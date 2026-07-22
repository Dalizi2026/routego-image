import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  executeConfirmedLegacyCleanupFixture,
  parseLegacyImageLibraryIndex,
  preflightLegacyCleanup,
  type LegacyImageLibraryIndex
} from "../../src";
import { listTransactionJournals } from "../../src/fs/journal";

const createdAt = "2026-07-22T00:00:00.000Z";
const sha = (value: string): string => value.repeat(64).slice(0, 64);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

async function createFixture(index: LegacyImageLibraryIndex): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "routego-migration-fixture-"));
  roots.push(root);
  await writeFile(path.join(root, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  for (const blob of index.blobs) {
    const destination = path.join(root, blob.relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(`synthetic-${blob.sha256}`, "utf8"));
  }
  return root;
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

  it("executes a matching confirmation only in a temporary fixture and removes only planned data", async () => {
    const editSha = sha("2");
    const trashSha = sha("3");
    const index = legacyIndex(
      [
        asset({ id: "asset-edit", kind: "edit", blobSha256: editSha }),
        asset({ id: "asset-trash", kind: "generate", status: "deleted", blobSha256: trashSha })
      ],
      [editSha, trashSha]
    );
    const root = await createFixture(index);
    const preflight = preflightLegacyCleanup(index);

    const result = await executeConfirmedLegacyCleanupFixture({
      fixtureRoot: root,
      confirmation: { fingerprint: preflight.fingerprint, confirmDestructiveMigration: true },
      idFactory: () => "fixture-success",
      now: () => new Date(createdAt)
    });

    expect(result).toMatchObject({
      status: "succeeded",
      removedRecordCount: 2,
      removedFileCount: 2,
      providerRequestCount: 0
    });
    expect(JSON.parse(await readFile(path.join(root, "index.json"), "utf8"))).toMatchObject({
      schemaVersion: 2,
      revision: 8,
      assets: [],
      blobs: []
    });
    await expect(readFile(path.join(root, "blobs", "2026", "07", `${editSha}.png`))).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(await listTransactionJournals(root)).toEqual([]);
  });

  it("rejects a stale confirmation before changing its synthetic fixture", async () => {
    const editSha = sha("4");
    const index = legacyIndex([asset({ id: "asset-edit", kind: "edit", blobSha256: editSha })], [editSha]);
    const root = await createFixture(index);
    const preflight = preflightLegacyCleanup(index);
    await writeFile(
      path.join(root, "index.json"),
      `${JSON.stringify({ ...index, revision: 8 }, null, 2)}\n`,
      "utf8"
    );

    const result = await executeConfirmedLegacyCleanupFixture({
      fixtureRoot: root,
      confirmation: { fingerprint: preflight.fingerprint, confirmDestructiveMigration: true },
      idFactory: () => "fixture-stale"
    });

    expect(result.status).toBe("blocked");
    expect(JSON.parse(await readFile(path.join(root, "index.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      revision: 8
    });
    await expect(readFile(path.join(root, "blobs", "2026", "07", `${editSha}.png`))).resolves.toBeDefined();
  });

  it("rolls back index and bytes when injected deletion fails", async () => {
    const editSha = sha("5");
    const trashSha = sha("6");
    const index = legacyIndex(
      [
        asset({ id: "asset-edit", kind: "edit", blobSha256: editSha }),
        asset({ id: "asset-trash", kind: "generate", status: "deleted", blobSha256: trashSha })
      ],
      [editSha, trashSha]
    );
    const root = await createFixture(index);
    const originalIndex = await readFile(path.join(root, "index.json"));
    const originalBlob = await readFile(path.join(root, "blobs", "2026", "07", `${editSha}.png`));
    const preflight = preflightLegacyCleanup(index);

    const result = await executeConfirmedLegacyCleanupFixture({
      fixtureRoot: root,
      confirmation: { fingerprint: preflight.fingerprint, confirmDestructiveMigration: true },
      idFactory: () => "fixture-rollback",
      hooks: {
        afterBlobDelete: async () => {
          throw new Error("synthetic injected failure");
        }
      }
    });

    expect(result).toMatchObject({ status: "failed", recovered: true, removedRecordCount: 0, removedFileCount: 0 });
    expect(await readFile(path.join(root, "index.json"))).toEqual(originalIndex);
    expect(await readFile(path.join(root, "blobs", "2026", "07", `${editSha}.png`))).toEqual(originalBlob);
    expect(await listTransactionJournals(root)).toEqual([]);
  });
});
