import { randomUUID } from "node:crypto";

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
import { LibraryError } from "../errors";
import { ImageLibraryIndexStore, type ImageLibraryIndexContext } from "./index-store";
import type { ImageLibraryIndex, StoredLibraryAsset } from "./model";

export const DEFAULT_LIBRARY_PREFLIGHT_TTL_MS = 5 * 60_000;

type AssetMutationAction = Exclude<LibraryMutationRequest["action"], "import-zip">;
type SupportedAssetMutationAction = Extract<
  AssetMutationAction,
  "assign-folders" | "remove-folders" | "mark"
>;

export interface LibraryMutationStoreOptions {
  readonly indexStore: ImageLibraryIndexStore;
  readonly now?: () => Date;
  readonly idFactory?: (kind: "preflight") => string;
  readonly preflightTtlMs?: number;
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

function requiredConfirmation(action: LibraryMutationRequest["action"]): "zip-export" | "zip-import" | undefined {
  return action === "export-zip"
      ? "zip-export"
      : action === "import-zip"
        ? "zip-import"
        : undefined;
}

function allowedActions(asset: StoredLibraryAsset): LibraryAssetDetail["allowedActions"] {
  const actions: LibraryAssetDetail["allowedActions"][number][] = [];
  actions.push("assign-folders");
  if (asset.folderIds.length > 0) actions.push("remove-folders");
  actions.push("export-zip", "download", "mark", "copy-generation-info");
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
  readonly #idFactory: (kind: "preflight") => string;
  readonly #preflightTtlMs: number;
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
  }

  #newId(kind: "preflight"): string {
    let value: string;
    try {
      value = identifierSchema.parse(this.#idFactory(kind));
    } catch {
      throw new LibraryError("internal_contract", `The ${kind} identifier factory returned an invalid value.`);
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
    const now = safeDate(this.#now);
    this.#cleanupExpiredPreflights(now.getTime());
    const mutation = parsed.mutation;
    const index = await this.#indexStore.read();
    const targets = targetIds(mutation);
    const confirmation = requiredConfirmation(mutation.action);
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
        !foldersValid
      ) {
        error = !foldersValid
          ? libraryMutationError("not_found", "A selected active Library folder does not exist.")
          : undefined;
      } else if (mutation.action === "mark" && asset.kind !== "generate") {
        error = libraryMutationError(
          "conflict",
          "Only an active generation record can be marked."
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
        warnings: [],
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
      warnings: [],
      ...(topError === undefined ? {} : { error: topError })
    });
  }

  async execute(input: ExecuteLibraryMutationInput): Promise<ExecuteLibraryMutationResult> {
    const parsed = executeLibraryMutationInputSchema.parse(input);
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
    // Legacy cleanup is owned exclusively by the confirmation-bound migration flow.
  }

  async #executeAssetMutation(
    preflight: StoredPreflight,
    now: Date
  ): Promise<ExecuteLibraryMutationResult> {
    const action = preflight.action as SupportedAssetMutationAction;
    const mutation = preflight.mutation as Extract<
      LibraryMutationRequest,
      { action: SupportedAssetMutationAction }
    >;
    return await this.#indexStore.runExclusive(async (context) => {
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
        if (action === "mark" && asset.kind !== "generate") {
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

      await this.#commitMutation(context, action, candidates, folderIds, items, now);
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
        items: orderedItems
      });
    });
  }

  async #commitMutation(
    context: ImageLibraryIndexContext,
    action: SupportedAssetMutationAction,
    candidates: readonly string[],
    folderIds: readonly string[],
    items: Map<string, MutationItem>,
    now: Date
  ): Promise<void> {
    if (action === "mark") {
      const recordId = candidates[0];
      if (recordId === undefined) return;
      const currentMarkRecordId =
        context.index.currentMarkRecordId === recordId ? undefined : recordId;
      await context.commit({
        blobs: context.index.blobs,
        assets: context.index.assets,
        folders: context.index.folders,
        currentMarkRecordId
      });
      items.set(recordId, successItem(recordId));
      return;
    }
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

}
