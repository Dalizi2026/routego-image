import { cp, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  OfflineBackgroundRemovalResourceError,
  verifyBackgroundRemovalResources
} from "../src/runtime/background-removal-resources";

const RESOURCE_DIRECTORY = path.resolve(import.meta.dirname, "../resources/background-removal");
const MANIFEST_PATH = path.resolve(import.meta.dirname, "../src/runtime/resource-manifest.json");
let temporaryRoot: string | undefined;

afterAll(async () => {
  if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
});

describe("offline background-removal resources", () => {
  it("verifies every pinned model and WASM resource without a network path", async () => {
    const verified = await verifyBackgroundRemovalResources({
      manifestPath: MANIFEST_PATH,
      resourceDirectory: RESOURCE_DIRECTORY
    });

    expect([...verified.resources.keys()].sort()).toEqual([
      "onnxruntime-web-simd-threaded",
      "onnxruntime-web-simd-threaded-jsep",
      "onnxruntime-web-simd-threaded-loader",
      "u2netp-model"
    ]);
  }, 30_000);

  it("fails closed when a packaged resource is missing or altered", async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "routego-background-removal-resources-"));
    const copiedResources = path.join(temporaryRoot, "resources");
    const copiedManifest = path.join(temporaryRoot, "resource-manifest.json");
    await Promise.all([
      cp(RESOURCE_DIRECTORY, copiedResources, { recursive: true }),
      cp(MANIFEST_PATH, copiedManifest)
    ]);

    await unlink(path.join(copiedResources, "u2netp.onnx"));
    await expect(verifyBackgroundRemovalResources({
      manifestPath: copiedManifest,
      resourceDirectory: copiedResources
    })).rejects.toBeInstanceOf(OfflineBackgroundRemovalResourceError);

    await cp(path.join(RESOURCE_DIRECTORY, "u2netp.onnx"), path.join(copiedResources, "u2netp.onnx"));
    const wasm = path.join(copiedResources, "ort-wasm-simd-threaded.wasm");
    const bytes = await readFile(wasm);
    bytes[0] = bytes[0] === 0 ? 1 : 0;
    await writeFile(wasm, bytes);
    await expect(verifyBackgroundRemovalResources({
      manifestPath: copiedManifest,
      resourceDirectory: copiedResources
    })).rejects.toThrow(/integrity mismatch/u);
  }, 30_000);
});
