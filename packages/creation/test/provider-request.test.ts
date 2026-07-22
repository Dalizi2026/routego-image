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
import { fingerprintProviderEndpoint, PROVIDER_REQUEST_SHAPES } from "@routego-image/foundation";
import {
  describePreparedProviderRequest,
  detectImageMetadata,
  prepareProviderRequest,
  redactProviderDiagnostic,
  type PreparedProviderRequest,
  type ProviderRequestPreparationContext,
  type ProviderRequestPreparationResult
} from "../src/provider/index";

const OBSERVED_AT = "2026-07-22T08:00:00.000Z";
const GENERATION_ENDPOINT = "https://relay.example/custom/generate?tenant=synthetic";
const RESPONSES_ENDPOINT = "https://relay.example/custom/responses";
const ENDPOINTS: ProviderEndpointSet = {
  generation: { mode: "exact-generation-endpoint", value: GENERATION_ENDPOINT }
};

let fixtureDirectory = "";
let referencePng = "";
let invalidPng = "";

function uint32Be(value: number): Buffer {
  const output = Buffer.alloc(4);
  output.writeUInt32BE(value);
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

function syntheticPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "routego-creation-provider-"));
  referencePng = join(fixtureDirectory, "reference.png");
  invalidPng = join(fixtureDirectory, "invalid.png");
  await Promise.all([
    writeFile(referencePng, syntheticPng(4, 3)),
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
  } = {}
): ProviderCapabilityRecord {
  const state = options.state ?? "supported";
  const requestShape = options.requestShape ?? PROVIDER_REQUEST_SHAPES.singleEndpointImage;
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
    evidence: state === "unknown"
      ? []
      : [{
          source: state === "supported"
            ? "successful-request"
            : state === "unsupported"
              ? "protocol-rejection"
              : "degraded-fallback",
          observedAt: OBSERVED_AT,
          summary: `Synthetic ${state} capability evidence.`,
          requestShape
        }],
    ...(state === "unknown" ? {} : { verifiedAt: OBSERVED_AT }),
    ...(state === "degraded" ? { degradedReason: "Synthetic reduced semantics." } : {})
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
  requestShape: string
): ProviderCapabilityRecord[] {
  return names.map((name) => capability(name, { endpoint, transport, requestShape }));
}

describe("generation-only provider request preparation", () => {
  it("detects bounded PNG metadata", () => {
    expect(detectImageMetadata(syntheticPng(4, 3))).toEqual({
      mimeType: "image/png",
      width: 4,
      height: 3,
      hasAlpha: true
    });
  });

  it("keeps the text-only baseline on the exact configured generation endpoint", async () => {
    const value = prepared(await prepareProviderRequest(context(), {
      kind: "generate",
      prompt: "中文提示 text baseline"
    }));
    expect(value.route).toMatchObject({
      tier: "A",
      requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointText
    });
    expect(value.submission).toMatchObject({
      bodyType: "json",
      endpoint: GENERATION_ENDPOINT,
      body: { model: "gpt-image-2", prompt: "中文提示 text baseline", n: 1, size: "auto" }
    });
  });

  it("serializes one ordered generation reference through the evidenced image adapter", async () => {
    const shape = PROVIDER_REQUEST_SHAPES.singleEndpointImage;
    const value = prepared(await prepareProviderRequest(
      context(tierCapabilities(["single-image-input", "data-url-input"], GENERATION_ENDPOINT, "single-endpoint-json", shape)),
      { kind: "generate", prompt: "One reference", references: [{ path: referencePng, role: "subject" }] }
    ));
    expect(value.inputs.images).toMatchObject([{ kind: "reference", role: "subject", slot: 0 }]);
    if (value.submission.bodyType !== "json") throw new Error("Expected JSON");
    expect(value.submission.body["image"]).toMatch(/^data:image\/png;base64,/u);
    expect(value.submission.body).not.toHaveProperty("mask");
  });

  it("keeps up to five generation references in their submitted order", async () => {
    const shape = PROVIDER_REQUEST_SHAPES.singleEndpointImages;
    const value = prepared(await prepareProviderRequest(
      context(tierCapabilities(["multi-image-input", "data-url-input"], GENERATION_ENDPOINT, "single-endpoint-json", shape)),
      {
        kind: "generate",
        prompt: "Five ordered references",
        references: ["reference", "style", "composition", "subject", "product"].map((role) => ({
          path: referencePng,
          role
        }))
      }
    ));
    expect(value.inputs.images.map((image) => image.role)).toEqual([
      "reference", "style", "composition", "subject", "product"
    ]);
    if (value.submission.bodyType !== "json") throw new Error("Expected JSON");
    expect(value.submission.body["images"]).toHaveLength(5);
    expect(value.submission.body).not.toHaveProperty("mask");
  });

  it("rejects a sixth generation reference before provider routing or file access", async () => {
    const result = await prepareProviderRequest(context(), {
      kind: "generate",
      prompt: "Too many references",
      references: Array.from({ length: 6 }, (_, index) => ({
        path: join(fixtureDirectory, `missing-${index}.png`),
        role: "reference"
      }))
    });
    expect(result).toMatchObject({ prepared: false, error: { code: "invalid_input", mayHaveBilled: false } });
  });

  it("uses the Images generation adapter only for text-only generation", async () => {
    const value = prepared(await prepareProviderRequest(
      context([], { preferredTransports: ["openai-images"] }),
      { kind: "generate", prompt: "Images generation" }
    ));
    expect(value.route.requestShape).toBe(PROVIDER_REQUEST_SHAPES.imagesGenerationsJson);
    expect(value.submission).toMatchObject({ bodyType: "json", endpoint: GENERATION_ENDPOINT });
  });

  it("retains Responses generation with ordered reference image content and no continuation fields", async () => {
    const shape = PROVIDER_REQUEST_SHAPES.responsesImageGeneration;
    const value = prepared(await prepareProviderRequest(
      context(
        tierCapabilities(
          ["text-generation", "single-image-input", "data-url-input"],
          RESPONSES_ENDPOINT,
          "openai-responses",
          shape
        ),
        { endpoints: { ...ENDPOINTS, responses: RESPONSES_ENDPOINT }, preferredTransports: ["openai-responses"] }
      ),
      { kind: "generate", prompt: "Responses reference", references: [{ path: referencePng, role: "style" }] }
    ));
    if (value.submission.bodyType !== "json") throw new Error("Expected JSON");
    expect(value.submission.body).toMatchObject({
      model: "gpt-image-2",
      input: [{ role: "user", content: [
        { type: "input_text", text: "Responses reference" },
        { type: "input_image", image_url: expect.stringMatching(/^data:image\/png;base64,/u) }
      ] }],
      tools: [{ type: "image_generation" }]
    });
    expect(value.submission.body).not.toHaveProperty("previous_response_id");
  });

  it("rejects removed edit, target, mask, and continuation fields before input preparation", async () => {
    for (const staleRequest of [
      { kind: "edit", prompt: "Removed edit" },
      { kind: "generate", prompt: "Removed target", targetImage: { path: join(fixtureDirectory, "missing.png") } },
      { kind: "generate", prompt: "Removed mask", maskPath: join(fixtureDirectory, "missing.png") },
      { kind: "generate", prompt: "Removed continuation", previousResponseId: "response-previous" }
    ]) {
      await expect(prepareProviderRequest(context(), staleRequest)).resolves.toMatchObject({
        prepared: false,
        error: { code: "invalid_input", mayHaveBilled: false }
      });
    }
  });

  it("requires image-input evidence before reading a generation reference and reports invalid files safely", async () => {
    await expect(prepareProviderRequest(context(), {
      kind: "generate",
      prompt: "Unknown capability",
      references: [{ path: join(fixtureDirectory, "does-not-exist.png"), role: "reference" }]
    })).resolves.toMatchObject({ prepared: false, error: { code: "capability_unavailable" } });

    const invalid = await prepareProviderRequest(
      context(tierCapabilities(["single-image-input", "data-url-input"], GENERATION_ENDPOINT, "single-endpoint-json", PROVIDER_REQUEST_SHAPES.singleEndpointImage)),
      { kind: "generate", prompt: "Invalid reference", references: [{ path: invalidPng, role: "reference" }] }
    );
    expect(invalid).toMatchObject({ prepared: false, error: { code: "invalid_input", mayHaveBilled: false } });
    expect(JSON.stringify(invalid)).not.toContain(invalidPng);
  });

  it("redacts prepared request diagnostics without exposing image bytes or paths", async () => {
    const diagnostic = redactProviderDiagnostic({
      authorization: "Bearer synthetic-secret-token",
      image: "data:image/png;base64,c2Vuc2l0aXZlLWltYWdl",
      imageBytes: Uint8Array.of(1, 2, 3)
    });
    expect(JSON.stringify(diagnostic)).not.toContain("synthetic-secret-token");

    const value = prepared(await prepareProviderRequest(
      context(tierCapabilities(["single-image-input", "data-url-input"], GENERATION_ENDPOINT, "single-endpoint-json", PROVIDER_REQUEST_SHAPES.singleEndpointImage)),
      { kind: "generate", prompt: "Diagnostic request", references: [{ path: referencePng, role: "reference" }] }
    ));
    const description = JSON.stringify(describePreparedProviderRequest(value));
    expect(description).toContain("?[REDACTED]");
    expect(description).toContain("[REDACTED_IMAGE_DATA]");
    expect(description).not.toContain(referencePng);
  });
});
