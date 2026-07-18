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
}

interface OutgoingResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(data?: Uint8Array): void;
}

type Next = () => void;

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

async function toRequest(input: IncomingRequest): Promise<Request> {
  const host = input.headers["host"];
  const authority = typeof host === "string" ? host : "127.0.0.1";
  const method = input.method ?? "GET";
  const body = await requestBody(input);
  return new Request(`http://${authority}${input.url ?? "/"}`, {
    method,
    headers: requestHeaders(input),
    ...(body === undefined ? {} : { body })
  });
}

async function writeResponse(source: Response, target: OutgoingResponse): Promise<void> {
  target.statusCode = source.status;
  source.headers.forEach((value, name) => target.setHeader(name, value));
  target.end(new Uint8Array(await source.arrayBuffer()));
}

export function installStudioMockBridge(
  use: (handler: (request: unknown, response: unknown, next: Next) => void) => void,
  options: StudioMockBridgeOptions
): void {
  const handler = createStudioMockHandler(options);
  use((request, response, next) => {
    const incoming = request as IncomingRequest;
    if (!(incoming.url ?? "/").startsWith("/api/v1/")) {
      next();
      return;
    }
    void (async () => {
      try {
        const result = await handler(await toRequest(incoming));
        if (result === undefined) {
          next();
          return;
        }
        await writeResponse(result, response as OutgoingResponse);
      } catch {
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
          response as OutgoingResponse
        );
      }
    })();
  });
}
