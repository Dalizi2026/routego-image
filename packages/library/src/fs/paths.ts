import path from "node:path";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";

import {
  resolveContainedPath,
  type PathOperation,
  type PathPlatform
} from "@routego-image/foundation";

import { LibraryError, isNodeError } from "../errors";

export interface ExclusiveFile {
  readonly path: string;
  readonly handle: FileHandle;
}

export interface PathIdentityFileSystem {
  lstat(filePath: string): Promise<{ isDirectory(): boolean }>;
  realpath(filePath: string): Promise<string>;
}

const defaultPathIdentityFileSystem: PathIdentityFileSystem = { lstat, realpath };

function implementation(platform: PathPlatform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

export function normalizePathIdentity(value: string, platform: PathPlatform): string {
  const pathApi = implementation(platform);
  const normalized = pathApi.normalize(pathApi.resolve(value));
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

export function isPathIdentityContained(
  root: string,
  candidate: string,
  platform: PathPlatform
): boolean {
  const pathApi = implementation(platform);
  const relative = pathApi.relative(
    normalizePathIdentity(root, platform),
    normalizePathIdentity(candidate, platform)
  );
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(relative))
  );
}

export function pathIdentitiesOverlap(
  left: string,
  right: string,
  platform: PathPlatform
): boolean {
  return (
    isPathIdentityContained(left, right, platform) ||
    isPathIdentityContained(right, left, platform)
  );
}

export async function canonicalizePathIdentity(
  value: string,
  options: {
    readonly platform?: PathPlatform;
    readonly fileSystem?: PathIdentityFileSystem;
  } = {}
): Promise<string> {
  const platform = options.platform ?? (process.platform === "win32" ? "win32" : "posix");
  const pathApi = implementation(platform);
  const fileSystem = options.fileSystem ?? defaultPathIdentityFileSystem;
  let cursor = pathApi.resolve(value);
  const missingSegments: string[] = [];

  while (true) {
    let metadata: { isDirectory(): boolean };
    try {
      metadata = await fileSystem.lstat(cursor);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      const parent = pathApi.dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.unshift(pathApi.basename(cursor));
      cursor = parent;
      continue;
    }

    const canonical = await fileSystem.realpath(cursor);
    if (missingSegments.length > 0 && !metadata.isDirectory()) {
      throw new LibraryError("path_unsafe", "A canonical path ancestor is not a directory.");
    }
    return pathApi.resolve(canonical, ...missingSegments);
  }
}

export async function canonicalizePathIdentities(
  values: readonly string[],
  options: {
    readonly platform?: PathPlatform;
    readonly fileSystem?: PathIdentityFileSystem;
  } = {}
): Promise<readonly string[]> {
  return await Promise.all(values.map(async (value) => await canonicalizePathIdentity(value, options)));
}

export function resolveApprovedPath(options: {
  readonly root: string;
  readonly candidate: string;
  readonly operation?: PathOperation;
  readonly platform?: PathPlatform;
  readonly protectedRoots?: readonly string[];
}): string {
  try {
    return resolveContainedPath(options);
  } catch (error) {
    throw new LibraryError("path_unsafe", "The requested path is outside the approved root.", {
      cause: error
    });
  }
}

export function sanitizeBaseName(value: string, fallback = "routego-image"): string {
  const normalized = Array.from(
    value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/gu, "")
  )
    .slice(0, 120)
    .join("")
    .replace(/[. ]+$/gu, "");
  if (
    normalized === "" ||
    normalized === "." ||
    normalized === ".." ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(normalized)
  ) {
    return fallback;
  }
  return normalized;
}

export async function createExclusiveFile(options: {
  readonly directory: string;
  readonly requestedBaseName: string;
  readonly extension: string;
  readonly mode?: number;
  readonly maxAttempts?: number;
}): Promise<ExclusiveFile> {
  const extension = options.extension.startsWith(".")
    ? options.extension.toLowerCase()
    : `.${options.extension.toLowerCase()}`;
  if (!/^\.[a-z0-9]{1,10}$/u.test(extension)) {
    throw new LibraryError("invalid_input", "The requested file extension is invalid.");
  }

  const maxAttempts = options.maxAttempts ?? 10_000;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new LibraryError("invalid_input", "The exclusive filename attempt limit is invalid.");
  }
  await mkdir(options.directory, { recursive: true });
  const baseName = sanitizeBaseName(options.requestedBaseName);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const candidate = path.join(options.directory, `${baseName}${suffix}${extension}`);
    try {
      const handle = await open(candidate, "wx", options.mode ?? 0o600);
      return { path: candidate, handle };
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        continue;
      }
      throw new LibraryError("file_write_failed", "A new exclusive file could not be created.", {
        cause: error
      });
    }
  }
  throw new LibraryError("conflict", "No exclusive filename was available.");
}
