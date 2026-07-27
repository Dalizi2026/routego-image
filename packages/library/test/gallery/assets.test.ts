import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { writeTransactionJournal } from "../../src/fs/journal";
import { LibraryAssetStore, type IngestLibraryAssetInput } from "../../src/gallery/assets";
import {
  IMAGE_LIBRARY_BLOB_TRANSACTION_KIND,
  ImageLibraryIndexStore
} from "../../src/gallery/index-store";
import { LibraryResourceResolver } from "../../src/gallery/resolver";
import { UploadStore } from "../../src/upload/store";
import { chunked, syntheticPng } from "../upload/fixtures";

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

function validPng(width = 3, height = 2, fill = 0x44): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (1 + width * 4), fill);
  for (let row = 0; row < height; row += 1) rows[row * (1 + width * 4)] = 0;
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function validJpeg(width = 4, height = 3): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x12, 0x34, 0xff, 0x00, 0x56,
    0xff, 0xd9
  ]);
}

function validWebp(width = 5, height = 4): Buffer {
  const payload = Buffer.alloc(6);
  payload[0] = 0x2f;
  const encodedWidth = width - 1;
  const encodedHeight = height - 1;
  payload[1] = encodedWidth & 0xff;
  payload[2] = ((encodedWidth >>> 8) & 0x3f) | ((encodedHeight & 0x03) << 6);
  payload[3] = (encodedHeight >>> 2) & 0xff;
  payload[4] = (encodedHeight >>> 10) & 0x0f;
  payload[5] = 0;
  const bytes = Buffer.alloc(26);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(18, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8L", 12, "ascii");
  bytes.writeUInt32LE(payload.byteLength, 16);
  payload.copy(bytes, 20);
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function operationParameters(prompt: string, format: "png" | "jpeg" | "webp" = "png") {
  return {
    kind: "generate" as const,
    prompt,
    references: [],
    size: "auto" as const,
    aspectRatio: "auto" as const,
    quality: "auto" as const,
    format,
    count: 1,
    partialImages: 0,
    transparentMode: "off" as const,
    moderation: "auto" as const,
    action: "generate" as const,
    imageIds: [],
    fileIds: [],
    outputDirectoryMode: "default" as const,
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
  readonly hooks?: ConstructorParameters<typeof ImageLibraryIndexStore>[0]["hooks"];
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "routego-gallery-"));
  roots.push(root);
  const home = path.join(root, "home");
  const libraryRoot = path.join(root, "library");
  const sourceRoot = path.join(root, "source");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(sourceRoot, { recursive: true })]);
  const counters = { asset: 0, artifact: 0, transaction: 0 };
  const indexStore = new ImageLibraryIndexStore({
    root: libraryRoot,
    homeDirectory: home,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks })
  });
  const assets = new LibraryAssetStore({
    indexStore,
    homeDirectory: home,
    now: () => new Date("2026-07-18T03:04:05.000Z"),
    idFactory: (kind) => `${kind}-synthetic-${++counters[kind]}`
  });
  return { root, home, libraryRoot, sourceRoot, indexStore, assets };
}

async function writeSource(sourceRoot: string, name: string, bytes: Uint8Array): Promise<void> {
  await writeFile(path.join(sourceRoot, name), bytes);
}

async function ingest(
  assets: LibraryAssetStore,
  sourceRoot: string,
  name: string,
  bytes: Uint8Array,
  overrides: Partial<IngestLibraryAssetInput> = {}
) {
  await writeSource(sourceRoot, name, bytes);
  const prompt = overrides.prompt ?? `Prompt for ${name}`;
  const format = name.endsWith(".jpg") ? "jpeg" : name.endsWith(".webp") ? "webp" : "png";
  const params = operationParameters(prompt, format);
  return await assets.ingestAsset({
    prompt,
    model: "synthetic-image-model",
    requestedParams: params,
    effectiveParams: params,
    execution,
    renditions: [
      {
        phase: "final",
        sourceRoot,
        sourceRelativePath: name,
        requestedBaseName: overrides.renditions?.[0]?.requestedBaseName ?? "generated"
      }
    ],
    ...overrides
  });
}

describe("versioned Image Library index", () => {
  it("initializes only a missing index and preserves corrupt or future documents", async () => {
    const missing = await createHarness();
    expect(await missing.indexStore.read()).toEqual({
      schemaVersion: 2,
      revision: 0,
      blobs: [],
      assets: [],
      folders: []
    });

    const corruptText = "{not-json";
    await writeFile(missing.indexStore.paths.index, corruptText, "utf8");
    await expect(missing.indexStore.read()).rejects.toMatchObject({ code: "config_corrupt" });
    expect(await readFile(missing.indexStore.paths.index, "utf8")).toBe(corruptText);

    const future = await createHarness();
    await mkdir(path.dirname(future.indexStore.paths.index), { recursive: true });
    await writeFile(
      future.indexStore.paths.index,
      JSON.stringify({ schemaVersion: 3, revision: 0, blobs: [], assets: [], folders: [] }),
      "utf8"
    );
    await expect(future.indexStore.read()).rejects.toMatchObject({ code: "unsupported_version" });
  });
});

describe("validated asset ingestion and deduplication", () => {
  it("ingests complete PNG, JPEG, and WebP files and rejects truncation or claim mismatch", async () => {
    const { assets, sourceRoot, indexStore } = await createHarness();
    const cases = [
      ["first.png", validPng(3, 2), "image/png", 3, 2],
      ["second.jpg", validJpeg(4, 3), "image/jpeg", 4, 3],
      ["third.webp", validWebp(5, 4), "image/webp", 5, 4]
    ] as const;
    for (const [name, bytes, mimeType, width, height] of cases) {
      const result = await ingest(assets, sourceRoot, name, bytes);
      expect(result.blobs[0]).toMatchObject({ mimeType, width, height, sha256: sha256(bytes) });
      expect(await readFile(path.join(indexStore.paths.root, result.blobs[0]!.relativePath))).toEqual(bytes);
    }

    const truncated = validPng().subarray(0, 40);
    await writeSource(sourceRoot, "truncated.png", truncated);
    await expect(
      assets.ingestAsset({
        prompt: "Truncated",
        model: "synthetic-image-model",
        requestedParams: operationParameters("Truncated"),
        effectiveParams: operationParameters("Truncated"),
        execution,
        renditions: [{ phase: "final", sourceRoot, sourceRelativePath: "truncated.png" }]
      })
    ).rejects.toMatchObject({ code: "upload_invalid_type" });

    const invalidCompressedPng = Buffer.concat([
      validPng().subarray(0, 33),
      pngChunk("IDAT", Buffer.from("not-a-zlib-stream", "utf8")),
      pngChunk("IEND", Buffer.alloc(0))
    ]);
    await writeSource(sourceRoot, "invalid-compressed.png", invalidCompressedPng);
    await expect(
      assets.ingestAsset({
        prompt: "Invalid compressed PNG",
        model: "synthetic-image-model",
        requestedParams: operationParameters("Invalid compressed PNG"),
        effectiveParams: operationParameters("Invalid compressed PNG"),
        execution,
        renditions: [
          { phase: "final", sourceRoot, sourceRelativePath: "invalid-compressed.png" }
        ]
      })
    ).rejects.toMatchObject({ code: "upload_invalid_type" });

    await writeSource(sourceRoot, "mismatch.png", validPng(7, 8));
    await expect(
      assets.ingestAsset({
        prompt: "Mismatch",
        model: "synthetic-image-model",
        requestedParams: operationParameters("Mismatch"),
        effectiveParams: operationParameters("Mismatch"),
        execution,
        renditions: [
          {
            phase: "final",
            sourceRoot,
            sourceRelativePath: "mismatch.png",
            expected: { width: 999 }
          }
        ]
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect((await indexStore.read()).assets).toHaveLength(3);
  });

  it("persists a validated JPEG provider output even when the requested format was PNG", async () => {
    const { assets, sourceRoot, indexStore } = await createHarness();
    const bytes = validJpeg(7, 5);
    await writeSource(sourceRoot, "provider-output.jpg", bytes);
    const params = operationParameters("Provider returned JPEG", "png");

    const result = await assets.ingestAsset({
      prompt: "Provider returned JPEG",
      model: "synthetic-image-model",
      requestedParams: params,
      effectiveParams: params,
      execution,
      renditions: [{
        phase: "final",
        sourceRoot,
        sourceRelativePath: "provider-output.jpg",
        requestedBaseName: "provider-output",
        expected: {
          mimeType: "image/jpeg",
          byteLength: bytes.byteLength,
          sha256: sha256(bytes),
          width: 7,
          height: 5
        }
      }]
    });

    expect(result.blobs[0]).toMatchObject({ mimeType: "image/jpeg", width: 7, height: 5 });
    expect(result.blobs[0]!.relativePath).toMatch(/provider-output\.jpg$/u);
    expect((await indexStore.read()).assets).toHaveLength(1);
  });

  it("rejects stale edit-record ingestion before publishing a blob or mutating the index", async () => {
    const { assets, sourceRoot, indexStore } = await createHarness();
    await writeSource(sourceRoot, "legacy-edit.png", validPng());
    const params = operationParameters("Legacy edit");
    const staleEdit = { ...params, kind: "edit" } as unknown as typeof params;

    await expect(
      assets.ingestAsset({
        prompt: "Legacy edit",
        model: "synthetic-image-model",
        requestedParams: staleEdit,
        effectiveParams: staleEdit,
        execution,
        renditions: [{ phase: "final", sourceRoot, sourceRelativePath: "legacy-edit.png" }]
      })
    ).rejects.toBeDefined();
    expect(await indexStore.read()).toEqual({
      schemaVersion: 2,
      revision: 0,
      blobs: [],
      assets: [],
      folders: []
    });
  });

  it("keeps distinct logical histories while sharing one SHA-256 blob", async () => {
    const { assets, sourceRoot, indexStore } = await createHarness();
    const bytes = validPng(9, 6);
    const first = await ingest(assets, sourceRoot, "one.png", bytes, { prompt: "First history" });
    const second = await ingest(assets, sourceRoot, "two.png", bytes, { prompt: "Second history" });
    const index = await indexStore.read();
    expect(index.assets).toHaveLength(2);
    expect(index.blobs).toHaveLength(1);
    expect(first.asset.id).not.toBe(second.asset.id);
    expect(first.asset.renditions[0]!.blobSha256).toBe(second.asset.renditions[0]!.blobSha256);
    expect(second.deduplicatedBlobCount).toBe(1);
  });

  it("commits a batch with cross-asset artifact relationships in one index revision", async () => {
    const { assets, sourceRoot, indexStore } = await createHarness();
    await Promise.all([
      writeSource(sourceRoot, "batch-a.png", validPng(4, 4, 0x31)),
      writeSource(sourceRoot, "batch-b.png", validPng(5, 5, 0x32))
    ]);
    const firstPrompt = "Batch first";
    const secondPrompt = "Batch second";
    const results = await assets.ingestAssets([
      {
        assetId: "asset-batch-a",
        prompt: firstPrompt,
        model: "synthetic-image-model",
        requestedParams: operationParameters(firstPrompt),
        effectiveParams: operationParameters(firstPrompt),
        execution,
        renditions: [
          {
            artifactId: "artifact-batch-a",
            phase: "final",
            sourceRoot,
            sourceRelativePath: "batch-a.png"
          }
        ],
        relationships: [
          {
            id: "relationship-a-to-b",
            role: "reference",
            relatedAssetId: "asset-batch-b",
            artifactId: "artifact-batch-b",
            order: 0
          }
        ]
      },
      {
        assetId: "asset-batch-b",
        prompt: secondPrompt,
        model: "synthetic-image-model",
        requestedParams: operationParameters(secondPrompt),
        effectiveParams: operationParameters(secondPrompt),
        execution,
        renditions: [
          {
            artifactId: "artifact-batch-b",
            phase: "final",
            sourceRoot,
            sourceRelativePath: "batch-b.png"
          }
        ],
        relationships: [
          {
            id: "relationship-b-to-a",
            role: "source",
            relatedAssetId: "asset-batch-a",
            artifactId: "artifact-batch-a",
            order: 0
          }
        ]
      }
    ]);
    expect(results.map((result) => result.asset.id)).toEqual(["asset-batch-a", "asset-batch-b"]);
    const index = await indexStore.read();
    expect(index).toMatchObject({ revision: 1 });
    expect(index.assets).toHaveLength(2);
    expect(index.assets[0]!.relationships[0]).toMatchObject({ relatedAssetId: "asset-batch-b" });
  });

  it("serializes concurrent ingests and publishes colliding names without overwrite", async () => {
    const { assets, sourceRoot, indexStore } = await createHarness();
    await Promise.all([
      writeSource(sourceRoot, "left.png", validPng(2, 2, 0x11)),
      writeSource(sourceRoot, "right.png", validPng(3, 3, 0x22))
    ]);
    await Promise.all([
      ingest(assets, sourceRoot, "left.png", validPng(2, 2, 0x11), {
        renditions: [
          { phase: "final", sourceRoot, sourceRelativePath: "left.png", requestedBaseName: "collision" }
        ]
      }),
      ingest(assets, sourceRoot, "right.png", validPng(3, 3, 0x22), {
        renditions: [
          { phase: "final", sourceRoot, sourceRelativePath: "right.png", requestedBaseName: "collision" }
        ]
      })
    ]);
    const paths = (await indexStore.read()).blobs.map((blob) => path.basename(blob.relativePath)).sort();
    expect(paths).toEqual(["collision-2.png", "collision.png"]);
  });

  it("versions project copies and rejects traversal or protected legacy destinations", async () => {
    const { assets, sourceRoot, home } = await createHarness();
    const result = await ingest(assets, sourceRoot, "copy.png", validPng());
    const project = path.join(path.dirname(home), "project");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "kept.png"), "do-not-overwrite", "utf8");
    const copied = await assets.copyArtifactToProject({
      assetId: result.asset.id,
      projectRoot: project,
      requestedBaseName: "kept"
    });
    expect(copied.fileName).toBe("kept-2.png");
    expect(await readFile(path.join(project, "kept.png"), "utf8")).toBe("do-not-overwrite");
    await expect(
      assets.copyArtifactToProject({
        assetId: result.asset.id,
        projectRoot: project,
        relativeDirectory: "../escape"
      })
    ).rejects.toMatchObject({ code: "path_unsafe" });
    await expect(
      assets.copyArtifactToProject({
        assetId: result.asset.id,
        projectRoot: path.join(home, "Pictures", "routego-image")
      })
    ).rejects.toMatchObject({ code: "path_unsafe" });
  });
});

describe("transaction recovery and stable resource resolution", () => {
  it("removes journal-owned uncommitted hard links after a crash before index commit", async () => {
    let shouldCrash = true;
    const harness = await createHarness({
      hooks: {
        beforeIndexCommit: async () => {
          if (shouldCrash) {
            shouldCrash = false;
            throw new Error("synthetic crash before commit");
          }
        }
      }
    });
    await expect(
      ingest(harness.assets, harness.sourceRoot, "before.png", validPng())
    ).rejects.toThrow("synthetic crash before commit");
    const recovered = await harness.indexStore.read();
    expect(recovered.assets).toEqual([]);
    expect(recovered.blobs).toEqual([]);
    expect(await readdir(harness.indexStore.paths.transactions)).toEqual(["files"]);
    expect(await readdir(harness.indexStore.paths.transactionFiles)).toEqual([]);
    const monthDirectory = path.join(harness.indexStore.paths.blobs, "2026", "07");
    expect(await readdir(monthDirectory)).toEqual([]);
  });

  it("retains the referenced final file and cleans the temp link after a crash after commit", async () => {
    let shouldCrash = true;
    const harness = await createHarness({
      hooks: {
        afterIndexCommit: async () => {
          if (shouldCrash) {
            shouldCrash = false;
            throw new Error("synthetic crash after commit");
          }
        }
      }
    });
    await expect(
      ingest(harness.assets, harness.sourceRoot, "after.png", validPng(8, 5))
    ).rejects.toThrow("synthetic crash after commit");
    const replacement = new ImageLibraryIndexStore({
      root: harness.libraryRoot,
      homeDirectory: harness.home
    });
    const recovered = await replacement.read();
    expect(recovered.assets).toHaveLength(1);
    expect(await readFile(path.join(replacement.paths.root, recovered.blobs[0]!.relativePath))).toEqual(
      validPng(8, 5)
    );
    expect(await readdir(replacement.paths.transactions)).toEqual(["files"]);
    expect(await readdir(replacement.paths.transactionFiles)).toEqual([]);
  });

  it("never deletes an unreferenced final path when journal ownership cannot be proven", async () => {
    const harness = await createHarness();
    await harness.indexStore.read();
    const transactionId = "transaction-foreign-file";
    const tempRelative = `.transactions/files/${transactionId}.tmp`;
    const finalRelative = "blobs/2026/07/foreign.png";
    const tempPath = path.join(harness.libraryRoot, tempRelative);
    const finalPath = path.join(harness.libraryRoot, finalRelative);
    await mkdir(path.dirname(finalPath), { recursive: true });
    await writeFile(tempPath, validPng(2, 2));
    await writeFile(finalPath, validPng(3, 3));
    await writeTransactionJournal(harness.libraryRoot, {
      schemaVersion: 1,
      id: transactionId,
      kind: IMAGE_LIBRARY_BLOB_TRANSACTION_KIND,
      state: "prepared",
      createdAt: "2026-07-18T03:04:05.000Z",
      createdPaths: [tempRelative, finalRelative],
      deleteAfterCommitPaths: [],
      metadata: {
        tempPath: tempRelative,
        finalPath: finalRelative,
        expectedRevision: 1,
        sha256: sha256(validPng(2, 2))
      }
    });
    await harness.indexStore.recover();
    expect(await readFile(finalPath)).toEqual(validPng(3, 3));
    await expect(readFile(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves asset, artifact, and reusable upload locators without provider execution", async () => {
    const harness = await createHarness();
    const ingested = await ingest(harness.assets, harness.sourceRoot, "resolve.png", validPng(), {
      assetId: "asset-stable",
      renditions: [
        {
          artifactId: "artifact-stable",
          phase: "final",
          sourceRoot: harness.sourceRoot,
          sourceRelativePath: "resolve.png"
        }
      ]
    });
    const uploads = new UploadStore({
      dataRoot: path.join(harness.root, "data"),
      homeDirectory: harness.home,
      idFactory: () => "upload-stable"
    });
    const uploadBytes = syntheticPng(3, 2);
    const reserved = await uploads.reserveUploadResource({
      purpose: "reference",
      declaredMimeType: "image/png",
      declaredByteLength: uploadBytes.byteLength,
      expectedSha256: sha256(uploadBytes)
    });
    if (reserved.status !== "succeeded" || !reserved.resource) throw new Error("reserve failed");
    await uploads.stageUpload(reserved.resource.uploadResourceId, chunked(uploadBytes));
    expect(
      await uploads.finalizeUploadResource({ uploadResourceId: reserved.resource.uploadResourceId })
    ).toMatchObject({ status: "succeeded" });

    const resolver = new LibraryResourceResolver({ assets: harness.assets, uploads });
    const byAsset = await resolver.resolve({ source: "asset", assetId: ingested.asset.id });
    const byArtifact = await resolver.resolve({ source: "artifact", artifactId: "artifact-stable" });
    const byUpload = await resolver.resolve(
      { source: "upload", uploadResourceId: "upload-stable" },
      ["reference"]
    );
    expect(byAsset).toMatchObject({ source: "asset", artifactId: "artifact-stable" });
    expect(byArtifact).toMatchObject({ source: "artifact", assetId: "asset-stable" });
    expect(byUpload).toMatchObject({ source: "upload", purpose: "reference" });
    await expect(
      resolver.resolve({ source: "upload", uploadResourceId: "upload-stable" }, ["mask"])
    ).rejects.toMatchObject({ code: "upload_invalid_type" });
  });

  it("rejects traversal, protected legacy sources, and later blob tampering", async () => {
    const harness = await createHarness();
    await writeSource(harness.sourceRoot, "safe.png", validPng());
    await expect(
      harness.assets.validateSource(harness.sourceRoot, "../safe.png")
    ).rejects.toMatchObject({ code: "path_unsafe" });

    const legacyRoot = path.join(harness.home, "Pictures", "routego-image");
    await mkdir(legacyRoot, { recursive: true });
    await writeFile(path.join(legacyRoot, "legacy.png"), validPng());
    await expect(
      harness.assets.validateSource(legacyRoot, "legacy.png")
    ).rejects.toMatchObject({ code: "path_unsafe" });

    const ingested = await ingest(harness.assets, harness.sourceRoot, "tamper.png", validPng(6, 6));
    await writeFile(ingested.blobs[0]!.relativePath.startsWith("blobs/")
      ? path.join(harness.libraryRoot, ingested.blobs[0]!.relativePath)
      : ingested.blobs[0]!.relativePath, validPng(7, 7));
    await expect(harness.assets.resolveAsset(ingested.asset.id)).rejects.toMatchObject({
      code: "config_corrupt"
    });
  });
});
