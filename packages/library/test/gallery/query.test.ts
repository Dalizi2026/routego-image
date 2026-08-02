import { deflateSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";
import type { LibraryOperationParameters } from "@routego-image/contracts";

import { LibraryError } from "../../src/errors";
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
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.byteLength);
  output.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.byteLength);
  return output;
}

function validPng(fill: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(18, fill);
  rows[0] = 0;
  rows[9] = 0;
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function generateParameters(prompt: string, size: LibraryOperationParameters["size"]): LibraryOperationParameters {
  return {
    kind: "generate",
    prompt,
    references: [],
    size,
    aspectRatio: "auto",
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

const execution = {
  attemptCount: 1,
  providerRequestCount: 1,
  receivedAnyOutput: true,
  mayHaveBilled: true,
  degradedContinuation: false,
  providerImageIds: []
};

async function createGallery() {
  const root = await mkdtemp(path.join(os.tmpdir(), "routego-query-"));
  roots.push(root);
  const libraryRoot = path.join(root, "library");
  const sourceRoot = path.join(root, "source");
  await mkdir(sourceRoot, { recursive: true });
  const indexStore = new ImageLibraryIndexStore({ root: libraryRoot });
  const folderIds = ["folder-primary", "folder-edits", "folder-archive"];
  let folderIndex = 0;
  const folders = new LibraryFolderStore({
    indexStore,
    now: () => new Date("2026-07-18T01:00:00.000Z"),
    idFactory: () => folderIds[folderIndex++]!
  });
  await folders.createFolder("Primary");
  await folders.createFolder("Edits");
  await folders.createFolder("Archive");

  const files = [
    { name: "a.png", bytes: validPng(0x11) },
    { name: "b.png", bytes: validPng(0x22) },
    { name: "c.png", bytes: validPng(0x33) }
  ];
  await Promise.all(files.map((file) => writeFile(path.join(sourceRoot, file.name), file.bytes)));
  const assets = new LibraryAssetStore({ indexStore, protectedRoots: [] });
  const promptA = "Astronaut Cat";
  const promptB = "Ocean Studio";
  const promptC = "Archive Portrait";
  await assets.ingestAssets([
    {
      assetId: "asset-a",
      primaryArtifactId: "artifact-a",
      prompt: promptA,
      model: "model-one",
      providerId: "provider-a",
      requestedParams: generateParameters(promptA, "1024x1024"),
      effectiveParams: generateParameters(promptA, "1024x1024"),
      execution,
      renditions: [
        {
          artifactId: "artifact-a",
          phase: "final",
          sourceRoot,
          sourceRelativePath: "a.png"
        }
      ],
      folderIds: ["folder-primary"],
      createdAt: "2026-07-18T03:00:00.000Z",
      updatedAt: "2026-07-18T03:00:00.000Z"
    },
    {
      assetId: "asset-b",
      primaryArtifactId: "artifact-b",
      prompt: promptB,
      model: "model-two",
      providerId: "provider-b",
      status: "partial",
      requestedParams: generateParameters(promptB, "1536x1024"),
      effectiveParams: generateParameters(promptB, "1536x1024"),
      execution,
      renditions: [
        {
          artifactId: "artifact-b",
          phase: "final",
          sourceRoot,
          sourceRelativePath: "b.png"
        }
      ],
      relationships: [
        { id: "relationship-reference", role: "reference", relatedAssetId: "asset-a", artifactId: "artifact-a", order: 0 },
        { id: "relationship-output", role: "output", relatedAssetId: "asset-b", artifactId: "artifact-b", order: 1 }
      ],
      folderIds: ["folder-primary", "folder-edits"],
      createdAt: "2026-07-18T04:00:00.000Z",
      updatedAt: "2026-07-18T04:00:00.000Z"
    },
    {
      assetId: "asset-c",
      primaryArtifactId: "artifact-c",
      prompt: promptC,
      model: "model-one",
      requestedParams: generateParameters(promptC, "1024x1536"),
      effectiveParams: generateParameters(promptC, "1024x1536"),
      execution,
      renditions: [
        {
          artifactId: "artifact-c",
          phase: "final",
          sourceRoot,
          sourceRelativePath: "c.png"
        }
      ],
      folderIds: ["folder-archive"],
      createdAt: "2026-07-18T02:00:00.000Z",
      updatedAt: "2026-07-18T02:00:00.000Z"
    }
  ]);
  await indexStore.runExclusive(async ({ index, commit }) => {
    await commit({
      blobs: index.blobs,
      folders: index.folders,
      assets: index.assets.map((asset) =>
          asset.id === "asset-c"
            ? {
                ...asset,
                status: "partial",
                updatedAt: "2026-07-18T05:00:00.000Z"
            }
          : asset
      )
    });
  });
  let resourceIndex = 0;
  const service = new LibraryReadService({
    indexStore,
    folders,
    now: () => new Date("2026-07-18T06:00:00.000Z"),
    resourceIdFactory: (rendition) => `resource-${rendition}-${++resourceIndex}`
  });
  return { service, indexStore };
}

describe("Library public and Studio query projections", () => {
  it("shares every filter and deterministic keyset pagination without duplicate rows", async () => {
    const { service } = await createGallery();
    const first = await service.searchStudioLibrary({ limit: 1 });
    expect(first.items.map((item) => item.assetId)).toEqual(["asset-b"]);
    expect(first.nextCursor).toBeDefined();
    const second = await service.searchStudioLibrary({ limit: 1, cursor: first.nextCursor });
    expect(second.items.map((item) => item.assetId)).toEqual(["asset-a"]);
    expect(new Set([...first.items, ...second.items].map((item) => item.assetId)).size).toBe(2);

    const all = await service.searchStudioLibrary({ limit: 10 });
    expect(all.items.map((item) => item.assetId)).toEqual(["asset-b", "asset-a", "asset-c"]);
    expect(all.total).toBe(3);
    const filters = await Promise.all([
      service.searchStudioLibrary({ query: "ASTRONAUT" }),
      service.searchStudioLibrary({ models: ["model-two"] }),
      service.searchStudioLibrary({ providerIds: ["provider-a"] }),
      service.searchStudioLibrary({ from: "2026-07-18T03:30:00.000Z" }),
      service.searchStudioLibrary({ to: "2026-07-18T03:30:00.000Z" }),
      service.searchStudioLibrary({ kinds: ["generate"] }),
      service.searchStudioLibrary({ sizes: ["1536x1024"] }),
      service.searchStudioLibrary({ statuses: ["partial"] }),
      service.searchStudioLibrary({ folderIds: ["folder-edits"] }),
      service.searchStudioLibrary({ sort: "prompt-asc" }),
      service.searchStudioLibrary({ sort: "prompt-desc" }),
      service.searchStudioLibrary({ sort: "created-asc" })
    ]);
    expect(filters.map((result) => result.items.map((item) => item.assetId))).toEqual([
      ["asset-a"],
      ["asset-b"],
      ["asset-a"],
      ["asset-b"],
      ["asset-a", "asset-c"],
      ["asset-b", "asset-a", "asset-c"],
      ["asset-b"],
      ["asset-b", "asset-c"],
      ["asset-b"],
      ["asset-c", "asset-a", "asset-b"],
      ["asset-b", "asset-a", "asset-c"],
      ["asset-c", "asset-a", "asset-b"]
    ]);

    const publicPage = await service.searchLibrary({ limit: 1 });
    expect(publicPage.items[0]?.id).toBe(first.items[0]?.assetId);
    expect(publicPage.nextCursor).toBe(first.nextCursor);
    expect(path.isAbsolute(publicPage.items[0]!.path)).toBe(true);
    const studioJson = JSON.stringify(all);
    expect(studioJson).not.toContain('"path"');
    expect(studioJson).not.toMatch(/(?:[A-Za-z]:\\|\/Users\/|data:image|base64)/u);
  });

  it("rejects malformed, non-canonical, and sort-mismatched cursors", async () => {
    const { service } = await createGallery();
    await expect(service.searchLibrary({ cursor: "%%%" })).rejects.toMatchObject({
      code: "invalid_request"
    } satisfies Partial<LibraryError>);
    const mismatched = Buffer.from(
      JSON.stringify({
        version: 1,
        sort: "created-desc",
        key: String(Date.parse("2026-07-18T04:00:00.000Z")).padStart(16, "0"),
        assetId: "asset-b"
      }),
      "utf8"
    ).toString("base64url");
    await expect(
      service.searchStudioLibrary({ sort: "prompt-asc", cursor: mismatched })
    ).rejects.toMatchObject({ code: "invalid_request" } satisfies Partial<LibraryError>);
  });

  it("rejects stale Trash search filters without changing the index", async () => {
    const { service, indexStore } = await createGallery();
    const before = await indexStore.read();

    await expect(service.searchStudioLibrary({ includeDeleted: true })).rejects.toMatchObject({
      code: "invalid_request"
    } satisfies Partial<LibraryError>);
    await expect(service.searchLibrary({ statuses: ["deleted"] })).rejects.toMatchObject({
      code: "invalid_request"
    } satisfies Partial<LibraryError>);

    expect(await indexStore.read()).toEqual(before);
  });

  it("keeps prompt-sort cursors bounded while sorting the complete long prompt", async () => {
    const { service, indexStore } = await createGallery();
    const longPrompt = `A${"x".repeat(31_900)}`;
    await indexStore.runExclusive(async ({ index, commit }) => {
      await commit({
        blobs: index.blobs,
        folders: index.folders,
        assets: index.assets.map((asset) =>
          asset.id === "asset-a"
            ? {
                ...asset,
                prompt: longPrompt,
                requestedParams: { ...asset.requestedParams, prompt: longPrompt },
                effectiveParams: { ...asset.effectiveParams, prompt: longPrompt }
              }
            : asset
        )
      });
    });
    const first = await service.searchStudioLibrary({ sort: "prompt-asc", limit: 1 });
    expect(first.items[0]?.assetId).toBe("asset-c");
    expect(first.nextCursor?.length).toBeLessThan(2_000);
    const second = await service.searchStudioLibrary({
      sort: "prompt-asc",
      limit: 1,
      cursor: first.nextCursor
    });
    expect(second.items[0]?.assetId).toBe("asset-a");
  });

  it("aligns search, complete detail relationships, allowed actions, and resources", async () => {
    const { service } = await createGallery();
    const search = await service.searchStudioLibrary({ query: "ocean" });
    const item = search.items[0]!;
    const detail = await service.getAssetDetail({ assetId: item.assetId });
    const resource = await service.getBrowserResource({
      assetId: item.assetId,
      artifactId: item.artifactId,
      rendition: "preview"
    });
    expect(detail.status).toBe("succeeded");
    expect(detail.asset?.renditions[0]?.artifactId).toBe(item.artifactId);
    expect(detail.asset?.relationships.map((relationship) => relationship.role)).toEqual([
      "reference",
      "output"
    ]);
    expect(detail.asset?.folders.map((folder) => folder.folderId)).toEqual([
      "folder-primary",
      "folder-edits"
    ]);
    expect(detail.asset?.allowedActions).toEqual([
      "assign-folders",
      "remove-folders",
      "copy-generation-info",
      "export-zip",
      "download"
    ]);
    expect(resource).toMatchObject({
      status: "succeeded",
      resource: {
        mimeType: "image/png",
        width: 2,
        height: 2,
        requiresSession: true
      }
    });
    expect(resource.resource?.relativeUrl).toMatch(/^\/api\/v1\/library\/resources\//u);
    expect(JSON.stringify(resource)).not.toContain("libraryRoot");
    expect(await service.getAssetDetail({ assetId: "asset-missing" })).toMatchObject({
      status: "failed",
      error: { code: "not_found" }
    });
  });

  it("removes stored paths, details, and partial artifacts from Studio detail errors", async () => {
    const { service, indexStore } = await createGallery();
    await indexStore.runExclusive(async ({ index, commit }) => {
      await commit({
        blobs: index.blobs,
        folders: index.folders,
        assets: index.assets.map((asset) =>
          asset.id === "asset-a"
            ? {
                ...asset,
                status: "failed",
                error: {
                  code: "file_write_failed",
                  category: "persistence",
                  stage: "persist",
                  safeMessage: "Failed at C:\\Users\\Example\\secret.png with Bearer hidden-token",
                  retryDisposition: "never",
                  partialArtifacts: [],
                  receivedAnyOutput: false,
                  mayHaveBilled: false,
                  details: { path: "C:\\Users\\Example\\secret.png" }
                }
              }
            : asset
        )
      });
    });
    const detail = await service.getAssetDetail({ assetId: "asset-a" });
    expect(detail.asset?.error?.safeMessage).toBe(
      "The stored image operation did not complete successfully."
    );
    expect(detail.asset?.error).not.toHaveProperty("details");
    expect(JSON.stringify(detail)).not.toMatch(/(?:C:\\Users|hidden-token|secret\.png)/u);
  });
});
