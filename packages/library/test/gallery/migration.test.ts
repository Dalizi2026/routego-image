import { describe, expect, it } from "vitest";

import {
  parseLegacyImageLibraryIndex,
  preflightLegacyCleanup,
  type LegacyImageLibraryIndex
} from "../../src";

const createdAt = "2026-07-22T00:00:00.000Z";
const sha = (value: string): string => value.repeat(64).slice(0, 64);

function parameters(kind: "generate" | "edit"): Record<string, unknown> {
  return {
    kind,
    prompt: `${kind} fixture`,
    references: [],
    size: "1024x1024",
    aspectRatio: "1:1",
    quality: "high",
    format: "png",
    count: 1,
    partialImages: 0,
    transparentMode: "off",
    moderation: "auto",
    outputDirectoryMode: "default",
    saveToLibrary: true
  };
}

function asset(options: {
  readonly id: string;
  readonly kind: "generate" | "edit";
  readonly blobSha256: string;
  readonly status?: "succeeded" | "deleted";
  readonly relationships?: readonly Record<string, unknown>[];
}): Record<string, unknown> {
  const status = options.status ?? "succeeded";
  const params = parameters(options.kind);
  return {
    id: options.id,
    prompt: `${options.kind} ${options.id}`,
    model: "synthetic-model",
    kind: options.kind,
    status,
    ...(status === "deleted"
      ? {
          previousStatus: "succeeded",
          deletedAt: createdAt,
          purgeEligibleAt: "2026-07-23T00:00:00.000Z"
        }
      : {}),
    primaryArtifactId: `artifact-${options.id}`,
    createdAt,
    updatedAt: createdAt,
    requestedParams: params,
    effectiveParams: params,
    execution: {
      attemptCount: 1,
      providerRequestCount: 0,
      receivedAnyOutput: true,
      mayHaveBilled: false,
      degradedContinuation: false,
      providerImageIds: []
    },
    renditions: [
      {
        artifactId: `artifact-${options.id}`,
        phase: "final",
        blobSha256: options.blobSha256,
        createdAt
      }
    ],
    relationships: [
      {
        id: `output-${options.id}`,
        role: "output",
        relatedAssetId: options.id,
        artifactId: `artifact-${options.id}`,
        order: 0
      },
      ...(options.relationships ?? [])
    ],
    folderIds: []
  };
}

function legacyIndex(
  assets: readonly Record<string, unknown>[],
  blobs: readonly string[]
): LegacyImageLibraryIndex {
  return parseLegacyImageLibraryIndex({
    schemaVersion: 1,
    revision: 7,
    blobs: blobs.map((blobSha256, index) => ({
      sha256: blobSha256,
      relativePath: `blobs/2026/07/${blobSha256}.png`,
      mimeType: "image/png",
      byteLength: 12,
      width: 2,
      height: 2,
      createdAt
    })),
    assets,
    folders: []
  });
}

describe("legacy cleanup preflight", () => {
  it("projects eligible legacy removals without changing the synthetic index", () => {
    const editSha = sha("a");
    const trashSha = sha("b");
    const index = legacyIndex(
      [
        asset({ id: "asset-edit", kind: "edit", blobSha256: editSha }),
        asset({ id: "asset-trash", kind: "generate", status: "deleted", blobSha256: trashSha })
      ],
      [editSha, trashSha]
    );
    const before = structuredClone(index);

    const result = preflightLegacyCleanup(index);

    expect(result).toMatchObject({
      eligible: true,
      projectedCounts: {
        trashGenerationRecords: 1,
        editRecords: 1,
        ownedFiles: 2,
        sharedReferences: 0,
        conflicts: 0
      },
      conflicts: [],
      removableRecordIds: ["asset-edit", "asset-trash"],
      providerRequestCount: 0,
      mutatesData: false
    });
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(index).toEqual(before);
  });

  it("blocks a surviving generation that references a legacy edit", () => {
    const editSha = sha("c");
    const generationSha = sha("d");
    const index = legacyIndex(
      [
        asset({ id: "asset-edit", kind: "edit", blobSha256: editSha }),
        asset({
          id: "asset-generation",
          kind: "generate",
          blobSha256: generationSha,
          relationships: [
            {
              id: "reference-edit",
              role: "reference",
              relatedAssetId: "asset-edit",
              artifactId: "artifact-asset-edit",
              order: 1
            }
          ]
        })
      ],
      [editSha, generationSha]
    );

    const result = preflightLegacyCleanup(index);

    expect(result.eligible).toBe(false);
    expect(result.conflicts).toEqual([
      {
        dependentRecordId: "asset-generation",
        dependencyRecordId: "asset-edit",
        reason: "generation-references-edit"
      }
    ]);
    expect(result.projectedCounts).toMatchObject({ conflicts: 1, ownedFiles: 1 });
  });

  it("reports a shared file as blocked and keeps it out of projected file removal", () => {
    const sharedSha = sha("e");
    const index = legacyIndex(
      [
        asset({ id: "asset-edit", kind: "edit", blobSha256: sharedSha }),
        asset({ id: "asset-generation", kind: "generate", blobSha256: sharedSha })
      ],
      [sharedSha]
    );

    const result = preflightLegacyCleanup(index);

    expect(result.eligible).toBe(false);
    expect(result.projectedCounts).toMatchObject({
      ownedFiles: 0,
      sharedReferences: 1,
      conflicts: 1
    });
    expect(result.conflicts).toEqual([
      {
        dependentRecordId: "asset-generation",
        dependencyRecordId: "asset-edit",
        reason: "shared-file-survives"
      }
    ]);
  });

  it("binds the confirmation fingerprint to the complete legacy snapshot deterministically", () => {
    const editSha = sha("f");
    const trashSha = sha("1");
    const first = legacyIndex(
      [
        asset({ id: "asset-edit", kind: "edit", blobSha256: editSha }),
        asset({ id: "asset-trash", kind: "generate", status: "deleted", blobSha256: trashSha })
      ],
      [editSha, trashSha]
    );
    const reordered = legacyIndex(
      [
        asset({ id: "asset-trash", kind: "generate", status: "deleted", blobSha256: trashSha }),
        asset({ id: "asset-edit", kind: "edit", blobSha256: editSha })
      ],
      [trashSha, editSha]
    );
    const changed = legacyIndex(
      [
        asset({ id: "asset-edit", kind: "edit", blobSha256: editSha }),
        asset({ id: "asset-trash", kind: "generate", status: "deleted", blobSha256: trashSha })
      ],
      [editSha, trashSha]
    );
    const changedRevision = { ...changed, revision: changed.revision + 1 };

    expect(preflightLegacyCleanup(first).fingerprint).toBe(preflightLegacyCleanup(reordered).fingerprint);
    expect(preflightLegacyCleanup(first).fingerprint).not.toBe(
      preflightLegacyCleanup(changedRevision).fingerprint
    );
  });
});
