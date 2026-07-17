import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { lstat, realpath, unlink } from "node:fs/promises";

import {
  executeLibraryMutationInputSchema,
  executeLibraryMutationResultSchema,
  identifierSchema,
  preflightLibraryMutationInputSchema,
  preflightLibraryMutationResultSchema,
  routegoServiceErrorSchema,
  type ExecuteLibraryMutationInput,
  type ExecuteLibraryMutationResult,
  type LibraryAssetDetail,
  type LibraryMutationRequest,
  type PreflightLibraryMutationInput,
  type PreflightLibraryMutationResult,
  type RoutegoServiceError
} from "@routego-image/contracts";
import { createProtectedLegacyRoots } from "@routego-image/foundation";

import { LibraryError, isNodeError } from "../errors";
import {
  listTransactionJournals,
  markTransactionJournalCommitted,
  removeTransactionJournal,
  writeTransactionJournal,
  type FileTransactionJournal
} from "../fs/journal";
import { resolveApprovedPath } from "../fs/paths";
import { ImageLibraryIndexStore, type ImageLibraryIndexContext } from "./index-store";
import {
  referencedBlobPaths,
  type ImageLibraryIndex,
  type StoredLibraryAsset
} from "./model";

export const LIBRARY_DELETE_TRANSACTION_KIND = "image-library-delete-v1";
export const DEFAULT_LIBRARY_PREFLIGHT_TTL_MS = 5 * 60_000;
export const LIBRARY_RECYCLE_RETENTION_MS = 30 * 24 * 60 * 60_000;

type AssetMutationAction = Exclude<LibraryMutationRequest["action"], "import-zip">;
type ExecutableAssetMutationAction = Exclude<AssetMutationAction, "export-zip">;

export interface LibraryMutationStoreHooks {
  readonly afterDeleteJournalPrepared?: (journal: FileTransactionJournal) => Promise<void>;
  readonly afterDeleteIndexCommit?: (journal: FileTransactionJournal) => Promise<void>;
  readonly beforeDeleteBackingFile?: (relativePath: string) => Promise<void>;
}

export interface LibraryMutationStoreOptions {
  readonly indexStore: ImageLibraryIndexStore;
  readonly now?: () => Date;
  readonly idFactory?: (kind: "preflight" | "transaction") => string;
  readonly preflightTtlMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly protectedRoots?: readonly string[];
  readonly hooks?: LibraryMutationStoreHooks;
}

interface StoredPreflight {
  readonly id: string;
  readonly action: LibraryMutationRequest["action"];
  readonly mutation: LibraryMutationRequest;
  readonly targetIds: readonly string[];
  readonly expiresAtMs: number;
  readonly errors: ReadonlyMap<string, RoutegoServiceError>;
  readonly assetFingerprints: ReadonlyMap<string, string>;
  readonly folderFingerprint?: string;
}

type MutationItem = ExecuteLibraryMutationResult["items"][number];

function platformKind(platform: NodeJS.Platform): "win32" | "posix" {
  return platform === "win32" ? "win32" : "posix";
}

function pathApi(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function normalizedPath(value: string, platform: NodeJS.Platform): string {
  const selectedPath = pathApi(platform);
  const normalized = selectedPath.normalize(selectedPath.resolve(value));
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function isContained(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  const selectedPath = pathApi(platform);
  const relative = selectedPath.relative(root, candidate);
  return (
    relative === "" ||
    (!selectedPath.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${selectedPath.sep}`))
  );
}

function overlaps(left: string, right: string, platform: NodeJS.Platform): boolean {
  return isContained(left, right, platform) || isContained(right, left, platform);
}

function safeDate(now: () => Date): Date {
  const value = now();
  if (!Number.isFinite(value.getTime())) {
    throw new LibraryError("internal_contract", "The Library mutation clock is invalid.");
  }
  return value;
}

function assetFingerprint(asset: StoredLibraryAsset): string {
  return JSON.stringify(asset);
}

function folderFingerprint(index: ImageLibraryIndex, folderIds: readonly string[]): string {
  const selected = new Set(folderIds);
  return JSON.stringify(
    index.folders
      .filter((folder) => selected.has(folder.id))
      .sort((left, right) => left.id.localeCompare(right.id))
  );
}

function requiredConfirmation(
  action: LibraryMutationRequest["action"]
): "permanent-delete" | "zip-export" | "zip-import" | undefined {
  return action === "permanent-delete"
    ? "permanent-delete"
    : action === "export-zip"
      ? "zip-export"
      : action === "import-zip"
        ? "zip-import"
        : undefined;
}

function allowedActions(asset: StoredLibraryAsset): LibraryAssetDetail["allowedActions"] {
  if (asset.status === "deleted") {
    return ["restore", "permanent-delete", "export-zip", "download"];
  }
  const actions: LibraryAssetDetail["allowedActions"][number][] = [];
  if (asset.status === "succeeded" || asset.status === "partial") actions.push("edit");
  if (asset.status === "succeeded" || asset.status === "partial" || asset.status === "failed") {
    actions.push("retry");
  }
  actions.push("assign-folders");
  if (asset.folderIds.length > 0) actions.push("remove-folders");
  actions.push("soft-delete", "export-zip", "download");
  return actions;
}

export function libraryMutationError(
  code: RoutegoServiceError["code"],
  safeMessage: string
): RoutegoServiceError {
  const category: RoutegoServiceError["category"] =
    code === "capability_unavailable"
      ? "capability"
      : code === "invalid_input" || code === "invalid_request"
        ? "validation"
        : code === "path_unsafe" || code === "access_denied"
          ? "security"
          : code === "not_found" || code === "conflict"
            ? "persistence"
            : "internal";
  return routegoServiceErrorSchema.parse({
    code,
    category,
    stage: category === "validation" ? "validate" : category === "capability" ? "route" : "persist",
    safeMessage,
    retryDisposition: code === "conflict" ? "user-confirmation" : "never",
    partialArtifacts: [],
    receivedAnyOutput: false,
    mayHaveBilled: false
  });
}

function resultStatus(items: readonly MutationItem[]): ExecuteLibraryMutationResult["status"] {
  const succeeded = items.filter((item) => item.status === "succeeded").length;
  return succeeded === items.length ? "succeeded" : succeeded === 0 ? "failed" : "partial";
}

function targetIds(mutation: LibraryMutationRequest): readonly string[] {
  return "assetIds" in mutation ? mutation.assetIds : [mutation.uploadResourceId];
}

function successItem(
  targetId: string,
  options: { readonly folderIds?: readonly string[]; readonly warnings?: readonly string[] } = {}
): MutationItem {
  return {
    targetId,
    status: "succeeded",
    affectedAssetId: targetId,
    affectedFolderIds: options.folderIds ? [...options.folderIds] : [],
    warnings: options.warnings ? [...options.warnings] : []
  };
}

function skippedItem(targetId: string, warning: string): MutationItem {
  return { targetId, status: "skipped", affectedFolderIds: [], warnings: [warning] };
}

function failedItem(targetId: string, error: RoutegoServiceError): MutationItem {
  return { targetId, status: "failed", affectedFolderIds: [], warnings: [], error };
}

function topLevelResult(options: {
  readonly preflightId: string;
  readonly action: LibraryMutationRequest["action"];
  readonly items: readonly MutationItem[];
  readonly warnings?: readonly string[];
}): ExecuteLibraryMutationResult {
  const status = resultStatus(options.items);
  const failed = options.items.find((item) => item.status === "failed")?.error;
  return executeLibraryMutationResultSchema.parse({
    schemaVersion: 1,
    preflightId: options.preflightId,
    action: options.action,
    status,
    items: options.items,
    warnings: options.warnings ? [...options.warnings] : [],
    ...(status === "failed" && failed ? { error: failed } : {})
  });
}

export class LibraryMutationStore {
  readonly #indexStore: ImageLibraryIndexStore;
  readonly #now: () => Date;
  readonly #idFactory: (kind: "preflight" | "transaction") => string;
  readonly #preflightTtlMs: number;
  readonly #platform: NodeJS.Platform;
  readonly #protectedRoots: readonly string[];
  readonly #allowedDefaultRoot: string;
  readonly #hooks: LibraryMutationStoreHooks;
  readonly #preflights = new Map<string, StoredPreflight>();

  constructor(options: LibraryMutationStoreOptions) {
    this.#indexStore = options.indexStore;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory =
      options.idFactory ?? ((kind) => `${kind}-${randomUUID()}`);
    this.#preflightTtlMs = options.preflightTtlMs ?? DEFAULT_LIBRARY_PREFLIGHT_TTL_MS;
    if (
      !Number.isSafeInteger(this.#preflightTtlMs) ||
      this.#preflightTtlMs < 1 ||
      this.#preflightTtlMs > 3_600_000
    ) {
      throw new LibraryError("invalid_input", "The Library preflight lifetime is invalid.");
    }
    this.#platform = options.platform ?? process.platform;
    const homeDirectory = options.homeDirectory ?? os.homedir();
    this.#protectedRoots =
      options.protectedRoots ?? createProtectedLegacyRoots(homeDirectory, platformKind(this.#platform));
    this.#allowedDefaultRoot = pathApi(this.#platform).resolve(
      homeDirectory,
      "Pictures",
      "routego-image",
      "library"
    );
    this.#hooks = options.hooks ?? {};
    this.#assertApprovedRoot();
  }

  #assertApprovedRoot(): void {
    const root = normalizedPath(this.#indexStore.paths.root, this.#platform);
    const allowedDefault = normalizedPath(this.#allowedDefaultRoot, this.#platform);
    for (const protectedRoot of this.#protectedRoots) {
      const protectedComparable = normalizedPath(protectedRoot, this.#platform);
      if (overlaps(root, protectedComparable, this.#platform) && root !== allowedDefault) {
        throw new LibraryError("path_unsafe", "The Image Library mutation root overlaps protected legacy data.");
      }
    }
  }

  async #assertCanonicalRootDoesNotAliasProtectedData(): Promise<void> {
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(this.#indexStore.paths.root);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw new LibraryError("path_unsafe", "The Image Library mutation root is unavailable.", {
        cause: error
      });
    }
    const lexicalRoot = normalizedPath(this.#indexStore.paths.root, this.#platform);
    const canonicalComparable = normalizedPath(canonicalRoot, this.#platform);
    if (isContained(lexicalRoot, canonicalComparable, this.#platform)) return;
    if (
      this.#protectedRoots.some((protectedRoot) =>
        overlaps(
          canonicalComparable,
          normalizedPath(protectedRoot, this.#platform),
          this.#platform
        )
      )
    ) {
      throw new LibraryError(
        "path_unsafe",
        "The Image Library mutation root resolves to protected legacy data."
      );
    }
  }

  #newId(kind: "preflight" | "transaction"): string {
    let value: string;
    try {
      value = identifierSchema.parse(this.#idFactory(kind));
    } catch {
      throw new LibraryError("internal_contract", `The ${kind} identifier factory returned an invalid value.`);
    }
    if (kind === "transaction" && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(value)) {
      throw new LibraryError("internal_contract", "The transaction identifier is not filesystem safe.");
    }
    return value;
  }

  #allocatePreflightId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.#newId("preflight");
      if (!this.#preflights.has(candidate)) return candidate;
    }
    throw new LibraryError("conflict", "A unique Library preflight identity could not be allocated.");
  }

  #cleanupExpiredPreflights(nowMs: number): void {
    for (const [preflightId, preflight] of this.#preflights) {
      if (preflight.expiresAtMs <= nowMs) this.#preflights.delete(preflightId);
    }
  }

  async preflight(input: PreflightLibraryMutationInput): Promise<PreflightLibraryMutationResult> {
    const parsed = preflightLibraryMutationInputSchema.parse(input);
    await this.#assertCanonicalRootDoesNotAliasProtectedData();
    const now = safeDate(this.#now);
    this.#cleanupExpiredPreflights(now.getTime());
    const index = await this.#indexStore.read();
    await this.#assertCanonicalRootDoesNotAliasProtectedData();
    const mutation = parsed.mutation;
    const targets = targetIds(mutation);
    const confirmation = requiredConfirmation(mutation.action);
    const selectedIds = new Set(targets);
    const selectedFolders =
      "folderIds" in mutation
        ? mutation.folderIds.map((folderId) => index.folders.find((folder) => folder.id === folderId))
        : [];
    const foldersValid = selectedFolders.every((folder) => folder?.state === "active");
    const errors = new Map<string, RoutegoServiceError>();
    const assetFingerprints = new Map<string, string>();

    const items = targets.map((targetId) => {
      if (mutation.action === "import-zip") {
        const error = libraryMutationError(
          "capability_unavailable",
          "ZIP import is not available until Library portability is installed."
        );
        errors.set(targetId, error);
        return {
          targetId,
          targetKind: "upload-resource" as const,
          eligible: false,
          allowedActions: [],
          requiredConfirmations: confirmation ? [confirmation] : [],
          warnings: [],
          error
        };
      }
      const asset = index.assets.find((candidate) => candidate.id === targetId);
      if (asset) assetFingerprints.set(targetId, assetFingerprint(asset));
      let error: RoutegoServiceError | undefined;
      if (!asset) {
        error = libraryMutationError("not_found", "The selected Library asset does not exist.");
      } else if (mutation.action === "export-zip") {
        error = libraryMutationError(
          "capability_unavailable",
          "ZIP export is not available until Library portability is installed."
        );
      } else if (
        (mutation.action === "assign-folders" || mutation.action === "remove-folders") &&
        (!foldersValid || asset.status === "deleted")
      ) {
        error = !foldersValid
          ? libraryMutationError("not_found", "A selected active Library folder does not exist.")
          : libraryMutationError("conflict", "Recycle-bin assets cannot change folder membership.");
      } else if (mutation.action === "soft-delete" && asset.status === "deleted") {
        error = libraryMutationError("conflict", "The Library asset is already in the recycle bin.");
      } else if (
        (mutation.action === "restore" || mutation.action === "permanent-delete") &&
        asset.status !== "deleted"
      ) {
        error = libraryMutationError("conflict", "The Library asset is not in the recycle bin.");
      } else if (
        mutation.action === "permanent-delete" &&
        index.assets.some(
          (survivor) =>
            !selectedIds.has(survivor.id) &&
            survivor.relationships.some((relationship) => relationship.relatedAssetId === asset.id)
        )
      ) {
        error = libraryMutationError(
          "conflict",
          "The Library asset is still referenced by an asset outside this deletion."
        );
      }
      if (error) errors.set(targetId, error);
      return {
        targetId,
        targetKind: "asset" as const,
        eligible: error === undefined,
        ...(asset === undefined ? {} : { currentStatus: asset.status }),
        allowedActions: asset === undefined ? [] : allowedActions(asset),
        requiredConfirmations: confirmation ? [confirmation] : [],
        warnings:
          mutation.action === "permanent-delete"
            ? ["Permanent deletion cannot be undone."]
            : [],
        ...(error === undefined ? {} : { error })
      };
    });
    const eligibleCount = items.filter((item) => item.eligible).length;
    const status = eligibleCount === items.length ? "ready" : eligibleCount === 0 ? "blocked" : "partial";
    const preflightId = this.#allocatePreflightId();
    const expiresAtMs = now.getTime() + this.#preflightTtlMs;
    this.#preflights.set(preflightId, {
      id: preflightId,
      action: mutation.action,
      mutation,
      targetIds: targets,
      expiresAtMs,
      errors,
      assetFingerprints,
      ...(mutation.action === "assign-folders" || mutation.action === "remove-folders"
        ? { folderFingerprint: folderFingerprint(index, mutation.folderIds) }
        : {})
    });
    const topError =
      status === "blocked"
        ? items.find((item) => item.error)?.error ??
          libraryMutationError("conflict", "Every Library mutation target is blocked.")
        : undefined;
    return preflightLibraryMutationResultSchema.parse({
      schemaVersion: 1,
      preflightId,
      action: mutation.action,
      status,
      expiresAt: new Date(expiresAtMs).toISOString(),
      requiredConfirmations: confirmation ? [confirmation] : [],
      items,
      warnings:
        mutation.action === "permanent-delete"
          ? ["Permanent deletion removes unreferenced image files after index commit."]
          : [],
      ...(topError === undefined ? {} : { error: topError })
    });
  }

  async execute(input: ExecuteLibraryMutationInput): Promise<ExecuteLibraryMutationResult> {
    const parsed = executeLibraryMutationInputSchema.parse(input);
    await this.#assertCanonicalRootDoesNotAliasProtectedData();
    const now = safeDate(this.#now);
    const preflight = this.#preflights.get(parsed.preflightId);
    if (!preflight || preflight.expiresAtMs <= now.getTime() || preflight.action !== parsed.action) {
      if (preflight) this.#preflights.delete(parsed.preflightId);
      const error = libraryMutationError("conflict", "The Library mutation preflight is missing, expired, or stale.");
      return topLevelResult({
        preflightId: parsed.preflightId,
        action: parsed.action,
        items: [failedItem(parsed.preflightId, error)]
      });
    }
    this.#preflights.delete(parsed.preflightId);
    if (parsed.action === "export-zip" || parsed.action === "import-zip") {
      const error = libraryMutationError(
        "capability_unavailable",
        "ZIP portability is not available in the current Library implementation."
      );
      return topLevelResult({
        preflightId: parsed.preflightId,
        action: parsed.action,
        items: preflight.targetIds.map((targetId) => failedItem(targetId, error))
      });
    }
    return await this.#executeAssetMutation(preflight, now);
  }

  async recover(): Promise<void> {
    await this.#assertCanonicalRootDoesNotAliasProtectedData();
    await this.#indexStore.runExclusive(async ({ index }) => {
      await this.#recoverDeleteJournals(index);
    });
  }

  async #executeAssetMutation(
    preflight: StoredPreflight,
    now: Date
  ): Promise<ExecuteLibraryMutationResult> {
    const action = preflight.action as ExecutableAssetMutationAction;
    const mutation = preflight.mutation as Extract<
      LibraryMutationRequest,
      { action: ExecutableAssetMutationAction }
    >;
    return await this.#indexStore.runExclusive(async (context) => {
      await this.#recoverDeleteJournals(context.index);
      const items = new Map<string, MutationItem>();
      const candidates: string[] = [];
      const folderIds = "folderIds" in mutation ? mutation.folderIds : [];
      const currentFolderFingerprint =
        folderIds.length === 0 ? undefined : folderFingerprint(context.index, folderIds);
      const foldersStale =
        preflight.folderFingerprint !== undefined &&
        currentFolderFingerprint !== preflight.folderFingerprint;
      for (const targetId of preflight.targetIds) {
        const initialError = preflight.errors.get(targetId);
        if (initialError) {
          items.set(targetId, failedItem(targetId, initialError));
          continue;
        }
        const asset = context.index.assets.find((candidate) => candidate.id === targetId);
        if (
          !asset ||
          preflight.assetFingerprints.get(targetId) !== assetFingerprint(asset) ||
          foldersStale
        ) {
          items.set(
            targetId,
            failedItem(
              targetId,
              libraryMutationError("conflict", "The Library mutation target changed after preflight.")
            )
          );
          continue;
        }
        if (
          (action === "soft-delete" && asset.status === "deleted") ||
          ((action === "restore" || action === "permanent-delete") && asset.status !== "deleted") ||
          ((action === "assign-folders" || action === "remove-folders") && asset.status === "deleted")
        ) {
          items.set(
            targetId,
            failedItem(
              targetId,
              libraryMutationError("conflict", "The Library mutation target is no longer eligible.")
            )
          );
          continue;
        }
        candidates.push(targetId);
      }

      let cleanupWarning: string | undefined;
      if (action === "permanent-delete") {
        cleanupWarning = await this.#permanentlyDelete(context, candidates, items, now);
      } else {
        await this.#commitNonDestructiveMutation(context, action, candidates, folderIds, items, now);
      }
      const orderedItems = preflight.targetIds.map(
        (targetId) =>
          items.get(targetId) ??
          failedItem(
            targetId,
            libraryMutationError("internal_contract", "The Library mutation did not produce an item outcome.")
          )
      );
      return topLevelResult({
        preflightId: preflight.id,
        action,
        items: orderedItems,
        ...(cleanupWarning === undefined ? {} : { warnings: [cleanupWarning] })
      });
    });
  }

  async #commitNonDestructiveMutation(
    context: ImageLibraryIndexContext,
    action: Exclude<ExecutableAssetMutationAction, "permanent-delete">,
    candidates: readonly string[],
    folderIds: readonly string[],
    items: Map<string, MutationItem>,
    now: Date
  ): Promise<void> {
    const selected = new Set(candidates);
    const folderOrder = new Map(
      [...context.index.folders]
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
        .map((folder, order) => [folder.id, order])
    );
    let changed = false;
    const updatedAt = now.toISOString();
    const assets = context.index.assets.map((asset) => {
      if (!selected.has(asset.id)) return asset;
      if (action === "soft-delete") {
        changed = true;
        items.set(asset.id, successItem(asset.id));
        return {
          ...asset,
          status: "deleted" as const,
          previousStatus: asset.status as Exclude<typeof asset.status, "deleted">,
          deletedAt: updatedAt,
          purgeEligibleAt: new Date(now.getTime() + LIBRARY_RECYCLE_RETENTION_MS).toISOString(),
          updatedAt
        };
      }
      if (action === "restore") {
        changed = true;
        items.set(asset.id, successItem(asset.id));
        const { previousStatus, deletedAt, purgeEligibleAt, ...rest } = asset;
        return { ...rest, status: previousStatus!, updatedAt };
      }
      const memberships = new Set(asset.folderIds);
      const changedFolderIds: string[] = [];
      if (action === "assign-folders") {
        for (const folderId of folderIds) {
          if (!memberships.has(folderId)) changedFolderIds.push(folderId);
          memberships.add(folderId);
        }
      } else {
        for (const folderId of folderIds) {
          if (memberships.delete(folderId)) changedFolderIds.push(folderId);
        }
      }
      const nextFolderIds = [...memberships].sort(
        (left, right) =>
          (folderOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
            (folderOrder.get(right) ?? Number.MAX_SAFE_INTEGER) ||
          left.localeCompare(right)
      );
      const itemChanged =
        nextFolderIds.length !== asset.folderIds.length ||
        nextFolderIds.some((folderId, index) => folderId !== asset.folderIds[index]);
      if (!itemChanged) {
        items.set(
          asset.id,
          skippedItem(
            asset.id,
            action === "assign-folders"
              ? "The asset already belongs to every selected folder."
              : "The asset does not belong to any selected folder."
          )
        );
        return asset;
      }
      changed = true;
      items.set(asset.id, successItem(asset.id, { folderIds: changedFolderIds }));
      return { ...asset, folderIds: nextFolderIds, updatedAt };
    });
    if (changed) {
      await context.commit({
        blobs: context.index.blobs,
        assets,
        folders: context.index.folders
      });
    }
  }

  async #permanentlyDelete(
    context: ImageLibraryIndexContext,
    candidatesInput: readonly string[],
    items: Map<string, MutationItem>,
    now: Date
  ): Promise<string | undefined> {
    const candidates = new Set(candidatesInput);
    let changed = true;
    while (changed) {
      changed = false;
      for (const targetId of [...candidates]) {
        const referencedBySurvivor = context.index.assets.some(
          (asset) =>
            !candidates.has(asset.id) &&
            asset.relationships.some((relationship) => relationship.relatedAssetId === targetId)
        );
        if (referencedBySurvivor) {
          candidates.delete(targetId);
          items.set(
            targetId,
            failedItem(
              targetId,
              libraryMutationError(
                "conflict",
                "The Library asset remains referenced by an asset that will survive deletion."
              )
            )
          );
          changed = true;
        }
      }
    }
    if (candidates.size === 0) return undefined;

    const nextAssets = context.index.assets.filter((asset) => !candidates.has(asset.id));
    const referencedShas = new Set(
      nextAssets.flatMap((asset) => asset.renditions.map((rendition) => rendition.blobSha256))
    );
    const deletedBlobs = context.index.blobs.filter((blob) => !referencedShas.has(blob.sha256));
    const nextBlobs = context.index.blobs.filter((blob) => referencedShas.has(blob.sha256));
    const deletePaths = [...new Set(deletedBlobs.map((blob) => blob.relativePath))];
    let journal: FileTransactionJournal | undefined;
    if (deletePaths.length > 0) {
      journal = {
        schemaVersion: 1,
        id: this.#newId("transaction"),
        kind: LIBRARY_DELETE_TRANSACTION_KIND,
        state: "prepared",
        createdAt: now.toISOString(),
        createdPaths: [],
        deleteAfterCommitPaths: deletePaths,
        metadata: { expectedRevision: context.index.revision + 1 }
      };
      await writeTransactionJournal(this.#indexStore.paths.root, journal);
      if (this.#hooks.afterDeleteJournalPrepared) {
        await this.#hooks.afterDeleteJournalPrepared(journal);
      }
    }
    await context.commit({ blobs: nextBlobs, assets: nextAssets, folders: context.index.folders });
    for (const targetId of candidates) items.set(targetId, successItem(targetId));
    if (!journal) return undefined;
    if (this.#hooks.afterDeleteIndexCommit) await this.#hooks.afterDeleteIndexCommit(journal);
    try {
      const committed = await markTransactionJournalCommitted(this.#indexStore.paths.root, journal);
      await this.#cleanupDeleteJournal(committed);
      return undefined;
    } catch {
      return "Image metadata was deleted; unreferenced file cleanup is deferred to recovery.";
    }
  }

  #validateDeleteJournal(journal: FileTransactionJournal): number {
    const expectedRevision = journal.metadata?.["expectedRevision"];
    if (
      journal.kind !== LIBRARY_DELETE_TRANSACTION_KIND ||
      journal.createdPaths.length !== 0 ||
      journal.deleteAfterCommitPaths.length < 1 ||
      new Set(journal.deleteAfterCommitPaths).size !== journal.deleteAfterCommitPaths.length ||
      journal.deleteAfterCommitPaths.some(
        (candidate) =>
          candidate.includes("\\") ||
          candidate.split("/").includes("..") ||
          !/^blobs\/\d{4}\/(?:0[1-9]|1[0-2])\/[^/]+\.(?:png|jpg|webp)$/u.test(candidate)
      ) ||
      !Number.isSafeInteger(expectedRevision) ||
      (expectedRevision as number) < 1
    ) {
      throw new LibraryError("config_corrupt", "An Image Library deletion journal is invalid.");
    }
    return expectedRevision as number;
  }

  async #recoverDeleteJournals(index: ImageLibraryIndex): Promise<void> {
    const referenced = referencedBlobPaths(index);
    for (const journal of await listTransactionJournals(this.#indexStore.paths.root)) {
      if (journal.kind !== LIBRARY_DELETE_TRANSACTION_KIND) continue;
      const expectedRevision = this.#validateDeleteJournal(journal);
      if (index.revision >= expectedRevision) {
        const unreferencedPaths = journal.deleteAfterCommitPaths.filter(
          (relativePath) => !referenced.has(relativePath)
        );
        if (unreferencedPaths.length > 0) {
          await this.#cleanupDeletePaths(unreferencedPaths);
        }
      }
      await removeTransactionJournal(this.#indexStore.paths.root, journal.id);
    }
  }

  async #cleanupDeleteJournal(journal: FileTransactionJournal): Promise<void> {
    this.#validateDeleteJournal(journal);
    await this.#cleanupDeletePaths(journal.deleteAfterCommitPaths);
    await removeTransactionJournal(this.#indexStore.paths.root, journal.id);
  }

  async #cleanupDeletePaths(relativePaths: readonly string[]): Promise<void> {
    const canonicalRoot = await realpath(this.#indexStore.paths.root).catch((error: unknown) => {
      throw new LibraryError("path_unsafe", "The Image Library root is unavailable for cleanup.", {
        cause: error
      });
    });
    for (const relativePath of relativePaths) {
      if (this.#hooks.beforeDeleteBackingFile) {
        await this.#hooks.beforeDeleteBackingFile(relativePath);
      }
      const candidate = resolveApprovedPath({
        root: this.#indexStore.paths.root,
        candidate: relativePath,
        operation: "delete",
        platform: platformKind(this.#platform)
      });
      let metadata;
      try {
        metadata = await lstat(candidate);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) continue;
        throw error;
      }
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new LibraryError("path_unsafe", "A deletion journal points to an unsafe file.");
      }
      const canonicalCandidate = await realpath(candidate);
      if (!isContained(canonicalRoot, canonicalCandidate, this.#platform)) {
        throw new LibraryError("path_unsafe", "A deletion journal escapes the Image Library root.");
      }
      await unlink(candidate);
    }
  }
}
