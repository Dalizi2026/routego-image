import { deflateSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";
import type { LibraryOperationParameters } from "@routego-image/contracts";

import { LibraryAssetStore } from "../../src/gallery/assets";
import { LibraryFolderStore } from "../../src/gallery/folders";
import { ImageLibraryIndexStore } from "../../src/gallery/index-store";
import { LibraryReadService } from "../../src/gallery/read-service";

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
    quality: "medium",
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

async function createHarness() {
  const root = await mkdtemp(path.join(os.tmpdir(), "routego-folders-"));
  roots.push(root);
  const libraryRoot = path.join(root, "library");
  const sourceRoot = path.join(root, "source");
  await mkdir(sourceRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(sourceRoot, "one.png"), png(0x11)),
    writeFile(path.join(sourceRoot, "two.png"), png(0x22))
  ]);
  const indexStore = new ImageLibraryIndexStore({ root: libraryRoot });
  const ids = ["folder-art", "folder-work", "folder-archive", "folder-race-one", "folder-race-two"];
  let idIndex = 0;
  let minute = 0;
  const now = () => new Date(Date.parse("2026-07-18T01:00:00.000Z") + minute++ * 60_000);
  const folders = new LibraryFolderStore({
    indexStore,
    now,
    idFactory: () => ids[idIndex++]!
  });
  const assets = new LibraryAssetStore({ indexStore, now, protectedRoots: [] });
  const execution = {
    attemptCount: 1,
    providerRequestCount: 1,
    receivedAnyOutput: true,
    mayHaveBilled: true,
    degradedContinuation: false,
    providerImageIds: []
  };
  await assets.ingestAssets(
    ["one", "two"].map((name) => ({
      assetId: `asset-${name}`,
      primaryArtifactId: `artifact-${name}`,
      prompt: `Prompt ${name}`,
      model: "folder-test-model",
      requestedParams: parameters(`Prompt ${name}`),
      effectiveParams: parameters(`Prompt ${name}`),
      execution,
      renditions: [
        {
          artifactId: `artifact-${name}`,
          phase: "final" as const,
          sourceRoot,
          sourceRelativePath: `${name}.png`
        }
      ]
    }))
  );
  const service = new LibraryReadService({ indexStore, folders });
  return { indexStore, folders, service };
}

describe("Library folder persistence", () => {
  it("normalizes active names and rejects Unicode/case/space collisions", async () => {
    const { service } = await createHarness();
    const created = await service.createFolder("  Ａrt   Picks  ");
    expect(created.name).toBe("Art Picks");
    await expect(service.createFolder("art picks")).rejects.toMatchObject({ code: "conflict" });
    const work = await service.createFolder("Work");
    await expect(service.renameFolder(work.id, " ART PICKS ")).rejects.toMatchObject({
      code: "conflict"
    });
    expect((await service.renameFolder(work.id, "Client Work")).name).toBe("Client Work");
    expect((await service.listFolders({})).folders.map((folder) => folder.name)).toEqual([
      "Art Picks",
      "Client Work"
    ]);
  });

  it("requires complete-set reorder and preserves the prior order on conflict", async () => {
    const { service } = await createHarness();
    const art = await service.createFolder("Art");
    const work = await service.createFolder("Work");
    const archive = await service.createFolder("Archive");
    const failed = await service.reorderFolders({ folderIds: [work.id, art.id] });
    expect(failed).toMatchObject({ status: "failed", error: { code: "conflict" } });
    expect((await service.listFolders({})).folders.map((folder) => folder.id)).toEqual([
      art.id,
      work.id,
      archive.id
    ]);
    const reordered = await service.reorderFolders({
      folderIds: [archive.id, art.id, work.id]
    });
    expect(reordered.status).toBe("succeeded");
    expect(reordered.folders.map((folder) => folder.id)).toEqual([
      archive.id,
      art.id,
      work.id
    ]);
    expect(reordered.folders.map((folder) => folder.order)).toEqual([0, 1, 2]);
  });

  it("uses one injected monotonic clock for asset creation and folder mutation", async () => {
    const { indexStore, service } = await createHarness();
    const initial = await indexStore.read();
    expect(
      initial.assets.map((asset) => ({
        id: asset.id,
        createdAt: asset.createdAt,
        updatedAt: asset.updatedAt
      }))
    ).toEqual([
      {
        id: "asset-one",
        createdAt: "2026-07-18T01:00:00.000Z",
        updatedAt: "2026-07-18T01:00:00.000Z"
      },
      {
        id: "asset-two",
        createdAt: "2026-07-18T01:01:00.000Z",
        updatedAt: "2026-07-18T01:01:00.000Z"
      }
    ]);

    const folder = await service.createFolder("Clock evidence");
    await service.assignFolders(["asset-one"], [folder.id]);
    const updated = (await indexStore.read()).assets.find((asset) => asset.id === "asset-one")!;
    expect(updated.updatedAt).toBe("2026-07-18T01:03:00.000Z");
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(updated.createdAt));
  });

  it("persists many-to-many assignment/removal and reports only real changes", async () => {
    const { service } = await createHarness();
    const art = await service.createFolder("Art");
    const work = await service.createFolder("Work");
    const assigned = await service.assignFolders(
      ["asset-one", "asset-two", "asset-one"],
      [work.id, art.id]
    );
    expect(assigned).toEqual({
      affectedAssetIds: ["asset-one", "asset-two"],
      affectedFolderIds: [work.id, art.id]
    });
    expect((await service.listFolders({})).folders.map((folder) => folder.assetCount)).toEqual([2, 2]);
    expect(await service.assignFolders(["asset-one"], [art.id])).toEqual({
      affectedAssetIds: [],
      affectedFolderIds: []
    });
    expect(await service.removeFolders(["asset-one"], [work.id])).toEqual({
      affectedAssetIds: ["asset-one"],
      affectedFolderIds: [work.id]
    });
    const detail = await service.getAssetDetail({ assetId: "asset-one" });
    expect(detail.asset?.folders.map((folder) => folder.folderId)).toEqual([art.id]);
  });

  it("serializes concurrent normalized-name creation through the index lock", async () => {
    const { service } = await createHarness();
    const results = await Promise.allSettled([
      service.createFolder("Race Folder"),
      service.createFolder("race   folder")
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await service.listFolders({})).folders).toHaveLength(1);
  });
});
