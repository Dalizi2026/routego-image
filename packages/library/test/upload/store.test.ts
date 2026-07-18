import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { UploadStore } from "../../src/upload/store";
import {
  chunked,
  sha256,
  syntheticJpeg,
  syntheticPng,
  syntheticWebp,
  syntheticZipHeader
} from "./fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createStore(options: ConstructorParameters<typeof UploadStore>[0] = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "routego-upload-"));
  roots.push(root);
  let sequence = 0;
  let current = new Date("2026-01-01T00:00:00.000Z");
  const store = new UploadStore({
    dataRoot: root,
    homeDirectory: path.join(root, "home"),
    idFactory: () => `upload-synthetic-${++sequence}`,
    now: () => new Date(current),
    ...options
  });
  return {
    root,
    store,
    advance(milliseconds: number) {
      current = new Date(current.getTime() + milliseconds);
    }
  };
}

async function reserve(
  store: UploadStore,
  options: {
    readonly purpose?: "image" | "reference" | "target" | "supporting" | "mask" | "zip-import";
    readonly mimeType?: "image/png" | "image/jpeg" | "image/webp" | "application/zip";
    readonly bytes: Uint8Array;
    readonly expectedSha256?: string;
  }
) {
  const result = await store.reserveUploadResource({
    purpose: options.purpose ?? "image",
    declaredMimeType: options.mimeType ?? "image/png",
    declaredByteLength: options.bytes.byteLength,
    ...(options.expectedSha256 === undefined ? {} : { expectedSha256: options.expectedSha256 })
  });
  if (result.status !== "succeeded" || !result.resource) throw new Error("reservation failed");
  return result.resource;
}

async function stageAndFinalize(store: UploadStore, resourceId: string, bytes: Uint8Array) {
  expect((await store.stageUpload(resourceId, chunked(bytes))).status).toBe("uploaded");
  const result = await store.finalizeUploadResource({ uploadResourceId: resourceId });
  expect(result.status).toBe("succeeded");
  return result.resource!;
}

describe("durable upload staging and lifecycle", () => {
  it("reserves every purpose with the frozen MIME, size, route, expiry, and reuse policies", async () => {
    const { store, root } = await createStore();
    const cases = [
      ["image", "image/png"],
      ["reference", "image/jpeg"],
      ["target", "image/webp"],
      ["supporting", "image/png"],
      ["mask", "image/png"],
      ["zip-import", "application/zip"]
    ] as const;
    for (const [purpose, mimeType] of cases) {
      const bytes = purpose === "zip-import" ? syntheticZipHeader() : syntheticPng();
      const resource = await reserve(store, { purpose, mimeType, bytes });
      expect(resource).toMatchObject({
        purpose,
        status: "reserved",
        reusePolicy:
          purpose === "zip-import" ? "single-consume" : "reusable-until-expiry",
        binaryUpload: {
          method: "PUT",
          requiresSession: true,
          requiresOrigin: true,
          maxBytes: purpose === "zip-import" ? 536_870_912 : 52_428_800
        }
      });
      expect(resource.binaryUpload.relativeUrl).toBe(
        `/api/v1/uploads/${resource.uploadResourceId}/content`
      );
      expect(JSON.stringify(resource)).not.toContain(root);
      expect(JSON.stringify(resource)).not.toContain("path");
    }
  });

  it("stages and finalizes PNG, JPEG, WebP, mask, and ZIP bytes with exact metadata", async () => {
    const { store } = await createStore();
    const cases = [
      ["image", "image/png", syntheticPng(3, 2), 3, 2],
      ["reference", "image/jpeg", syntheticJpeg(4, 3), 4, 3],
      ["target", "image/webp", syntheticWebp(5, 4), 5, 4],
      ["mask", "image/png", syntheticPng(6, 7), 6, 7],
      ["zip-import", "application/zip", syntheticZipHeader(), undefined, undefined]
    ] as const;
    for (const [purpose, mimeType, bytes, width, height] of cases) {
      const resource = await reserve(store, {
        purpose,
        mimeType,
        bytes,
        expectedSha256: sha256(bytes)
      });
      const finalized = await stageAndFinalize(store, resource.uploadResourceId, bytes);
      expect(finalized.finalized).toMatchObject({
        detectedMimeType: mimeType,
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height })
      });
    }
  });

  it("stops an oversized stream, removes incomplete bytes, and records failure", async () => {
    const { store } = await createStore({ imageMaxBytes: 8 });
    const bytes = Buffer.from([1, 2, 3, 4]);
    const resource = await reserve(store, { bytes });
    let pulls = 0;
    async function* oversized() {
      pulls += 1;
      yield Buffer.alloc(4, 1);
      pulls += 1;
      yield Buffer.alloc(5, 2);
      pulls += 1;
      yield Buffer.alloc(1, 3);
    }
    await expect(store.stageUpload(resource.uploadResourceId, oversized())).rejects.toMatchObject({
      code: "upload_oversize"
    });
    expect(pulls).toBe(2);
    const status = await store.getUploadResourceStatus({
      uploadResourceId: resource.uploadResourceId
    });
    expect(status).toMatchObject({ status: "failed", error: { code: "upload_oversize" } });
    expect(await readdir(store.paths.objects)).toEqual([]);
  });

  it("rejects wrong-purpose MIME, corrupt headers, and checksum mismatches", async () => {
    const { store } = await createStore();
    const jpeg = syntheticJpeg();
    const mask = await reserve(store, { purpose: "mask", mimeType: "image/png", bytes: jpeg });
    await store.stageUpload(mask.uploadResourceId, chunked(jpeg));
    expect(await store.finalizeUploadResource({ uploadResourceId: mask.uploadResourceId })).toMatchObject({
      status: "failed",
      error: { code: "upload_invalid_type" }
    });

    const corrupt = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const corruptResource = await reserve(store, { bytes: corrupt });
    await store.stageUpload(corruptResource.uploadResourceId, chunked(corrupt));
    expect(
      await store.finalizeUploadResource({ uploadResourceId: corruptResource.uploadResourceId })
    ).toMatchObject({ status: "failed", error: { code: "upload_invalid_type" } });

    const png = syntheticPng();
    const checksum = await reserve(store, {
      bytes: png,
      expectedSha256: "0".repeat(64)
    });
    await store.stageUpload(checksum.uploadResourceId, chunked(png));
    expect(
      await store.finalizeUploadResource({ uploadResourceId: checksum.uploadResourceId })
    ).toMatchObject({ status: "failed", error: { code: "upload_checksum_failed" } });
  });

  it("expires lazily, discards safely, and reports unknown resources without paths", async () => {
    const { store, advance, root } = await createStore();
    const png = syntheticPng();
    const expiring = await reserve(store, { bytes: png });
    await stageAndFinalize(store, expiring.uploadResourceId, png);
    advance(5 * 60 * 1_000 + 1);
    const expired = await store.getUploadResourceStatus({
      uploadResourceId: expiring.uploadResourceId
    });
    expect(expired).toMatchObject({ status: "failed", error: { code: "upload_expired" } });
    expect(JSON.stringify(expired)).not.toContain(root);
    await expect(store.resolveUploadResource(expiring.uploadResourceId)).rejects.toMatchObject({
      code: "upload_expired"
    });

    const discardable = await reserve(store, { bytes: png });
    await store.stageUpload(discardable.uploadResourceId, chunked(png));
    expect(
      await store.discardUploadResource({ uploadResourceId: discardable.uploadResourceId })
    ).toMatchObject({ status: "succeeded", resource: { status: "discarded" } });
    expect(
      await store.getUploadResourceStatus({ uploadResourceId: discardable.uploadResourceId })
    ).toMatchObject({ status: "failed", error: { code: "upload_discarded" } });
    expect(
      await store.getUploadResourceStatus({ uploadResourceId: "upload-does-not-exist" })
    ).toMatchObject({ status: "failed", error: { code: "not_found" } });
  });

  it("resolves reusable images repeatedly and consumes ZIP only after an explicit commit signal", async () => {
    const { store } = await createStore();
    const png = syntheticPng();
    const image = await reserve(store, { bytes: png });
    await stageAndFinalize(store, image.uploadResourceId, png);
    const first = await store.resolveUploadResource(image.uploadResourceId, ["image"]);
    const second = await store.resolveUploadResource(image.uploadResourceId, ["image"]);
    expect(second).toEqual(first);
    expect(first.path).toContain(path.join("uploads", "objects"));

    const zipBytes = syntheticZipHeader();
    const zip = await reserve(store, {
      purpose: "zip-import",
      mimeType: "application/zip",
      bytes: zipBytes
    });
    await stageAndFinalize(store, zip.uploadResourceId, zipBytes);
    await expect(store.resolveUploadResource(zip.uploadResourceId, ["zip-import"])).resolves.toMatchObject({
      mimeType: "application/zip"
    });
    // A failed import performs no consumption call, so the finalized resource remains reusable here.
    await expect(store.resolveUploadResource(zip.uploadResourceId, ["zip-import"])).resolves.toBeDefined();
    await store.consumeZipUpload(zip.uploadResourceId);
    await expect(store.resolveUploadResource(zip.uploadResourceId)).rejects.toMatchObject({
      code: "upload_consumed"
    });
  });

  it("recovers interrupted staging without deleting unknown files and serializes duplicate writers", async () => {
    const { store } = await createStore();
    const png = syntheticPng();
    const interrupted = await reserve(store, { bytes: png });
    const stalePart = path.join(store.paths.objects, `${interrupted.uploadResourceId}.bin.part`);
    await writeFile(stalePart, "synthetic-partial", "utf8");
    expect(
      await store.getUploadResourceStatus({ uploadResourceId: interrupted.uploadResourceId })
    ).toMatchObject({ status: "succeeded", resource: { status: "reserved" } });
    await expect(access(stalePart)).rejects.toMatchObject({ code: "ENOENT" });

    async function* failsMidStream() {
      yield png.subarray(0, 8);
      throw new Error("synthetic interruption");
    }
    await expect(store.stageUpload(interrupted.uploadResourceId, failsMidStream())).rejects.toThrow(
      /synthetic interruption/u
    );
    expect(
      await store.getUploadResourceStatus({ uploadResourceId: interrupted.uploadResourceId })
    ).toMatchObject({ status: "succeeded", resource: { status: "reserved" } });
    await store.stageUpload(interrupted.uploadResourceId, chunked(png));

    const concurrent = await reserve(store, { bytes: png });
    const attempts = await Promise.allSettled([
      store.stageUpload(concurrent.uploadResourceId, chunked(png, 3)),
      store.stageUpload(concurrent.uploadResourceId, chunked(Buffer.from(png), 5))
    ]);
    expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(
      await store.finalizeUploadResource({ uploadResourceId: concurrent.uploadResourceId })
    ).toMatchObject({ status: "succeeded" });
  });

  it("skips unregistered on-disk collisions instead of deleting unknown files", async () => {
    let sequence = 0;
    const ids = ["upload-collision", "upload-safe"];
    const { store } = await createStore({ idFactory: () => ids[sequence++]! });
    await mkdir(store.paths.objects, { recursive: true });
    const unknown = path.join(store.paths.objects, "upload-collision.bin");
    await writeFile(unknown, "synthetic-unknown-file", "utf8");
    const resource = await reserve(store, { bytes: syntheticPng() });
    expect(resource.uploadResourceId).toBe("upload-safe");
    expect(await readFile(unknown, "utf8")).toBe("synthetic-unknown-file");
  });

  it("detects missing or modified finalized bytes before resolving them", async () => {
    const { store } = await createStore();
    const png = syntheticPng();
    const modified = await reserve(store, { bytes: png });
    await stageAndFinalize(store, modified.uploadResourceId, png);
    const resolved = await store.resolveUploadResource(modified.uploadResourceId);
    await writeFile(resolved.path, syntheticPng(9, 9));
    await expect(store.resolveUploadResource(modified.uploadResourceId)).rejects.toMatchObject({
      code: "upload_checksum_failed"
    });

    const refinalized = await reserve(store, { bytes: png });
    await stageAndFinalize(store, refinalized.uploadResourceId, png);
    const refinalizedPath = path.join(
      store.paths.objects,
      `${refinalized.uploadResourceId}.bin`
    );
    await writeFile(refinalizedPath, syntheticPng(8, 8));
    expect(
      await store.finalizeUploadResource({ uploadResourceId: refinalized.uploadResourceId })
    ).toMatchObject({ status: "failed", error: { code: "upload_checksum_failed" } });

    const missing = await reserve(store, { bytes: png });
    await store.stageUpload(missing.uploadResourceId, chunked(png));
    const stagedPath = path.join(store.paths.objects, `${missing.uploadResourceId}.bin`);
    await rm(stagedPath, { force: true });
    expect(
      await store.getUploadResourceStatus({ uploadResourceId: missing.uploadResourceId })
    ).toMatchObject({ status: "failed", error: { code: "upload_checksum_failed" } });
  });

  it("expires a resource that crosses its deadline while bytes are streaming", async () => {
    const { store, advance } = await createStore();
    const png = syntheticPng();
    const resource = await reserve(store, { bytes: png });
    async function* slowStream() {
      yield png.subarray(0, 8);
      advance(5 * 60 * 1_000 + 1);
      yield png.subarray(8);
    }
    await expect(store.stageUpload(resource.uploadResourceId, slowStream())).rejects.toMatchObject({
      code: "upload_expired"
    });
    expect(
      await store.getUploadResourceStatus({ uploadResourceId: resource.uploadResourceId })
    ).toMatchObject({ status: "failed", error: { code: "upload_expired" } });
  });

  it("rejects a future upload registry without downgrading to its older backup", async () => {
    const { store } = await createStore();
    await reserve(store, { bytes: syntheticPng() });
    await writeFile(store.paths.registry, JSON.stringify({ schemaVersion: 2 }), "utf8");
    await expect(
      store.getUploadResourceStatus({ uploadResourceId: "upload-synthetic-1" })
    ).rejects.toMatchObject({ code: "unsupported_version" });
    expect(JSON.parse(await readFile(store.paths.registry, "utf8"))).toEqual({ schemaVersion: 2 });
  });

  it("cleans all expired active records through the explicit cleanup pass", async () => {
    const { store, advance } = await createStore();
    const png = syntheticPng();
    await reserve(store, { bytes: png });
    await reserve(store, { bytes: png });
    advance(5 * 60 * 1_000 + 1);
    expect(await store.cleanupExpired()).toBe(2);
    expect(await store.cleanupExpired()).toBe(0);
  });
});
