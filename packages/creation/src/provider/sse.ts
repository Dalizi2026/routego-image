import { redactFreeText } from "@routego-image/foundation";

export interface SseFrame {
  readonly event?: string;
  readonly data: string;
  readonly id?: string;
  readonly retry?: number;
  readonly done: boolean;
}

export class SseDecodingError extends Error {
  readonly reason: "invalid-utf8" | "invalid-json" | "frame-too-large";

  constructor(reason: SseDecodingError["reason"], safeMessage: string) {
    super(safeMessage);
    this.name = "SseDecodingError";
    this.reason = reason;
  }
}

export interface SseDecoderOptions {
  readonly maxFrameBytes?: number;
}

export class SseDecoder {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #maxFrameBytes: number;
  #buffer = "";
  #event: string | undefined;
  #id: string | undefined;
  #retry: number | undefined;
  #data: string[] = [];
  #frameBytes = 0;

  constructor(options: SseDecoderOptions = {}) {
    this.#maxFrameBytes = options.maxFrameBytes ?? 1_048_576;
  }

  #reset(): void {
    this.#event = undefined;
    this.#id = undefined;
    this.#retry = undefined;
    this.#data = [];
    this.#frameBytes = 0;
  }

  #dispatch(): SseFrame | undefined {
    if (
      this.#data.length === 0 &&
      this.#event === undefined &&
      this.#id === undefined &&
      this.#retry === undefined
    ) {
      this.#reset();
      return undefined;
    }
    const data = this.#data.join("\n");
    const frame: SseFrame = {
      data,
      done: data.trim() === "[DONE]",
      ...(this.#event === undefined ? {} : { event: this.#event }),
      ...(this.#id === undefined ? {} : { id: this.#id }),
      ...(this.#retry === undefined ? {} : { retry: this.#retry })
    };
    this.#reset();
    return frame;
  }

  #line(line: string): SseFrame | undefined {
    this.#frameBytes += Buffer.byteLength(line, "utf8") + 1;
    if (this.#frameBytes > this.#maxFrameBytes) {
      this.#reset();
      throw new SseDecodingError("frame-too-large", "A provider SSE frame exceeded the byte limit.");
    }
    if (line === "") {
      return this.#dispatch();
    }
    if (line.startsWith(":")) {
      return undefined;
    }
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    switch (field) {
      case "event":
        this.#event = value;
        break;
      case "data":
        this.#data.push(value);
        break;
      case "id":
        if (!value.includes("\0")) this.#id = value;
        break;
      case "retry": {
        const retry = Number(value);
        if (Number.isSafeInteger(retry) && retry >= 0) this.#retry = retry;
        break;
      }
      default:
        break;
    }
    return undefined;
  }

  #consumeText(text: string): SseFrame[] {
    this.#buffer += text;
    const frames: SseFrame[] = [];
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      let line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const frame = this.#line(line);
      if (frame !== undefined) frames.push(frame);
    }
    return frames;
  }

  push(chunk: Uint8Array | string): SseFrame[] {
    try {
      return this.#consumeText(
        typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true })
      );
    } catch (error) {
      if (error instanceof SseDecodingError) throw error;
      throw new SseDecodingError("invalid-utf8", "The provider SSE stream is not valid UTF-8.");
    }
  }

  finish(): SseFrame[] {
    let tail = "";
    try {
      tail = this.#decoder.decode();
    } catch {
      throw new SseDecodingError("invalid-utf8", "The provider SSE stream is not valid UTF-8.");
    }
    const frames = this.#consumeText(tail);
    if (this.#buffer.length > 0) {
      let line = this.#buffer;
      this.#buffer = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const frame = this.#line(line);
      if (frame !== undefined) frames.push(frame);
    }
    const finalFrame = this.#dispatch();
    if (finalFrame !== undefined) frames.push(finalFrame);
    return frames;
  }
}

export function parseSseJson(frame: SseFrame): unknown {
  if (frame.done) return undefined;
  try {
    return JSON.parse(frame.data) as unknown;
  } catch {
    throw new SseDecodingError(
      "invalid-json",
      `The provider SSE event ${redactFreeText(frame.event ?? "message")} contains invalid JSON.`
    );
  }
}

export async function decodeSseChunks(
  chunks: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>,
  options: SseDecoderOptions = {}
): Promise<SseFrame[]> {
  const decoder = new SseDecoder(options);
  const frames: SseFrame[] = [];
  for await (const chunk of chunks) {
    frames.push(...decoder.push(chunk));
  }
  frames.push(...decoder.finish());
  return frames;
}
