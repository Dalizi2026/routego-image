import { deflateSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";
import type { LibraryMutationRequest, LibraryOperationParameters } from "@routego-image/contracts";

import { LibraryAssetStore } from "../../src/gallery/assets";
import { ImageLibraryIndexStore } from "../../src/gallery/index-store";
import { LibraryMutationStore } from "../../src/gallery/mutations";

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
  readonly indexHooks?: ConstructorParameters<typeof ImageLibraryIndexStore>[0]["hooks"];
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
  const indexStore = new ImageLibraryIndexStore({
    root: libraryRoot,
    ...(options.indexHooks === undefined ? {} : { hooks: options.indexHooks })
  });
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
  const mutations = new LibraryMutationStore({ indexStore, protectedRoots: [] });
  return { assets, indexStore, mutations, sourceRoot };
}

async function execute(mutations: LibraryMutationStore, mutation: LibraryMutationRequest) {
  const preflight = await mutations.preflight({ mutation });
  const result = await mutations.execute({
    preflightId: preflight.preflightId,
    action: mutation.action,
    confirmations: []
  });
  return { preflight, result };
}

describe("current generation mark mutations", () => {
  it("atomically replaces and cancels the one persistent mark", async () => {
    const { indexStore, mutations } = await createHarness();

    const first = await execute(mutations, { action: "mark", assetIds: ["asset-one"] });
    expect(first.result.status).toBe("succeeded");
    expect((await indexStore.read()).currentMarkRecordId).toBe("asset-one");

    const replacement = await execute(mutations, { action: "mark", assetIds: ["asset-unique"] });
    expect(replacement.result.status).toBe("succeeded");
    expect((await indexStore.read()).currentMarkRecordId).toBe("asset-unique");

    const cancellation = await execute(mutations, { action: "mark", assetIds: ["asset-unique"] });
    expect(cancellation.result.status).toBe("succeeded");
    expect((await indexStore.read()).currentMarkRecordId).toBeUndefined();
  });

  it("keeps the existing mark when a target is missing and when generation is ingested", async () => {
    const { assets, indexStore, mutations, sourceRoot } = await createHarness();
    await execute(mutations, { action: "mark", assetIds: ["asset-one"] });

    const missing = await execute(mutations, { action: "mark", assetIds: ["asset-missing"] });
    expect(missing.preflight.status).toBe("blocked");
    expect(missing.result.status).toBe("failed");
    expect((await indexStore.read()).currentMarkRecordId).toBe("asset-one");

    const prompt = "Synthetic ingestion keeps the current mark";
    await assets.ingestAsset({
      assetId: "asset-later",
      primaryArtifactId: "artifact-later",
      prompt,
      model: "mutation-model",
      requestedParams: parameters(prompt),
      effectiveParams: parameters(prompt),
      execution,
      renditions: [
        {
          artifactId: "artifact-later",
          phase: "final",
          sourceRoot,
          sourceRelativePath: "unique.png"
        }
      ],
      createdAt: "2026-07-18T07:00:00.000Z",
      updatedAt: "2026-07-18T07:00:00.000Z"
    });
    expect((await indexStore.read()).currentMarkRecordId).toBe("asset-one");
  });

  it("does not replace the persisted mark when the atomic index commit is rejected", async () => {
    const { indexStore, mutations } = await createHarness({
      indexHooks: {
        beforeIndexCommit: async (next) => {
          if (next.currentMarkRecordId === "asset-unique") {
            throw new Error("synthetic index commit rejection");
          }
        }
      }
    });
    await execute(mutations, { action: "mark", assetIds: ["asset-one"] });

    await expect(
      execute(mutations, { action: "mark", assetIds: ["asset-unique"] })
    ).rejects.toThrow("synthetic index commit rejection");
    expect((await indexStore.read()).currentMarkRecordId).toBe("asset-one");
  });
});
