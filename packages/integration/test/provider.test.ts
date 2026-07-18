import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  capabilityProbeInputSchema,
  type CapabilityProbeInput,
  type ProviderCapability,
  type ProviderEndpointSet
} from "@routego-image/contracts";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LibrarySettingsStore,
  type RuntimeProviderProfile
} from "@routego-image/library";
import { fingerprintProviderEndpoint, PROVIDER_REQUEST_SHAPES } from "@routego-image/foundation";

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
import { probeProviderCapability } from "../src/provider/probes";
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
        responseHeaderMs: 30_000,
        bodyMs: 120_000,
        downloadMs: 30_000,
        totalMs: 180_000
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

  it("sends exactly one authorized deterministic PNG request and persists supported evidence", async () => {
    const { store, profileId } = await createStore();
    const expected = createDeterministicSyntheticPngInputs().image.dataUrl;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe("https://relay.example/custom/v1/images/generations?tenant=synthetic");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${credential}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body["image"]).toBe(expected);
      return new Response(JSON.stringify({ data: [{ b64_json: "discarded-provider-image" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
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
    expect(JSON.stringify(result)).not.toContain("discarded-provider-image");
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
      .mockResolvedValueOnce(new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "unsupported_feature", message: credential } }), {
        status: 415,
        headers: { "content-type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-routego-capability-state": "degraded",
          "x-routego-degraded-reason": `Previous output must be uploaded again. Authorization: Bearer ${credential} C:\\Users\\Synthetic\\probe.png`
        }
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
      capability: "responses-state",
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

  it("uses the exact configured Edits endpoint with deterministic PNG image and mask parts", async () => {
    const editsEndpoint = "https://relay.example/v1/images/edits?tenant=synthetic";
    const { store, profileId } = await createStore({
      endpoints: {
        generation: { mode: "exact-generation-endpoint", value: "https://relay.example/generate" },
        edits: editsEndpoint
      }
    });
    const synthetic = createDeterministicSyntheticPngInputs();
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe(editsEndpoint);
      expect(init?.body).toBeInstanceOf(FormData);
      const body = init?.body as FormData;
      const image = body.get("image");
      const mask = body.get("mask");
      expect(image).toBeInstanceOf(File);
      expect(mask).toBeInstanceOf(File);
      expect((image as File).type).toBe("image/png");
      expect((mask as File).type).toBe("image/png");
      expect(Buffer.from(await (image as File).arrayBuffer())).toEqual(Buffer.from(synthetic.image.bytes));
      expect(Buffer.from(await (mask as File).arrayBuffer())).toEqual(Buffer.from(synthetic.mask.bytes));
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const result = await probeProviderCapability(store, probeInput({
      providerId: profileId!,
      capability: "mask-edit",
      transport: "openai-images",
      requestShape: PROVIDER_REQUEST_SHAPES.imagesEditsMultipart
    }), { fetch: fetchImpl, now: () => now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "completed", mayHaveBilled: true, record: { state: "supported" } });
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

  it("does not derive an Edits endpoint and never submits a mismatched capability shape", async () => {
    const { store, profileId } = await createStore();
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(probeProviderCapability(store, probeInput({
      providerId: profileId!,
      capability: "mask-edit",
      transport: "openai-images",
      requestShape: PROVIDER_REQUEST_SHAPES.imagesEditsMultipart
    }), { fetch: fetchImpl })).rejects.toMatchObject({
      serviceError: { code: "config_missing" }
    });
    await expect(probeProviderCapability(store, probeInput({
      providerId: profileId!,
      capability: "mask-edit",
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
