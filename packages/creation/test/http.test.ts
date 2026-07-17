import { describe, expect, it, vi } from "vitest";

import {
  imageOperationResultSchema,
  routegoStatusResultSchema,
  studioGenerateInputSchema,
  studioImageOperationEventSchema,
  studioImageOperationResultSchema,
  studioServiceErrorSchema,
  type ImageOperationRequest,
  type LocalRoutegoService,
  type StudioImageArtifact,
  type StudioImageOperationRequest
} from "@routego-image/contracts";
import {
  StudioEventBroker,
  createRoutegoHttpDispatcher,
  createRoutegoLoopbackHttpServer,
  createStudioEventStreamResponse,
  serializeStudioImageOperationEvent,
  type RoutegoHttpRequest,
  type RoutegoHttpResponse
} from "../src/runtime/http/index";

const TOKEN = "synthetic-session-token-that-is-long-enough";
const ORIGIN = "http://127.0.0.1:7777";
const TIMESTAMP = "2026-07-18T12:00:00.000Z";

function statusResult() {
  return routegoStatusResultSchema.parse({
    schemaVersion: 1,
    configured: false,
    hasApiKey: false,
    models: [],
    capabilities: [],
    defaults: {
      size: "auto",
      aspectRatio: "auto",
      quality: "auto",
      format: "png",
      count: 1,
      partialImages: 0,
      transparentMode: "off",
      moderation: "auto",
      saveToLibrary: true
    },
    service: {
      status: "ready",
      version: "1.0.0",
      nodeVersion: "v20.19.0",
      uptimeSeconds: 1,
      mcpAvailable: true,
      httpAvailable: true,
      studioAvailable: true
    }
  });
}

function imageResult(input: ImageOperationRequest) {
  return imageOperationResultSchema.parse({
    schemaVersion: 1,
    requestId: "request-http-result",
    status: "succeeded",
    requestedParams: input,
    effectiveParams: input,
    execution: {
      transport: "single-endpoint-json",
      attemptCount: 1,
      providerRequestCount: 1,
      receivedAnyOutput: true,
      mayHaveBilled: true,
      degradedContinuation: false,
      providerImageIds: []
    },
    finalArtifacts: [
      {
        id: "artifact-http",
        slot: 0,
        phase: "final",
        mimeType: "image/png",
        display: {
          type: "image",
          dataUrl: "data:image/png;base64,iVBORw0KGgo="
        },
        createdAt: TIMESTAMP
      }
    ],
    partialArtifacts: [],
    failedSlots: [],
    relationships: []
  });
}

function service(overrides: Record<string, unknown> = {}): LocalRoutegoService {
  return new Proxy(overrides, {
    get(target, property) {
      if (typeof property === "string" && property in target) return target[property];
      return async () => {
        throw new Error(`Unused service method: ${String(property)}`);
      };
    }
  }) as unknown as LocalRoutegoService;
}

async function* chunks(...values: Array<string | Uint8Array>): AsyncGenerator<string | Uint8Array> {
  for (const value of values) yield value;
}

function runtimeRequest(
  path: string,
  options: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: AsyncIterable<string | Uint8Array>;
    readonly signal?: AbortSignal;
  } = {}
): RoutegoHttpRequest {
  return {
    method: options.method ?? "GET",
    url: new URL(path, "http://127.0.0.1"),
    headers: {
      origin: ORIGIN,
      "x-routego-session": TOKEN,
      ...options.headers
    },
    ...(options.body === undefined ? {} : { body: options.body }),
    signal: options.signal ?? new AbortController().signal
  };
}

function responseJson(response: RoutegoHttpResponse): Record<string, unknown> {
  if (typeof response.body !== "string") throw new Error("Expected a JSON string response");
  return JSON.parse(response.body) as Record<string, unknown>;
}

function studioRequest(): StudioImageOperationRequest {
  return studioGenerateInputSchema.parse({ kind: "generate", prompt: "浏览器安全的宇航猫 🚀" });
}

function studioArtifact(id: string, phase: "partial" | "final"): StudioImageArtifact {
  return {
    artifactId: id,
    slot: 0,
    phase,
    resource: {
      resourceId: `resource-${id}`,
      relativeUrl: `/api/v1/resources/resource-${id}`,
      requiresSession: true,
      mimeType: "image/png",
      byteLength: 68,
      width: 1,
      height: 1,
      etag: `etag-${id}`,
      expiresAt: "2026-07-18T12:30:00.000Z"
    },
    createdAt: TIMESTAMP
  };
}

function studioSuccess(request: StudioImageOperationRequest) {
  const artifact = studioArtifact("artifact-studio-final", "final");
  return studioImageOperationResultSchema.parse({
    schemaVersion: 1,
    requestId: "studio-stream",
    status: "succeeded",
    requestedParams: request,
    effectiveParams: request,
    execution: {
      transport: "single-endpoint-json",
      attemptCount: 1,
      providerRequestCount: 1,
      receivedAnyOutput: true,
      mayHaveBilled: true,
      degradedContinuation: false,
      providerImageIds: []
    },
    finalArtifacts: [artifact],
    partialArtifacts: [],
    failedSlots: [],
    relationships: [{ role: "output", outputArtifactId: artifact.artifactId, order: 0 }]
  });
}

describe("loopback HTTP lifecycle and authorization", () => {
  it("rejects non-loopback binds and starts/stops IPv4 and IPv6 listeners", async () => {
    const local = service({ status: async () => statusResult() });
    expect(() => createRoutegoLoopbackHttpServer({
      service: local,
      localService: local,
      expectedSessionToken: TOKEN,
      allowedOrigins: [ORIGIN],
      address: "0.0.0.0" as "127.0.0.1"
    })).toThrow(/loopback|127\.0\.0\.1/u);

    for (const address of ["127.0.0.1", "::1"] as const) {
      const server = createRoutegoLoopbackHttpServer({
        service: local,
        localService: local,
        expectedSessionToken: TOKEN,
        allowedOrigins: [ORIGIN],
        address
      });
      const bound = await server.start();
      expect(bound.address).toBe(address);
      expect(bound.port).toBeGreaterThan(0);
      if (address === "127.0.0.1") {
        const response = await fetch(`${bound.origin}/api/v1/status?refreshCapabilities=true`, {
          headers: { origin: ORIGIN, "x-routego-session": TOKEN }
        });
        expect(response.status).toBe(200);
        expect((await response.json()) as unknown).toMatchObject({ configured: false });
      }
      await server.close();
      expect(server.address).toBeUndefined();
    }
  });

  it("enforces exact origin, session, cookie, CORS, and typed GET query decoding", async () => {
    const status = vi.fn(async () => statusResult());
    const local = service({ status });
    const dispatcher = createRoutegoHttpDispatcher({
      service: local,
      localService: local,
      expectedSessionToken: TOKEN,
      allowedOrigins: [ORIGIN]
    });

    const accepted = await dispatcher.dispatch(runtimeRequest(
      "/api/v1/status?refreshCapabilities=true&confirmBillableProbe=false"
    ));
    expect(accepted.status).toBe(200);
    expect(accepted.headers).toMatchObject({
      "access-control-allow-origin": ORIGIN,
      vary: "Origin"
    });
    expect(status).toHaveBeenCalledWith({ refreshCapabilities: true, confirmBillableProbe: false });

    for (const headers of [
      { origin: "https://example.invalid", "x-routego-session": TOKEN },
      { origin: ORIGIN, "x-routego-session": "wrong-token" },
      { origin: ORIGIN, "x-routego-session": TOKEN, cookie: "session=forbidden" }
    ]) {
      const denied = await dispatcher.dispatch(runtimeRequest("/api/v1/status", { headers }));
      expect(denied.status).toBe(403);
      expect(JSON.stringify(responseJson(denied))).not.toContain(TOKEN);
    }
    expect(status).toHaveBeenCalledTimes(1);
  });
});

describe("frozen public and Studio dispatch", () => {
  it("validates POST JSON and Studio GET inputs plus service outputs", async () => {
    const generate = vi.fn(async (input: ImageOperationRequest) => imageResult(input));
    const listFolders = vi.fn(async () => ({ schemaVersion: 1, folders: [] }));
    const local = service({ generate, listFolders });
    const diagnostics: unknown[] = [];
    const dispatcher = createRoutegoHttpDispatcher({
      service: local,
      localService: local,
      expectedSessionToken: TOKEN,
      allowedOrigins: [ORIGIN],
      logger: (value) => {
        diagnostics.push(value);
      }
    });

    const body = JSON.stringify({ kind: "generate", prompt: "中文 HTTP prompt" });
    const generated = await dispatcher.dispatch(runtimeRequest("/api/v1/generate", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: chunks(body.slice(0, 11), body.slice(11))
    }));
    expect(generated.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0]).toMatchObject({ prompt: "中文 HTTP prompt", count: 1 });
    expect(JSON.stringify(responseJson(generated))).toContain("data:image/png;base64,iVBORw0KGgo=");

    const folders = await dispatcher.dispatch(runtimeRequest(
      "/api/v1/library/folders?includeDeleted=true"
    ));
    expect(folders.status).toBe(200);
    expect(listFolders).toHaveBeenCalledWith({ schemaVersion: 1, includeDeleted: true });

    const invalidInput = await dispatcher.dispatch(runtimeRequest("/api/v1/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chunks(JSON.stringify({ kind: "generate", prompt: "x", unknown: true }))
    }));
    expect(invalidInput.status).toBe(400);
    expect(generate).toHaveBeenCalledTimes(1);

    const invalidLocal = service({ status: async () => ({ invalid: true }) });
    const invalidDispatcher = createRoutegoHttpDispatcher({
      service: invalidLocal,
      localService: invalidLocal,
      expectedSessionToken: TOKEN,
      allowedOrigins: [ORIGIN],
      logger: (value) => {
        diagnostics.push(value);
      }
    });
    const invalidOutput = await invalidDispatcher.dispatch(runtimeRequest("/api/v1/status"));
    expect(invalidOutput.status).toBe(500);
    expect(responseJson(invalidOutput)).toMatchObject({ error: { code: "internal_contract" } });
    expect(diagnostics).toHaveLength(1);
  });

  it("bounds bodies and queries, rejects malformed UTF-8, and redacts failures", async () => {
    const diagnostics: unknown[] = [];
    const local = service({
      generate: async () => {
        throw new Error("Authorization: Bearer synthetic-secret sessionToken=synthetic-session");
      }
    });
    const dispatcher = createRoutegoHttpDispatcher({
      service: local,
      localService: local,
      expectedSessionToken: TOKEN,
      allowedOrigins: [ORIGIN],
      maximumJsonBodyBytes: 64,
      maximumQueryBytes: 32,
      logger: (value) => {
        diagnostics.push(value);
      }
    });

    const oversized = await dispatcher.dispatch(runtimeRequest("/api/v1/generate", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "65" },
      body: chunks("{}")
    }));
    expect(oversized.status).toBe(413);

    const invalidUtf8 = await dispatcher.dispatch(runtimeRequest("/api/v1/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chunks(Uint8Array.of(0xff, 0xfe))
    }));
    expect(invalidUtf8.status).toBe(400);

    const longQuery = await dispatcher.dispatch(runtimeRequest(`/api/v1/status?value=${"x".repeat(40)}`));
    expect(longQuery.status).toBe(414);

    const body = JSON.stringify({ kind: "generate", prompt: "safe" });
    const failed = await dispatcher.dispatch(runtimeRequest("/api/v1/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chunks(body)
    }));
    expect(failed.status).toBe(500);
    const rendered = JSON.stringify([responseJson(failed), diagnostics]);
    expect(rendered).not.toContain("synthetic-secret");
    expect(rendered).not.toContain("synthetic-session");
  });

  it("delegates only unmatched extension routes after authorization and supports safe preflight", async () => {
    const extension = vi.fn(async (request: RoutegoHttpRequest) => {
      if (request.url.pathname !== "/api/v1/uploads/upload-a/content") return undefined;
      return request.method === "OPTIONS"
        ? { status: 204, headers: { "access-control-allow-methods": "PUT, OPTIONS" } }
        : { status: 204 };
    });
    const local = service();
    const dispatcher = createRoutegoHttpDispatcher({
      service: local,
      localService: local,
      expectedSessionToken: TOKEN,
      allowedOrigins: [ORIGIN],
      extensionHandler: extension
    });

    const actual = await dispatcher.dispatch(runtimeRequest("/api/v1/uploads/upload-a/content", {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: chunks(Uint8Array.of(1, 2, 3))
    }));
    expect(actual.status).toBe(204);
    expect(actual.headers?.["access-control-allow-origin"]).toBe(ORIGIN);

    const preflight = await dispatcher.dispatch(runtimeRequest("/api/v1/uploads/upload-a/content", {
      method: "OPTIONS",
      headers: {
        "access-control-request-method": "PUT",
        "access-control-request-headers": "content-type, x-routego-session"
      }
    }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers?.["access-control-allow-methods"]).toBe("PUT, OPTIONS");
    expect(extension).toHaveBeenCalledTimes(2);
  });
});

describe("Studio SSE broker and serialization", () => {
  it("streams validated started/partial/completed and failed events in monotonic order", async () => {
    const broker = new StudioEventBroker();
    const request = studioRequest();
    const partial = studioArtifact("artifact-studio-partial", "partial");
    const events = broker.subscribe("studio-stream");
    broker.publish({
      type: "started",
      requestId: "studio-stream",
      sequence: 0,
      occurredAt: TIMESTAMP,
      requestedParams: request
    });
    broker.publish({
      type: "partial",
      requestId: "studio-stream",
      sequence: 1,
      occurredAt: TIMESTAMP,
      artifact: partial,
      receivedAnyOutput: true,
      mayHaveBilled: true
    });
    broker.publish({
      type: "completed",
      requestId: "studio-stream",
      sequence: 2,
      occurredAt: TIMESTAMP,
      result: studioSuccess(request)
    });

    const response = createStudioEventStreamResponse(events);
    expect(response.headers).toMatchObject({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform"
    });
    const rendered: string[] = [];
    if (response.body === undefined || typeof response.body === "string" || response.body instanceof Uint8Array) {
      throw new Error("Expected an SSE iterable");
    }
    for await (const chunk of response.body) rendered.push(String(chunk));
    expect(rendered).toHaveLength(3);
    expect(rendered.join("")).toContain("event: partial");
    expect(rendered.join("")).not.toMatch(/(?:path|dataUrl|base64|Authorization)/u);
    expect(() => broker.publish({
      type: "started",
      requestId: "studio-stream",
      sequence: 3,
      occurredAt: TIMESTAMP,
      requestedParams: request
    })).toThrow(/terminal/u);

    const error = studioServiceErrorSchema.parse({
      code: "capability_unavailable",
      category: "capability",
      stage: "route",
      safeMessage: "The synthetic route is unavailable.",
      retryDisposition: "user-confirmation",
      partialArtifacts: [],
      receivedAnyOutput: false,
      mayHaveBilled: false
    });
    const failed = studioImageOperationEventSchema.parse({
      type: "failed",
      requestId: "studio-failed",
      sequence: 0,
      occurredAt: TIMESTAMP,
      error,
      receivedAnyOutput: false,
      mayHaveBilled: false
    });
    expect(serializeStudioImageOperationEvent(failed)).toContain("event: failed");
    expect(() => studioImageOperationEventSchema.parse({
      ...failed,
      receivedAnyOutput: true
    })).toThrow();
  });

  it("unsubscribes and propagates cancellation on disconnect", async () => {
    const broker = new StudioEventBroker();
    const controller = new AbortController();
    const onCancel = vi.fn();
    const events = broker.subscribe("studio-disconnect", {
      signal: controller.signal,
      onCancel
    });
    const iterator = events[Symbol.asyncIterator]();
    const pending = iterator.next();
    controller.abort();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
