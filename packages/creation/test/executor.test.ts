import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  imageOperationRequestSchema,
  providerCapabilityRecordSchema,
  type ImageOperationEvent,
  type ImageOperationRequest,
  type ProviderCapability,
  type ProviderCapabilityRecord,
  type ProviderTransport
} from "@routego-image/contracts";
import {
  fingerprintProviderEndpoint,
  PROVIDER_REQUEST_SHAPES
} from "@routego-image/foundation";
import {
  createCreationImageService,
  createResolvedImageExecutor,
  decideProviderRetry,
  type ImageExecutionDependencies
} from "../src/execution/index";
import type { ProviderRuntimeContext } from "../src/provider/index";

const OBSERVED_AT = "2026-07-18T10:00:00.000Z";
const GENERATION_ENDPOINT = "https://provider.example/custom/generate?tenant=synthetic";
const EDITS_ENDPOINT = "https://provider.example/custom/edits";
const RESPONSES_ENDPOINT = "https://provider.example/custom/responses";

let fixtureDirectory = "";
let previousOutputPath = "";

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

function syntheticPng(width = 1, height = 1): Buffer {
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

const PNG_BASE64 = syntheticPng().toString("base64");

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "routego-creation-executor-"));
  previousOutputPath = join(fixtureDirectory, "previous.png");
  await writeFile(previousOutputPath, syntheticPng());
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
  const requestShape = options.requestShape ?? PROVIDER_REQUEST_SHAPES.singleEndpointText;
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
    evidence:
      state === "unknown"
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
          ],
    ...(state === "unknown" ? {} : { verifiedAt: OBSERVED_AT }),
    ...(state === "degraded" ? { degradedReason: "Synthetic degraded route." } : {}),
    ...(options.limits === undefined ? {} : { limits: options.limits })
  });
}

function runtime(
  fetchImplementation: typeof fetch,
  overrides: Partial<ProviderRuntimeContext> = {}
): ProviderRuntimeContext {
  return {
    providerId: "provider-a",
    model: "gpt-image-2",
    endpoints: {
      generation: { mode: "exact-generation-endpoint", value: GENERATION_ENDPOINT }
    },
    capabilities: [],
    apiKey: "synthetic-api-key",
    fetch: fetchImplementation,
    deadlines: {
      responseHeaderMs: 1_000,
      bodyMs: 1_000,
      downloadMs: 1_000,
      totalMs: 5_000
    },
    retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 2_000 },
    now: () => Date.parse(OBSERVED_AT),
    random: () => 0,
    ...overrides
  };
}

function request(overrides: Record<string, unknown> = {}): ImageOperationRequest {
  return imageOperationRequestSchema.parse({
    kind: "generate",
    prompt: "Generate a synthetic image",
    ...overrides
  });
}

function imageResponse(count = 1): Response {
  return Response.json({
    data: Array.from({ length: count }, (_, index) => ({
      id: `provider-image-${index}`,
      b64_json: PNG_BASE64
    }))
  });
}

function dependencies(
  provider: ProviderRuntimeContext,
  overrides: Partial<ImageExecutionDependencies> = {}
): ImageExecutionDependencies {
  return {
    providerContext: provider,
    createRequestId: () => "request-executor-test",
    ...overrides
  };
}

function imageCapabilities(
  state: "unknown" | "supported" | "unsupported" | "degraded"
): ProviderCapabilityRecord[] {
  const shape = PROVIDER_REQUEST_SHAPES.singleEndpointImage;
  return [
    capability("single-image-input", { requestShape: shape, state }),
    capability("data-url-input", { requestShape: shape, state: state === "unknown" ? "unknown" : "supported" })
  ];
}

describe("resolved executor success, capability states, and false-success rejection", () => {
  it("executes the unknown text-generation baseline and returns a schema-valid result", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    const result = await createResolvedImageExecutor(dependencies(runtime(fetchMock))).execute(request());
    expect(result).toMatchObject({
      status: "succeeded",
      execution: {
        transport: "single-endpoint-json",
        attemptCount: 1,
        providerRequestCount: 1,
        receivedAnyOutput: true,
        mayHaveBilled: true
      }
    });
    expect(result.finalArtifacts).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors unknown, supported, unsupported, and degraded image capability states without probing", async () => {
    for (const state of ["unknown", "supported", "unsupported", "degraded"] as const) {
      const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
      const provider = runtime(fetchMock, { capabilities: imageCapabilities(state) });
      const result = await createResolvedImageExecutor(dependencies(provider)).execute(
        request({
          references: [{ path: previousOutputPath, role: "reference" }]
        })
      );
      if (state === "supported" || state === "degraded") {
        expect(result.status).toBe("succeeded");
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } else {
        expect(result).toMatchObject({
          status: "failed",
          error: { code: "capability_unavailable" },
          execution: { attemptCount: 0, providerRequestCount: 0 }
        });
        expect(fetchMock).not.toHaveBeenCalled();
      }
    }
  });

  it("rejects a 2xx response with no usable image instead of reporting success", async () => {
    const result = await createResolvedImageExecutor(
      dependencies(runtime(async () => Response.json({ data: [] })))
    ).execute(request());
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "invalid_response", retryDisposition: "never" },
      execution: { providerRequestCount: 1, receivedAnyOutput: false, mayHaveBilled: true }
    });
    expect(result.finalArtifacts).toEqual([]);
  });
});

describe("native variants and same-transport fan-out", () => {
  it("uses one native request only when the scoped native-variant capability permits it", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse(2));
    const provider = runtime(fetchMock, {
      capabilities: [
        capability("native-variants", {
          requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointText,
          limits: { maxVariants: 4 }
        })
      ]
    });
    const result = await createResolvedImageExecutor(dependencies(provider)).execute(request({ count: 2 }));
    expect(result.status).toBe("succeeded");
    expect(result.finalArtifacts.map((artifact) => artifact.slot)).toEqual([0, 1]);
    expect(result.execution).toMatchObject({ attemptCount: 1, providerRequestCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fans out requested variants on the frozen transport and preserves slot identity", async () => {
    const observedBodies: Array<Record<string, unknown>> = [];
    const fetchMock: typeof fetch = async (_input, init) => {
      observedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return imageResponse();
    };
    const result = await createResolvedImageExecutor(dependencies(runtime(fetchMock))).execute(
      request({ count: 3 })
    );
    expect(result.status).toBe("succeeded");
    expect(result.finalArtifacts.map((artifact) => artifact.slot)).toEqual([0, 1, 2]);
    expect(new Set(result.finalArtifacts.map((artifact) => artifact.id)).size).toBe(3);
    expect(result.execution).toMatchObject({ attemptCount: 3, providerRequestCount: 3 });
    expect(observedBodies.map((body) => body["n"])).toEqual([1, 1, 1]);
  });

  it("keeps successful slots when one fan-out request fails", async () => {
    let calls = 0;
    const fetchMock: typeof fetch = async () => {
      calls += 1;
      return calls === 2
        ? Response.json({ error: { code: "provider_failure", message: "Synthetic failure" } }, { status: 503 })
        : imageResponse();
    };
    const provider = runtime(fetchMock, { retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });
    const result = await createResolvedImageExecutor(dependencies(provider)).execute(request({ count: 3 }));
    expect(result.status).toBe("partial");
    expect(result.finalArtifacts.map((artifact) => artifact.slot)).toEqual([0, 2]);
    expect(result.failedSlots).toMatchObject([{ slot: 1, error: { code: "provider_5xx" } }]);
    expect(result.execution.providerRequestCount).toBe(3);
  });
});

describe("retry safety, backoff, and frozen route", () => {
  it("honors bounded Retry-After then exponential same-transport backoff", async () => {
    const delays: number[] = [];
    const urls: string[] = [];
    let calls = 0;
    const fetchMock: typeof fetch = async (input) => {
      urls.push(String(input));
      calls += 1;
      if (calls === 1) {
        return Response.json(
          { error: { code: "rate_limit", message: "Slow down" } },
          { status: 429, headers: { "retry-after": "0.01" } }
        );
      }
      if (calls === 2) {
        return Response.json({ error: { code: "temporary", message: "Unavailable" } }, { status: 503 });
      }
      return imageResponse();
    };
    const result = await createResolvedImageExecutor(
      dependencies(runtime(fetchMock), {
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        }
      })
    ).execute(request());
    expect(result.status).toBe("succeeded");
    expect(result.execution).toMatchObject({ attemptCount: 3, providerRequestCount: 3 });
    expect(delays).toEqual([10, 160]);
    expect(urls).toEqual([GENERATION_ENDPOINT, GENERATION_ENDPOINT, GENERATION_ENDPOINT]);
  });

  it("stops at three total attempts and refuses an overlong Retry-After", async () => {
    const alwaysUnavailable = vi.fn<typeof fetch>(async () =>
      Response.json({ error: { code: "temporary", message: "Unavailable" } }, { status: 503 })
    );
    const failed = await createResolvedImageExecutor(
      dependencies(runtime(alwaysUnavailable), { sleep: async () => undefined })
    ).execute(request());
    expect(failed.status).toBe("failed");
    expect(failed.execution.providerRequestCount).toBe(3);

    const retryError = routeError("rate_limited", "respect-retry-after", { retryAfterMs: 5_000 });
    expect(
      decideProviderRetry(retryError, 1, { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 })
    ).toEqual({ retry: false, delayMs: 0, reason: "retry-after-too-long" });
  });

  it.each([
    [401, { error: { code: "invalid_api_key", message: "Bad key" } }, "auth_failed"],
    [400, { error: { code: "content_policy_violation", message: "Blocked" } }, "moderation_blocked"]
  ] as const)("never retries HTTP %s %s failures", async (status, body, code) => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(body, { status }));
    const result = await createResolvedImageExecutor(
      dependencies(runtime(fetchMock), { sleep: async () => undefined })
    ).execute(request());
    expect(result.error?.code).toBe(code);
    expect(result.execution.providerRequestCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not replay a Responses failure after partial output", async () => {
    const shape = PROVIDER_REQUEST_SHAPES.responsesImageGeneration;
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        id: "response-partial",
        status: "failed",
        output: [
          {
            type: "image_generation_call",
            id: "image-partial",
            status: "in_progress",
            result: PNG_BASE64
          }
        ],
        error: { code: "partial_failure", message: "Failed after output" }
      })
    );
    const provider = runtime(fetchMock, {
      endpoints: {
        generation: { mode: "exact-generation-endpoint", value: GENERATION_ENDPOINT },
        responses: RESPONSES_ENDPOINT
      },
      preferredTransports: ["openai-responses"],
      capabilities: [
        capability("text-generation", {
          endpoint: RESPONSES_ENDPOINT,
          transport: "openai-responses",
          requestShape: shape
        })
      ]
    });
    const result = await createResolvedImageExecutor(
      dependencies(provider, { sleep: async () => undefined })
    ).execute(request());
    expect(result.status).toBe("partial");
    expect(result.partialArtifacts).toHaveLength(1);
    expect(result.execution).toMatchObject({ providerRequestCount: 1, mayHaveBilled: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function routeError(
  code: "rate_limited" | "provider_5xx",
  retryDisposition: "safe-pre-generation" | "respect-retry-after",
  details: Record<string, unknown> = {}
) {
  return {
    code,
    category: code === "rate_limited" ? "rate_limit" as const : "provider" as const,
    stage: "submit" as const,
    safeMessage: "Synthetic retry error",
    retryDisposition,
    partialArtifacts: [],
    receivedAnyOutput: false,
    mayHaveBilled: false,
    details
  };
}

describe("stage deadlines, cancellation, state, continuation, and events", () => {
  it("times out stalled response headers and stalled bodies without replay", async () => {
    const headerFetch = vi.fn<typeof fetch>((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })
    );
    const headerResult = await createResolvedImageExecutor(
      dependencies(runtime(headerFetch, {
        deadlines: { responseHeaderMs: 10, bodyMs: 100, downloadMs: 100, totalMs: 500 }
      }))
    ).execute(request());
    expect(headerResult.error).toMatchObject({ code: "timeout", stage: "submit", retryDisposition: "never" });
    expect(headerResult.execution.providerRequestCount).toBe(1);

    let bodyCancelled = false;
    const bodyResult = await createResolvedImageExecutor(
      dependencies(runtime(async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              bodyCancelled = true;
            }
          }),
          { headers: { "content-type": "application/json" } }
        ), {
        deadlines: { responseHeaderMs: 100, bodyMs: 10, downloadMs: 100, totalMs: 500 }
      }))
    ).execute(request());
    expect(bodyResult.error).toMatchObject({ code: "timeout", stage: "stream" });
    expect(bodyResult.execution.providerRequestCount).toBe(1);
    expect(bodyCancelled).toBe(true);
  });

  it("cancels before submission with zero provider requests", async () => {
    const controller = new AbortController();
    controller.abort(new Error("synthetic-cancel"));
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    const result = await createResolvedImageExecutor(dependencies(runtime(fetchMock))).execute(
      request(),
      { signal: controller.signal }
    );
    expect(result.status).toBe("cancelled");
    expect(result.error?.code).toBe("cancelled");
    expect(result.execution).toMatchObject({ attemptCount: 0, providerRequestCount: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces the total deadline during retry backoff", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ error: { code: "temporary", message: "Unavailable" } }, { status: 503 })
    );
    const result = await createResolvedImageExecutor(
      dependencies(runtime(fetchMock, {
        deadlines: { responseHeaderMs: 100, bodyMs: 100, downloadMs: 100, totalMs: 15 },
        retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 }
      }))
    ).execute(request());
    expect(result.error).toMatchObject({ code: "timeout", stage: "complete" });
    expect(result.execution.providerRequestCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves partial output when the caller cancels a running stream", async () => {
    const controller = new AbortController();
    const shape = PROVIDER_REQUEST_SHAPES.responsesImageGeneration;
    const partialFrame = new TextEncoder().encode(
      `event: response.image_generation_call.partial_image\ndata: ${JSON.stringify({
        type: "response.image_generation_call.partial_image",
        item_id: "image-cancelled",
        output_index: 0,
        partial_image_index: 0,
        partial_image_b64: PNG_BASE64
      })}\n\n`
    );
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            streamController.enqueue(partialFrame);
          }
        }),
        { headers: { "content-type": "text/event-stream" } }
      )
    );
    const provider = runtime(fetchMock, {
      endpoints: {
        generation: { mode: "exact-generation-endpoint", value: GENERATION_ENDPOINT },
        responses: RESPONSES_ENDPOINT
      },
      preferredTransports: ["openai-responses"],
      capabilities: [
        ...["text-generation", "streaming", "partial-images"].map((name) =>
          capability(name as ProviderCapability, {
            endpoint: RESPONSES_ENDPOINT,
            transport: "openai-responses",
            requestShape: shape
          })
        )
      ]
    });
    const result = await createResolvedImageExecutor(dependencies(provider)).execute(
      request({ partialImages: 1 }),
      {
        signal: controller.signal,
        onEvent(event) {
          if (event.type === "partial") controller.abort(new Error("cancel-after-partial"));
        }
      }
    );
    expect(result.status).toBe("partial");
    expect(result.partialArtifacts).toHaveLength(1);
    expect(result.error).toMatchObject({
      code: "cancelled",
      retryDisposition: "never",
      receivedAnyOutput: true,
      mayHaveBilled: true
    });
    expect(result.execution.providerRequestCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("publishes monotonic started/partial/completed events and ignores observer failures", async () => {
    const events: ImageOperationEvent[] = [];
    const shape = PROVIDER_REQUEST_SHAPES.responsesImageGeneration;
    const stream =
      `event: response.image_generation_call.partial_image\ndata: ${JSON.stringify({
        type: "response.image_generation_call.partial_image",
        item_id: "image-event",
        output_index: 0,
        partial_image_index: 0,
        partial_image_b64: PNG_BASE64
      })}\n\n` +
      `event: response.output_item.done\ndata: ${JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "image_generation_call",
          id: "image-event",
          status: "completed",
          result: PNG_BASE64
        }
      })}\n\n` +
      "data: [DONE]\n\n";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(stream, { headers: { "content-type": "text/event-stream" } })
    );
    const provider = runtime(fetchMock, {
      endpoints: {
        generation: { mode: "exact-generation-endpoint", value: GENERATION_ENDPOINT },
        responses: RESPONSES_ENDPOINT
      },
      preferredTransports: ["openai-responses"],
      capabilities: [
        ...["text-generation", "streaming", "partial-images"].map((name) =>
          capability(name as ProviderCapability, {
            endpoint: RESPONSES_ENDPOINT,
            transport: "openai-responses",
            requestShape: shape
          })
        )
      ]
    });
    const result = await createResolvedImageExecutor(
      dependencies(provider, {
        onEvent: (event) => {
          events.push(event);
          if (event.type === "partial") throw new Error("observer failure");
        }
      })
    ).execute(request({ partialImages: 1 }));
    expect(result.status).toBe("succeeded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual(["started", "partial", "completed"]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
  });

  it("exposes only the validated generation service method", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    const imageCaps = imageCapabilities("supported");
    const service = createCreationImageService(dependencies(runtime(fetchMock, { capabilities: imageCaps })));
    const generated = await service.generate({ kind: "generate", prompt: "Service generate" });
    expect(generated.status).toBe("succeeded");
    expect("edit" in service).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
