import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  capabilityProbeInputSchema,
  type CapabilityProbeInput,
  type CapabilityProbeResult,
  type ProviderCapability,
  type ProviderEndpointSet
} from "@routego-image/contracts";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LibrarySettingsStore,
  type RuntimeProviderProfile
} from "@routego-image/library";
import {
  fingerprintProviderEndpoint,
  normalizeProviderEndpoints,
  PROVIDER_REQUEST_SHAPES
} from "@routego-image/foundation";

import {
  ProviderIntegrationError,
  boundedRedactedDiagnostic,
  loadProviderContext,
  readProviderStatus
} from "../src/provider/context";
import {
  MAX_MODEL_RESPONSE_BYTES,
  parseBoundedModelPayload,
  refreshProviderModels
} from "../src/provider/models";
import {
  CAPABILITY_PROBE_PAIRS,
  MAX_CAPABILITY_PROBE_PNG_DIMENSION,
  MAX_CAPABILITY_PROBE_PNG_PIXELS,
  MAX_CAPABILITY_PROBE_PNG_RGBA_BYTES,
  probeProviderCapability,
  type CapabilityProbeOwner,
  type CapabilityProbePair
} from "../src/provider/probes";
import {
  createDeterministicSyntheticPng,
  createDeterministicSyntheticPngInputs
} from "../src/image/png";

const roots: string[] = [];
const now = new Date("2026-07-18T12:00:00.000Z");
const credential = "synthetic-provider-credential";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function createStore(options: {
  readonly endpoints?: ProviderEndpointSet;
  readonly withCredential?: boolean;
  readonly active?: boolean;
  readonly defaultModel?: string;
} = {}): Promise<{
  readonly store: LibrarySettingsStore;
  readonly profileId?: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "routego-provider-integration-"));
  roots.push(root);
  const store = new LibrarySettingsStore({
    dataRoot: root,
    homeDirectory: path.join(root, "home"),
    now: () => now,
    idFactory: () => "provider-synthetic"
  });
  if (options.active === false) {
    await store.readSettings({});
    return { store };
  }
  const created = await store.upsertProviderProfile({
    name: "Synthetic provider",
    endpoints: options.endpoints ?? {
      generation: {
        mode: "legacy-api-base",
        value: "https://relay.example/custom?tenant=synthetic"
      }
    },
    defaultModel: options.defaultModel ?? "synthetic-image-model",
    apiKey: options.withCredential === false
      ? { operation: "unchanged" }
      : { operation: "replace", value: credential },
    setActive: true
  });
  return { store, profileId: created.profile.id };
}

function serviceHealth() {
  return {
    status: "ready" as const,
    version: "1.0.0",
    nodeVersion: process.version,
    uptimeSeconds: 12,
    mcpAvailable: true,
    httpAvailable: false,
    studioAvailable: false
  };
}

function probeInput(input: {
  readonly providerId: string;
  readonly capability?: ProviderCapability;
  readonly transport?: CapabilityProbeInput["transport"];
  readonly requestShape?: string;
}): CapabilityProbeInput {
  return capabilityProbeInputSchema.parse({
    providerId: input.providerId,
    model: "synthetic-image-model",
    capability: input.capability ?? "single-image-input",
    transport: input.transport ?? "single-endpoint-json",
    requestShape: input.requestShape ?? PROVIDER_REQUEST_SHAPES.singleEndpointImage,
    confirmBillableProbe: true
  });
}

function pngBase64(options: {
  readonly width?: number;
  readonly height?: number;
  readonly transparent?: boolean;
} = {}): string {
  const width = options.width ?? 4;
  const height = options.height ?? 4;
  const png = new PNG({ width, height });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = 32;
    png.data[offset + 1] = 96;
    png.data[offset + 2] = 224;
    png.data[offset + 3] = options.transparent === true && offset === 0 ? 0 : 255;
  }
  return PNG.sync.write(png).toString("base64");
}

function jpegBase64(): string {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11,
    0x00, 0x3f, 0x00,
    0x00,
    0xff, 0xd9
  ]).toString("base64");
}

function crc32(bytes: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function pngHeaderBase64(options: {
  readonly width: number;
  readonly height: number;
  readonly bitDepth?: number;
  readonly colorType?: number;
  readonly compressionMethod?: number;
  readonly filterMethod?: number;
  readonly interlaceMethod?: number;
  readonly chunkLength?: number;
  readonly chunkType?: string;
  readonly truncateAt?: number;
  readonly corruptCrc?: boolean;
}): string {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const type = Buffer.from(options.chunkType ?? "IHDR", "ascii");
  const data = Buffer.alloc(13);
  data.writeUInt32BE(options.width >>> 0, 0);
  data.writeUInt32BE(options.height >>> 0, 4);
  data[8] = options.bitDepth ?? 8;
  data[9] = options.colorType ?? 6;
  data[10] = options.compressionMethod ?? 0;
  data[11] = options.filterMethod ?? 0;
  data[12] = options.interlaceMethod ?? 0;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(options.chunkLength ?? 13, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((crc32(Buffer.concat([type, data])) + (options.corruptCrc === true ? 1 : 0)) >>> 0, 0);
  const header = Buffer.concat([signature, length, type, data, crc]);
  return header.subarray(0, options.truncateAt ?? header.byteLength).toString("base64");
}

function probeImageResponse(base64: string): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: base64 }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function successfulProbeResponse(
  input: Pick<CapabilityProbeInput, "capability" | "transport">,
  headers: Readonly<Record<string, string>> = {}
): Response {
  const image = input.capability === "custom-size"
    ? pngBase64({ width: 256, height: 256 })
    : input.capability === "native-transparency"
      ? pngBase64({ transparent: true })
      : input.capability === "output-format"
        ? jpegBase64()
        : pngBase64();
  const body = input.transport === "openai-responses"
    ? {
        id: "response-synthetic",
        status: "completed",
        output: [{
          id: "image-call-synthetic",
          type: "image_generation_call",
          status: "completed",
          result: image
        }]
      }
    : {
        data: Array.from(
          { length: input.capability === "native-variants" ? 2 : 1 },
          () => ({ b64_json: image })
        )
      };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers }
  });
}

function mockProbeOwner(): {
  readonly owner: CapabilityProbeOwner & {
    getRuntimeProviderProfile: ReturnType<typeof vi.fn<() => Promise<RuntimeProviderProfile>>>;
    persistCapabilityProbe: ReturnType<
      typeof vi.fn<(result: CapabilityProbeResult) => Promise<void>>
    >;
  };
  readonly profile: RuntimeProviderProfile;
} {
  const endpoints: ProviderEndpointSet = {
    generation: {
      mode: "exact-generation-endpoint",
      value: "https://relay.example/generate"
    },
    edits: "https://relay.example/edits",
    responses: "https://relay.example/responses"
  };
  let profile: RuntimeProviderProfile = {
    id: "provider-synthetic",
    name: "Synthetic provider",
    endpoints,
    normalizedEndpoints: normalizeProviderEndpoints(endpoints),
    defaultModel: "synthetic-image-model",
    models: ["synthetic-image-model"],
    capabilities: [],
    credential
  };
  const owner: CapabilityProbeOwner & {
    getRuntimeProviderProfile: ReturnType<typeof vi.fn<() => Promise<RuntimeProviderProfile>>>;
    persistCapabilityProbe: ReturnType<
      typeof vi.fn<(result: CapabilityProbeResult) => Promise<void>>
    >;
  } = {
    getRuntimeProviderProfile: vi.fn(async () => profile),
    persistCapabilityProbe: vi.fn<(result: CapabilityProbeResult) => Promise<void>>(async (result) => {
      profile = { ...profile, capabilities: [result.record] };
    })
  };
  return { owner, get profile() { return profile; } };
}

async function assertProbeRequestSemantics(
  pair: CapabilityProbePair,
  init: RequestInit | undefined
): Promise<void> {
  expect(init?.method).toBe("POST");
  expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${credential}`);
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  if (pair.requestShape === PROVIDER_REQUEST_SHAPES.singleEndpointImage) {
    expect(body["image"]).toMatch(/^data:image\/png;base64,/u);
  }
  if (pair.requestShape === PROVIDER_REQUEST_SHAPES.singleEndpointImages) {
    expect(body["images"]).toEqual([
      expect.stringMatching(/^data:image\/png;base64,/u),
      expect.stringMatching(/^data:image\/png;base64,/u)
    ]);
  }
  if (pair.requestShape === PROVIDER_REQUEST_SHAPES.responsesImageGeneration) {
    const input = body["input"] as Array<{ content: Array<Record<string, unknown>> }>;
    const images = input[0]?.content.filter((item) => item["type"] === "input_image") ?? [];
    expect(images).toHaveLength(pair.capability === "multi-image-input" ? 2 :
      ["single-image-input", "data-url-input"].includes(pair.capability) ? 1 : 0);
    for (const image of images) {
      expect(image["image_url"]).toMatch(/^data:image\/png;base64,/u);
    }
    const tools = body["tools"] as Array<Record<string, unknown>>;
    expect(tools[0]?.["action"]).toBe(pair.capability === "text-generation"
        ? "generate"
        : "auto");
  }
  if (pair.capability === "native-variants") expect(body["n"]).toBe(2);
  if (pair.capability === "custom-size") expect(body["size"]).toBe("256x256");
  if (pair.capability === "output-format") expect(body["output_format"]).toBe("jpeg");
  if (pair.capability === "native-transparency") expect(body["background"]).toBe("transparent");
}

describe("deterministic synthetic PNG fixtures", () => {
  it("emits repeatable bounded PNG and alpha-mask bytes", () => {
    const first = createDeterministicSyntheticPng("image");
    const second = createDeterministicSyntheticPng("image");
    const mask = createDeterministicSyntheticPng("mask");

    expect(first.sha256).toBe(second.sha256);
    expect(Buffer.from(first.bytes)).toEqual(Buffer.from(second.bytes));
    expect(first.dataUrl).toBe(second.dataUrl);
    expect(first.byteLength).toBeLessThan(1_024);

    const decoded = PNG.sync.read(Buffer.from(first.bytes));
    const decodedMask = PNG.sync.read(Buffer.from(mask.bytes));
    expect(decoded).toMatchObject({ width: 4, height: 4 });
    expect(decodedMask).toMatchObject({ width: 4, height: 4 });
    expect([...decodedMask.data].filter((_value, index) => index % 4 === 3)).toContain(0);
    expect(first.dataUrl).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/u);
  });
});

describe("Library-owned provider runtime context and status", () => {
  it("loads only the active Library profile, exact endpoints, credential, model, and bounded policy", async () => {
    const { store } = await createStore({
      endpoints: {
        generation: {
          mode: "legacy-api-base",
          value: "https://relay.example/custom?tenant=synthetic"
        },
        models: "https://models.example/v2/catalog?tenant=synthetic",
        edits: "https://relay.example/explicit-edits",
        responses: "https://responses.example/v1/run"
      }
    });
    const fetchImpl = vi.fn<typeof fetch>();
    const context = await loadProviderContext(store, {}, { fetch: fetchImpl });

    expect(context).toMatchObject({
      providerId: "provider-synthetic",
      model: "synthetic-image-model",
      apiKey: credential,
      deadlines: {
        responseHeaderMs: 300_000,
        bodyMs: 300_000,
        downloadMs: 300_000,
        totalMs: 300_000
      },
      retry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 5_000 }
    });
    expect(context.fetch).toBe(fetchImpl);
    expect(context.endpoints).toEqual({
      generation: {
        mode: "legacy-api-base",
        value: "https://relay.example/custom?tenant=synthetic"
      },
      models: "https://models.example/v2/catalog?tenant=synthetic",
      edits: "https://relay.example/explicit-edits",
      responses: "https://responses.example/v1/run"
    });
  });

  it("fails safely for missing active profile, missing key, and unavailable requested model", async () => {
    const empty = await createStore({ active: false });
    await expect(loadProviderContext(empty.store)).rejects.toMatchObject({
      serviceError: { code: "config_missing" }
    });

    const withoutKey = await createStore({ withCredential: false });
    await expect(loadProviderContext(withoutKey.store)).rejects.toMatchObject({
      serviceError: { code: "config_missing", safeMessage: expect.not.stringContaining(credential) }
    });

    const configured = await createStore();
    await expect(
      loadProviderContext(configured.store, { model: "unlisted-model" })
    ).rejects.toMatchObject({ serviceError: { code: "invalid_input" } });
  });

  it("Task 4.4 loads the atomically selected fallback profile and model", async () => {
    const { store } = await createStore({ defaultModel: "active-model" });
    await store.upsertProviderProfile({
      profileId: "provider-fallback",
      name: "Fallback provider",
      endpoints: {
        generation: { mode: "legacy-api-base", value: "https://fallback.example/v1" }
      },
      defaultModel: "fallback-model",
      apiKey: { operation: "replace", value: credential },
      setActive: false
    });
    const switched = await store.studioProviderSwitch({
      profileId: "provider-fallback",
      preferredModel: "active-model"
    });
    const context = await loadProviderContext(store);
    expect(switched).toMatchObject({ selectedModel: "fallback-model", modelPreserved: false });
    expect(context).toMatchObject({ providerId: "provider-fallback", model: "fallback-model" });
  });

  it("builds redacted status snapshots and drops evidence scoped to stale endpoints", async () => {
    const { store, profileId } = await createStore();
    const runtime = await store.getRuntimeProviderProfile();
    const currentFingerprint = fingerprintProviderEndpoint(
      runtime.normalizedEndpoints.generationEndpoint
    );
    await store.persistCapabilityProbe({
      schemaVersion: 1,
      providerId: profileId!,
      model: "synthetic-image-model",
      status: "completed",
      record: {
        capability: "single-image-input",
        scope: {
          providerId: profileId!,
          model: "synthetic-image-model",
          endpointFingerprint: currentFingerprint,
          transport: "single-endpoint-json",
          requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointImage
        },
        state: "supported",
        evidence: [{
          source: "successful-request",
          observedAt: now.toISOString(),
          summary: "Synthetic success."
        }],
        verifiedAt: now.toISOString()
      },
      mayHaveBilled: true
    });
    await store.persistCapabilityProbe({
      schemaVersion: 1,
      providerId: profileId!,
      model: "synthetic-image-model",
      status: "completed",
      record: {
        capability: "multi-image-input",
        scope: {
          providerId: profileId!,
          model: "synthetic-image-model",
          endpointFingerprint: "f".repeat(64),
          transport: "single-endpoint-json",
          requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointImages
        },
        state: "supported",
        evidence: [{
          source: "successful-request",
          observedAt: now.toISOString(),
          summary: "Stale synthetic success."
        }],
        verifiedAt: now.toISOString()
      },
      mayHaveBilled: true
    });

    const status = await readProviderStatus(store, { service: serviceHealth });
    expect(status).toMatchObject({
      configured: true,
      hasApiKey: true,
      providerId: profileId,
      models: ["synthetic-image-model"],
      service: { status: "ready" }
    });
    expect(status.capabilities).toHaveLength(1);
    expect(status.capabilities[0]?.capabilities.map((item) => item.capability)).toEqual([
      "single-image-input"
    ]);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain("tenant=synthetic");
    expect(serialized).toContain("[REDACTED]");
  });

  it("recursively redacts and bounds provider diagnostics", () => {
    const circular: Record<string, unknown> = {
      authorization: `Bearer ${credential}`,
      nested: {
        apiKey: credential,
        sessionToken: "synthetic-session-token",
        path: "C:\\Users\\Synthetic\\Pictures\\private.png",
        posix: "/home/synthetic/private.png",
        url: "https://relay.example/v1/run?api_key=synthetic",
        imageData: "data:image/png;base64,QUJDRA=="
      },
      long: "x".repeat(20_000)
    };
    circular["self"] = circular;
    const diagnostic = boundedRedactedDiagnostic(circular);
    const serialized = JSON.stringify(diagnostic);
    expect(serialized.length).toBeLessThanOrEqual(8_192);
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain("synthetic-session-token");
    expect(serialized).not.toContain("private.png");
    expect(serialized).not.toContain("QUJDRA");
    expect(serialized).not.toContain("api_key=synthetic");
    expect(serialized).toMatch(/REDACTED|CIRCULAR|TRUNCATED/u);
  });
});

describe("explicit non-billable model refresh", () => {
  it("never derives /models and sends no request without an explicit models endpoint", async () => {
    const { store, profileId } = await createStore();
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await refreshProviderModels(store, { providerId: profileId! }, { fetch: fetchImpl });

    expect(result).toMatchObject({
      status: "failed",
      billable: false,
      error: { code: "config_missing", mayHaveBilled: false }
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the exact configured endpoint once, accepts bounded compatible shapes, and persists models", async () => {
    const endpoint = "https://models.example/v2/catalog?tenant=synthetic";
    const { store, profileId } = await createStore({
      endpoints: {
        generation: { mode: "exact-generation-endpoint", value: "https://relay.example/generate" },
        models: endpoint
      }
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe(endpoint);
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${credential}`);
      return new Response(JSON.stringify({
        object: "list",
        data: [{ id: "synthetic-image-model" }, { id: "synthetic-image-model-v2" }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await refreshProviderModels(store, { providerId: profileId! }, {
      fetch: fetchImpl,
      now: () => now
    });
    expect(result).toEqual({
      schemaVersion: 1,
      providerId: profileId,
      status: "succeeded",
      billable: false,
      models: ["synthetic-image-model", "synthetic-image-model-v2"],
      refreshedAt: now.toISOString()
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await store.getRuntimeProviderProfile(profileId)).models).toEqual(result.models);
    expect(parseBoundedModelPayload({ models: ["a", { id: "b" }, "a"] })).toEqual([
      "a",
      "b"
    ]);
  });

  it("rejects oversized/invalid model responses and missing credentials without leakage", async () => {
    const endpoints: ProviderEndpointSet = {
      generation: { mode: "exact-generation-endpoint", value: "https://relay.example/generate" },
      models: "https://models.example/list"
    };
    const configured = await createStore({ endpoints });
    const oversized = await refreshProviderModels(
      configured.store,
      { providerId: configured.profileId! },
      {
        maxResponseBytes: 16,
        fetch: async () => new Response("x".repeat(100), {
          status: 200,
          headers: { "content-type": "application/json", "content-length": "100" }
        })
      }
    );
    expect(oversized).toMatchObject({ status: "failed", billable: false, error: { code: "invalid_response" } });

    const withoutKey = await createStore({ endpoints, withCredential: false });
    const fetchImpl = vi.fn<typeof fetch>();
    const missing = await refreshProviderModels(
      withoutKey.store,
      { providerId: withoutKey.profileId! },
      { fetch: fetchImpl }
    );
    expect(missing).toMatchObject({ status: "failed", error: { code: "config_missing" } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify([oversized, missing])).not.toContain(credential);
    expect(MAX_MODEL_RESPONSE_BYTES).toBe(256 * 1024);
  });
});

describe("exact confirmed capability probes", () => {
  const generationProbePairs = CAPABILITY_PROBE_PAIRS.filter(
    (pair) => pair.requestShape !== undefined
  );

  it("rejects an unconfirmed probe before profile or network access", async () => {
    const owner = {
      getRuntimeProviderProfile: vi.fn<() => Promise<RuntimeProviderProfile>>(),
      persistCapabilityProbe: vi.fn()
    };
    const unconfirmed = {
      providerId: "provider-synthetic",
      model: "synthetic-image-model",
      capability: "single-image-input",
      transport: "single-endpoint-json",
      requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointImage,
      confirmBillableProbe: false
    } as unknown as CapabilityProbeInput;
    await expect(probeProviderCapability(owner, unconfirmed, { fetch: vi.fn() })).rejects.toMatchObject({
      serviceError: { code: "invalid_request" }
    });
    expect(owner.getRuntimeProviderProfile).not.toHaveBeenCalled();
  });

  it.each(generationProbePairs.map((pair) => [
    `${pair.transport} ${pair.requestShape} ${pair.capability}`,
    pair
  ] as const))("materially exercises and proves allowed pair %s", async (_label, pair) => {
    const { owner } = mockProbeOwner();
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      await assertProbeRequestSemantics(pair, init);
      return successfulProbeResponse(pair);
    });
    const result = await probeProviderCapability(owner, probeInput({
      providerId: "provider-synthetic",
      capability: pair.capability,
      transport: pair.transport,
      requestShape: pair.requestShape
    }), { fetch: fetchImpl, now: () => now });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(owner.getRuntimeProviderProfile).toHaveBeenCalledTimes(1);
    expect(owner.persistCapabilityProbe).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "completed",
      mayHaveBilled: true,
      record: {
        capability: pair.capability,
        state: "supported",
        scope: {
          transport: pair.transport,
          requestShape: pair.requestShape
        }
      }
    });
  });

  it("rejects every unprovable or representation-mismatched pair before profile, network, or persistence", async () => {
    const rejectedPairs: readonly CapabilityProbePair[] = [
      ...[PROVIDER_REQUEST_SHAPES.singleEndpointText, PROVIDER_REQUEST_SHAPES.imagesGenerationsJson]
        .flatMap((requestShape): CapabilityProbePair[] => {
          const transport = requestShape === PROVIDER_REQUEST_SHAPES.singleEndpointText
            ? "single-endpoint-json" as const
            : "openai-images" as const;
          return ["quality-control", "compression", "moderation"].map((capability) => ({
            transport,
            requestShape,
            capability: capability as ProviderCapability
          }));
        }),
      ...[PROVIDER_REQUEST_SHAPES.singleEndpointImage, PROVIDER_REQUEST_SHAPES.singleEndpointImages]
        .flatMap((requestShape): CapabilityProbePair[] => [
          {
            transport: "single-endpoint-json",
            requestShape,
            capability: "image-url-input"
          },
          {
            transport: "single-endpoint-json",
            requestShape,
            capability: "base64-input"
          }
        ]),
      {
        transport: "single-endpoint-json",
        requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointImage,
        capability: "canvas-expansion"
      },
      ...[
        "streaming",
        "partial-images",
        "responses-state",
        "image-url-input",
        "base64-input",
        "file-id-input",
        "image-id-input"
      ].map((capability): CapabilityProbePair => ({
        transport: "openai-responses",
        requestShape: PROVIDER_REQUEST_SHAPES.responsesImageGeneration,
        capability: capability as ProviderCapability
      }))
    ];

    for (const pair of rejectedPairs) {
      const { owner } = mockProbeOwner();
      const fetchImpl = vi.fn<typeof fetch>();
      await expect(probeProviderCapability(owner, probeInput({
        providerId: "provider-synthetic",
        capability: pair.capability,
        transport: pair.transport,
        requestShape: pair.requestShape
      }), { fetch: fetchImpl })).rejects.toMatchObject({
        serviceError: { code: "invalid_request", mayHaveBilled: false }
      });
      expect(owner.getRuntimeProviderProfile).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(owner.persistCapabilityProbe).not.toHaveBeenCalled();
    }
  });

  it("keeps a generic successful HTTP response inconclusive instead of promoting support", async () => {
    const { owner } = mockProbeOwner();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const result = await probeProviderCapability(owner, probeInput({
      providerId: "provider-synthetic"
    }), { fetch: fetchImpl, now: () => now });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(owner.persistCapabilityProbe).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "failed",
      mayHaveBilled: true,
      record: { state: "unknown" },
      error: { code: "invalid_response", mayHaveBilled: true }
    });
  });

  it.each([
    {
      label: "variants without two outputs",
      capability: "native-variants" as const,
      transport: "single-endpoint-json" as const,
      requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointText,
      body: { data: [{ b64_json: pngBase64() }] }
    },
    {
      label: "custom size with wrong dimensions",
      capability: "custom-size" as const,
      transport: "single-endpoint-json" as const,
      requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointText,
      body: { data: [{ b64_json: pngBase64() }] }
    },
    {
      label: "JPEG format request with PNG output",
      capability: "output-format" as const,
      transport: "openai-images" as const,
      requestShape: PROVIDER_REQUEST_SHAPES.imagesGenerationsJson,
      body: { data: [{ b64_json: pngBase64() }] }
    },
    {
      label: "transparent background request with opaque output",
      capability: "native-transparency" as const,
      transport: "openai-images" as const,
      requestShape: PROVIDER_REQUEST_SHAPES.imagesGenerationsJson,
      body: { data: [{ b64_json: pngBase64() }] }
    },
    {
      label: "Responses success without completed image_generation_call output",
      capability: "single-image-input" as const,
      transport: "openai-responses" as const,
      requestShape: PROVIDER_REQUEST_SHAPES.responsesImageGeneration,
      body: { status: "completed", output: [{ type: "message", status: "completed" }] }
    }
  ])("keeps $label inconclusive", async ({ capability, transport, requestShape, body }) => {
    const { owner } = mockProbeOwner();
    const result = await probeProviderCapability(owner, probeInput({
      providerId: "provider-synthetic",
      capability,
      transport,
      requestShape
    }), {
      fetch: async () => new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-routego-capability-state": "degraded"
        }
      }),
      now: () => now
    });
    expect(result).toMatchObject({
      status: "failed",
      record: { state: "unknown" },
      error: { code: "invalid_response" }
    });
  });

  it("accepts a valid PNG exactly at the capability-proof dimension, pixel, and RGBA limits", async () => {
    expect(MAX_CAPABILITY_PROBE_PNG_PIXELS).toBe(
      MAX_CAPABILITY_PROBE_PNG_DIMENSION * 1_024
    );
    expect(MAX_CAPABILITY_PROBE_PNG_RGBA_BYTES).toBe(
      MAX_CAPABILITY_PROBE_PNG_PIXELS * 4
    );
    const boundaryPng = pngBase64({
      width: MAX_CAPABILITY_PROBE_PNG_DIMENSION,
      height: 1_024
    });
    const readSpy = vi.spyOn(PNG.sync, "read");
    const { owner } = mockProbeOwner();
    const fetchImpl = vi.fn<typeof fetch>(async () => probeImageResponse(boundaryPng));
    const result = await probeProviderCapability(owner, probeInput({
      providerId: "provider-synthetic"
    }), { fetch: fetchImpl, now: () => now });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "completed",
      mayHaveBilled: true,
      record: { state: "supported" }
    });
  });

  it("rejects unsafe or malformed PNG IHDR values before pngjs allocation", async () => {
    const cases = [
      {
        label: "unsafe integer pixel multiplication",
        value: pngHeaderBase64({ width: 0xffff_ffff, height: 0xffff_ffff })
      },
      {
        label: "one dimension over",
        value: pngHeaderBase64({
          width: MAX_CAPABILITY_PROBE_PNG_DIMENSION + 1,
          height: 1
        })
      },
      {
        label: "one row over the pixel and RGBA bound",
        value: pngHeaderBase64({
          width: MAX_CAPABILITY_PROBE_PNG_DIMENSION,
          height: 1_025
        })
      },
      {
        label: "zero width",
        value: pngHeaderBase64({ width: 0, height: 1 })
      },
      {
        label: "unsupported bit depth and color type combination",
        value: pngHeaderBase64({ width: 1, height: 1, bitDepth: 4, colorType: 6 })
      },
      {
        label: "unsupported compression method",
        value: pngHeaderBase64({ width: 1, height: 1, compressionMethod: 1 })
      },
      {
        label: "invalid IHDR length",
        value: pngHeaderBase64({ width: 1, height: 1, chunkLength: 12 })
      },
      {
        label: "invalid first chunk type",
        value: pngHeaderBase64({ width: 1, height: 1, chunkType: "IDAT" })
      },
      {
        label: "invalid IHDR CRC",
        value: pngHeaderBase64({ width: 1, height: 1, corruptCrc: true })
      },
      {
        label: "truncated IHDR",
        value: pngHeaderBase64({ width: 1, height: 1, truncateAt: 28 })
      }
    ] as const;
    const readSpy = vi.spyOn(PNG.sync, "read");

    for (const testCase of cases) {
      const { owner } = mockProbeOwner();
      const fetchImpl = vi.fn<typeof fetch>(async () => probeImageResponse(testCase.value));
      const result = await probeProviderCapability(owner, probeInput({
        providerId: "provider-synthetic"
      }), { fetch: fetchImpl, now: () => now });

      expect(fetchImpl, testCase.label).toHaveBeenCalledTimes(1);
      expect(owner.persistCapabilityProbe, testCase.label).toHaveBeenCalledTimes(1);
      expect(result, testCase.label).toMatchObject({
        status: "failed",
        mayHaveBilled: true,
        record: { state: "unknown" },
        error: { code: "invalid_response", mayHaveBilled: true }
      });
      const persisted = owner.persistCapabilityProbe.mock.calls[0]?.[0];
      expect(persisted?.record.state, testCase.label).toBe("unknown");
      expect(
        persisted?.record.evidence.some(
          (item) => item.source === "successful-request" || item.source === "degraded-fallback"
        ),
        testCase.label
      ).toBe(false);
    }

    expect(readSpy).not.toHaveBeenCalled();
  });

  it("rejects 16-bit and interlaced pngjs decoder profiles before allocation", async () => {
    const cases = [
      { label: "16-bit grayscale", value: pngHeaderBase64({ width: 1, height: 1, bitDepth: 16, colorType: 0 }) },
      { label: "16-bit RGB", value: pngHeaderBase64({ width: 1, height: 1, bitDepth: 16, colorType: 2 }) },
      { label: "16-bit grayscale alpha", value: pngHeaderBase64({ width: 1, height: 1, bitDepth: 16, colorType: 4 }) },
      { label: "16-bit RGBA", value: pngHeaderBase64({ width: 1, height: 1, bitDepth: 16, colorType: 6 }) },
      { label: "Adam7 interlace", value: pngHeaderBase64({ width: 1, height: 1, interlaceMethod: 1 }) }
    ] as const;
    const readSpy = vi.spyOn(PNG.sync, "read");

    for (const testCase of cases) {
      const { owner } = mockProbeOwner();
      const fetchImpl = vi.fn<typeof fetch>(async () => probeImageResponse(testCase.value));
      const result = await probeProviderCapability(owner, probeInput({
        providerId: "provider-synthetic"
      }), { fetch: fetchImpl, now: () => now });

      expect(fetchImpl, testCase.label).toHaveBeenCalledTimes(1);
      expect(owner.persistCapabilityProbe, testCase.label).toHaveBeenCalledTimes(1);
      expect(result, testCase.label).toMatchObject({
        status: "failed",
        mayHaveBilled: true,
        record: { state: "unknown" },
        error: { code: "invalid_response", mayHaveBilled: true }
      });
      const persisted = owner.persistCapabilityProbe.mock.calls[0]?.[0];
      expect(
        persisted?.record.evidence.some(
          (item) => item.source === "successful-request" || item.source === "degraded-fallback"
        ),
        testCase.label
      ).toBe(false);
    }

    expect(readSpy).not.toHaveBeenCalled();
  });

  it("rejects the removed OpenAI Images edits multi-image probe before network access", async () => {
    const { owner } = mockProbeOwner();
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(probeProviderCapability(owner, probeInput({
      providerId: "provider-synthetic",
      capability: "multi-image-input",
      transport: "openai-images",
      requestShape: "openai-images:edits-multipart"
    }), { fetch: fetchImpl, now: () => now })).rejects.toMatchObject({
      serviceError: { code: "invalid_request" }
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends exactly two deterministic input_image entries for a Responses multi-image probe", async () => {
    const { owner } = mockProbeOwner();
    const synthetic = createDeterministicSyntheticPngInputs();
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        input: Array<{ content: Array<Record<string, unknown>> }>;
      };
      const images = body.input[0]!.content.filter((item) => item["type"] === "input_image");
      expect(images).toEqual([
        { type: "input_image", image_url: synthetic.image.dataUrl },
        { type: "input_image", image_url: synthetic.mask.dataUrl }
      ]);
      return successfulProbeResponse({
        capability: "multi-image-input",
        transport: "openai-responses"
      });
    });
    await probeProviderCapability(owner, probeInput({
      providerId: "provider-synthetic",
      capability: "multi-image-input",
      transport: "openai-responses",
      requestShape: PROVIDER_REQUEST_SHAPES.responsesImageGeneration
    }), { fetch: fetchImpl, now: () => now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends exactly one authorized deterministic PNG request and persists supported evidence", async () => {
    const { store, profileId } = await createStore();
    const expected = createDeterministicSyntheticPngInputs().image.dataUrl;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe("https://relay.example/custom/v1/images/generations?tenant=synthetic");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${credential}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body["image"]).toBe(expected);
      return successfulProbeResponse({
        capability: "single-image-input",
        transport: "single-endpoint-json"
      });
    });
    const result = await probeProviderCapability(store, probeInput({ providerId: profileId! }), {
      fetch: fetchImpl,
      now: () => now
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "completed",
      mayHaveBilled: true,
      record: { state: "supported", verifiedAt: now.toISOString() }
    });
    const persisted = await store.getRuntimeProviderProfile(profileId);
    expect(persisted.capabilities).toHaveLength(1);
    expect(persisted.capabilities[0]).toMatchObject({ state: "supported" });
    expect(JSON.stringify(result)).not.toContain(pngBase64());
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it("persists supported, unsupported, degraded, and transient matrices without replay", async () => {
    const { store, profileId } = await createStore({
      endpoints: {
        generation: { mode: "exact-generation-endpoint", value: "https://relay.example/generate" },
        responses: "https://relay.example/responses"
      }
    });
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(successfulProbeResponse({
        capability: "single-image-input",
        transport: "single-endpoint-json"
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "unsupported_feature", message: credential } }), {
        status: 415,
        headers: { "content-type": "application/json" }
      }))
      .mockResolvedValueOnce(successfulProbeResponse({
        capability: "single-image-input",
        transport: "openai-responses"
      }, {
          "x-routego-capability-state": "degraded",
          "x-routego-degraded-reason": `Previous output must be uploaded again. Authorization: Bearer ${credential} C:\\Users\\Synthetic\\probe.png`
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "rate_limited", message: credential } }), {
        status: 429,
        headers: { "content-type": "application/json" }
      }));

    const supportedInput = probeInput({ providerId: profileId! });
    const supported = await probeProviderCapability(store, supportedInput, { fetch: fetchImpl, now: () => now });
    const unsupported = await probeProviderCapability(store, probeInput({
      providerId: profileId!,
      capability: "multi-image-input",
      requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointImages
    }), { fetch: fetchImpl, now: () => now });
    const degraded = await probeProviderCapability(store, probeInput({
      providerId: profileId!,
      capability: "single-image-input",
      transport: "openai-responses",
      requestShape: PROVIDER_REQUEST_SHAPES.responsesImageGeneration
    }), { fetch: fetchImpl, now: () => now });
    const transient = await probeProviderCapability(store, supportedInput, { fetch: fetchImpl, now: () => now });

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(supported.record.state).toBe("supported");
    expect(unsupported.record.state).toBe("unsupported");
    expect(degraded.record).toMatchObject({
      state: "degraded"
    });
    expect(degraded.record.degradedReason).toContain("Previous output must be uploaded again.");
    expect(degraded.record.degradedReason).not.toContain(credential);
    expect(degraded.record.degradedReason).not.toContain("probe.png");
    expect(transient).toMatchObject({
      status: "failed",
      mayHaveBilled: true,
      record: { state: "supported" },
      error: { code: "rate_limited", mayHaveBilled: true }
    });
    expect(transient.record.evidence.at(-1)).toMatchObject({ source: "transient-failure" });
    const states = new Set((await store.getRuntimeProviderProfile(profileId)).capabilities.map((item) => item.state));
    expect(states).toEqual(new Set(["supported", "unsupported", "degraded"]));
    expect(JSON.stringify([unsupported, transient])).not.toContain(credential);
  });

  it("rejects the removed exact Edits endpoint probe before network access", async () => {
    const editsEndpoint = "https://relay.example/v1/images/edits?tenant=synthetic";
    const { store, profileId } = await createStore({
      endpoints: {
        generation: { mode: "exact-generation-endpoint", value: "https://relay.example/generate" },
        edits: editsEndpoint
      }
    });
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(probeProviderCapability(store, probeInput({
      providerId: profileId!,
      capability: "single-image-input",
      transport: "openai-images",
      requestShape: "openai-images:edits-multipart"
    }), { fetch: fetchImpl, now: () => now })).rejects.toMatchObject({
      serviceError: { code: "invalid_request" }
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [401, "auth_failed"],
    [429, "rate_limited"],
    [503, "provider_5xx"],
    [422, "invalid_response"]
  ] as const)("keeps HTTP %s transient as %s", async (status, code) => {
    const { store, profileId } = await createStore();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: { code: "isolated_model_failure", message: credential }
    }), { status, headers: { "content-type": "application/json" } }));
    const result = await probeProviderCapability(store, probeInput({ providerId: profileId! }), {
      fetch: fetchImpl,
      now: () => now
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "failed",
      mayHaveBilled: true,
      record: { state: "unknown" },
      error: { code, mayHaveBilled: true }
    });
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it("does not submit removed Edits or mismatched capability shapes", async () => {
    const { store, profileId } = await createStore();
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(probeProviderCapability(store, probeInput({
      providerId: profileId!,
      capability: "single-image-input",
      transport: "openai-images",
      requestShape: "openai-images:edits-multipart"
    }), { fetch: fetchImpl })).rejects.toMatchObject({
      serviceError: { code: "invalid_request" }
    });
    await expect(probeProviderCapability(store, probeInput({
      providerId: profileId!,
      capability: "single-image-input",
      transport: "single-endpoint-json",
      requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointText
    }), { fetch: fetchImpl })).rejects.toBeInstanceOf(ProviderIntegrationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("marks a thrown provider request as one possible billing event and does not retry", async () => {
    const { store, profileId } = await createStore();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error(`Authorization: Bearer ${credential} C:\\Users\\Synthetic\\probe.png`);
    });
    const result = await probeProviderCapability(store, probeInput({ providerId: profileId! }), {
      fetch: fetchImpl,
      now: () => now
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "failed",
      mayHaveBilled: true,
      error: { code: "invalid_response", mayHaveBilled: true }
    });
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(JSON.stringify(result)).not.toContain("probe.png");
  });
});
