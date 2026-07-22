import { createHash } from "node:crypto";

import {
  libraryMigrationPreflightResultSchema,
  type LibraryMigrationPreflightResult
} from "@routego-image/contracts";

import type { LegacyImageLibraryIndex, LegacyStoredLibraryAsset } from "./model";

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
