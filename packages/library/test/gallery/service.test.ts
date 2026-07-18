import { deflateSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";
import type { LibraryOperationParameters } from "@routego-image/contracts";

import { LibraryAssetStore } from "../../src/gallery/assets";
import { ImageLibraryIndexStore } from "../../src/gallery/index-store";
import { GalleryService } from "../../src/gallery/service";

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
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, fill, fill, fill, 0xff]))),
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

async function createService() {
  const root = await mkdtemp(path.join(os.tmpdir(), "routego-gallery-service-"));
  roots.push(root);
  const libraryRoot = path.join(root, "library");
  const sourceRoot = path.join(root, "source");
  await mkdir(sourceRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(sourceRoot, "one.png"), png(0x11)),
    writeFile(path.join(sourceRoot, "two.png"), png(0x22))
  ]);
  const indexStore = new ImageLibraryIndexStore({ root: libraryRoot });
  const assets = new LibraryAssetStore({ indexStore, protectedRoots: [] });
  const execution = {
    attemptCount: 1,
    providerRequestCount: 1,
    receivedAnyOutput: true,
    mayHaveBilled: true,
    degradedContinuation: false,
    providerImageIds: []
  };
  await assets.ingestAssets(
    ["one", "two"].map((name, index) => {
      const prompt = `Service prompt ${name}`;
      return {
        assetId: `asset-${name}`,
        primaryArtifactId: `artifact-${name}`,
        prompt,
        model: "service-model",
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
  let folderId = 0;
  const mutationIds = { preflight: 0, transaction: 0 };
  const service = new GalleryService({
    indexStore,
    readOptions: {
      now: () => new Date("2026-07-18T06:00:00.000Z"),
      folderIdFactory: () => `folder-service-${++folderId}`,
      resourceIdFactory: (rendition) => `resource-${rendition}-${folderId}`
    },
    mutationOptions: {
      now: () => new Date("2026-07-18T06:00:00.000Z"),
      idFactory: (kind) => `${kind}-service-${++mutationIds[kind]}`,
      protectedRoots: []
    }
  });
  return { service, indexStore };
}

describe("public routego_manage_library compatibility", () => {
  it("maps folder and membership operations with honest affected identifiers", async () => {
    const { service } = await createService();
    const created = await service.manageLibrary({ action: "create-folder", name: "  Picks  " });
    const folderId = created.affectedFolderIds[0]!;
    expect(created).toMatchObject({ action: "create-folder", affectedFolderIds: [folderId] });
    expect(
      await service.manageLibrary({
        action: "rename-folder",
        folderId,
        name: "Selected Picks"
      })
    ).toMatchObject({ affectedFolderIds: [folderId] });

    const assigned = await service.manageLibrary({
      action: "assign-folders",
      assetIds: ["asset-one", "asset-missing"],
      folderIds: [folderId]
    });
    expect(assigned.affectedAssetIds).toEqual(["asset-one"]);
    expect(assigned.affectedFolderIds).toEqual([folderId]);
    expect(assigned.warnings.join(" ")).toContain("asset-missing");

    const repeated = await service.manageLibrary({
      action: "assign-folders",
      assetIds: ["asset-one"],
      folderIds: [folderId]
    });
    expect(repeated.affectedAssetIds).toEqual([]);
    expect(repeated.affectedFolderIds).toEqual([]);
    expect(repeated.warnings.join(" ")).toContain("already belongs");

    const secondFolderId = (
      await service.manageLibrary({ action: "create-folder", name: "Second Picks" })
    ).affectedFolderIds[0]!;
    const partiallyNewAssignment = await service.manageLibrary({
      action: "assign-folders",
      assetIds: ["asset-one"],
      folderIds: [folderId, secondFolderId]
    });
    expect(partiallyNewAssignment.affectedAssetIds).toEqual(["asset-one"]);
    expect(partiallyNewAssignment.affectedFolderIds).toEqual([secondFolderId]);

    const removed = await service.manageLibrary({
      action: "remove-folders",
      assetIds: ["asset-one"],
      folderIds: [folderId, secondFolderId]
    });
    expect(removed).toMatchObject({
      affectedAssetIds: ["asset-one"],
      affectedFolderIds: [folderId, secondFolderId]
    });
  });

  it("maps recycle, restore, and confirmed permanent deletion without false affected IDs", async () => {
    const { service } = await createService();
    expect(
      await service.manageLibrary({ action: "soft-delete", assetIds: ["asset-one"] })
    ).toMatchObject({ affectedAssetIds: ["asset-one"] });
    expect((await service.searchLibrary({})).items.map((item) => item.id)).toEqual(["asset-two"]);
    expect(
      (await service.searchLibrary({ includeDeleted: true })).items.find(
        (item) => item.id === "asset-one"
      )?.status
    ).toBe("deleted");
    expect(
      await service.manageLibrary({ action: "restore", assetIds: ["asset-one"] })
    ).toMatchObject({ affectedAssetIds: ["asset-one"] });

    await service.manageLibrary({ action: "soft-delete", assetIds: ["asset-one"] });
    const permanent = await service.manageLibrary({
      action: "permanent-delete",
      assetIds: ["asset-one", "asset-missing"],
      confirmPermanentDelete: true
    });
    expect(permanent.affectedAssetIds).toEqual(["asset-one"]);
    expect(permanent.warnings.join(" ")).toContain("asset-missing");
    expect((await service.searchLibrary({ includeDeleted: true })).items.map((item) => item.id)).toEqual([
      "asset-two"
    ]);
  });

  it("fails closed for ZIP actions that belong to later portability tasks", async () => {
    const { service } = await createService();
    await expect(
      service.manageLibrary({
        action: "export-zip",
        assetIds: ["asset-one"],
        outputPath: "C:\\synthetic\\export.zip"
      })
    ).rejects.toMatchObject({ code: "capability_unavailable" });
    await expect(
      service.manageLibrary({ action: "import-zip", zipPath: "C:\\synthetic\\import.zip" })
    ).rejects.toMatchObject({ code: "capability_unavailable" });
  });
});

describe("Studio Library mutation service", () => {
  it("returns schema-shaped preflight and ordered partial execution outcomes", async () => {
    const { service, indexStore } = await createService();
    const preflight = await service.preflightLibraryMutation({
      mutation: { action: "soft-delete", assetIds: ["asset-one", "asset-two"] }
    });
    await indexStore.runExclusive(async ({ index, commit }) => {
      await commit({
        blobs: index.blobs,
        folders: index.folders,
        assets: index.assets.map((asset) =>
          asset.id === "asset-two"
            ? { ...asset, updatedAt: "2026-07-18T06:01:00.000Z" }
            : asset
        )
      });
    });
    const result = await service.executeLibraryMutation({
      preflightId: preflight.preflightId,
      action: "soft-delete"
    });
    expect(result).toMatchObject({
      status: "partial",
      items: [
        { targetId: "asset-one", status: "succeeded", affectedAssetId: "asset-one" },
        { targetId: "asset-two", status: "failed", error: { code: "conflict" } }
      ]
    });
  });

  it("blocks ZIP preflight/execution and rejects missing preflight reuse", async () => {
    const { service } = await createService();
    const zip = await service.preflightLibraryMutation({
      mutation: { action: "export-zip", assetIds: ["asset-one"] }
    });
    expect(zip).toMatchObject({
      status: "blocked",
      requiredConfirmations: ["zip-export"],
      items: [{ eligible: false, error: { code: "capability_unavailable" } }]
    });
    expect(
      await service.executeLibraryMutation({
        preflightId: zip.preflightId,
        action: "export-zip",
        confirmations: ["zip-export"]
      })
    ).toMatchObject({ status: "failed", error: { code: "capability_unavailable" } });
    expect(
      await service.executeLibraryMutation({
        preflightId: zip.preflightId,
        action: "export-zip",
        confirmations: ["zip-export"]
      })
    ).toMatchObject({ status: "failed", error: { code: "conflict" } });
  });
});
