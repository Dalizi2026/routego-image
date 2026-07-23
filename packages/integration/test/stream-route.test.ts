import { describe, expect, it, vi } from "vitest";

import {
  studioGenerateInputSchema,
  studioImageOperationResultSchema,
  studioServiceErrorSchema,
  type RoutegoService,
  type StudioImageArtifact,
  type StudioImageOperationRequest
} from "@routego-image/contracts";
import {
  createRoutegoHttpDispatcher,
  type RoutegoHttpRequest,
  type RoutegoHttpResponse
} from "@routego-image/creation";
import {
  STUDIO_CREATION_STREAM_PATH,
  createStudioCreationStreamRoute,
  type StudioCreationStreamExecutor
} from "../src/index";

const TOKEN = "synthetic-session-token-that-is-long-enough";
const ORIGIN = "http://127.0.0.1:43119";
const TIMESTAMP = "2026-07-18T12:00:00.000Z";

function generateRequest(
  overrides: Partial<Extract<StudioImageOperationRequest, { kind: "generate" }>> = {}
): StudioImageOperationRequest {
  return studioGenerateInputSchema.parse({
    kind: "generate",
    prompt: "生成一只浏览器安全的宇航猫",
    ...overrides
  });
}

function artifact(id: string, phase: "partial" | "final"): StudioImageArtifact {
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

function completedResult(input: StudioImageOperationRequest, requestId: string) {
  const finalArtifact = artifact(`artifact-${requestId}-final`, "final");
  return studioImageOperationResultSchema.parse({
    schemaVersion: 1,
    requestId,
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
    finalArtifacts: [finalArtifact],
    partialArtifacts: [],
    failedSlots: [],
    relationships: [
      { role: "output", outputArtifactId: finalArtifact.artifactId, order: 0 }
    ]
  });
}

function failedError(receivedAnyOutput: boolean) {
  return studioServiceErrorSchema.parse({
    code: "capability_unavailable",
    category: "capability",
    stage: "route",
    safeMessage: "The synthetic stream failed safely.",
    retryDisposition: receivedAnyOutput ? "user-confirmation" : "safe-pre-generation",
    partialArtifacts: receivedAnyOutput ? [artifact("artifact-failed-partial", "partial")] : [],
    receivedAnyOutput,
    mayHaveBilled: receivedAnyOutput
  });
}

function started(input: StudioImageOperationRequest, requestId = "stream-request", sequence = 0) {
  return {
    type: "started" as const,
    requestId,
    sequence,
    occurredAt: TIMESTAMP,
    requestedParams: input
  };
}

function partial(requestId = "stream-request", sequence = 1, id = "artifact-partial") {
  return {
    type: "partial" as const,
    requestId,
    sequence,
    occurredAt: TIMESTAMP,
    artifact: artifact(id, "partial"),
    receivedAnyOutput: true as const,
    mayHaveBilled: true as const
  };
}

function completed(
  input: StudioImageOperationRequest,
  requestId = "stream-request",
  sequence = 1,
  resultRequestId = requestId
) {
  return {
    type: "completed" as const,
    requestId,
    sequence,
    occurredAt: TIMESTAMP,
    result: completedResult(input, resultRequestId)
  };
}

function failed(requestId = "stream-request", sequence = 1, receivedAnyOutput = false) {
  const error = failedError(receivedAnyOutput);
  return {
    type: "failed" as const,
    requestId,
    sequence,
    occurredAt: TIMESTAMP,
    error,
    receivedAnyOutput,
    mayHaveBilled: receivedAnyOutput
  };
}

async function* values(...items: unknown[]): AsyncGenerator<unknown> {
  for (const item of items) yield item;
}

function unusedService(): RoutegoService {
  return new Proxy({}, {
    get(_target, property) {
      return async () => {
        throw new Error(`Unexpected Routego service call: ${String(property)}`);
      };
    }
  }) as RoutegoService;
}

function dispatcher(execute: StudioCreationStreamExecutor, maximumJsonBodyBytes?: number) {
  return createRoutegoHttpDispatcher({
    service: unusedService(),
    expectedSessionToken: TOKEN,
    allowedOrigins: [ORIGIN],
    extensionHandler: createStudioCreationStreamRoute({
      execute,
      ...(maximumJsonBodyBytes === undefined ? {} : { maximumJsonBodyBytes })
    })
  });
}

async function* chunks(...items: Array<string | Uint8Array>) {
  for (const item of items) yield item;
}

function request(
  path: string,
  input: unknown,
  options: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: AsyncIterable<string | Uint8Array>;
    readonly signal?: AbortSignal;
  } = {}
): RoutegoHttpRequest {
  const body = JSON.stringify(input);
  return {
    method: options.method ?? "POST",
    url: new URL(path, "http://127.0.0.1"),
    headers: {
      origin: ORIGIN,
      "x-routego-session": TOKEN,
      "content-type": "application/json; charset=utf-8",
      ...options.headers
    },
    body: options.body ?? chunks(body.slice(0, Math.floor(body.length / 2)), body.slice(Math.floor(body.length / 2))),
    signal: options.signal ?? new AbortController().signal
  };
}

function json(response: RoutegoHttpResponse): Record<string, unknown> {
  if (typeof response.body !== "string") throw new Error("Expected a JSON response body");
  return JSON.parse(response.body) as Record<string, unknown>;
}

function iterableBody(response: RoutegoHttpResponse): AsyncIterable<string | Uint8Array> {
  if (
    response.body === undefined ||
    typeof response.body === "string" ||
    response.body instanceof Uint8Array
  ) {
    throw new Error("Expected an iterable response body");
  }
  return response.body;
}

async function consume(response: RoutegoHttpResponse): Promise<{
  readonly chunks: readonly string[];
  readonly error?: unknown;
}> {
  const rendered: string[] = [];
  try {
    for await (const chunk of iterableBody(response)) rendered.push(String(chunk));
    return { chunks: rendered };
  } catch (error) {
    return { chunks: rendered, error };
  }
}

function dataEvents(rendered: readonly string[]): Array<Record<string, unknown>> {
  return rendered.flatMap((chunk) =>
    chunk
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>)
  );
}

describe("authenticated Studio creation stream route", () => {
  it("accepts the exact route and streams a first started plus one completed terminal", async () => {
    const input = generateRequest();
    const execute = vi.fn<StudioCreationStreamExecutor>(async (actual) =>
      values(started(actual), completed(actual))
    );
    const response = await dispatcher(execute).dispatch(
      request(STUDIO_CREATION_STREAM_PATH, { kind: "generate", prompt: input.prompt })
    );

    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({
      "access-control-allow-origin": ORIGIN,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform"
    });
    const consumed = await consume(response);
    expect(consumed.error).toBeUndefined();
    expect(dataEvents(consumed.chunks).map((event) => event["type"])).toEqual([
      "started",
      "completed"
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual(input);
    expect(consumed.chunks.join("")).not.toMatch(/\[DONE\]|sentinel/u);
  });

  it("accepts frozen generation input, zero-or-more partials, and one failed terminal", async () => {
    const input = generateRequest({ prompt: "生成一组可中途失败的浏览器安全图片" });
    const execute = vi.fn<StudioCreationStreamExecutor>(async (actual) =>
      values(
        started(actual, "generate-stream", 4),
        partial("generate-stream", 7, "artifact-generate-partial-1"),
        partial("generate-stream", 9, "artifact-generate-partial-2"),
        failed("generate-stream", 12, true)
      )
    );
    const response = await dispatcher(execute).dispatch(request(STUDIO_CREATION_STREAM_PATH, input));
    const consumed = await consume(response);

    expect(consumed.error).toBeUndefined();
    expect(dataEvents(consumed.chunks).map((event) => event["type"])).toEqual([
      "started",
      "partial",
      "partial",
      "failed"
    ]);
    expect(execute.mock.calls[0]?.[0]).toEqual(input);
  });

  it("requires exact session, loopback origin, route, method, and safe preflight", async () => {
    const input = generateRequest();
    const execute = vi.fn<StudioCreationStreamExecutor>(async (actual) =>
      values(started(actual), completed(actual))
    );
    const routeDispatcher = dispatcher(execute);

    for (const headers of [
      { origin: ORIGIN, "x-routego-session": "wrong-session" },
      { origin: "https://example.invalid", "x-routego-session": TOKEN },
      { origin: ORIGIN, "x-routego-session": TOKEN, cookie: "session=forbidden" }
    ]) {
      const denied = await routeDispatcher.dispatch(
        request(STUDIO_CREATION_STREAM_PATH, input, { headers })
      );
      expect(denied.status).toBe(403);
      expect(JSON.stringify(json(denied))).not.toContain(TOKEN);
    }

    const alternate = await routeDispatcher.dispatch(
      request("/api/v1/studio/creation/events", input)
    );
    expect(alternate.status).toBe(404);

    const wrongMethod = await routeDispatcher.dispatch(
      request(STUDIO_CREATION_STREAM_PATH, input, { method: "GET" })
    );
    expect(wrongMethod.status).toBe(405);

    const preflight = await routeDispatcher.dispatch(request(STUDIO_CREATION_STREAM_PATH, input, {
      method: "OPTIONS",
      headers: {
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-routego-session"
      }
    }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers).toMatchObject({
      "access-control-allow-origin": ORIGIN,
      "access-control-allow-methods": "POST, OPTIONS"
    });

    const wrongPreflight = await routeDispatcher.dispatch(request(STUDIO_CREATION_STREAM_PATH, input, {
      method: "OPTIONS",
      headers: {
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-routego-session"
      }
    }));
    expect(wrongPreflight.status).toBe(405);
    expect(execute).not.toHaveBeenCalled();
  });

  it("validates content type, bounded UTF-8 JSON, and the frozen discriminated input", async () => {
    const execute = vi.fn<StudioCreationStreamExecutor>(async (actual) =>
      values(started(actual), completed(actual))
    );
    const routeDispatcher = dispatcher(execute, 128);

    const wrongContentType = await routeDispatcher.dispatch(request(
      STUDIO_CREATION_STREAM_PATH,
      generateRequest(),
      { headers: { "content-type": "text/plain" } }
    ));
    expect(wrongContentType.status).toBe(415);

    const wrongCharset = await routeDispatcher.dispatch(request(
      STUDIO_CREATION_STREAM_PATH,
      generateRequest(),
      { headers: { "content-type": "application/json; charset=iso-8859-1" } }
    ));
    expect(wrongCharset.status).toBe(415);

    const malformed = await routeDispatcher.dispatch(request(
      STUDIO_CREATION_STREAM_PATH,
      {},
      { body: chunks("{") }
    ));
    expect(malformed.status).toBe(400);

    const invalidUtf8 = await routeDispatcher.dispatch(request(
      STUDIO_CREATION_STREAM_PATH,
      {},
      { body: chunks(Uint8Array.of(0xff, 0xfe)) }
    ));
    expect(invalidUtf8.status).toBe(400);

    const invalidInput = await routeDispatcher.dispatch(request(
      STUDIO_CREATION_STREAM_PATH,
      { kind: "batch", prompt: "not generate or edit" }
    ));
    expect(invalidInput.status).toBe(400);

    const oversized = await routeDispatcher.dispatch(request(
      STUDIO_CREATION_STREAM_PATH,
      generateRequest(),
      { headers: { "content-length": "129" } }
    ));
    expect(oversized.status).toBe(413);

    const mismatchedLength = await routeDispatcher.dispatch(request(
      STUDIO_CREATION_STREAM_PATH,
      {},
      { headers: { "content-length": "2" }, body: chunks("{} ") }
    ));
    expect(mismatchedLength.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "missing or late started",
      source: (input: StudioImageOperationRequest) => values(partial(), completed(input, "stream-request", 2))
    },
    {
      name: "duplicate started",
      source: (input: StudioImageOperationRequest) => values(started(input), started(input, "stream-request", 1), completed(input, "stream-request", 2))
    },
    {
      name: "started input drift",
      source: (input: StudioImageOperationRequest) =>
        values(started(generateRequest({ prompt: "不同的生成请求" })), completed(input))
    },
    {
      name: "request ID drift",
      source: (input: StudioImageOperationRequest) => values(started(input), partial("another-request", 1), completed(input, "another-request", 2))
    },
    {
      name: "non-monotonic sequence",
      source: (input: StudioImageOperationRequest) => values(started(input, "stream-request", 3), partial("stream-request", 3), completed(input, "stream-request", 4))
    },
    {
      name: "EOF before terminal",
      source: (input: StudioImageOperationRequest) => values(started(input), partial())
    },
    {
      name: "completed result request ID drift",
      source: (input: StudioImageOperationRequest) => values(started(input), completed(input, "stream-request", 1, "different-result-request"))
    },
    {
      name: "duplicate terminal or post-terminal data",
      source: (input: StudioImageOperationRequest) => values(started(input), completed(input), failed("stream-request", 2))
    },
    {
      name: "schema-invalid event",
      source: (input: StudioImageOperationRequest) => values(started(input), { ...partial(), artifact: artifact("wrong-phase", "final") }, completed(input, "stream-request", 2))
    }
  ])("fails closed on $name", async ({ source }) => {
    const input = generateRequest();
    const response = await dispatcher(async () => source(input)).dispatch(
      request(STUDIO_CREATION_STREAM_PATH, input)
    );
    const consumed = await consume(response);

    expect(response.status).toBe(200);
    expect(consumed.error).toBeInstanceOf(Error);
    expect(consumed.chunks.join("")).not.toContain("different-result-request");
    expect(dataEvents(consumed.chunks).every((event) => event["type"] !== "failed")).toBe(true);
  });

  it("rejects [DONE] and every non-schema sentinel without emitting it", async () => {
    const input = generateRequest();
    const response = await dispatcher(async () =>
      values(started(input), "[DONE]", completed(input, "stream-request", 2))
    ).dispatch(request(STUDIO_CREATION_STREAM_PATH, input));
    const consumed = await consume(response);

    expect(consumed.error).toBeInstanceOf(Error);
    expect(consumed.chunks.join("")).not.toContain("[DONE]");
    expect(dataEvents(consumed.chunks).map((event) => event["type"])).toEqual(["started"]);
  });

  it("rejects a schema-valid terminal that contains credential or path diagnostics", async () => {
    const input = generateRequest();
    const unsafeError = studioServiceErrorSchema.parse({
      code: "internal_contract",
      category: "internal",
      stage: "complete",
      safeMessage: "Authorization: Bearer synthetic-secret C:\\Users\\Synthetic\\private.png",
      retryDisposition: "never",
      partialArtifacts: [],
      receivedAnyOutput: false,
      mayHaveBilled: false
    });
    const response = await dispatcher(async () => values(
      started(input),
      {
        type: "failed",
        requestId: "stream-request",
        sequence: 1,
        occurredAt: TIMESTAMP,
        error: unsafeError,
        receivedAnyOutput: false,
        mayHaveBilled: false
      }
    )).dispatch(request(STUDIO_CREATION_STREAM_PATH, input));
    const consumed = await consume(response);

    expect(consumed.error).toBeInstanceOf(Error);
    expect(dataEvents(consumed.chunks).map((event) => event["type"])).toEqual(["started"]);
    expect(consumed.chunks.join("")).not.toMatch(/synthetic-secret|C:\\Users\\Synthetic/u);
  });

  it("aborts the injected operation and closes its channel when the client disconnects", async () => {
    const input = generateRequest();
    let operationSignal: AbortSignal | undefined;
    let channelClosed = false;
    const execute: StudioCreationStreamExecutor = async (actual, context) => {
      operationSignal = context.signal;
      return (async function* stream() {
        try {
          yield started(actual);
          yield await new Promise<never>(() => undefined);
        } finally {
          channelClosed = true;
        }
      })();
    };
    const response = await dispatcher(execute).dispatch(request(STUDIO_CREATION_STREAM_PATH, input));
    const iterator = iterableBody(response)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await iterator.return?.();
    expect(operationSignal?.aborted).toBe(true);
    expect(channelClosed).toBe(true);
  });

  it("races a request abort against a blocked source and still returns the iterator", async () => {
    const input = generateRequest();
    const requestController = new AbortController();
    let operationSignal: AbortSignal | undefined;
    let returned = false;
    let calls = 0;
    const execute: StudioCreationStreamExecutor = async (_actual, context) => {
      operationSignal = context.signal;
      return {
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              calls += 1;
              if (calls === 1) return { done: false as const, value: started(input) };
              return await new Promise<IteratorResult<unknown>>(() => undefined);
            },
            return: async () => {
              returned = true;
              return { done: true as const, value: undefined };
            }
          };
        }
      };
    };
    const response = await dispatcher(execute).dispatch(request(
      STUDIO_CREATION_STREAM_PATH,
      input,
      { signal: requestController.signal }
    ));
    const iterator = iterableBody(response)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    requestController.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: "cancelled" });
    expect(operationSignal?.aborted).toBe(true);
    expect(returned).toBe(true);
  });

  it("returns a safe JSON failure when the injected service cannot open a channel", async () => {
    const execute = vi.fn<StudioCreationStreamExecutor>(async () => {
      throw new Error("Authorization: Bearer synthetic-secret");
    });
    const response = await dispatcher(execute).dispatch(
      request(STUDIO_CREATION_STREAM_PATH, generateRequest())
    );

    expect(response.status).toBe(500);
    const rendered = JSON.stringify(json(response));
    expect(rendered).toContain("internal_contract");
    expect(rendered).not.toContain("synthetic-secret");
  });
});
