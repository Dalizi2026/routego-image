import { describe, expect, it } from "vitest";

import {
  studioEditInputSchema,
  studioGenerateInputSchema,
  studioImageOperationResultSchema,
  studioServiceErrorSchema,
  type StudioImageOperationEvent,
  type StudioImageOperationRequest
} from "@routego-image/contracts";
import { StudioGatewayError } from "../src/api/errors";
import {
  assertStudioEventStreamContentType,
  parseStudioImageOperationEventStream
} from "../src/api/sse";

const TIMESTAMP = "2026-07-18T12:00:00.000Z";

function request(prompt = "浏览器安全的合成测试") {
  return studioGenerateInputSchema.parse({ kind: "generate", prompt });
}

function editRequest() {
  return studioEditInputSchema.parse({
    kind: "edit",
    prompt: "只替换天空",
    target: { source: "artifact", artifactId: "artifact-target" },
    invariants: {
      allowedChanges: ["sky"],
      preserve: ["subject"],
      forbiddenChanges: ["text"]
    }
  });
}

function artifact(id: string, phase: "partial" | "final") {
  return {
    artifactId: id,
    slot: 0,
    phase,
    resource: {
      resourceId: `resource-${id}`,
      relativeUrl: `/api/v1/resources/${id}`,
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
    relationships: [{ role: "output", outputArtifactId: finalArtifact.artifactId, order: 0 }]
  });
}

function failedError(receivedAnyOutput: boolean) {
  return studioServiceErrorSchema.parse({
    code: "capability_unavailable",
    category: "capability",
    stage: "route",
    safeMessage: "The synthetic stream failed safely.",
    retryDisposition: receivedAnyOutput ? "user-confirmation" : "safe-pre-generation",
    partialArtifacts: receivedAnyOutput ? [artifact("artifact-partial", "partial")] : [],
    receivedAnyOutput,
    mayHaveBilled: receivedAnyOutput
  });
}

function started(input: StudioImageOperationRequest, requestId = "request-1", sequence = 0) {
  return {
    type: "started" as const,
    requestId,
    sequence,
    occurredAt: TIMESTAMP,
    requestedParams: input
  };
}

function partial(requestId = "request-1", sequence = 1, artifactId = "artifact-partial") {
  return {
    type: "partial" as const,
    requestId,
    sequence,
    occurredAt: TIMESTAMP,
    artifact: artifact(artifactId, "partial"),
    receivedAnyOutput: true as const,
    mayHaveBilled: true as const
  };
}

function completed(
  input: StudioImageOperationRequest,
  requestId = "request-1",
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

function failed(requestId = "request-1", sequence = 1, receivedAnyOutput = false) {
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

function record(
  value: unknown,
  options: { readonly lineEnding?: "\n" | "\r\n"; readonly multiline?: boolean } = {}
): string {
  const lineEnding = options.lineEnding ?? "\n";
  const event = value as { readonly requestId?: string; readonly sequence?: number; readonly type?: string };
  const json = JSON.stringify(value, undefined, options.multiline === true ? 2 : 0);
  const dataLines = json.split("\n").map((line) => `data: ${line}`);
  return [
    `id: ${event.requestId ?? "request-1"}:${event.sequence ?? 0}`,
    `event: ${event.type ?? "unknown"}`,
    ...dataLines,
    ""
  ].join(lineEnding) + lineEnding;
}

function dataOnly(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function streamFromChunks(chunks: readonly Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel() {
      onCancel?.();
    }
  });
}

function chunkText(text: string, sizes: readonly number[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const size of sizes) {
    if (offset >= bytes.byteLength) break;
    chunks.push(bytes.slice(offset, offset + size));
    offset += size;
  }
  if (offset < bytes.byteLength) chunks.push(bytes.slice(offset));
  return streamFromChunks(chunks);
}

async function collect(stream: AsyncIterable<StudioImageOperationEvent>) {
  const events: StudioImageOperationEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("strict browser-safe Studio SSE parser", () => {
  it("parses LF records fragmented across arbitrary UTF-8 chunks", async () => {
    const input = request();
    const text = record(started(input)) + record(completed(input));
    const events = await collect(parseStudioImageOperationEventStream(
      chunkText(text, [1, 2, 3, 5, 8, 13])
    ));

    expect(events.map((event) => event.type)).toEqual(["started", "completed"]);
  });

  it("parses CRLF and multiline data with zero or more partial events", async () => {
    const input = editRequest();
    const text =
      record(started(input), { lineEnding: "\r\n", multiline: true }) +
      record(partial("request-1", 4, "partial-a"), { lineEnding: "\r\n", multiline: true }) +
      record(partial("request-1", 7, "partial-b"), { lineEnding: "\r\n" }) +
      record(failed("request-1", 9, true), { lineEnding: "\r\n" });

    const events = await collect(parseStudioImageOperationEventStream(
      chunkText(text, [2, 1, 7, 4, 3, 19])
    ));

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "partial",
      "partial",
      "failed"
    ]);
  });

  it("accepts only the exact event-stream content type", () => {
    expect(() => assertStudioEventStreamContentType("text/event-stream; charset=utf-8")).not.toThrow();
    expect(() => assertStudioEventStreamContentType("TEXT/EVENT-STREAM; CHARSET=UTF-8")).not.toThrow();
    for (const value of [
      null,
      "text/event-stream",
      "text/event-stream; charset=us-ascii",
      "application/json; charset=utf-8",
      "text/event-stream; charset=utf-8; extra=true"
    ]) {
      expect(() => assertStudioEventStreamContentType(value)).toThrow(StudioGatewayError);
    }
  });

  it("rejects invalid UTF-8 and bounded lines, records, or bodies", async () => {
    const input = request();
    await expect(
      collect(parseStudioImageOperationEventStream(
        streamFromChunks([Uint8Array.of(0xff, 0xfe)])
      ))
    ).rejects.toMatchObject({ code: "invalid_output" });

    await expect(
      collect(parseStudioImageOperationEventStream(
        streamFromChunks([new TextEncoder().encode(`data: ${"x".repeat(20)}\n\n`)]),
        { limits: { maximumLineBytes: 8, maximumEventBytes: 32, maximumBodyBytes: 64 } }
      ))
    ).rejects.toMatchObject({ code: "invalid_output" });

    const oversizedRecord = `data: ${JSON.stringify(started(input))}\n${"x".repeat(30)}\n\n`;
    await expect(
      collect(parseStudioImageOperationEventStream(
        streamFromChunks([new TextEncoder().encode(oversizedRecord)]),
        { limits: { maximumLineBytes: 128, maximumEventBytes: 140, maximumBodyBytes: 512 } }
      ))
    ).rejects.toMatchObject({ code: "invalid_output" });

    const longInput = request("x".repeat(1_500));
    const body = record(started(longInput)) + record(failed());
    await expect(
      collect(parseStudioImageOperationEventStream(
        streamFromChunks([new TextEncoder().encode(body)]),
        { limits: { maximumLineBytes: 2_000, maximumEventBytes: 2_100, maximumBodyBytes: 2_200 } }
      ))
    ).rejects.toMatchObject({ code: "invalid_output" });
  });

  it.each([
    {
      name: "missing first started",
      text: dataOnly(completed(request()))
    },
    {
      name: "duplicate started",
      text: record(started(request())) + record(started(request(), "request-1", 1))
    },
    {
      name: "request ID drift",
      text: record(started(request())) + record(partial("other-request"))
    },
    {
      name: "non-monotonic sequence",
      text: record(started(request(), "request-1", 4)) + record(partial("request-1", 4))
    },
    {
      name: "EOF before terminal",
      text: record(started(request()))
    },
    {
      name: "duplicate terminal",
      text: record(started(request())) + record(completed(request())) + record(failed("request-1", 2))
    },
    {
      name: "completed result ID drift",
      text: record(started(request())) + record(completed(request(), "request-1", 1, "other-result"))
    },
    {
      name: "DONE sentinel",
      text: record(started(request())) + "data: [DONE]\n\n"
    },
    {
      name: "schema-invalid sentinel",
      text: record(started(request())) + "data: {\"type\":\"sentinel\"}\n\n"
    }
  ])("fails closed on $name", async ({ text }) => {
    await expect(collect(parseStudioImageOperationEventStream(
      streamFromChunks([new TextEncoder().encode(text)])
    ))).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("rejects comments, unknown fields, lone CR framing, and incomplete records", async () => {
    for (const text of [
      ": keepalive\n\n",
      "retry: 1000\n\n",
      "data: {}\rdata: {}\n\n",
      "data: {}\n"
    ]) {
      await expect(collect(parseStudioImageOperationEventStream(
        streamFromChunks([new TextEncoder().encode(text)])
      ))).rejects.toMatchObject({ code: "invalid_output" });
    }
  });

  it("propagates abort, cancels the reader, and releases its lock", async () => {
    const input = request();
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode(record(started(input))));
      },
      cancel() {
        cancelled = true;
      }
    });
    const iterator = parseStudioImageOperationEventStream(body, { signal: controller.signal })[
      Symbol.asyncIterator
    ]();

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "started" }, done: false });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: "network_error" });
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it("cancels and releases the reader when the consumer leaves early", async () => {
    const input = request();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode(record(started(input))));
      },
      cancel() {
        cancelled = true;
      }
    });
    const iterator = parseStudioImageOperationEventStream(body)[Symbol.asyncIterator]();

    await iterator.next();
    await iterator.return?.(undefined);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it("keeps parser failures redacted from paths, data URLs, and credentials", async () => {
    const secretPayload = "C:\\Users\\someone\\image.png data:image/png;base64,AAAA Authorization: Bearer secret";
    let error: unknown;
    try {
      await collect(parseStudioImageOperationEventStream(
        streamFromChunks([new TextEncoder().encode(`data: ${secretPayload}\n\n`)])
      ));
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "invalid_output" });
    expect(String((error as Error).message)).not.toContain("C:\\Users");
    expect(String((error as Error).message)).not.toMatch(/data:image|base64|Bearer/iu);
  });
});
