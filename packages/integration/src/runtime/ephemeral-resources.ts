import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { lstat, mkdir, mkdtemp, open, realpath, rm, stat, unlink } from "node:fs/promises";

import {
  browserResourceDescriptorSchema,
  identifierSchema,
  type BrowserResourceDescriptor
} from "@routego-image/contracts";
import {
  MAX_PROVIDER_INPUT_BYTES,
  detectImageMetadata,
  type SupportedImageMimeType
} from "@routego-image/creation";

import type { MaterializedImageOutput } from "../image/materialize";

export const EPHEMERAL_IMAGE_RESOURCE_TTL_MS = 5 * 60_000;
export const MAX_EPHEMERAL_IMAGE_RESOURCES = 64;
export const MAX_EPHEMERAL_IMAGE_TOTAL_BYTES = 256 * 1024 * 1024;

export type EphemeralImageResourceErrorCode =
  | "invalid-input"
  | "not-found"
  | "expired"
  | "integrity-failed"
  | "resource-conflict"
  | "registry-shutdown"
  | "storage-failed";

export class EphemeralImageResourceError extends Error {
  readonly code: EphemeralImageResourceErrorCode;

  constructor(code: EphemeralImageResourceErrorCode, safeMessage: string) {
    super(safeMessage);
    this.name = "EphemeralImageResourceError";
    this.code = code;
  }
}

export interface EphemeralImageResourceRegistryOptions {
  readonly root: string;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly removeFile?: (filePath: string) => Promise<void>;
}

export interface RegisterEphemeralImageInput {
  readonly output: MaterializedImageOutput;
  readonly owningSessionId: string;
  readonly owningSessionExpiresAt: string | Date;
}

export interface OpenEphemeralImageResource {
  readonly descriptor: BrowserResourceDescriptor;
  readonly path: string;
  readonly mimeType: SupportedImageMimeType;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly signal: AbortSignal;
  close(): Promise<void>;
}

interface EphemeralResourceRecord {
  readonly descriptor: BrowserResourceDescriptor;
  readonly owningSessionId: string;
  readonly owningSessionExpiresAtMs: number;
  readonly registeredAtMs: number;
  readonly expiresAtMs: number;
  readonly path: string;
  readonly mimeType: SupportedImageMimeType;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly leases: Set<AbortController>;
  timer?: NodeJS.Timeout;
}

interface ValidatedBackingImage {
  readonly bytes: Uint8Array;
  readonly mimeType: SupportedImageMimeType;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
}

interface OrphanedPathRecord {
  readonly byteLength: number;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function extensionFor(mimeType: SupportedImageMimeType): "png" | "jpg" | "webp" {
  return mimeType === "image/png" ? "png" : mimeType === "image/jpeg" ? "jpg" : "webp";
}

function parseTimestamp(value: string | Date): number {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new EphemeralImageResourceError(
      "invalid-input",
      "The owning session expiry is invalid."
    );
  }
  return milliseconds;
}

async function validateBackingImage(
  filePath: string,
  expected: Pick<
    MaterializedImageOutput,
    "mimeType" | "byteLength" | "width" | "height" | "sha256"
  >
): Promise<ValidatedBackingImage> {
  if (
    !Number.isSafeInteger(expected.byteLength) ||
    expected.byteLength < 1 ||
    expected.byteLength > MAX_PROVIDER_INPUT_BYTES ||
    !Number.isSafeInteger(expected.width) ||
    !Number.isSafeInteger(expected.height) ||
    expected.width < 1 ||
    expected.height < 1 ||
    expected.width > 65_535 ||
    expected.height > 65_535 ||
    !/^[a-f0-9]{64}$/u.test(expected.sha256)
  ) {
    throw new EphemeralImageResourceError(
      "integrity-failed",
      "The ephemeral image backing claims are invalid."
    );
  }
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch {
    throw new EphemeralImageResourceError(
      "integrity-failed",
      "The ephemeral image backing file is unavailable."
    );
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size !== expected.byteLength
  ) {
    throw new EphemeralImageResourceError(
      "integrity-failed",
      "The ephemeral image backing file failed metadata validation."
    );
  }
  let handle;
  let bytes: Uint8Array;
  try {
    handle = await open(filePath, "r");
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile() || openedMetadata.size !== expected.byteLength) {
      throw new Error("backing-size-changed");
    }
    const buffer = Buffer.alloc(expected.byteLength + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        offset
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== expected.byteLength) {
      throw new Error("backing-size-changed");
    }
    bytes = new Uint8Array(buffer.subarray(0, offset));
  } catch {
    throw new EphemeralImageResourceError(
      "integrity-failed",
      "The ephemeral image backing file is unavailable."
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
  if (bytes.byteLength !== expected.byteLength) {
    throw new EphemeralImageResourceError(
      "integrity-failed",
      "The ephemeral image backing file failed metadata validation."
    );
  }
  let detected;
  try {
    detected = detectImageMetadata(bytes);
  } catch {
    throw new EphemeralImageResourceError(
      "integrity-failed",
      "The ephemeral image backing file is not a supported image."
    );
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (
    detected.mimeType !== expected.mimeType ||
    detected.width !== expected.width ||
    detected.height !== expected.height ||
    sha256 !== expected.sha256
  ) {
    throw new EphemeralImageResourceError(
      "integrity-failed",
      "The ephemeral image backing file failed integrity validation."
    );
  }
  return {
    bytes,
    mimeType: detected.mimeType,
    byteLength: bytes.byteLength,
    width: detected.width,
    height: detected.height,
    sha256
  };
}

async function writeExclusive(filePath: string, bytes: Uint8Array): Promise<void> {
  let handle;
  try {
    handle = await open(filePath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
      handle = undefined;
      await unlink(filePath).catch(() => undefined);
    }
    if (isNodeError(error, "EEXIST")) {
      throw new EphemeralImageResourceError(
        "resource-conflict",
        "An exclusive ephemeral resource path already exists."
      );
    }
    throw new EphemeralImageResourceError(
      "storage-failed",
      "The ephemeral image resource could not be stored."
    );
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
  }
}

export class EphemeralImageResourceRegistry {
  readonly #root: string;
  readonly #directory: string;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #removeFile: (filePath: string) => Promise<void>;
  readonly #resources = new Map<string, EphemeralResourceRecord>();
  readonly #orphanedPaths = new Map<string, OrphanedPathRecord>();
  #totalBytes = 0;
  #shutdownRequested = false;
  #shutdownComplete = false;
  #orphanCleanupPromise: Promise<void> | undefined;

  constructor(input: {
    readonly root: string;
    readonly directory: string;
    readonly now: () => Date;
    readonly idFactory: () => string;
    readonly removeFile: (filePath: string) => Promise<void>;
  }) {
    this.#root = input.root;
    this.#directory = input.directory;
    this.#now = input.now;
    this.#idFactory = input.idFactory;
    this.#removeFile = input.removeFile;
  }

  get directory(): string {
    return this.#directory;
  }

  get size(): number {
    return this.#resources.size;
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }

  #assertActive(): void {
    if (this.#shutdownRequested) {
      throw new EphemeralImageResourceError(
        "registry-shutdown",
        "The ephemeral image resource registry is shut down."
      );
    }
  }

  #nowMs(): number {
    const milliseconds = this.#now().getTime();
    if (!Number.isFinite(milliseconds)) {
      throw new EphemeralImageResourceError(
        "invalid-input",
        "The ephemeral resource clock is invalid."
      );
    }
    return milliseconds;
  }

  #parseIdentifier(value: string): string {
    try {
      return identifierSchema.parse(value);
    } catch {
      throw new EphemeralImageResourceError(
        "invalid-input",
        "The ephemeral resource identity is invalid."
      );
    }
  }

  #allocateResourceId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.#parseIdentifier(this.#idFactory());
      if (!this.#resources.has(candidate)) return candidate;
    }
    throw new EphemeralImageResourceError(
      "resource-conflict",
      "A unique ephemeral resource identity could not be allocated."
    );
  }

  async registerImage(input: RegisterEphemeralImageInput): Promise<BrowserResourceDescriptor> {
    this.#assertActive();
    const owningSessionId = this.#parseIdentifier(input.owningSessionId);
    const registeredAtMs = this.#nowMs();
    const owningSessionExpiresAtMs = parseTimestamp(input.owningSessionExpiresAt);
    if (owningSessionExpiresAtMs <= registeredAtMs) {
      throw new EphemeralImageResourceError(
        "expired",
        "The owning session is already expired."
      );
    }
    const expiresAtMs = Math.min(
      registeredAtMs + EPHEMERAL_IMAGE_RESOURCE_TTL_MS,
      owningSessionExpiresAtMs
    );
    const validated = await validateBackingImage(input.output.path, input.output);
    this.#assertActive();
    if (
      this.#resources.size >= MAX_EPHEMERAL_IMAGE_RESOURCES ||
      this.#totalBytes + validated.byteLength > MAX_EPHEMERAL_IMAGE_TOTAL_BYTES
    ) {
      throw new EphemeralImageResourceError(
        "resource-conflict",
        "The bounded ephemeral image resource capacity is exhausted."
      );
    }
    const resourceId = this.#allocateResourceId();
    const fileIdentity = createHash("sha256")
      .update(resourceId, "utf8")
      .digest("hex")
      .slice(0, 24);
    const resourcePath = path.join(
      this.#directory,
      `resource-${fileIdentity}.${extensionFor(validated.mimeType)}`
    );
    await writeExclusive(resourcePath, validated.bytes);

    try {
      this.#assertActive();
      const descriptor = Object.freeze(browserResourceDescriptorSchema.parse({
        resourceId,
        relativeUrl: `/api/v1/resources/${resourceId}`,
        requiresSession: true,
        mimeType: validated.mimeType,
        byteLength: validated.byteLength,
        width: validated.width,
        height: validated.height,
        etag: `sha256-${validated.sha256}`,
        expiresAt: new Date(expiresAtMs).toISOString()
      }));
      const publicationNowMs = this.#nowMs();
      if (publicationNowMs >= expiresAtMs || publicationNowMs >= owningSessionExpiresAtMs) {
        throw new EphemeralImageResourceError(
          "expired",
          "The owning session expired before the ephemeral image could be registered."
        );
      }
      this.#assertActive();
      if (
        this.#resources.size >= MAX_EPHEMERAL_IMAGE_RESOURCES ||
        this.#totalBytes + validated.byteLength > MAX_EPHEMERAL_IMAGE_TOTAL_BYTES
      ) {
        throw new EphemeralImageResourceError(
          "resource-conflict",
          "The bounded ephemeral image resource capacity is exhausted."
        );
      }
      const record: EphemeralResourceRecord = {
        descriptor,
        owningSessionId,
        owningSessionExpiresAtMs,
        registeredAtMs,
        expiresAtMs,
        path: resourcePath,
        mimeType: validated.mimeType,
        byteLength: validated.byteLength,
        width: validated.width,
        height: validated.height,
        sha256: validated.sha256,
        leases: new Set()
      };
      this.#resources.set(resourceId, record);
      this.#totalBytes += record.byteLength;
      const delay = expiresAtMs - publicationNowMs;
      record.timer = setTimeout(() => {
        void this.#revokeRecord(resourceId);
      }, delay);
      record.timer.unref();
      return descriptor;
    } catch (error) {
      await this.#deleteUnpublished(resourcePath, validated.byteLength);
      if (error instanceof EphemeralImageResourceError) throw error;
      throw new EphemeralImageResourceError(
        "invalid-input",
        "The ephemeral resource descriptor failed contract validation."
      );
    }
  }

  async #deleteUnpublished(resourcePath: string, byteLength: number): Promise<void> {
    try {
      await this.#removeFile(resourcePath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        this.#trackOrphan(resourcePath, byteLength, false);
      }
    }
  }

  #trackOrphan(resourcePath: string, byteLength: number, alreadyCounted: boolean): void {
    const previous = this.#orphanedPaths.get(resourcePath);
    if (previous !== undefined) {
      this.#totalBytes -= previous.byteLength;
    }
    if (!alreadyCounted) {
      this.#totalBytes += byteLength;
    }
    this.#orphanedPaths.set(resourcePath, { byteLength });
  }

  async #revokeRecord(resourceId: string): Promise<boolean> {
    const record = this.#resources.get(resourceId);
    if (record === undefined) return false;
    this.#resources.delete(resourceId);
    if (record.timer !== undefined) clearTimeout(record.timer);
    for (const lease of record.leases) lease.abort();
    record.leases.clear();
    const previousOrphan = this.#orphanedPaths.get(record.path);
    try {
      await this.#removeFile(record.path);
      this.#totalBytes -= record.byteLength;
      if (
        previousOrphan !== undefined &&
        this.#orphanedPaths.get(record.path) === previousOrphan &&
        this.#orphanedPaths.delete(record.path)
      ) {
        this.#totalBytes -= previousOrphan.byteLength;
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        this.#totalBytes -= record.byteLength;
        if (
          previousOrphan !== undefined &&
          this.#orphanedPaths.get(record.path) === previousOrphan &&
          this.#orphanedPaths.delete(record.path)
        ) {
          this.#totalBytes -= previousOrphan.byteLength;
        }
      } else {
        const currentOrphan = this.#orphanedPaths.get(record.path);
        if (currentOrphan === undefined || currentOrphan === previousOrphan) {
          this.#trackOrphan(record.path, record.byteLength, true);
        } else {
          this.#totalBytes -= record.byteLength;
        }
      }
    }
    return true;
  }

  async #retryOrphanCleanup(): Promise<void> {
    if (this.#orphanCleanupPromise !== undefined) return await this.#orphanCleanupPromise;
    const cleanupPromise = (async () => {
      for (const [orphanedPath, orphan] of [...this.#orphanedPaths]) {
        let removed = false;
        try {
          await this.#removeFile(orphanedPath);
          removed = true;
        } catch (error) {
          removed = isNodeError(error, "ENOENT");
        }
        if (
          removed &&
          this.#orphanedPaths.get(orphanedPath) === orphan &&
          this.#orphanedPaths.delete(orphanedPath)
        ) {
          this.#totalBytes -= orphan.byteLength;
        }
      }
    })();
    this.#orphanCleanupPromise = cleanupPromise;
    try {
      await cleanupPromise;
    } finally {
      if (this.#orphanCleanupPromise === cleanupPromise) {
        this.#orphanCleanupPromise = undefined;
      }
    }
  }

  async open(resourceIdInput: string, owningSessionIdInput: string): Promise<OpenEphemeralImageResource> {
    this.#assertActive();
    const resourceId = this.#parseIdentifier(resourceIdInput);
    const owningSessionId = this.#parseIdentifier(owningSessionIdInput);
    const record = this.#resources.get(resourceId);
    if (record === undefined || record.owningSessionId !== owningSessionId) {
      throw new EphemeralImageResourceError(
        "not-found",
        "The ephemeral image resource is unavailable."
      );
    }
    const nowMs = this.#nowMs();
    if (nowMs >= record.expiresAtMs || nowMs >= record.owningSessionExpiresAtMs) {
      await this.#revokeRecord(resourceId);
      throw new EphemeralImageResourceError(
        "expired",
        "The ephemeral image resource is expired."
      );
    }
    try {
      await validateBackingImage(record.path, record);
    } catch {
      this.#assertActive();
      if (this.#resources.get(resourceId) !== record) {
        throw new EphemeralImageResourceError(
          "not-found",
          "The ephemeral image resource is unavailable."
        );
      }
      await this.#revokeRecord(resourceId);
      throw new EphemeralImageResourceError(
        "integrity-failed",
        "The ephemeral image resource failed integrity validation."
      );
    }
    this.#assertActive();
    if (this.#resources.get(resourceId) !== record) {
      throw new EphemeralImageResourceError(
        "not-found",
        "The ephemeral image resource is unavailable."
      );
    }
    const publicationNowMs = this.#nowMs();
    if (
      publicationNowMs >= record.expiresAtMs ||
      publicationNowMs >= record.owningSessionExpiresAtMs
    ) {
      await this.#revokeRecord(resourceId);
      throw new EphemeralImageResourceError(
        "expired",
        "The ephemeral image resource is expired."
      );
    }
    const controller = new AbortController();
    record.leases.add(controller);
    let closed = false;
    return {
      descriptor: record.descriptor,
      path: record.path,
      mimeType: record.mimeType,
      byteLength: record.byteLength,
      width: record.width,
      height: record.height,
      sha256: record.sha256,
      signal: controller.signal,
      close: async () => {
        if (closed) return;
        closed = true;
        record.leases.delete(controller);
        controller.abort();
      }
    };
  }

  async cleanupExpired(): Promise<number> {
    if (this.#shutdownRequested) return 0;
    const nowMs = this.#nowMs();
    let removed = 0;
    for (const [resourceId, record] of [...this.#resources]) {
      if (nowMs >= record.expiresAtMs || nowMs >= record.owningSessionExpiresAtMs) {
        if (await this.#revokeRecord(resourceId)) removed += 1;
      }
    }
    await this.#retryOrphanCleanup();
    return removed;
  }

  async revokeOwningSession(owningSessionIdInput: string): Promise<number> {
    const owningSessionId = this.#parseIdentifier(owningSessionIdInput);
    let removed = 0;
    for (const [resourceId, record] of [...this.#resources]) {
      if (record.owningSessionId === owningSessionId) {
        if (await this.#revokeRecord(resourceId)) removed += 1;
      }
    }
    await this.#retryOrphanCleanup();
    return removed;
  }

  async shutdown(): Promise<number> {
    if (this.#shutdownComplete) return 0;
    this.#shutdownRequested = true;
    let removed = 0;
    for (const resourceId of [...this.#resources.keys()]) {
      if (await this.#revokeRecord(resourceId)) removed += 1;
    }
    const relative = path.relative(this.#root, this.#directory);
    if (
      relative.length === 0 ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    ) {
      throw new EphemeralImageResourceError(
        "storage-failed",
        "The ephemeral resource directory is outside the approved root."
      );
    }
    await rm(this.#directory, { recursive: true, force: true });
    this.#orphanedPaths.clear();
    this.#totalBytes = 0;
    this.#shutdownComplete = true;
    return removed;
  }
}

export async function createEphemeralImageResourceRegistry(
  options: EphemeralImageResourceRegistryOptions
): Promise<EphemeralImageResourceRegistry> {
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const root = await realpath(options.root);
  if (!(await stat(root)).isDirectory()) {
    throw new EphemeralImageResourceError(
      "invalid-input",
      "The ephemeral resource root is not a directory."
    );
  }
  const directory = await mkdtemp(path.join(root, "ephemeral-images-"));
  return new EphemeralImageResourceRegistry({
    root,
    directory,
    now: options.now ?? (() => new Date()),
    idFactory: options.idFactory ?? (() => `resource-${randomUUID()}`),
    removeFile: options.removeFile ?? unlink
  });
}
