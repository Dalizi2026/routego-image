import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";
import type { LibraryOperationParameters } from "@routego-image/contracts";

import { LibraryAssetStore } from "../../src/gallery/assets";
import { LibraryFolderStore } from "../../src/gallery/folders";
import { ImageLibraryIndexStore } from "../../src/gallery/index-store";
import { libraryMutationError } from "../../src/gallery/mutations";
import { BrowserResourceRegistry } from "../../src/gallery/resources";
import { listTransactionJournals } from "../../src/fs/journal";
import { UploadStore } from "../../src/upload/store";
import { decodeZipArchive, encodeZipArchive, type ZipSourceEntry } from "../../src/zip/codec";
import {
  PORTABLE_LIBRARY_MANIFEST_ENTRY,
  parsePortableLibraryManifestBytes
} from "../../src/zip/manifest";
import { LibraryPortabilityService } from "../../src/zip/portability";

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

async function* chunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  const middle = Math.max(1, Math.floor(bytes.byteLength / 2));
  yield bytes.subarray(0, middle);
  if (middle < bytes.byteLength) yield bytes.subarray(middle);
}

async function createHarness(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  const libraryRoot = path.join(root, "library");
  const indexStore = new ImageLibraryIndexStore({ root: libraryRoot });
  const assetStore = new LibraryAssetStore({ indexStore, protectedRoots: [] });
  const uploadStore = new UploadStore({
    dataRoot: path.join(root, "data"),
    idFactory: (() => {
      let value = 0;
      return () => `upload-portable-${++value}`;
    })()
  });
  const resourceRegistry = new BrowserResourceRegistry({
    root: libraryRoot,
    idFactory: (() => {
      let value = 0;
      return () => `resource-portable-${++value}`;
    })()
  });
  const counters = { asset: 0, artifact: 0, folder: 0, transaction: 0 };
  const service = new LibraryPortabilityService({
    indexStore,
    uploadStore,
    resourceRegistry,
    assetStore,
    now: () => new Date("2026-07-18T08:00:00.000Z"),
    idFactory: (kind) => `${kind}-portable-${++counters[kind]}`
  });
  return { root, libraryRoot, indexStore, assetStore, uploadStore, resourceRegistry, service };
}

async function seedRelatedAssets(
  harness: Awaited<ReturnType<typeof createHarness>>,
  options: {
    readonly sourceFill?: number;
    readonly outputFill?: number;
    readonly sourceId?: string;
    readonly outputId?: string;
    readonly sourceArtifactId?: string;
    readonly outputArtifactId?: string;
    readonly folderId?: string;
    readonly folderName?: string;
  } = {}
) {
  const sourceId = options.sourceId ?? "asset-source";
  const outputId = options.outputId ?? "asset-output";
  const sourceArtifactId = options.sourceArtifactId ?? "artifact-source";
  const outputArtifactId = options.outputArtifactId ?? "artifact-output";
  const folderId = options.folderId ?? "folder-picks";
  const sourceRoot = path.join(harness.root, `source-${sourceId}`);
  await mkdir(sourceRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(sourceRoot, "source.png"), png(options.sourceFill ?? 0x11)),
    writeFile(path.join(sourceRoot, "output.png"), png(options.outputFill ?? 0x22))
  ]);
  const folders = new LibraryFolderStore({
    indexStore: harness.indexStore,
    now: () => new Date("2026-07-18T07:00:00.000Z"),
    idFactory: () => folderId
  });
  await folders.createFolder(options.folderName ?? "精选 图库 🙂");
  const sourcePrompt = "源图：山水与星光 🙂";
  const outputPrompt = "输出：保留中文与 emoji 🚀";
  await harness.assetStore.ingestAssets([
    {
      assetId: sourceId,
      primaryArtifactId: sourceArtifactId,
      prompt: sourcePrompt,
      model: "portable-model",
      requestedParams: parameters(sourcePrompt),
      effectiveParams: parameters(sourcePrompt),
      execution,
      renditions: [
        {
          artifactId: sourceArtifactId,
          phase: "final",
          sourceRoot,
          sourceRelativePath: "source.png"
        }
      ],
      createdAt: "2026-07-18T07:10:00.000Z",
      updatedAt: "2026-07-18T07:10:00.000Z"
    },
    {
      assetId: outputId,
      primaryArtifactId: outputArtifactId,
      prompt: outputPrompt,
      model: "portable-model",
      requestedParams: parameters(outputPrompt),
      effectiveParams: parameters(outputPrompt),
      execution,
      renditions: [
        {
          artifactId: outputArtifactId,
          phase: "final",
          sourceRoot,
          sourceRelativePath: "output.png"
        }
      ],
      relationships: [
        {
          id: `relationship-${outputId}`,
          role: "source",
          relatedAssetId: sourceId,
          artifactId: sourceArtifactId,
          order: 0,
          label: "源图"
        }
      ],
      folderIds: [folderId],
      createdAt: "2026-07-18T07:20:00.000Z",
      updatedAt: "2026-07-18T07:20:00.000Z"
    }
  ]);
  return { sourceId, outputId, sourceArtifactId, outputArtifactId, folderId };
}

async function finalizeZipUpload(store: UploadStore, bytes: Buffer): Promise<string> {
  const reserved = await store.reserveUploadResource({
    purpose: "zip-import",
    declaredMimeType: "application/zip",
    declaredByteLength: bytes.byteLength,
    expectedSha256: createHash("sha256").update(bytes).digest("hex")
  });
  if (reserved.status !== "succeeded" || !reserved.resource) throw new Error("reserve failed");
  const uploadResourceId = reserved.resource.uploadResourceId;
  await store.stageUpload(uploadResourceId, chunks(bytes));
  const finalized = await store.finalizeUploadResource({ uploadResourceId });
  if (finalized.status !== "succeeded") throw new Error("finalize failed");
  return uploadResourceId;
}

async function seedIndependentAssets(
  harness: Awaited<ReturnType<typeof createHarness>>,
  assets: readonly {
    readonly assetId: string;
    readonly artifactId: string;
    readonly fill: number;
    readonly prompt?: string;
  }[]
) {
  const sourceRoot = path.join(harness.root, `independent-${assets[0]?.assetId ?? "empty"}`);
  await mkdir(sourceRoot, { recursive: true });
  await Promise.all(
    assets.map((asset) => writeFile(path.join(sourceRoot, `${asset.assetId}.png`), png(asset.fill)))
  );
  await harness.assetStore.ingestAssets(
    assets.map((asset, index) => {
      const prompt = asset.prompt ?? `Independent ${asset.assetId}`;
      return {
        assetId: asset.assetId,
        primaryArtifactId: asset.artifactId,
        prompt,
        model: "portable-model",
        requestedParams: parameters(prompt),
        effectiveParams: parameters(prompt),
        execution,
        renditions: [
          {
            artifactId: asset.artifactId,
            phase: "final" as const,
            sourceRoot,
            sourceRelativePath: `${asset.assetId}.png`
          }
        ],
        createdAt: `2026-07-18T07:${String(30 + index).padStart(2, "0")}:00.000Z`,
        updatedAt: `2026-07-18T07:${String(30 + index).padStart(2, "0")}:00.000Z`
      };
    })
  );
}

function createServiceForHarness(
  harness: Awaited<ReturnType<typeof createHarness>>,
  options: Partial<
    Omit<
      ConstructorParameters<typeof LibraryPortabilityService>[0],
      "indexStore" | "uploadStore" | "resourceRegistry" | "assetStore" | "now"
    >
  > = {}
) {
  return new LibraryPortabilityService({
    indexStore: harness.indexStore,
    uploadStore: harness.uploadStore,
    resourceRegistry: harness.resourceRegistry,
    assetStore: harness.assetStore,
    now: () => new Date("2026-07-18T08:00:00.000Z"),
    ...options
  });
}

function rewritePortableArchive(
  bytes: Buffer,
  mutate: (
    manifest: {
      blobs: Array<Record<string, unknown>>;
      assets: Array<Record<string, unknown>>;
      folders: Array<Record<string, unknown>>;
    },
    entries: ZipSourceEntry[]
  ) => void
): Buffer {
  const decoded = decodeZipArchive(bytes);
  const entries: ZipSourceEntry[] = decoded.entries.map((entry) => ({
    name: entry.name,
    data: Buffer.from(entry.data),
    compression: entry.compression
  }));
  const manifestIndex = entries.findIndex((entry) => entry.name === PORTABLE_LIBRARY_MANIFEST_ENTRY);
  const manifest = JSON.parse(entries[manifestIndex]!.data.toString("utf8")) as {
    blobs: Array<Record<string, unknown>>;
    assets: Array<Record<string, unknown>>;
    folders: Array<Record<string, unknown>>;
  };
  mutate(manifest, entries);
  const updatedManifestIndex = entries.findIndex(
    (entry) => entry.name === PORTABLE_LIBRARY_MANIFEST_ENTRY
  );
  if (updatedManifestIndex >= 0) {
    entries[updatedManifestIndex] = {
      name: PORTABLE_LIBRARY_MANIFEST_ENTRY,
      data: Buffer.from(JSON.stringify(manifest), "utf8"),
      compression: "deflate"
    };
  }
  return encodeZipArchive(entries);
}

function corruptEntryCrc(bytes: Buffer, entryName: string): Buffer {
  const output = Buffer.from(bytes);
  const eocd = output.byteLength - 22;
  let central = output.readUInt32LE(eocd + 16);
  const entryCount = output.readUInt16LE(eocd + 10);
  for (let index = 0; index < entryCount; index += 1) {
    const nameLength = output.readUInt16LE(central + 28);
    const extraLength = output.readUInt16LE(central + 30);
    const commentLength = output.readUInt16LE(central + 32);
    const name = output.subarray(central + 46, central + 46 + nameLength).toString("utf8");
    if (name === entryName) {
      output.writeUInt32LE((output.readUInt32LE(central + 16) ^ 1) >>> 0, central + 16);
      return output;
    }
    central += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error("portable ZIP entry was not found");
}

async function exportedArchive(
  harness: Awaited<ReturnType<typeof createHarness>>,
  assetIds: readonly string[]
) {
  const result = await harness.service.exportAssets({
    preflightId: "preflight-export-portable",
    assetIds,
    requestedBaseName: "图库 导出 🙂"
  });
  if (!result.outputResource) throw new Error(`export failed: ${JSON.stringify(result)}`);
  const resolved = harness.resourceRegistry.resolve(result.outputResource.resourceId);
  return { result, resolved, bytes: await readFile(resolved.path) };
}

describe("portable Library ZIP export and import", () => {
  it("exports the complete selected closure without credentials or local paths", async () => {
    const source = await createHarness("routego-portable-export-");
    const ids = await seedRelatedAssets(source);
    const unsafeText = String.raw`输出：保留中文与 emoji 🚀；本地 C:\Users\Synthetic\private.png；Authorization: synthetic-test-value；data:image/png;base64,c3ludGhldGlj`;
    await source.indexStore.runExclusive(async ({ index, commit }) => {
      await commit({
        blobs: index.blobs,
        folders: index.folders,
        assets: index.assets.map((asset) =>
          asset.id !== ids.outputId
            ? asset
            : {
                ...asset,
                prompt: unsafeText,
                requestedParams: { ...asset.requestedParams, prompt: unsafeText },
                effectiveParams: { ...asset.effectiveParams, prompt: unsafeText },
                error: {
                  ...libraryMutationError("invalid_input", unsafeText),
                  details: {
                    apiKey: "synthetic-test-value",
                    localPath: String.raw`C:\Users\Synthetic\private.png`
                  }
                }
              }
        )
      });
    });
    const exported = await exportedArchive(source, [ids.outputId]);
    expect(exported.result).toMatchObject({
      status: "succeeded",
      items: [{ targetId: ids.outputId, status: "succeeded" }],
      outputResource: {
        requiresSession: true,
        mimeType: "application/zip"
      }
    });
    expect(exported.result.outputResource?.relativeUrl).toMatch(
      /^\/api\/v1\/library\/resources\//u
    );
    expect(path.basename(exported.resolved.path)).toContain("图库 导出 🙂");
    const archive = decodeZipArchive(exported.bytes);
    const manifestEntry = archive.entries.find(
      (entry) => entry.name === PORTABLE_LIBRARY_MANIFEST_ENTRY
    )!;
    const manifest = parsePortableLibraryManifestBytes(manifestEntry.data);
    expect(manifest.assets.map((asset) => asset.id)).toEqual([ids.sourceId, ids.outputId]);
    expect(manifest.folders.map((folder) => folder.id)).toEqual([ids.folderId]);
    expect(manifest.assets[1]?.relationships).toMatchObject([
      { relatedAssetId: ids.sourceId, artifactId: ids.sourceArtifactId }
    ]);
    expect(JSON.stringify(manifest)).toContain("中文与 emoji 🚀");
    const serialized = JSON.stringify(manifest).toLocaleLowerCase("en-US");
    expect(serialized).not.toContain(source.root.toLocaleLowerCase("en-US"));
    expect(serialized).not.toMatch(/(?:apikey|authorization|bearer |credential|stagingpath|relativepath)/u);
    expect(serialized).not.toContain("synthetic-test-value");
    expect(serialized).not.toContain(String.raw`c:\users\synthetic\private.png`);
    expect(serialized).not.toContain("data:image");
    expect(manifest.assets[1]?.error).toMatchObject({ partialArtifacts: [] });
    expect(manifest.assets[1]?.error).not.toHaveProperty("details");
  });

  it("imports validated assets, folders, relationships and blobs, then consumes the ZIP", async () => {
    const source = await createHarness("routego-portable-source-");
    const ids = await seedRelatedAssets(source);
    const exported = await exportedArchive(source, [ids.outputId]);
    const target = await createHarness("routego-portable-target-");
    const uploadResourceId = await finalizeZipUpload(target.uploadStore, exported.bytes);
    const imported = await target.service.importUpload({
      preflightId: "preflight-import-portable",
      uploadResourceId
    });
    expect(imported).toMatchObject({
      status: "succeeded",
      importedCount: 2,
      skippedCount: 0,
      items: [
        { targetId: ids.sourceId, status: "succeeded", affectedAssetId: ids.sourceId },
        { targetId: ids.outputId, status: "succeeded", affectedAssetId: ids.outputId }
      ]
    });
    const index = await target.indexStore.read();
    expect(index.assets.map((asset) => asset.id)).toEqual([ids.sourceId, ids.outputId]);
    expect(index.folders).toMatchObject([{ id: ids.folderId, name: "精选 图库 🙂" }]);
    expect(index.blobs).toHaveLength(2);
    expect(index.assets[1]?.relationships).toMatchObject([
      { relatedAssetId: ids.sourceId, artifactId: ids.sourceArtifactId }
    ]);
    expect(
      await target.uploadStore.getUploadResourceStatus({ uploadResourceId })
    ).toMatchObject({ status: "failed", error: { code: "upload_consumed" } });
  });

  it("keeps valid export selections when another target is missing and versions collisions", async () => {
    const source = await createHarness("routego-portable-partial-export-");
    const ids = await seedRelatedAssets(source);
    const first = await source.service.exportAssets({
      preflightId: "preflight-export-partial",
      assetIds: [ids.outputId, "asset-missing"],
      requestedBaseName: "shared-name"
    });
    expect(first).toMatchObject({
      status: "partial",
      items: [
        { targetId: ids.outputId, status: "succeeded" },
        { targetId: "asset-missing", status: "failed", error: { code: "not_found" } }
      ]
    });
    const firstResolved = source.resourceRegistry.resolve(first.outputResource!.resourceId);
    const firstBytes = await readFile(firstResolved.path);
    const second = await source.service.exportAssets({
      preflightId: "preflight-export-collision",
      assetIds: [ids.outputId],
      requestedBaseName: "shared-name"
    });
    const secondResolved = source.resourceRegistry.resolve(second.outputResource!.resourceId);
    expect(path.basename(firstResolved.path)).toBe("shared-name.zip");
    expect(path.basename(secondResolved.path)).toBe("shared-name-2.zip");
    expect(await readFile(firstResolved.path)).toEqual(firstBytes);
  });

  it("reuses existing blobs and reports exact-record skips without duplicating data", async () => {
    const source = await createHarness("routego-portable-reuse-source-");
    const ids = await seedRelatedAssets(source);
    const exported = await exportedArchive(source, [ids.outputId]);
    const target = await createHarness("routego-portable-reuse-target-");
    await seedRelatedAssets(target, {
      sourceId: "asset-existing-source",
      outputId: "asset-existing-output",
      sourceArtifactId: "artifact-existing-source",
      outputArtifactId: "artifact-existing-output",
      folderId: "folder-existing",
      folderName: "Existing",
      sourceFill: 0x11,
      outputFill: 0x44
    });
    const beforeBlobCount = (await target.indexStore.read()).blobs.length;
    const firstUpload = await finalizeZipUpload(target.uploadStore, exported.bytes);
    const firstImport = await target.service.importUpload({
      preflightId: "preflight-import-reuse",
      uploadResourceId: firstUpload
    });
    expect(firstImport).toMatchObject({ status: "succeeded", importedCount: 2 });
    expect((await target.indexStore.read()).blobs).toHaveLength(beforeBlobCount + 1);

    const secondUpload = await finalizeZipUpload(target.uploadStore, exported.bytes);
    const repeated = await target.service.importUpload({
      preflightId: "preflight-import-exact-skip",
      uploadResourceId: secondUpload
    });
    expect(repeated.items.map((item) => item.status)).toEqual(["skipped", "skipped"]);
    expect(repeated).toMatchObject({ importedCount: 0, skippedCount: 2 });
    expect((await target.indexStore.read()).blobs).toHaveLength(beforeBlobCount + 1);
    expect(await target.uploadStore.getUploadResourceStatus({ uploadResourceId: secondUpload })).toMatchObject({
      status: "failed",
      error: { code: "upload_consumed" }
    });
  });

  it("remaps conflicting asset, artifact, folder, relationship and parameter identities consistently", async () => {
    const source = await createHarness("routego-portable-remap-source-");
    const ids = await seedRelatedAssets(source);
    const exported = await exportedArchive(source, [ids.outputId]);
    const target = await createHarness("routego-portable-remap-target-");
    await seedRelatedAssets(target, {
      sourceId: ids.sourceId,
      outputId: "asset-existing-other",
      sourceArtifactId: ids.sourceArtifactId,
      outputArtifactId: "artifact-existing-other",
      folderId: ids.folderId,
      folderName: "Existing Conflict",
      sourceFill: 0x66,
      outputFill: 0x77
    });
    const uploadResourceId = await finalizeZipUpload(target.uploadStore, exported.bytes);
    const imported = await target.service.importUpload({
      preflightId: "preflight-import-remap",
      uploadResourceId
    });
    expect(imported.status).toBe("succeeded");
    const sourceItem = imported.items.find((item) => item.targetId === ids.sourceId)!;
    const outputItem = imported.items.find((item) => item.targetId === ids.outputId)!;
    expect(sourceItem.affectedAssetId).not.toBe(ids.sourceId);
    expect(outputItem.affectedAssetId).toBe(ids.outputId);
    expect(sourceItem.warnings.join(" ")).toContain("remapped");
    const index = await target.indexStore.read();
    const importedOutput = index.assets.find((asset) => asset.id === ids.outputId)!;
    const importedSource = index.assets.find((asset) => asset.id === sourceItem.affectedAssetId)!;
    expect(importedOutput.relationships[0]).toMatchObject({
      relatedAssetId: importedSource.id,
      artifactId: importedSource.primaryArtifactId
    });
    expect(importedOutput.folderIds[0]).not.toBe(ids.folderId);
  });

  it("commits eligible assets when one conflicting item cannot allocate a replacement ID", async () => {
    const source = await createHarness("routego-portable-partial-source-");
    await seedIndependentAssets(source, [
      { assetId: "asset-conflict", artifactId: "artifact-import-conflict", fill: 0x21 },
      { assetId: "asset-free", artifactId: "artifact-import-free", fill: 0x22 }
    ]);
    const exported = await exportedArchive(source, ["asset-conflict", "asset-free"]);
    const target = await createHarness("routego-portable-partial-target-");
    await seedIndependentAssets(target, [
      { assetId: "asset-conflict", artifactId: "artifact-existing-conflict", fill: 0x99 }
    ]);
    let otherId = 0;
    const partialService = createServiceForHarness(target, {
      idFactory: (kind) =>
        kind === "asset" ? "asset-conflict" : `${kind}-partial-${++otherId}`
    });
    const uploadResourceId = await finalizeZipUpload(target.uploadStore, exported.bytes);
    const result = await partialService.importUpload({
      preflightId: "preflight-import-partial",
      uploadResourceId
    });
    expect(result).toMatchObject({
      status: "partial",
      importedCount: 1,
      items: [
        { targetId: "asset-conflict", status: "failed", error: { code: "conflict" } },
        { targetId: "asset-free", status: "succeeded", affectedAssetId: "asset-free" }
      ]
    });
    expect((await target.indexStore.read()).assets.some((asset) => asset.id === "asset-free")).toBe(
      true
    );
    expect(await target.uploadStore.getUploadResourceStatus({ uploadResourceId })).toMatchObject({
      status: "failed",
      error: { code: "upload_consumed" }
    });
  });

  it.each([
    [
      "missing entry",
      (_manifest: { blobs: Array<Record<string, unknown>> }, entries: ZipSourceEntry[]) => {
        const blobEntry = entries.findIndex((entry) => entry.name.startsWith("blobs/"));
        entries.splice(blobEntry, 1);
      }
    ],
    [
      "unexpected entry",
      (_manifest: { blobs: Array<Record<string, unknown>> }, entries: ZipSourceEntry[]) => {
        entries.push({ name: "unexpected.bin", data: Buffer.from("unexpected"), compression: "store" });
      }
    ],
    [
      "SHA mismatch",
      (_manifest: { blobs: Array<Record<string, unknown>> }, entries: ZipSourceEntry[]) => {
        const blobEntry = entries.find((entry) => entry.name.startsWith("blobs/"))!;
        const changed = Buffer.from(blobEntry.data);
        changed[changed.length - 1] ^= 0xff;
        Object.assign(blobEntry, { data: changed });
      }
    ],
    [
      "dimension mismatch",
      (manifest: { blobs: Array<Record<string, unknown>> }) => {
        manifest.blobs[0]!["width"] = 999;
      }
    ],
    [
      "MIME mismatch",
      (manifest: { blobs: Array<Record<string, unknown>> }, entries: ZipSourceEntry[]) => {
        const blob = manifest.blobs[0]!;
        const oldName = blob["entryName"] as string;
        const newName = `blobs/${blob["sha256"] as string}.jpg`;
        blob["mimeType"] = "image/jpeg";
        blob["entryName"] = newName;
        const entry = entries.find((candidate) => candidate.name === oldName)!;
        Object.assign(entry, { name: newName });
      }
    ],
    [
      "duplicate manifest blob",
      (manifest: { blobs: Array<Record<string, unknown>> }) => {
        manifest.blobs.push(structuredClone(manifest.blobs[0]!));
      }
    ],
    [
      "absolute metadata path",
      (manifest: { assets: Array<Record<string, unknown>> }) => {
        const asset = manifest.assets[0]!;
        const unsafePrompt = String.raw`C:\Users\Synthetic\private.png`;
        asset["prompt"] = unsafePrompt;
        (asset["requestedParams"] as Record<string, unknown>)["prompt"] = unsafePrompt;
        (asset["effectiveParams"] as Record<string, unknown>)["prompt"] = unsafePrompt;
      }
    ]
  ])("rejects %s before index mutation or ZIP consumption", async (_label, mutate) => {
    const source = await createHarness("routego-portable-invalid-source-");
    const ids = await seedRelatedAssets(source);
    const exported = await exportedArchive(source, [ids.outputId]);
    const changed = rewritePortableArchive(exported.bytes, mutate);
    const target = await createHarness("routego-portable-invalid-target-");
    const uploadResourceId = await finalizeZipUpload(target.uploadStore, changed);
    const result = await target.service.importUpload({
      preflightId: "preflight-import-invalid",
      uploadResourceId
    });
    expect(result.status).toBe("failed");
    expect((await target.indexStore.read()).assets).toEqual([]);
    await expect(
      target.uploadStore.resolveUploadResource(uploadResourceId, ["zip-import"])
    ).resolves.toMatchObject({ uploadResourceId });
  });

  it("rejects a CRC mismatch before index mutation or ZIP consumption", async () => {
    const source = await createHarness("routego-portable-crc-source-");
    const ids = await seedRelatedAssets(source);
    const exported = await exportedArchive(source, [ids.outputId]);
    const archive = decodeZipArchive(exported.bytes);
    const blobName = archive.entries.find((entry) => entry.name.startsWith("blobs/"))!.name;
    const corrupt = corruptEntryCrc(exported.bytes, blobName);
    const target = await createHarness("routego-portable-crc-target-");
    const uploadResourceId = await finalizeZipUpload(target.uploadStore, corrupt);
    const result = await target.service.importUpload({
      preflightId: "preflight-import-crc",
      uploadResourceId
    });
    expect(result.status).toBe("failed");
    expect((await target.indexStore.read()).assets).toEqual([]);
    await expect(
      target.uploadStore.resolveUploadResource(uploadResourceId, ["zip-import"])
    ).resolves.toMatchObject({ uploadResourceId });
  });

  it("recovers a crash before index commit without deleting unknown files, then retries", async () => {
    const source = await createHarness("routego-portable-before-source-");
    const ids = await seedRelatedAssets(source);
    const exported = await exportedArchive(source, [ids.outputId]);
    const target = await createHarness("routego-portable-before-target-");
    const uploadResourceId = await finalizeZipUpload(target.uploadStore, exported.bytes);
    const crashing = createServiceForHarness(target, {
      hooks: {
        afterImportJournalsPrepared: async () => {
          throw new Error("synthetic crash before index commit");
        }
      }
    });
    await expect(
      crashing.importUpload({ preflightId: "preflight-crash-before", uploadResourceId })
    ).rejects.toThrow("synthetic crash before index commit");
    expect(await listTransactionJournals(target.libraryRoot)).not.toEqual([]);
    const unknownPath = path.join(target.libraryRoot, ".transactions", "files", "unknown-user.bin");
    await writeFile(unknownPath, Buffer.from("preserve"));
    await crashing.recover();
    expect(await listTransactionJournals(target.libraryRoot)).toEqual([]);
    await expect(access(unknownPath)).resolves.toBeUndefined();
    expect((await target.indexStore.read()).assets).toEqual([]);
    const retried = await createServiceForHarness(target).importUpload({
      preflightId: "preflight-retry-before",
      uploadResourceId
    });
    expect(retried).toMatchObject({ status: "succeeded", importedCount: 2 });
  });

  it("retains committed blobs after a post-commit crash and consumes on exact retry", async () => {
    const source = await createHarness("routego-portable-after-source-");
    const ids = await seedRelatedAssets(source);
    const exported = await exportedArchive(source, [ids.outputId]);
    const target = await createHarness("routego-portable-after-target-");
    const uploadResourceId = await finalizeZipUpload(target.uploadStore, exported.bytes);
    const crashing = createServiceForHarness(target, {
      hooks: {
        afterImportIndexCommit: async () => {
          throw new Error("synthetic crash after index commit");
        }
      }
    });
    await expect(
      crashing.importUpload({ preflightId: "preflight-crash-after", uploadResourceId })
    ).rejects.toThrow("synthetic crash after index commit");
    expect(await listTransactionJournals(target.libraryRoot)).not.toEqual([]);
    await crashing.recover();
    expect(await listTransactionJournals(target.libraryRoot)).toEqual([]);
    const committed = await target.indexStore.read();
    expect(committed.assets).toHaveLength(2);
    for (const blob of committed.blobs) {
      await expect(
        access(path.join(target.libraryRoot, ...blob.relativePath.split("/")))
      ).resolves.toBeUndefined();
    }
    await expect(
      target.uploadStore.resolveUploadResource(uploadResourceId, ["zip-import"])
    ).resolves.toBeDefined();
    const retried = await createServiceForHarness(target).importUpload({
      preflightId: "preflight-retry-after",
      uploadResourceId
    });
    expect(retried.items.map((item) => item.status)).toEqual(["skipped", "skipped"]);
    expect(retried.skippedCount).toBe(2);
    expect(await target.uploadStore.getUploadResourceStatus({ uploadResourceId })).toMatchObject({
      status: "failed",
      error: { code: "upload_consumed" }
    });
  });
});
