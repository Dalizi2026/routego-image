import { describe, expect, it, vi } from "vitest";

import {
  studioGenerateInputSchema,
  studioImageOperationEventSchema,
  studioImageOperationResultSchema,
  studioServiceErrorSchema,
  type BrowserResourceDescriptor,
  type StudioImageArtifact,
  type StudioImageOperationEvent
} from "@routego-image/contracts";
import { StudioGatewayError, type StudioGateway } from "../src/api";
import {
  describeCreationArtifactAvailability,
  describeCreationArtifactCleanup,
  describeCreationStreamFailure
} from "../src/features/creation/result";
import {
  consumeCreationStream,
  transitionCreationStreamState
} from "../src/features/creation/stream";
import type { SubmissionState } from "../src/features/creation/types";

const TIMESTAMP = "2026-07-18T12:00:00.000Z";
const INPUT = studioGenerateInputSchema.parse({
  kind: "generate",
  prompt: "deterministic streamed workbench"
});

function artifact(
  artifactId: string,
  phase: "partial" | "final",
  expiresAt = "2026-07-18T12:05:00.000Z"
): StudioImageArtifact {
  return {
    artifactId,
    slot: 0,
    phase,
    resource: {
      resourceId: `resource-${artifactId}`,
      relativeUrl: `/api/v1/resources/${artifactId}`,
      requiresSession: true,
      mimeType: "image/png",
      byteLength: 68,
      width: 1,
      height: 1,
      etag: `etag-${artifactId}`,
      expiresAt
    },
    createdAt: TIMESTAMP
  };
}

function started(requestId = "stream-request", sequence = 0): StudioImageOperationEvent {
  return studioImageOperationEventSchema.parse({
    type: "started",
    requestId,
    sequence,
    occurredAt: TIMESTAMP,
    requestedParams: INPUT
  });
}

function partial(
  value: StudioImageArtifact,
  requestId = "stream-request",
  sequence = 1
): StudioImageOperationEvent {
  return studioImageOperationEventSchema.parse({
    type: "partial",
    requestId,
    sequence,
    occurredAt: TIMESTAMP,
    artifact: value,
    receivedAnyOutput: true,
    mayHaveBilled: true
  });
}

function completed(requestId = "stream-request", sequence = 2): StudioImageOperationEvent {
  const finalArtifact = artifact("final-artifact", "final");
  const result = studioImageOperationResultSchema.parse({
    schemaVersion: 1,
    requestId,
    status: "succeeded",
    requestedParams: INPUT,
    effectiveParams: INPUT,
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
  return studioImageOperationEventSchema.parse({
    type: "completed",
    requestId,
    sequence,
    occurredAt: TIMESTAMP,
    result
  });
}

function failed(
  partialArtifacts: readonly StudioImageArtifact[],
  options: {
    readonly requestId?: string;
    readonly sequence?: number;
    readonly receivedAnyOutput?: boolean;
    readonly safeMessage?: string;
  } = {}
): StudioImageOperationEvent {
  const receivedAnyOutput = options.receivedAnyOutput ?? partialArtifacts.length > 0;
  const error = studioServiceErrorSchema.parse({
    code: "invalid_response",
    category: "protocol",
    stage: "stream",
    safeMessage: options.safeMessage ?? "The deterministic stream failed safely.",
    retryDisposition: receivedAnyOutput ? "user-confirmation" : "safe-pre-generation",
    partialArtifacts,
    receivedAnyOutput,
    mayHaveBilled: receivedAnyOutput
  });
  return studioImageOperationEventSchema.parse({
    type: "failed",
    requestId: options.requestId ?? "stream-request",
    sequence: options.sequence ?? 2,
    occurredAt: TIMESTAMP,
    error,
    receivedAnyOutput,
    mayHaveBilled: receivedAnyOutput
  });
}

function gatewayWithStream(
  create: (
    signal: AbortSignal | undefined
  ) => AsyncIterable<StudioImageOperationEvent>
): StudioGateway {
  return {
    streamImageOperation: (
      _input: Parameters<StudioGateway["streamImageOperation"]>[0],
      options?: Parameters<StudioGateway["streamImageOperation"]>[1]
    ) => create(options?.signal),
    invoke: vi.fn(async () => {
      throw new Error("unexpected non-stream invocation");
    }),
    uploadBinary: vi.fn(async () => undefined),
    fetchProtectedBlob: vi.fn(async () => new Blob()),
    fetchProtectedObjectUrl: vi.fn(async () => {
      throw new Error("unexpected resource fetch");
    })
  } as unknown as StudioGateway;
}

async function* events(values: readonly StudioImageOperationEvent[]) {
  for (const value of values) yield value;
}

describe("Creation workbench stream state", () => {
  it("renders partial state as events arrive and promotes only the completed result", async () => {
    const partialArtifact = artifact("partial-artifact", "partial");
    const states: SubmissionState[] = [];
    const gateway = gatewayWithStream(() =>
      events([started(), partial(partialArtifact), completed()])
    );
    const inputSnapshot = JSON.stringify(INPUT);

    const terminal = await consumeCreationStream(gateway, INPUT, {
      onState: (state) => states.push(state)
    });

    expect(states.map((state) => state.status)).toEqual([
      "submitting",
      "streaming",
      "streaming",
      "result"
    ]);
    expect(states[2]).toMatchObject({
      partialArtifacts: [{ artifactId: partialArtifact.artifactId }],
      receivedAnyOutput: true,
      mayHaveBilled: true
    });
    expect(terminal).toMatchObject({
      status: "result",
      result: { status: "succeeded", finalArtifacts: [{ artifactId: "final-artifact" }] }
    });
    expect(JSON.stringify(INPUT)).toBe(inputSnapshot);
  });

  it("preserves validated partials and billing risk after a failed terminal event", async () => {
    const partialArtifact = artifact("partial-failure", "partial");
    const partialEvent = partial(partialArtifact);
    const terminal = await consumeCreationStream(
      gatewayWithStream(() => events([started(), partialEvent, failed([partialArtifact])])),
      INPUT
    );

    expect(terminal).toMatchObject({
      status: "stream-failure",
      failureKind: "terminal",
      automaticReplayAllowed: false,
      receivedAnyOutput: true,
      mayHaveBilled: true,
      partialArtifacts: [{ artifactId: partialArtifact.artifactId }]
    });
    if (terminal.status !== "stream-failure") throw new Error("expected stream failure");
    expect(terminal.partialArtifacts[0]?.resource).toBe(
      partialEvent.type === "partial" ? partialEvent.artifact.resource : undefined
    );
    expect(describeCreationStreamFailure(terminal)).toMatchObject({
      tone: "partial",
      retryRequiresConfirmation: true,
      manualRetryWarning: expect.any(String)
    });
  });

  it("fails closed when a valid terminal event contradicts earlier partial output", async () => {
    const partialArtifact = artifact("partial-invalid-terminal", "partial");
    const contradictoryTerminal = failed([], {
      sequence: 2,
      receivedAnyOutput: false
    });
    const terminal = await consumeCreationStream(
      gatewayWithStream(() =>
        events([started(), partial(partialArtifact), contradictoryTerminal])
      ),
      INPUT
    );

    expect(terminal).toMatchObject({
      status: "stream-failure",
      failureKind: "invalid",
      automaticReplayAllowed: false,
      receivedAnyOutput: true,
      mayHaveBilled: true,
      partialArtifacts: [{ artifactId: partialArtifact.artifactId }]
    });
  });

  it("aborts the active channel, runs generator cleanup, and retains only validated facts", async () => {
    const partialArtifact = artifact("partial-cancelled", "partial");
    const controller = new AbortController();
    let cleaned = false;
    const gateway = gatewayWithStream((signal) =>
      (async function* abortable() {
        try {
          yield started();
          yield partial(partialArtifact);
          if (signal?.aborted === true) {
            throw new StudioGatewayError("network_error", "The Studio image stream was cancelled.");
          }
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new StudioGatewayError("network_error", "The Studio image stream was cancelled.")),
              { once: true }
            );
          });
        } finally {
          cleaned = true;
        }
      })()
    );

    const terminal = await consumeCreationStream(gateway, INPUT, {
      signal: controller.signal,
      onState: (state) => {
        if (state.status === "streaming" && state.partialArtifacts.length === 1) {
          controller.abort();
        }
      }
    });

    expect(cleaned).toBe(true);
    expect(terminal).toMatchObject({
      status: "stream-failure",
      failureKind: "cancelled",
      automaticReplayAllowed: false,
      partialArtifacts: [{ artifactId: partialArtifact.artifactId }],
      receivedAnyOutput: true,
      mayHaveBilled: true
    });
  });

  it("cancels before started without inventing output or billing evidence", async () => {
    const controller = new AbortController();
    let cleaned = false;
    const gateway = gatewayWithStream((signal) =>
      (async function* pendingStart() {
        try {
          if (signal?.aborted === true) {
            throw new StudioGatewayError("network_error", "The Studio image stream was cancelled.");
          }
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new StudioGatewayError("network_error", "The Studio image stream was cancelled.")),
              { once: true }
            );
          });
        } finally {
          cleaned = true;
        }
      })()
    );
    const terminal = await consumeCreationStream(gateway, INPUT, {
      signal: controller.signal,
      onState: (state) => {
        if (state.status === "submitting") controller.abort();
      }
    });

    expect(cleaned).toBe(true);
    expect(terminal).toMatchObject({
      status: "stream-failure",
      failureKind: "cancelled",
      partialArtifacts: [],
      receivedAnyOutput: false,
      mayHaveBilled: false,
      automaticReplayAllowed: false
    });
  });

  it("treats EOF without a terminal event as an invalid closure while preserving partials", async () => {
    const partialArtifact = artifact("partial-eof", "partial");
    const terminal = await consumeCreationStream(
      gatewayWithStream(() => events([started(), partial(partialArtifact)])),
      INPUT
    );

    expect(terminal).toMatchObject({
      status: "stream-failure",
      failureKind: "invalid",
      partialArtifacts: [{ artifactId: partialArtifact.artifactId }],
      receivedAnyOutput: true,
      mayHaveBilled: true,
      automaticReplayAllowed: false
    });
  });

  it("keeps immutable normal and near-expiry descriptors separate from browser cleanup", () => {
    const registeredAt = Date.parse(TIMESTAMP);
    const full = artifact("full-window", "partial", "2026-07-18T12:05:00.000Z").resource;
    const near = artifact("near-window", "partial", "2026-07-18T12:00:30.000Z").resource;
    const snapshot = JSON.stringify({ full, near });

    expect(describeCreationArtifactAvailability(full, registeredAt)).toMatchObject({
      status: "available",
      expiresAt: full.expiresAt
    });
    expect(describeCreationArtifactAvailability(full, Date.parse(full.expiresAt))).toMatchObject({
      status: "expired"
    });
    expect(describeCreationArtifactAvailability(near, registeredAt + 29_999).status).toBe("available");
    expect(describeCreationArtifactAvailability(near, registeredAt + 30_000).status).toBe("expired");
    expect(describeCreationArtifactCleanup(full)).toEqual({
      revokeBrowserObjectUrlOnUnmount: true,
      revokeServerDescriptorOnClientCleanup: false,
      serverDescriptorExpiresAt: full.expiresAt
    });
    expect(Date.parse(full.expiresAt) - registeredAt).toBe(300_000);
    expect(Date.parse(near.expiresAt) - registeredAt).toBe(30_000);
    expect(JSON.stringify({ full, near })).toBe(snapshot);
  });

  it("projects transport shutdown as unavailable without exposing unsafe details", async () => {
    const unsafe = "Authorization: Bearer secret at C:\\Users\\someone\\image.png data:image/png;base64,AAAA";
    const gateway = gatewayWithStream(() =>
      (async function* unavailable() {
        yield started();
        throw new StudioGatewayError("network_error", unsafe);
      })()
    );
    const terminal = await consumeCreationStream(gateway, INPUT);

    expect(terminal).toMatchObject({
      status: "stream-failure",
      failureKind: "transport",
      automaticReplayAllowed: false,
      receivedAnyOutput: false,
      mayHaveBilled: false
    });
    expect(JSON.stringify(terminal)).not.toMatch(
      /(?:Authorization|Bearer|C:\\Users|data:image|base64)/u
    );

    const unsafeTerminal = await consumeCreationStream(
      gatewayWithStream(() => events([started(), failed([], { safeMessage: unsafe })])),
      INPUT
    );
    expect(JSON.stringify(unsafeTerminal)).not.toMatch(
      /(?:Authorization|Bearer|C:\\Users|data:image|base64)/u
    );
  });

  it("rejects duplicate or late lifecycle transitions without promoting them", () => {
    const running = transitionCreationStreamState({ status: "submitting" }, started());
    expect(() => transitionCreationStreamState(running, started("stream-request", 1))).toThrow();
    const done = transitionCreationStreamState(running, completed("stream-request", 1));
    expect(() => transitionCreationStreamState(done, partial(artifact("late", "partial"), "stream-request", 2))).toThrow();
  });
});
