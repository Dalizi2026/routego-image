import { REDACTED_VALUE } from "@routego-image/foundation";

export type MockRelayFixture =
  | "single-endpoint-text"
  | "single-endpoint-image"
  | "single-endpoint-images"
  | "openai-images"
  | "openai-responses-json"
  | "openai-responses-sse";

export type MockRelayOutcome = "success" | "failure" | "partial-then-failure";

export interface MockRelayPaths {
  readonly singleEndpoint?: string;
  readonly imagesGenerations?: string;
  readonly imagesEdits?: string;
  readonly responses?: string;
}

export interface MockRelayOptions {
  readonly fixture?: MockRelayFixture;
  readonly outcome?: MockRelayOutcome;
  readonly paths?: MockRelayPaths;
}

export interface MockRelayObservation {
  readonly method: string;
  readonly pathname: string;
  readonly contentType?: string;
  readonly headers: Readonly<Record<string, "present" | "[REDACTED]">>;
  readonly bodyShape: unknown;
}

interface ParsedBody {
  readonly value: unknown;
  readonly shape: unknown;
}

const DEFAULT_PATHS = {
  singleEndpoint: "/v1/images/generations",
  imagesGenerations: "/v1/images/generations",
  imagesEdits: "/v1/images/edits",
  responses: "/v1/responses"
} as const;

const MOCK_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZVt8AAAAASUVORK5CYII=";

function normalizePath(value: string): string {
  if (!value.startsWith("/") || value.includes("?") || value.includes("#")) {
    throw new Error("Mock relay paths must be absolute pathnames without query strings or fragments");
  }
  return value.replace(/\/{2,}/gu, "/");
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message, type: "mock_relay_error" } }, status);
}

function describeHeaders(headers: Headers): Readonly<Record<string, "present" | "[REDACTED]">> {
  const output: Record<string, "present" | "[REDACTED]"> = {};
  const sensitive = new Set([
    "authorization",
    "cookie",
    "proxy-authorization",
    "set-cookie",
    "x-api-key",
    "x-routego-session"
  ]);
  for (const [name] of [...headers.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    output[name.toLowerCase()] = sensitive.has(name.toLowerCase()) ? REDACTED_VALUE : "present";
  }
  return output;
}

function describeValue(value: unknown): unknown {
  if (value === null) {
    return { type: "null" };
  }
  if (Array.isArray(value)) {
    return { type: "array", length: value.length, items: value.map(describeValue) };
  }
  if (typeof value === "string") {
    const dataUrl = value.match(/^data:image\/([a-z0-9.+-]+);base64,/iu);
    return dataUrl === null
      ? { type: "string", length: value.length }
      : { type: "image-data-url", mimeType: `image/${dataUrl[1]}`, length: value.length };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { type: typeof value };
  }
  if (typeof value === "object") {
    return {
      type: "object",
      fields: Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, describeValue(child)])
      )
    };
  }
  return { type: typeof value };
}

async function parseJsonBody(request: Request): Promise<ParsedBody> {
  const text = await request.text();
  try {
    const value: unknown = JSON.parse(text);
    return { value, shape: describeValue(value) };
  } catch {
    return {
      value: undefined,
      shape: { type: "invalid-json", byteLength: new TextEncoder().encode(text).byteLength }
    };
  }
}

async function parseMultipartBody(request: Request): Promise<ParsedBody> {
  try {
    const form = await request.formData();
    const entries: Array<Record<string, unknown>> = [];
    for (const [name, value] of form.entries()) {
      if (typeof value === "string") {
        entries.push({ name, value: describeValue(value) });
      } else {
        entries.push({
          name,
          value: {
            type: "file",
            mimeType: value.type || "application/octet-stream",
            byteLength: value.size
          }
        });
      }
    }
    return { value: form, shape: { type: "multipart", entries } };
  } catch {
    return { value: undefined, shape: { type: "invalid-multipart" } };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isImageDataUrl(value: unknown): value is string {
  return typeof value === "string" && /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+$/iu.test(value);
}

function imagesSuccess(): Response {
  return jsonResponse({
    created: 1_767_225_600,
    data: [{ b64_json: MOCK_IMAGE_BASE64, revised_prompt: "mock revised prompt" }]
  });
}

function responsesJson(outcome: MockRelayOutcome): Response {
  if (outcome === "failure") {
    return errorResponse(500, "mock_provider_failure", "The configured mock Responses call failed.");
  }
  const output = [
    {
      type: "image_generation_call",
      id: "mock-image-call-0",
      status: outcome === "partial-then-failure" ? "in_progress" : "completed",
      result: MOCK_IMAGE_BASE64
    }
  ];
  return jsonResponse({
    id: "mock-response-0",
    object: "response",
    status: outcome === "partial-then-failure" ? "failed" : "completed",
    output,
    ...(outcome === "partial-then-failure"
      ? { error: { code: "mock_stream_failure", message: "Mock failure after partial output." } }
      : {})
  });
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function responsesSse(outcome: MockRelayOutcome): Response {
  let body = sseEvent("response.created", {
    type: "response.created",
    response: { id: "mock-response-0", status: "in_progress" }
  });

  if (outcome !== "failure") {
    body += sseEvent("response.image_generation_call.partial_image", {
      type: "response.image_generation_call.partial_image",
      item_id: "mock-image-call-0",
      output_index: 0,
      partial_image_index: 0,
      partial_image_b64: MOCK_IMAGE_BASE64
    });
  }

  if (outcome === "success") {
    body += sseEvent("response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "image_generation_call",
        id: "mock-image-call-0",
        status: "completed",
        result: MOCK_IMAGE_BASE64
      }
    });
    body += sseEvent("response.completed", {
      type: "response.completed",
      response: { id: "mock-response-0", status: "completed" }
    });
  } else {
    body += sseEvent("error", {
      type: "error",
      error: {
        code: outcome === "failure" ? "mock_provider_failure" : "mock_partial_failure",
        message: "The configured mock Responses stream failed."
      }
    });
  }
  body += "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8"
    }
  });
}

export class MockRelay {
  readonly #fixture: MockRelayFixture;
  readonly #outcome: MockRelayOutcome;
  readonly #paths: Required<MockRelayPaths>;
  readonly #observations: MockRelayObservation[] = [];

  constructor(options: MockRelayOptions = {}) {
    this.#fixture = options.fixture ?? "single-endpoint-text";
    this.#outcome = options.outcome ?? "success";
    this.#paths = {
      singleEndpoint: normalizePath(options.paths?.singleEndpoint ?? DEFAULT_PATHS.singleEndpoint),
      imagesGenerations: normalizePath(
        options.paths?.imagesGenerations ?? DEFAULT_PATHS.imagesGenerations
      ),
      imagesEdits: normalizePath(options.paths?.imagesEdits ?? DEFAULT_PATHS.imagesEdits),
      responses: normalizePath(options.paths?.responses ?? DEFAULT_PATHS.responses)
    };
  }

  get observations(): readonly MockRelayObservation[] {
    return this.#observations.map((observation) => structuredClone(observation));
  }

  clearObservations(): void {
    this.#observations.length = 0;
  }

  async #observe(request: Request): Promise<ParsedBody> {
    const contentTypeHeader = request.headers.get("content-type") ?? undefined;
    const contentType = contentTypeHeader?.split(";", 1)[0]?.trim().toLowerCase();
    const parsed =
      request.method === "GET" || request.method === "HEAD"
        ? { value: undefined, shape: { type: "empty" } }
        : contentType === "application/json"
          ? await parseJsonBody(request.clone())
          : contentType === "multipart/form-data"
            ? await parseMultipartBody(request.clone())
            : {
                value: undefined,
                shape: {
                  type: "unparsed",
                  ...(contentType === undefined ? {} : { contentType })
                }
              };
    this.#observations.push({
      method: request.method,
      pathname: new URL(request.url).pathname,
      ...(contentType === undefined ? {} : { contentType }),
      headers: describeHeaders(request.headers),
      bodyShape: parsed.shape
    });
    return parsed;
  }

  async #singleEndpoint(request: Request, parsed: ParsedBody): Promise<Response> {
    if (request.method !== "POST") {
      return errorResponse(405, "method_not_allowed", "The mock endpoint accepts POST only.");
    }
    if (!isRecord(parsed.value)) {
      return errorResponse(400, "invalid_json", "The mock endpoint requires a JSON object.");
    }
    const image = parsed.value["image"];
    const images = parsed.value["images"];
    if (this.#fixture === "single-endpoint-text" && (image !== undefined || images !== undefined)) {
      return errorResponse(
        400,
        "unsupported_image_input",
        "This mock single endpoint is configured for text input only."
      );
    }
    if (this.#fixture === "single-endpoint-image") {
      if ((image !== undefined && !isImageDataUrl(image)) || images !== undefined) {
        return errorResponse(
          400,
          "unsupported_image_shape",
          "This mock endpoint accepts exactly one image data URL in the image field."
        );
      }
    }
    if (this.#fixture === "single-endpoint-images") {
      const validSingle = image === undefined || isImageDataUrl(image);
      const validMultiple =
        images === undefined ||
        (Array.isArray(images) && images.length > 0 && images.every(isImageDataUrl));
      if (!validSingle || !validMultiple) {
        return errorResponse(
          400,
          "unsupported_image_shape",
          "This mock endpoint accepts image or images data URL fields."
        );
      }
    }
    if (this.#outcome !== "success") {
      return errorResponse(500, "mock_provider_failure", "The configured mock request failed.");
    }
    return imagesSuccess();
  }

  async #images(request: Request, pathname: string, parsed: ParsedBody): Promise<Response> {
    if (request.method !== "POST") {
      return errorResponse(405, "method_not_allowed", "The mock Images endpoint accepts POST only.");
    }
    if (pathname === this.#paths.imagesGenerations) {
      if (!isRecord(parsed.value)) {
        return errorResponse(400, "invalid_json", "Images generations requires JSON.");
      }
    } else if (pathname === this.#paths.imagesEdits) {
      if (!(parsed.value instanceof FormData)) {
        return errorResponse(400, "invalid_multipart", "Images edits requires multipart form data.");
      }
      const orderedEntries = [...parsed.value.entries()];
      const imageEntries = orderedEntries.filter(
        ([name]) => name === "image" || name === "image[]"
      );
      const maskEntries = orderedEntries.filter(([name]) => name === "mask");
      if (imageEntries.length === 0) {
        return errorResponse(400, "image_required", "Images edits requires at least one image field.");
      }
      if (imageEntries.some(([, value]) => typeof value === "string")) {
        return errorResponse(400, "invalid_image_part", "Images edits image fields must be file parts.");
      }
      if (maskEntries.length > 1) {
        return errorResponse(400, "multiple_masks", "Images edits accepts at most one mask field.");
      }
      if (maskEntries.some(([, value]) => typeof value === "string")) {
        return errorResponse(400, "invalid_mask_part", "The Images edits mask must be a file part.");
      }
      if (maskEntries.length === 1) {
        const firstImageIndex = orderedEntries.findIndex(
          ([name]) => name === "image" || name === "image[]"
        );
        const maskIndex = orderedEntries.findIndex(([name]) => name === "mask");
        if (maskIndex < firstImageIndex) {
          return errorResponse(
            400,
            "mask_before_image",
            "The Images edits mask must follow the first image field."
          );
        }
      }
    }
    if (this.#outcome !== "success") {
      return errorResponse(500, "mock_provider_failure", "The configured mock Images request failed.");
    }
    return imagesSuccess();
  }

  async handle(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    const parsed = await this.#observe(request);

    if (
      (this.#fixture === "single-endpoint-text" ||
        this.#fixture === "single-endpoint-image" ||
        this.#fixture === "single-endpoint-images") &&
      pathname === this.#paths.singleEndpoint
    ) {
      return this.#singleEndpoint(request, parsed);
    }

    if (
      this.#fixture === "openai-images" &&
      (pathname === this.#paths.imagesGenerations || pathname === this.#paths.imagesEdits)
    ) {
      return this.#images(request, pathname, parsed);
    }

    if (
      (this.#fixture === "openai-responses-json" ||
        this.#fixture === "openai-responses-sse") &&
      pathname === this.#paths.responses
    ) {
      if (request.method !== "POST") {
        return errorResponse(405, "method_not_allowed", "The mock Responses endpoint accepts POST only.");
      }
      if (!isRecord(parsed.value)) {
        return errorResponse(400, "invalid_json", "Responses requires a JSON object.");
      }
      return this.#fixture === "openai-responses-sse"
        ? responsesSse(this.#outcome)
        : responsesJson(this.#outcome);
    }

    return errorResponse(404, "mock_route_unavailable", "The requested mock relay path is not configured.");
  }
}

export function createMockRelay(options: MockRelayOptions = {}): MockRelay {
  return new MockRelay(options);
}
