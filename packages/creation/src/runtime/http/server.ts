import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";

import { assertLoopbackBindAddress, redactDiagnostic } from "@routego-image/foundation";

import { createRoutegoHttpDispatcher } from "./dispatcher";
import type {
  RoutegoHttpBodyChunk,
  RoutegoHttpRequest,
  RoutegoHttpResponse,
  RoutegoLoopbackServerAddress,
  RoutegoLoopbackServerOptions
} from "./types";

function requestHeaders(request: IncomingMessage): Readonly<Record<string, string | undefined>> {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

async function* requestBody(request: IncomingMessage): AsyncGenerator<RoutegoHttpBodyChunk> {
  for await (const chunk of request) {
    if (typeof chunk === "string") yield chunk;
    else if (chunk instanceof Uint8Array) yield chunk;
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<RoutegoHttpBodyChunk> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value;
}

async function writeResponse(
  response: RoutegoHttpResponse,
  target: ServerResponse,
  signal: AbortSignal
): Promise<void> {
  target.statusCode = response.status;
  for (const [name, value] of Object.entries(response.headers ?? {})) target.setHeader(name, value);
  if (response.body === undefined) {
    target.end();
    return;
  }
  if (typeof response.body === "string" || response.body instanceof Uint8Array) {
    target.end(response.body);
    return;
  }
  if (!isAsyncIterable(response.body)) {
    target.end();
    return;
  }
  try {
    for await (const chunk of response.body) {
      if (signal.aborted || target.destroyed) break;
      if (!target.write(chunk)) await once(target, "drain");
    }
  } finally {
    if (!target.writableEnded && !target.destroyed) target.end();
  }
}

export class RoutegoLoopbackHttpServer {
  readonly #options: RoutegoLoopbackServerOptions;
  readonly #dispatcher: ReturnType<typeof createRoutegoHttpDispatcher>;
  readonly #controllers = new Set<AbortController>();
  readonly #responses = new Set<ServerResponse>();
  #server: Server | undefined;
  #address: RoutegoLoopbackServerAddress | undefined;
  #closing = false;

  constructor(options: RoutegoLoopbackServerOptions) {
    const address = assertLoopbackBindAddress(options.address);
    const port = options.port ?? 0;
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error("port must be an integer from 0 through 65535");
    }
    this.#options = { ...options, address, port };
    this.#dispatcher = createRoutegoHttpDispatcher(options);
  }

  get address(): RoutegoLoopbackServerAddress | undefined {
    return this.#address;
  }

  async start(): Promise<RoutegoLoopbackServerAddress> {
    if (this.#address !== undefined) return this.#address;
    if (this.#server !== undefined) throw new Error("The loopback server is already starting");
    if (this.#closing) throw new Error("The loopback server is shutting down");

    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.#options.port ?? 0, this.#options.address);
    });
    const bound = server.address();
    if (bound === null || typeof bound === "string") {
      await this.close();
      throw new Error("The loopback server did not return a TCP address");
    }
    const info = bound as AddressInfo;
    const address = assertLoopbackBindAddress(info.address);
    const host = address === "::1" ? "[::1]" : address;
    this.#address = { address, port: info.port, origin: `http://${host}:${info.port}` };
    return this.#address;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController();
    this.#controllers.add(controller);
    this.#responses.add(response);
    const abort = () => controller.abort();
    request.once("aborted", abort);
    response.once("close", abort);
    try {
      const host = this.#options.address === "::1" ? "[::1]" : this.#options.address;
      const url = new URL(request.url ?? "/", `http://${host}`);
      const runtimeRequest: RoutegoHttpRequest = {
        method: request.method ?? "GET",
        url,
        headers: requestHeaders(request),
        body: requestBody(request),
        signal: controller.signal
      };
      const runtimeResponse = await this.#dispatcher.dispatch(runtimeRequest);
      await writeResponse(runtimeResponse, response, controller.signal);
    } catch (error) {
      await this.#diagnose(error);
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("cache-control", "no-store");
        response.setHeader("content-type", "application/json; charset=utf-8");
      }
      if (!response.writableEnded && !response.destroyed) {
        response.end(JSON.stringify({
          error: { code: "internal_contract", safeMessage: "The HTTP runtime failed safely." }
        }));
      }
    } finally {
      request.off("aborted", abort);
      response.off("close", abort);
      this.#controllers.delete(controller);
      this.#responses.delete(response);
    }
  }

  async #diagnose(value: unknown): Promise<void> {
    if (this.#options.logger === undefined) return;
    try {
      await this.#options.logger(redactDiagnostic(value));
    } catch {
      // Diagnostic sinks cannot affect server lifecycle.
    }
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    for (const controller of this.#controllers) controller.abort();
    for (const response of this.#responses) {
      if (!response.writableEnded && !response.destroyed) response.end();
    }
    const server = this.#server;
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) reject(error);
          else resolve();
        });
      });
    }
    this.#server = undefined;
    this.#address = undefined;
    this.#closing = false;
  }
}

export function createRoutegoLoopbackHttpServer(
  options: RoutegoLoopbackServerOptions
): RoutegoLoopbackHttpServer {
  return new RoutegoLoopbackHttpServer(options);
}
