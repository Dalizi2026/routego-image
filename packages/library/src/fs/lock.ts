import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";

import { LibraryError, isNodeError } from "../errors";

interface LockMetadata {
  readonly schemaVersion: 1;
  readonly token: string;
  readonly pid: number;
  readonly resource: string;
  readonly createdAt: string;
}

export interface AcquireFileLockOptions {
  readonly timeoutMs?: number;
  readonly staleMs?: number;
  readonly retryMinMs?: number;
  readonly retryMaxMs?: number;
  readonly now?: () => number;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly beforeStaleTokenRecheck?: () => Promise<void>;
}

export interface FileLock {
  readonly path: string;
  readonly token: string;
  release(): Promise<void>;
}

const delay = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

function parseLock(value: string): LockMetadata | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<LockMetadata>;
    if (
      parsed.schemaVersion === 1 &&
      typeof parsed.token === "string" &&
      parsed.token.length > 0 &&
      parsed.token.length <= 200 &&
      Number.isInteger(parsed.pid) &&
      (parsed.pid ?? 0) > 0 &&
      typeof parsed.resource === "string" &&
      parsed.resource.length > 0 &&
      parsed.resource.length <= 500 &&
      typeof parsed.createdAt === "string"
    ) {
      return parsed as LockMetadata;
    }
  } catch {
    // Invalid old lock metadata can only be removed after the stale threshold.
  }
  return undefined;
}

async function readLock(lockPath: string): Promise<LockMetadata | undefined> {
  try {
    return parseLock(await readFile(lockPath, "utf8"));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function recoverStaleLock(
  lockPath: string,
  staleMs: number,
  now: number,
  isProcessAlive: (pid: number) => boolean,
  beforeTokenRecheck?: () => Promise<void>
): Promise<boolean> {
  let metadata: LockMetadata | undefined;
  let age: number;
  try {
    metadata = await readLock(lockPath);
    const fileStat = await stat(lockPath);
    const createdAt = metadata ? Date.parse(metadata.createdAt) : Number.NaN;
    age = now - (Number.isFinite(createdAt) ? createdAt : fileStat.mtimeMs);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    throw error;
  }

  if (age < staleMs || (metadata !== undefined && isProcessAlive(metadata.pid))) return false;
  const token = metadata?.token;
  if (beforeTokenRecheck) await beforeTokenRecheck();
  const current = await readLock(lockPath);
  if ((token !== undefined && current?.token !== token) || (token === undefined && current !== undefined)) {
    return false;
  }
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    return false;
  }
}

export async function acquireFileLock(
  lockPath: string,
  resource: string,
  options: AcquireFileLockOptions = {}
): Promise<FileLock> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 60_000;
  const retryMinMs = options.retryMinMs ?? 10;
  const retryMaxMs = options.retryMaxMs ?? 250;
  const now = options.now ?? Date.now;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const sleep = options.sleep ?? delay;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0 ||
    !Number.isFinite(staleMs) ||
    staleMs < 0 ||
    !Number.isFinite(retryMinMs) ||
    retryMinMs < 1 ||
    !Number.isFinite(retryMaxMs) ||
    retryMaxMs < retryMinMs
  ) {
    throw new LibraryError("invalid_input", "The persistence lock timing options are invalid.");
  }
  const started = now();
  const token = randomUUID();
  await mkdir(path.dirname(lockPath), { recursive: true });

  let attempt = 0;
  while (now() - started <= timeoutMs) {
    const metadata: LockMetadata = {
      schemaVersion: 1,
      token,
      pid: process.pid,
      resource,
      createdAt: new Date(now()).toISOString()
    };
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      } finally {
        await handle.close().catch(() => undefined);
      }
      return {
        path: lockPath,
        token,
        async release(): Promise<void> {
          const current = await readLock(lockPath);
          if (current?.token !== token) return;
          try {
            await unlink(lockPath);
          } catch (error) {
            if (!isNodeError(error, "ENOENT")) throw error;
          }
        }
      };
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw new LibraryError("file_write_failed", "The persistence lock could not be created.", {
          cause: error
        });
      }
    }

    if (
      await recoverStaleLock(
        lockPath,
        staleMs,
        now(),
        isProcessAlive,
        options.beforeStaleTokenRecheck
      )
    ) {
      continue;
    }
    attempt += 1;
    const remaining = timeoutMs - (now() - started);
    if (remaining <= 0) break;
    const wait = Math.min(
      remaining,
      retryMaxMs,
      retryMinMs * 2 ** Math.min(attempt, 8)
    );
    await sleep(wait);
  }

  throw new LibraryError("lock_timeout", "Timed out waiting for the persistence lock.", {
    details: { timeoutMs }
  });
}

export async function withFileLock<T>(
  lockPath: string,
  resource: string,
  callback: () => Promise<T>,
  options?: AcquireFileLockOptions
): Promise<T> {
  const lock = await acquireFileLock(lockPath, resource, options);
  try {
    return await callback();
  } finally {
    await lock.release();
  }
}
