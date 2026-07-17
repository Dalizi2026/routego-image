export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export class JsonRpcFramingError extends Error {
  readonly code: "invalid-utf8" | "line-too-large" | "trailing-data";

  constructor(code: JsonRpcFramingError["code"], message: string) {
    super(message);
    this.name = "JsonRpcFramingError";
    this.code = code;
  }
}

export interface JsonRpcLineDecoderOptions {
  readonly maximumLineBytes?: number;
}

export class JsonRpcLineDecoder {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #maximumLineBytes: number;
  #buffer = "";

  constructor(options: JsonRpcLineDecoderOptions = {}) {
    this.#maximumLineBytes = options.maximumLineBytes ?? 1_048_576;
  }

  #bounded(): void {
    if (Buffer.byteLength(this.#buffer, "utf8") > this.#maximumLineBytes) {
      this.#buffer = "";
      throw new JsonRpcFramingError("line-too-large", "A JSON-RPC line exceeded the byte limit.");
    }
  }

  push(chunk: Uint8Array | string): string[] {
    try {
      this.#buffer += typeof chunk === "string"
        ? chunk
        : this.#decoder.decode(chunk, { stream: true });
    } catch {
      this.#buffer = "";
      throw new JsonRpcFramingError("invalid-utf8", "JSON-RPC input must be valid UTF-8.");
    }
    this.#bounded();
    const lines: string[] = [];
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      let line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim().length > 0) lines.push(line);
    }
    this.#bounded();
    return lines;
  }

  finish(): string[] {
    let tail = "";
    try {
      tail = this.#decoder.decode();
    } catch {
      this.#buffer = "";
      throw new JsonRpcFramingError("invalid-utf8", "JSON-RPC input must be valid UTF-8.");
    }
    this.#buffer += tail;
    this.#bounded();
    if (this.#buffer.trim().length === 0) {
      this.#buffer = "";
      return [];
    }
    const line = this.#buffer.endsWith("\r") ? this.#buffer.slice(0, -1) : this.#buffer;
    this.#buffer = "";
    return [line];
  }
}

export function jsonRpcSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcFailure(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown
): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) }
  };
}

export function parseJsonRpcRequest(value: unknown): JsonRpcRequest | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record["jsonrpc"] !== "2.0" || typeof record["method"] !== "string") return undefined;
  const id = record["id"];
  if (
    id !== undefined &&
    id !== null &&
    typeof id !== "string" &&
    (typeof id !== "number" || !Number.isFinite(id))
  ) {
    return undefined;
  }
  return {
    jsonrpc: "2.0",
    method: record["method"],
    ...(id === undefined ? {} : { id: id as JsonRpcId }),
    ...(record["params"] === undefined ? {} : { params: record["params"] })
  };
}
