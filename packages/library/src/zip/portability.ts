import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import {
  executeLibraryMutationResultSchema,
  identifierSchema,
  type BrowserResourceDescriptor,
  type ExecuteLibraryMutationResult,
  type LibraryOperationParameters,
  type RoutegoServiceError
} from "@routego-image/contracts";

import { LibraryError, isNodeError } from "../errors";
import {
  listTransactionJournals,
  markTransactionJournalCommitted,
  removeTransactionJournal,
  writeTransactionJournal,
  type FileTransactionJournal
} from "../fs/journal";
import { resolveApprovedPath } from "../fs/paths";
import {
  LibraryAssetStore,
  type ValidatedLibraryImage
} from "../gallery/assets";
import { ImageLibraryIndexStore, IMAGE_LIBRARY_BLOB_TRANSACTION_KIND } from "../gallery/index-store";
import { libraryMutationError } from "../gallery/mutations";
import {
  type ImageLibraryIndex,
  type StoredImageBlob,
  type StoredLibraryAsset,
  type StoredLibraryFolder
} from "../gallery/model";
import { BrowserResourceRegistry } from "../gallery/resources";
import { UploadStore } from "../upload/store";
import {
  decodeZipArchive,
  encodeZipArchive,
  publishZipArchive,
  type ZipSourceEntry
} from "./codec";
import {
  PORTABLE_LIBRARY_MANIFEST_ENTRY,
  collectPortableAssetClosure,
  createPortableLibraryManifest,
  parsePortableLibraryManifestBytes,
  portableAssetDependencyIds,
  serializePortableLibraryManifest,
  type PortableImageBlob,
  type PortableLibraryManifest
} from "./manifest";

export const LIBRARY_PORTABILITY_EXPORT_TRANSACTION_KIND =
  "image-library-portability-export-v1";

type MutationItem = ExecuteLibraryMutationResult["items"][number];
type IdKind = "asset" | "artifact" | "folder" | "transaction";

export interface ExportPortableLibraryInput {
  readonly preflightId: string;
  readonly assetIds: readonly string[];
  readonly requestedBaseName?: string;
}

export interface ImportPortableLibraryInput {
  readonly preflightId: string;
  readonly uploadResourceId: string;
}

export interface LibraryPortabilityHooks {
  readonly afterImportJournalsPrepared?: (
    journals: readonly FileTransactionJournal[]
  ) => Promise<void>;
  readonly beforeImportIndexCommit?: (next: {
    readonly blobs: readonly StoredImageBlob[];
    readonly assets: readonly StoredLibraryAsset[];
    readonly folders: readonly StoredLibraryFolder[];
  }) => Promise<void>;
  readonly afterImportIndexCommit?: () => Promise<void>;
}

export interface LibraryPortabilityServiceOptions {
  readonly indexStore: ImageLibraryIndexStore;
  readonly uploadStore: UploadStore;
  readonly resourceRegistry: BrowserResourceRegistry;
  readonly assetStore?: LibraryAssetStore;
  readonly now?: () => Date;
  readonly idFactory?: (kind: IdKind) => string;
  readonly platform?: NodeJS.Platform;
  readonly exportDirectoryRelative?: string;
  readonly hooks?: LibraryPortabilityHooks;
}

interface PreparedImportBlob {
  readonly manifest: PortableImageBlob;
  readonly image: ValidatedLibraryImage;
  readonly tempRelative: string;
  journal: FileTransactionJournal;
}

interface ValidatedPortableArchive {
  readonly manifest: PortableLibraryManifest;
  readonly blobData: ReadonlyMap<string, Buffer>;
}

interface ImportPlan {
  readonly assetMap: ReadonlyMap<string, string>;
  readonly artifactMap: ReadonlyMap<string, string>;
  readonly folderMap: ReadonlyMap<string, string>;
  readonly failures: ReadonlyMap<string, RoutegoServiceError>;
  readonly transformedAssets: ReadonlyMap<string, StoredLibraryAsset>;
  readonly newFolders: readonly StoredLibraryFolder[];
}

function platformKind(platform: NodeJS.Platform): "win32" | "posix" {
  return platform === "win32" ? "win32" : "posix";
}

function pathApi(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function safeNow(now: () => Date): Date {
  const value = now();
  if (!Number.isFinite(value.getTime())) {
    throw new LibraryError("internal_contract", "The Library portability clock is invalid.");
  }
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(filePath: string): Promise<{ readonly byteLength: number; readonly sha256: string }> {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    byteLength += chunk.length;
  }
  return { byteLength, sha256: hash.digest("hex") };
}

function extensionForMime(mimeType: StoredImageBlob["mimeType"]): ".png" | ".jpg" | ".webp" {
  return mimeType === "image/png" ? ".png" : mimeType === "image/jpeg" ? ".jpg" : ".webp";
}

function relativeFromRoot(root: string, candidate: string, platform: NodeJS.Platform): string {
  const selectedPath = pathApi(platform);
  const relative = selectedPath.relative(selectedPath.resolve(root), selectedPath.resolve(candidate));
  if (
    relative === "" ||
    selectedPath.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${selectedPath.sep}`)
  ) {
    throw new LibraryError("path_unsafe", "A portability file escaped the Image Library root.");
  }
  return relative.split(selectedPath.sep).join("/");
}

async function unlinkRegularFile(filePath: string): Promise<void> {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new LibraryError("path_unsafe", "A portability transaction path is unsafe.");
    }
    await unlink(filePath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

async function sameRegularFile(left: string, right: string): Promise<boolean> {
  try {
    const [leftLink, rightLink, leftStat, rightStat] = await Promise.all([
      lstat(left),
      lstat(right),
      stat(left),
      stat(right)
    ]);
    return (
      leftLink.isFile() &&
      rightLink.isFile() &&
      !leftLink.isSymbolicLink() &&
      !rightLink.isSymbolicLink() &&
      leftStat.ino !== 0 &&
      leftStat.dev === rightStat.dev &&
      leftStat.ino === rightStat.ino
    );
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Directory fsync support differs across the supported platforms.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function serviceError(error: unknown, fallback: RoutegoServiceError["code"]): RoutegoServiceError {
  if (error instanceof LibraryError) {
    const code: RoutegoServiceError["code"] =
      error.code === "lock_timeout"
        ? "timeout"
        : error.code === "upload_consumed" ||
            error.code === "upload_discarded" ||
            error.code === "upload_expired"
          ? "conflict"
          : error.code === "upload_checksum_failed" ||
              error.code === "upload_invalid_type" ||
              error.code === "upload_oversize" ||
              error.code === "unsupported_version"
            ? "invalid_input"
            : error.code;
    return libraryMutationError(code, error.message);
  }
  return libraryMutationError(fallback, "The Library portability operation could not be completed.");
}

function successItem(
  targetId: string,
  options: {
    readonly affectedAssetId?: string;
    readonly folderIds?: readonly string[];
    readonly warnings?: readonly string[];
  } = {}
): MutationItem {
  return {
    targetId,
    status: "succeeded",
    ...(options.affectedAssetId === undefined
      ? {}
      : { affectedAssetId: options.affectedAssetId }),
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

function resultStatus(items: readonly MutationItem[]): ExecuteLibraryMutationResult["status"] {
  const succeeded = items.filter((item) => item.status === "succeeded").length;
  return succeeded === items.length ? "succeeded" : succeeded === 0 ? "failed" : "partial";
}

function portabilityResult(options: {
  readonly preflightId: string;
  readonly action: "export-zip" | "import-zip";
  readonly items: readonly MutationItem[];
  readonly outputResource?: BrowserResourceDescriptor;
  readonly importedCount?: number;
  readonly skippedCount?: number;
  readonly warnings?: readonly string[];
}): ExecuteLibraryMutationResult {
  const status = resultStatus(options.items);
  const firstFailure = options.items.find((item) => item.status === "failed")?.error;
  return executeLibraryMutationResultSchema.parse({
    schemaVersion: 1,
    preflightId: options.preflightId,
    action: options.action,
    status,
    items: options.items,
    ...(options.outputResource === undefined ? {} : { outputResource: options.outputResource }),
    ...(options.importedCount === undefined ? {} : { importedCount: options.importedCount }),
    ...(options.skippedCount === undefined ? {} : { skippedCount: options.skippedCount }),
    warnings: options.warnings ? [...options.warnings] : [],
    ...(status === "failed" && firstFailure ? { error: firstFailure } : {})
  });
}

function remapParameters(
  parameters: LibraryOperationParameters,
  assetMap: ReadonlyMap<string, string>
): LibraryOperationParameters {
  const { references, ...rest } = parameters;
  return {
    ...rest,
    ...(parameters.kind !== "edit"
      ? {}
      : {
          target: {
            ...parameters.target,
            assetId: assetMap.get(parameters.target.assetId) ?? parameters.target.assetId
          }
        }),
    references: references.map((reference) => ({
      ...reference,
      assetId: assetMap.get(reference.assetId) ?? reference.assetId
    }))
  };
}

function remapAsset(
  asset: StoredLibraryAsset,
  assetMap: ReadonlyMap<string, string>,
  artifactMap: ReadonlyMap<string, string>,
  folderMap: ReadonlyMap<string, string>
): StoredLibraryAsset {
  return {
    ...asset,
    id: assetMap.get(asset.id) ?? asset.id,
    primaryArtifactId: artifactMap.get(asset.primaryArtifactId) ?? asset.primaryArtifactId,
    requestedParams: remapParameters(asset.requestedParams, assetMap),
    effectiveParams: remapParameters(asset.effectiveParams, assetMap),
    renditions: asset.renditions.map((rendition) => ({
      ...rendition,
      artifactId: artifactMap.get(rendition.artifactId) ?? rendition.artifactId
    })),
    relationships: asset.relationships.map((relationship) => ({
      ...relationship,
      relatedAssetId: assetMap.get(relationship.relatedAssetId) ?? relationship.relatedAssetId,
      ...(relationship.artifactId === undefined
        ? {}
        : {
            artifactId: artifactMap.get(relationship.artifactId) ?? relationship.artifactId
          })
    })),
    folderIds: asset.folderIds.map((folderId) => folderMap.get(folderId) ?? folderId)
  };
}

export class LibraryPortabilityService {
  readonly #indexStore: ImageLibraryIndexStore;
  readonly #uploadStore: UploadStore;
  readonly #resourceRegistry: BrowserResourceRegistry;
  readonly #assetStore: LibraryAssetStore;
  readonly #now: () => Date;
  readonly #idFactory: (kind: IdKind) => string;
  readonly #platform: NodeJS.Platform;
  readonly #exportDirectoryRelative: string;
  readonly #hooks: LibraryPortabilityHooks;

  constructor(options: LibraryPortabilityServiceOptions) {
    this.#indexStore = options.indexStore;
    this.#uploadStore = options.uploadStore;
    this.#resourceRegistry = options.resourceRegistry;
    this.#assetStore = options.assetStore ?? new LibraryAssetStore({ indexStore: options.indexStore });
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? ((kind) => `${kind}-${randomUUID()}`);
    this.#platform = options.platform ?? process.platform;
    const exportDirectory = resolveApprovedPath({
      root: this.#indexStore.paths.root,
      candidate: options.exportDirectoryRelative ?? "exports",
      operation: "create",
      platform: platformKind(this.#platform)
    });
    this.#exportDirectoryRelative = relativeFromRoot(
      this.#indexStore.paths.root,
      exportDirectory,
      this.#platform
    );
    this.#hooks = options.hooks ?? {};
  }

  #newId(kind: IdKind): string {
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

  #allocateId(kind: Exclude<IdKind, "transaction">, used: Set<string>): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = this.#newId(kind);
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
    throw new LibraryError("conflict", `A unique imported ${kind} identity could not be allocated.`);
  }

  async #recoverExportJournals(): Promise<void> {
    for (const journal of await listTransactionJournals(this.#indexStore.paths.root)) {
      if (journal.kind !== LIBRARY_PORTABILITY_EXPORT_TRANSACTION_KIND) continue;
      if (
        journal.deleteAfterCommitPaths.length !== 0 ||
        journal.createdPaths.length < 1 ||
        journal.createdPaths.length > 2 ||
        journal.createdPaths.some((candidate) => {
          const prefix = `${this.#exportDirectoryRelative}/`;
          if (!candidate.startsWith(prefix)) return true;
          const name = candidate.slice(prefix.length);
          return !(
            /^\.routego-zip-[A-Za-z0-9._-]+\.tmp$/u.test(name) ||
            /^[^/]+\.zip$/u.test(name)
          );
        })
      ) {
        throw new LibraryError("config_corrupt", "A Library portability export journal is invalid.");
      }
      const tempRelative = journal.createdPaths.find((candidate) => candidate.endsWith(".tmp"));
      const finalRelative = journal.createdPaths.find((candidate) => candidate.endsWith(".zip"));
      if (tempRelative && finalRelative) {
        const tempPath = resolveApprovedPath({
          root: this.#indexStore.paths.root,
          candidate: tempRelative,
          operation: "delete",
          platform: platformKind(this.#platform)
        });
        const finalPath = resolveApprovedPath({
          root: this.#indexStore.paths.root,
          candidate: finalRelative,
          operation: "delete",
          platform: platformKind(this.#platform)
        });
        if (await sameRegularFile(tempPath, finalPath)) await unlinkRegularFile(finalPath);
      }
      if (tempRelative) {
        await unlinkRegularFile(
          resolveApprovedPath({
            root: this.#indexStore.paths.root,
            candidate: tempRelative,
            operation: "delete",
            platform: platformKind(this.#platform)
          })
        );
      }
      await removeTransactionJournal(this.#indexStore.paths.root, journal.id);
    }
  }

  async recover(): Promise<void> {
    await this.#indexStore.runExclusive(async () => {
      await this.#recoverExportJournals();
    });
  }

  async exportAssets(input: ExportPortableLibraryInput): Promise<ExecuteLibraryMutationResult> {
    const preflightId = identifierSchema.parse(input.preflightId);
    if (
      input.assetIds.length < 1 ||
      input.assetIds.length > 200 ||
      new Set(input.assetIds).size !== input.assetIds.length
    ) {
      throw new LibraryError("invalid_input", "Portable export asset identities are invalid.");
    }
    return await this.#indexStore.runExclusive(async ({ index }) => {
      await this.#recoverExportJournals();
      const failures = new Map<string, RoutegoServiceError>();
      const closures = new Map<string, ReturnType<typeof collectPortableAssetClosure>>();
      for (const assetId of input.assetIds) {
        try {
          closures.set(assetId, collectPortableAssetClosure(index, assetId));
        } catch (error) {
          failures.set(assetId, serviceError(error, "invalid_input"));
        }
      }
      const candidateClosures = [...closures.entries()].filter(([assetId]) => !failures.has(assetId));
      const requiredBlobShas = new Set(
        candidateClosures.flatMap(([, closure]) => [...closure.blobSha256s])
      );
      const blobBySha = new Map(index.blobs.map((blob) => [blob.sha256, blob]));
      const blobBytes = new Map<string, Buffer>();
      const blobErrors = new Map<string, RoutegoServiceError>();
      for (const blobSha of requiredBlobShas) {
        const blob = blobBySha.get(blobSha);
        if (!blob) {
          blobErrors.set(
            blobSha,
            libraryMutationError("config_corrupt", "A selected Library blob is missing.")
          );
          continue;
        }
        try {
          const image = await this.#assetStore.validateSource(
            this.#indexStore.paths.root,
            blob.relativePath,
            blob
          );
          blobBytes.set(blobSha, image.bytes);
        } catch (error) {
          blobErrors.set(blobSha, serviceError(error, "config_corrupt"));
        }
      }
      for (const [assetId, closure] of candidateClosures) {
        const errorSha = [...closure.blobSha256s].find((sha) => blobErrors.has(sha));
        if (errorSha) failures.set(assetId, blobErrors.get(errorSha)!);
      }
      const successfulSelections = input.assetIds.filter((assetId) => !failures.has(assetId));
      if (successfulSelections.length === 0) {
        return portabilityResult({
          preflightId,
          action: "export-zip",
          items: input.assetIds.map((assetId) => failedItem(assetId, failures.get(assetId)!))
        });
      }

      let manifest: PortableLibraryManifest;
      try {
        manifest = createPortableLibraryManifest(
          index,
          successfulSelections,
          safeNow(this.#now).toISOString()
        );
      } catch (error) {
        const structured = serviceError(error, "invalid_input");
        for (const assetId of successfulSelections) failures.set(assetId, structured);
        return portabilityResult({
          preflightId,
          action: "export-zip",
          items: input.assetIds.map((assetId) => failedItem(assetId, failures.get(assetId)!))
        });
      }
      const manifestBytes = serializePortableLibraryManifest(manifest);
      const entries: ZipSourceEntry[] = [
        { name: PORTABLE_LIBRARY_MANIFEST_ENTRY, data: manifestBytes, compression: "deflate" },
        ...manifest.blobs.map((blob) => ({
          name: blob.entryName,
          data: blobBytes.get(blob.sha256)!,
          compression: "store" as const
        }))
      ];
      const expectedArchive = encodeZipArchive(entries);
      const expectedSha256 = sha256(expectedArchive);
      const transactionId = this.#newId("transaction");
      let journal: FileTransactionJournal | undefined;
      let publishedRelative: string | undefined;
      try {
        const directory = resolveApprovedPath({
          root: this.#indexStore.paths.root,
          candidate: this.#exportDirectoryRelative,
          operation: "create",
          platform: platformKind(this.#platform)
        });
        const published = await publishZipArchive(entries, {
          directory,
          requestedBaseName: input.requestedBaseName ?? "routego-image-library",
          hooks: {
            afterTemporaryFileSynced: async (temporaryPath) => {
              const tempRelative = relativeFromRoot(
                this.#indexStore.paths.root,
                temporaryPath,
                this.#platform
              );
              journal = {
                schemaVersion: 1,
                id: transactionId,
                kind: LIBRARY_PORTABILITY_EXPORT_TRANSACTION_KIND,
                state: "prepared",
                createdAt: safeNow(this.#now).toISOString(),
                createdPaths: [tempRelative],
                deleteAfterCommitPaths: [],
                metadata: {
                  expectedSha256,
                  expectedByteLength: expectedArchive.byteLength
                }
              };
              await writeTransactionJournal(this.#indexStore.paths.root, journal);
            },
            beforePublish: async (_temporaryPath, finalPath) => {
              if (!journal) {
                throw new LibraryError("internal_contract", "The ZIP export journal was not prepared.");
              }
              const finalRelative = relativeFromRoot(
                this.#indexStore.paths.root,
                finalPath,
                this.#platform
              );
              journal = {
                ...journal,
                createdPaths: [journal.createdPaths[0]!, finalRelative],
                metadata: { ...journal.metadata, finalPath: finalRelative }
              };
              await writeTransactionJournal(this.#indexStore.paths.root, journal);
            }
          }
        });
        publishedRelative = relativeFromRoot(
          this.#indexStore.paths.root,
          published.path,
          this.#platform
        );
        const actual = await sha256File(published.path);
        if (
          actual.byteLength !== expectedArchive.byteLength ||
          actual.sha256 !== expectedSha256
        ) {
          throw new LibraryError("upload_checksum_failed", "The published ZIP failed integrity validation.");
        }
        const outputResource = await this.#resourceRegistry.registerZip({
          relativePath: publishedRelative,
          byteLength: actual.byteLength,
          sha256: actual.sha256
        });
        if (journal) await removeTransactionJournal(this.#indexStore.paths.root, journal.id);
        return portabilityResult({
          preflightId,
          action: "export-zip",
          items: input.assetIds.map((assetId) =>
            failures.has(assetId)
              ? failedItem(assetId, failures.get(assetId)!)
              : successItem(assetId)
          ),
          outputResource
        });
      } catch (error) {
        if (publishedRelative) {
          await unlinkRegularFile(
            resolveApprovedPath({
              root: this.#indexStore.paths.root,
              candidate: publishedRelative,
              operation: "delete",
              platform: platformKind(this.#platform)
            })
          ).catch(() => undefined);
        }
        if (journal) {
          await this.#recoverExportJournals().catch(() => undefined);
        }
        const structured = serviceError(error, "file_write_failed");
        for (const assetId of successfulSelections) failures.set(assetId, structured);
        return portabilityResult({
          preflightId,
          action: "export-zip",
          items: input.assetIds.map((assetId) => failedItem(assetId, failures.get(assetId)!))
        });
      }
    });
  }

  async #readAndValidateArchive(uploadResourceId: string): Promise<ValidatedPortableArchive> {
    const upload = await this.#uploadStore.resolveUploadResource(uploadResourceId, ["zip-import"]);
    if (upload.mimeType !== "application/zip") {
      throw new LibraryError("upload_invalid_type", "The upload is not a finalized ZIP import.");
    }
    const bytes = await readFile(upload.path);
    if (bytes.byteLength !== upload.byteLength || sha256(bytes) !== upload.sha256) {
      throw new LibraryError("upload_checksum_failed", "The ZIP upload changed during import.");
    }
    const archive = decodeZipArchive(bytes);
    const entryByName = new Map(archive.entries.map((entry) => [entry.name, entry]));
    const manifestEntry = entryByName.get(PORTABLE_LIBRARY_MANIFEST_ENTRY);
    if (!manifestEntry) {
      throw new LibraryError("upload_invalid_type", "The portable ZIP manifest is missing.");
    }
    const manifest = parsePortableLibraryManifestBytes(manifestEntry.data);
    const expectedNames = new Set([
      PORTABLE_LIBRARY_MANIFEST_ENTRY,
      ...manifest.blobs.map((blob) => blob.entryName)
    ]);
    if (
      archive.entries.length !== expectedNames.size ||
      archive.entries.some((entry) => !expectedNames.has(entry.name))
    ) {
      throw new LibraryError("upload_invalid_type", "The portable ZIP entries do not match the manifest.");
    }
    const blobData = new Map<string, Buffer>();
    for (const blob of manifest.blobs) {
      const entry = entryByName.get(blob.entryName);
      if (
        !entry ||
        entry.data.byteLength !== blob.byteLength ||
        sha256(entry.data) !== blob.sha256
      ) {
        throw new LibraryError("upload_checksum_failed", "A portable image entry failed integrity validation.");
      }
      blobData.set(blob.sha256, entry.data);
    }
    return { manifest, blobData };
  }

  async #prepareImportBlobs(
    manifest: PortableLibraryManifest,
    blobData: ReadonlyMap<string, Buffer>,
    expectedRevision: number,
    createdAt: string
  ): Promise<PreparedImportBlob[]> {
    const prepared: PreparedImportBlob[] = [];
    const created: { readonly journal: FileTransactionJournal; readonly tempRelative: string }[] = [];
    try {
      for (const [index, blob] of manifest.blobs.entries()) {
        const transactionId = this.#newId("transaction");
        void index;
        const tempRelative = `.transactions/files/${transactionId}.tmp`;
        const journal: FileTransactionJournal = {
          schemaVersion: 1,
          id: transactionId,
          kind: IMAGE_LIBRARY_BLOB_TRANSACTION_KIND,
          state: "prepared",
          createdAt,
          createdPaths: [tempRelative],
          deleteAfterCommitPaths: [],
          metadata: {
            tempPath: tempRelative,
            sha256: blob.sha256,
            expectedRevision
          }
        };
        await writeTransactionJournal(this.#indexStore.paths.root, journal);
        created.push({ journal, tempRelative });
        const tempPath = resolveApprovedPath({
          root: this.#indexStore.paths.root,
          candidate: tempRelative,
          operation: "create",
          platform: platformKind(this.#platform)
        });
        const handle = await open(tempPath, "wx", 0o600);
        try {
          await handle.writeFile(blobData.get(blob.sha256)!);
          await handle.sync();
        } finally {
          await handle.close();
        }
        const image = await this.#assetStore.validateSource(
          this.#indexStore.paths.root,
          tempRelative,
          blob
        );
        prepared.push({
          manifest: blob,
          image,
          tempRelative,
          journal
        });
      }
      return prepared;
    } catch (error) {
      for (const item of created) {
        await unlinkRegularFile(
          resolveApprovedPath({
            root: this.#indexStore.paths.root,
            candidate: item.tempRelative,
            operation: "delete",
            platform: platformKind(this.#platform)
          })
        ).catch(() => undefined);
        await removeTransactionJournal(this.#indexStore.paths.root, item.journal.id).catch(
          () => undefined
        );
      }
      throw error;
    }
  }

  #buildImportPlan(
    index: ImageLibraryIndex,
    manifest: PortableLibraryManifest,
    initialFailures: ReadonlyMap<string, RoutegoServiceError>
  ): ImportPlan {
    const failures = new Map(initialFailures);
    const existingAssetById = new Map(index.assets.map((asset) => [asset.id, asset]));
    const existingFolderById = new Map(index.folders.map((folder) => [folder.id, folder]));
    const existingActiveFolderByName = new Map(
      index.folders
        .filter((folder) => folder.state === "active")
        .map((folder) => [folder.normalizedName, folder])
    );
    const existingArtifactOwner = new Map<string, string>();
    for (const asset of index.assets) {
      for (const rendition of asset.renditions) {
        existingArtifactOwner.set(rendition.artifactId, asset.id);
      }
    }

    const usedFolderIds = new Set([
      ...index.folders.map((folder) => folder.id),
      ...manifest.folders.map((folder) => folder.id)
    ]);
    const folderMap = new Map<string, string>();
    const newFolderBySource = new Map<string, StoredLibraryFolder>();
    const folderFailures = new Map<string, RoutegoServiceError>();
    for (const folder of manifest.folders) {
      const existingById = existingFolderById.get(folder.id);
      const existingByName =
        folder.state === "active" ? existingActiveFolderByName.get(folder.normalizedName) : undefined;
      if (existingById && isDeepStrictEqual(existingById, folder)) {
        folderMap.set(folder.id, folder.id);
        continue;
      }
      if (existingByName) {
        folderMap.set(folder.id, existingByName.id);
        continue;
      }
      let mappedId = folder.id;
      if (existingById) {
        try {
          mappedId = this.#allocateId("folder", usedFolderIds);
        } catch (error) {
          folderFailures.set(folder.id, serviceError(error, "conflict"));
          continue;
        }
      }
      folderMap.set(folder.id, mappedId);
      newFolderBySource.set(folder.id, { ...folder, id: mappedId });
    }
    for (const asset of manifest.assets) {
      const failedFolder = asset.folderIds.find((folderId) => folderFailures.has(folderId));
      if (failedFolder) failures.set(asset.id, folderFailures.get(failedFolder)!);
    }

    const usedAssetIds = new Set([
      ...index.assets.map((asset) => asset.id),
      ...manifest.assets.map((asset) => asset.id)
    ]);
    const usedArtifactIds = new Set([
      ...existingArtifactOwner.keys(),
      ...manifest.assets.flatMap((asset) =>
        asset.renditions.map((rendition) => rendition.artifactId)
      )
    ]);
    const assetMap = new Map(manifest.assets.map((asset) => [asset.id, asset.id]));
    const artifactMap = new Map(
      manifest.assets.flatMap((asset) =>
        asset.renditions.map((rendition) => [rendition.artifactId, rendition.artifactId] as const)
      )
    );
    const exactAssets = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      exactAssets.clear();
      for (const asset of manifest.assets) {
        if (failures.has(asset.id) || assetMap.get(asset.id) !== asset.id) continue;
        const existing = existingAssetById.get(asset.id);
        if (!existing) continue;
        const transformed = remapAsset(asset, assetMap, artifactMap, folderMap);
        if (isDeepStrictEqual(existing, transformed)) {
          exactAssets.add(asset.id);
          continue;
        }
        try {
          assetMap.set(asset.id, this.#allocateId("asset", usedAssetIds));
          changed = true;
        } catch (error) {
          failures.set(asset.id, serviceError(error, "conflict"));
        }
      }
      for (const asset of manifest.assets) {
        if (failures.has(asset.id)) continue;
        for (const rendition of asset.renditions) {
          if (artifactMap.get(rendition.artifactId) !== rendition.artifactId) continue;
          const existingOwner = existingArtifactOwner.get(rendition.artifactId);
          if (!existingOwner) continue;
          const canReuse =
            assetMap.get(asset.id) === asset.id &&
            exactAssets.has(asset.id) &&
            existingOwner === asset.id;
          if (canReuse) continue;
          try {
            artifactMap.set(
              rendition.artifactId,
              this.#allocateId("artifact", usedArtifactIds)
            );
            changed = true;
          } catch (error) {
            failures.set(asset.id, serviceError(error, "conflict"));
            break;
          }
        }
      }
    }

    let propagated = true;
    while (propagated) {
      propagated = false;
      for (const asset of manifest.assets) {
        if (failures.has(asset.id)) continue;
        const failedDependency = [...portableAssetDependencyIds(asset)].find((assetId) =>
          failures.has(assetId)
        );
        if (failedDependency) {
          failures.set(
            asset.id,
            libraryMutationError(
              "conflict",
              "An imported asset dependency could not be integrated."
            )
          );
          propagated = true;
        }
      }
    }

    const transformedAssets = new Map<string, StoredLibraryAsset>();
    for (const asset of manifest.assets) {
      if (failures.has(asset.id)) continue;
      const transformed = remapAsset(asset, assetMap, artifactMap, folderMap);
      const existing = existingAssetById.get(transformed.id);
      if (existing && !isDeepStrictEqual(existing, transformed)) {
        failures.set(
          asset.id,
          libraryMutationError("conflict", "The imported asset identity remains conflicted.")
        );
        continue;
      }
      transformedAssets.set(asset.id, transformed);
    }

    const referencedFolderIds = new Set(
      [...transformedAssets.entries()]
        .filter(([assetId]) => !failures.has(assetId))
        .flatMap(([, asset]) => asset.folderIds)
    );
    const newFolders = [...newFolderBySource.entries()]
      .filter(([sourceId, folder]) =>
        !folderFailures.has(sourceId) && referencedFolderIds.has(folder.id)
      )
      .map(([, folder]) => folder);
    return { assetMap, artifactMap, folderMap, failures, transformedAssets, newFolders };
  }

  async #publishImportedBlob(
    prepared: PreparedImportBlob
  ): Promise<StoredImageBlob> {
    const createdAt = new Date(prepared.manifest.createdAt);
    const year = String(createdAt.getUTCFullYear()).padStart(4, "0");
    const month = String(createdAt.getUTCMonth() + 1).padStart(2, "0");
    const directoryRelative = `blobs/${year}/${month}`;
    const directory = resolveApprovedPath({
      root: this.#indexStore.paths.root,
      candidate: directoryRelative,
      operation: "create",
      platform: platformKind(this.#platform)
    });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const tempPath = resolveApprovedPath({
      root: this.#indexStore.paths.root,
      candidate: prepared.tempRelative,
      operation: "read",
      platform: platformKind(this.#platform)
    });
    let finalRelative: string | undefined;
    for (let attempt = 1; attempt <= 10_000; attempt += 1) {
      const suffix = attempt === 1 ? "" : `-${attempt}`;
      const candidateRelative = `${directoryRelative}/${prepared.manifest.sha256}${suffix}${extensionForMime(
        prepared.manifest.mimeType
      )}`;
      const candidatePath = resolveApprovedPath({
        root: this.#indexStore.paths.root,
        candidate: candidateRelative,
        operation: "create",
        platform: platformKind(this.#platform)
      });
      prepared.journal = {
        ...prepared.journal,
        createdPaths: [prepared.tempRelative, candidateRelative],
        metadata: { ...prepared.journal.metadata, finalPath: candidateRelative }
      };
      await writeTransactionJournal(this.#indexStore.paths.root, prepared.journal);
      try {
        await link(tempPath, candidatePath);
        await syncDirectoryBestEffort(directory);
        finalRelative = candidateRelative;
        break;
      } catch (error) {
        if (isNodeError(error, "EEXIST")) continue;
        throw new LibraryError("file_write_failed", "An imported Library blob could not be published.", {
          cause: error
        });
      }
    }
    if (!finalRelative) {
      throw new LibraryError("conflict", "No exclusive imported Library filename was available.");
    }
    return {
      sha256: prepared.image.sha256,
      relativePath: finalRelative,
      mimeType: prepared.image.mimeType,
      byteLength: prepared.image.byteLength,
      width: prepared.image.width,
      height: prepared.image.height,
      createdAt: prepared.manifest.createdAt
    };
  }

  async #cleanupPreparedBlobs(prepared: readonly PreparedImportBlob[]): Promise<void> {
    for (const item of prepared) {
      await unlinkRegularFile(
        resolveApprovedPath({
          root: this.#indexStore.paths.root,
          candidate: item.tempRelative,
          operation: "delete",
          platform: platformKind(this.#platform)
        })
      ).catch(() => undefined);
      await removeTransactionJournal(this.#indexStore.paths.root, item.journal.id).catch(
        () => undefined
      );
    }
  }

  async #finishPreparedBlobs(prepared: readonly PreparedImportBlob[]): Promise<void> {
    for (const item of prepared) {
      await markTransactionJournalCommitted(this.#indexStore.paths.root, item.journal);
      await unlinkRegularFile(
        resolveApprovedPath({
          root: this.#indexStore.paths.root,
          candidate: item.tempRelative,
          operation: "delete",
          platform: platformKind(this.#platform)
        })
      );
      await removeTransactionJournal(this.#indexStore.paths.root, item.journal.id);
    }
  }

  async importUpload(input: ImportPortableLibraryInput): Promise<ExecuteLibraryMutationResult> {
    const preflightId = identifierSchema.parse(input.preflightId);
    const uploadResourceId = identifierSchema.parse(input.uploadResourceId);
    let archive: ValidatedPortableArchive;
    try {
      archive = await this.#readAndValidateArchive(uploadResourceId);
    } catch (error) {
      return portabilityResult({
        preflightId,
        action: "import-zip",
        items: [failedItem(uploadResourceId, serviceError(error, "invalid_input"))],
        importedCount: 0,
        skippedCount: 0
      });
    }

    return await this.#indexStore.runExclusive(async ({ index, commit }) => {
      await this.#recoverExportJournals();
      const preparedAt = safeNow(this.#now).toISOString();
      let prepared: PreparedImportBlob[];
      try {
        prepared = await this.#prepareImportBlobs(
          archive.manifest,
          archive.blobData,
          index.revision + 1,
          preparedAt
        );
      } catch (error) {
        return portabilityResult({
          preflightId,
          action: "import-zip",
          items: archive.manifest.assets.map((asset) =>
            failedItem(asset.id, serviceError(error, "invalid_input"))
          ),
          importedCount: 0,
          skippedCount: 0
        });
      }
      if (this.#hooks.afterImportJournalsPrepared) {
        await this.#hooks.afterImportJournalsPrepared(prepared.map((item) => item.journal));
      }

      const preparedBySha = new Map(prepared.map((item) => [item.manifest.sha256, item]));
      const existingBlobBySha = new Map(index.blobs.map((blob) => [blob.sha256, blob]));
      const blobFailures = new Map<string, RoutegoServiceError>();
      for (const blob of archive.manifest.blobs) {
        const existing = existingBlobBySha.get(blob.sha256);
        if (!existing) continue;
        if (
          existing.mimeType !== blob.mimeType ||
          existing.byteLength !== blob.byteLength ||
          existing.width !== blob.width ||
          existing.height !== blob.height
        ) {
          blobFailures.set(
            blob.sha256,
            libraryMutationError("config_corrupt", "An existing Library blob conflicts with the import.")
          );
          continue;
        }
        try {
          await this.#assetStore.validateSource(
            this.#indexStore.paths.root,
            existing.relativePath,
            existing
          );
        } catch (error) {
          blobFailures.set(blob.sha256, serviceError(error, "config_corrupt"));
        }
      }
      const initialFailures = new Map<string, RoutegoServiceError>();
      for (const asset of archive.manifest.assets) {
        const failedBlob = asset.renditions.find((rendition) =>
          blobFailures.has(rendition.blobSha256)
        )?.blobSha256;
        if (failedBlob) initialFailures.set(asset.id, blobFailures.get(failedBlob)!);
      }
      const plan = this.#buildImportPlan(index, archive.manifest, initialFailures);
      const failed = new Map(plan.failures);
      let propagate = true;
      while (propagate) {
        propagate = false;
        for (const asset of archive.manifest.assets) {
          if (failed.has(asset.id)) continue;
          if ([...portableAssetDependencyIds(asset)].some((dependency) => failed.has(dependency))) {
            failed.set(
              asset.id,
              libraryMutationError("conflict", "An imported asset dependency could not be integrated.")
            );
            propagate = true;
          }
        }
      }

      const existingAssetById = new Map(index.assets.map((asset) => [asset.id, asset]));
      const items: MutationItem[] = [];
      const newAssets: StoredLibraryAsset[] = [];
      for (const asset of archive.manifest.assets) {
        const error = failed.get(asset.id);
        if (error) {
          items.push(failedItem(asset.id, error));
          continue;
        }
        const transformed = plan.transformedAssets.get(asset.id)!;
        const existing = existingAssetById.get(transformed.id);
        if (existing && isDeepStrictEqual(existing, transformed)) {
          items.push(skippedItem(asset.id, "The exact Library asset record already exists."));
          continue;
        }
        newAssets.push(transformed);
        const warnings: string[] = [];
        if (transformed.id !== asset.id) warnings.push("The imported asset identity was remapped.");
        if (
          asset.renditions.some(
            (rendition) =>
              (plan.artifactMap.get(rendition.artifactId) ?? rendition.artifactId) !==
              rendition.artifactId
          )
        ) {
          warnings.push("One or more imported artifact identities were remapped.");
        }
        if (
          asset.folderIds.some(
            (folderId) => (plan.folderMap.get(folderId) ?? folderId) !== folderId
          )
        ) {
          warnings.push("One or more imported folder identities were remapped.");
        }
        items.push(
          successItem(asset.id, {
            affectedAssetId: transformed.id,
            folderIds: transformed.folderIds,
            warnings
          })
        );
      }

      const eligibleAssetIds = new Set(
        archive.manifest.assets
          .filter((asset) => !failed.has(asset.id))
          .map((asset) => asset.id)
      );
      if (eligibleAssetIds.size === 0) {
        await this.#cleanupPreparedBlobs(prepared);
        return portabilityResult({
          preflightId,
          action: "import-zip",
          items,
          importedCount: 0,
          skippedCount: 0
        });
      }

      const neededBlobShas = new Set(
        newAssets.flatMap((asset) =>
          asset.renditions.map((rendition) => rendition.blobSha256)
        )
      );
      const newBlobs: StoredImageBlob[] = [];
      for (const blobSha of neededBlobShas) {
        if (existingBlobBySha.has(blobSha)) continue;
        const importedBlob = await this.#publishImportedBlob(preparedBySha.get(blobSha)!);
        newBlobs.push(importedBlob);
        existingBlobBySha.set(blobSha, importedBlob);
      }
      const referencedFolderIds = new Set(newAssets.flatMap((asset) => asset.folderIds));
      const newFolders = plan.newFolders.filter((folder) => referencedFolderIds.has(folder.id));
      const next = {
        blobs: [...index.blobs, ...newBlobs],
        assets: [...index.assets, ...newAssets],
        folders: [...index.folders, ...newFolders]
      };
      if (this.#hooks.beforeImportIndexCommit) await this.#hooks.beforeImportIndexCommit(next);
      await commit(next);
      if (this.#hooks.afterImportIndexCommit) await this.#hooks.afterImportIndexCommit();
      await this.#finishPreparedBlobs(prepared);
      await this.#uploadStore.consumeZipUpload(uploadResourceId);
      return portabilityResult({
        preflightId,
        action: "import-zip",
        items,
        importedCount: items.filter((item) => item.status === "succeeded").length,
        skippedCount: items.filter((item) => item.status === "skipped").length
      });
    });
  }
}
