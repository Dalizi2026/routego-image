import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createReadStream } from "node:fs";
import {
  access,
  link,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { TextDecoder } from "node:util";

import {
  discardUploadResourceInputSchema,
  discardUploadResourceResultSchema,
  finalizeUploadResourceInputSchema,
  finalizeUploadResourceResultSchema,
  getUploadResourceStatusInputSchema,
  getUploadResourceStatusResultSchema,
  identifierSchema,
  reserveUploadResourceInputSchema,
  reserveUploadResourceResultSchema,
  uploadResourceDescriptorSchema,
  uploadServiceErrorSchema,
  type DiscardUploadResourceInput,
  type DiscardUploadResourceResult,
  type FinalizeUploadResourceInput,
  type FinalizeUploadResourceResult,
  type GetUploadResourceStatusInput,
  type GetUploadResourceStatusResult,
  type ReserveUploadResourceInput,
  type ReserveUploadResourceResult,
  type UploadMimeType,
  type UploadResourceDescriptor,
  type UploadResourcePurpose,
  type UploadServiceError
} from "@routego-image/contracts";

import { LibraryError, isNodeError } from "../errors";
import { cleanupAtomicJsonTemporaryFiles, writeJsonAtomic } from "../fs/atomic-json";
import { acquireFileLock, type AcquireFileLockOptions } from "../fs/lock";
import { resolveApprovedPath } from "../fs/paths";
import { ensurePrivateDirectory } from "../fs/permissions";
import { inspectUploadContent } from "../image/metadata";
import {
  createEmptyUploadRegistry,
  parseUploadRegistryDocument,
  type StoredUploadRecord,
  type UploadRegistryDocument
} from "./model";

export const DEFAULT_IMAGE_UPLOAD_MAX_BYTES = 52_428_800;
export const DEFAULT_ZIP_UPLOAD_MAX_BYTES = 536_870_912;
export const DEFAULT_UPLOAD_EXPIRY_MS = 5 * 60 * 1_000;

export interface UploadStoragePaths {
  readonly root: string;
  readonly registry: string;
  readonly registryLock: string;
  readonly objects: string;
  readonly locks: string;
}

export interface ResolvedUploadResource {
  readonly uploadResourceId: string;
  readonly purpose: UploadResourcePurpose;
  readonly path: string;
  readonly mimeType: UploadMimeType;
  readonly byteLength: number;
  readonly sha256: string;
  readonly width?: number;
  readonly height?: number;
  readonly expiresAt: string;
  readonly reusePolicy: "reusable-until-expiry" | "single-consume";
}

export interface UploadStoreOptions {
  readonly dataRoot?: string;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly lockOptions?: AcquireFileLockOptions;
  readonly imageMaxBytes?: number;
  readonly zipMaxBytes?: number;
  readonly expiryMs?: number;
}

function pathApi(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

export function createUploadStoragePaths(options: {
  readonly dataRoot?: string;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
} = {}): UploadStoragePaths {
  const platform = options.platform ?? process.platform;
  const selectedPath = pathApi(platform);
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const dataRoot = selectedPath.resolve(
    options.dataRoot ?? selectedPath.join(homeDirectory, ".codex", "routego-image")
  );
  const root = selectedPath.join(dataRoot, "uploads");
  return {
    root,
    registry: selectedPath.join(root, "registry.json"),
    registryLock: selectedPath.join(root, ".locks", "registry.lock"),
    objects: selectedPath.join(root, "objects"),
    locks: selectedPath.join(root, ".locks", "resources")
  };
}

function allowedMimeTypes(purpose: UploadResourcePurpose): readonly UploadMimeType[] {
  if (purpose === "zip-import") return ["application/zip"];
  if (purpose === "mask") return ["image/png"];
  return ["image/png", "image/jpeg", "image/webp"];
}

function uploadError(
  code:
    | "not_found"
    | "upload_expired"
    | "upload_invalid_type"
    | "upload_oversize"
    | "upload_checksum_failed"
    | "upload_consumed"
    | "upload_discarded",
  safeMessage: string
): UploadServiceError {
  const policy = {
    not_found: { category: "persistence", stage: "persist", httpStatus: 404 },
    upload_expired: { category: "persistence", stage: "persist", httpStatus: 410 },
    upload_invalid_type: { category: "validation", stage: "validate", httpStatus: 415 },
    upload_oversize: { category: "validation", stage: "validate", httpStatus: 413 },
    upload_checksum_failed: { category: "validation", stage: "validate", httpStatus: 422 },
    upload_consumed: { category: "persistence", stage: "persist", httpStatus: 409 },
    upload_discarded: { category: "persistence", stage: "persist", httpStatus: 410 }
  } as const;
  return uploadServiceErrorSchema.parse({
    code,
    category: policy[code].category,
    stage: policy[code].stage,
    safeMessage,
    retryDisposition: "never",
    httpStatus: policy[code].httpStatus,
    partialArtifacts: [],
    receivedAnyOutput: false,
    mayHaveBilled: false
  });
}

function safeRegistryError(): LibraryError {
  return new LibraryError("config_corrupt", "The upload registry is malformed or invalid.");
}

async function readRegistryValue(filePath: string): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw error;
    throw safeRegistryError();
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw safeRegistryError();
  }
}

async function readRegistryRecovering(filePath: string): Promise<UploadRegistryDocument | undefined> {
  let primaryError: unknown;
  try {
    return parseUploadRegistryDocument(await readRegistryValue(filePath));
  } catch (error) {
    if (error instanceof LibraryError && error.code === "unsupported_version") throw error;
    primaryError = error;
  }
  try {
    const recovered = parseUploadRegistryDocument(await readRegistryValue(`${filePath}.bak`));
    if (!isNodeError(primaryError, "ENOENT")) {
      try {
        await rename(filePath, `${filePath}.corrupt-${randomUUID()}`);
      } catch {
        throw safeRegistryError();
      }
    }
    await writeJsonAtomic(filePath, recovered);
    return recovered;
  } catch (backupError) {
    if (backupError instanceof LibraryError && backupError.code === "unsupported_version") {
      throw backupError;
    }
    if (isNodeError(primaryError, "ENOENT") && isNodeError(backupError, "ENOENT")) return undefined;
    if (isNodeError(primaryError, "ENOENT")) throw safeRegistryError();
    throw primaryError;
  }
}

function timestamp(date: Date): string {
  if (!Number.isFinite(date.getTime())) {
    throw new LibraryError("invalid_input", "The upload clock is invalid.");
  }
  return date.toISOString();
}

function withoutLifecycle(record: StoredUploadRecord): Omit<
  StoredUploadRecord,
  "staged" | "finalized" | "consumedAt" | "discardedAt" | "error"
> {
  const {
    staged: _staged,
    finalized: _finalized,
    consumedAt: _consumedAt,
    discardedAt: _discardedAt,
    error: _error,
    ...base
  } = record;
  return base;
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

async function writeChunk(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    if (result.bytesWritten < 1) {
      throw new LibraryError("file_write_failed", "The staged upload could not be written.");
    }
    offset += result.bytesWritten;
  }
}

async function hashFile(filePath: string): Promise<{ readonly byteLength: number; readonly sha256: string }> {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(filePath)) {
    const bytes = chunk as Buffer;
    byteLength += bytes.byteLength;
    hash.update(bytes);
  }
  return { byteLength, sha256: hash.digest("hex") };
}

export class UploadStore {
  readonly #platform: NodeJS.Platform;
  readonly #paths: UploadStoragePaths;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #lockOptions: AcquireFileLockOptions | undefined;
  readonly #imageMaxBytes: number;
  readonly #zipMaxBytes: number;
  readonly #expiryMs: number;

  constructor(options: UploadStoreOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#paths = createUploadStoragePaths({
      ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
      ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
      platform: this.#platform
    });
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => `upload-${randomUUID()}`);
    this.#lockOptions = options.lockOptions;
    this.#imageMaxBytes = options.imageMaxBytes ?? DEFAULT_IMAGE_UPLOAD_MAX_BYTES;
    this.#zipMaxBytes = options.zipMaxBytes ?? DEFAULT_ZIP_UPLOAD_MAX_BYTES;
    this.#expiryMs = options.expiryMs ?? DEFAULT_UPLOAD_EXPIRY_MS;
    for (const value of [this.#imageMaxBytes, this.#zipMaxBytes, this.#expiryMs]) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new LibraryError("invalid_input", "Upload policy limits are invalid.");
      }
    }
  }

  get paths(): UploadStoragePaths {
    return this.#paths;
  }

  #objectPath(record: StoredUploadRecord): string {
    return resolveApprovedPath({
      root: this.#paths.root,
      candidate: record.relativePath,
      operation: "read"
    });
  }

  #partPath(record: StoredUploadRecord): string {
    return `${this.#objectPath(record)}.part`;
  }

  #resourceLockPath(uploadResourceId: string): string {
    return resolveApprovedPath({
      root: this.#paths.locks,
      candidate: `${uploadResourceId}.lock`,
      operation: "create"
    });
  }

  async #withRegistryLock<T>(callback: () => Promise<T>): Promise<T> {
    await ensurePrivateDirectory(this.#paths.root, this.#platform);
    const lock = await acquireFileLock(
      this.#paths.registryLock,
      "routego-image-upload-registry",
      this.#lockOptions
    );
    try {
      return await callback();
    } finally {
      await lock.release();
    }
  }

  async #readRegistryUnderLock(): Promise<UploadRegistryDocument> {
    await mkdir(this.#paths.objects, { recursive: true, mode: 0o700 });
    await cleanupAtomicJsonTemporaryFiles(this.#paths.registry, { olderThanMs: 0 });
    const existing = await readRegistryRecovering(this.#paths.registry);
    if (existing) return existing;
    const created = createEmptyUploadRegistry();
    await writeJsonAtomic(this.#paths.registry, created);
    return created;
  }

  async #writeRegistryUnderLock(
    previous: UploadRegistryDocument,
    uploads: readonly StoredUploadRecord[]
  ): Promise<UploadRegistryDocument> {
    const next = parseUploadRegistryDocument({
      schemaVersion: 1,
      revision: previous.revision + 1,
      uploads
    });
    await writeJsonAtomic(this.#paths.registry, next);
    return next;
  }

  #descriptor(record: StoredUploadRecord): UploadResourceDescriptor {
    return uploadResourceDescriptorSchema.parse({
      uploadResourceId: record.uploadResourceId,
      purpose: record.purpose,
      status: record.status,
      reusePolicy: record.reusePolicy,
      binaryUpload: {
        method: "PUT",
        relativeUrl: `/api/v1/uploads/${record.uploadResourceId}/content`,
        requiresSession: true,
        requiresOrigin: true,
        allowedMimeTypes: allowedMimeTypes(record.purpose),
        maxBytes: record.maxBytes,
        expiresAt: record.expiresAt
      },
      declaredMimeType: record.declaredMimeType,
      declaredByteLength: record.declaredByteLength,
      ...(record.expectedSha256 === undefined ? {} : { expectedSha256: record.expectedSha256 }),
      ...(record.finalized === undefined ? {} : { finalized: record.finalized }),
      createdAt: record.createdAt,
      ...(record.consumedAt === undefined ? {} : { consumedAt: record.consumedAt }),
      ...(record.discardedAt === undefined ? {} : { discardedAt: record.discardedAt }),
      ...(record.error === undefined ? {} : { error: record.error })
    });
  }

  async #deleteRecordFiles(record: StoredUploadRecord): Promise<void> {
    try {
      await unlinkIfPresent(this.#partPath(record));
      await unlinkIfPresent(this.#objectPath(record));
    } catch {
      throw new LibraryError("file_write_failed", "Upload-owned staging bytes could not be removed.");
    }
  }

  async #replaceRecord(
    registry: UploadRegistryDocument,
    replacement: StoredUploadRecord
  ): Promise<UploadRegistryDocument> {
    return this.#writeRegistryUnderLock(
      registry,
      registry.uploads.map((item) =>
        item.uploadResourceId === replacement.uploadResourceId ? replacement : item
      )
    );
  }

  async #expireIfNeeded(
    registry: UploadRegistryDocument,
    record: StoredUploadRecord
  ): Promise<{ readonly registry: UploadRegistryDocument; readonly record: StoredUploadRecord }> {
    if (
      record.status === "expired" ||
      record.status === "discarded" ||
      record.status === "consumed" ||
      record.status === "failed"
    ) {
      await this.#deleteRecordFiles(record).catch(() => undefined);
      return { registry, record };
    }
    if (Date.parse(record.expiresAt) > this.#now().getTime()) {
      return { registry, record };
    }
    const expired: StoredUploadRecord = { ...withoutLifecycle(record), status: "expired" };
    const next = await this.#replaceRecord(registry, expired);
    await this.#deleteRecordFiles(record).catch(() => undefined);
    return { registry: next, record: expired };
  }

  async reserveUploadResource(
    input: ReserveUploadResourceInput
  ): Promise<ReserveUploadResourceResult> {
    const parsed = reserveUploadResourceInputSchema.parse(input);
    const maxBytes = parsed.purpose === "zip-import" ? this.#zipMaxBytes : this.#imageMaxBytes;
    if (parsed.declaredByteLength > maxBytes) {
      return reserveUploadResourceResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        error: uploadError("upload_oversize", "The declared upload exceeds the allowed size.")
      });
    }
    return this.#withRegistryLock(async () => {
      const registry = await this.#readRegistryUnderLock();
      if (registry.uploads.length >= 10_000) {
        throw new LibraryError("conflict", "The upload registry reached its resource limit.");
      }
      let uploadResourceId: string | undefined;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          const candidate = identifierSchema.parse(this.#idFactory());
          const candidatePath = resolveApprovedPath({
            root: this.#paths.root,
            candidate: `objects/${candidate}.bin`,
            operation: "read"
          });
          const occupied = await Promise.all(
            [candidatePath, `${candidatePath}.part`].map(async (filePath) => {
              try {
                await access(filePath);
                return true;
              } catch (error) {
                if (isNodeError(error, "ENOENT")) return false;
                throw new LibraryError(
                  "access_denied",
                  "The upload staging area cannot be inspected."
                );
              }
            })
          ).then((values) => values.some(Boolean));
          if (
            !occupied &&
            !registry.uploads.some((item) => item.uploadResourceId === candidate)
          ) {
            uploadResourceId = candidate;
            break;
          }
        } catch {
          throw new LibraryError("invalid_input", "The upload resource identity is invalid.");
        }
      }
      if (!uploadResourceId) {
        throw new LibraryError("conflict", "A unique upload resource could not be reserved.");
      }
      const createdAt = this.#now();
      const record: StoredUploadRecord = {
        uploadResourceId,
        purpose: parsed.purpose,
        status: "reserved",
        reusePolicy:
          parsed.purpose === "zip-import" ? "single-consume" : "reusable-until-expiry",
        relativePath: `objects/${uploadResourceId}.bin`,
        declaredMimeType: parsed.declaredMimeType,
        declaredByteLength: parsed.declaredByteLength,
        ...(parsed.expectedSha256 === undefined ? {} : { expectedSha256: parsed.expectedSha256 }),
        maxBytes,
        createdAt: timestamp(createdAt),
        expiresAt: timestamp(new Date(createdAt.getTime() + this.#expiryMs))
      };
      await this.#writeRegistryUnderLock(registry, [...registry.uploads, record]);
      return reserveUploadResourceResultSchema.parse({
        schemaVersion: 1,
        status: "succeeded",
        resource: this.#descriptor(record)
      });
    });
  }

  async stageUpload(
    uploadResourceId: string,
    source: AsyncIterable<Uint8Array>
  ): Promise<UploadResourceDescriptor> {
    const id = identifierSchema.parse(uploadResourceId);
    await ensurePrivateDirectory(this.#paths.root, this.#platform);
    const resourceLock = await acquireFileLock(
      this.#resourceLockPath(id),
      `routego-image-upload-${id}`,
      this.#lockOptions
    );
    let record: StoredUploadRecord;
    try {
      record = await this.#withRegistryLock(async () => {
        const registry = await this.#readRegistryUnderLock();
        const found = registry.uploads.find((item) => item.uploadResourceId === id);
        if (!found) throw new LibraryError("not_found", "The upload resource does not exist.");
        const current = await this.#expireIfNeeded(registry, found);
        if (current.record.status === "expired") {
          throw new LibraryError("upload_expired", "The upload resource has expired.");
        }
        if (current.record.status === "consumed") {
          throw new LibraryError("upload_consumed", "The ZIP upload has already been consumed.");
        }
        if (current.record.status === "discarded") {
          throw new LibraryError("upload_discarded", "The upload resource was discarded.");
        }
        if (current.record.status !== "reserved") {
          throw new LibraryError("conflict", "The upload resource already contains staged bytes.");
        }
        return current.record;
      });
      await this.#deleteRecordFiles(record);
      const partPath = this.#partPath(record);
      const finalPath = this.#objectPath(record);
      let handle: FileHandle;
      try {
        handle = await open(partPath, "wx", 0o600);
      } catch {
        throw new LibraryError("file_write_failed", "The upload staging file could not be created.");
      }
      const hash = createHash("sha256");
      let byteLength = 0;
      try {
        for await (const chunk of source) {
          if (!(chunk instanceof Uint8Array)) {
            throw new LibraryError("invalid_input", "Upload chunks must be binary data.");
          }
          if (byteLength + chunk.byteLength > record.maxBytes) {
            const error = uploadError("upload_oversize", "The upload exceeded the allowed size.");
            await handle.close().catch(() => undefined);
            await unlinkIfPresent(partPath);
            await this.#withRegistryLock(async () => {
              const registry = await this.#readRegistryUnderLock();
              const current = registry.uploads.find((item) => item.uploadResourceId === id);
              if (!current) return;
              await this.#replaceRecord(registry, {
                ...withoutLifecycle(current),
                status: "failed",
                error
              });
            });
            throw new LibraryError("upload_oversize", "The upload exceeded the allowed size.");
          }
          await writeChunk(handle, chunk);
          hash.update(chunk);
          byteLength += chunk.byteLength;
        }
        if (byteLength < 1) {
          throw new LibraryError("invalid_input", "The upload stream was empty.");
        }
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlinkIfPresent(partPath);
        throw error;
      }
      await handle.close();
      try {
        await link(partPath, finalPath);
        await unlink(partPath);
      } catch (error) {
        await unlinkIfPresent(partPath);
        void error;
        throw new LibraryError("file_write_failed", "The staged upload could not be published.");
      }
      const staged = {
        byteLength,
        sha256: hash.digest("hex"),
        uploadedAt: timestamp(this.#now())
      };
      const uploaded = await this.#withRegistryLock(async () => {
        const registry = await this.#readRegistryUnderLock();
        const current = registry.uploads.find((item) => item.uploadResourceId === id);
        if (!current || current.status !== "reserved") {
          throw new LibraryError("conflict", "The upload resource changed during staging.");
        }
        const active = await this.#expireIfNeeded(registry, current);
        if (active.record.status === "expired") {
          throw new LibraryError("upload_expired", "The upload resource expired during staging.");
        }
        const next: StoredUploadRecord = { ...active.record, status: "uploaded", staged };
        await this.#replaceRecord(active.registry, next);
        return next;
      });
      return this.#descriptor(uploaded);
    } finally {
      await resourceLock.release();
    }
  }

  async #operationRecord(uploadResourceId: string): Promise<{
    readonly registry: UploadRegistryDocument;
    readonly record: StoredUploadRecord;
  }> {
    const registry = await this.#readRegistryUnderLock();
    const record = registry.uploads.find((item) => item.uploadResourceId === uploadResourceId);
    if (!record) throw new LibraryError("not_found", "The upload resource does not exist.");
    return this.#expireIfNeeded(registry, record);
  }

  #failureForRecord(record: StoredUploadRecord): UploadServiceError | undefined {
    if (record.status === "expired") {
      return uploadError("upload_expired", "The upload resource has expired.");
    }
    if (record.status === "consumed") {
      return uploadError("upload_consumed", "The ZIP upload has already been consumed.");
    }
    if (record.status === "discarded") {
      return uploadError("upload_discarded", "The upload resource was discarded.");
    }
    if (record.status === "failed") return record.error;
    return undefined;
  }

  async finalizeUploadResource(
    input: FinalizeUploadResourceInput
  ): Promise<FinalizeUploadResourceResult> {
    const parsed = finalizeUploadResourceInputSchema.parse(input);
    const resourceLock = await acquireFileLock(
      this.#resourceLockPath(parsed.uploadResourceId),
      `routego-image-upload-${parsed.uploadResourceId}`,
      this.#lockOptions
    );
    try {
      const snapshot = await this.#withRegistryLock(async () => {
        let current: { registry: UploadRegistryDocument; record: StoredUploadRecord };
        try {
          current = await this.#operationRecord(parsed.uploadResourceId);
        } catch (error) {
          if (error instanceof LibraryError && error.code === "not_found") {
            return {
              result: finalizeUploadResourceResultSchema.parse({
                schemaVersion: 1,
                status: "failed",
                error: uploadError("not_found", "The upload resource was not found.")
              })
            } as const;
          }
          throw error;
        }
        const lifecycleError = this.#failureForRecord(current.record);
        if (lifecycleError) {
          return {
            result: finalizeUploadResourceResultSchema.parse({
              schemaVersion: 1,
              status: "failed",
              error: lifecycleError
            })
          } as const;
        }
        if (
          (current.record.status !== "uploaded" && current.record.status !== "finalized") ||
          current.record.staged === undefined
        ) {
          return {
            result: finalizeUploadResourceResultSchema.parse({
              schemaVersion: 1,
              status: "failed",
              error: uploadError(
                "upload_invalid_type",
                "The upload has no completed staged bytes."
              )
            })
          } as const;
        }
        return { record: current.record } as const;
      });
      if ("result" in snapshot) return snapshot.result;

      const finalPath = this.#objectPath(snapshot.record);
      let detected: Awaited<ReturnType<typeof inspectUploadContent>> | undefined;
      let actual: Awaited<ReturnType<typeof hashFile>> | undefined;
      let failure: UploadServiceError | undefined;
      try {
        actual = await hashFile(finalPath);
        if (actual.byteLength > snapshot.record.maxBytes) {
          failure = uploadError("upload_oversize", "The staged upload exceeds its size policy.");
        } else if (
          actual.byteLength !== snapshot.record.declaredByteLength ||
          actual.byteLength !== snapshot.record.staged!.byteLength ||
          actual.sha256 !== snapshot.record.staged!.sha256 ||
          (snapshot.record.expectedSha256 !== undefined &&
            actual.sha256 !== snapshot.record.expectedSha256)
        ) {
          failure = uploadError(
            "upload_checksum_failed",
            "The staged upload failed integrity validation."
          );
        } else {
          detected = await inspectUploadContent(finalPath, actual.byteLength);
          if (
            detected.mimeType !== snapshot.record.declaredMimeType ||
            !allowedMimeTypes(snapshot.record.purpose).includes(detected.mimeType)
          ) {
            failure = uploadError("upload_invalid_type", "The staged upload type is not allowed.");
          }
        }
      } catch (error) {
        failure =
          error instanceof LibraryError && error.code === "upload_invalid_type"
            ? uploadError("upload_invalid_type", "The staged upload header is invalid.")
            : uploadError("upload_invalid_type", "The staged upload could not be validated.");
      }

      return await this.#withRegistryLock(async () => {
        const current = await this.#operationRecord(parsed.uploadResourceId);
        const lifecycleError = this.#failureForRecord(current.record);
        if (lifecycleError) {
          return finalizeUploadResourceResultSchema.parse({
            schemaVersion: 1,
            status: "failed",
            error: lifecycleError
          });
        }
        if (
          (current.record.status !== "uploaded" && current.record.status !== "finalized") ||
          current.record.staged === undefined ||
          current.record.staged.sha256 !== snapshot.record.staged!.sha256
        ) {
          return finalizeUploadResourceResultSchema.parse({
            schemaVersion: 1,
            status: "failed",
            error: uploadError("upload_checksum_failed", "The staged upload changed during validation.")
          });
        }
        if (failure || !detected || !actual) {
          const failed: StoredUploadRecord = {
            ...withoutLifecycle(current.record),
            status: "failed",
            error: failure ?? uploadError("upload_invalid_type", "The staged upload is invalid.")
          };
          await this.#replaceRecord(current.registry, failed);
          await this.#deleteRecordFiles(current.record).catch(() => undefined);
          return finalizeUploadResourceResultSchema.parse({
            schemaVersion: 1,
            status: "failed",
            error: failed.error
          });
        }
        if (current.record.status === "finalized") {
          return finalizeUploadResourceResultSchema.parse({
            schemaVersion: 1,
            status: "succeeded",
            resource: this.#descriptor(current.record)
          });
        }
        const finalizedAtDate = this.#now();
        if (finalizedAtDate.getTime() >= Date.parse(current.record.expiresAt)) {
          const expired: StoredUploadRecord = {
            ...withoutLifecycle(current.record),
            status: "expired"
          };
          await this.#replaceRecord(current.registry, expired);
          await this.#deleteRecordFiles(current.record).catch(() => undefined);
          return finalizeUploadResourceResultSchema.parse({
            schemaVersion: 1,
            status: "failed",
            error: uploadError("upload_expired", "The upload resource expired during validation.")
          });
        }
        const finalized: StoredUploadRecord = {
          ...current.record,
          status: "finalized",
          finalized: {
            detectedMimeType: detected.mimeType,
            byteLength: actual.byteLength,
            sha256: actual.sha256,
            ...(detected.width === undefined ? {} : { width: detected.width }),
            ...(detected.height === undefined ? {} : { height: detected.height }),
            finalizedAt: timestamp(finalizedAtDate)
          }
        };
        await this.#replaceRecord(current.registry, finalized);
        return finalizeUploadResourceResultSchema.parse({
          schemaVersion: 1,
          status: "succeeded",
          resource: this.#descriptor(finalized)
        });
      });
    } finally {
      await resourceLock.release();
    }
  }

  async getUploadResourceStatus(
    input: GetUploadResourceStatusInput
  ): Promise<GetUploadResourceStatusResult> {
    const parsed = getUploadResourceStatusInputSchema.parse(input);
    const resourceLock = await acquireFileLock(
      this.#resourceLockPath(parsed.uploadResourceId),
      `routego-image-upload-${parsed.uploadResourceId}`,
      this.#lockOptions
    );
    try {
      return await this.#withRegistryLock(async () => {
        let current;
        try {
          current = await this.#operationRecord(parsed.uploadResourceId);
        } catch (error) {
          if (error instanceof LibraryError && error.code === "not_found") {
            return getUploadResourceStatusResultSchema.parse({
              schemaVersion: 1,
              status: "failed",
              error: uploadError("not_found", "The upload resource was not found.")
            });
          }
          throw error;
        }
        if (current.record.status === "reserved") {
          await this.#deleteRecordFiles(current.record);
        }
        const lifecycleError = this.#failureForRecord(current.record);
        if (lifecycleError) {
          return getUploadResourceStatusResultSchema.parse({
            schemaVersion: 1,
            status: "failed",
            error: lifecycleError
          });
        }
        if (current.record.status === "uploaded" || current.record.status === "finalized") {
          try {
            await access(this.#objectPath(current.record));
          } catch {
            const error = uploadError(
              "upload_checksum_failed",
              "The staged upload bytes are unavailable."
            );
            await this.#replaceRecord(current.registry, {
              ...withoutLifecycle(current.record),
              status: "failed",
              error
            });
            return getUploadResourceStatusResultSchema.parse({
              schemaVersion: 1,
              status: "failed",
              error
            });
          }
        }
        return getUploadResourceStatusResultSchema.parse({
          schemaVersion: 1,
          status: "succeeded",
          resource: this.#descriptor(current.record)
        });
      });
    } finally {
      await resourceLock.release();
    }
  }

  async discardUploadResource(
    input: DiscardUploadResourceInput
  ): Promise<DiscardUploadResourceResult> {
    const parsed = discardUploadResourceInputSchema.parse(input);
    const resourceLock = await acquireFileLock(
      this.#resourceLockPath(parsed.uploadResourceId),
      `routego-image-upload-${parsed.uploadResourceId}`,
      this.#lockOptions
    );
    try {
      return await this.#withRegistryLock(async () => {
        let current;
        try {
          current = await this.#operationRecord(parsed.uploadResourceId);
        } catch (error) {
          if (error instanceof LibraryError && error.code === "not_found") {
            return discardUploadResourceResultSchema.parse({
              schemaVersion: 1,
              status: "failed",
              error: uploadError("not_found", "The upload resource was not found.")
            });
          }
          throw error;
        }
        const lifecycleError = this.#failureForRecord(current.record);
        if (lifecycleError) {
          return discardUploadResourceResultSchema.parse({
            schemaVersion: 1,
            status: "failed",
            error: lifecycleError
          });
        }
        const discarded: StoredUploadRecord = {
          ...withoutLifecycle(current.record),
          status: "discarded",
          discardedAt: timestamp(this.#now())
        };
        await this.#replaceRecord(current.registry, discarded);
        await this.#deleteRecordFiles(current.record).catch(() => undefined);
        return discardUploadResourceResultSchema.parse({
          schemaVersion: 1,
          status: "succeeded",
          resource: this.#descriptor(discarded)
        });
      });
    } finally {
      await resourceLock.release();
    }
  }

  async resolveUploadResource(
    uploadResourceId: string,
    expectedPurposes?: readonly UploadResourcePurpose[]
  ): Promise<ResolvedUploadResource> {
    const id = identifierSchema.parse(uploadResourceId);
    const resourceLock = await acquireFileLock(
      this.#resourceLockPath(id),
      `routego-image-upload-${id}`,
      this.#lockOptions
    );
    try {
      const snapshot = await this.#withRegistryLock(async () => {
        const current = await this.#operationRecord(id);
        const lifecycleError = this.#failureForRecord(current.record);
        if (lifecycleError) {
          throw new LibraryError(lifecycleError.code, lifecycleError.safeMessage);
        }
        if (
          current.record.status !== "finalized" ||
          current.record.finalized === undefined ||
          current.record.staged === undefined
        ) {
          throw new LibraryError("conflict", "The upload resource is not finalized.");
        }
        if (expectedPurposes && !expectedPurposes.includes(current.record.purpose)) {
          throw new LibraryError("upload_invalid_type", "The upload purpose is not allowed here.");
        }
        return current.record;
      });
      const filePath = this.#objectPath(snapshot);
      const actual = await hashFile(filePath).catch(() => undefined);
      return await this.#withRegistryLock(async () => {
        const current = await this.#operationRecord(id);
        const lifecycleError = this.#failureForRecord(current.record);
        if (lifecycleError) {
          throw new LibraryError(lifecycleError.code, lifecycleError.safeMessage);
        }
        if (
          current.record.status !== "finalized" ||
          current.record.finalized === undefined ||
          current.record.staged === undefined
        ) {
          throw new LibraryError("conflict", "The upload resource is not finalized.");
        }
        if (
          !actual ||
          actual.byteLength !== current.record.finalized.byteLength ||
          actual.sha256 !== current.record.finalized.sha256
        ) {
          const error = uploadError(
            "upload_checksum_failed",
            "The finalized upload bytes failed integrity validation."
          );
          await this.#replaceRecord(current.registry, {
            ...withoutLifecycle(current.record),
            status: "failed",
            error
          });
          await this.#deleteRecordFiles(current.record).catch(() => undefined);
          throw new LibraryError("upload_checksum_failed", error.safeMessage);
        }
        return {
          uploadResourceId: id,
          purpose: current.record.purpose,
          path: filePath,
          mimeType: current.record.finalized.detectedMimeType,
          byteLength: current.record.finalized.byteLength,
          sha256: current.record.finalized.sha256,
          ...(current.record.finalized.width === undefined
            ? {}
            : { width: current.record.finalized.width }),
          ...(current.record.finalized.height === undefined
            ? {}
            : { height: current.record.finalized.height }),
          expiresAt: current.record.expiresAt,
          reusePolicy: current.record.reusePolicy
        };
      });
    } finally {
      await resourceLock.release();
    }
  }

  async consumeZipUpload(uploadResourceId: string): Promise<void> {
    const id = identifierSchema.parse(uploadResourceId);
    const resourceLock = await acquireFileLock(
      this.#resourceLockPath(id),
      `routego-image-upload-${id}`,
      this.#lockOptions
    );
    try {
      await this.#withRegistryLock(async () => {
        const current = await this.#operationRecord(id);
        const lifecycleError = this.#failureForRecord(current.record);
        if (lifecycleError) throw new LibraryError(lifecycleError.code, lifecycleError.safeMessage);
        if (
          current.record.purpose !== "zip-import" ||
          current.record.status !== "finalized" ||
          current.record.finalized?.detectedMimeType !== "application/zip"
        ) {
          throw new LibraryError("upload_invalid_type", "The upload is not a finalized ZIP import.");
        }
        const consumed: StoredUploadRecord = {
          ...current.record,
          status: "consumed",
          consumedAt: timestamp(this.#now())
        };
        await this.#replaceRecord(current.registry, consumed);
        await this.#deleteRecordFiles(current.record).catch(() => undefined);
      });
    } finally {
      await resourceLock.release();
    }
  }

  async cleanupExpired(): Promise<number> {
    const ids = await this.#withRegistryLock(async () => {
      const registry = await this.#readRegistryUnderLock();
      const now = this.#now().getTime();
      return registry.uploads
        .filter(
          (record) =>
            !["expired", "discarded", "consumed", "failed"].includes(record.status) &&
            Date.parse(record.expiresAt) <= now
        )
        .map((record) => record.uploadResourceId);
    });
    let cleaned = 0;
    for (const id of ids) {
      const resourceLock = await acquireFileLock(
        this.#resourceLockPath(id),
        `routego-image-upload-${id}`,
        this.#lockOptions
      );
      try {
        await this.#withRegistryLock(async () => {
          const registry = await this.#readRegistryUnderLock();
          const record = registry.uploads.find((item) => item.uploadResourceId === id);
          if (!record || Date.parse(record.expiresAt) > this.#now().getTime()) return;
          const current = await this.#expireIfNeeded(registry, record);
          if (current.record.status === "expired") cleaned += 1;
        });
      } finally {
        await resourceLock.release();
      }
    }
    return cleaned;
  }
}
