import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  providerCapabilityRecordSchema,
  type ProviderCapability,
  type ProviderCapabilityRecord,
  type ProviderEndpointSet,
  type ProviderTransport
} from "@routego-image/contracts";
import {
  fingerprintProviderEndpoint,
  PROVIDER_REQUEST_SHAPES
} from "@routego-image/foundation";
import {
  describePreparedProviderRequest,
  detectImageMetadata,
  prepareProviderRequest,
  redactProviderDiagnostic,
  type PreparedProviderRequest,
  type ProviderRequestPreparationContext,
  type ProviderRequestPreparationResult
} from "../src/provider/index";

const OBSERVED_AT = "2026-07-18T08:00:00.000Z";
const GENERATION_ENDPOINT = "https://relay.example/custom/generate?tenant=synthetic";
const EDITS_ENDPOINT = "https://relay.example/custom/edits";
const RESPONSES_ENDPOINT = "https://relay.example/custom/responses";
const ENDPOINTS: ProviderEndpointSet = {
  generation: { mode: "exact-generation-endpoint", value: GENERATION_ENDPOINT }
};

let fixtureDirectory = "";
let targetPng = "";
let supportingJpeg = "";
let referenceWebp = "";
let alphaMask = "";
let opaqueMask = "";
let mismatchedMask = "";
let invalidPng = "";

function uint32Be(value: number): Buffer {
  const output = Buffer.alloc(4);
  output.writeUInt32BE(value);
  return output;
}

function uint32Le(value: number): Buffer {
  const output = Buffer.alloc(4);
  output.writeUInt32LE(value);
  return output;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  return Buffer.concat([
    uint32Be(data.byteLength),
    Buffer.from(type, "ascii"),
    Buffer.from(data),
    Buffer.alloc(4)
  ]);
}

function syntheticPng(width: number, height: number, alpha: boolean): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function syntheticJpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xd9
  ]);
}

function syntheticWebp(width: number, height: number, alpha: boolean): Buffer {
  const data = Buffer.alloc(10);
  data[0] = alpha ? 0x10 : 0;
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  const chunk = Buffer.concat([Buffer.from("VP8X", "ascii"), uint32Le(data.length), data]);
  return Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    uint32Le(4 + chunk.length),
    Buffer.from("WEBP", "ascii"),
    chunk
  ]);
}

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "routego-creation-provider-"));
  targetPng = join(fixtureDirectory, "target.png");
  supportingJpeg = join(fixtureDirectory, "support.jpg");
  referenceWebp = join(fixtureDirectory, "reference.webp");
  alphaMask = join(fixtureDirectory, "mask.png");
  opaqueMask = join(fixtureDirectory, "opaque-mask.png");
  mismatchedMask = join(fixtureDirectory, "mismatched-mask.png");
  invalidPng = join(fixtureDirectory, "invalid.png");
  await Promise.all([
    writeFile(targetPng, syntheticPng(4, 3, true)),
    writeFile(supportingJpeg, syntheticJpeg(5, 4)),
    writeFile(referenceWebp, syntheticWebp(6, 5, false)),
    writeFile(alphaMask, syntheticPng(4, 3, true)),
    writeFile(opaqueMask, syntheticPng(4, 3, false)),
    writeFile(mismatchedMask, syntheticPng(5, 3, true)),
    writeFile(invalidPng, Buffer.from("not-an-image", "utf8"))
  ]);
});

afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

function capability(
  name: ProviderCapability,
  options: {
    endpoint?: string;
    transport?: ProviderTransport;
    requestShape?: string;
    state?: "unknown" | "supported" | "unsupported" | "degraded";
    limits?: Record<string, unknown>;
  } = {}
): ProviderCapabilityRecord {
  const state = options.state ?? "supported";
  const requestShape = options.requestShape ?? PROVIDER_REQUEST_SHAPES.singleEndpointImage;
  const evidence = state === "unknown"
    ? []
    : [
        {
          source:
            state === "supported"
              ? "successful-request"
              : state === "unsupported"
                ? "protocol-rejection"
                : "degraded-fallback",
          observedAt: OBSERVED_AT,
          summary: `Synthetic ${state} capability evidence.`,
          requestShape
        }
      ];
  return providerCapabilityRecordSchema.parse({
    capability: name,
    scope: {
      providerId: "provider-a",
      model: "gpt-image-2",
      endpointFingerprint: fingerprintProviderEndpoint(options.endpoint ?? GENERATION_ENDPOINT),
      transport: options.transport ?? "single-endpoint-json",
      requestShape
    },
    state,
    evidence,
    ...(state === "unknown" ? {} : { verifiedAt: OBSERVED_AT }),
    ...(state === "degraded" ? { degradedReason: "Synthetic reduced semantics." } : {}),
    ...(options.limits === undefined ? {} : { limits: options.limits })
  });
}

function context(
  capabilities: readonly ProviderCapabilityRecord[] = [],
  overrides: Partial<ProviderRequestPreparationContext> = {}
): ProviderRequestPreparationContext {
  return {
    providerId: "provider-a",
    model: "gpt-image-2",
    endpoints: ENDPOINTS,
    capabilities,
    ...overrides
  };
}

function prepared(result: ProviderRequestPreparationResult): PreparedProviderRequest {
  if (!result.prepared) {
    throw new Error(`Expected a prepared request, received ${result.error.code}: ${result.error.safeMessage}`);
  }
  return result.value;
}

function tierCapabilities(
  names: readonly ProviderCapability[],
  endpoint: string,
  transport: ProviderTransport,
  requestShape: string,
  state: "supported" | "unsupported" | "degraded" = "supported"
): ProviderCapabilityRecord[] {
  return names.map((name) => capability(name, { endpoint, transport, requestShape, state }));
}

describe("image metadata and ordered local input preparation", () => {
  it("detects bounded PNG, JPEG, and WebP metadata from magic bytes", () => {
    expect(detectImageMetadata(syntheticPng(4, 3, true))).toEqual({
      mimeType: "image/png",
      width: 4,
      height: 3,
      hasAlpha: true
    });
    expect(detectImageMetadata(syntheticJpeg(5, 4))).toEqual({
      mimeType: "image/jpeg",
      width: 5,
      height: 4,
      hasAlpha: false
    });
    expect(detectImageMetadata(syntheticWebp(6, 5, false))).toEqual({
      mimeType: "image/webp",
      width: 6,
      height: 5,
      hasAlpha: false
    });
  });

  it("keeps target, supporting, and reference order and binds the mask to target slot zero", async () => {
    const shape = PROVIDER_REQUEST_SHAPES.imagesEditsMultipart;
    const caps = tierCapabilities(
      ["multi-image-input", "multipart-input", "target-edit", "mask-edit"],
      EDITS_ENDPOINT,
      "openai-images",
      shape
    );
    const value = prepared(
      await prepareProviderRequest(
        context(caps, {
          endpoints: { ...ENDPOINTS, edits: EDITS_ENDPOINT },
          preferredTransports: ["openai-images"]
        }),
        {
          kind: "edit",
          prompt: "Preserve ordered inputs",
          targetImage: { id: "target-1", path: targetPng },
          supportingImages: [{ id: "support-1", path: supportingJpeg }],
          references: [{ id: "reference-1", path: referenceWebp, role: "style" }],
          maskPath: alphaMask,
          invariants: { preserve: ["subject identity"] }
        }
      )
    );

    expect(value.inputs.images.map(({ kind, role, slot, mimeType }) => ({ kind, role, slot, mimeType }))).toEqual([
      { kind: "target", role: "target", slot: 0, mimeType: "image/png" },
      { kind: "supporting", role: "supporting", slot: 1, mimeType: "image/jpeg" },
      { kind: "reference", role: "style", slot: 2, mimeType: "image/webp" }
    ]);
    expect(value.inputs.mask).toMatchObject({
      targetSlot: 0,
      mimeType: "image/png",
      width: 4,
      height: 3,
      hasAlpha: true
    });
  });
});

describe("Tier A single-endpoint request serialization", () => {
  it("keeps the text-only baseline on the exact configured generation endpoint", async () => {
    const value = prepared(
      await prepareProviderRequest(context(), {
        kind: "generate",
        prompt: "中文提示 text baseline"
      })
    );
    expect(value.route).toMatchObject({
      tier: "A",
      requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointText
    });
    expect(value.submission).toMatchObject({
      bodyType: "json",
      endpoint: GENERATION_ENDPOINT,
      body: { model: "gpt-image-2", prompt: "中文提示 text baseline", n: 1, size: "auto" }
    });
    if (value.submission.bodyType === "json") {
      expect(value.submission.body).not.toHaveProperty("image");
      expect(value.submission.body).not.toHaveProperty("images");
      expect(value.submission.body).not.toHaveProperty("mask");
    }
  });

  it("uses only the separately evidenced image field for one input", async () => {
    const shape = PROVIDER_REQUEST_SHAPES.singleEndpointImage;
    const caps = tierCapabilities(
      ["single-image-input", "data-url-input", "target-edit"],
      GENERATION_ENDPOINT,
      "single-endpoint-json",
      shape
    );
    const value = prepared(
      await prepareProviderRequest(context(caps), {
        kind: "edit",
        prompt: "Single image edit",
        targetImage: { path: targetPng },
        invariants: { preserve: ["subject"] }
      })
    );
    expect(value.submission).toMatchObject({ bodyType: "json", endpoint: GENERATION_ENDPOINT });
    if (value.submission.bodyType === "json") {
      expect(value.submission.body["image"]).toMatch(/^data:image\/png;base64,/u);
      expect(value.submission.body).not.toHaveProperty("images");
    }
  });

  it("uses only the separately evidenced ordered images field for multiple inputs", async () => {
    const shape = PROVIDER_REQUEST_SHAPES.singleEndpointImages;
    const caps = tierCapabilities(
      ["multi-image-input", "data-url-input"],
      GENERATION_ENDPOINT,
      "single-endpoint-json",
      shape
    );
    const value = prepared(
      await prepareProviderRequest(context(caps), {
        kind: "generate",
        prompt: "Ordered references",
        references: [
          { path: supportingJpeg, role: "subject" },
          { path: referenceWebp, role: "style" }
        ]
      })
    );
    if (value.submission.bodyType !== "json") throw new Error("Expected JSON");
    expect(value.submission.body["images"]).toEqual([
      expect.stringMatching(/^data:image\/jpeg;base64,/u),
      expect.stringMatching(/^data:image\/webp;base64,/u)
    ]);
    expect(value.submission.body).not.toHaveProperty("image");
  });
});

describe("Tier B Images request serialization", () => {
  it("uses generations JSON for an explicitly preferred text-only Images route", async () => {
    const value = prepared(
      await prepareProviderRequest(
        context([], { preferredTransports: ["openai-images"] }),
        { kind: "generate", prompt: "Images generation", count: 1 }
      )
    );
    expect(value.route.requestShape).toBe(PROVIDER_REQUEST_SHAPES.imagesGenerationsJson);
    expect(value.submission).toMatchObject({
      bodyType: "json",
      endpoint: GENERATION_ENDPOINT,
      body: { model: "gpt-image-2", prompt: "Images generation", n: 1, size: "auto" }
    });
  });

  it("serializes multipart target, mask, supporting, references, then effective controls", async () => {
    const shape = PROVIDER_REQUEST_SHAPES.imagesEditsMultipart;
    const caps = tierCapabilities(
      ["multi-image-input", "multipart-input", "target-edit", "mask-edit"],
      EDITS_ENDPOINT,
      "openai-images",
      shape
    );
    const value = prepared(
      await prepareProviderRequest(
        context(caps, {
          endpoints: { ...ENDPOINTS, edits: EDITS_ENDPOINT },
          preferredTransports: ["openai-images"]
        }),
        {
          kind: "edit",
          prompt: "Multipart edit",
          targetImage: { path: targetPng },
          supportingImages: [{ path: supportingJpeg }],
          references: [{ path: referenceWebp, role: "style" }],
          maskPath: alphaMask,
          invariants: { preserve: ["subject"] }
        }
      )
    );
    expect(value.submission.bodyType).toBe("multipart");
    if (value.submission.bodyType !== "multipart") throw new Error("Expected multipart");
    const entries = [...value.submission.body.entries()];
    expect(entries.map(([name]) => name)).toEqual([
      "model",
      "prompt",
      "image",
      "mask",
      "image[]",
      "image[]",
      "n",
      "size"
    ]);
    expect(entries.slice(2, 6).map(([, item]) => (typeof item === "string" ? item : item.type))).toEqual([
      "image/png",
      "image/png",
      "image/jpeg",
      "image/webp"
    ]);
  });
});

describe("Tier C Responses request serialization", () => {
  it("preserves state, ordered local/file/image inputs, action, and capability-authorized controls", async () => {
    const shape = PROVIDER_REQUEST_SHAPES.responsesImageGeneration;
    const required: ProviderCapability[] = [
      "text-generation",
      "multi-image-input",
      "data-url-input",
      "file-id-input",
      "image-id-input",
      "responses-state",
      "custom-size",
      "quality-control",
      "output-format",
      "compression",
      "streaming",
      "partial-images",
      "moderation"
    ];
    const caps = tierCapabilities(required, RESPONSES_ENDPOINT, "openai-responses", shape);
    const value = prepared(
      await prepareProviderRequest(
        context(caps, { endpoints: { ...ENDPOINTS, responses: RESPONSES_ENDPOINT } }),
        {
          kind: "generate",
          prompt: "Responses request",
          references: [{ path: targetPng, role: "reference" }],
          previousResponseId: "response-previous",
          fileIds: ["file-1"],
          imageIds: ["image-1"],
          action: "generate",
          size: "1024x1024",
          quality: "high",
          format: "webp",
          compression: 80,
          partialImages: 2,
          moderation: "low"
        }
      )
    );
    expect(value.route).toMatchObject({ tier: "C", endpoint: RESPONSES_ENDPOINT });
    if (value.submission.bodyType !== "json") throw new Error("Expected JSON");
    expect(value.submission.body).toMatchObject({
      model: "gpt-image-2",
      previous_response_id: "response-previous",
      stream: true,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Responses request" },
            { type: "input_image", image_url: expect.stringMatching(/^data:image\/png;base64,/u) },
            { type: "input_image", file_id: "file-1" },
            { type: "input_image", image_id: "image-1" }
          ]
        }
      ],
      tools: [
        {
          type: "image_generation",
          action: "generate",
          size: "1024x1024",
          quality: "high",
          output_format: "webp",
          output_compression: 80,
          partial_images: 2,
          moderation: "low"
        }
      ]
    });
  });
});

describe("capability gates and endpoint no-guessing", () => {
  const request = () => ({
    kind: "edit",
    prompt: "Capability gated edit",
    targetImage: { path: targetPng },
    invariants: { preserve: ["subject"] }
  });

  it("allows the unknown text baseline but rejects unknown image capability before reading a file", async () => {
    expect((await prepareProviderRequest(context(), { kind: "generate", prompt: "Text" })).prepared).toBe(true);
    const result = await prepareProviderRequest(context(), {
      ...request(),
      targetImage: { path: join(fixtureDirectory, "does-not-exist.png") }
    });
    expect(result).toMatchObject({ prepared: false, error: { code: "capability_unavailable" } });
  });

  it("honors supported, unsupported, and degraded capability states without mutating them", async () => {
    const shape = PROVIDER_REQUEST_SHAPES.singleEndpointImage;
    const supported = tierCapabilities(
      ["single-image-input", "data-url-input", "target-edit"],
      GENERATION_ENDPOINT,
      "single-endpoint-json",
      shape
    );
    expect((await prepareProviderRequest(context(supported), request())).prepared).toBe(true);

    const unsupported = [
      capability("single-image-input", { requestShape: shape, state: "unsupported" }),
      ...tierCapabilities(
        ["data-url-input", "target-edit"],
        GENERATION_ENDPOINT,
        "single-endpoint-json",
        shape
      )
    ];
    expect(await prepareProviderRequest(context(unsupported), request())).toMatchObject({
      prepared: false,
      error: { code: "capability_unavailable" }
    });

    const degraded = [
      capability("single-image-input", { requestShape: shape, state: "degraded" }),
      ...tierCapabilities(
        ["data-url-input", "target-edit"],
        GENERATION_ENDPOINT,
        "single-endpoint-json",
        shape
      )
    ];
    const degradedValue = prepared(await prepareProviderRequest(context(degraded), request()));
    expect(degradedValue.route.degraded).toBe(true);
    expect(degradedValue.effective.degraded).toBe(true);
  });

  it("does not derive Edits, Responses, models, or any sibling endpoint", async () => {
    const result = await prepareProviderRequest(
      context([], { preferredTransports: ["openai-images"] }),
      request()
    );
    expect(result.prepared).toBe(false);
    if (result.prepared) throw new Error("Expected unavailable route");
    expect(result.error.code).toBe("capability_unavailable");
    expect(result.route).toMatchObject({ attemptedTransports: [] });
    expect(JSON.stringify(result)).not.toMatch(/images\/edits|\/responses|\/models/u);
  });
});

describe("invalid files, masks, limits, and diagnostics", () => {
  const tierAEditCapabilities = tierCapabilities(
    ["single-image-input", "data-url-input", "target-edit"],
    GENERATION_ENDPOINT,
    "single-endpoint-json",
    PROVIDER_REQUEST_SHAPES.singleEndpointImage
  );

  it("returns a structured pre-submission failure for invalid or oversized image files", async () => {
    const invalid = await prepareProviderRequest(context(tierAEditCapabilities), {
      kind: "edit",
      prompt: "Invalid file",
      targetImage: { path: invalidPng },
      invariants: { preserve: ["subject"] }
    });
    expect(invalid).toMatchObject({
      prepared: false,
      error: { code: "invalid_input", receivedAnyOutput: false, mayHaveBilled: false }
    });
    expect(JSON.stringify(invalid)).not.toContain(invalidPng);

    const oversized = await prepareProviderRequest(
      context(tierAEditCapabilities),
      {
        kind: "edit",
        prompt: "Bounded file",
        targetImage: { path: targetPng },
        invariants: { preserve: ["subject"] }
      },
      { maxFileBytes: 8 }
    );
    expect(oversized).toMatchObject({
      prepared: false,
      error: { code: "invalid_input", details: { reason: "image-too-large" } }
    });
  });

  it("rejects a non-alpha or dimension-mismatched mask before submission", async () => {
    const shape = PROVIDER_REQUEST_SHAPES.imagesEditsMultipart;
    const caps = tierCapabilities(
      ["single-image-input", "multipart-input", "target-edit", "mask-edit"],
      EDITS_ENDPOINT,
      "openai-images",
      shape
    );
    const maskContext = context(caps, {
      endpoints: { ...ENDPOINTS, edits: EDITS_ENDPOINT },
      preferredTransports: ["openai-images"]
    });
    for (const [maskPath, reason] of [
      [opaqueMask, "invalid-mask"],
      [mismatchedMask, "mask-dimension-mismatch"]
    ] as const) {
      const result = await prepareProviderRequest(maskContext, {
        kind: "edit",
        prompt: "Invalid mask",
        targetImage: { path: targetPng },
        maskPath,
        invariants: { preserve: ["subject"] }
      });
      expect(result).toMatchObject({
        prepared: false,
        error: { code: "invalid_input", details: { reason } }
      });
    }

    const oversizedMask = await prepareProviderRequest(
      maskContext,
      {
        kind: "edit",
        prompt: "Bounded mask",
        targetImage: { path: targetPng },
        maskPath: alphaMask,
        invariants: { preserve: ["subject"] }
      },
      { maxMaskBytes: 8 }
    );
    expect(oversizedMask).toMatchObject({
      prepared: false,
      error: { code: "invalid_input", details: { reason: "mask-too-large" } }
    });
  });

  it("recursively redacts authorization, API keys, URLs, image data, bytes, and prepared diagnostics", async () => {
    const diagnostic = redactProviderDiagnostic({
      authorization: "Bearer synthetic-secret-token",
      apiKey: "synthetic-api-key",
      url: "https://relay.example/generate?api_key=synthetic-api-key",
      image: "data:image/png;base64,c2Vuc2l0aXZlLWltYWdl",
      nested: {
        imageBytes: Uint8Array.of(1, 2, 3),
        rawBytes: Uint8Array.of(4, 5, 6)
      }
    });
    const rendered = JSON.stringify(diagnostic);
    expect(rendered).not.toContain("synthetic-secret-token");
    expect(rendered).not.toContain("synthetic-api-key");
    expect(rendered).not.toContain("c2Vuc2l0aXZlLWltYWdl");
    expect(rendered).toContain("[REDACTED]");
    expect(rendered).toContain("[REDACTED_IMAGE_DATA]");
    expect(rendered).toContain("[REDACTED_BINARY_DATA]");

    const value = prepared(
      await prepareProviderRequest(context(tierAEditCapabilities), {
        kind: "edit",
        prompt: "Diagnostic request",
        targetImage: { path: targetPng },
        invariants: { preserve: ["subject"] }
      })
    );
    const description = JSON.stringify(describePreparedProviderRequest(value));
    expect(description).toContain("?[REDACTED]");
    expect(description).toContain("[REDACTED_IMAGE_DATA]");
    expect(description).not.toContain(Buffer.from(syntheticPng(4, 3, true)).toString("base64"));
    expect(description).not.toContain(targetPng);
  });
});
