import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";

import { imageArtifactSchema, type ImageArtifact } from "@routego-image/contracts";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyPngChromakey,
  type ChromakeyContentClass
} from "../src/image/chromakey";
import {
  DEFAULT_MAX_MATERIALIZED_IMAGE_BYTES,
  ImageMaterializationError,
  MAX_OPERATION_RENDITIONS,
  assertOperationRenditionBound,
  createOutputMaterializationTransaction,
  type MaterializedImageOutput,
  type OutputMaterializationTransaction
} from "../src/image/materialize";
import { normalizeProviderRasterOutput } from "../src/image/resize";
import {
  EPHEMERAL_IMAGE_RESOURCE_TTL_MS,
  EphemeralImageResourceError,
  MAX_EPHEMERAL_IMAGE_RESOURCES,
  createEphemeralImageResourceRegistry,
  type EphemeralImageResourceRegistry
} from "../src/runtime/ephemeral-resources";

const roots: string[] = [];
const registries: EphemeralImageResourceRegistry[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(registries.splice(0).map(async (registry) => await registry.shutdown().catch(() => 0)));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix = "routego-image-task-3-2-"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pngBytes(input: {
  readonly width?: number;
  readonly height?: number;
  readonly pixel?: (x: number, y: number) => readonly [number, number, number, number];
} = {}): Uint8Array {
  const width = input.width ?? 3;
  const height = input.height ?? 3;
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const [red, green, blue, alpha] = input.pixel?.(x, y) ?? [32, 96, 224, 255];
      png.data[offset] = red;
      png.data[offset + 1] = green;
      png.data[offset + 2] = blue;
      png.data[offset + 3] = alpha;
    }
  }
  return new Uint8Array(
    PNG.sync.write(png, {
      colorType: 6,
      inputColorType: 6,
      inputHasAlpha: true,
      bitDepth: 8,
      deflateLevel: 9,
      deflateStrategy: 3,
      filterType: 4
    })
  );
}

function crc32(bytes: Buffer, start: number, end: number): number {
  let crc = 0xffff_ffff;
  for (let position = start; position < end; position += 1) {
    crc ^= bytes[position]!;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function boundedHeaderOnlyPng(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(45);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  bytes[26] = 0;
  bytes[27] = 0;
  bytes[28] = 0;
  bytes.writeUInt32BE(crc32(bytes, 12, 29), 29);
  bytes.writeUInt32BE(0, 33);
  bytes.write("IEND", 37, "ascii");
  bytes.writeUInt32BE(crc32(bytes, 37, 41), 41);
  return new Uint8Array(bytes);
}

function jpegBytes(width = 3, height = 2): Uint8Array {
  return Uint8Array.of(
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x08,
    0x08,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    0x01
  );
}

function webpBytes(width = 4, height = 3): Uint8Array {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return new Uint8Array(bytes);
}

function artifact(input: {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly width: number;
  readonly height: number;
  readonly phase?: "partial" | "final";
  readonly slot?: number;
}): ImageArtifact {
  return imageArtifactSchema.parse({
    id: input.id,
    slot: input.slot ?? 0,
    phase: input.phase ?? "final",
    mimeType: input.mimeType,
    byteLength: input.bytes.byteLength,
    width: input.width,
    height: input.height,
    sha256: sha256(input.bytes),
    display: {
      type: "image",
      dataUrl: `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString("base64")}`
    },
    createdAt: "2026-07-18T12:00:00.000Z"
  });
}

function expectMaterializationCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof ImageMaterializationError && error.code === code;
}

function expectResourceCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof EphemeralImageResourceError && error.code === code;
}

async function materializedPng(input: {
  readonly root: string;
  readonly id?: string;
  readonly bytes?: Uint8Array;
}): Promise<{
  readonly transaction: OutputMaterializationTransaction;
  readonly output: MaterializedImageOutput;
  readonly bytes: Uint8Array;
}> {
  const bytes = input.bytes ?? pngBytes();
  const transaction = await createOutputMaterializationTransaction({
    stagingRoot: path.join(input.root, "transactions"),
    requestId: `request-${input.id ?? "image"}`
  });
  const output = await transaction.materializeArtifact(
    artifact({
      id: input.id ?? "artifact-image",
      bytes,
      mimeType: "image/png",
      width: 3,
      height: 3
    })
  );
  return { transaction, output, bytes };
}

async function registry(input: {
  readonly root: string;
  readonly now: () => Date;
  readonly idFactory?: () => string;
  readonly removeFile?: (filePath: string) => Promise<void>;
}): Promise<EphemeralImageResourceRegistry> {
  const created = await createEphemeralImageResourceRegistry({
    root: path.join(input.root, "ephemeral"),
    now: input.now,
    ...(input.idFactory === undefined ? {} : { idFactory: input.idFactory }),
    ...(input.removeFile === undefined ? {} : { removeFile: input.removeFile })
  });
  registries.push(created);
  return created;
}

describe("bounded output materialization", () => {
  it("accepts the 4096 raster boundary without allocating an output and rejects larger targets", async () => {
    const output: MaterializedImageOutput = {
      artifactId: "artifact-webp-boundary",
      slot: 0,
      phase: "final",
      path: "/not-read.webp",
      mimeType: "image/webp",
      byteLength: 30,
      width: 8,
      height: 8,
      sha256: "0".repeat(64),
      createdAt: "2026-07-27T12:00:00.000Z",
      source: "provider-original"
    };
    const transaction = {} as OutputMaterializationTransaction;

    await expect(normalizeProviderRasterOutput({
      transaction,
      output,
      targetWidth: 4_096,
      targetHeight: 4_096,
      targetMimeType: "image/jpeg"
    })).resolves.toBeUndefined();
    await expect(normalizeProviderRasterOutput({
      transaction,
      output,
      targetWidth: 4_097,
      targetHeight: 4_096,
      targetMimeType: "image/jpeg"
    })).rejects.toMatchObject({ code: "metadata-mismatch" });
  });

  it("materializes PNG, JPEG, and WebP only after exact metadata and checksum validation", async () => {
    const root = await temporaryRoot();
    const png = pngBytes({ width: 3, height: 2 });
    const jpeg = jpegBytes(3, 2);
    const webp = webpBytes(4, 3);
    const transaction = await createOutputMaterializationTransaction({
      stagingRoot: path.join(root, "staging"),
      requestId: "request-valid-formats"
    });

    const result = await transaction.materializeArtifacts(
      [
        artifact({
          id: "artifact-png",
          bytes: png,
          mimeType: "image/png",
          width: 3,
          height: 2,
          phase: "partial",
          slot: 0
        }),
        artifact({
          id: "artifact-jpeg",
          bytes: jpeg,
          mimeType: "image/jpeg",
          width: 3,
          height: 2,
          phase: "partial",
          slot: 1
        }),
        artifact({
          id: "artifact-webp",
          bytes: webp,
          mimeType: "image/webp",
          width: 4,
          height: 3,
          slot: 2
        })
      ],
      { sourceCount: 17, mayHaveBilled: false }
    );

    expect(result).toMatchObject({
      failures: [],
      receivedAnyOutput: true,
      mayHaveBilled: true
    });
    expect(result.outputs.map((output) => output.mimeType)).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp"
    ]);
    await expect(readFile(result.outputs[0]!.path)).resolves.toEqual(Buffer.from(png));
    await expect(readFile(result.outputs[1]!.path)).resolves.toEqual(Buffer.from(jpeg));
    await expect(readFile(result.outputs[2]!.path)).resolves.toEqual(Buffer.from(webp));
  });

  it("rejects malformed data, claim drift, and byte limits before publishing a staged output", async () => {
    const root = await temporaryRoot();
    const bytes = pngBytes();
    const base = artifact({
      id: "artifact-invalid",
      bytes,
      mimeType: "image/png",
      width: 3,
      height: 3
    });
    const transaction = await createOutputMaterializationTransaction({
      stagingRoot: path.join(root, "staging"),
      requestId: "request-invalid-claims"
    });

    const malformedDataUrl = {
      ...base,
      display: { type: "image" as const, dataUrl: "data:image/png;base64,%%%" }
    } as ImageArtifact;
    const dataUrlMimeMismatch = {
      ...base,
      mimeType: "image/jpeg" as const
    };
    const detectedMimeMismatch = {
      ...base,
      mimeType: "image/jpeg" as const,
      display: {
        type: "image" as const,
        dataUrl: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`
      }
    };

    await expect(transaction.materializeArtifact(malformedDataUrl)).rejects.toSatisfy(
      expectMaterializationCode("artifact-invalid")
    );
    await expect(transaction.materializeArtifact(dataUrlMimeMismatch)).rejects.toSatisfy(
      expectMaterializationCode("mime-mismatch")
    );
    await expect(transaction.materializeArtifact(detectedMimeMismatch)).rejects.toSatisfy(
      expectMaterializationCode("mime-mismatch")
    );
    await expect(
      transaction.materializeArtifact({ ...base, byteLength: bytes.byteLength + 1 })
    ).rejects.toSatisfy(expectMaterializationCode("metadata-mismatch"));
    await expect(transaction.materializeArtifact({ ...base, width: 4 })).rejects.toSatisfy(
      expectMaterializationCode("metadata-mismatch")
    );
    await expect(transaction.materializeArtifact({ ...base, sha256: "0".repeat(64) })).rejects.toSatisfy(
      expectMaterializationCode("hash-mismatch")
    );

    const bounded = await createOutputMaterializationTransaction({
      stagingRoot: path.join(root, "bounded"),
      requestId: "request-bounded",
      maximumImageBytes: bytes.byteLength - 1
    });
    await expect(bounded.materializeArtifact(base)).rejects.toSatisfy(
      expectMaterializationCode("image-too-large")
    );
    await expect(
      createOutputMaterializationTransaction({
        stagingRoot: path.join(root, "oversized-policy"),
        requestId: "request-oversized-policy",
        maximumImageBytes: DEFAULT_MAX_MATERIALIZED_IMAGE_BYTES + 1
      })
    ).rejects.toSatisfy(expectMaterializationCode("rendition-limit"));
  });

  it("preserves earlier and later valid outputs when one slot fails and retains billing evidence", async () => {
    const root = await temporaryRoot();
    const bytes = pngBytes();
    const first = artifact({
      id: "artifact-partial-first",
      bytes,
      mimeType: "image/png",
      width: 3,
      height: 3,
      phase: "partial",
      slot: 0
    });
    const invalid = {
      ...artifact({
        id: "artifact-final-invalid",
        bytes,
        mimeType: "image/png",
        width: 3,
        height: 3,
        slot: 1
      }),
      sha256: "f".repeat(64)
    };
    const last = artifact({
      id: "artifact-final-last",
      bytes,
      mimeType: "image/png",
      width: 3,
      height: 3,
      slot: 2
    });
    const transaction = await createOutputMaterializationTransaction({
      stagingRoot: path.join(root, "staging"),
      requestId: "request-partial-preservation"
    });

    const result = await transaction.materializeArtifacts([first, invalid, last], {
      mayHaveBilled: true
    });
    expect(result.outputs.map((output) => output.artifactId)).toEqual([
      "artifact-partial-first",
      "artifact-final-last"
    ]);
    expect(result.failures).toEqual([
      expect.objectContaining({
        artifactId: "artifact-final-invalid",
        code: "hash-mismatch"
      })
    ]);
    expect(result).toMatchObject({ receivedAnyOutput: true, mayHaveBilled: true });
    await expect(readFile(result.outputs[0]!.path)).resolves.toEqual(Buffer.from(bytes));

    const failureOnlyTransaction = await createOutputMaterializationTransaction({
      stagingRoot: path.join(root, "failure-only"),
      requestId: "request-failure-only"
    });
    const failureOnly = await failureOnlyTransaction.materializeArtifacts(
      [{ ...invalid, id: "artifact-failure-only" }],
      { mayHaveBilled: true }
    );
    expect(failureOnly).toMatchObject({
      outputs: [],
      receivedAnyOutput: false,
      mayHaveBilled: true
    });
  });

  it("uses exclusive request and output names and cleans only the transaction-owned directory", async () => {
    const root = await temporaryRoot();
    const stagingRoot = path.join(root, "staging");
    const sibling = path.join(stagingRoot, "keep.txt");
    await mkdir(stagingRoot, { recursive: true });
    await writeFile(sibling, "keep", "utf8");
    const first = await createOutputMaterializationTransaction({
      stagingRoot,
      requestId: "same-request"
    });
    const second = await createOutputMaterializationTransaction({
      stagingRoot,
      requestId: "same-request"
    });
    expect(first.directory).not.toBe(second.directory);

    const bytes = pngBytes();
    const outputArtifact = artifact({
      id: "artifact-exclusive",
      bytes,
      mimeType: "image/png",
      width: 3,
      height: 3
    });
    const identity = sha256(Buffer.from(outputArtifact.id, "utf8")).slice(0, 20);
    const collisionPath = path.join(
      first.directory,
      `provider-original-final-0-${identity}.png`
    );
    await writeFile(collisionPath, "sentinel", "utf8");
    await expect(first.materializeArtifact(outputArtifact)).rejects.toSatisfy(
      expectMaterializationCode("staging-conflict")
    );
    await expect(readFile(collisionPath, "utf8")).resolves.toBe("sentinel");

    await first.cleanup();
    await expect(access(first.directory)).rejects.toBeDefined();
    await expect(readFile(sibling, "utf8")).resolves.toBe("keep");
    await second.cleanup();
  });

  it("serializes cleanup after an in-flight materialization and rejects later writes", async () => {
    const root = await temporaryRoot();
    const transaction = await createOutputMaterializationTransaction({
      stagingRoot: path.join(root, "staging"),
      requestId: "request-cleanup-race"
    });
    const outputArtifact = artifact({
      id: "artifact-cleanup-race",
      bytes: pngBytes(),
      mimeType: "image/png",
      width: 3,
      height: 3
    });
    const events: string[] = [];
    const materializing = transaction.materializeArtifact(outputArtifact).then((output) => {
      events.push("materialized");
      return output;
    });
    const cleaning = transaction.cleanup().then(() => {
      events.push("cleaned");
    });
    const [output] = await Promise.all([materializing, cleaning]);
    expect(events).toEqual(["materialized", "cleaned"]);
    await expect(access(output.path)).rejects.toBeDefined();
    await expect(transaction.materializeArtifact(outputArtifact)).rejects.toSatisfy(
      expectMaterializationCode("transaction-closed")
    );
  });

  it("accepts the exact 17 + 12 + 4 graph and rejects every 34-rendition variant", () => {
    expect(MAX_OPERATION_RENDITIONS).toBe(33);
    expect(() =>
      assertOperationRenditionBound({
        sourceCount: 17,
        partialOutputCount: 12,
        finalOutputCount: 4
      })
    ).not.toThrow();
    for (const counts of [
      { sourceCount: 18, partialOutputCount: 12, finalOutputCount: 4 },
      { sourceCount: 17, partialOutputCount: 13, finalOutputCount: 4 },
      { sourceCount: 17, partialOutputCount: 12, finalOutputCount: 5 }
    ]) {
      expect(() => assertOperationRenditionBound(counts)).toThrowError(
        expect.objectContaining({ code: "rendition-limit" })
      );
    }
  });
});

describe("same-identity PNG chromakey", () => {
  const keyColor = { red: 0, green: 255, blue: 0 } as const;

  it("selects one processed byte stream under the original artifact identity", async () => {
    const root = await temporaryRoot();
    const bytes = pngBytes({
      pixel: (x, y) => (x === 1 && y === 1 ? [220, 30, 30, 255] : [0, 255, 0, 255])
    });
    const { transaction, output } = await materializedPng({
      root,
      id: "artifact-chromakey",
      bytes
    });

    const result = await applyPngChromakey({
      transaction,
      output,
      requestedMode: "chromakey",
      contentClass: "simple",
      keyColor,
      tolerance: 0
    });

    expect(result).toMatchObject({
      status: "applied",
      transparencyApplied: true,
      requestedMode: "chromakey",
      effectiveMode: "chromakey",
      degraded: true,
      removedPixels: 8,
      output: {
        artifactId: output.artifactId,
        slot: output.slot,
        phase: output.phase,
        source: "processed"
      }
    });
    expect(transaction.selectedOutputs).toHaveLength(1);
    expect(transaction.selectedOutput(output.artifactId)?.path).toBe(result.output.path);
    expect(result.output.path).not.toBe(output.path);
    const decoded = PNG.sync.read(await readFile(result.output.path));
    expect(decoded.data[3]).toBe(0);
    expect(decoded.data[(1 * 3 + 1) * 4 + 3]).toBe(255);
    expect(JSON.stringify(result)).not.toContain("transparent-original");
    expect(JSON.stringify(result)).not.toContain("relationship");
  });

  it.each<ChromakeyContentClass>([
    "hair",
    "fur",
    "glass",
    "smoke",
    "liquid",
    "uncertain-edges",
    "unknown"
  ])("refuses complex or uncertain content class %s without changing the selected bytes", async (contentClass) => {
    const root = await temporaryRoot();
    const { transaction, output } = await materializedPng({ root, id: `artifact-${contentClass}` });
    const result = await applyPngChromakey({
      transaction,
      output,
      requestedMode: "chromakey",
      contentClass,
      keyColor,
      tolerance: 8
    });
    expect(result).toMatchObject({
      status: "refused",
      reason: "complex-content",
      transparencyApplied: false,
      effectiveMode: "original",
      output: { path: output.path }
    });
    expect(transaction.selectedOutput(output.artifactId)?.path).toBe(output.path);
  });

  it("requires explicit eligibility before auto mode may select chromakey", async () => {
    const root = await temporaryRoot();
    const bytes = pngBytes({
      pixel: (x, y) => (x === 1 && y === 1 ? [220, 30, 30, 255] : [0, 255, 0, 255])
    });
    const { transaction, output } = await materializedPng({
      root,
      id: "artifact-auto-chromakey",
      bytes
    });
    const refused = await applyPngChromakey({
      transaction,
      output,
      requestedMode: "auto",
      contentClass: "simple",
      keyColor,
      tolerance: 0
    });
    expect(refused).toMatchObject({
      status: "refused",
      reason: "auto-ineligible",
      requestedMode: "auto",
      effectiveMode: "original"
    });
    expect(transaction.selectedOutput(output.artifactId)?.path).toBe(output.path);

    const applied = await applyPngChromakey({
      transaction,
      output,
      requestedMode: "auto",
      autoEligible: true,
      contentClass: "simple",
      keyColor,
      tolerance: 0
    });
    expect(applied).toMatchObject({
      status: "applied",
      requestedMode: "auto",
      effectiveMode: "chromakey",
      transparencyApplied: true
    });
  });

  it("refuses a missing key or an unsafe all-key image instead of claiming transparency", async () => {
    const root = await temporaryRoot();
    const noKey = await materializedPng({
      root,
      id: "artifact-no-key",
      bytes: pngBytes({ pixel: () => [20, 30, 200, 255] })
    });
    const missingResult = await applyPngChromakey({
      transaction: noKey.transaction,
      output: noKey.output,
      requestedMode: "chromakey",
      contentClass: "simple",
      keyColor,
      tolerance: 0
    });
    expect(missingResult).toMatchObject({
      status: "refused",
      reason: "key-not-found",
      transparencyApplied: false
    });

    const allKey = await materializedPng({
      root,
      id: "artifact-all-key",
      bytes: pngBytes({ pixel: () => [0, 255, 0, 255] })
    });
    const unsafeResult = await applyPngChromakey({
      transaction: allKey.transaction,
      output: allKey.output,
      requestedMode: "chromakey",
      contentClass: "simple",
      keyColor,
      tolerance: 0
    });
    expect(unsafeResult).toMatchObject({
      status: "refused",
      reason: "key-dominates-image",
      transparencyApplied: false,
      warning: { code: "chromakey_unsafe_coverage" }
    });
  });

  it("falls back to the validated provider original when PNG processing fails", async () => {
    const root = await temporaryRoot();
    const bytes = pngBytes({
      pixel: (x, y) => (x === 1 && y === 1 ? [200, 20, 20, 255] : [0, 255, 0, 255])
    });
    const { transaction, output } = await materializedPng({
      root,
      id: "artifact-processing-failure",
      bytes
    });
    vi.spyOn(PNG.sync, "write").mockImplementationOnce(() => {
      throw new Error("synthetic encoder failure");
    });

    const result = await applyPngChromakey({
      transaction,
      output,
      requestedMode: "chromakey",
      contentClass: "simple",
      keyColor,
      tolerance: 0
    });
    expect(result).toMatchObject({
      status: "fallback",
      transparencyApplied: false,
      effectiveMode: "original",
      output: { artifactId: output.artifactId, path: output.path, source: "provider-original" },
      postProcessingError: { code: "chromakey_processing_failed" }
    });
    expect(transaction.selectedOutputs).toEqual([output]);
    await expect(readFile(output.path)).resolves.toEqual(Buffer.from(bytes));
  });

  it("rejects an unsafe PNG allocation profile before calling pngjs", async () => {
    const root = await temporaryRoot();
    const bytes = boundedHeaderOnlyPng(4_097, 1);
    const transaction = await createOutputMaterializationTransaction({
      stagingRoot: path.join(root, "staging"),
      requestId: "request-unsafe-png-header"
    });
    const output = await transaction.materializeArtifact(
      artifact({
        id: "artifact-unsafe-png-header",
        bytes,
        mimeType: "image/png",
        width: 4_097,
        height: 1
      })
    );
    const readSpy = vi.spyOn(PNG.sync, "read");
    const result = await applyPngChromakey({
      transaction,
      output,
      requestedMode: "chromakey",
      contentClass: "simple",
      keyColor,
      tolerance: 0
    });
    expect(result).toMatchObject({
      status: "fallback",
      transparencyApplied: false,
      effectiveMode: "original"
    });
    expect(readSpy).not.toHaveBeenCalled();
    expect(transaction.selectedOutput(output.artifactId)?.path).toBe(output.path);
  });

  it("refuses non-PNG outputs and prevents a processed output from being processed again", async () => {
    const root = await temporaryRoot();
    const jpeg = jpegBytes(3, 2);
    const transaction = await createOutputMaterializationTransaction({
      stagingRoot: path.join(root, "staging"),
      requestId: "request-jpeg-chromakey"
    });
    const jpegOutput = await transaction.materializeArtifact(
      artifact({
        id: "artifact-jpeg-chromakey",
        bytes: jpeg,
        mimeType: "image/jpeg",
        width: 3,
        height: 2
      })
    );
    await expect(
      applyPngChromakey({
        transaction,
        output: jpegOutput,
        requestedMode: "chromakey",
        contentClass: "simple",
        keyColor,
        tolerance: 0
      })
    ).resolves.toMatchObject({ status: "refused", reason: "non-png" });

    const chroma = await materializedPng({
      root,
      id: "artifact-no-repeat",
      bytes: pngBytes({
        pixel: (x, y) => (x === 1 && y === 1 ? [200, 20, 20, 255] : [0, 255, 0, 255])
      })
    });
    const first = await applyPngChromakey({
      transaction: chroma.transaction,
      output: chroma.output,
      requestedMode: "chromakey",
      contentClass: "simple",
      keyColor,
      tolerance: 0
    });
    expect(first.status).toBe("applied");
    if (first.status !== "applied") throw new Error("expected applied chromakey result");
    await expect(
      applyPngChromakey({
        transaction: chroma.transaction,
        output: first.output,
        requestedMode: "chromakey",
        contentClass: "simple",
        keyColor,
        tolerance: 0
      })
    ).rejects.toSatisfy(expectMaterializationCode("transaction-ownership"));
  });
});

describe("session-owned ephemeral image resources", () => {
  it("registers an immutable full-five-minute descriptor that survives transaction and lease cleanup", async () => {
    const root = await temporaryRoot();
    let nowMs = Date.parse("2026-07-18T12:00:00.000Z");
    const materialized = await materializedPng({ root, id: "artifact-ephemeral-normal" });
    const resources = await registry({
      root,
      now: () => new Date(nowMs),
      idFactory: () => "resource-normal"
    });
    const descriptor = await resources.registerImage({
      output: materialized.output,
      owningSessionId: "session-normal",
      owningSessionExpiresAt: "2026-07-18T12:10:00.000Z"
    });

    expect(descriptor).toEqual({
      resourceId: "resource-normal",
      relativeUrl: "/api/v1/resources/resource-normal",
      requiresSession: true,
      mimeType: "image/png",
      byteLength: materialized.output.byteLength,
      width: 3,
      height: 3,
      etag: `sha256-${materialized.output.sha256}`,
      expiresAt: "2026-07-18T12:05:00.000Z"
    });
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(JSON.stringify(descriptor)).not.toContain(materialized.output.path);
    expect(JSON.stringify(descriptor)).not.toContain("session-normal");

    await materialized.transaction.cleanup();
    nowMs += 60_000;
    const firstLease = await resources.open(descriptor.resourceId, "session-normal");
    expect(firstLease.descriptor).toBe(descriptor);
    expect(firstLease.descriptor.expiresAt).toBe("2026-07-18T12:05:00.000Z");
    expect(firstLease.descriptor.etag).toBe(`sha256-${materialized.output.sha256}`);
    await expect(readFile(firstLease.path)).resolves.toEqual(Buffer.from(materialized.bytes));
    await firstLease.close();
    expect(firstLease.signal.aborted).toBe(true);
    expect(resources.size).toBe(1);

    const secondLease = await resources.open(descriptor.resourceId, "session-normal");
    expect(secondLease.descriptor).toBe(descriptor);
    await secondLease.close();
  });

  it("caps near-expiry sessions and rejects precisely at the immutable expiry boundary", async () => {
    const root = await temporaryRoot();
    let nowMs = Date.parse("2026-07-18T12:00:00.000Z");
    const materialized = await materializedPng({ root, id: "artifact-near-expiry" });
    const resources = await registry({
      root,
      now: () => new Date(nowMs),
      idFactory: () => "resource-near-expiry"
    });
    const descriptor = await resources.registerImage({
      output: materialized.output,
      owningSessionId: "session-near-expiry",
      owningSessionExpiresAt: "2026-07-18T12:00:30.000Z"
    });
    expect(descriptor.expiresAt).toBe("2026-07-18T12:00:30.000Z");

    nowMs = Date.parse(descriptor.expiresAt) - 1;
    const beforeExpiry = await resources.open(descriptor.resourceId, "session-near-expiry");
    const resourcePath = beforeExpiry.path;
    await beforeExpiry.close();
    nowMs += 1;
    await expect(resources.open(descriptor.resourceId, "session-near-expiry")).rejects.toSatisfy(
      expectResourceCode("expired")
    );
    expect(resources.size).toBe(0);
    await expect(access(resourcePath)).rejects.toBeDefined();
  });

  it("isolates sessions and revokes only the authoritative owning session", async () => {
    const root = await temporaryRoot();
    const nowMs = Date.parse("2026-07-18T12:00:00.000Z");
    const materialized = await materializedPng({ root, id: "artifact-session-isolation" });
    let sequence = 0;
    const resources = await registry({
      root,
      now: () => new Date(nowMs),
      idFactory: () => `resource-session-${sequence++}`
    });
    const first = await resources.registerImage({
      output: materialized.output,
      owningSessionId: "session-a",
      owningSessionExpiresAt: "2026-07-18T12:10:00.000Z"
    });
    const second = await resources.registerImage({
      output: materialized.output,
      owningSessionId: "session-b",
      owningSessionExpiresAt: "2026-07-18T12:10:00.000Z"
    });
    await expect(resources.open(first.resourceId, "session-b")).rejects.toSatisfy(
      expectResourceCode("not-found")
    );
    const leaseA = await resources.open(first.resourceId, "session-a");
    expect(await resources.revokeOwningSession("session-a")).toBe(1);
    expect(leaseA.signal.aborted).toBe(true);
    await expect(resources.open(first.resourceId, "session-a")).rejects.toSatisfy(
      expectResourceCode("not-found")
    );
    const leaseB = await resources.open(second.resourceId, "session-b");
    await leaseB.close();
    expect(resources.size).toBe(1);
  });

  it("does not publish a lease when session revocation wins an in-flight open", async () => {
    const root = await temporaryRoot();
    const nowMs = Date.parse("2026-07-18T12:00:00.000Z");
    const materialized = await materializedPng({ root, id: "artifact-open-revoke-race" });
    const resources = await registry({
      root,
      now: () => new Date(nowMs),
      idFactory: () => "resource-open-revoke-race"
    });
    const descriptor = await resources.registerImage({
      output: materialized.output,
      owningSessionId: "session-open-revoke-race",
      owningSessionExpiresAt: "2026-07-18T12:10:00.000Z"
    });
    const opening = resources.open(descriptor.resourceId, "session-open-revoke-race");
    const openingExpectation = expect(opening).rejects.toSatisfy(expectResourceCode("not-found"));
    const revoking = resources.revokeOwningSession("session-open-revoke-race");
    expect(await revoking).toBe(1);
    await openingExpectation;
    expect(resources.size).toBe(0);
  });

  it("detects backing corruption and immediately revokes the unsafe resource", async () => {
    const root = await temporaryRoot();
    const nowMs = Date.parse("2026-07-18T12:00:00.000Z");
    const materialized = await materializedPng({ root, id: "artifact-corrupt-resource" });
    const resources = await registry({
      root,
      now: () => new Date(nowMs),
      idFactory: () => "resource-corrupt"
    });
    const descriptor = await resources.registerImage({
      output: materialized.output,
      owningSessionId: "session-corrupt",
      owningSessionExpiresAt: "2026-07-18T12:10:00.000Z"
    });
    const lease = await resources.open(descriptor.resourceId, "session-corrupt");
    const resourcePath = lease.path;
    await lease.close();
    await writeFile(resourcePath, "corrupt", "utf8");
    await expect(resources.open(descriptor.resourceId, "session-corrupt")).rejects.toSatisfy(
      expectResourceCode("integrity-failed")
    );
    expect(resources.size).toBe(0);
    await expect(access(resourcePath)).rejects.toBeDefined();
  });

  it("bounds resource identities and resource count without orphaning an accepted record", async () => {
    const root = await temporaryRoot();
    const nowMs = Date.parse("2026-07-18T12:00:00.000Z");
    const materialized = await materializedPng({ root, id: "artifact-capacity" });
    let sequence = 0;
    const resources = await registry({
      root,
      now: () => new Date(nowMs),
      idFactory: () => `resource-capacity-${sequence++}`
    });
    for (let index = 0; index < MAX_EPHEMERAL_IMAGE_RESOURCES; index += 1) {
      await resources.registerImage({
        output: materialized.output,
        owningSessionId: "session-capacity",
        owningSessionExpiresAt: "2026-07-18T12:10:00.000Z"
      });
    }
    expect(resources.size).toBe(MAX_EPHEMERAL_IMAGE_RESOURCES);
    await expect(
      resources.registerImage({
        output: materialized.output,
        owningSessionId: "session-capacity",
        owningSessionExpiresAt: "2026-07-18T12:10:00.000Z"
      })
    ).rejects.toSatisfy(expectResourceCode("resource-conflict"));
    expect(resources.size).toBe(MAX_EPHEMERAL_IMAGE_RESOURCES);
  });

  it("serializes concurrent orphan retries and releases capacity exactly once", async () => {
    const root = await temporaryRoot();
    const nowMs = Date.parse("2026-07-18T12:00:00.000Z");
    const materialized = await materializedPng({ root, id: "artifact-orphan-retry" });
    let removeCalls = 0;
    const resources = await registry({
      root,
      now: () => new Date(nowMs),
      idFactory: () => "resource-orphan-retry",
      removeFile: async (filePath) => {
        removeCalls += 1;
        if (removeCalls <= 2) {
          throw Object.assign(new Error("synthetic sharing violation"), { code: "EBUSY" });
        }
        await unlink(filePath);
      }
    });
    await resources.registerImage({
      output: materialized.output,
      owningSessionId: "session-orphan-retry",
      owningSessionExpiresAt: "2026-07-18T12:10:00.000Z"
    });
    expect(resources.totalBytes).toBe(materialized.output.byteLength);

    expect(await resources.revokeOwningSession("session-orphan-retry")).toBe(1);
    expect(removeCalls).toBe(2);
    expect(resources.totalBytes).toBe(materialized.output.byteLength);

    await Promise.all([
      resources.cleanupExpired(),
      resources.revokeOwningSession("session-with-no-resources")
    ]);
    expect(removeCalls).toBe(3);
    expect(resources.totalBytes).toBe(0);
  });

  it("keeps a replacement orphan accounted while an older same-path cleanup resolves", async () => {
    const root = await temporaryRoot();
    const initialNowMs = Date.parse("2026-07-18T12:00:00.000Z");
    const materialized = await materializedPng({ root, id: "artifact-orphan-replacement" });
    let expireDuringRegistration = false;
    let expiringRegistrationClockCalls = 0;
    let removeCalls = 0;
    let signalOldRemoval: (() => void) | undefined;
    let releaseOldCleanup: (() => void) | undefined;
    const oldRemovalStarted = new Promise<void>((resolve) => {
      signalOldRemoval = resolve;
    });
    const oldCleanupMayResolve = new Promise<void>((resolve) => {
      releaseOldCleanup = resolve;
    });
    const resources = await registry({
      root,
      now: () => {
        if (!expireDuringRegistration) return new Date(initialNowMs);
        expiringRegistrationClockCalls += 1;
        return new Date(
          expiringRegistrationClockCalls === 1
            ? initialNowMs
            : initialNowMs + EPHEMERAL_IMAGE_RESOURCE_TTL_MS
        );
      },
      idFactory: () => "resource-orphan-replacement",
      removeFile: async (filePath) => {
        removeCalls += 1;
        if (removeCalls <= 2 || removeCalls === 4) {
          throw Object.assign(new Error("synthetic sharing violation"), { code: "EBUSY" });
        }
        await unlink(filePath);
        if (removeCalls === 3) {
          signalOldRemoval?.();
          await oldCleanupMayResolve;
        }
      }
    });
    await resources.registerImage({
      output: materialized.output,
      owningSessionId: "session-orphan-replacement-old",
      owningSessionExpiresAt: "2026-07-18T12:10:00.000Z"
    });
    expect(await resources.revokeOwningSession("session-orphan-replacement-old")).toBe(1);
    expect(removeCalls).toBe(2);
    expect(resources.totalBytes).toBe(materialized.output.byteLength);

    const cleanup = resources.cleanupExpired();
    await oldRemovalStarted;
    expireDuringRegistration = true;
    await expect(
      resources.registerImage({
        output: materialized.output,
        owningSessionId: "session-orphan-replacement-new",
        owningSessionExpiresAt: "2026-07-18T12:10:00.000Z"
      })
    ).rejects.toSatisfy(expectResourceCode("expired"));
    expect(removeCalls).toBe(4);
    expect(resources.totalBytes).toBe(materialized.output.byteLength);

    releaseOldCleanup?.();
    await cleanup;
    expect(resources.totalBytes).toBe(materialized.output.byteLength);

    await resources.cleanupExpired();
    expect(removeCalls).toBe(5);
    expect(resources.totalBytes).toBe(0);
  });

  it("revokes open leases and all resources immediately on idempotent shutdown", async () => {
    const root = await temporaryRoot();
    const nowMs = Date.parse("2026-07-18T12:00:00.000Z");
    const materialized = await materializedPng({ root, id: "artifact-shutdown" });
    const resources = await registry({
      root,
      now: () => new Date(nowMs),
      idFactory: () => "resource-shutdown"
    });
    const descriptor = await resources.registerImage({
      output: materialized.output,
      owningSessionId: "session-shutdown",
      owningSessionExpiresAt: "2026-07-18T12:10:00.000Z"
    });
    const lease = await resources.open(descriptor.resourceId, "session-shutdown");
    const directory = resources.directory;

    expect(await resources.shutdown()).toBe(1);
    expect(lease.signal.aborted).toBe(true);
    expect(resources.size).toBe(0);
    await expect(access(directory)).rejects.toBeDefined();
    await expect(resources.open(descriptor.resourceId, "session-shutdown")).rejects.toSatisfy(
      expectResourceCode("registry-shutdown")
    );
    await expect(
      resources.registerImage({
        output: materialized.output,
        owningSessionId: "session-shutdown",
        owningSessionExpiresAt: "2026-07-18T12:10:00.000Z"
      })
    ).rejects.toSatisfy(expectResourceCode("registry-shutdown"));
    expect(await resources.shutdown()).toBe(0);
  });

  it("cannot publish a registration after shutdown starts", async () => {
    const root = await temporaryRoot();
    const nowMs = Date.parse("2026-07-18T12:00:00.000Z");
    const materialized = await materializedPng({ root, id: "artifact-register-shutdown-race" });
    const resources = await registry({
      root,
      now: () => new Date(nowMs),
      idFactory: () => "resource-register-shutdown-race"
    });
    const registering = resources.registerImage({
      output: materialized.output,
      owningSessionId: "session-register-shutdown-race",
      owningSessionExpiresAt: "2026-07-18T12:10:00.000Z"
    });
    const registrationExpectation = expect(registering).rejects.toSatisfy(
      expectResourceCode("registry-shutdown")
    );
    const shuttingDown = resources.shutdown();
    await registrationExpectation;
    expect(await shuttingDown).toBe(0);
    expect(resources.size).toBe(0);
    await expect(access(resources.directory)).rejects.toBeDefined();
  });

  it("uses the exact five-minute constant and rejects already-expired sessions", async () => {
    expect(EPHEMERAL_IMAGE_RESOURCE_TTL_MS).toBe(300_000);
    const root = await temporaryRoot();
    const nowMs = Date.parse("2026-07-18T12:00:00.000Z");
    const materialized = await materializedPng({ root, id: "artifact-expired-session" });
    const resources = await registry({
      root,
      now: () => new Date(nowMs),
      idFactory: () => "resource-expired-session"
    });
    await expect(
      resources.registerImage({
        output: materialized.output,
        owningSessionId: "session-expired",
        owningSessionExpiresAt: "2026-07-18T12:00:00.000Z"
      })
    ).rejects.toSatisfy(expectResourceCode("expired"));
    expect(resources.size).toBe(0);
  });
});
