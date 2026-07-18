import path from "node:path";
import { mkdir, open, type FileHandle } from "node:fs/promises";

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
