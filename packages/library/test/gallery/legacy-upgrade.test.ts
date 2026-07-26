import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LibraryError } from "../../src/errors";
import { ImageLibraryIndexStore } from "../../src/gallery/index-store";

const roots: string[] = [];
const createdAt = "2026-07-26T00:00:00.000Z";
const sha = "a".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function legacyIndex(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const params = {
    kind: "generate",
    prompt: "legacy image",
    references: [],
    supportingImages: [],
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
  return {
    schemaVersion: 1,
    revision: 3,
    blobs: [{
      sha256: sha, relativePath: `blobs/2026/07/${sha}.png`, mimeType: "image/png",
      byteLength: 12, width: 2, height: 2, createdAt
    }],
    assets: [{
      id: "asset-legacy", prompt: "legacy image", model: "legacy-model", kind: "generate",
      status: "succeeded", primaryArtifactId: "artifact-legacy", createdAt, updatedAt: createdAt,
      requestedParams: params, effectiveParams: params,
      execution: {
        attemptCount: 1, providerRequestCount: 0, receivedAnyOutput: true,
        mayHaveBilled: false, degradedContinuation: false, providerImageIds: []
      },
      renditions: [{ artifactId: "artifact-legacy", phase: "final", blobSha256: sha, createdAt }],
      relationships: [{
        id: "relationship-output", role: "output", relatedAssetId: "asset-legacy",
        artifactId: "artifact-legacy", order: 0
      }],
      folderIds: []
    }],
    folders: [],
    ...overrides
  };
}

async function storeFor(value: Record<string, unknown>): Promise<ImageLibraryIndexStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), "routego-legacy-upgrade-"));
  roots.push(root);
  await writeFile(path.join(root, "index.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return new ImageLibraryIndexStore({ root });
}

describe("legacy Library upgrade", () => {
  it("requires confirmation, preserves the source backup, and promotes the supported v1 generation index", async () => {
    const store = await storeFor(legacyIndex());
    const before = await readFile(store.paths.index, "utf8");
    const inspection = await store.inspectLegacyUpgrade();

    expect(inspection.status).toBe("ready");
    if (inspection.status !== "ready") throw new Error("expected ready legacy migration");
    await store.confirmLegacyUpgrade(inspection.fingerprint);

    expect(await store.read()).toMatchObject({ schemaVersion: 2, revision: 3 });
    expect(await readFile(path.join(store.paths.root, `index.json.routego-v1-backup-${inspection.fingerprint.slice(0, 16)}`), "utf8"))
      .toBe(before);
  });

  it("blocks unsupported legacy records and leaves the source untouched", async () => {
    const source = legacyIndex({ assets: [{ kind: "edit" }] });
    const store = await storeFor(source);
    const before = await readFile(store.paths.index, "utf8");

    expect(await store.inspectLegacyUpgrade()).toMatchObject({ status: "blocked" });
    expect(await readFile(store.paths.index, "utf8")).toBe(before);
  });

  it("rejects a stale fingerprint without changing the source", async () => {
    const store = await storeFor(legacyIndex());
    const inspection = await store.inspectLegacyUpgrade();
    if (inspection.status !== "ready") throw new Error("expected ready legacy migration");
    const before = await readFile(store.paths.index, "utf8");

    await expect(store.confirmLegacyUpgrade("b".repeat(64))).rejects.toMatchObject<Partial<LibraryError>>({
      code: "conflict"
    });
    expect(await readFile(store.paths.index, "utf8")).toBe(before);
  });
});
