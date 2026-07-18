import { deflateSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";
import type { LibraryMutationRequest, LibraryOperationParameters } from "@routego-image/contracts";

import { LibraryAssetStore } from "../../src/gallery/assets";
import { ImageLibraryIndexStore } from "../../src/gallery/index-store";
import {
  LIBRARY_RECYCLE_RETENTION_MS,
  LibraryMutationStore
} from "../../src/gallery/mutations";
import { listTransactionJournals } from "../../src/fs/journal";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(data.byteLength + 12);
  output.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.byteLength + 8);
  return output;
}

function png(fill: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, fill, fill, fill, 0xff, fill, fill, fill, 0xff]))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function parameters(prompt: string): LibraryOperationParameters {
  return {
    kind: "generate",
    prompt,
    references: [],
    size: "1024x1024",
    aspectRatio: "1:1",
    quality: "high",
    format: "png",
    count: 1,
    partialImages: 0,
    transparentMode: "off",
    moderation: "auto",
    action: "generate",
    imageIds: [],
    fileIds: [],
    outputDirectoryMode: "default",
    saveToLibrary: true
  };
}

const execution = {
  attemptCount: 1,
  providerRequestCount: 1,
  receivedAnyOutput: true,
  mayHaveBilled: true,
  degradedContinuation: false,
  providerImageIds: []
};

async function createHarness(options: {
  readonly hooks?: ConstructorParameters<typeof LibraryMutationStore>[0]["hooks"];
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "routego-mutations-"));
  roots.push(root);
  const libraryRoot = path.join(root, "library");
  const sourceRoot = path.join(root, "source");
  await mkdir(sourceRoot, { recursive: true });
  const shared = png(0x11);
  const unique = png(0x22);
  await Promise.all([
    writeFile(path.join(sourceRoot, "one.png"), shared),
    writeFile(path.join(sourceRoot, "duplicate.png"), shared),
    writeFile(path.join(sourceRoot, "unique.png"), unique)
  ]);
  const indexStore = new ImageLibraryIndexStore({ root: libraryRoot });
  const assets = new LibraryAssetStore({ indexStore, protectedRoots: [] });
  await assets.ingestAssets(
    ["one", "duplicate", "unique"].map((name, index) => {
      const prompt = `Prompt ${name}`;
      return {
        assetId: `asset-${name}`,
        primaryArtifactId: `artifact-${name}`,
        prompt,
        model: "mutation-model",
        requestedParams: parameters(prompt),
        effectiveParams: parameters(prompt),
        execution,
        renditions: [
          {
            artifactId: `artifact-${name}`,
            phase: "final" as const,
            sourceRoot,
            sourceRelativePath: `${name}.png`
          }
        ],
        createdAt: `2026-07-18T0${index + 1}:00:00.000Z`,
        updatedAt: `2026-07-18T0${index + 1}:00:00.000Z`
      };
    })
  );
  let nowMs = Date.parse("2026-07-18T06:00:00.000Z");
  const counters = { preflight: 0, transaction: 0 };
  const mutations = new LibraryMutationStore({
    indexStore,
    now: () => new Date(nowMs),
    idFactory: (kind) => `${kind}-test-${++counters[kind]}`,
    protectedRoots: [],
    ...(options.hooks === undefined ? {} : { hooks: options.hooks })
  });
  return {
    root,
    libraryRoot,
    indexStore,
    mutations,
    advance(milliseconds: number) {
      nowMs += milliseconds;
    }
  };
}

async function execute(
  mutations: LibraryMutationStore,
  mutation: LibraryMutationRequest,
  confirmations: ("permanent-delete" | "zip-export" | "zip-import")[] = []
) {
  const preflight = await mutations.preflight({ mutation });
  const result = await mutations.execute({
    preflightId: preflight.preflightId,
    action: mutation.action,
    confirmations
  });
  return { preflight, result };
}

async function softDelete(mutations: LibraryMutationStore, assetIds: string[]) {
  return await execute(mutations, { action: "soft-delete", assetIds });
}

describe("Library recycle-bin mutations", () => {
  it("records thirty-day deletion state and restores the exact previous status", async () => {
    const { indexStore, mutations } = await createHarness();
    const { preflight, result } = await execute(mutations, {
      action: "soft-delete",
      assetIds: ["asset-one", "asset-missing"]
    });
    expect(preflight.status).toBe("partial");
    expect(result.status).toBe("partial");
    expect(result.items.map((item) => item.status)).toEqual(["succeeded", "failed"]);
    const deleted = (await indexStore.read()).assets.find((asset) => asset.id === "asset-one")!;
    expect(deleted).toMatchObject({
      status: "deleted",
      previousStatus: "succeeded",
      deletedAt: "2026-07-18T06:00:00.000Z"
    });
    expect(
      Date.parse(deleted.purgeEligibleAt!) - Date.parse(deleted.deletedAt!)
    ).toBe(LIBRARY_RECYCLE_RETENTION_MS);

    const restored = await execute(mutations, { action: "restore", assetIds: ["asset-one"] });
    expect(restored.result.status).toBe("succeeded");
    expect((await indexStore.read()).assets.find((asset) => asset.id === "asset-one")).toMatchObject({
      status: "succeeded"
    });
    const restoredRecord = (await indexStore.read()).assets.find((asset) => asset.id === "asset-one")!;
    expect(restoredRecord).not.toHaveProperty("previousStatus");
    expect(restoredRecord).not.toHaveProperty("deletedAt");
    expect(restoredRecord).not.toHaveProperty("purgeEligibleAt");
  });

  it("revalidates each target and preserves partial success after a concurrent change", async () => {
    const { indexStore, mutations, advance } = await createHarness();
    const preflight = await mutations.preflight({
      mutation: { action: "soft-delete", assetIds: ["asset-one", "asset-unique"] }
    });
    await indexStore.runExclusive(async ({ index, commit }) => {
      await commit({
        blobs: index.blobs,
        folders: index.folders,
        assets: index.assets.map((asset) =>
          asset.id === "asset-unique"
            ? { ...asset, updatedAt: "2026-07-18T06:01:00.000Z" }
            : asset
        )
      });
    });
    const result = await mutations.execute({
      preflightId: preflight.preflightId,
      action: "soft-delete"
    });
    expect(result.status).toBe("partial");
    expect(result.items).toMatchObject([
      { targetId: "asset-one", status: "succeeded" },
      { targetId: "asset-unique", status: "failed", error: { code: "conflict" } }
    ]);

    const restorePreflight = await mutations.preflight({
      mutation: { action: "restore", assetIds: ["asset-one"] }
    });
    advance(5 * 60_000 + 1);
    expect(
      await mutations.execute({
        preflightId: restorePreflight.preflightId,
        action: "restore"
      })
    ).toMatchObject({ status: "failed", error: { code: "conflict" } });
  });
});

describe("permanent deletion and file recovery", () => {
  it("retains a shared blob until the final logical asset is removed and preserves unknown files", async () => {
    const { indexStore, mutations, libraryRoot } = await createHarness();
    const initial = await indexStore.read();
    const sharedBlob = initial.blobs.find((blob) =>
      initial.assets
        .find((asset) => asset.id === "asset-one")!
        .renditions.some((rendition) => rendition.blobSha256 === blob.sha256)
    )!;
    const sharedPath = path.join(libraryRoot, ...sharedBlob.relativePath.split("/"));
    const unknownPath = path.join(path.dirname(sharedPath), "unknown-user-file.png");
    await writeFile(unknownPath, Buffer.from("unknown", "utf8"));

    await softDelete(mutations, ["asset-one"]);
    const confirmationPreflight = await mutations.preflight({
      mutation: { action: "permanent-delete", assetIds: ["asset-one"] }
    });
    await expect(
      mutations.execute({
        preflightId: confirmationPreflight.preflightId,
        action: "permanent-delete",
        confirmations: []
      })
    ).rejects.toThrow();
    const first = await execute(
      mutations,
      { action: "permanent-delete", assetIds: ["asset-one"] },
      ["permanent-delete"]
    );
    expect(first.result.status).toBe("succeeded");
    await expect(access(sharedPath)).resolves.toBeUndefined();
    expect((await indexStore.read()).blobs.some((blob) => blob.sha256 === sharedBlob.sha256)).toBe(true);

    await softDelete(mutations, ["asset-duplicate"]);
    const second = await execute(
      mutations,
      { action: "permanent-delete", assetIds: ["asset-duplicate"] },
      ["permanent-delete"]
    );
    expect(second.result.status).toBe("succeeded");
    await expect(access(sharedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(unknownPath)).resolves.toBeUndefined();
  });

  it("recovers safely before and after the index commit without deleting unknown files", async () => {
    const before = await createHarness({
      hooks: {
        afterDeleteJournalPrepared: async () => {
          throw new Error("synthetic crash before commit");
        }
      }
    });
    await softDelete(before.mutations, ["asset-unique"]);
    const beforeIndex = await before.indexStore.read();
    const beforeBlob = beforeIndex.blobs.find((blob) =>
      beforeIndex.assets
        .find((asset) => asset.id === "asset-unique")!
        .renditions.some((rendition) => rendition.blobSha256 === blob.sha256)
    )!;
    const beforePath = path.join(before.libraryRoot, ...beforeBlob.relativePath.split("/"));
    const beforePreflight = await before.mutations.preflight({
      mutation: { action: "permanent-delete", assetIds: ["asset-unique"] }
    });
    await expect(
      before.mutations.execute({
        preflightId: beforePreflight.preflightId,
        action: "permanent-delete",
        confirmations: ["permanent-delete"]
      })
    ).rejects.toThrow("synthetic crash before commit");
    expect((await before.indexStore.read()).assets.some((asset) => asset.id === "asset-unique")).toBe(true);
    const beforeRecovery = new LibraryMutationStore({
      indexStore: before.indexStore,
      protectedRoots: []
    });
    await beforeRecovery.recover();
    await expect(access(beforePath)).resolves.toBeUndefined();
    expect(await listTransactionJournals(before.libraryRoot)).toEqual([]);

    const after = await createHarness({
      hooks: {
        afterDeleteIndexCommit: async () => {
          throw new Error("synthetic crash after commit");
        }
      }
    });
    await softDelete(after.mutations, ["asset-unique"]);
    const afterIndex = await after.indexStore.read();
    const afterBlob = afterIndex.blobs.find((blob) =>
      afterIndex.assets
        .find((asset) => asset.id === "asset-unique")!
        .renditions.some((rendition) => rendition.blobSha256 === blob.sha256)
    )!;
    const afterPath = path.join(after.libraryRoot, ...afterBlob.relativePath.split("/"));
    const unknownPath = path.join(path.dirname(afterPath), "untracked-neighbor.png");
    await writeFile(unknownPath, Buffer.from("preserve", "utf8"));
    const afterPreflight = await after.mutations.preflight({
      mutation: { action: "permanent-delete", assetIds: ["asset-unique"] }
    });
    await expect(
      after.mutations.execute({
        preflightId: afterPreflight.preflightId,
        action: "permanent-delete",
        confirmations: ["permanent-delete"]
      })
    ).rejects.toThrow("synthetic crash after commit");
    expect((await after.indexStore.read()).assets.some((asset) => asset.id === "asset-unique")).toBe(false);
    await expect(access(afterPath)).resolves.toBeUndefined();
    const afterRecovery = new LibraryMutationStore({
      indexStore: after.indexStore,
      protectedRoots: []
    });
    await afterRecovery.recover();
    await expect(access(afterPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(unknownPath)).resolves.toBeUndefined();
    expect(await listTransactionJournals(after.libraryRoot)).toEqual([]);
  });

  it("blocks deletion while a surviving asset relationship still references the target", async () => {
    const { indexStore, mutations } = await createHarness();
    await indexStore.runExclusive(async ({ index, commit }) => {
      await commit({
        blobs: index.blobs,
        folders: index.folders,
        assets: index.assets.map((asset) =>
          asset.id === "asset-unique"
            ? {
                ...asset,
                relationships: [
                  {
                    id: "relationship-preserve-one",
                    role: "source",
                    relatedAssetId: "asset-one",
                    artifactId: "artifact-one",
                    order: 0
                  }
                ],
                updatedAt: "2026-07-18T06:01:00.000Z"
              }
            : asset
        )
      });
    });
    await softDelete(mutations, ["asset-one"]);
    const preflight = await mutations.preflight({
      mutation: { action: "permanent-delete", assetIds: ["asset-one"] }
    });
    expect(preflight).toMatchObject({
      status: "blocked",
      items: [{ eligible: false, error: { code: "conflict" } }]
    });
  });

  it("rejects a configured destructive root that overlaps protected legacy data", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "routego-legacy-root-"));
    roots.push(root);
    const legacyRoot = path.join(root, "legacy-library");
    const indexStore = new ImageLibraryIndexStore({ root: legacyRoot });
    expect(
      () => new LibraryMutationStore({ indexStore, protectedRoots: [legacyRoot] })
    ).toThrowError(expect.objectContaining({ code: "path_unsafe" }));
  });

  it("rejects a Library root alias that resolves into protected legacy data", async () => {
    const { root, libraryRoot } = await createHarness();
    const aliasRoot = path.join(root, "library-alias");
    await symlink(libraryRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const mutations = new LibraryMutationStore({
      indexStore: new ImageLibraryIndexStore({ root: aliasRoot }),
      protectedRoots: [libraryRoot]
    });
    await expect(
      mutations.preflight({ mutation: { action: "soft-delete", assetIds: ["asset-one"] } })
    ).rejects.toMatchObject({ code: "path_unsafe" });
  });
});
