import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createRoutegoHttpDispatcher,
  type RoutegoHttpBodyChunk,
  type RoutegoHttpExtensionHandler,
  type RoutegoHttpRequest,
  type RoutegoHttpResponse,
  type RoutegoLoopbackServerAddress
} from "@routego-image/creation";
import {
  routegoOpenStudioResultSchema,
  type LocalRoutegoService,
  type RoutegoOpenStudioResult,
  type RoutegoService
} from "@routego-image/contracts";
import {
  assertLoopbackBindAddress,
  generateSessionToken,
  redactDiagnostic,
  type LoopbackAddress
} from "@routego-image/foundation";

import {
  StudioSessionManager,
  type IssuedStudioSession,
  type StudioSessionManagerOptions
} from "./sessions";
import { StudioStaticAssetRegistry } from "./static";

export interface IntegrationLoopbackHttpHostOptions {
  readonly service: RoutegoService;
  readonly localService?: LocalRoutegoService;
  readonly address: LoopbackAddress;
  readonly port?: number;
  readonly staticAssets: StudioStaticAssetRegistry;
  readonly entryModuleRoute: string;
  readonly styleRoutes?: readonly string[];
  readonly sessions?: StudioSessionManager;
  readonly sessionOptions?: StudioSessionManagerOptions;
  readonly maximumJsonBodyBytes?: number;
  readonly maximumQueryBytes?: number;
  readonly extensionHandler?: RoutegoHttpExtensionHandler;
  readonly logger?: (diagnostic: unknown) => void | Promise<void>;
}

export interface IssuedStudioLaunch {
  readonly result: RoutegoOpenStudioResult;
  readonly session: IssuedStudioSession;
}

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

function waitForResponseDrain(target: ServerResponse, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || target.destroyed || target.writableEnded) return Promise.resolve(false);
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      target.off("drain", onDrain);
      target.off("close", onClose);
      target.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (drained: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(drained);
    };
    const onDrain = () => settle(true);
    const onClose = () => settle(false);
    const onAbort = () => settle(false);
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    target.once("drain", onDrain);
    target.once("close", onClose);
    target.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted || target.destroyed || target.writableEnded) settle(false);
  });
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
  const iterator = response.body[Symbol.asyncIterator]();
  try {
    while (!signal.aborted && !target.destroyed && !target.writableEnded) {
      const result = await iterator.next();
      if (result.done) break;
      if (signal.aborted || target.destroyed || target.writableEnded) break;
      if (!target.write(result.value) && !await waitForResponseDrain(target, signal)) break;
    }
  } finally {
    try {
      await iterator.return?.();
    } finally {
      if (!target.writableEnded && !target.destroyed) target.end();
    }
  }
}

function jsonError(status: number, code: string, safeMessage: string): RoutegoHttpResponse {
  return {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff"
    },
    body: JSON.stringify({ error: { code, safeMessage } })
  };
}

function header(request: RoutegoHttpRequest, name: string): string | undefined {
  return request.headers[name.toLowerCase()];
}

function withBrowserSameOrigin(
  request: RoutegoHttpRequest,
  expectedOrigin: string
): RoutegoHttpRequest {
  if (header(request, "origin") !== undefined || (header(request, "cookie") ?? "").trim() !== "") {
    return request;
  }
  const fetchSite = (header(request, "sec-fetch-site") ?? "").trim().toLowerCase();
  const fetchMode = (header(request, "sec-fetch-mode") ?? "").trim().toLowerCase();
  const fetchDestination = (header(request, "sec-fetch-dest") ?? "").trim().toLowerCase();
  const expectedHost = new URL(expectedOrigin).host.toLowerCase();
  const presentedHost = (header(request, "host") ?? "").trim().toLowerCase();
  if (
    fetchSite !== "same-origin" ||
    (fetchMode !== "cors" && fetchMode !== "same-origin") ||
    fetchDestination !== "empty" ||
    presentedHost !== expectedHost
  ) {
    return request;
  }
  return {
    ...request,
    headers: { ...request.headers, origin: expectedOrigin }
  };
}

function safeJsonForInlineScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function bootstrapHtml(
  sessionToken: string,
  expiresAt: string,
  entryModuleRoute: string,
  styleRoutes: readonly string[],
  nonce: string
): string {
  const bootstrap = safeJsonForInlineScript({ sessionToken, expiresAt });
  const styles = styleRoutes
    .map((route) => `<link rel="stylesheet" href="${route}">`)
    .join("");
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>Routego Image Studio</title>",
    styles,
    "</head><body><div id=\"root\"></div>",
    `<script nonce="${nonce}">`,
    `Object.defineProperty(globalThis,"__ROUTEGO_STUDIO_SESSION__",{value:Object.freeze(${bootstrap}),configurable:false});`,
    "history.replaceState(null,document.title,location.pathname);",
    "</script>",
    `<script type="module" src="${entryModuleRoute}"></script>`,
    "</body></html>"
  ].join("");
}

export class IntegrationLoopbackHttpHost {
  readonly #options: IntegrationLoopbackHttpHostOptions;
  readonly #sessions: StudioSessionManager;
  readonly #controllers = new Set<AbortController>();
  readonly #responses = new Set<ServerResponse>();
  #server: Server | undefined;
  #address: RoutegoLoopbackServerAddress | undefined;
  #startPromise: Promise<RoutegoLoopbackServerAddress> | undefined;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: IntegrationLoopbackHttpHostOptions) {
    const address = assertLoopbackBindAddress(options.address);
    const port = options.port ?? 0;
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error("port must be an integer from 0 through 65535");
    }
    if (!options.staticAssets.hasRoute(options.entryModuleRoute)) {
      throw new Error("entryModuleRoute must name an allowlisted Studio static asset");
    }
    for (const route of options.styleRoutes ?? []) {
      if (!options.staticAssets.hasRoute(route)) {
        throw new Error("Every style route must name an allowlisted Studio static asset");
      }
    }
    if (options.sessions !== undefined && options.sessionOptions !== undefined) {
      throw new Error("Provide either sessions or sessionOptions, not both");
    }
    this.#options = { ...options, address, port };
    this.#sessions = options.sessions ?? new StudioSessionManager(options.sessionOptions);
  }

  get address(): RoutegoLoopbackServerAddress | undefined {
    return this.#address;
  }

  get sessions(): StudioSessionManager {
    return this.#sessions;
  }

  get isHealthy(): boolean {
    return this.#address !== undefined && this.#server?.listening === true && !this.#closed;
  }

  async start(): Promise<RoutegoLoopbackServerAddress> {
    if (this.#address !== undefined) return this.#address;
    if (this.#closed) throw new Error("The Integration HTTP host is closed.");
    if (this.#startPromise !== undefined) return this.#startPromise;
    this.#startPromise = this.#listen();
    try {
      return await this.#startPromise;
    } finally {
      this.#startPromise = undefined;
    }
  }

  async openStudioSession(reused?: boolean): Promise<IssuedStudioLaunch> {
    const listenerWasHealthy = this.isHealthy;
    const address = await this.start();
    const issued = this.#sessions.issue();
    const url = new URL(address.origin);
    url.pathname = "/";
    url.searchParams.set("token", issued.launchToken);
    const result = routegoOpenStudioResultSchema.parse({
      schemaVersion: 1,
      url: url.toString(),
      expiresAt: issued.expiresAt,
      reused: reused ?? listenerWasHealthy,
      address: address.address
    });
    return { result, session: issued };
  }

  async #listen(): Promise<RoutegoLoopbackServerAddress> {
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    this.#server = server;
    try {
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
        throw new Error("The Integration HTTP host did not return a TCP address.");
      }
      const info = bound as AddressInfo;
      const address = assertLoopbackBindAddress(info.address);
      const host = address === "::1" ? "[::1]" : address;
      this.#address = { address, port: info.port, origin: `http://${host}:${info.port}` };
      return this.#address;
    } catch (error) {
      this.#server = undefined;
      try {
        server.close();
      } catch {
        // The original startup error remains authoritative.
      }
      throw error;
    }
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController();
    this.#controllers.add(controller);
    this.#responses.add(response);
    const abort = () => controller.abort();
    request.once("aborted", abort);
    response.once("close", abort);
    try {
      const address = this.#address;
      if (address === undefined || this.#closed) {
        await writeResponse(
          jsonError(503, "runtime_unavailable", "The local HTTP runtime is unavailable."),
          response,
          controller.signal
        );
        return;
      }
      const rawUrl = request.url ?? "/";
      if (!rawUrl.startsWith("/") || rawUrl.startsWith("//")) {
        await writeResponse(
          jsonError(400, "invalid_request", "The request target is invalid."),
          response,
          controller.signal
        );
        return;
      }
      const url = new URL(rawUrl, address.origin);
      const runtimeRequest: RoutegoHttpRequest = {
        method: request.method ?? "GET",
        url,
        headers: requestHeaders(request),
        body: requestBody(request),
        signal: controller.signal
      };
      const runtimeResponse = await this.#dispatch(runtimeRequest);
      await writeResponse(runtimeResponse, response, controller.signal);
    } catch (error) {
      await this.#diagnose(error);
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("cache-control", "no-store");
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("x-content-type-options", "nosniff");
      }
      if (!response.writableEnded && !response.destroyed) {
        response.end(JSON.stringify({
          error: { code: "internal_contract", safeMessage: "The local HTTP runtime failed safely." }
        }));
      }
    } finally {
      request.off("aborted", abort);
      response.off("close", abort);
      this.#controllers.delete(controller);
      this.#responses.delete(response);
    }
  }

  async #dispatch(request: RoutegoHttpRequest): Promise<RoutegoHttpResponse> {
    const method = request.method.toUpperCase();
    const pathname = request.url.pathname;
    if (pathname === "/") return this.#bootstrap(request, method);
    if (
      this.#options.staticAssets.hasRoute(pathname) ||
      this.#options.staticAssets.isStaticNamespace(pathname)
    ) {
      return this.#options.staticAssets.handle(method, pathname, request.url.search, request.headers);
    }

    let expectedSessionToken: string | undefined;
    if (method === "OPTIONS") {
      expectedSessionToken = this.#sessions.firstActiveSessionToken();
    } else {
      const presented = header(request, "x-routego-session") ?? "";
      if (this.#sessions.authorizeSessionToken(presented) !== undefined) {
        expectedSessionToken = presented;
      }
    }
    if (expectedSessionToken === undefined) {
      return jsonError(403, "session_invalid", "The local session is missing or no longer valid.");
    }
    const address = this.#address;
    if (address === undefined) {
      return jsonError(503, "runtime_unavailable", "The local HTTP runtime is unavailable.");
    }
    const dispatcher = createRoutegoHttpDispatcher({
      service: this.#options.service,
      ...(this.#options.localService === undefined ? {} : { localService: this.#options.localService }),
      expectedSessionToken,
      allowedOrigins: [address.origin],
      ...(this.#options.maximumJsonBodyBytes === undefined
        ? {}
        : { maximumJsonBodyBytes: this.#options.maximumJsonBodyBytes }),
      ...(this.#options.maximumQueryBytes === undefined
        ? {}
        : { maximumQueryBytes: this.#options.maximumQueryBytes }),
      ...(this.#options.extensionHandler === undefined
        ? {}
        : { extensionHandler: this.#options.extensionHandler }),
      ...(this.#options.logger === undefined ? {} : { logger: this.#options.logger })
    });
    return dispatcher.dispatch(withBrowserSameOrigin(request, address.origin));
  }

  #bootstrap(request: RoutegoHttpRequest, method: string): RoutegoHttpResponse {
    if (method !== "GET") {
      const response = jsonError(405, "invalid_request", "Studio bootstrap requires GET.");
      return {
        ...response,
        headers: { ...response.headers, allow: "GET" }
      };
    }
    if ((header(request, "cookie") ?? "").trim() !== "") {
      return jsonError(403, "origin_rejected", "Cookie authentication is not accepted by the local service.");
    }
    const tokens = request.url.searchParams.getAll("token");
    if (tokens.length !== 1 || [...request.url.searchParams.keys()].length !== 1) {
      return jsonError(403, "session_invalid", "The Studio launch token is missing or no longer valid.");
    }
    const activated = this.#sessions.authorizeLaunchToken(tokens[0] ?? "");
    if (activated === undefined) {
      return jsonError(403, "session_invalid", "The Studio launch token is missing or no longer valid.");
    }
    const nonce = generateSessionToken(24);
    const html = bootstrapHtml(
      activated.sessionToken,
      activated.expiresAt,
      this.#options.entryModuleRoute,
      this.#options.styleRoutes ?? [],
      nonce
    );
    return {
      status: 200,
      headers: {
        "cache-control": "no-store, max-age=0",
        "content-length": String(Buffer.byteLength(html, "utf8")),
        "content-security-policy": [
          "default-src 'none'",
          `script-src 'self' 'nonce-${nonce}'`,
          "style-src 'self'",
          "img-src 'self' data: blob:",
          "font-src 'self'",
          "connect-src 'self'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'"
        ].join("; "),
        "content-type": "text/html; charset=utf-8",
        expires: "0",
        pragma: "no-cache",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY"
      },
      body: html
    };
  }

  async #diagnose(value: unknown): Promise<void> {
    if (this.#options.logger === undefined) return;
    try {
      await this.#options.logger(redactDiagnostic(value));
    } catch {
      // Diagnostic sinks cannot affect listener lifecycle.
    }
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#sessions.close();
    for (const controller of this.#controllers) controller.abort();
    for (const response of this.#responses) {
      if (!response.writableEnded && !response.destroyed) response.end();
    }
    const server = this.#server;
    if (server !== undefined) {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error !== undefined) reject(error);
            else resolve();
          });
        });
      }
    }
    this.#server = undefined;
    this.#address = undefined;
  }
}

export function createIntegrationLoopbackHttpHost(
  options: IntegrationLoopbackHttpHostOptions
): IntegrationLoopbackHttpHost {
  return new IntegrationLoopbackHttpHost(options);
}
