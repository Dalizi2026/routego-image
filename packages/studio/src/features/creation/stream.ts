import {
  type StudioImageArtifact,
  type StudioImageOperationEvent,
  type StudioImageOperationRequest
} from "@routego-image/contracts";

import { StudioGatewayError, type StudioGateway } from "../../api";
import type { SubmissionState } from "./types";

const SENSITIVE_STREAM_MESSAGE =
  /(?:[A-Za-z]:\\|\/Users\/|\/home\/|data:image|base64|authorization|bearer\s|x-routego-session)/iu;
const INVALID_STREAM_MESSAGE = "Studio rejected an invalid local image stream.";
const TRANSPORT_STREAM_MESSAGE = "Studio could not complete the local image stream.";

export class CreationStreamStateError extends Error {
  constructor(message = INVALID_STREAM_MESSAGE) {
    super(message);
    this.name = "CreationStreamStateError";
  }
}

export interface ConsumeCreationStreamOptions {
  readonly signal?: AbortSignal;
  readonly onState?: (state: SubmissionState) => void;
}

function streamPartials(state: SubmissionState): readonly StudioImageArtifact[] {
  return state.status === "streaming" || state.status === "stream-failure"
    ? state.partialArtifacts
    : [];
}

function streamRequestId(state: SubmissionState): string | undefined {
  return state.status === "streaming" || state.status === "stream-failure"
    ? state.requestId
    : undefined;
}

function mergeArtifacts(
  current: readonly StudioImageArtifact[],
  incoming: readonly StudioImageArtifact[]
): readonly StudioImageArtifact[] {
  const merged = new Map(current.map((artifact) => [artifact.artifactId, artifact] as const));
  for (const artifact of incoming) {
    if (!merged.has(artifact.artifactId)) merged.set(artifact.artifactId, artifact);
  }
  return [...merged.values()];
}

function safeStreamMessage(error: unknown): string {
  const candidate =
    error instanceof CreationStreamStateError || error instanceof StudioGatewayError
      ? error.message.trim()
      : "";
  if (
    candidate === "" ||
    candidate.length > 1_000 ||
    SENSITIVE_STREAM_MESSAGE.test(candidate)
  ) {
    return error instanceof CreationStreamStateError
      ? INVALID_STREAM_MESSAGE
      : TRANSPORT_STREAM_MESSAGE;
  }
  return candidate;
}

function safeTerminalStreamMessage(value: string): string {
  const candidate = value.trim();
  return candidate !== "" && candidate.length <= 1_000 && !SENSITIVE_STREAM_MESSAGE.test(candidate)
    ? candidate
    : INVALID_STREAM_MESSAGE;
}

function failureKind(
  error: unknown,
  signal: AbortSignal | undefined
): "invalid" | "transport" | "cancelled" {
  if (signal?.aborted === true) return "cancelled";
  if (
    error instanceof CreationStreamStateError ||
    (error instanceof StudioGatewayError && error.code === "invalid_output")
  ) {
    return "invalid";
  }
  return "transport";
}

export function failCreationStream(
  state: SubmissionState,
  error: unknown,
  signal?: AbortSignal
): SubmissionState {
  const partialArtifacts = streamPartials(state);
  const receivedAnyOutput = partialArtifacts.length > 0;
  return {
    status: "stream-failure",
    ...(streamRequestId(state) === undefined ? {} : { requestId: streamRequestId(state) }),
    safeMessage: safeStreamMessage(error),
    partialArtifacts,
    receivedAnyOutput,
    mayHaveBilled: receivedAnyOutput,
    failureKind: failureKind(error, signal),
    automaticReplayAllowed: false
  };
}

export function transitionCreationStreamState(
  state: SubmissionState,
  event: StudioImageOperationEvent
): SubmissionState {
  if (event.type === "started") {
    if (state.status !== "submitting") throw new CreationStreamStateError();
    return {
      status: "streaming",
      requestId: event.requestId,
      partialArtifacts: [],
      receivedAnyOutput: false,
      mayHaveBilled: false
    };
  }
  if (state.status !== "streaming" || state.requestId !== event.requestId) {
    throw new CreationStreamStateError();
  }
  if (event.type === "partial") {
    return {
      ...state,
      partialArtifacts: mergeArtifacts(state.partialArtifacts, [event.artifact]),
      receivedAnyOutput: true,
      mayHaveBilled: true
    };
  }
  if (event.type === "completed") {
    if (
      state.receivedAnyOutput &&
      (!event.result.execution.receivedAnyOutput || !event.result.execution.mayHaveBilled)
    ) {
      throw new CreationStreamStateError();
    }
    return { status: "result", result: event.result };
  }
  if (
    state.receivedAnyOutput &&
    (!event.receivedAnyOutput || !event.mayHaveBilled)
  ) {
    throw new CreationStreamStateError();
  }
  const partialArtifacts = mergeArtifacts(
    state.partialArtifacts,
    event.error.partialArtifacts
  );
  const receivedAnyOutput = state.receivedAnyOutput || event.receivedAnyOutput;
  const mayHaveBilled = state.mayHaveBilled || event.mayHaveBilled;
  return {
    status: "stream-failure",
    requestId: state.requestId,
    safeMessage: safeTerminalStreamMessage(event.error.safeMessage),
    partialArtifacts,
    receivedAnyOutput,
    mayHaveBilled,
    failureKind: "terminal",
    automaticReplayAllowed: false
  };
}

export async function consumeCreationStream(
  gateway: StudioGateway,
  input: StudioImageOperationRequest,
  options: ConsumeCreationStreamOptions = {}
): Promise<SubmissionState> {
  let state: SubmissionState = { status: "submitting" };
  options.onState?.(state);
  try {
    for await (const event of gateway.streamImageOperation(
      input,
      options.signal === undefined ? {} : { signal: options.signal }
    )) {
      state = transitionCreationStreamState(state, event);
      options.onState?.(state);
    }
    if (state.status !== "result" && state.status !== "stream-failure") {
      throw new CreationStreamStateError();
    }
    return state;
  } catch (error) {
    const failed = failCreationStream(state, error, options.signal);
    options.onState?.(failed);
    return failed;
  }
}
