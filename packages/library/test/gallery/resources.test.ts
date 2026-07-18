import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import type { StoredImageBlob } from "../../src/gallery/model";
import { BrowserResourceRegistry } from "../../src/gallery/resources";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createHarness() {
  const root = await mkdtemp(path.join(os.tmpdir(), "routego-resources-"));
  roots.push(root);
  const imageRelativePath = "blobs/2026/07/image.png";
  const zipRelativePath = "exports/library.zip";
  const imageBytes = Buffer.from("synthetic-image-resource", "utf8");
  const zipBytes = Buffer.from("PK\u0003\u0004synthetic-zip-resource", "binary");
  await Promise.all([
    mkdir(path.join(root, "blobs", "2026", "07"), { recursive: true }),
    mkdir(path.join(root, "exports"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(root, ...imageRelativePath.split("/")), imageBytes),
    writeFile(path.join(root, ...zipRelativePath.split("/")), zipBytes)
  ]);
  let nowMs = Date.parse("2026-07-18T06:00:00.000Z");
  let id = 0;
  const registry = new BrowserResourceRegistry({
    root,
    ttlMs: 60_000,
    now: () => new Date(nowMs),
    idFactory: (rendition) => `resource-${rendition}-${++id}`
  });
  const blob: StoredImageBlob = {
    sha256: sha256(imageBytes),
    relativePath: imageRelativePath,
    mimeType: "image/png",
    byteLength: imageBytes.byteLength,
    width: 16,
    height: 12,
    createdAt: "2026-07-18T05:00:00.000Z"
  };
  return {
    root,
    registry,
    blob,
    zip: {
      relativePath: zipRelativePath,
      byteLength: zipBytes.byteLength,
      sha256: sha256(zipBytes)
    },
    advance(milliseconds: number) {
      nowMs += milliseconds;
    }
  };
}

describe("short-lived protected browser resources", () => {
  it("registers thumbnail, preview, original, and ZIP descriptors without backing paths", async () => {
    const { root, registry, blob, zip } = await createHarness();
    const descriptors = await Promise.all([
      registry.registerImage(blob, "thumbnail"),
      registry.registerImage(blob, "preview"),
      registry.registerImage(blob, "original"),
      registry.registerZip(zip)
    ]);
    expect(descriptors.map((descriptor) => descriptor.mimeType)).toEqual([
      "image/png",
      "image/png",
      "image/png",
      "application/zip"
    ]);
    for (const descriptor of descriptors) {
      expect(descriptor.relativeUrl).toBe(
        `/api/v1/library/resources/${descriptor.resourceId}`
      );
      expect(descriptor.requiresSession).toBe(true);
      expect(descriptor.etag).toMatch(/^sha256-[a-f0-9]{64}$/u);
      expect(JSON.stringify(descriptor)).not.toContain(root);
      expect(JSON.stringify(descriptor)).not.toContain("path");
    }
    expect(descriptors[3]).not.toHaveProperty("width");
    expect(descriptors[3]).not.toHaveProperty("height");
    expect(registry.resolve(descriptors[1]!.resourceId)).toMatchObject({
      rendition: "preview",
      mimeType: "image/png",
      width: 16,
      height: 12
    });
    expect(path.isAbsolute(registry.resolve(descriptors[3]!.resourceId).path)).toBe(true);
  });

  it("expires registrations lazily and removes them without exposing paths", async () => {
    const { registry, blob, advance } = await createHarness();
    const descriptor = await registry.registerImage(blob, "preview");
    advance(60_001);
    expect(() => registry.resolve(descriptor.resourceId)).toThrowError(
      expect.objectContaining({ code: "not_found" })
    );
    expect(registry.cleanupExpired()).toBe(0);
  });

  it("rejects traversal, missing files, and metadata mismatches before registration", async () => {
    const { root, registry, blob, zip } = await createHarness();
    await expect(
      registry.registerZip({ ...zip, relativePath: "../outside.zip" })
    ).rejects.toMatchObject({ code: "path_unsafe" });
    await expect(
      registry.registerImage({ ...blob, relativePath: "blobs/2026/07/missing.png" }, "original")
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      registry.registerImage({ ...blob, byteLength: blob.byteLength + 1 }, "thumbnail")
    ).rejects.toMatchObject({ code: "path_unsafe" });
    await writeFile(
      path.join(root, ...blob.relativePath.split("/")),
      Buffer.alloc(blob.byteLength, 0x61)
    );
    await expect(registry.registerImage(blob, "preview")).rejects.toMatchObject({
      code: "config_corrupt"
    });
  });
});
