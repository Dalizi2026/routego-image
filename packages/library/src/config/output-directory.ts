import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
  type FileHandle
} from "node:fs/promises";

import { createProtectedLegacyRoots, type PathPlatform } from "@routego-image/foundation";

import { LibraryError, isNodeError } from "../errors";

export interface OutputDirectoryStat {
  readonly uid?: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface OutputDirectoryFileSystem {
  lstat(filePath: string): Promise<OutputDirectoryStat>;
  mkdir(directory: string, options: { readonly recursive: true; readonly mode: number }): Promise<unknown>;
  realpath(filePath: string): Promise<string>;
  open(filePath: string, flags: "wx", mode: number): Promise<Pick<FileHandle, "sync" | "close">>;
  unlink(filePath: string): Promise<void>;
}

const defaultFileSystem: OutputDirectoryFileSystem = { lstat, mkdir, realpath, open, unlink };

export interface ValidateOutputDirectoryOptions {
  readonly platform?: PathPlatform;
  readonly homeDirectory: string;
  readonly defaultDirectory?: string;
  readonly protectedRoots?: readonly string[];
  readonly fileSystem?: OutputDirectoryFileSystem;
  readonly currentUid?: number;
  readonly tokenFactory?: () => string;
}

function implementation(platform: PathPlatform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function normalized(value: string, platform: PathPlatform): string {
  const pathApi = implementation(platform);
  const resolved = pathApi.resolve(value);
  const parsed = pathApi.parse(resolved);
  let result = pathApi.normalize(resolved);
  while (result.length > parsed.root.length && result.endsWith(pathApi.sep)) {
    result = result.slice(0, -pathApi.sep.length);
  }
  return platform === "win32" ? result.toLowerCase() : result;
}

function contains(parent: string, child: string, platform: PathPlatform): boolean {
  const pathApi = implementation(platform);
  const relative = pathApi.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(relative))
  );
}

function overlaps(left: string, right: string, platform: PathPlatform): boolean {
  return contains(left, right, platform) || contains(right, left, platform);
}

function rejectLexicallyUnsafePath(value: string, platform: PathPlatform): void {
  const pathApi = implementation(platform);
  if (
    value.includes("\0") ||
    /^(?:file:|[A-Za-z][A-Za-z0-9+.-]*:\/\/)/iu.test(value) ||
    value.split(/[\\/]/u).includes("..") ||
    !pathApi.isAbsolute(value) ||
    value.startsWith("//")
  ) {
    throw new LibraryError("path_unsafe", "The selected output directory is unsafe.");
  }
  if (
    platform === "win32" &&
    (/^(?:\\\\|\/\/|\\\\[?.]\\)/u.test(value) ||
      !/^[A-Za-z]:[\\/]/u.test(value) ||
      value.slice(2).includes(":") ||
      value
        .split(/[\\/]/u)
        .slice(1)
        .some(
          (segment) =>
            /[. ]$/u.test(segment) ||
            /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment)
        ))
  ) {
    throw new LibraryError("path_unsafe", "The selected output directory is unsafe.");
  }
}

export function canonicalizeOutputDirectorySyntax(
  value: string,
  options: Pick<
    ValidateOutputDirectoryOptions,
    "platform" | "homeDirectory" | "defaultDirectory" | "protectedRoots"
  >
): string {
  const platform = options.platform ?? (process.platform === "win32" ? "win32" : "posix");
  const pathApi = implementation(platform);
  rejectLexicallyUnsafePath(value, platform);
  const candidate = pathApi.resolve(value);
  const parsed = pathApi.parse(candidate);
  if (normalized(candidate, platform) === normalized(parsed.root, platform)) {
    throw new LibraryError("path_unsafe", "The selected output directory cannot be a filesystem root.");
  }
  const home = pathApi.resolve(options.homeDirectory);
  const defaultDirectory = pathApi.resolve(
    options.defaultDirectory ?? pathApi.join(home, "Pictures", "routego-image", "library")
  );
  const protectedRoots =
    options.protectedRoots ?? createProtectedLegacyRoots(home, platform);
  const candidateNormalized = normalized(candidate, platform);
  const defaultNormalized = normalized(defaultDirectory, platform);
  const insideApprovedNewRoot = contains(defaultNormalized, candidateNormalized, platform);
  if (
    !insideApprovedNewRoot &&
    protectedRoots.some((protectedRoot) =>
      overlaps(candidateNormalized, normalized(protectedRoot, platform), platform)
    )
  ) {
    throw new LibraryError("path_unsafe", "The selected output directory is protected.");
  }
  return candidate;
}

async function inspectExistingComponents(
  candidate: string,
  platform: PathPlatform,
  fileSystem: OutputDirectoryFileSystem,
  currentUid: number | undefined
): Promise<void> {
  const pathApi = implementation(platform);
  const parsed = pathApi.parse(candidate);
  const segments = pathApi.relative(parsed.root, candidate).split(pathApi.sep).filter(Boolean);
  let current = parsed.root;
  let lastExisting: OutputDirectoryStat | undefined;
  for (const segment of segments) {
    current = pathApi.join(current, segment);
    let entry: OutputDirectoryStat;
    try {
      entry = await fileSystem.lstat(current);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) break;
      throw new LibraryError("access_denied", "The selected output directory cannot be inspected.");
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new LibraryError("path_unsafe", "The selected output directory is unsafe.");
    }
    lastExisting = entry;
  }
  if (
    platform === "posix" &&
    currentUid !== undefined &&
    lastExisting !== undefined &&
    lastExisting.uid !== currentUid
  ) {
    throw new LibraryError("access_denied", "The selected output directory is not user-owned.");
  }
}

async function verifyFinalDirectory(
  candidate: string,
  platform: PathPlatform,
  fileSystem: OutputDirectoryFileSystem,
  currentUid: number | undefined
): Promise<void> {
  let entry: OutputDirectoryStat;
  try {
    entry = await fileSystem.lstat(candidate);
  } catch {
    throw new LibraryError("access_denied", "The selected output directory cannot be created.");
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new LibraryError("path_unsafe", "The selected output directory is unsafe.");
  }
  if (platform === "posix" && currentUid !== undefined && entry.uid !== currentUid) {
    throw new LibraryError("access_denied", "The selected output directory is not user-owned.");
  }
}

export async function validateOutputDirectory(
  value: string,
  options: ValidateOutputDirectoryOptions
): Promise<string> {
  const platform = options.platform ?? (process.platform === "win32" ? "win32" : "posix");
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const pathApi = implementation(platform);
  const candidate = canonicalizeOutputDirectorySyntax(value, options);
  const candidateNormalized = normalized(candidate, platform);

  const currentUid =
    platform === "posix" ? (options.currentUid ?? process.getuid?.()) : undefined;
  await inspectExistingComponents(candidate, platform, fileSystem, currentUid);
  try {
    await fileSystem.mkdir(candidate, { recursive: true, mode: 0o700 });
  } catch {
    throw new LibraryError("access_denied", "The selected output directory cannot be created.");
  }
  await verifyFinalDirectory(candidate, platform, fileSystem, currentUid);

  let canonical: string;
  try {
    canonical = await fileSystem.realpath(candidate);
  } catch {
    throw new LibraryError("access_denied", "The selected output directory cannot be canonicalized.");
  }
  if (normalized(canonical, platform) !== candidateNormalized) {
    throw new LibraryError("path_unsafe", "The selected output directory resolves through a link.");
  }

  const probe = pathApi.join(
    canonical,
    `.routego-write-probe-${options.tokenFactory?.() ?? randomUUID()}.tmp`
  );
  let handle: Pick<FileHandle, "sync" | "close"> | undefined;
  let createdProbe = false;
  try {
    handle = await fileSystem.open(probe, "wx", 0o600);
    createdProbe = true;
    await handle.sync();
  } catch {
    throw new LibraryError("access_denied", "The selected output directory is not writable.");
  } finally {
    await handle?.close().catch(() => undefined);
    if (createdProbe) await fileSystem.unlink(probe).catch(() => undefined);
  }
  return canonical;
}

export function redactOutputDirectoryDisplay(value: string, platform?: PathPlatform): string {
  const selectedPlatform =
    platform ?? (process.platform === "win32" ? "win32" : "posix");
  const pathApi = implementation(selectedPlatform);
  const parsed = pathApi.parse(value);
  const segments = pathApi
    .relative(parsed.root, pathApi.resolve(value))
    .split(pathApi.sep)
    .filter(Boolean)
    .slice(-2);
  return segments.length === 0 ? "Selected local output directory" : `…/${segments.join("/")}`;
}

export function defaultOutputDirectoryDisplay(): string {
  return "Default Pictures/routego-image/library";
}
