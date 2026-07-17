import type { LocalRoutegoService, RoutegoService } from "@routego-image/contracts";
import type { LoopbackAddress } from "@routego-image/foundation";

export type RoutegoHttpBodyChunk = string | Uint8Array;
export type RoutegoHttpBody = RoutegoHttpBodyChunk | AsyncIterable<RoutegoHttpBodyChunk>;

export interface RoutegoHttpRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: AsyncIterable<RoutegoHttpBodyChunk>;
  readonly signal: AbortSignal;
}

export interface RoutegoHttpResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: RoutegoHttpBody;
}

export interface RoutegoHttpExtensionContext {
  readonly preflight: boolean;
  readonly allowOrigin: string;
  readonly corsHeaders: Readonly<Record<string, string>>;
}

export type RoutegoHttpExtensionHandler = (
  request: RoutegoHttpRequest,
  context: RoutegoHttpExtensionContext
) => Promise<RoutegoHttpResponse | undefined>;

export interface RoutegoHttpRuntimeOptions {
  readonly service: RoutegoService;
  readonly localService?: LocalRoutegoService;
  readonly expectedSessionToken: string;
  readonly allowedOrigins: readonly string[];
  readonly maximumJsonBodyBytes?: number;
  readonly maximumQueryBytes?: number;
  readonly extensionHandler?: RoutegoHttpExtensionHandler;
  readonly logger?: (diagnostic: unknown) => void | Promise<void>;
}

export interface RoutegoLoopbackServerOptions extends RoutegoHttpRuntimeOptions {
  readonly address: LoopbackAddress;
  readonly port?: number;
}

export interface RoutegoLoopbackServerAddress {
  readonly address: LoopbackAddress;
  readonly port: number;
  readonly origin: string;
}

export interface RoutegoHttpDispatcher {
  dispatch(request: RoutegoHttpRequest): Promise<RoutegoHttpResponse>;
}
