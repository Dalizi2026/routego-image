import { randomUUID } from "node:crypto";
import path from "node:path";
import { TextDecoder } from "node:util";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink
} from "node:fs/promises";

import { LibraryError, isNodeError } from "../errors";

export interface AtomicJsonOptions {
  readonly mode?: number;
  readonly applyPermissions?: (filePath: string) => Promise<void>;
}

interface AtomicJsonWriteOptions extends AtomicJsonOptions {
  readonly createBackup: boolean;
}

export interface AtomicJsonCleanupOptions {
  readonly olderThanMs?: number;
  readonly now?: () => number;
}

async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

async function flushDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isNodeError(error, "EINVAL") && !isNodeError(error, "EPERM") && !isNodeError(error, "EISDIR")) {
      throw error;
    }
  }
}

async function flushFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function parseFile<T>(filePath: string, parse: (value: unknown) => T): Promise<T> {
  const bytes = await readFile(filePath);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new LibraryError("config_corrupt", "A persisted JSON document is not valid UTF-8.", {
      cause: error
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new LibraryError("config_corrupt", "A persisted JSON document is malformed.", {
      cause: error
    });
  }
  try {
    return parse(value);
  } catch (error) {
    if (error instanceof LibraryError) throw error;
    throw new LibraryError("config_corrupt", "A persisted JSON document is invalid.", {
      cause: error
    });
  }
}

async function writeJsonAtomicInternal(
  filePath: string,
  value: unknown,
  options: AtomicJsonWriteOptions
): Promise<void> {
  const directory = path.dirname(filePath);
  const token = randomUUID();
  const temporary = path.join(directory, `.${path.basename(filePath)}.${token}.tmp`);
  const backup = `${filePath}.bak`;
  const backupTemporary = `${backup}.${token}.tmp`;
  await mkdir(directory, { recursive: true });
  const content = `${JSON.stringify(value, null, 2)}\n`;

  try {
    const handle = await open(temporary, "wx", options.mode ?? 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (options.createBackup) {
      try {
        await copyFile(filePath, backupTemporary);
        await flushFile(backupTemporary);
        if (options.applyPermissions) await options.applyPermissions(backupTemporary);
        await rename(backupTemporary, backup);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
    }

    if (options.applyPermissions) await options.applyPermissions(temporary);
    await rename(temporary, filePath);
    await flushDirectory(directory);
  } catch (error) {
    throw new LibraryError("file_write_failed", "A persisted document could not be replaced.", {
      cause: error
    });
  } finally {
    await removeIfPresent(temporary);
    await removeIfPresent(backupTemporary);
  }
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options: AtomicJsonOptions = {}
): Promise<void> {
  await writeJsonAtomicInternal(filePath, value, { ...options, createBackup: true });
}

export async function cleanupAtomicJsonTemporaryFiles(
  filePath: string,
  options: AtomicJsonCleanupOptions = {}
): Promise<readonly string[]> {
  const olderThanMs = options.olderThanMs ?? 60 * 60 * 1_000;
  if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
    throw new LibraryError("invalid_input", "The atomic cleanup age is invalid.");
  }
  const now = options.now ?? Date.now;
  const directory = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const prefixes = [`.${baseName}.`, `${baseName}.bak.`];
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  const removed: string[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".tmp") || !prefixes.some((prefix) => name.startsWith(prefix))) continue;
    const candidate = path.join(directory, name);
    try {
      const candidateStat = await stat(candidate);
      if (!candidateStat.isFile() || now() - candidateStat.mtimeMs < olderThanMs) continue;
      await unlink(candidate);
      removed.push(candidate);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
  return removed;
}

export async function readJsonRecovering<T>(
  filePath: string,
  parse: (value: unknown) => T,
  options: AtomicJsonOptions = {}
): Promise<T> {
  try {
    return await parseFile(filePath, parse);
  } catch (primaryError) {
    const backup = `${filePath}.bak`;
    try {
      const recovered = await parseFile(backup, parse);
      await writeJsonAtomicInternal(filePath, recovered, { ...options, createBackup: false });
      return recovered;
    } catch (backupError) {
      if (isNodeError(primaryError, "ENOENT") && isNodeError(backupError, "ENOENT")) {
        throw new LibraryError("not_found", "The persisted document does not exist.");
      }
      if (isNodeError(primaryError, "ENOENT")) throw backupError;
      throw primaryError;
    }
  }
}

export async function readJsonIfPresent<T>(
  filePath: string,
  parse: (value: unknown) => T,
  options: AtomicJsonOptions = {}
): Promise<T | undefined> {
  try {
    return await readJsonRecovering(filePath, parse, options);
  } catch (error) {
    if (error instanceof LibraryError && error.code === "not_found") return undefined;
    throw error;
  }
}
