import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { assertLoopbackBindAddress, type LoopbackAddress } from "@routego-image/foundation";

import { createMockRelay, type MockRelay, type MockRelayOptions } from "./mock-relay";

export interface MockRelayTestServerOptions extends MockRelayOptions {
  readonly address?: LoopbackAddress;
  readonly port?: number;
  readonly maxRequestBytes?: number;
}

export interface MockRelayTestServer {
  readonly relay: MockRelay;
  readonly address: LoopbackAddress;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

async function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<ArrayBuffer> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("request-too-large");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw new Error("request-too-large");
    }
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks);
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

async function writeResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, name) => target.setHeader(name, value));
  const body = Buffer.from(await response.arrayBuffer());
  target.end(body);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

export async function startMockRelayTestServer(
  options: MockRelayTestServerOptions = {}
): Promise<MockRelayTestServer> {
  const address = assertLoopbackBindAddress(options.address ?? "127.0.0.1");
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Mock relay port must be an integer from 0 through 65535");
  }
  const maxRequestBytes = options.maxRequestBytes ?? 8 * 1024 * 1024;
  if (!Number.isInteger(maxRequestBytes) || maxRequestBytes < 1) {
    throw new Error("Mock relay request limit must be a positive integer");
  }
  const relay = createMockRelay(options);
  let origin: string | undefined;
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        const body = await readRequestBody(incoming, maxRequestBytes);
        const method = incoming.method ?? "GET";
        const request = new Request(`${origin ?? "http://127.0.0.1"}${incoming.url ?? "/"}`, {
          method,
          headers: requestHeaders(incoming),
          ...(method === "GET" || method === "HEAD" || body.byteLength === 0 ? {} : { body })
        });
        await writeResponse(await relay.handle(request), outgoing);
      } catch (error) {
        const tooLarge = error instanceof Error && error.message === "request-too-large";
        await writeResponse(
          Response.json(
            {
              error: {
                code: tooLarge ? "request_too_large" : "mock_server_error",
                message: tooLarge
                  ? "The mock request exceeded the configured byte limit."
                  : "The mock server could not process the request."
              }
            },
            { status: tooLarge ? 413 : 500 }
          ),
          outgoing
        );
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: address, port, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    await closeServer(server);
    throw new Error("Mock relay did not expose a TCP address");
  }
  const host = address === "::1" ? "[::1]" : address;
  origin = `http://${host}:${bound.port}`;

  return {
    relay,
    address,
    port: bound.port,
    url: origin,
    close: () => closeServer(server)
  };
}
