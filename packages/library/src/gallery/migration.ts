import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { copyFile, lstat, mkdir, readFile, rm, unlink } from "node:fs/promises";

import {
  libraryMigrationConfirmationInputSchema,
  libraryMigrationConfirmationResultSchema,
  libraryMigrationPreflightResultSchema,
  type LibraryMigrationConfirmationResult,
  type LibraryMigrationPreflightResult
} from "@routego-image/contracts";

import { LibraryError, isNodeError } from "../errors";
import { writeJsonAtomic } from "../fs/atomic-json";
import { markTransactionJournalCommitted, removeTransactionJournal, writeTransactionJournal } from "../fs/journal";
import { withFileLock } from "../fs/lock";
import { resolveApprovedPath } from "../fs/paths";
import { createImageLibraryStoragePaths } from "./index-store";
import {
  parseImageLibraryIndex,
  parseLegacyImageLibraryIndex,
  type LegacyImageLibraryIndex,
  type LegacyStoredLibraryAsset
} from "./model";

interface LegacyCleanupCandidate {
  readonly asset: LegacyStoredLibraryAsset;
  readonly reason: "legacy-edit" | "trash-generation";
}

type MigrationConflict = {
  readonly dependentRecordId: string;
  readonly dependencyRecordId: string;
  readonly reason: "generation-references-edit" | "shared-file-survives" | "unresolved-locator";
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareConflict(left: MigrationConflict, right: MigrationConflict): number {
  return (
    compareText(left.dependentRecordId, right.dependentRecordId) ||
    compareText(left.dependencyRecordId, right.dependencyRecordId) ||
    compareText(left.reason, right.reason)
  );
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).sort(compareText).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`)
    .join(",")}}`;
}

function fingerprint(index: LegacyImageLibraryIndex, conflicts: readonly MigrationConflict[]): string {
  const payload = canonicalValue({
    index,
    conflicts: [...conflicts].sort(compareConflict)
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function addConflict(
  target: Map<string, MigrationConflict>,
  conflict: MigrationConflict
): void {
  target.set(
    `${conflict.dependentRecordId}\u0000${conflict.dependencyRecordId}\u0000${conflict.reason}`,
    conflict
  );
}

/**
 * Computes the legacy-cleanup plan from an already parsed v1 index.
 *
 * This function is intentionally pure: it does not receive a store, path, or
 * confirmation value, and it neither reads nor writes Library files. The
 * later confirmation-bound task owns every destructive operation.
 */
export function preflightLegacyCleanup(
  index: LegacyImageLibraryIndex
): LibraryMigrationPreflightResult {
  const candidates = index.assets
    .flatMap<LegacyCleanupCandidate>((asset) => {
      if (asset.kind === "edit") return [{ asset, reason: "legacy-edit" }];
      if (asset.status === "deleted") return [{ asset, reason: "trash-generation" }];
      return [];
    })
    .sort((left, right) => compareText(left.asset.id, right.asset.id));
  const candidateById = new Map(candidates.map((candidate) => [candidate.asset.id, candidate]));
  const survivingAssets = index.assets.filter((asset) => !candidateById.has(asset.id));
  const artifactOwners = new Map<string, string>();
  const blobOwners = new Map<string, Set<string>>();
  for (const asset of index.assets) {
    for (const rendition of asset.renditions) {
      artifactOwners.set(rendition.artifactId, asset.id);
      const owners = blobOwners.get(rendition.blobSha256) ?? new Set<string>();
      owners.add(asset.id);
      blobOwners.set(rendition.blobSha256, owners);
    }
  }

  const conflictByKey = new Map<string, MigrationConflict>();
  for (const dependent of survivingAssets) {
    for (const relationship of dependent.relationships) {
      const candidate = candidateById.get(relationship.relatedAssetId);
      if (!candidate) continue;
      if (candidate.asset.kind === "edit" && dependent.kind === "generate") {
        addConflict(conflictByKey, {
          dependentRecordId: dependent.id,
          dependencyRecordId: candidate.asset.id,
          reason: "generation-references-edit"
        });
      } else {
        addConflict(conflictByKey, {
          dependentRecordId: dependent.id,
          dependencyRecordId: candidate.asset.id,
          reason: "unresolved-locator"
        });
      }
      if (
        relationship.artifactId !== undefined &&
        artifactOwners.get(relationship.artifactId) !== relationship.relatedAssetId
      ) {
        addConflict(conflictByKey, {
          dependentRecordId: dependent.id,
          dependencyRecordId: candidate.asset.id,
          reason: "unresolved-locator"
        });
      }
    }
  }

  const removableBlobShas = new Set<string>();
  for (const candidate of candidates) {
    for (const rendition of candidate.asset.renditions) {
      const owners = blobOwners.get(rendition.blobSha256) ?? new Set<string>();
      const survivingOwners = [...owners]
        .filter((ownerId) => !candidateById.has(ownerId))
        .sort(compareText);
      if (survivingOwners.length === 0) {
        removableBlobShas.add(rendition.blobSha256);
        continue;
      }
      for (const dependentRecordId of survivingOwners) {
        addConflict(conflictByKey, {
          dependentRecordId,
          dependencyRecordId: candidate.asset.id,
          reason: "shared-file-survives"
        });
      }
    }
  }

  const conflicts = [...conflictByKey.values()].sort(compareConflict);
  const removableRecordIds = candidates.map((candidate) => candidate.asset.id);
  const result = {
    schemaVersion: 1,
    fingerprint: fingerprint(index, conflicts),
    eligible: conflicts.length === 0,
    projectedCounts: {
      trashGenerationRecords: candidates.filter((candidate) => candidate.reason === "trash-generation")
        .length,
      editRecords: candidates.filter((candidate) => candidate.reason === "legacy-edit").length,
      ownedFiles: removableBlobShas.size,
      sharedReferences: conflicts.filter((conflict) => conflict.reason === "shared-file-survives").length,
      conflicts: conflicts.length
    },
    conflicts,
    removableRecordIds,
    providerRequestCount: 0 as const,
    mutatesData: false as const
  };
  return libraryMigrationPreflightResultSchema.parse(result);
}

export interface LegacyCleanupFixtureExecutionHooks {
  readonly beforeIndexPromotion?: () => Promise<void>;
  readonly beforeBlobDelete?: (relativePath: string) => Promise<void>;
  readonly afterBlobDelete?: (relativePath: string) => Promise<void>;
  readonly beforeVerification?: () => Promise<void>;
}

export interface ExecuteLegacyCleanupFixtureOptions {
  /** A synthetic, test-created Library root. This executor is not a real-data migration entry point. */
  readonly fixtureRoot: string;
  readonly confirmation: { readonly fingerprint: string; readonly confirmDestructiveMigration: true };
  readonly idFactory?: () => string;
  readonly now?: () => Date;
  readonly hooks?: LegacyCleanupFixtureExecutionHooks;
}

interface LegacyCleanupFilePlan {
  readonly removableBlobShas: ReadonlySet<string>;
  readonly removableBlobPaths: readonly string[];
}

function migrationError(
  fingerprint: string,
  status: "blocked" | "failed",
  safeMessage: string,
  recovered: boolean
): LibraryMigrationConfirmationResult {
  return libraryMigrationConfirmationResultSchema.parse({
    schemaVersion: 1,
    status,
    fingerprint,
    removedRecordCount: 0,
    removedFileCount: 0,
    recovered,
    providerRequestCount: 0,
    error: {
      code: status === "blocked" ? "conflict" : "file_write_failed",
      category: "persistence",
      stage: "persist",
      safeMessage,
      retryDisposition: status === "blocked" ? "user-confirmation" : "never",
      partialArtifacts: [],
      receivedAnyOutput: false,
      mayHaveBilled: false
    }
  });
}

function fixtureId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(value)) {
    throw new LibraryError("invalid_input", "The synthetic migration transaction identifier is invalid.");
  }
  return value;
}

function assertSyntheticFixtureRoot(root: string): void {
  if (!path.isAbsolute(root) || !path.basename(root).startsWith("routego-migration-fixture-")) {
    throw new LibraryError(
      "access_denied",
      "Legacy cleanup execution is limited to an explicitly named synthetic fixture directory."
    );
  }
}

async function readLegacyFixtureIndex(indexPath: string): Promise<{
  readonly raw: Record<string, unknown>;
  readonly parsed: LegacyImageLibraryIndex;
}> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(indexPath, "utf8")) as unknown;
  } catch (error) {
    throw new LibraryError("config_corrupt", "The synthetic legacy index could not be read.", { cause: error });
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LibraryError("config_corrupt", "The synthetic legacy index is invalid.");
  }
  return { raw: raw as Record<string, unknown>, parsed: parseLegacyImageLibraryIndex(raw) };
}

function filePlan(index: LegacyImageLibraryIndex, removableRecordIds: readonly string[]): LegacyCleanupFilePlan {
  const removableIds = new Set(removableRecordIds);
  const owners = new Map<string, Set<string>>();
  for (const asset of index.assets) {
    for (const rendition of asset.renditions) {
      const values = owners.get(rendition.blobSha256) ?? new Set<string>();
      values.add(asset.id);
      owners.set(rendition.blobSha256, values);
    }
  }
  const removableBlobShas = new Set<string>();
  for (const [sha256, assetIds] of owners) {
    if ([...assetIds].every((assetId) => removableIds.has(assetId))) removableBlobShas.add(sha256);
  }
  return {
    removableBlobShas,
    removableBlobPaths: index.blobs
      .filter((blob) => removableBlobShas.has(blob.sha256))
      .map((blob) => blob.relativePath)
      .sort(compareText)
  };
}

async function copyRegularFile(source: string, destination: string): Promise<void> {
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new LibraryError("config_corrupt", "A synthetic migration file is not a regular file.");
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
}

async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

/**
 * Executes an already confirmed cleanup against a temporary synthetic fixture only.
 * Production invocation is intentionally deferred to the separately authorized
 * Integration flow; this function enforces a fixture-only directory name.
 */
export async function executeConfirmedLegacyCleanupFixture(
  options: ExecuteLegacyCleanupFixtureOptions
): Promise<LibraryMigrationConfirmationResult> {
  assertSyntheticFixtureRoot(options.fixtureRoot);
  const confirmation = libraryMigrationConfirmationInputSchema.parse(options.confirmation);
  const paths = createImageLibraryStoragePaths({ root: options.fixtureRoot });
  const id = fixtureId(options.idFactory?.() ?? `legacy-cleanup-${randomUUID()}`);
  const now = options.now ?? (() => new Date());

  return await withFileLock(paths.indexLock, "routego-image-legacy-cleanup-fixture", async () => {
    const initial = await readLegacyFixtureIndex(paths.index);
    const preflight = preflightLegacyCleanup(initial.parsed);
    if (!preflight.eligible || preflight.fingerprint !== confirmation.fingerprint) {
      return migrationError(
        preflight.fingerprint,
        "blocked",
        "The legacy cleanup preflight is blocked, stale, or does not match this confirmation.",
        false
      );
    }

    const plan = filePlan(initial.parsed, preflight.removableRecordIds);
    const recoveryRelative = path.posix.join(".transactions", "legacy-cleanup", id);
    const backupIndexRelative = path.posix.join(recoveryRelative, "index.json");
    const backupByPath = new Map(
      plan.removableBlobPaths.map((relativePath) => [
        relativePath,
        path.posix.join(recoveryRelative, "blobs", createHash("sha256").update(relativePath).digest("hex"))
      ])
    );
    const journal = {
      schemaVersion: 1 as const,
      id,
      kind: "image-library-legacy-cleanup-v1",
      state: "prepared" as const,
      createdAt: now().toISOString(),
      createdPaths: [backupIndexRelative, ...backupByPath.values()],
      deleteAfterCommitPaths: plan.removableBlobPaths,
      metadata: { fingerprint: preflight.fingerprint, expectedRevision: initial.parsed.revision }
    };
    const backupIndexPath = resolveApprovedPath({ root: paths.root, candidate: backupIndexRelative, operation: "create" });
    const absoluteBlobPath = (relativePath: string, operation: "read" | "delete" | "create") =>
      resolveApprovedPath({ root: paths.root, candidate: relativePath, operation });

    await copyRegularFile(paths.index, backupIndexPath);
    for (const [relativePath, backupRelative] of backupByPath) {
      await copyRegularFile(
        absoluteBlobPath(relativePath, "read"),
        absoluteBlobPath(backupRelative, "create")
      );
    }
    await writeTransactionJournal(paths.root, journal);

    let indexPromoted = false;
    let deletedFiles = 0;
    try {
      await options.hooks?.beforeIndexPromotion?.();
      const { currentMarkRecordId: _ignoredCurrentMark, ...legacyDocument } = initial.raw;
      const next = {
        ...legacyDocument,
        schemaVersion: 2,
        revision: initial.parsed.revision + 1,
        blobs: (initial.raw["blobs"] as readonly Record<string, unknown>[]).filter(
          (blob) => !plan.removableBlobShas.has(String(blob["sha256"]))
        ),
        assets: (initial.raw["assets"] as readonly Record<string, unknown>[]).filter(
          (asset) => !preflight.removableRecordIds.includes(String(asset["id"]))
        )
      };
      await writeJsonAtomic(paths.index, next);
      indexPromoted = true;

      for (const relativePath of plan.removableBlobPaths) {
        await options.hooks?.beforeBlobDelete?.(relativePath);
        await removeIfPresent(absoluteBlobPath(relativePath, "delete"));
        deletedFiles += 1;
        await options.hooks?.afterBlobDelete?.(relativePath);
      }
      await options.hooks?.beforeVerification?.();
      const verified = parseImageLibraryIndex(JSON.parse(await readFile(paths.index, "utf8")));
      if (
        verified.assets.some((asset) => preflight.removableRecordIds.includes(asset.id)) ||
        verified.blobs.some((blob) => plan.removableBlobShas.has(blob.sha256))
      ) {
        throw new LibraryError("config_corrupt", "The synthetic migration verification did not remove every planned record.");
      }
      await markTransactionJournalCommitted(paths.root, journal);
      await rm(resolveApprovedPath({ root: paths.root, candidate: recoveryRelative, operation: "delete" }), {
        recursive: true,
        force: true
      });
      await removeTransactionJournal(paths.root, id);
      return libraryMigrationConfirmationResultSchema.parse({
        schemaVersion: 1,
        status: "succeeded",
        fingerprint: preflight.fingerprint,
        removedRecordCount: preflight.removableRecordIds.length,
        removedFileCount: deletedFiles,
        recovered: false,
        providerRequestCount: 0
      });
    } catch (error) {
      try {
        if (indexPromoted) {
          await writeJsonAtomic(
            paths.index,
            JSON.parse((await readFile(backupIndexPath, "utf8")) as string) as unknown
          );
        }
        for (const [relativePath, backupRelative] of backupByPath) {
          await copyRegularFile(
            absoluteBlobPath(backupRelative, "read"),
            absoluteBlobPath(relativePath, "create")
          );
        }
        await rm(resolveApprovedPath({ root: paths.root, candidate: recoveryRelative, operation: "delete" }), {
          recursive: true,
          force: true
        });
        await removeTransactionJournal(paths.root, id);
      } catch (recoveryError) {
        throw new LibraryError("file_write_failed", "Synthetic migration recovery failed.", { cause: recoveryError });
      }
      return migrationError(
        preflight.fingerprint,
        "failed",
        "Synthetic migration failed and the fixture was restored.",
        true
      );
    }
  });
}
