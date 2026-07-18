import {
  studioImageOperationEventSchema,
  type StudioImageOperationEvent
} from "@routego-image/contracts";

import { StudioGatewayError } from "./errors";

export const STUDIO_CREATION_STREAM_PATH = "/api/v1/studio/creation/stream" as const;

const DEFAULT_MAXIMUM_LINE_BYTES = 262_144;
const DEFAULT_MAXIMUM_EVENT_BYTES = 1_048_576;
const DEFAULT_MAXIMUM_BODY_BYTES = 8_388_608;

const textEncoder = new TextEncoder();

export interface StudioSseParserLimits {
  readonly maximumLineBytes?: number;
  readonly maximumEventBytes?: number;
  readonly maximumBodyBytes?: number;
}

export interface StudioSseParserOptions {
  readonly signal?: AbortSignal;
  readonly limits?: StudioSseParserLimits;
}

interface NormalizedLimits {
  readonly maximumLineBytes: number;
  readonly maximumEventBytes: number;
  readonly maximumBodyBytes: number;
}

interface SseRecord {
  readonly data: string;
  readonly event?: string;
  readonly id?: string;
}

function invalidOutput(message: string): StudioGatewayError {
  return new StudioGatewayError("invalid_output", message);
}

function cancelledStream(): StudioGatewayError {
  return new StudioGatewayError("network_error", "The Studio image stream was cancelled.");
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return selected;
}

function normalizedLimits(input: StudioSseParserLimits | undefined): NormalizedLimits {
  const maximumLineBytes = positiveLimit(
    input?.maximumLineBytes,
    DEFAULT_MAXIMUM_LINE_BYTES,
    "maximumLineBytes"
  );
  const maximumEventBytes = positiveLimit(
    input?.maximumEventBytes,
    DEFAULT_MAXIMUM_EVENT_BYTES,
    "maximumEventBytes"
  );
  const maximumBodyBytes = positiveLimit(
    input?.maximumBodyBytes,
    DEFAULT_MAXIMUM_BODY_BYTES,
    "maximumBodyBytes"
  );
  if (maximumEventBytes < maximumLineBytes) {
    throw new Error("maximumEventBytes must be at least maximumLineBytes");
  }
  if (maximumBodyBytes < maximumEventBytes) {
    throw new Error("maximumBodyBytes must be at least maximumEventBytes");
  }
  return { maximumLineBytes, maximumEventBytes, maximumBodyBytes };
}

function utf8Length(value: string): number {
  return textEncoder.encode(value).byteLength;
}

class StrictSseDecoder {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #limits: NormalizedLimits;
  #buffer = "";
  #eventBytes = 0;
  #dataLines: string[] = [];
  #eventName: string | undefined;
  #id: string | undefined;

  constructor(limits: NormalizedLimits) {
    this.#limits = limits;
  }

  push(chunk: Uint8Array): readonly SseRecord[] {
    let text: string;
    try {
      text = this.#decoder.decode(chunk, { stream: true });
    } catch {
      throw invalidOutput("The local service returned invalid UTF-8 in the Studio event stream.");
    }
    this.#buffer += text;
    return this.#consumeCompleteLines();
  }

  finish(): readonly SseRecord[] {
    try {
      this.#buffer += this.#decoder.decode();
    } catch {
      throw invalidOutput("The local service returned invalid UTF-8 in the Studio event stream.");
    }
    const records = this.#consumeCompleteLines();
    if (this.#buffer !== "" || this.#hasRecordFields()) {
      throw invalidOutput("The local service ended the Studio event stream with incomplete framing.");
    }
    return records;
  }

  #hasRecordFields(): boolean {
    return this.#dataLines.length > 0 || this.#eventName !== undefined || this.#id !== undefined;
  }

  #consumeCompleteLines(): readonly SseRecord[] {
    const records: SseRecord[] = [];
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      const rawLine = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.includes("\r")) {
        throw invalidOutput("The local service returned invalid Studio event line endings.");
      }
      const lineBytes = utf8Length(line);
      if (lineBytes > this.#limits.maximumLineBytes) {
        throw invalidOutput("The local service returned an oversized Studio event line.");
      }
      this.#eventBytes += utf8Length(rawLine) + 1;
      if (this.#eventBytes > this.#limits.maximumEventBytes) {
        throw invalidOutput("The local service returned an oversized Studio event record.");
      }
      const record = this.#consumeLine(line);
      if (record !== undefined) records.push(record);
    }

    const buffered = this.#buffer.endsWith("\r")
      ? this.#buffer.slice(0, -1)
      : this.#buffer;
    if (utf8Length(buffered) > this.#limits.maximumLineBytes) {
      throw invalidOutput("The local service returned an oversized Studio event line.");
    }
    if (buffered.includes("\r")) {
      throw invalidOutput("The local service returned invalid Studio event line endings.");
    }
    return records;
  }

  #consumeLine(line: string): SseRecord | undefined {
    if (line === "") {
      if (!this.#hasRecordFields()) {
        throw invalidOutput("The local service returned an empty Studio event record.");
      }
      if (this.#dataLines.length === 0) {
        throw invalidOutput("The local service returned a Studio event without JSON data.");
      }
      const record: SseRecord = {
        data: this.#dataLines.join("\n"),
        ...(this.#eventName === undefined ? {} : { event: this.#eventName }),
        ...(this.#id === undefined ? {} : { id: this.#id })
      };
      this.#eventBytes = 0;
      this.#dataLines = [];
      this.#eventName = undefined;
      this.#id = undefined;
      return record;
    }
    if (line.startsWith(":")) {
      throw invalidOutput("The local service returned an unsupported Studio event comment.");
    }

    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "data") {
      this.#dataLines.push(value);
      return undefined;
    }
    if (field === "event") {
      if (this.#eventName !== undefined) {
        throw invalidOutput("The local service returned duplicate Studio event metadata.");
      }
      this.#eventName = value;
      return undefined;
    }
    if (field === "id") {
      if (this.#id !== undefined || value.includes("\u0000")) {
        throw invalidOutput("The local service returned invalid Studio event metadata.");
      }
      this.#id = value;
      return undefined;
    }
    throw invalidOutput("The local service returned an unsupported Studio event field.");
  }
}

function parseRecord(record: SseRecord): StudioImageOperationEvent {
  let json: unknown;
  try {
    json = JSON.parse(record.data) as unknown;
  } catch {
    throw invalidOutput("The local service returned invalid Studio event JSON.");
  }
  const parsed = studioImageOperationEventSchema.safeParse(json);
  if (!parsed.success) {
    throw invalidOutput("The local service returned an event outside the frozen Studio contract.");
  }
  const event = parsed.data;
  if (record.event !== undefined && record.event !== event.type) {
    throw invalidOutput("The Studio event name did not match its validated payload.");
  }
  if (record.id !== undefined && record.id !== `${event.requestId}:${event.sequence}`) {
    throw invalidOutput("The Studio event ID did not match its validated payload.");
  }
  return event;
}

export function assertStudioEventStreamContentType(value: string | null): void {
  if (value === null) {
    throw invalidOutput("The local service omitted the Studio event stream content type.");
  }
  const parts = value.split(";").map((part) => part.trim().toLowerCase());
  if (
    parts.length !== 2 ||
    parts[0] !== "text/event-stream" ||
    parts[1] !== "charset=utf-8"
  ) {
    throw invalidOutput("The local service returned an invalid Studio event stream content type.");
  }
}

export async function* parseStudioImageOperationEventStream(
  body: ReadableStream<Uint8Array>,
  options: StudioSseParserOptions = {}
): AsyncGenerator<StudioImageOperationEvent> {
  const limits = normalizedLimits(options.limits);
  const reader = body.getReader();
  const decoder = new StrictSseDecoder(limits);
  let totalBytes = 0;
  let started = false;
  let requestId: string | undefined;
  let lastSequence = -1;
  let terminal: StudioImageOperationEvent | undefined;
  let reachedEof = false;
  let aborted = options.signal?.aborted === true;
  const abort = (): void => {
    aborted = true;
    void reader.cancel().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  const accept = (record: SseRecord): StudioImageOperationEvent | undefined => {
    if (terminal !== undefined) {
      throw invalidOutput("The local service returned data after the Studio terminal event.");
    }
    const event = parseRecord(record);
    if (!started) {
      if (event.type !== "started") {
        throw invalidOutput("The first Studio image event must be started.");
      }
      started = true;
      requestId = event.requestId;
    } else if (event.type === "started") {
      throw invalidOutput("The Studio image stream may contain only one started event.");
    }
    if (event.requestId !== requestId) {
      throw invalidOutput("Studio image event request identifiers must remain consistent.");
    }
    if (event.sequence <= lastSequence) {
      throw invalidOutput("Studio image event sequences must increase strictly.");
    }
    lastSequence = event.sequence;
    if (event.type === "completed" && event.result.requestId !== requestId) {
      throw invalidOutput("The completed Studio result used a different request identifier.");
    }
    if (event.type === "completed" || event.type === "failed") {
      terminal = event;
      return undefined;
    }
    return event;
  };

  try {
    while (true) {
      if (aborted) throw cancelledStream();
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        if (aborted || options.signal?.aborted === true) throw cancelledStream();
        throw new StudioGatewayError(
          "network_error",
          "Studio lost the local image event stream."
        );
      }
      if (aborted) throw cancelledStream();
      if (result.done) {
        for (const record of decoder.finish()) {
          const event = accept(record);
          if (event !== undefined) yield event;
        }
        reachedEof = true;
        break;
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > limits.maximumBodyBytes) {
        throw invalidOutput("The local service returned an oversized Studio event stream.");
      }
      for (const record of decoder.push(result.value)) {
        const event = accept(record);
        if (event !== undefined) yield event;
      }
    }
    if (!started || terminal === undefined) {
      throw invalidOutput("The local service ended the Studio image stream before a terminal event.");
    }
    yield terminal;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (!reachedEof) {
      try {
        await reader.cancel();
      } catch {
        // Reader cancellation is best-effort after a fail-closed boundary result.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // Reader lock release must not replace the primary stream result.
    }
  }
}
