import os from "node:os";
import path from "node:path";
import { copyFile, lstat, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { TextDecoder } from "node:util";

import { LibraryError, isNodeError } from "../errors";
import { cleanupAtomicJsonTemporaryFiles, writeJsonAtomic } from "../fs/atomic-json";
import {
  listTransactionJournals,
  markTransactionJournalCommitted,
  removeTransactionJournal,
  writeTransactionJournal,
  type FileTransactionJournal
} from "../fs/journal";
import { acquireFileLock, type AcquireFileLockOptions } from "../fs/lock";
import { resolveApprovedPath } from "../fs/paths";
import {
  createEmptyImageLibraryIndex,
  planLegacyImageLibraryUpgrade,
  parseImageLibraryIndex,
  referencedBlobPaths,
  type ImageLibraryIndex
} from "./model";

export const IMAGE_LIBRARY_BLOB_TRANSACTION_KIND = "image-library-blob-v1";
export const IMAGE_LIBRARY_LEGACY_UPGRADE_TRANSACTION_KIND = "image-library-v1-upgrade";

export type LegacyLibraryUpgradeInspection =
  | { readonly status: "not-required" }
  | { readonly status: "ready"; readonly fingerprint: string; readonly assetCount: number }
  | { readonly status: "blocked"; readonly error: LibraryError };

export interface ImageLibraryStoragePaths {
  readonly root: string;
  readonly index: string;
  readonly indexLock: string;
  readonly blobs: string;
  readonly transactions: string;
  readonly transactionFiles: string;
}

export interface ImageLibraryIndexStoreHooks {
  readonly beforeIndexCommit?: (next: ImageLibraryIndex) => Promise<void>;
  readonly afterIndexCommit?: (committed: ImageLibraryIndex) => Promise<void>;
}

export interface ImageLibraryIndexStoreOptions {
  readonly root?: string;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly lockOptions?: AcquireFileLockOptions;
  readonly hooks?: ImageLibraryIndexStoreHooks;
}

export type ImageLibraryIndexState = Pick<ImageLibraryIndex, "blobs" | "assets" | "folders"> & {
  /** Omit to retain the current mark; pass undefined explicitly to clear it. */
  readonly currentMarkRecordId?: string | undefined;
};

export interface ImageLibraryIndexContext {
  readonly index: ImageLibraryIndex;
  commit(next: ImageLibraryIndexState): Promise<ImageLibraryIndex>;
}

function pathApi(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

export function createImageLibraryStoragePaths(
  options: Pick<ImageLibraryIndexStoreOptions, "root" | "homeDirectory" | "platform"> = {}
): ImageLibraryStoragePaths {
  const platform = options.platform ?? process.platform;
  const selectedPath = pathApi(platform);
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const root = selectedPath.resolve(
    options.root ?? selectedPath.join(homeDirectory, "Pictures", "routego-image", "library")
  );
  return {
    root,
    index: selectedPath.join(root, "index.json"),
    indexLock: selectedPath.join(root, ".locks", "index.lock"),
    blobs: selectedPath.join(root, "blobs"),
    transactions: selectedPath.join(root, ".transactions"),
    transactionFiles: selectedPath.join(root, ".transactions", "files")
  };
}

function safeIndexError(cause?: unknown): LibraryError {
  return new LibraryError("config_corrupt", "The Image Library index is malformed or invalid.", {
    ...(cause === undefined ? {} : { cause })
  });
}

async function readIndexValue(filePath: string): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw error;
    throw safeIndexError(error);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw safeIndexError(error);
  }
}

async function readIndexRecovering(filePath: string): Promise<ImageLibraryIndex | undefined> {
  let primaryError: unknown;
  try {
    return parseImageLibraryIndex(await readIndexValue(filePath));
  } catch (error) {
    if (error instanceof LibraryError && error.code === "unsupported_version") throw error;
    primaryError = error;
  }

  if (!isNodeError(primaryError, "ENOENT")) {
    throw primaryError instanceof LibraryError ? primaryError : safeIndexError(primaryError);
  }

  try {
    const recovered = parseImageLibraryIndex(await readIndexValue(`${filePath}.bak`));
    await writeJsonAtomic(filePath, recovered);
    return recovered;
  } catch (backupError) {
    if (backupError instanceof LibraryError && backupError.code === "unsupported_version") {
      throw backupError;
    }
    if (isNodeError(backupError, "ENOENT")) return undefined;
    throw safeIndexError(backupError);
  }
}

async function unlinkRegularFile(filePath: string): Promise<void> {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return;
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

function journalString(journal: FileTransactionJournal, key: string): string | undefined {
  const value = journal.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function journalNumber(journal: FileTransactionJournal, key: string): number | undefined {
  const value = journal.metadata?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function validateBlobJournalOwnership(journal: FileTransactionJournal): {
  readonly tempRelative: string;
  readonly finalRelative?: string;
  readonly expectedRevision: number;
} {
  const tempRelative = journalString(journal, "tempPath");
  const finalRelative = journalString(journal, "finalPath");
  const expectedRevision = journalNumber(journal, "expectedRevision");
  const sha256 = journalString(journal, "sha256");
  const expectedTemp = `.transactions/files/${journal.id}.tmp`;
  if (
    tempRelative !== expectedTemp ||
    !journal.createdPaths.includes(tempRelative) ||
    (finalRelative !== undefined &&
      (!/^blobs\/\d{4}\/(?:0[1-9]|1[0-2])\/[^/]+\.(?:png|jpg|webp)$/u.test(finalRelative) ||
        !journal.createdPaths.includes(finalRelative))) ||
    expectedRevision === undefined ||
    expectedRevision < 1 ||
    sha256 === undefined ||
    !/^[a-f0-9]{64}$/u.test(sha256) ||
    journal.deleteAfterCommitPaths.length !== 0
  ) {
    throw new LibraryError("config_corrupt", "An Image Library transaction journal is invalid.");
  }
  return {
    tempRelative,
    ...(finalRelative === undefined ? {} : { finalRelative }),
    expectedRevision
  };
}

export class ImageLibraryIndexStore {
  readonly #paths: ImageLibraryStoragePaths;
  readonly #lockOptions: AcquireFileLockOptions | undefined;
  readonly #hooks: ImageLibraryIndexStoreHooks;

  constructor(options: ImageLibraryIndexStoreOptions = {}) {
    this.#paths = createImageLibraryStoragePaths(options);
    this.#lockOptions = options.lockOptions;
    this.#hooks = options.hooks ?? {};
  }

  get paths(): ImageLibraryStoragePaths {
    return this.#paths;
  }

  async #ensureLayout(): Promise<void> {
    await Promise.all([
      mkdir(this.#paths.root, { recursive: true, mode: 0o700 }),
      mkdir(this.#paths.blobs, { recursive: true, mode: 0o700 }),
      mkdir(path.dirname(this.#paths.indexLock), { recursive: true, mode: 0o700 }),
      mkdir(this.#paths.transactions, { recursive: true, mode: 0o700 }),
      mkdir(this.#paths.transactionFiles, { recursive: true, mode: 0o700 })
    ]);
  }

  async #readIndexUnderLock(): Promise<ImageLibraryIndex> {
    await cleanupAtomicJsonTemporaryFiles(this.#paths.index, { olderThanMs: 0 });
    const existing = await readIndexRecovering(this.#paths.index);
    if (existing) return existing;
    const created = createEmptyImageLibraryIndex();
    await writeJsonAtomic(this.#paths.index, created);
    return created;
  }

  #absoluteJournalPath(relativePath: string, operation: "read" | "delete"): string {
    return resolveApprovedPath({ root: this.#paths.root, candidate: relativePath, operation });
  }

  async #recoverBlobJournal(
    journal: FileTransactionJournal,
    index: ImageLibraryIndex
  ): Promise<void> {
    const ownership = validateBlobJournalOwnership(journal);
    const referenced = referencedBlobPaths(index);
    const tempRelative = ownership.tempRelative;
    const finalRelative = ownership.finalRelative;
    const expectedRevision = ownership.expectedRevision;
    const indexCommitted =
      finalRelative !== undefined &&
      referenced.has(finalRelative) &&
      (expectedRevision === undefined || index.revision >= expectedRevision);

    const tempPath = this.#absoluteJournalPath(tempRelative, "delete");
    const finalPath =
      finalRelative === undefined
        ? undefined
        : this.#absoluteJournalPath(finalRelative, "delete");

    if (indexCommitted) {
      await unlinkRegularFile(tempPath);
    } else if (finalPath) {
      if (await sameRegularFile(tempPath, finalPath)) {
        await unlinkRegularFile(finalPath);
      }
      await unlinkRegularFile(tempPath);
    } else {
      await unlinkRegularFile(tempPath);
    }
    await removeTransactionJournal(this.#paths.root, journal.id);
  }

  async #recoverUnderLock(index: ImageLibraryIndex): Promise<void> {
    for (const journal of await listTransactionJournals(this.#paths.root)) {
      if (journal.kind !== IMAGE_LIBRARY_BLOB_TRANSACTION_KIND) continue;
      await this.#recoverBlobJournal(journal, index);
    }
  }

  async runExclusive<T>(callback: (context: ImageLibraryIndexContext) => Promise<T>): Promise<T> {
    await this.#ensureLayout();
    const lock = await acquireFileLock(
      this.#paths.indexLock,
      "routego-image-library-index",
      this.#lockOptions
    );
    try {
      const index = await this.#readIndexUnderLock();
      await this.#recoverUnderLock(index);
      let committed = false;
      const context: ImageLibraryIndexContext = {
        index,
        commit: async (next) => {
          if (committed) {
            throw new LibraryError("conflict", "The Image Library transaction is already committed.");
          }
          const currentMarkRecordId = Object.hasOwn(next, "currentMarkRecordId")
            ? next.currentMarkRecordId
            : index.currentMarkRecordId;
          const validated = parseImageLibraryIndex({
            schemaVersion: 2,
            revision: index.revision + 1,
            blobs: next.blobs,
            assets: next.assets,
            folders: next.folders,
            ...(currentMarkRecordId === undefined ? {} : { currentMarkRecordId })
          });
          if (this.#hooks.beforeIndexCommit) await this.#hooks.beforeIndexCommit(validated);
          await writeJsonAtomic(this.#paths.index, validated);
          committed = true;
          if (this.#hooks.afterIndexCommit) await this.#hooks.afterIndexCommit(validated);
          return validated;
        }
      };
      return await callback(context);
    } finally {
      await lock.release();
    }
  }

  async read(): Promise<ImageLibraryIndex> {
    return await this.runExclusive(async ({ index }) => structuredClone(index));
  }

  async inspectLegacyUpgrade(): Promise<LegacyLibraryUpgradeInspection> {
    await this.#ensureLayout();
    const lock = await acquireFileLock(this.#paths.indexLock, "routego-image-library-index", this.#lockOptions);
    try {
      let source: unknown;
      try {
        source = await readIndexValue(this.#paths.index);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return { status: "not-required" };
        throw error;
      }
      if (source === null || typeof source !== "object" || Array.isArray(source)) {
        throw safeIndexError();
      }
      const schemaVersion = (source as Record<string, unknown>)["schemaVersion"];
      if (schemaVersion !== 1) {
        parseImageLibraryIndex(source);
        return { status: "not-required" };
      }
      try {
        const plan = planLegacyImageLibraryUpgrade(source);
        return { status: "ready", fingerprint: plan.fingerprint, assetCount: plan.assetCount };
      } catch (error) {
        return {
          status: "blocked",
          error: error instanceof LibraryError
            ? error
            : new LibraryError("config_corrupt", "The legacy Image Library cannot be upgraded safely.")
        };
      }
    } finally {
      await lock.release();
    }
  }

  async confirmLegacyUpgrade(fingerprint: string): Promise<void> {
    await this.#ensureLayout();
    const lock = await acquireFileLock(this.#paths.indexLock, "routego-image-library-index", this.#lockOptions);
    try {
      const source = await readIndexValue(this.#paths.index);
      const plan = planLegacyImageLibraryUpgrade(source);
      if (plan.fingerprint !== fingerprint) {
        throw new LibraryError("conflict", "The legacy Image Library changed before confirmation.");
      }
      const backupRelative = `index.json.routego-v1-backup-${plan.fingerprint.slice(0, 16)}`;
      const backupPath = resolveApprovedPath({ root: this.#paths.root, candidate: backupRelative, operation: "create" });
      const journalId = `legacy-upgrade-${plan.fingerprint.slice(0, 16)}`;
      const journal: FileTransactionJournal = {
        schemaVersion: 1,
        id: journalId,
        kind: IMAGE_LIBRARY_LEGACY_UPGRADE_TRANSACTION_KIND,
        state: "prepared",
        createdAt: new Date().toISOString(),
        createdPaths: [backupRelative],
        deleteAfterCommitPaths: [],
        metadata: { fingerprint: plan.fingerprint }
      };
      await writeTransactionJournal(this.#paths.root, journal);
      try {
        await copyFile(this.#paths.index, backupPath);
        await writeJsonAtomic(this.#paths.index, plan.index);
        parseImageLibraryIndex(await readIndexValue(this.#paths.index));
        await markTransactionJournalCommitted(this.#paths.root, journal);
      } finally {
        await removeTransactionJournal(this.#paths.root, journalId).catch(() => undefined);
      }
    } finally {
      await lock.release();
    }
  }

  async recover(): Promise<void> {
    await this.runExclusive(async () => undefined);
  }
}
