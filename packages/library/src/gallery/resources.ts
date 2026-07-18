import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";

import {
  browserResourceDescriptorSchema,
  identifierSchema,
  type BrowserResourceDescriptor
} from "@routego-image/contracts";

import { LibraryError, isNodeError } from "../errors";
import { resolveApprovedPath } from "../fs/paths";
import type { StoredImageBlob } from "./model";

export const DEFAULT_BROWSER_RESOURCE_TTL_MS = 5 * 60_000;

export type LibraryBrowserResourceRendition = "original" | "preview" | "thumbnail" | "zip";

export interface BrowserResourceRegistryOptions {
  readonly root: string;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => Date;
  readonly ttlMs?: number;
  readonly idFactory?: (rendition: LibraryBrowserResourceRendition) => string;
}

export interface RegisterZipBrowserResourceInput {
  readonly relativePath: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface InspectedBrowserBackingFile {
  readonly path: string;
  readonly mimeType: BrowserResourceDescriptor["mimeType"];
  readonly byteLength: number;
  readonly sha256: string;
  readonly width?: number;
  readonly height?: number;
}

export interface ResolvedBrowserResource extends InspectedBrowserBackingFile {
  readonly resourceId: string;
  readonly rendition: LibraryBrowserResourceRendition;
  readonly etag: string;
  readonly expiresAt: string;
}

interface BrowserResourceRecord extends ResolvedBrowserResource {
  readonly descriptor: BrowserResourceDescriptor;
}

interface BackingIntegrityCacheEntry {
  readonly byteLength: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly sha256: string;
}

function platformKind(platform: NodeJS.Platform): "win32" | "posix" {
  return platform === "win32" ? "win32" : "posix";
}

function pathApi(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function isContained(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  const selectedPath = pathApi(platform);
  const relative = selectedPath.relative(root, candidate);
  return (
    relative === "" ||
    (!selectedPath.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${selectedPath.sep}`))
  );
}

function validateSha256(value: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new LibraryError("invalid_input", "The browser resource checksum is invalid.");
  }
  return value;
}

export class BrowserResourceRegistry {
  readonly #root: string;
  readonly #platform: NodeJS.Platform;
  readonly #now: () => Date;
  readonly #ttlMs: number;
  readonly #idFactory: (rendition: LibraryBrowserResourceRendition) => string;
  readonly #resources = new Map<string, BrowserResourceRecord>();
  readonly #integrityCache = new Map<string, BackingIntegrityCacheEntry>();

  constructor(options: BrowserResourceRegistryOptions) {
    this.#platform = options.platform ?? process.platform;
    this.#root = pathApi(this.#platform).resolve(options.root);
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = options.ttlMs ?? DEFAULT_BROWSER_RESOURCE_TTL_MS;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1 || this.#ttlMs > 3_600_000) {
      throw new LibraryError("invalid_input", "The browser resource lifetime is invalid.");
    }
    this.#idFactory =
      options.idFactory ?? ((rendition) => `resource-${rendition}-${randomUUID()}`);
  }

  async #inspect(input: {
    readonly relativePath: string;
    readonly mimeType: BrowserResourceDescriptor["mimeType"];
    readonly byteLength: number;
    readonly sha256: string;
    readonly width?: number;
    readonly height?: number;
  }): Promise<InspectedBrowserBackingFile> {
    if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 1) {
      throw new LibraryError("invalid_input", "The browser resource length is invalid.");
    }
    const sha256 = validateSha256(input.sha256);
    const lexicalPath = resolveApprovedPath({
      root: this.#root,
      candidate: input.relativePath,
      operation: "read",
      platform: platformKind(this.#platform)
    });
    let metadata;
    let canonicalRoot: string;
    let canonicalPath: string;
    try {
      [metadata, canonicalRoot, canonicalPath] = await Promise.all([
        lstat(lexicalPath),
        realpath(this.#root),
        realpath(lexicalPath)
      ]);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new LibraryError("not_found", "The browser resource backing file is unavailable.");
      }
      throw new LibraryError("access_denied", "The browser resource backing file is unavailable.", {
        cause: error
      });
    }
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size !== input.byteLength ||
      !isContained(canonicalRoot, canonicalPath, this.#platform)
    ) {
      throw new LibraryError("path_unsafe", "The browser resource backing file is unsafe.");
    }
    const cached = this.#integrityCache.get(canonicalPath);
    let actualSha256: string;
    if (
      cached &&
      cached.byteLength === metadata.size &&
      cached.mtimeMs === metadata.mtimeMs &&
      cached.ctimeMs === metadata.ctimeMs
    ) {
      actualSha256 = cached.sha256;
    } else {
      const hash = createHash("sha256");
      try {
        for await (const chunk of createReadStream(canonicalPath)) hash.update(chunk);
      } catch (error) {
        throw new LibraryError("access_denied", "The browser resource backing file is unavailable.", {
          cause: error
        });
      }
      actualSha256 = hash.digest("hex");
      this.#integrityCache.set(canonicalPath, {
        byteLength: metadata.size,
        mtimeMs: metadata.mtimeMs,
        ctimeMs: metadata.ctimeMs,
        sha256: actualSha256
      });
    }
    if (actualSha256 !== sha256) {
      throw new LibraryError("config_corrupt", "The browser resource backing file failed integrity validation.");
    }
    const isImage = input.mimeType.startsWith("image/");
    if (
      (isImage &&
        (!Number.isSafeInteger(input.width) ||
          !Number.isSafeInteger(input.height) ||
          (input.width ?? 0) < 1 ||
          (input.height ?? 0) < 1)) ||
      (!isImage && (input.width !== undefined || input.height !== undefined))
    ) {
      throw new LibraryError("invalid_input", "The browser resource dimensions are invalid.");
    }
    return {
      path: canonicalPath,
      mimeType: input.mimeType,
      byteLength: input.byteLength,
      sha256,
      ...(input.width === undefined ? {} : { width: input.width }),
      ...(input.height === undefined ? {} : { height: input.height })
    };
  }

  async inspectImage(blob: StoredImageBlob): Promise<InspectedBrowserBackingFile> {
    return await this.#inspect({
      relativePath: blob.relativePath,
      mimeType: blob.mimeType,
      byteLength: blob.byteLength,
      sha256: blob.sha256,
      width: blob.width,
      height: blob.height
    });
  }

  async registerImage(
    blob: StoredImageBlob,
    rendition: Exclude<LibraryBrowserResourceRendition, "zip">
  ): Promise<BrowserResourceDescriptor> {
    return await this.#register(await this.inspectImage(blob), rendition);
  }

  async registerZip(input: RegisterZipBrowserResourceInput): Promise<BrowserResourceDescriptor> {
    return await this.#register(
      await this.#inspect({
        relativePath: input.relativePath,
        mimeType: "application/zip",
        byteLength: input.byteLength,
        sha256: input.sha256
      }),
      "zip"
    );
  }

  async #register(
    backing: InspectedBrowserBackingFile,
    rendition: LibraryBrowserResourceRendition
  ): Promise<BrowserResourceDescriptor> {
    this.cleanupExpired();
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) {
      throw new LibraryError("internal_contract", "The browser resource clock is invalid.");
    }
    let resourceId: string | undefined;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let candidate: string;
      try {
        candidate = identifierSchema.parse(this.#idFactory(rendition));
      } catch {
        throw new LibraryError(
          "internal_contract",
          "The browser resource identifier factory returned an invalid value."
        );
      }
      if (!this.#resources.has(candidate)) {
        resourceId = candidate;
        break;
      }
    }
    if (resourceId === undefined) {
      throw new LibraryError("conflict", "A unique browser resource identity could not be allocated.");
    }
    const expiresAt = new Date(now.getTime() + this.#ttlMs).toISOString();
    const etag = `sha256-${backing.sha256}`;
    const descriptor = browserResourceDescriptorSchema.parse({
      resourceId,
      relativeUrl: `/api/v1/library/resources/${resourceId}`,
      requiresSession: true,
      mimeType: backing.mimeType,
      byteLength: backing.byteLength,
      ...(backing.width === undefined ? {} : { width: backing.width }),
      ...(backing.height === undefined ? {} : { height: backing.height }),
      etag,
      expiresAt
    });
    this.#resources.set(resourceId, {
      resourceId,
      rendition,
      ...backing,
      etag,
      expiresAt,
      descriptor
    });
    return descriptor;
  }

  resolve(resourceIdInput: string): ResolvedBrowserResource {
    let resourceId: string;
    try {
      resourceId = identifierSchema.parse(resourceIdInput);
    } catch {
      throw new LibraryError("invalid_input", "The browser resource identity is invalid.");
    }
    const record = this.#resources.get(resourceId);
    if (!record || Date.parse(record.expiresAt) <= this.#now().getTime()) {
      if (record) this.#resources.delete(resourceId);
      throw new LibraryError("not_found", "The browser resource is unavailable or expired.");
    }
    const { descriptor: _descriptor, ...resolved } = record;
    return resolved;
  }

  discard(resourceIdInput: string): boolean {
    let resourceId: string;
    try {
      resourceId = identifierSchema.parse(resourceIdInput);
    } catch {
      return false;
    }
    return this.#resources.delete(resourceId);
  }

  cleanupExpired(): number {
    const now = this.#now().getTime();
    if (!Number.isFinite(now)) {
      throw new LibraryError("internal_contract", "The browser resource clock is invalid.");
    }
    let removed = 0;
    for (const [resourceId, record] of this.#resources) {
      if (Date.parse(record.expiresAt) <= now) {
        this.#resources.delete(resourceId);
        removed += 1;
      }
    }
    return removed;
  }
}
