import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

import type { LibraryOperationParameters } from "@routego-image/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { LibraryAssetStore, type IngestLibraryAssetInput } from "../../src/gallery/assets";
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

function parameters(prompt: string, format: "png" | "jpeg" | "webp" = "png"): LibraryOperationParameters {
  return {
    kind: "generate",
    prompt,
    references: [],
    size: "auto",
    aspectRatio: "auto",
    quality: "auto",
    format,
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

async function createHarness() {
  const root = await mkdtemp(path.join(os.tmpdir(), "routego-source-renditions-"));
  roots.push(root);
  const home = path.join(root, "home");
  const libraryRoot = path.join(root, "library");
  const sourceRoot = path.join(root, "source");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(sourceRoot, { recursive: true })]);
  const counters = { asset: 0, artifact: 0, transaction: 0 };
  const indexStore = new ImageLibraryIndexStore({ root: libraryRoot, homeDirectory: home });
  const assets = new LibraryAssetStore({
    indexStore,
    homeDirectory: home,
    now: () => new Date("2026-07-18T08:00:00.000Z"),
    idFactory: (kind) => `${kind}-source-${++counters[kind]}`
  });
  let resourceIndex = 0;
  const readService = new LibraryReadService({
    indexStore,
    now: () => new Date("2026-07-18T08:01:00.000Z"),
    resourceIdFactory: (rendition) => `resource-${rendition}-${++resourceIndex}`
  });
  return { root, home, libraryRoot, sourceRoot, indexStore, assets, readService };
}

async function writeSources(
  sourceRoot: string,
  entries: Readonly<Record<string, Uint8Array>>
): Promise<void> {
  await Promise.all(
    Object.entries(entries).map(([name, bytes]) => writeFile(path.join(sourceRoot, name), bytes))
  );
}

function assetInput(
  sourceRoot: string,
  overrides: Partial<IngestLibraryAssetInput> = {}
): IngestLibraryAssetInput {
  const prompt = overrides.prompt ?? "Synthetic source rendition operation";
  const operationParameters = parameters(prompt);
  return {
    assetId: "asset-operation",
    prompt,
    model: "synthetic-image-model",
    requestedParams: operationParameters,
    effectiveParams: operationParameters,
    execution,
    renditions: [
      {
        artifactId: "artifact-final",
        phase: "final",
        sourceRoot,
        sourceRelativePath: "final.png"
      }
    ],
    ...overrides
  };
}

describe("Library source/output operation graphs", () => {
  it("co-ingests mixed source MIME with PNG outputs and projects exact detail/resources", async () => {
    const harness = await createHarness();
    const target = validJpeg(7, 5);
    const reference = validWebp(6, 4);
    const partial = validPng(8, 6, 0x31);
    const final = validPng(9, 7, 0x32);
    await writeSources(harness.sourceRoot, {
      "target.jpg": target,
      "reference.webp": reference,
      "partial.png": partial,
      "final.png": final
    });

    const result = await harness.assets.ingestAsset(
      assetInput(harness.sourceRoot, {
        primaryArtifactId: "artifact-final",
        renditions: [
          { artifactId: "artifact-target", phase: "source", sourceRoot: harness.sourceRoot, sourceRelativePath: "target.jpg" },
          { artifactId: "artifact-reference", phase: "source", sourceRoot: harness.sourceRoot, sourceRelativePath: "reference.webp" },
          { artifactId: "artifact-partial", phase: "partial", sourceRoot: harness.sourceRoot, sourceRelativePath: "partial.png" },
          { artifactId: "artifact-final", phase: "final", sourceRoot: harness.sourceRoot, sourceRelativePath: "final.png" }
        ],
        relationships: [
          { id: "relationship-target", role: "target", relatedAssetId: "asset-operation", artifactId: "artifact-target", order: 0 },
          { id: "relationship-reference", role: "reference", relatedAssetId: "asset-operation", artifactId: "artifact-reference", order: 1 },
          { id: "relationship-partial", role: "output", relatedAssetId: "asset-operation", artifactId: "artifact-partial", order: 2 },
          { id: "relationship-final", role: "output", relatedAssetId: "asset-operation", artifactId: "artifact-final", order: 3 }
        ]
      })
    );

    expect(result.asset).toMatchObject({
      id: "asset-operation",
      primaryArtifactId: "artifact-final",
      status: "succeeded"
    });
    expect(result.asset.renditions.map(({ artifactId, phase }) => ({ artifactId, phase }))).toEqual([
      { artifactId: "artifact-target", phase: "source" },
      { artifactId: "artifact-reference", phase: "source" },
      { artifactId: "artifact-partial", phase: "partial" },
      { artifactId: "artifact-final", phase: "final" }
    ]);

    const detail = await harness.readService.getAssetDetail({ assetId: "asset-operation" });
    expect(detail).toMatchObject({
      status: "succeeded",
      asset: {
        primaryArtifactId: "artifact-final",
        mimeType: "image/png",
        width: 9,
        height: 7
      }
    });
    expect(detail.asset?.renditions.map(({ artifactId, phase, mimeType }) => ({ artifactId, phase, mimeType }))).toEqual([
      { artifactId: "artifact-final", phase: "final", mimeType: "image/png" },
      { artifactId: "artifact-partial", phase: "partial", mimeType: "image/png" },
      { artifactId: "artifact-reference", phase: "source", mimeType: "image/webp" },
      { artifactId: "artifact-target", phase: "source", mimeType: "image/jpeg" }
    ]);
    expect(detail.asset?.relationships.map((relationship) => relationship.artifactId)).toEqual([
      "artifact-target",
      "artifact-reference",
      "artifact-partial",
      "artifact-final"
    ]);

    const sourceResource = await harness.readService.getBrowserResource({
      assetId: "asset-operation",
      artifactId: "artifact-target",
      rendition: "original"
    });
    expect(sourceResource).toMatchObject({
      status: "succeeded",
      resource: { mimeType: "image/jpeg", width: 7, height: 5, requiresSession: true }
    });
    const resolved = await harness.assets.resolveArtifact("artifact-reference");
    expect(resolved).toMatchObject({
      assetId: "asset-operation",
      artifactId: "artifact-reference",
      mimeType: "image/webp",
      sha256: sha256(reference)
    });
    expect(JSON.stringify(detail)).not.toMatch(/(?:"path"|data:image|base64|[A-Za-z]:\\|\/Users\/)/u);
    expect(JSON.stringify(sourceResource)).not.toContain(harness.libraryRoot);
  });

  it("deduplicates identical source and final bytes without merging logical artifact identities", async () => {
    const harness = await createHarness();
    const bytes = validPng(5, 5, 0x41);
    await writeSources(harness.sourceRoot, { "shared.png": bytes });
    const result = await harness.assets.ingestAsset(
      assetInput(harness.sourceRoot, {
        renditions: [
          { artifactId: "artifact-source", phase: "source", sourceRoot: harness.sourceRoot, sourceRelativePath: "shared.png" },
          { artifactId: "artifact-final", phase: "final", sourceRoot: harness.sourceRoot, sourceRelativePath: "shared.png" }
        ],
        relationships: [
          { id: "relationship-source", role: "source", relatedAssetId: "asset-operation", artifactId: "artifact-source", order: 0 },
          { id: "relationship-output", role: "output", relatedAssetId: "asset-operation", artifactId: "artifact-final", order: 1 }
        ]
      })
    );
    const index = await harness.indexStore.read();
    expect(index.blobs).toHaveLength(1);
    expect(result.deduplicatedBlobCount).toBe(1);
    expect(new Set(result.asset.renditions.map((rendition) => rendition.artifactId)).size).toBe(2);
    expect(new Set(result.asset.renditions.map((rendition) => rendition.blobSha256))).toEqual(
      new Set([sha256(bytes)])
    );
  });

  it("enforces output-only primary/final invariants and output MIME while allowing source MIME diversity", async () => {
    const harness = await createHarness();
    await writeSources(harness.sourceRoot, {
      "source.jpg": validJpeg(),
      "partial.png": validPng(3, 3, 0x51),
      "final.png": validPng(4, 4, 0x52),
      "wrong-final.jpg": validJpeg(8, 8)
    });
    const commonRenditions = [
      { artifactId: "artifact-source", phase: "source" as const, sourceRoot: harness.sourceRoot, sourceRelativePath: "source.jpg" },
      { artifactId: "artifact-final", phase: "final" as const, sourceRoot: harness.sourceRoot, sourceRelativePath: "final.png" }
    ];

    await expect(
      harness.assets.ingestAsset(assetInput(harness.sourceRoot, {
        primaryArtifactId: "artifact-source",
        renditions: commonRenditions
      }))
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.assets.ingestAsset(assetInput(harness.sourceRoot, {
        primaryArtifactId: "artifact-partial",
        renditions: [
          commonRenditions[0]!,
          { artifactId: "artifact-partial", phase: "partial", sourceRoot: harness.sourceRoot, sourceRelativePath: "partial.png" }
        ]
      }))
    ).rejects.toMatchObject({ code: "invalid_input" });

    const partial = await harness.assets.ingestAsset(assetInput(harness.sourceRoot, {
      assetId: "asset-partial",
      status: "partial",
      primaryArtifactId: undefined,
      renditions: [
        { artifactId: "artifact-partial-source", phase: "source", sourceRoot: harness.sourceRoot, sourceRelativePath: "source.jpg" },
        { artifactId: "artifact-partial-output", phase: "partial", sourceRoot: harness.sourceRoot, sourceRelativePath: "partial.png" }
      ]
    }));
    expect(partial.asset.primaryArtifactId).toBe("artifact-partial-output");

    await expect(
      harness.assets.ingestAsset(assetInput(harness.sourceRoot, {
        assetId: "asset-wrong-mime",
        renditions: [
          { artifactId: "artifact-wrong-source", phase: "source", sourceRoot: harness.sourceRoot, sourceRelativePath: "source.jpg" },
          { artifactId: "artifact-wrong-final", phase: "final", sourceRoot: harness.sourceRoot, sourceRelativePath: "wrong-final.jpg" }
        ]
      }))
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("accepts the exact 17+12+4 graph and rejects a thirty-fourth rendition", async () => {
    const harness = await createHarness();
    await writeSources(harness.sourceRoot, {
      "source.jpg": validJpeg(2, 2),
      "partial.png": validPng(2, 2, 0x61),
      "final.png": validPng(2, 2, 0x62)
    });
    const sourceRenditions = Array.from({ length: 17 }, (_, index) => ({
      artifactId: `artifact-source-${index + 1}`,
      phase: "source" as const,
      sourceRoot: harness.sourceRoot,
      sourceRelativePath: "source.jpg"
    }));
    const partialRenditions = Array.from({ length: 12 }, (_, index) => ({
      artifactId: `artifact-partial-${index + 1}`,
      phase: "partial" as const,
      sourceRoot: harness.sourceRoot,
      sourceRelativePath: "partial.png"
    }));
    const finalRenditions = Array.from({ length: 4 }, (_, index) => ({
      artifactId: `artifact-final-${index + 1}`,
      phase: "final" as const,
      sourceRoot: harness.sourceRoot,
      sourceRelativePath: "final.png"
    }));
    const renditions = [...sourceRenditions, ...partialRenditions, ...finalRenditions];
    const result = await harness.assets.ingestAsset(assetInput(harness.sourceRoot, { renditions }));
    expect(result.asset.renditions).toHaveLength(33);
    expect(result.asset.primaryArtifactId).toBe("artifact-final-4");
    expect(result.deduplicatedBlobCount).toBe(30);
    expect((await harness.indexStore.read()).blobs).toHaveLength(3);

    await expect(
      harness.assets.ingestAsset(assetInput(harness.sourceRoot, {
        assetId: "asset-too-large",
        renditions: [
          ...renditions,
          { artifactId: "artifact-source-18", phase: "source", sourceRoot: harness.sourceRoot, sourceRelativePath: "source.jpg" }
        ]
      }))
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect((await harness.indexStore.read()).assets).toHaveLength(1);
  });

  it("rejects missing, cross-owned, or source-backed output relationship artifacts", async () => {
    const harness = await createHarness();
    await writeSources(harness.sourceRoot, {
      "first.png": validPng(2, 2, 0x71),
      "source.jpg": validJpeg(3, 3),
      "final.png": validPng(3, 3, 0x72)
    });
    await harness.assets.ingestAsset(assetInput(harness.sourceRoot, {
      assetId: "asset-existing",
      primaryArtifactId: "artifact-existing",
      renditions: [
        { artifactId: "artifact-existing", phase: "final", sourceRoot: harness.sourceRoot, sourceRelativePath: "first.png" }
      ]
    }));
    const operation = assetInput(harness.sourceRoot, {
      assetId: "asset-new",
      primaryArtifactId: "artifact-new-final",
      renditions: [
        { artifactId: "artifact-new-source", phase: "source", sourceRoot: harness.sourceRoot, sourceRelativePath: "source.jpg" },
        { artifactId: "artifact-new-final", phase: "final", sourceRoot: harness.sourceRoot, sourceRelativePath: "final.png" }
      ]
    });

    await expect(harness.assets.ingestAsset({
      ...operation,
      relationships: [
        { id: "relationship-wrong-owner", role: "reference", relatedAssetId: "asset-existing", artifactId: "artifact-new-source", order: 0 }
      ]
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(harness.assets.ingestAsset({
      ...operation,
      relationships: [
        { id: "relationship-output-missing", role: "output", relatedAssetId: "asset-new", order: 0 }
      ]
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(harness.assets.ingestAsset({
      ...operation,
      relationships: [
        { id: "relationship-output-source", role: "output", relatedAssetId: "asset-new", artifactId: "artifact-new-source", order: 0 }
      ]
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects corrupt persisted source graphs instead of repairing or projecting them", async () => {
    const harness = await createHarness();
    await writeSources(harness.sourceRoot, {
      "source.jpg": validJpeg(),
      "final.png": validPng()
    });
    await harness.assets.ingestAsset(assetInput(harness.sourceRoot, {
      renditions: [
        { artifactId: "artifact-source", phase: "source", sourceRoot: harness.sourceRoot, sourceRelativePath: "source.jpg" },
        { artifactId: "artifact-final", phase: "final", sourceRoot: harness.sourceRoot, sourceRelativePath: "final.png" }
      ],
      relationships: [
        { id: "relationship-source", role: "source", relatedAssetId: "asset-operation", artifactId: "artifact-source", order: 0 },
        { id: "relationship-output", role: "output", relatedAssetId: "asset-operation", artifactId: "artifact-final", order: 1 }
      ]
    }));
    const validDocument = JSON.parse(await readFile(harness.indexStore.paths.index, "utf8")) as {
      assets: Array<Record<string, unknown>>;
    };
    const corruptions = [
      (document: typeof validDocument) => {
        document.assets[0]!["primaryArtifactId"] = "artifact-source";
      },
      (document: typeof validDocument) => {
        const renditions = document.assets[0]!["renditions"] as Array<Record<string, unknown>>;
        renditions[1]!["phase"] = "partial";
      },
      (document: typeof validDocument) => {
        const relationships = document.assets[0]!["relationships"] as Array<Record<string, unknown>>;
        relationships[1]!["artifactId"] = "artifact-source";
      },
      (document: typeof validDocument) => {
        const renditions = document.assets[0]!["renditions"] as Array<Record<string, unknown>>;
        for (let index = 0; index < 32; index += 1) {
          renditions.push({ ...renditions[0], artifactId: `artifact-overflow-${index + 1}` });
        }
      }
    ];

    for (const mutate of corruptions) {
      const document = structuredClone(validDocument);
      mutate(document);
      await writeFile(harness.indexStore.paths.index, `${JSON.stringify(document)}\n`, "utf8");
      const reader = new ImageLibraryIndexStore({ root: harness.libraryRoot, homeDirectory: harness.home });
      await expect(reader.read()).rejects.toMatchObject({ code: "config_corrupt" });
    }
  });

  it("applies traversal and protected-legacy rejection equally to source renditions", async () => {
    const harness = await createHarness();
    await writeSources(harness.sourceRoot, { "safe.jpg": validJpeg(), "final.png": validPng() });
    await expect(harness.assets.ingestAsset(assetInput(harness.sourceRoot, {
      renditions: [
        { artifactId: "artifact-source", phase: "source", sourceRoot: harness.sourceRoot, sourceRelativePath: "../outside.jpg" },
        { artifactId: "artifact-final", phase: "final", sourceRoot: harness.sourceRoot, sourceRelativePath: "final.png" }
      ]
    }))).rejects.toMatchObject({ code: "path_unsafe" });

    const legacyRoot = path.join(harness.home, "Pictures", "routego-image");
    await mkdir(legacyRoot, { recursive: true });
    await writeFile(path.join(legacyRoot, "legacy.jpg"), validJpeg());
    await expect(harness.assets.ingestAsset(assetInput(harness.sourceRoot, {
      assetId: "asset-legacy",
      renditions: [
        { artifactId: "artifact-legacy-source", phase: "source", sourceRoot: legacyRoot, sourceRelativePath: "legacy.jpg" },
        { artifactId: "artifact-final", phase: "final", sourceRoot: harness.sourceRoot, sourceRelativePath: "final.png" }
      ]
    }))).rejects.toMatchObject({ code: "path_unsafe" });
  });
});
