import {
  routegoOperationDefinitions,
  routegoOperationNames,
  studioOperationDefinitions,
  studioOperationNames,
  type LocalRoutegoService,
  type RoutegoOperation,
  type RoutegoService,
  type StudioOperation
} from "@routego-image/contracts";
import {
  authorizeLoopbackRequest,
  createLoopbackCorsHeaders,
  normalizeLoopbackOrigin,
  redactDiagnostic
} from "@routego-image/foundation";

import type {
  RoutegoHttpDispatcher,
  RoutegoHttpRequest,
  RoutegoHttpResponse,
  RoutegoHttpRuntimeOptions
} from "./types";

interface RuntimeSchema {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: unknown }
    | {
        readonly success: false;
        readonly error: {
          readonly issues: readonly {
            readonly path: readonly PropertyKey[];
            readonly message: string;
          }[];
        };
      };
}

interface RuntimeRoute {
  readonly scope: "public" | "studio";
  readonly operation: RoutegoOperation | StudioOperation;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly inputSchema: RuntimeSchema;
  readonly outputSchema: RuntimeSchema;
}

const DEFAULT_MAXIMUM_JSON_BODY_BYTES = 1_048_576;
const DEFAULT_MAXIMUM_QUERY_BYTES = 16_384;
const STANDARD_REQUEST_HEADERS = new Set(["content-type", "x-routego-session"]);

const ROUTES: readonly RuntimeRoute[] = [
  ...routegoOperationNames.map((operation): RuntimeRoute => {
    const definition = routegoOperationDefinitions[operation];
    return {
      scope: "public",
      operation,
      method: definition.http.method,
      path: definition.http.path,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema
    };
  }),
  ...studioOperationNames.map((operation): RuntimeRoute => {
    const definition = studioOperationDefinitions[operation];
    return {
      scope: "studio",
      operation,
      method: definition.http.method,
      path: definition.http.path,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema
    };
  })
];

const ROUTES_BY_PATH = new Map<string, readonly RuntimeRoute[]>();
for (const route of ROUTES) {
  ROUTES_BY_PATH.set(route.path, [...(ROUTES_BY_PATH.get(route.path) ?? []), route]);
}

class HttpBoundaryError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpBoundaryError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function header(request: RoutegoHttpRequest, name: string): string | undefined {
  return request.headers[name.toLowerCase()];
}

function safeIssues(error: { readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[] }) {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message
  }));
}

function jsonResponse(
  status: number,
  value: unknown,
  headers: Readonly<Record<string, string>> = {}
): RoutegoHttpResponse {
  return {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers
    },
    body: JSON.stringify(value)
  };
}

function boundaryErrorResponse(
  error: HttpBoundaryError,
  headers: Readonly<Record<string, string>> = {}
): RoutegoHttpResponse {
  return jsonResponse(
    error.status,
    redactDiagnostic({
      error: {
        code: error.code,
        safeMessage: error.message,
        ...(error.details === undefined ? {} : { details: error.details })
      }
    }),
    headers
  );
}

function parseContentLength(request: RoutegoHttpRequest): number | undefined {
  const value = header(request, "content-length");
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) {
    throw new HttpBoundaryError(400, "invalid_request", "Content-Length is invalid.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new HttpBoundaryError(400, "invalid_request", "Content-Length is invalid.");
  }
  return parsed;
}

async function readJsonBody(request: RoutegoHttpRequest, maximumBytes: number): Promise<unknown> {
  const contentType = header(request, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpBoundaryError(415, "invalid_request", "POST requests require application/json.");
  }
  const declaredLength = parseContentLength(request);
  if (declaredLength !== undefined && declaredLength > maximumBytes) {
    throw new HttpBoundaryError(413, "invalid_request", "The JSON request body is too large.");
  }
  if (request.body === undefined) {
    throw new HttpBoundaryError(400, "invalid_request", "A JSON request body is required.");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const encoder = new TextEncoder();
  for await (const chunk of request.body) {
    if (request.signal.aborted) {
      throw new HttpBoundaryError(499, "cancelled", "The request was cancelled.");
    }
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    total += bytes.byteLength;
    if (total > maximumBytes) {
      throw new HttpBoundaryError(413, "invalid_request", "The JSON request body is too large.");
    }
    chunks.push(bytes);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(merged);
  } catch {
    throw new HttpBoundaryError(400, "invalid_request", "The JSON request body must be valid UTF-8.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpBoundaryError(400, "invalid_request", "The JSON request body is malformed.");
  }
}

function decodeQueryPrimitive(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return value;
}

function readQuery(request: RoutegoHttpRequest, maximumBytes: number): Record<string, unknown> {
  if (Buffer.byteLength(request.url.search, "utf8") > maximumBytes) {
    throw new HttpBoundaryError(414, "invalid_request", "The query string is too large.");
  }
  const result: Record<string, unknown> = {};
  let count = 0;
  for (const [key, rawValue] of request.url.searchParams.entries()) {
    count += 1;
    if (count > 100) {
      throw new HttpBoundaryError(414, "invalid_request", "The query contains too many fields.");
    }
    const value = decodeQueryPrimitive(rawValue);
    const existing = result[key];
    result[key] = existing === undefined
      ? value
      : Array.isArray(existing)
        ? [...existing, value]
        : [existing, value];
  }
  return result;
}

function allowedOrigin(request: RoutegoHttpRequest, allowedOrigins: readonly string[]): string | undefined {
  if ((header(request, "cookie") ?? "").trim() !== "") return undefined;
  const origin = header(request, "origin");
  if (origin === undefined) return undefined;
  try {
    const normalized = normalizeLoopbackOrigin(origin);
    return allowedOrigins.map(normalizeLoopbackOrigin).includes(normalized) ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function validatePreflightHeaders(request: RoutegoHttpRequest): void {
  const requested = header(request, "access-control-request-headers");
  if (requested === undefined || requested.trim() === "") return;
  for (const name of requested.split(",").map((value) => value.trim().toLowerCase())) {
    if (!STANDARD_REQUEST_HEADERS.has(name)) {
      throw new HttpBoundaryError(403, "origin_rejected", "The requested CORS headers are not allowed.");
    }
  }
}

function withCors(
  response: RoutegoHttpResponse,
  corsHeaders: Readonly<Record<string, string>>,
  allowOrigin: string
): RoutegoHttpResponse {
  const extensionHeaders: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(response.headers ?? {})) {
    const name = rawName.toLowerCase();
    if (name === "access-control-allow-credentials") {
      throw new HttpBoundaryError(500, "internal_contract", "An extension returned an unsafe CORS policy.");
    }
    if (name === "set-cookie") {
      throw new HttpBoundaryError(500, "internal_contract", "An extension returned an unsafe cookie policy.");
    }
    if (name === "access-control-allow-origin" && value !== allowOrigin) {
      throw new HttpBoundaryError(500, "internal_contract", "An extension returned an unsafe CORS policy.");
    }
    if ((name === "access-control-allow-methods" || name === "access-control-allow-headers") && value.includes("*")) {
      throw new HttpBoundaryError(500, "internal_contract", "An extension returned an unsafe CORS policy.");
    }
    extensionHeaders[name] = value;
  }
  return {
    ...response,
    headers: { ...corsHeaders, ...extensionHeaders, "access-control-allow-origin": allowOrigin }
  };
}

async function callService(
  route: RuntimeRoute,
  service: RoutegoService,
  localService: LocalRoutegoService | undefined,
  input: unknown
): Promise<unknown> {
  const target: RoutegoService | LocalRoutegoService | undefined =
    route.scope === "public" ? (localService ?? service) : localService;
  if (target === undefined) {
    throw new HttpBoundaryError(503, "capability_unavailable", "The local Studio service is unavailable.");
  }
  const method = (target as unknown as Record<string, unknown>)[route.operation];
  if (typeof method !== "function") {
    throw new Error("The local service method is unavailable");
  }
  return (method as (this: unknown, value: unknown) => Promise<unknown>).call(target, input);
}

function preservesOmittedPublicControls(route: RuntimeRoute): boolean {
  return route.scope === "public" &&
    (route.operation === "generate" || route.operation === "edit" || route.operation === "batch");
}

export function createRoutegoHttpDispatcher(options: RoutegoHttpRuntimeOptions): RoutegoHttpDispatcher {
  const maximumJsonBodyBytes = options.maximumJsonBodyBytes ?? DEFAULT_MAXIMUM_JSON_BODY_BYTES;
  const maximumQueryBytes = options.maximumQueryBytes ?? DEFAULT_MAXIMUM_QUERY_BYTES;
  if (!Number.isSafeInteger(maximumJsonBodyBytes) || maximumJsonBodyBytes < 1) {
    throw new Error("maximumJsonBodyBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maximumQueryBytes) || maximumQueryBytes < 1) {
    throw new Error("maximumQueryBytes must be a positive safe integer");
  }
  if (options.expectedSessionToken.length === 0) {
    throw new Error("expectedSessionToken must not be empty");
  }
  if (options.allowedOrigins.length === 0) {
    throw new Error("allowedOrigins must contain at least one exact loopback origin");
  }
  const normalizedAllowedOrigins = options.allowedOrigins.map(normalizeLoopbackOrigin);

  const diagnose = async (value: unknown): Promise<void> => {
    if (options.logger === undefined) return;
    try {
      await options.logger(redactDiagnostic(value));
    } catch {
      // Diagnostic sinks cannot affect request handling.
    }
  };

  return {
    async dispatch(request): Promise<RoutegoHttpResponse> {
      const method = request.method.toUpperCase();
      const pathRoutes = ROUTES_BY_PATH.get(request.url.pathname) ?? [];

      if (method === "OPTIONS") {
        const origin = allowedOrigin(request, normalizedAllowedOrigins);
        if (origin === undefined) {
          return boundaryErrorResponse(
            new HttpBoundaryError(403, "origin_rejected", "The request origin is not allowed by the local service.")
          );
        }
        const corsHeaders = createLoopbackCorsHeaders(origin);
        try {
          validatePreflightHeaders(request);
          const requestedMethod = header(request, "access-control-request-method")?.toUpperCase();
          const registered = pathRoutes.some((route) => route.method === requestedMethod);
          if (registered) return { status: 204, headers: corsHeaders };
          if (options.extensionHandler !== undefined) {
            const extension = await options.extensionHandler(request, {
              preflight: true,
              allowOrigin: origin,
              corsHeaders
            });
            if (extension !== undefined) return withCors(extension, corsHeaders, origin);
          }
          return boundaryErrorResponse(
            new HttpBoundaryError(404, "not_found", "The requested local route was not found."),
            corsHeaders
          );
        } catch (error) {
          const boundary = error instanceof HttpBoundaryError
            ? error
            : new HttpBoundaryError(500, "internal_contract", "The CORS preflight failed safely.");
          await diagnose(error);
          return boundaryErrorResponse(boundary, corsHeaders);
        }
      }

      const originHeader = header(request, "origin");
      const tokenHeader = header(request, "x-routego-session");
      const cookieHeader = header(request, "cookie");
      const policyDecision = authorizeLoopbackRequest({
        allowedOrigins: normalizedAllowedOrigins,
        expectedToken: options.expectedSessionToken,
        ...(originHeader === undefined ? {} : { origin: originHeader }),
        ...(tokenHeader === undefined ? {} : { presentedToken: tokenHeader }),
        ...(cookieHeader === undefined ? {} : { cookieHeader })
      });
      if (!policyDecision.allowed) {
        return boundaryErrorResponse(
          new HttpBoundaryError(403, policyDecision.code, policyDecision.safeMessage)
        );
      }
      const corsHeaders = createLoopbackCorsHeaders(policyDecision.allowOrigin);

      const route = pathRoutes.find((candidate) => candidate.method === method);
      if (route === undefined) {
        try {
          if (pathRoutes.length > 0) {
            throw new HttpBoundaryError(405, "invalid_request", "The HTTP method is not allowed for this route.");
          }
          if (options.extensionHandler !== undefined) {
            const extension = await options.extensionHandler(request, {
              preflight: false,
              allowOrigin: policyDecision.allowOrigin,
              corsHeaders
            });
            if (extension !== undefined) {
              return withCors(extension, corsHeaders, policyDecision.allowOrigin);
            }
          }
          throw new HttpBoundaryError(404, "not_found", "The requested local route was not found.");
        } catch (error) {
          const boundary = error instanceof HttpBoundaryError
            ? error
            : new HttpBoundaryError(500, "internal_contract", "The extension route failed safely.");
          await diagnose(error);
          return boundaryErrorResponse(boundary, corsHeaders);
        }
      }

      try {
        if (route.method === "POST" && request.url.search !== "") {
          throw new HttpBoundaryError(400, "invalid_request", "POST operation inputs must use the JSON body only.");
        }
        const rawInput = route.method === "GET"
          ? readQuery(request, maximumQueryBytes)
          : await readJsonBody(request, maximumJsonBodyBytes);
        const parsedInput = route.inputSchema.safeParse(rawInput);
        if (!parsedInput.success) {
          throw new HttpBoundaryError(
            400,
            "invalid_request",
            "The request does not match the frozen Routego Image schema.",
            safeIssues(parsedInput.error)
          );
        }
        // The schema above validates the request. Generation and batch requests
        // still need their raw shape so the service can distinguish a caller's
        // explicit "auto" from a field omitted to use saved Studio defaults.
        const serviceInput = preservesOmittedPublicControls(route) ? rawInput : parsedInput.data;
        const output = await callService(route, options.service, options.localService, serviceInput);
        const parsedOutput = route.outputSchema.safeParse(output);
        if (!parsedOutput.success) {
          await diagnose({ code: "internal_contract", operation: route.operation, issues: parsedOutput.error.issues });
          throw new HttpBoundaryError(500, "internal_contract", "The local service returned an invalid result.");
        }
        return jsonResponse(200, parsedOutput.data, corsHeaders);
      } catch (error) {
        const boundary = error instanceof HttpBoundaryError
          ? error
          : new HttpBoundaryError(500, "internal_contract", "The local service request failed safely.");
        if (!(error instanceof HttpBoundaryError)) await diagnose(error);
        return boundaryErrorResponse(boundary, corsHeaders);
      }
    }
  };
}
