import {
  relativeBrowserResourceUrlSchema,
  relativeUploadUrlSchema,
  routegoOperationDefinitions,
  studioOperationDefinitions,
  studioOperationNames,
  type LocalRoutegoService,
  type RoutegoManageLibraryInput,
  type StudioOperation
} from "@routego-image/contracts";

import { STUDIO_SESSION_HEADER } from "../api/session";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
  0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00,
  0xb5, 0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63,
  0xfc, 0xff, 0x1f, 0x00, 0x02, 0xeb, 0x01, 0xf5, 0x8f, 0x59, 0x56, 0xdf, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
]);
const ZIP_BYTES = new Uint8Array(256);
ZIP_BYTES.set([0x50, 0x4b, 0x05, 0x06]);

type GatewayOperation = "status" | "manageLibrary" | StudioOperation;
type StudioManageLibraryInput = Extract<
  RoutegoManageLibraryInput,
  { readonly action: "create-folder" | "rename-folder" }
>;

type OperationDefinition = {
  readonly http: { readonly method: "GET" | "POST"; readonly path: string };
  readonly inputSchema: { parse(value: unknown): unknown };
  readonly outputSchema: { parse(value: unknown): unknown };
};

export interface StudioMockHandlerOptions {
  readonly service: LocalRoutegoService;
  readonly sessionToken: string;
}

export type StudioMockHandler = (request: Request) => Promise<Response | undefined>;

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

function safeError(status: number, code: string, safeMessage: string): Response {
  return json({ error: { code, safeMessage } }, status);
}

function operationDefinition(operation: GatewayOperation): OperationDefinition {
  if (operation === "status") return routegoOperationDefinitions.status;
  return operation === "manageLibrary"
    ? routegoOperationDefinitions.manageLibrary
    : studioOperationDefinitions[operation];
}

function findOperation(pathname: string): GatewayOperation | undefined {
  if (routegoOperationDefinitions.status.http.path === pathname) {
    return "status";
  }
  if (routegoOperationDefinitions.manageLibrary.http.path === pathname) {
    return "manageLibrary";
  }
  return studioOperationNames.find(
    (operation) => studioOperationDefinitions[operation].http.path === pathname
  );
}

function isAllowedManageLibraryInput(value: unknown): value is StudioManageLibraryInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const action = (value as { readonly action?: unknown }).action;
  return action === "create-folder" || action === "rename-folder";
}

function decodeQuery(url: URL): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [name, encoded] of url.searchParams) {
    try {
      output[name] = JSON.parse(encoded) as unknown;
    } catch {
      output[name] = encoded;
    }
  }
  return output;
}

async function requestInput(request: Request, method: "GET" | "POST"): Promise<unknown> {
  if (method === "GET") {
    return decodeQuery(new URL(request.url));
  }
  if ((request.headers.get("content-type") ?? "").split(";", 1)[0] !== "application/json") {
    throw new Error("invalid-content-type");
  }
  return request.json();
}

function serviceFailure(error: unknown): Response {
  if (error !== null && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const code = typeof record["code"] === "string" ? record["code"] : "mock_service_error";
    const safeMessage =
      typeof record["safeMessage"] === "string"
        ? record["safeMessage"].slice(0, 1_000)
        : "The deterministic mock service could not complete this request.";
    const status =
      typeof record["httpStatus"] === "number"
        ? record["httpStatus"]
        : code === "not_found"
          ? 404
          : code === "conflict"
            ? 409
            : 503;
    return safeError(status, code, safeMessage);
  }
  return safeError(500, "mock_service_error", "The deterministic mock service failed safely.");
}

async function dispatchOperation(
  service: LocalRoutegoService,
  operation: GatewayOperation,
  request: Request
): Promise<Response> {
  const definition = operationDefinition(operation);
  if (request.method !== definition.http.method) {
    return safeError(405, "method_not_allowed", "This local operation does not accept that method.");
  }

  let input: unknown;
  try {
    input = definition.inputSchema.parse(await requestInput(request, definition.http.method));
  } catch {
    return safeError(400, "invalid_input", "The request did not match the frozen local contract.");
  }
  if (operation === "manageLibrary" && !isAllowedManageLibraryInput(input)) {
    return safeError(
      400,
      "invalid_input",
      "Studio permits only folder creation and rename through the public Library bridge."
    );
  }

  let output: unknown;
  try {
    const method = service[operation] as (value: unknown) => Promise<unknown>;
    output = await method.call(service, input);
  } catch (error) {
    return serviceFailure(error);
  }

  try {
    const parsedOutput = definition.outputSchema.parse(output);
    if (
      operation === "manageLibrary" &&
      (parsedOutput as { readonly action?: unknown }).action !==
        (input as StudioManageLibraryInput).action
    ) {
      throw new Error("manage-library-action-mismatch");
    }
    return json(parsedOutput);
  } catch {
    return safeError(
      500,
      "invalid_output",
      "The deterministic mock returned an invalid contract result."
    );
  }
}

async function handleUpload(service: LocalRoutegoService, request: Request, pathname: string) {
  if (request.method !== "PUT") {
    return safeError(405, "method_not_allowed", "Binary upload routes accept PUT only.");
  }
  try {
    relativeUploadUrlSchema.parse(pathname);
  } catch {
    return safeError(404, "not_found", "The protected upload route was not found.");
  }
  const uploadResourceId = decodeURIComponent(pathname.split("/").at(-2) ?? "");
  const status = await service.getUploadResourceStatus({ uploadResourceId });
  if (status.status !== "succeeded" || status.resource === undefined) {
    return safeError(
      status.error?.httpStatus ?? 404,
      status.error?.code ?? "not_found",
      status.error?.safeMessage ?? "The protected upload resource was not found."
    );
  }
  const resource = status.resource;
  const contentType = (request.headers.get("content-type") ?? "").split(";", 1)[0] ?? "";
  const allowedMimeTypes: readonly string[] = resource.binaryUpload.allowedMimeTypes;
  if (
    resource.binaryUpload.relativeUrl !== pathname ||
    !allowedMimeTypes.includes(contentType)
  ) {
    return safeError(415, "upload_invalid_type", "The binary upload MIME type is not allowed.");
  }
  const content = await request.arrayBuffer();
  if (
    content.byteLength !== resource.declaredByteLength ||
    content.byteLength > resource.binaryUpload.maxBytes
  ) {
    return safeError(413, "upload_oversize", "The binary upload size did not match its reservation.");
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

function handleProtectedResource(request: Request, pathname: string): Response {
  if (request.method !== "GET") {
    return safeError(405, "method_not_allowed", "Protected resources accept GET only.");
  }
  try {
    relativeBrowserResourceUrlSchema.parse(pathname);
  } catch {
    return safeError(404, "not_found", "The protected resource was not found.");
  }
  const isZip = decodeURIComponent(pathname.split("/").at(-1) ?? "").startsWith("mock-export:");
  const bytes = isZip ? ZIP_BYTES : PNG_BYTES;
  return new Response(bytes.slice().buffer, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-length": String(bytes.byteLength),
      "content-type": isZip ? "application/zip" : "image/png"
    }
  });
}

export function createStudioMockHandler(options: StudioMockHandlerOptions): StudioMockHandler {
  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/v1/")) {
      return undefined;
    }
    if (request.headers.get(STUDIO_SESSION_HEADER) !== options.sessionToken) {
      return safeError(401, "session_invalid", "The local mock session is missing or invalid.");
    }

    const operation = findOperation(url.pathname);
    if (operation !== undefined) {
      return dispatchOperation(options.service, operation, request);
    }
    if (/^\/api\/v1\/uploads\/[^/]+\/content$/u.test(url.pathname)) {
      return handleUpload(options.service, request, url.pathname);
    }
    if (
      url.pathname.startsWith("/api/v1/library/resources/") ||
      url.pathname.startsWith("/api/v1/resources/")
    ) {
      if (url.search !== "") {
        return safeError(400, "unsafe_resource", "Protected resources do not accept query data.");
      }
      return handleProtectedResource(request, url.pathname);
    }
    return safeError(404, "not_found", "The requested local mock route is not available.");
  };
}
