import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, unlink, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  executeLibraryMutationInputSchema,
  executeLibraryMutationResultSchema,
  identifierSchema,
  preflightLibraryMutationInputSchema,
  preflightLibraryMutationResultSchema,
  routegoManageLibraryInputSchema,
  routegoManageLibraryResultSchema,
  type DiscardUploadResourceInput,
  type DiscardUploadResourceResult,
  type ExecuteLibraryMutationInput,
  type ExecuteLibraryMutationResult,
  type FinalizeUploadResourceInput,
  type FinalizeUploadResourceResult,
  type GetAssetDetailInput,
  type GetAssetDetailResult,
  type GetBrowserResourceInput,
  type GetBrowserResourceResult,
  type GetUploadResourceStatusInput,
  type GetUploadResourceStatusResult,
  type ListFoldersInput,
  type ListFoldersResult,
  type PreflightLibraryMutationInput,
  type PreflightLibraryMutationResult,
  type ReadSettingsInput,
  type ReadSettingsResult,
  type RemoveProviderProfileInput,
  type RemoveProviderProfileResult,
  type ReorderFoldersInput,
  type ReorderFoldersResult,
  type ReserveUploadResourceInput,
  type ReserveUploadResourceResult,
  type RoutegoManageLibraryInput,
  type RoutegoManageLibraryResult,
  type RoutegoSearchLibraryInput,
  type RoutegoSearchLibraryResult,
  type RoutegoService,
  type RoutegoServiceError,
  type SetActiveProviderProfileInput,
  type SetActiveProviderProfileResult,
  type StudioLibrarySearchInput,
  type StudioLibrarySearchResult,
  type StudioLibraryService,
  type StudioSettingsService,
  type StudioUploadService,
  type UpdateSettingsInput,
  type UpdateSettingsResult,
  type UpsertProviderProfileInput,
  type UpsertProviderProfileResult,
  type UploadResourcePurpose
} from "@routego-image/contracts";
import { createProtectedLegacyRoots, type PathPlatform } from "@routego-image/foundation";

import { LibrarySettingsStore, type LibrarySettingsStoreOptions } from "./config/store";
import { isNodeError, LibraryError } from "./errors";
import {
  canonicalizePathIdentities,
  canonicalizePathIdentity,
  createExclusiveFile,
  isPathIdentityContained,
  normalizePathIdentity,
  pathIdentitiesOverlap
} from "./fs/paths";
import { LibraryAssetStore, type LibraryAssetStoreOptions } from "./gallery/assets";
import { ImageLibraryIndexStore, type ImageLibraryIndexStoreOptions } from "./gallery/index-store";
import {
  libraryMutationError,
  type LibraryMutationStoreOptions
} from "./gallery/mutations";
import type { LibraryReadServiceOptions } from "./gallery/read-service";
import {
  BrowserResourceRegistry,
  type BrowserResourceRegistryOptions,
  type ResolvedBrowserResource
} from "./gallery/resources";
import {
  LibraryResourceResolver,
  type ResolvedStableImageResource,
  type StableImageLocator
} from "./gallery/resolver";
import { GalleryService } from "./gallery/service";
import { UploadStore, type UploadStoreOptions } from "./upload/store";
import {
  LibraryPortabilityService,
  type LibraryPortabilityServiceOptions
} from "./zip/portability";

export type LibrarySettingsService = Pick<
  StudioSettingsService,
  | "readSettings"
  | "upsertProviderProfile"
  | "removeProviderProfile"
  | "setActiveProviderProfile"
  | "updateSettings"
>;

export interface LibraryApplicationService
  extends LibrarySettingsService,
    StudioUploadService,
    StudioLibraryService,
    Pick<RoutegoService, "searchLibrary" | "manageLibrary"> {}

export interface RoutegoLibraryServiceOptions {
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => Date;
  readonly settingsStore?: LibrarySettingsStore;
  readonly uploadStore?: UploadStore;
  readonly indexStore?: ImageLibraryIndexStore;
  readonly assetStore?: LibraryAssetStore;
  readonly resourceRegistry?: BrowserResourceRegistry;
  readonly galleryService?: GalleryService;
  readonly portabilityService?: LibraryPortabilityService;
  readonly resourceResolver?: LibraryResourceResolver;
  readonly settings?: LibrarySettingsStoreOptions;
  readonly uploads?: UploadStoreOptions;
  readonly index?: ImageLibraryIndexStoreOptions;
  readonly assets?: Omit<LibraryAssetStoreOptions, "indexStore">;
  readonly resources?: Omit<BrowserResourceRegistryOptions, "root">;
  readonly read?: Omit<LibraryReadServiceOptions, "indexStore" | "resources">;
  readonly mutations?: Omit<LibraryMutationStoreOptions, "indexStore">;
  readonly portability?: Omit<
    LibraryPortabilityServiceOptions,
    "indexStore" | "uploadStore" | "resourceRegistry" | "assetStore"
  >;
  readonly zipPreflightTtlMs?: number;
  readonly zipPreflightIdFactory?: () => string;
  readonly publicProtectedRoots?: readonly string[];
}

type ExportZipMutation = { readonly action: "export-zip"; readonly assetIds: readonly string[] };
type ImportZipMutation = { readonly action: "import-zip"; readonly uploadResourceId: string };
type ZipMutation = ExportZipMutation | ImportZipMutation;
type MutationItem = ExecuteLibraryMutationResult["items"][number];

interface StoredZipPreflightBase {
  readonly id: string;
  readonly targetIds: readonly string[];
  readonly expiresAtMs: number;
  readonly errors: ReadonlyMap<string, RoutegoServiceError>;
  readonly assetFingerprints: ReadonlyMap<string, string>;
}

type StoredZipPreflight = StoredZipPreflightBase &
  (
    | {
        readonly action: "export-zip";
        readonly mutation: ExportZipMutation;
        readonly requestedBaseName?: string;
      }
    | {
        readonly action: "import-zip";
        readonly mutation: ImportZipMutation;
        readonly uploadFingerprint?: string;
      }
  );

const DEFAULT_ZIP_PREFLIGHT_TTL_MS = 5 * 60_000;

function platformKind(platform: NodeJS.Platform): PathPlatform {
  return platform === "win32" ? "win32" : "posix";
}

function pathApi(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function normalizedPath(value: string, platform: NodeJS.Platform): string {
  return normalizePathIdentity(value, platformKind(platform));
}

function isContained(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  return isPathIdentityContained(root, candidate, platformKind(platform));
}

function overlaps(left: string, right: string, platform: NodeJS.Platform): boolean {
  return pathIdentitiesOverlap(left, right, platformKind(platform));
}

async function canonicalizeThroughExistingAncestor(
  candidate: string,
  platform: NodeJS.Platform
): Promise<string> {
  return await canonicalizePathIdentity(candidate, {
    platform: platformKind(platform)
  }).catch((error: unknown) => {
    throw new LibraryError("path_unsafe", "The ZIP output path could not be resolved safely.", {
      cause: error
    });
  });
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const remaining = chunk.byteLength - offset;
    const { bytesWritten } = await handle.write(chunk.subarray(offset));
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 1 || bytesWritten > remaining) {
      throw new LibraryError("file_write_failed", "The public ZIP export could not be written.");
    }
    offset += bytesWritten;
  }
}

function resultStatus(items: readonly MutationItem[]): ExecuteLibraryMutationResult["status"] {
  const succeeded = items.filter((item) => item.status === "succeeded").length;
  return succeeded === items.length ? "succeeded" : succeeded === 0 ? "failed" : "partial";
}

function failedItem(targetId: string, error: RoutegoServiceError): MutationItem {
  return { targetId, status: "failed", affectedFolderIds: [], warnings: [], error };
}

function mutationFailure(error: unknown, fallback: string): RoutegoServiceError {
  if (error instanceof LibraryError) {
    const code: RoutegoServiceError["code"] =
      error.code === "not_found" ||
      error.code === "conflict" ||
      error.code === "path_unsafe" ||
      error.code === "access_denied" ||
      error.code === "invalid_input" ||
      error.code === "invalid_request" ||
      error.code === "config_corrupt" ||
      error.code === "config_missing"
        ? error.code
        : "internal_contract";
    return libraryMutationError(code, fallback);
  }
  return libraryMutationError("internal_contract", fallback);
}

function operationWarnings(result: ExecuteLibraryMutationResult): readonly string[] {
  return [
    ...result.warnings,
    ...result.items.flatMap((item) =>
      item.status === "failed"
        ? [`${item.targetId}: ${item.error?.safeMessage ?? "The mutation failed."}`]
        : item.warnings
    )
  ].slice(0, 100);
}

function uploadFingerprint(result: GetUploadResourceStatusResult): string | undefined {
  if (result.status !== "succeeded" || !result.resource) return undefined;
  const resource = result.resource;
  if (
    resource.purpose !== "zip-import" ||
    resource.status !== "finalized" ||
    resource.finalized?.detectedMimeType !== "application/zip"
  ) {
    return undefined;
  }
  return JSON.stringify({
    uploadResourceId: resource.uploadResourceId,
    status: resource.status,
    purpose: resource.purpose,
    byteLength: resource.finalized.byteLength,
    sha256: resource.finalized.sha256,
    expiresAt: resource.binaryUpload.expiresAt
  });
}

export class RoutegoLibraryService implements LibraryApplicationService {
  readonly settingsStore: LibrarySettingsStore;
  readonly uploadStore: UploadStore;
  readonly indexStore: ImageLibraryIndexStore;
  readonly assetStore: LibraryAssetStore;
  readonly resourceRegistry: BrowserResourceRegistry;
  readonly galleryService: GalleryService;
  readonly portabilityService: LibraryPortabilityService;
  readonly resourceResolver: LibraryResourceResolver;

  readonly #platform: NodeJS.Platform;
  readonly #now: () => Date;
  readonly #zipPreflightTtlMs: number;
  readonly #zipPreflightIdFactory: () => string;
  readonly #publicProtectedRoots: readonly string[];
  readonly #zipPreflights = new Map<string, StoredZipPreflight>();

  constructor(options: RoutegoLibraryServiceOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#now = options.now ?? (() => new Date());
    const homeDirectory = options.homeDirectory ?? os.homedir();
    const common = {
      homeDirectory,
      platform: this.#platform
    } as const;
    const timed = { ...common, now: this.#now } as const;

    this.settingsStore =
      options.settingsStore ?? new LibrarySettingsStore({ ...timed, ...options.settings });
    this.uploadStore = options.uploadStore ?? new UploadStore({ ...timed, ...options.uploads });
    this.indexStore =
      options.indexStore ?? new ImageLibraryIndexStore({ ...common, ...options.index });
    this.assetStore =
      options.assetStore ??
      new LibraryAssetStore({
        ...timed,
        ...options.assets,
        indexStore: this.indexStore
      });
    this.resourceRegistry =
      options.resourceRegistry ??
      options.galleryService?.readService.resources ??
      new BrowserResourceRegistry({
        root: this.indexStore.paths.root,
        platform: this.#platform,
        now: this.#now,
        ...options.resources
      });
    this.galleryService =
      options.galleryService ??
      new GalleryService({
        indexStore: this.indexStore,
        readOptions: {
          platform: this.#platform,
          now: this.#now,
          ...options.read,
          resources: this.resourceRegistry
        },
        mutationOptions: {
          ...timed,
          ...options.mutations
        }
      });
    this.portabilityService =
      options.portabilityService ??
      new LibraryPortabilityService({
        indexStore: this.indexStore,
        uploadStore: this.uploadStore,
        resourceRegistry: this.resourceRegistry,
        assetStore: this.assetStore,
        platform: this.#platform,
        now: this.#now,
        ...options.portability
      });
    this.resourceResolver =
      options.resourceResolver ??
      new LibraryResourceResolver({ assets: this.assetStore, uploads: this.uploadStore });

    this.#zipPreflightTtlMs = options.zipPreflightTtlMs ?? DEFAULT_ZIP_PREFLIGHT_TTL_MS;
    if (
      !Number.isSafeInteger(this.#zipPreflightTtlMs) ||
      this.#zipPreflightTtlMs < 1 ||
      this.#zipPreflightTtlMs > 3_600_000
    ) {
      throw new LibraryError("invalid_input", "The ZIP preflight lifetime is invalid.");
    }
    this.#zipPreflightIdFactory =
      options.zipPreflightIdFactory ?? (() => `preflight-${randomUUID()}`);
    this.#publicProtectedRoots =
      options.publicProtectedRoots ??
      createProtectedLegacyRoots(homeDirectory, platformKind(this.#platform));
  }

  #safeNow(): Date {
    const value = this.#now();
    if (!Number.isFinite(value.getTime())) {
      throw new LibraryError("internal_contract", "The Library service clock is invalid.");
    }
    return value;
  }

  #cleanupZipPreflights(nowMs: number): void {
    for (const [preflightId, preflight] of this.#zipPreflights) {
      if (preflight.expiresAtMs <= nowMs) this.#zipPreflights.delete(preflightId);
    }
  }

  #allocateZipPreflightId(): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      let candidate: string;
      try {
        candidate = identifierSchema.parse(this.#zipPreflightIdFactory());
      } catch {
        throw new LibraryError(
          "internal_contract",
          "The ZIP preflight identifier factory returned an invalid value."
        );
      }
      if (!this.#zipPreflights.has(candidate)) return candidate;
    }
    throw new LibraryError("conflict", "A unique ZIP preflight identity could not be allocated.");
  }

  async #createZipPreflight(
    mutation: ZipMutation,
    requestedBaseName?: string
  ): Promise<PreflightLibraryMutationResult> {
    const now = this.#safeNow();
    this.#cleanupZipPreflights(now.getTime());
    const preflightId = this.#allocateZipPreflightId();
    const expiresAtMs = now.getTime() + this.#zipPreflightTtlMs;
    const errors = new Map<string, RoutegoServiceError>();
    const assetFingerprints = new Map<string, string>();
    let uploadState: string | undefined;

    const items =
      mutation.action === "export-zip"
        ? await (async () => {
            const index = await this.indexStore.read();
            return mutation.assetIds.map((assetId) => {
              const asset = index.assets.find((candidate) => candidate.id === assetId);
              if (!asset) {
                const error = libraryMutationError(
                  "not_found",
                  "The selected Library asset does not exist."
                );
                errors.set(assetId, error);
                return {
                  targetId: assetId,
                  targetKind: "asset" as const,
                  eligible: false,
                  allowedActions: [],
                  requiredConfirmations: ["zip-export" as const],
                  warnings: [],
                  error
                };
              }
              assetFingerprints.set(assetId, JSON.stringify(asset));
              return {
                targetId: assetId,
                targetKind: "asset" as const,
                eligible: true,
                currentStatus: asset.status,
                allowedActions: ["export-zip" as const],
                requiredConfirmations: ["zip-export" as const],
                warnings: []
              };
            });
          })()
        : await (async () => {
            const status = await this.uploadStore.getUploadResourceStatus({
              uploadResourceId: mutation.uploadResourceId
            });
            uploadState = uploadFingerprint(status);
            const error =
              uploadState === undefined
                ? libraryMutationError(
                    status.status === "failed" && status.error?.code === "not_found"
                      ? "not_found"
                      : "conflict",
                    "The ZIP upload is unavailable, expired, consumed, or not finalized."
                  )
                : undefined;
            if (error) errors.set(mutation.uploadResourceId, error);
            return [
              {
                targetId: mutation.uploadResourceId,
                targetKind: "upload-resource" as const,
                eligible: error === undefined,
                allowedActions: [],
                requiredConfirmations: ["zip-import" as const],
                warnings: [],
                ...(error === undefined ? {} : { error })
              }
            ];
          })();

    const eligibleCount = items.filter((item) => item.eligible).length;
    const status =
      eligibleCount === items.length ? "ready" : eligibleCount === 0 ? "blocked" : "partial";
    const requiredConfirmation =
      mutation.action === "export-zip" ? ("zip-export" as const) : ("zip-import" as const);
    const topError = status === "blocked" ? items.find((item) => item.error)?.error : undefined;
    this.#zipPreflights.set(
      preflightId,
      mutation.action === "export-zip"
        ? {
            id: preflightId,
            action: mutation.action,
            mutation,
            targetIds: [...mutation.assetIds],
            expiresAtMs,
            errors,
            assetFingerprints,
            ...(requestedBaseName === undefined ? {} : { requestedBaseName })
          }
        : {
            id: preflightId,
            action: mutation.action,
            mutation,
            targetIds: [mutation.uploadResourceId],
            expiresAtMs,
            errors,
            assetFingerprints,
            ...(uploadState === undefined ? {} : { uploadFingerprint: uploadState })
          }
    );
    return preflightLibraryMutationResultSchema.parse({
      schemaVersion: 1,
      preflightId,
      action: mutation.action,
      status,
      expiresAt: new Date(expiresAtMs).toISOString(),
      requiredConfirmations: [requiredConfirmation],
      items,
      warnings: [],
      ...(topError === undefined ? {} : { error: topError })
    });
  }

  #zipExecutionFailure(
    preflightId: string,
    action: ZipMutation["action"],
    targetIds: readonly string[],
    error: RoutegoServiceError
  ): ExecuteLibraryMutationResult {
    const items = targetIds.map((targetId) => failedItem(targetId, error));
    return executeLibraryMutationResultSchema.parse({
      schemaVersion: 1,
      preflightId,
      action,
      status: "failed",
      items,
      warnings: [],
      error
    });
  }

  async #executeZipMutation(
    input: ExecuteLibraryMutationInput
  ): Promise<ExecuteLibraryMutationResult> {
    const parsed = executeLibraryMutationInputSchema.parse(input);
    if (parsed.action !== "export-zip" && parsed.action !== "import-zip") {
      throw new LibraryError("invalid_input", "The Library mutation is not a ZIP operation.");
    }
    const now = this.#safeNow();
    const stored = this.#zipPreflights.get(parsed.preflightId);
    if (
      !stored ||
      stored.expiresAtMs <= now.getTime() ||
      stored.action !== parsed.action
    ) {
      if (stored) this.#zipPreflights.delete(parsed.preflightId);
      return this.#zipExecutionFailure(
        parsed.preflightId,
        parsed.action === "import-zip" ? "import-zip" : "export-zip",
        stored?.targetIds ?? [parsed.preflightId],
        libraryMutationError("conflict", "The ZIP preflight is missing, expired, or stale.")
      );
    }
    this.#zipPreflights.delete(parsed.preflightId);

    try {
      if (stored.action === "import-zip") {
        const status = await this.uploadStore.getUploadResourceStatus({
          uploadResourceId: stored.mutation.uploadResourceId
        });
        if (
          stored.uploadFingerprint === undefined ||
          uploadFingerprint(status) !== stored.uploadFingerprint
        ) {
          return this.#zipExecutionFailure(
            stored.id,
            stored.action,
            stored.targetIds,
            libraryMutationError("conflict", "The ZIP upload changed after preflight.")
          );
        }
        return await this.portabilityService.importUpload({
          preflightId: stored.id,
          uploadResourceId: stored.mutation.uploadResourceId
        });
      }

      const index = await this.indexStore.read();
      const failed = new Map(stored.errors);
      const eligibleAssetIds: string[] = [];
      for (const assetId of stored.mutation.assetIds) {
        if (failed.has(assetId)) continue;
        const asset = index.assets.find((candidate) => candidate.id === assetId);
        if (!asset || JSON.stringify(asset) !== stored.assetFingerprints.get(assetId)) {
          failed.set(
            assetId,
            libraryMutationError("conflict", "The Library asset changed after ZIP preflight.")
          );
        } else {
          eligibleAssetIds.push(assetId);
        }
      }
      const portable =
        eligibleAssetIds.length === 0
          ? undefined
          : await this.portabilityService.exportAssets({
              preflightId: stored.id,
              assetIds: eligibleAssetIds,
              ...(stored.requestedBaseName === undefined
                ? {}
                : { requestedBaseName: stored.requestedBaseName })
            });
      const portableByTarget = new Map(portable?.items.map((item) => [item.targetId, item]));
      const items = stored.targetIds.map(
        (targetId) =>
          failed.has(targetId)
            ? failedItem(targetId, failed.get(targetId)!)
            : portableByTarget.get(targetId) ??
              failedItem(
                targetId,
                libraryMutationError(
                  "internal_contract",
                  "The ZIP export omitted a selected Library asset outcome."
                )
              )
      );
      const status = resultStatus(items);
      const topError = status === "failed" ? items.find((item) => item.error)?.error : undefined;
      return executeLibraryMutationResultSchema.parse({
        schemaVersion: 1,
        preflightId: stored.id,
        action: stored.action,
        status,
        items,
        ...(portable?.outputResource === undefined
          ? {}
          : { outputResource: portable.outputResource }),
        warnings: portable?.warnings ?? [],
        ...(topError === undefined ? {} : { error: topError })
      });
    } catch (error) {
      return this.#zipExecutionFailure(
        stored.id,
        stored.action,
        stored.targetIds,
        mutationFailure(error, "The ZIP Library mutation could not be completed.")
      );
    }
  }

  #assertPublicOutputAllowed(
    candidate: string,
    libraryRoot = this.indexStore.paths.root,
    protectedRoots = this.#publicProtectedRoots
  ): void {
    const normalizedCandidate = normalizedPath(candidate, this.#platform);
    const normalizedLibraryRoot = normalizedPath(libraryRoot, this.#platform);
    if (isContained(normalizedLibraryRoot, normalizedCandidate, this.#platform)) return;
    for (const protectedRoot of protectedRoots) {
      if (overlaps(normalizedCandidate, normalizedPath(protectedRoot, this.#platform), this.#platform)) {
        throw new LibraryError(
          "path_unsafe",
          "The requested ZIP output overlaps protected legacy data."
        );
      }
    }
  }

  async #resolvePublicOutputDirectory(absoluteOutputPath: string): Promise<{
    readonly canonicalDirectory: string;
    readonly requestedDirectory: string;
  }> {
    const selectedPath = pathApi(this.#platform);
    this.#assertPublicOutputAllowed(absoluteOutputPath);
    const requestedDirectory = selectedPath.dirname(absoluteOutputPath);
    const requestedFileName = selectedPath.basename(absoluteOutputPath);
    const requestedMetadata = await lstat(requestedDirectory).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw new LibraryError("path_unsafe", "The ZIP output path could not be inspected.", {
        cause: error
      });
    });
    if (requestedMetadata?.isSymbolicLink()) {
      throw new LibraryError("path_unsafe", "The ZIP output directory cannot be a link.");
    }
    const [projectedDirectory, canonicalLibraryRoot, canonicalProtectedRoots] = await Promise.all([
      canonicalizeThroughExistingAncestor(requestedDirectory, this.#platform),
      canonicalizeThroughExistingAncestor(this.indexStore.paths.root, this.#platform),
      canonicalizePathIdentities(this.#publicProtectedRoots, {
        platform: platformKind(this.#platform)
      })
    ]);
    this.#assertPublicOutputAllowed(
      selectedPath.join(projectedDirectory, requestedFileName),
      canonicalLibraryRoot,
      canonicalProtectedRoots
    );
    try {
      await mkdir(projectedDirectory, { recursive: true });
    } catch (error) {
      throw new LibraryError("path_unsafe", "The ZIP output directory could not be created safely.", {
        cause: error
      });
    }
    const canonicalDirectory = await canonicalizeThroughExistingAncestor(
      projectedDirectory,
      this.#platform
    );
    const metadata = await lstat(canonicalDirectory).catch((error: unknown) => {
      throw new LibraryError("path_unsafe", "The ZIP output directory is unavailable.", {
        cause: error
      });
    });
    if (!metadata.isDirectory()) {
      throw new LibraryError("path_unsafe", "The ZIP output destination is not a directory.");
    }
    this.#assertPublicOutputAllowed(
      selectedPath.join(canonicalDirectory, requestedFileName),
      canonicalLibraryRoot,
      canonicalProtectedRoots
    );
    return { canonicalDirectory, requestedDirectory };
  }

  async #copyExportToPublicPath(
    backing: ResolvedBrowserResource,
    requestedPath: string
  ): Promise<string> {
    if (backing.mimeType !== "application/zip") {
      throw new LibraryError("internal_contract", "The ZIP export resource type is invalid.");
    }
    const selectedPath = pathApi(this.#platform);
    const absolute = selectedPath.resolve(requestedPath);
    const extension = selectedPath.extname(absolute);
    const requestedBaseName =
      extension.toLocaleLowerCase("en-US") === ".zip"
        ? selectedPath.basename(absolute, extension)
        : selectedPath.basename(absolute);
    const { canonicalDirectory, requestedDirectory } =
      await this.#resolvePublicOutputDirectory(absolute);
    const output = await createExclusiveFile({
      directory: canonicalDirectory,
      requestedBaseName,
      extension: ".zip"
    });
    try {
      for await (const chunk of createReadStream(backing.path)) {
        await writeAll(output.handle, chunk);
      }
      await output.handle.sync();
      await output.handle.close();
      return selectedPath.join(requestedDirectory, selectedPath.basename(output.path));
    } catch (error) {
      await output.handle.close().catch(() => undefined);
      await unlink(output.path).catch(() => undefined);
      throw new LibraryError("file_write_failed", "The public ZIP export could not be written.", {
        cause: error
      });
    }
  }

  async #stagePublicZip(zipPath: string): Promise<string> {
    const metadata = await lstat(zipPath).catch((error: unknown) => {
      throw new LibraryError("not_found", "The ZIP import source does not exist.", {
        cause: error
      });
    });
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1) {
      throw new LibraryError("path_unsafe", "The ZIP import source must be a regular file.");
    }
    const reserved = await this.uploadStore.reserveUploadResource({
      purpose: "zip-import",
      declaredMimeType: "application/zip",
      declaredByteLength: metadata.size
    });
    if (reserved.status !== "succeeded" || !reserved.resource) {
      throw new LibraryError(
        reserved.error?.code ?? "upload_invalid_type",
        reserved.error?.safeMessage ?? "The ZIP import could not be reserved."
      );
    }
    const uploadResourceId = reserved.resource.uploadResourceId;
    try {
      await this.uploadStore.stageUpload(uploadResourceId, createReadStream(zipPath));
      const finalized = await this.uploadStore.finalizeUploadResource({ uploadResourceId });
      if (finalized.status !== "succeeded") {
        throw new LibraryError(
          finalized.error?.code ?? "upload_invalid_type",
          finalized.error?.safeMessage ?? "The ZIP import source is invalid."
        );
      }
      return uploadResourceId;
    } catch (error) {
      await this.uploadStore
        .discardUploadResource({ uploadResourceId })
        .catch(() => undefined);
      throw error;
    }
  }

  async readSettings(input: ReadSettingsInput): Promise<ReadSettingsResult> {
    return await this.settingsStore.readSettings(input);
  }

  async upsertProviderProfile(
    input: UpsertProviderProfileInput
  ): Promise<UpsertProviderProfileResult> {
    return await this.settingsStore.upsertProviderProfile(input);
  }

  async removeProviderProfile(
    input: RemoveProviderProfileInput
  ): Promise<RemoveProviderProfileResult> {
    return await this.settingsStore.removeProviderProfile(input);
  }

  async setActiveProviderProfile(
    input: SetActiveProviderProfileInput
  ): Promise<SetActiveProviderProfileResult> {
    return await this.settingsStore.setActiveProviderProfile(input);
  }

  async updateSettings(input: UpdateSettingsInput): Promise<UpdateSettingsResult> {
    return await this.settingsStore.updateSettings(input);
  }

  async reserveUploadResource(
    input: ReserveUploadResourceInput
  ): Promise<ReserveUploadResourceResult> {
    return await this.uploadStore.reserveUploadResource(input);
  }

  async finalizeUploadResource(
    input: FinalizeUploadResourceInput
  ): Promise<FinalizeUploadResourceResult> {
    return await this.uploadStore.finalizeUploadResource(input);
  }

  async getUploadResourceStatus(
    input: GetUploadResourceStatusInput
  ): Promise<GetUploadResourceStatusResult> {
    return await this.uploadStore.getUploadResourceStatus(input);
  }

  async discardUploadResource(
    input: DiscardUploadResourceInput
  ): Promise<DiscardUploadResourceResult> {
    return await this.uploadStore.discardUploadResource(input);
  }

  async searchLibrary(input: RoutegoSearchLibraryInput): Promise<RoutegoSearchLibraryResult> {
    return await this.galleryService.searchLibrary(input);
  }

  async searchStudioLibrary(
    input: StudioLibrarySearchInput
  ): Promise<StudioLibrarySearchResult> {
    return await this.galleryService.searchStudioLibrary(input);
  }

  async listFolders(input: ListFoldersInput): Promise<ListFoldersResult> {
    return await this.galleryService.listFolders(input);
  }

  async reorderFolders(input: ReorderFoldersInput): Promise<ReorderFoldersResult> {
    return await this.galleryService.reorderFolders(input);
  }

  async getAssetDetail(input: GetAssetDetailInput): Promise<GetAssetDetailResult> {
    return await this.galleryService.getAssetDetail(input);
  }

  async getBrowserResource(input: GetBrowserResourceInput): Promise<GetBrowserResourceResult> {
    return await this.galleryService.getBrowserResource(input);
  }

  async preflightLibraryMutation(
    input: PreflightLibraryMutationInput
  ): Promise<PreflightLibraryMutationResult> {
    const parsed = preflightLibraryMutationInputSchema.parse(input);
    if (parsed.mutation.action === "export-zip") {
      return await this.#createZipPreflight({
        action: "export-zip",
        assetIds: parsed.mutation.assetIds
      });
    }
    if (parsed.mutation.action === "import-zip") {
      return await this.#createZipPreflight({
        action: "import-zip",
        uploadResourceId: parsed.mutation.uploadResourceId
      });
    }
    return await this.galleryService.preflightLibraryMutation(parsed);
  }

  async executeLibraryMutation(
    input: ExecuteLibraryMutationInput
  ): Promise<ExecuteLibraryMutationResult> {
    const parsed = executeLibraryMutationInputSchema.parse(input);
    if (parsed.action === "export-zip" || parsed.action === "import-zip") {
      return await this.#executeZipMutation(parsed);
    }
    return await this.galleryService.executeLibraryMutation(parsed);
  }

  async manageLibrary(input: RoutegoManageLibraryInput): Promise<RoutegoManageLibraryResult> {
    const parsed = routegoManageLibraryInputSchema.parse(input);
    if (parsed.action !== "export-zip" && parsed.action !== "import-zip") {
      return await this.galleryService.manageLibrary(parsed);
    }

    if (parsed.action === "export-zip") {
      const selectedPath = pathApi(this.#platform);
      const extension = selectedPath.extname(parsed.outputPath);
      const requestedBaseName =
        extension.toLocaleLowerCase("en-US") === ".zip"
          ? selectedPath.basename(parsed.outputPath, extension)
          : selectedPath.basename(parsed.outputPath);
      const preflight = await this.#createZipPreflight(
        { action: "export-zip", assetIds: [...new Set(parsed.assetIds)] },
        requestedBaseName
      );
      const execution = await this.#executeZipMutation({
        preflightId: preflight.preflightId,
        action: "export-zip",
        confirmations: ["zip-export"]
      });
      let outputPath: string | undefined;
      if (execution.outputResource) {
        const backing = this.resourceRegistry.resolve(execution.outputResource.resourceId);
        outputPath = await this.#copyExportToPublicPath(backing, parsed.outputPath);
      }
      return routegoManageLibraryResultSchema.parse({
        schemaVersion: 1,
        action: parsed.action,
        affectedAssetIds: execution.items.flatMap((item) =>
          item.status === "succeeded" && item.affectedAssetId ? [item.affectedAssetId] : []
        ),
        affectedFolderIds: [],
        ...(outputPath === undefined ? {} : { outputPath }),
        warnings: operationWarnings(execution)
      });
    }

    const uploadResourceId = await this.#stagePublicZip(parsed.zipPath);
    const preflight = await this.#createZipPreflight({ action: "import-zip", uploadResourceId });
    const execution = await this.#executeZipMutation({
      preflightId: preflight.preflightId,
      action: "import-zip",
      confirmations: ["zip-import"]
    });
    if (execution.status === "failed") {
      await this.uploadStore
        .discardUploadResource({ uploadResourceId })
        .catch(() => undefined);
    }
    return routegoManageLibraryResultSchema.parse({
      schemaVersion: 1,
      action: parsed.action,
      affectedAssetIds: execution.items.flatMap((item) =>
        item.status === "succeeded" && item.affectedAssetId ? [item.affectedAssetId] : []
      ),
      affectedFolderIds: [
        ...new Set(
          execution.items.flatMap((item) =>
            item.status === "succeeded" ? item.affectedFolderIds : []
          )
        )
      ],
      importedCount: execution.importedCount ?? 0,
      skippedCount: execution.skippedCount ?? 0,
      warnings: operationWarnings(execution)
    });
  }

  async stageUpload(
    uploadResourceId: string,
    source: AsyncIterable<Uint8Array>
  ): Promise<Awaited<ReturnType<UploadStore["stageUpload"]>>> {
    return await this.uploadStore.stageUpload(uploadResourceId, source);
  }

  async resolveImageResource(
    locator: StableImageLocator,
    expectedUploadPurposes?: readonly UploadResourcePurpose[]
  ): Promise<ResolvedStableImageResource> {
    return await this.resourceResolver.resolve(locator, expectedUploadPurposes);
  }

  resolveBrowserResource(resourceId: string): ResolvedBrowserResource {
    return this.resourceRegistry.resolve(resourceId);
  }

  async recover(): Promise<void> {
    await this.indexStore.read();
    await this.galleryService.recover();
    await this.portabilityService.recover();
    await this.uploadStore.cleanupExpired();
  }
}

export function createRoutegoLibraryService(
  options: RoutegoLibraryServiceOptions = {}
): RoutegoLibraryService {
  return new RoutegoLibraryService(options);
}
