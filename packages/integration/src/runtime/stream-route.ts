import {
  studioImageOperationEventSchema,
  studioImageOperationRequestSchema,
  type StudioImageOperationEvent,
  type StudioImageOperationRequest
} from "@routego-image/contracts";
import {
  createStudioEventStreamResponse,
  type RoutegoHttpExtensionHandler,
  type RoutegoHttpRequest,
  type RoutegoHttpResponse
} from "@routego-image/creation";

export const STUDIO_CREATION_STREAM_PATH = "/api/v1/studio/creation/stream" as const;

const DEFAULT_MAXIMUM_JSON_BODY_BYTES = 1_048_576;

export interface StudioCreationStreamContext {
  readonly signal: AbortSignal;
}

export type StudioCreationStreamExecutor = (
  input: StudioImageOperationRequest,
  context: StudioCreationStreamContext
) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;

export interface StudioCreationStreamRouteOptions {
  readonly execute: StudioCreationStreamExecutor;
  readonly maximumJsonBodyBytes?: number;
}

class StreamRouteError extends Error {
  readonly status: number;
  readonly code: "cancelled" | "internal_contract" | "invalid_request";

  constructor(
    status: number,
    code: "cancelled" | "internal_contract" | "invalid_request",
    message: string
  ) {
    super(message);
    this.name = "StreamRouteError";
    this.status = status;
    this.code = code;
  }
}

function jsonErrorResponse(error: StreamRouteError): RoutegoHttpResponse {
  return {
    status: error.status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      error: {
        code: error.code,
        safeMessage: error.message
      }
    })
  };
}

function header(request: RoutegoHttpRequest, name: string): string | undefined {
  return request.headers[name.toLowerCase()];
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function containsSensitiveString(value: string): boolean {
  return /(?:authorization\s*:\s*(?:bearer\s+)?\S+|bearer\s+[A-Za-z0-9._~+/=-]{8,}|api[_ -]?key\s*[:=]\s*\S{8,}|data:image\/|base64,[A-Za-z0-9+/=]{16,}|file:\/\/|[A-Za-z]:\\\\|\bsk-[A-Za-z0-9]{16,}\b)/iu.test(value) ||
    /(?:^|[\s"'`])\/(?:Users|home|private|tmp|var|etc)(?:[\\/\s"'`]|$)/u.test(value);
}

function containsSensitiveValue(value: unknown): boolean {
  if (typeof value === "string") return containsSensitiveString(value);
  if (Array.isArray(value)) return value.some(containsSensitiveValue);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(containsSensitiveValue);
  }
  return false;
}

function containsSensitiveEventData(event: StudioImageOperationEvent): boolean {
  if (event.type === "started") {
    return containsSensitiveValue({ ...event, requestedParams: undefined });
  }
  if (event.type === "completed") {
    return containsSensitiveValue({
      ...event,
      result: {
        ...event.result,
        requestedParams: undefined,
        effectiveParams: undefined
      }
    });
  }
  return containsSensitiveValue(event);
}

async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
  message: string
): Promise<IteratorResult<T>> {
  if (signal.aborted) throw new StreamRouteError(499, "cancelled", message);
  return await new Promise<IteratorResult<T>>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => finish(() => reject(new StreamRouteError(499, "cancelled", message)));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(iterator.next()).then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error))
    );
  });
}

async function closeIterator(iterator: AsyncIterator<unknown>): Promise<void> {
  if (iterator.return === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(iterator.return()).then(() => undefined, () => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1_000);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parseContentLength(request: RoutegoHttpRequest): number | undefined {
  const value = header(request, "content-length");
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) {
    throw new StreamRouteError(400, "invalid_request", "Content-Length is invalid.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new StreamRouteError(400, "invalid_request", "Content-Length is invalid.");
  }
  return parsed;
}

async function readJsonBody(
  request: RoutegoHttpRequest,
  maximumBytes: number
): Promise<unknown> {
  const contentType = header(request, "content-type")?.trim().toLowerCase();
  if (contentType === undefined ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/u.test(contentType)) {
    throw new StreamRouteError(415, "invalid_request", "The stream route requires JSON input.");
  }
  const declaredLength = parseContentLength(request);
  if (declaredLength !== undefined && declaredLength > maximumBytes) {
    throw new StreamRouteError(413, "invalid_request", "The stream request body is too large.");
  }
  if (request.body === undefined) {
    throw new StreamRouteError(400, "invalid_request", "A JSON request body is required.");
  }

  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const bodyIterator = request.body[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await nextWithAbort(bodyIterator, request.signal, "The stream request was cancelled.");
      if (next.done) break;
      const chunk = next.value;
      const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
      total += bytes.byteLength;
      if (total > maximumBytes) {
        throw new StreamRouteError(413, "invalid_request", "The stream request body is too large.");
      }
      chunks.push(bytes);
    }
  } finally {
    await closeIterator(bodyIterator);
  }
  if (declaredLength !== undefined && declaredLength !== total) {
    throw new StreamRouteError(400, "invalid_request", "Content-Length does not match the request body.");
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
    throw new StreamRouteError(400, "invalid_request", "The stream request must use UTF-8.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new StreamRouteError(400, "invalid_request", "The stream request JSON is malformed.");
  }
}

function assertAsyncIterable(value: unknown): asserts value is AsyncIterable<unknown> {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null ||
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function"
  ) {
    throw new StreamRouteError(
      500,
      "internal_contract",
      "The stream service did not provide an event channel."
    );
  }
}

function streamContractError(message: string): StreamRouteError {
  return new StreamRouteError(500, "internal_contract", message);
}

async function* validateEventStream(
  source: AsyncIterable<unknown>,
  operationController: AbortController,
  requestSignal: AbortSignal,
  removeRequestAbortListener: () => void,
  expectedInput: StudioImageOperationRequest
): AsyncGenerator<StudioImageOperationEvent> {
  const iterator = source[Symbol.asyncIterator]();
  let started = false;
  let requestId: string | undefined;
  let lastSequence = -1;

  try {
    while (true) {
      const next = await nextWithAbort(iterator, requestSignal, "The Studio stream request was cancelled.");
      if (next.done) {
        throw streamContractError("The Studio stream ended before a terminal event.");
      }

      const parsed = studioImageOperationEventSchema.safeParse(next.value);
      if (!parsed.success) {
        throw streamContractError("The Studio stream service emitted an invalid event.");
      }
      const event = parsed.data;

      if (!started) {
        if (event.type !== "started") {
          throw streamContractError("The first Studio stream event must be started.");
        }
        started = true;
        requestId = event.requestId;
        if (!sameJson(event.requestedParams, expectedInput)) {
          throw streamContractError("The started Studio stream input does not match the HTTP request.");
        }
      } else if (event.type === "started") {
        throw streamContractError("The Studio stream may contain only one started event.");
      }

      if (event.requestId !== requestId) {
        throw streamContractError("Studio stream request identifiers must remain consistent.");
      }
      if (event.sequence <= lastSequence) {
        throw streamContractError("Studio stream sequence numbers must increase monotonically.");
      }
      lastSequence = event.sequence;

      if (containsSensitiveEventData(event)) {
        throw streamContractError("The Studio stream contained unsafe diagnostic data.");
      }

      if (event.type === "completed" && event.result.requestId !== requestId) {
        throw streamContractError("The completed result must use the Studio stream request ID.");
      }
      if (event.type === "completed" && !sameJson(event.result.requestedParams, expectedInput)) {
        throw streamContractError("The completed Studio result input does not match the HTTP request.");
      }

      if (event.type === "completed" || event.type === "failed") {
        const afterTerminal = await nextWithAbort(iterator, requestSignal, "The Studio stream request was cancelled.");
        if (!afterTerminal.done) {
          throw streamContractError("The Studio stream emitted data after its terminal event.");
        }
        yield event;
        return;
      }

      yield event;
    }
  } finally {
    removeRequestAbortListener();
    if (!operationController.signal.aborted) operationController.abort();
    await closeIterator(iterator);
  }
}

export function createStudioCreationStreamRoute(
  options: StudioCreationStreamRouteOptions
): RoutegoHttpExtensionHandler {
  const maximumJsonBodyBytes = options.maximumJsonBodyBytes ?? DEFAULT_MAXIMUM_JSON_BODY_BYTES;
  if (!Number.isSafeInteger(maximumJsonBodyBytes) || maximumJsonBodyBytes < 1) {
    throw new Error("maximumJsonBodyBytes must be a positive safe integer");
  }

  return async (request, context): Promise<RoutegoHttpResponse | undefined> => {
    if (request.url.pathname !== STUDIO_CREATION_STREAM_PATH) return undefined;

    if (request.url.search !== "") {
      return jsonErrorResponse(
        new StreamRouteError(400, "invalid_request", "Stream inputs must use the JSON body only.")
      );
    }

    if (context.preflight) {
      if (header(request, "access-control-request-method")?.trim().toUpperCase() !== "POST") {
        return jsonErrorResponse(
          new StreamRouteError(405, "invalid_request", "The Studio stream preflight requires POST.")
        );
      }
      return {
        status: 204,
        headers: {
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type, x-routego-session"
        }
      };
    }

    if (request.method.toUpperCase() !== "POST") {
      return jsonErrorResponse(
        new StreamRouteError(405, "invalid_request", "The Studio stream route accepts POST only.")
      );
    }
    try {
      const rawInput = await readJsonBody(request, maximumJsonBodyBytes);
      const parsedInput = studioImageOperationRequestSchema.safeParse(rawInput);
      if (!parsedInput.success) {
        throw new StreamRouteError(
          400,
          "invalid_request",
          "The request does not match the frozen Studio image operation schema."
        );
      }

      const operationController = new AbortController();
      const abortOperation = (): void => operationController.abort();
      if (request.signal.aborted) abortOperation();
      else request.signal.addEventListener("abort", abortOperation, { once: true });
      const removeRequestAbortListener = (): void => {
        request.signal.removeEventListener("abort", abortOperation);
      };

      let source: AsyncIterable<unknown>;
      try {
        source = await options.execute(parsedInput.data, { signal: operationController.signal });
        assertAsyncIterable(source);
      } catch (error) {
        removeRequestAbortListener();
        operationController.abort();
        if (error instanceof StreamRouteError) throw error;
        throw new StreamRouteError(
          500,
          "internal_contract",
          "The Studio stream service failed before opening its event channel."
        );
      }

      return createStudioEventStreamResponse(
        validateEventStream(
          source,
          operationController,
          request.signal,
          removeRequestAbortListener,
          parsedInput.data
        )
      );
    } catch (error) {
      return jsonErrorResponse(
        error instanceof StreamRouteError
          ? error
          : new StreamRouteError(500, "internal_contract", "The Studio stream route failed safely.")
      );
    }
  };
}
