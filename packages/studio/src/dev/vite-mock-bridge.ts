import type { LocalRoutegoService } from "@routego-image/contracts";

import { createStudioMockHandler } from "./mock-handler";

export interface StudioMockBridgeOptions {
  readonly service: LocalRoutegoService;
  readonly sessionToken: string;
}

interface IncomingRequest extends AsyncIterable<Uint8Array> {
  readonly method?: string;
  readonly url?: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  once?(event: "aborted", listener: () => void): void;
  off?(event: "aborted", listener: () => void): void;
}

interface OutgoingResponse {
  statusCode: number;
  readonly destroyed?: boolean;
  readonly headersSent?: boolean;
  readonly writableEnded?: boolean;
  setHeader(name: string, value: string): void;
  write(data: Uint8Array): boolean;
  end(data?: Uint8Array): void;
  once?(event: "close" | "drain", listener: () => void): void;
  off?(event: "close" | "drain", listener: () => void): void;
}

type Next = () => void;

function responseClosed(target: OutgoingResponse): boolean {
  return target.destroyed === true || target.writableEnded === true;
}

function requestHeaders(input: IncomingRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input.headers)) {
    if (typeof value === "string") {
      headers.set(name, value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    }
  }
  return headers;
}

async function requestBody(input: IncomingRequest): Promise<ArrayBuffer | undefined> {
  if (input.method === "GET" || input.method === "HEAD") {
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of input) {
    const copy = Uint8Array.from(chunk);
    chunks.push(copy);
    length += copy.byteLength;
  }
  if (length === 0) {
    return undefined;
  }
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

async function toRequest(input: IncomingRequest, signal: AbortSignal): Promise<Request> {
  const host = input.headers["host"];
  const authority = typeof host === "string" ? host : "127.0.0.1";
  const method = input.method ?? "GET";
  const body = await requestBody(input);
  return new Request(`http://${authority}${input.url ?? "/"}`, {
    method,
    headers: requestHeaders(input),
    signal,
    ...(body === undefined ? {} : { body })
  });
}

function waitForDrain(target: OutgoingResponse, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("response-aborted"));
  if (target.once === undefined) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const drained = (): void => {
      cleanup();
      resolve();
    };
    const aborted = (): void => {
      cleanup();
      reject(new Error("response-aborted"));
    };
    const cleanup = (): void => {
      target.off?.("drain", drained);
      signal.removeEventListener("abort", aborted);
    };
    target.once?.("drain", drained);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

async function writeResponse(
  source: Response,
  target: OutgoingResponse,
  signal: AbortSignal
): Promise<void> {
  target.statusCode = source.status;
  source.headers.forEach((value, name) => target.setHeader(name, value));
  if (source.body === null) {
    target.end();
    return;
  }

  const reader = source.body.getReader();
  let reachedEof = false;
  const abort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted || responseClosed(target)) throw new Error("response-aborted");
      const result = await reader.read();
      if (result.done) {
        reachedEof = true;
        break;
      }
      if (!target.write(result.value)) {
        await waitForDrain(target, signal);
      }
    }
    if (!responseClosed(target)) {
      target.end();
    }
  } finally {
    signal.removeEventListener("abort", abort);
    if (!reachedEof) {
      try {
        await reader.cancel();
      } catch {
        // Client disconnect cleanup must not replace the original bridge result.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // Reader lock cleanup is best-effort after the response boundary closes.
    }
  }
}

export function installStudioMockBridge(
  use: (handler: (request: unknown, response: unknown, next: Next) => void) => void,
  options: StudioMockBridgeOptions
): void {
  const handler = createStudioMockHandler(options);
  use((request, response, next) => {
    const incoming = request as IncomingRequest;
    const outgoing = response as OutgoingResponse;
    if (!(incoming.url ?? "/").startsWith("/api/v1/")) {
      next();
      return;
    }
    const controller = new AbortController();
    const abortIncoming = (): void => controller.abort();
    const abortOutgoing = (): void => {
      if (outgoing.writableEnded !== true) controller.abort();
    };
    incoming.once?.("aborted", abortIncoming);
    outgoing.once?.("close", abortOutgoing);
    void (async () => {
      try {
        const result = await handler(await toRequest(incoming, controller.signal));
        if (result === undefined) {
          next();
          return;
        }
        await writeResponse(result, outgoing, controller.signal);
      } catch {
        if (
          controller.signal.aborted ||
          responseClosed(outgoing) ||
          outgoing.headersSent === true
        ) {
          return;
        }
        await writeResponse(
          Response.json(
            {
              error: {
                code: "mock_bridge_error",
                safeMessage: "The deterministic Studio bridge failed safely."
              }
            },
            { status: 500, headers: { "cache-control": "no-store" } }
          ),
          outgoing,
          controller.signal
        );
      } finally {
        incoming.off?.("aborted", abortIncoming);
        outgoing.off?.("close", abortOutgoing);
      }
    })();
  });
}
