import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  providerCapabilityRecordSchema,
  routegoOperationDefinitions,
  routegoOperationNames,
  type ProviderCapability,
  type ProviderCapabilityRecord,
  type ProviderTransport
} from "@routego-image/contracts";
import {
  fingerprintProviderEndpoint,
  PROVIDER_REQUEST_SHAPES
} from "@routego-image/foundation";
import {
  createMockRoutegoService,
  startMockRelayTestServer,
  type MockRelayTestServer
} from "@routego-image/mock-relay";

import {
  createCreationImageService,
  createRoutegoMcpServer,
  ROUTEGO_CREATION_PACKAGE_VERSION,
  type ImageExecutionDependencies,
  type ProviderRuntimeContext
} from "../src/index";

const OBSERVED_AT = "2026-07-18T10:00:00.000Z";

let fixtureDirectory = "";
let targetPath = "";
let supportingPath = "";
let maskPath = "";

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

function syntheticPng(width = 2, height = 2): Buffer {
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
  fixtureDirectory = await mkdtemp(join(tmpdir(), "routego-creation-integration-"));
  targetPath = join(fixtureDirectory, "target.png");
  supportingPath = join(fixtureDirectory, "supporting.png");
  maskPath = join(fixtureDirectory, "mask.png");
  const image = syntheticPng();
  await Promise.all([
    writeFile(targetPath, image),
    writeFile(supportingPath, image),
    writeFile(maskPath, image)
  ]);
});

afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

function endpoint(server: MockRelayTestServer, pathname: string): string {
  return `${server.url}${pathname}`;
}

function capability(
  name: ProviderCapability,
  targetEndpoint: string,
  transport: ProviderTransport,
  requestShape: string
): ProviderCapabilityRecord {
  return providerCapabilityRecordSchema.parse({
    capability: name,
    scope: {
      providerId: "provider-integration",
      model: "gpt-image-2",
      endpointFingerprint: fingerprintProviderEndpoint(targetEndpoint),
      transport,
      requestShape
    },
    state: "supported",
    evidence: [
      {
        source: "successful-request",
        observedAt: OBSERVED_AT,
        summary: "Synthetic offline integration evidence.",
        requestShape
      }
    ],
    verifiedAt: OBSERVED_AT
  });
}

function providerRuntime(
  server: MockRelayTestServer,
  overrides: Partial<ProviderRuntimeContext> = {}
): ProviderRuntimeContext {
  return {
    providerId: "provider-integration",
    model: "gpt-image-2",
    endpoints: {
      generation: {
        mode: "exact-generation-endpoint",
        value: endpoint(server, "/v1/images/generations")
      }
    },
    capabilities: [],
    apiKey: "synthetic-integration-key",
    fetch,
    deadlines: {
      responseHeaderMs: 2_000,
      bodyMs: 2_000,
      downloadMs: 2_000,
      totalMs: 10_000
    },
    retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 },
    now: () => Date.parse(OBSERVED_AT),
    random: () => 0,
    ...overrides
  };
}

function dependencies(
  runtime: ProviderRuntimeContext,
  suffix: string,
  overrides: Partial<ImageExecutionDependencies> = {}
): ImageExecutionDependencies {
  return {
    providerContext: runtime,
    createRequestId: () => `request-integration-${suffix}`,
    ...overrides
  };
}

async function close(server: MockRelayTestServer): Promise<void> {
  await server.close();
}

describe("Creation package integration", () => {
  it("exports the approved runtime surface and exposes exactly the seven frozen MCP tools", async () => {
    expect(ROUTEGO_CREATION_PACKAGE_VERSION).toBe(1);
    const server = createRoutegoMcpServer({
      service: createMockRoutegoService({ requestId: "request-integration-mcp" })
    });
    await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const response = await server.handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    if (response === undefined || !("result" in response)) {
      throw new Error("Expected a successful MCP tools/list response");
    }
    const tools = (response.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(
      routegoOperationNames.map((operation) => routegoOperationDefinitions[operation].toolName)
    );
    expect(tools).toHaveLength(7);
  });

  it("runs Tier A text and evidenced single-image requests through the offline relay", async () => {
    const textServer = await startMockRelayTestServer({ fixture: "single-endpoint-text" });
    try {
      const service = createCreationImageService(
        dependencies(providerRuntime(textServer), "tier-a-text")
      );
      const generated = await service.generate({
        kind: "generate",
        prompt: "Offline Tier A text generation"
      });
      expect(generated).toMatchObject({
        status: "succeeded",
        execution: { transport: "single-endpoint-json", providerRequestCount: 1 }
      });
      expect(textServer.relay.observations).toHaveLength(1);
      expect(textServer.relay.observations[0]).toMatchObject({
        method: "POST",
        pathname: "/v1/images/generations",
        headers: { authorization: "[REDACTED]" }
      });
    } finally {
      await close(textServer);
    }

    const imageServer = await startMockRelayTestServer({ fixture: "single-endpoint-image" });
    try {
      const generationEndpoint = endpoint(imageServer, "/v1/images/generations");
      const shape = PROVIDER_REQUEST_SHAPES.singleEndpointImage;
      const runtime = providerRuntime(imageServer, {
        capabilities: ["single-image-input", "data-url-input", "target-edit"].map((name) =>
          capability(name as ProviderCapability, generationEndpoint, "single-endpoint-json", shape)
        )
      });
      const edited = await createCreationImageService(
        dependencies(runtime, "tier-a-image")
      ).edit({
        kind: "edit",
        prompt: "Offline Tier A image edit",
        targetImage: { path: targetPath },
        invariants: { preserve: ["subject identity"] }
      });
      expect(edited).toMatchObject({
        status: "succeeded",
        execution: { transport: "single-endpoint-json", providerRequestCount: 1 }
      });
      expect(JSON.stringify(imageServer.relay.observations[0]?.bodyShape)).toContain(
        "image-data-url"
      );
    } finally {
      await close(imageServer);
    }
  });

  it("runs explicit Images multipart with target-first ordering and mask slot zero", async () => {
    const server = await startMockRelayTestServer({ fixture: "openai-images" });
    try {
      const editsEndpoint = endpoint(server, "/v1/images/edits");
      const shape = PROVIDER_REQUEST_SHAPES.imagesEditsMultipart;
      const runtime = providerRuntime(server, {
        endpoints: {
          generation: {
            mode: "exact-generation-endpoint",
            value: endpoint(server, "/v1/images/generations")
          },
          edits: editsEndpoint
        },
        preferredTransports: ["openai-images"],
        capabilities: ["multi-image-input", "multipart-input", "target-edit", "mask-edit"].map(
          (name) => capability(name as ProviderCapability, editsEndpoint, "openai-images", shape)
        )
      });
      const result = await createCreationImageService(
        dependencies(runtime, "images-multipart")
      ).edit({
        kind: "edit",
        prompt: "Offline multipart edit",
        targetImage: { path: targetPath },
        supportingImages: [{ path: supportingPath }],
        maskPath,
        invariants: { preserve: ["layout", "subject"] }
      });
      expect(result).toMatchObject({
        status: "succeeded",
        execution: { transport: "openai-images", providerRequestCount: 1 }
      });
      const bodyShape = server.relay.observations[0]?.bodyShape as {
        entries?: Array<{ name: string }>;
      };
      expect(bodyShape.entries?.map((entry) => entry.name)).toEqual([
        "model",
        "prompt",
        "image",
        "mask",
        "image[]",
        "n",
        "size"
      ]);
    } finally {
      await close(server);
    }
  });

  it("normalizes Responses JSON success and SSE partial failure without replay", async () => {
    const jsonServer = await startMockRelayTestServer({ fixture: "openai-responses-json" });
    try {
      const responsesEndpoint = endpoint(jsonServer, "/v1/responses");
      const shape = PROVIDER_REQUEST_SHAPES.responsesImageGeneration;
      const runtime = providerRuntime(jsonServer, {
        endpoints: {
          generation: {
            mode: "exact-generation-endpoint",
            value: endpoint(jsonServer, "/v1/images/generations")
          },
          responses: responsesEndpoint
        },
        preferredTransports: ["openai-responses"],
        capabilities: [
          capability("text-generation", responsesEndpoint, "openai-responses", shape)
        ]
      });
      const result = await createCreationImageService(
        dependencies(runtime, "responses-json")
      ).generate({ kind: "generate", prompt: "Offline Responses JSON" });
      expect(result).toMatchObject({
        status: "succeeded",
        execution: {
          transport: "openai-responses",
          providerRequestCount: 1,
          providerResponseId: "mock-response-0",
          providerImageIds: ["mock-image-call-0"]
        }
      });
    } finally {
      await close(jsonServer);
    }

    const streamServer = await startMockRelayTestServer({
      fixture: "openai-responses-sse",
      outcome: "partial-then-failure"
    });
    try {
      const responsesEndpoint = endpoint(streamServer, "/v1/responses");
      const shape = PROVIDER_REQUEST_SHAPES.responsesImageGeneration;
      const runtime = providerRuntime(streamServer, {
        endpoints: {
          generation: {
            mode: "exact-generation-endpoint",
            value: endpoint(streamServer, "/v1/images/generations")
          },
          responses: responsesEndpoint
        },
        preferredTransports: ["openai-responses"],
        capabilities: ["text-generation", "streaming", "partial-images"].map((name) =>
          capability(name as ProviderCapability, responsesEndpoint, "openai-responses", shape)
        )
      });
      const result = await createCreationImageService(
        dependencies(runtime, "responses-sse", { sleep: async () => undefined })
      ).generate({
        kind: "generate",
        prompt: "Offline Responses SSE partial",
        partialImages: 1
      });
      expect(result.status).toBe("partial");
      expect(result.partialArtifacts).toHaveLength(1);
      expect(result.execution).toMatchObject({
        transport: "openai-responses",
        providerRequestCount: 1,
        receivedAnyOutput: true,
        mayHaveBilled: true
      });
      expect(result.error?.retryDisposition).toBe("never");
      expect(streamServer.relay.observations).toHaveLength(1);
    } finally {
      await close(streamServer);
    }
  });

  it("returns a pre-generation server failure after one provider request", async () => {
    const server = await startMockRelayTestServer({ fixture: "single-endpoint-text" });
    try {
      const calls: string[] = [];
      const failingFetch: typeof fetch = async (input) => {
        calls.push(String(input));
        return Response.json(
          { error: { code: "temporary", message: "Synthetic pre-generation failure." } },
          { status: 503 }
        );
      };
      const runtime = providerRuntime(server, {
        fetch: failingFetch,
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 }
      });
      const result = await createCreationImageService(
        dependencies(runtime, "single-request")
      ).generate({ kind: "generate", prompt: "Offline single request" });
      expect(result).toMatchObject({
        status: "failed",
        error: { code: "provider_5xx", retryDisposition: "user-confirmation" },
        execution: { attemptCount: 1, providerRequestCount: 1 }
      });
      expect(calls).toEqual([calls[0]]);
      expect(server.relay.observations).toHaveLength(0);
    } finally {
      await close(server);
    }
  });

  it("preserves ordered batch identities and provider counts over the offline relay", async () => {
    const server = await startMockRelayTestServer({ fixture: "single-endpoint-text" });
    try {
      const service = createCreationImageService(
        dependencies(providerRuntime(server), "batch")
      );
      const result = await service.batch({
        tasks: [
          {
            id: "batch-first",
            operation: { kind: "generate", prompt: "Offline batch first" }
          },
          {
            id: "batch-second",
            operation: { kind: "generate", prompt: "Offline batch second" }
          }
        ],
        concurrency: 2
      });
      expect(result.status).toBe("succeeded");
      expect(result.items.map((item) => item.id)).toEqual(["batch-first", "batch-second"]);
      expect(result.items.map((item) => item.result.execution.providerRequestCount)).toEqual([1, 1]);
      expect(server.relay.observations).toHaveLength(2);
    } finally {
      await close(server);
    }
  });
});
