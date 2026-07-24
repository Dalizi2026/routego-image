import {
  relativeBrowserResourceUrlSchema,
  relativeUploadUrlSchema,
  routegoOperationDefinitions,
  studioImageOperationEventSchema,
  studioImageOperationRequestSchema,
  studioImageOperationResultSchema,
  studioOperationDefinitions,
  studioOperationNames,
  type LocalRoutegoService,
  type RoutegoManageLibraryInput,
  type StudioImageArtifact,
  type StudioImageOperationEvent,
  type StudioImageOperationRequest,
  type StudioImageOperationResult,
  type StudioOperation
} from "@routego-image/contracts";

import { STUDIO_SESSION_HEADER } from "../api/session";
import { STUDIO_CREATION_STREAM_PATH } from "../api/sse";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
  0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00,
  0xb5, 0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63,
  0xfc, 0xff, 0x1f, 0x00, 0x02, 0xeb, 0x01, 0xf5, 0x8f, 0x59, 0x56, 0xdf, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
]);
const ZIP_BYTES = new Uint8Array(256);
ZIP_BYTES.set([0x50, 0x4b, 0x05, 0x06]);

const STREAM_TIMESTAMP = "2026-01-01T00:00:00.000Z";
const STREAM_FULL_EXPIRY = "2026-01-01T00:05:00.000Z";
const STREAM_NEAR_EXPIRY = "2026-01-01T00:00:30.000Z";
const STREAM_FIXTURE_PREFIX = "mock-stream:";

type MockStreamFixture =
  | "completed"
  | "failed"
  | "full-expiry"
  | "near-expiry"
  | "missing-started"
  | "duplicate-started"
  | "late-started"
  | "request-id-drift"
  | "invalid-sequence"
  | "invalid-schema"
  | "sentinel"
  | "missing-terminal"
  | "duplicate-terminal"
  | "post-terminal"
  | "eof-before-terminal"
  | "oversize"
  | "disconnect";

const MOCK_STREAM_FIXTURES = new Set<MockStreamFixture>([
  "completed",
  "failed",
  "full-expiry",
  "near-expiry",
  "missing-started",
  "duplicate-started",
  "late-started",
  "request-id-drift",
  "invalid-sequence",
  "invalid-schema",
  "sentinel",
  "missing-terminal",
  "duplicate-terminal",
  "post-terminal",
  "eof-before-terminal",
  "oversize",
  "disconnect"
]);

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
  readonly onStreamCancel?: (fixture: MockStreamFixture) => void;
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

function mockStreamFixture(input: StudioImageOperationRequest): MockStreamFixture {
  if (!input.prompt.startsWith(STREAM_FIXTURE_PREFIX)) return "completed";
  const candidate = input.prompt.slice(STREAM_FIXTURE_PREFIX.length) as MockStreamFixture;
  return MOCK_STREAM_FIXTURES.has(candidate) ? candidate : "completed";
}

function streamExpiry(fixture: MockStreamFixture): string {
  return fixture === "near-expiry" ? STREAM_NEAR_EXPIRY : STREAM_FULL_EXPIRY;
}

function withResourceExpiry(
  result: StudioImageOperationResult,
  expiresAt: string
): StudioImageOperationResult {
  const updateArtifact = (artifact: StudioImageArtifact): StudioImageArtifact => ({
    ...artifact,
    resource: { ...artifact.resource, expiresAt }
  });
  return studioImageOperationResultSchema.parse({
    ...result,
    finalArtifacts: result.finalArtifacts.map(updateArtifact),
    partialArtifacts: result.partialArtifacts.map(updateArtifact)
  });
}

function partialArtifact(
  requestId: string,
  saveToLibrary: boolean,
  expiresAt: string
): StudioImageArtifact {
  const artifactId = `${requestId}-stream-partial`;
  const resourceId = `${requestId}-stream-partial-resource`;
  return {
    artifactId,
    ...(saveToLibrary ? { assetId: `${requestId}-stream-asset` } : {}),
    slot: 0,
    phase: "partial",
    resource: {
      resourceId,
      relativeUrl: `/api/v1/resources/${resourceId}`,
      requiresSession: true,
      mimeType: "image/png",
      byteLength: PNG_BYTES.byteLength,
      width: 1,
      height: 1,
      etag: `${resourceId}-etag`,
      expiresAt
    },
    createdAt: STREAM_TIMESTAMP
  };
}

function eventRecord(event: StudioImageOperationEvent): string {
  return `id: ${event.requestId}:${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function streamChunks(records: readonly string[]): Uint8Array[] {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const record of records) {
    const bytes = encoder.encode(record);
    const targetChunks = bytes.byteLength > 65_536 ? 24 : 3;
    const size = Math.max(1, Math.ceil(bytes.byteLength / targetChunks));
    for (let offset = 0; offset < bytes.byteLength; offset += size) {
      chunks.push(bytes.slice(offset, Math.min(offset + size, bytes.byteLength)));
    }
  }
  return chunks;
}

function chunkedStream(
  chunks: readonly Uint8Array[],
  keepOpen: boolean,
  onCancel: () => void
): ReadableStream<Uint8Array> {
  let index = 0;
  let cancelled = false;
  let releasePendingPull: (() => void) | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        if (cancelled) return;
        controller.enqueue(chunks[index++]!);
        if (index === chunks.length && !keepOpen) controller.close();
        return;
      }
      if (!keepOpen) {
        controller.close();
        return;
      }
      await new Promise<void>((resolve) => {
        releasePendingPull = resolve;
      });
    },
    cancel() {
      cancelled = true;
      releasePendingPull?.();
      onCancel();
    }
  });
}

function streamPlan(
  fixture: MockStreamFixture,
  input: StudioImageOperationRequest,
  result: StudioImageOperationResult
): { readonly records: readonly string[]; readonly keepOpen: boolean } {
  const requestId = result.requestId;
  const expiresAt = streamExpiry(fixture);
  const partial = partialArtifact(requestId, input.saveToLibrary, expiresAt);
  const started = (sequence = 0, id = requestId) =>
    studioImageOperationEventSchema.parse({
      type: "started",
      requestId: id,
      sequence,
      occurredAt: STREAM_TIMESTAMP,
      requestedParams: input
    });
  const partialEvent = (sequence = 1, id = requestId) =>
    studioImageOperationEventSchema.parse({
      type: "partial",
      requestId: id,
      sequence,
      occurredAt: STREAM_TIMESTAMP,
      artifact: partial,
      receivedAnyOutput: true,
      mayHaveBilled: true
    });
  const completed = (sequence = 2) =>
    studioImageOperationEventSchema.parse({
      type: "completed",
      requestId,
      sequence,
      occurredAt: STREAM_TIMESTAMP,
      result: withResourceExpiry(result, expiresAt)
    });
  const error = {
    code: "invalid_response",
    category: "protocol",
    stage: "stream",
    safeMessage: "The deterministic Studio stream ended after a partial image.",
    retryDisposition: "never",
    partialArtifacts: [partial],
    receivedAnyOutput: true,
    mayHaveBilled: true
  } as const;
  const failed = (sequence = 2) =>
    studioImageOperationEventSchema.parse({
      type: "failed",
      requestId,
      sequence,
      occurredAt: STREAM_TIMESTAMP,
      error,
      receivedAnyOutput: true,
      mayHaveBilled: true
    });

  const records = (...events: StudioImageOperationEvent[]) => events.map(eventRecord);
  switch (fixture) {
    case "failed":
      return { records: records(started(), partialEvent(), failed()), keepOpen: false };
    case "full-expiry":
    case "near-expiry":
    case "completed":
      return { records: records(started(), partialEvent(), completed()), keepOpen: false };
    case "missing-started":
      return { records: records(partialEvent(), completed()), keepOpen: false };
    case "duplicate-started":
      return { records: records(started(), started(1), completed(2)), keepOpen: false };
    case "late-started":
      return {
        records: records(started(), partialEvent(), started(2), completed(3)),
        keepOpen: false
      };
    case "request-id-drift":
      return {
        records: records(started(), partialEvent(1, `${requestId}-drift`)),
        keepOpen: false
      };
    case "invalid-sequence":
      return { records: records(started(), partialEvent(0)), keepOpen: false };
    case "invalid-schema":
      return {
        records: [
          eventRecord(started()),
          `id: ${requestId}:1\nevent: partial\ndata: ${JSON.stringify({
            type: "partial",
            requestId,
            sequence: 1
          })}\n\n`
        ],
        keepOpen: false
      };
    case "sentinel":
      return { records: [eventRecord(started()), "data: [DONE]\n\n"], keepOpen: false };
    case "missing-terminal":
      return { records: records(started()), keepOpen: false };
    case "duplicate-terminal":
      return {
        records: records(started(), partialEvent(), completed(), completed(3)),
        keepOpen: false
      };
    case "post-terminal":
      return { records: records(started(), completed(1), partialEvent(2)), keepOpen: false };
    case "eof-before-terminal":
      return { records: records(started(), partialEvent()), keepOpen: false };
    case "oversize":
      return {
        records: [eventRecord(started()), `data: ${"x".repeat(262_145)}\n\n`],
        keepOpen: false
      };
    case "disconnect":
      return { records: records(started(), partialEvent()), keepOpen: true };
  }
}

async function handleStudioCreationStream(
  options: StudioMockHandlerOptions,
  request: Request
): Promise<Response> {
  if (request.method !== "POST") {
    return safeError(405, "method_not_allowed", "Studio image streams accept POST only.");
  }
  if ((request.headers.get("content-type") ?? "").split(";", 1)[0] !== "application/json") {
    return safeError(415, "invalid_input", "Studio image streams require JSON input.");
  }
  if ((request.headers.get("accept") ?? "").toLowerCase() !== "text/event-stream; charset=utf-8") {
    return safeError(406, "invalid_input", "Studio image streams require the frozen SSE media type.");
  }

  let input: StudioImageOperationRequest;
  try {
    input = studioImageOperationRequestSchema.parse(await request.json());
  } catch {
    return safeError(400, "invalid_input", "The stream request did not match the frozen contract.");
  }
  const fixture = mockStreamFixture(input);
  let result: StudioImageOperationResult;
  try {
    result = studioImageOperationResultSchema.parse(await options.service.studioGenerate(input));
  } catch (error) {
    return serviceFailure(error);
  }
  if (result.status === "failed") {
    return safeError(500, "invalid_output", "The deterministic stream requires a valid base result.");
  }

  const plan = streamPlan(fixture, input, result);
  return new Response(
    chunkedStream(streamChunks(plan.records), plan.keepOpen, () => {
      options.onStreamCancel?.(fixture);
    }),
    {
      status: 200,
      headers: {
        "cache-control": "no-cache, no-store",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
        "x-routego-mock-stream-fixture": fixture
      }
    }
  );
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
    if (url.pathname === STUDIO_CREATION_STREAM_PATH) {
      if (url.search !== "") {
        return safeError(400, "invalid_input", "Studio image streams do not accept query data.");
      }
      return handleStudioCreationStream(options, request);
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
