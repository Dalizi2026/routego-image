import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { lstat, open, type FileHandle } from "node:fs/promises";

import {
  copyGenerationInfoInputSchema,
  identifierSchema,
  type LocalRoutegoService,
  type StudioImageOperationRequest
} from "@routego-image/contracts";
import type {
  RoutegoHttpExtensionHandler,
  RoutegoHttpRequest,
  RoutegoHttpResponse
} from "@routego-image/creation";
import type {
  ResolvedBrowserResource,
  RoutegoLibraryService
} from "@routego-image/library";

import type {
  EphemeralImageResourceRegistry,
  OpenEphemeralImageResource
} from "./ephemeral-resources";
import type {
  StudioSessionDescriptor,
  StudioSessionManager
} from "./sessions";
import {
  STUDIO_CREATION_STREAM_PATH,
  createStudioCreationStreamRoute
} from "./stream-route";
import { selectNativeLibraryDirectory } from "./native-directory-picker";

export const UPLOAD_CONTENT_ROUTE_PATTERN =
  /^\/api\/v1\/uploads\/([A-Za-z0-9][A-Za-z0-9._:-]*)\/content$/u;
export const LIBRARY_RESOURCE_ROUTE_PATTERN =
  /^\/api\/v1\/library\/resources\/([A-Za-z0-9][A-Za-z0-9._:-]*)$/u;
export const EPHEMERAL_RESOURCE_ROUTE_PATTERN =
  /^\/api\/v1\/resources\/([A-Za-z0-9][A-Za-z0-9._:-]*)$/u;

const LIBRARY_COPY_INFORMATION_ROUTE = "/api/v1/library/copy-generation-info";
const LIBRARY_SELECT_DIRECTORY_ROUTE = "/api/v1/library/select-directory";
const REMOVED_LIBRARY_ROUTE_PATHS = new Set([
  "/api/v1/edit",
  "/api/v1/library/mark",
  "/api/v1/library/trash",
  "/api/v1/library/delete",
  "/api/v1/library/restore",
  "/api/v1/library/permanent-delete",
  "/api/v1/library/migration/preflight",
  "/api/v1/library/migration/confirmation"
]);

const DEFAULT_RESOURCE_CHUNK_BYTES = 64 * 1024;
const MAXIMUM_RESOURCE_CHUNK_BYTES = 1024 * 1024;
const MAXIMUM_LIBRARY_JSON_BODY_BYTES = 64 * 1024;

export class StudioRequestSessionContext {
  readonly #storage = new AsyncLocalStorage<StudioSessionDescriptor>();

  run<T>(session: StudioSessionDescriptor, operation: () => T): T {
    return this.#storage.run(Object.freeze({ ...session }), operation);
  }

  requireSession(): StudioSessionDescriptor {
    const session = this.#storage.getStore();
    if (session === undefined) {
      throw new Error("The active Studio request has no owning session context.");
    }
    return session;
  }
}

export interface ProductionStudioStreamService {
  executeStudioStream(
    input: StudioImageOperationRequest,
    options?: { readonly signal?: AbortSignal }
  ): AsyncIterable<unknown>;
}

export interface IntegrationRuntimeRouteOptions {
  readonly service: Pick<LocalRoutegoService, "getUploadResourceStatus"> &
    Partial<Pick<LocalRoutegoService, "manageLibrary">> & ProductionStudioStreamService;
  readonly library: Pick<
    RoutegoLibraryService,
    | "resolveBrowserResource"
    | "stageUpload"
    | "preflightLibraryMutation"
    | "executeLibraryMutation"
    | "getAssetDetail"
  > & {
    readonly galleryService: Pick<RoutegoLibraryService["galleryService"], "copyGenerationInfo">;
  };
  readonly ephemeralResources: Pick<EphemeralImageResourceRegistry, "open">;
  readonly sessions: Pick<StudioSessionManager, "authorizeSessionToken">;
  readonly sessionContext: StudioRequestSessionContext;
  readonly now?: () => Date;
  readonly resourceChunkBytes?: number;
  readonly maximumStreamJsonBodyBytes?: number;
  /** Injectable only for deterministic runtime-route tests. */
  readonly selectLibraryDirectory?: () => Promise<string | undefined>;
}

class RuntimeRouteError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, safeMessage: string) {
    super(safeMessage);
    this.name = "RuntimeRouteError";
    this.status = status;
    this.code = code;
  }
}

interface ResourceBacking {
  readonly path: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp" | "application/zip";
  readonly byteLength: number;
  readonly sha256: string;
  readonly etag: string;
  readonly expiresAt: string;
  readonly signal?: AbortSignal;
  close(): Promise<void>;
}

interface ValidatedResource extends ResourceBacking {
  readonly handle: FileHandle;
}

function header(request: RoutegoHttpRequest, name: string): string | undefined {
  return request.headers[name.toLowerCase()];
}

function jsonResponse(status: number, value: unknown): RoutegoHttpResponse {
  return {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff"
    },
    body: JSON.stringify(value)
  };
}

function errorResponse(error: RuntimeRouteError): RoutegoHttpResponse {
  return jsonResponse(error.status, {
    error: { code: error.code, safeMessage: error.message }
  });
}

function errorCode(value: unknown): string | undefined {
  if (value !== null && typeof value === "object" && "code" in value) {
    const code = (value as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function safeRouteError(value: unknown, resource = false): RuntimeRouteError {
  const code = errorCode(value);
  if (code === "not_found" || code === "not-found") {
    return new RuntimeRouteError(404, "not_found", "The protected resource is unavailable.");
  }
  if (code === "upload_expired" || code === "expired") {
    return new RuntimeRouteError(
      410,
      resource ? "expired" : "upload_expired",
      "The protected resource has expired."
    );
  }
  if (code === "upload_oversize") {
    return new RuntimeRouteError(413, code, "The upload exceeded its reserved size.");
  }
  if (code === "upload_invalid_type" || code === "upload_checksum_failed" || code === "integrity-failed") {
    return new RuntimeRouteError(422, code, "The protected resource failed validation.");
  }
  if (code === "upload_consumed" || code === "upload_discarded" || code === "conflict") {
    return new RuntimeRouteError(409, code, "The upload is no longer writable.");
  }
  if (code === "cancelled") {
    return new RuntimeRouteError(499, code, "The protected request was cancelled.");
  }
  if (code === "registry-shutdown") {
    return new RuntimeRouteError(503, "runtime_unavailable", "The protected resource runtime is unavailable.");
  }
  return new RuntimeRouteError(
    500,
    "internal_contract",
    resource
      ? "The protected resource failed safely."
      : "The protected upload failed safely."
  );
}

function safeLibraryRouteError(value: unknown): RuntimeRouteError {
  const code = errorCode(value);
  if (code === "not_found" || code === "not-found") {
    return new RuntimeRouteError(404, "not_found", "The Library record is unavailable.");
  }
  if (code === "invalid_input" || code === "invalid_request") {
    return new RuntimeRouteError(400, "invalid_request", "The Library request is invalid.");
  }
  if (code === "conflict") {
    return new RuntimeRouteError(409, "conflict", "The Library record is no longer eligible.");
  }
  return new RuntimeRouteError(500, "internal_contract", "The Library request failed safely.");
}

function parseContentLength(request: RoutegoHttpRequest): number {
  const value = header(request, "content-length");
  if (value === undefined || !/^\d+$/u.test(value)) {
    throw new RuntimeRouteError(411, "invalid_request", "A valid Content-Length is required.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RuntimeRouteError(400, "invalid_request", "Content-Length is invalid.");
  }
  return parsed;
}

async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal
): Promise<IteratorResult<T>> {
  if (signal.aborted) {
    throw new RuntimeRouteError(499, "cancelled", "The protected request was cancelled.");
  }
  return await new Promise<IteratorResult<T>>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => finish(() => reject(
      new RuntimeRouteError(499, "cancelled", "The protected request was cancelled.")
    ));
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
  } catch {
    // A cancelled binary request must still close the Library staging path.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function* boundedUploadBody(
  request: RoutegoHttpRequest,
  expectedBytes: number,
  maximumBytes: number
): AsyncGenerator<Uint8Array> {
  if (request.body === undefined) {
    throw new RuntimeRouteError(400, "invalid_request", "An upload body is required.");
  }
  const iterator = request.body[Symbol.asyncIterator]();
  let total = 0;
  try {
    while (true) {
      const next = await nextWithAbort(iterator, request.signal);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) {
        throw new RuntimeRouteError(400, "invalid_request", "Upload chunks must be binary.");
      }
      total += next.value.byteLength;
      if (total > expectedBytes || total > maximumBytes) {
        throw new RuntimeRouteError(413, "upload_oversize", "The upload exceeded its reserved size.");
      }
      yield next.value;
    }
    if (total !== expectedBytes) {
      throw new RuntimeRouteError(400, "invalid_request", "The upload byte length does not match its reservation.");
    }
  } finally {
    await closeIterator(iterator);
  }
}

async function boundedJsonBody(request: RoutegoHttpRequest): Promise<unknown> {
  if (request.body === undefined) {
    throw new RuntimeRouteError(400, "invalid_request", "A JSON request body is required.");
  }
  const mediaType = header(request, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new RuntimeRouteError(415, "invalid_request", "The Library request must be JSON.");
  }
  const iterator = request.body[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await nextWithAbort(iterator, request.signal);
      if (next.done) break;
      const bytes = typeof next.value === "string"
        ? new TextEncoder().encode(next.value)
        : next.value instanceof Uint8Array
          ? next.value
          : undefined;
      if (bytes === undefined) {
        throw new RuntimeRouteError(400, "invalid_request", "The Library JSON body is invalid.");
      }
      total += bytes.byteLength;
      if (total > MAXIMUM_LIBRARY_JSON_BODY_BYTES) {
        throw new RuntimeRouteError(413, "request_oversize", "The Library JSON body is too large.");
      }
      chunks.push(bytes);
    }
  } finally {
    await closeIterator(iterator);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new RuntimeRouteError(400, "invalid_request", "The Library JSON body is invalid.");
  }
}

function parseCopyInput(value: unknown) {
  try {
    return copyGenerationInfoInputSchema.parse(value);
  } catch {
    throw new RuntimeRouteError(400, "invalid_request", "The Library copy request is invalid.");
  }
}

function validIdentifier(value: string | undefined): string {
  try {
    return identifierSchema.parse(value);
  } catch {
    throw new RuntimeRouteError(404, "not_found", "The protected route was not found.");
  }
}

function parseExpiry(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new RuntimeRouteError(500, "internal_contract", "The protected resource expiry is invalid.");
  }
  return milliseconds;
}

function matchesMimeMagic(mimeType: ResourceBacking["mimeType"], prefix: Uint8Array): boolean {
  if (mimeType === "image/png") {
    return prefix.length >= 8 &&
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
        .every((value, index) => prefix[index] === value);
  }
  if (mimeType === "image/jpeg") {
    return prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
  }
  if (mimeType === "image/webp") {
    return prefix.length >= 12 &&
      String.fromCharCode(...prefix.subarray(0, 4)) === "RIFF" &&
      String.fromCharCode(...prefix.subarray(8, 12)) === "WEBP";
  }
  return prefix.length >= 4 && prefix[0] === 0x50 && prefix[1] === 0x4b &&
    ((prefix[2] === 0x03 && prefix[3] === 0x04) ||
      (prefix[2] === 0x05 && prefix[3] === 0x06) ||
      (prefix[2] === 0x07 && prefix[3] === 0x08));
}

async function validateResource(
  backing: ResourceBacking,
  now: () => Date,
  chunkBytes: number
): Promise<ValidatedResource> {
  const expiresAt = parseExpiry(backing.expiresAt);
  if (now().getTime() >= expiresAt) {
    throw new RuntimeRouteError(410, "expired", "The protected resource has expired.");
  }
  if (!Number.isSafeInteger(backing.byteLength) || backing.byteLength < 1 ||
    !/^[a-f0-9]{64}$/u.test(backing.sha256) ||
    backing.etag !== `sha256-${backing.sha256}`) {
    throw new RuntimeRouteError(500, "internal_contract", "The protected resource claims are invalid.");
  }
  const metadata = await lstat(backing.path).catch(() => undefined);
  if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink() ||
    metadata.size !== backing.byteLength) {
    throw new RuntimeRouteError(422, "integrity_failed", "The protected resource failed integrity validation.");
  }

  const handle = await open(backing.path, "r").catch(() => undefined);
  if (handle === undefined) {
    throw new RuntimeRouteError(404, "not_found", "The protected resource is unavailable.");
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== backing.byteLength) {
      throw new RuntimeRouteError(422, "integrity_failed", "The protected resource failed integrity validation.");
    }
    const hash = createHash("sha256");
    const prefix = new Uint8Array(Math.min(12, backing.byteLength));
    let prefixLength = 0;
    let position = 0;
    while (position < backing.byteLength) {
      const buffer = new Uint8Array(Math.min(chunkBytes, backing.byteLength - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead < 1) {
        throw new RuntimeRouteError(422, "integrity_failed", "The protected resource changed during validation.");
      }
      const bytes = buffer.subarray(0, bytesRead);
      hash.update(bytes);
      if (prefixLength < prefix.length) {
        const copied = Math.min(prefix.length - prefixLength, bytes.length);
        prefix.set(bytes.subarray(0, copied), prefixLength);
        prefixLength += copied;
      }
      position += bytesRead;
    }
    const extra = new Uint8Array(1);
    if ((await handle.read(extra, 0, 1, backing.byteLength)).bytesRead !== 0 ||
      hash.digest("hex") !== backing.sha256 ||
      !matchesMimeMagic(backing.mimeType, prefix.subarray(0, prefixLength)) ||
      (await handle.stat()).size !== backing.byteLength) {
      throw new RuntimeRouteError(422, "integrity_failed", "The protected resource failed integrity validation.");
    }
    if (now().getTime() >= expiresAt) {
      throw new RuntimeRouteError(410, "expired", "The protected resource has expired.");
    }
    return { ...backing, handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function* resourceBody(
  resource: ValidatedResource,
  requestSignal: AbortSignal,
  chunkBytes: number
): AsyncGenerator<Uint8Array> {
  let position = 0;
  try {
    while (position < resource.byteLength) {
      if (requestSignal.aborted || resource.signal?.aborted === true) return;
      const buffer = new Uint8Array(Math.min(chunkBytes, resource.byteLength - position));
      const { bytesRead } = await resource.handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead < 1) return;
      position += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await resource.handle.close().catch(() => undefined);
    await resource.close().catch(() => undefined);
  }
}

function httpEtag(etag: string): string {
  return `"${etag}"`;
}

function etagMatches(value: string | undefined, etag: string): boolean {
  if (value === undefined) return false;
  return value.split(",").map((item) => item.trim()).some((item) =>
    item === "*" || item === etag || item === httpEtag(etag)
  );
}

function durableBacking(resource: ResolvedBrowserResource): ResourceBacking {
  return { ...resource, close: async () => undefined };
}

function ephemeralBacking(resource: OpenEphemeralImageResource): ResourceBacking {
  return {
    path: resource.path,
    mimeType: resource.mimeType,
    byteLength: resource.byteLength,
    sha256: resource.sha256,
    etag: resource.descriptor.etag,
    expiresAt: resource.descriptor.expiresAt,
    signal: resource.signal,
    close: () => resource.close()
  };
}

function preflightResponse(method: "GET" | "POST" | "PUT"): RoutegoHttpResponse {
  return {
    status: 204,
    headers: {
      "access-control-allow-methods": `${method}, OPTIONS`,
      "access-control-allow-headers": method === "PUT" || method === "POST"
        ? "content-type, x-routego-session"
        : "x-routego-session"
    }
  };
}

export function createIntegrationRuntimeRoutes(
  options: IntegrationRuntimeRouteOptions
): RoutegoHttpExtensionHandler {
  const now = options.now ?? (() => new Date());
  const resourceChunkBytes = options.resourceChunkBytes ?? DEFAULT_RESOURCE_CHUNK_BYTES;
  if (!Number.isSafeInteger(resourceChunkBytes) || resourceChunkBytes < 1 ||
    resourceChunkBytes > MAXIMUM_RESOURCE_CHUNK_BYTES) {
    throw new Error("resourceChunkBytes must be a positive safe integer no greater than 1 MiB");
  }
  const streamRoute = createStudioCreationStreamRoute({
    execute: (input, context) => options.service.executeStudioStream(input, { signal: context.signal }),
    ...(options.maximumStreamJsonBodyBytes === undefined
      ? {}
      : { maximumJsonBodyBytes: options.maximumStreamJsonBodyBytes })
  });

  return async (request, extensionContext): Promise<RoutegoHttpResponse | undefined> => {
    const uploadMatch = UPLOAD_CONTENT_ROUTE_PATTERN.exec(request.url.pathname);
    const libraryMatch = LIBRARY_RESOURCE_ROUTE_PATTERN.exec(request.url.pathname);
    const ephemeralMatch = EPHEMERAL_RESOURCE_ROUTE_PATTERN.exec(request.url.pathname);
    const isStream = request.url.pathname === STUDIO_CREATION_STREAM_PATH;
    const isLibraryCopy = request.url.pathname === LIBRARY_COPY_INFORMATION_ROUTE;
    const isLibraryDirectorySelection = request.url.pathname === LIBRARY_SELECT_DIRECTORY_ROUTE;
    const isRemovedLibraryRoute = REMOVED_LIBRARY_ROUTE_PATHS.has(request.url.pathname);
    if (uploadMatch === null && libraryMatch === null && ephemeralMatch === null && !isStream &&
      !isLibraryCopy && !isLibraryDirectorySelection && !isRemovedLibraryRoute) {
      return undefined;
    }

    if (request.url.search !== "") {
      return errorResponse(new RuntimeRouteError(400, "invalid_request", "Protected routes do not accept query input."));
    }

    if (extensionContext.preflight) {
      if (isStream) return await streamRoute(request, extensionContext);
      const expectedMethod = uploadMatch !== null ? "PUT" :
        isLibraryCopy || isLibraryDirectorySelection ? "POST" : "GET";
      if (header(request, "access-control-request-method")?.trim().toUpperCase() !== expectedMethod) {
        return errorResponse(new RuntimeRouteError(405, "invalid_request", "The protected route preflight method is invalid."));
      }
      return preflightResponse(expectedMethod);
    }

    const token = header(request, "x-routego-session") ?? "";
    const session = options.sessions.authorizeSessionToken(token);
    const sessionExpiresAt = session === undefined ? Number.NaN : Date.parse(session.expiresAt);
    if (session === undefined || !Number.isFinite(sessionExpiresAt) || now().getTime() >= sessionExpiresAt) {
      return errorResponse(new RuntimeRouteError(403, "session_invalid", "The local session is no longer valid."));
    }

    if (isStream) {
      return await options.sessionContext.run(session, () => streamRoute(request, extensionContext));
    }

    try {
      if (isRemovedLibraryRoute) {
        throw new RuntimeRouteError(404, "not_found", "The Library route was not found.");
      }
      if (isLibraryCopy) {
        if (request.method.toUpperCase() !== "POST") {
          throw new RuntimeRouteError(405, "invalid_request", "The Library copy route accepts POST only.");
        }
        return jsonResponse(200, await options.library.galleryService.copyGenerationInfo(
          parseCopyInput(await boundedJsonBody(request))
        ));
      }
      if (isLibraryDirectorySelection) {
        if (request.method.toUpperCase() !== "POST") {
          throw new RuntimeRouteError(405, "invalid_request", "The Library directory picker accepts POST only.");
        }
        const input = await boundedJsonBody(request);
        if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 0) {
          throw new RuntimeRouteError(400, "invalid_request", "The Library directory picker request is invalid.");
        }
        const selected = await (options.selectLibraryDirectory ?? selectNativeLibraryDirectory)();
        if (selected === undefined) return jsonResponse(200, { schemaVersion: 1, selected: false });
        if (options.service.manageLibrary === undefined) {
          throw new RuntimeRouteError(503, "runtime_unavailable", "The Library directory picker is unavailable.");
        }
        const result = await options.service.manageLibrary({ action: "add-location", locationPath: selected });
        return jsonResponse(200, { schemaVersion: 1, selected: true, result });
      }
      if (uploadMatch !== null) {
        if (request.method.toUpperCase() !== "PUT") {
          throw new RuntimeRouteError(405, "invalid_request", "The upload content route accepts PUT only.");
        }
        const uploadResourceId = validIdentifier(uploadMatch[1]);
        const status = await options.service.getUploadResourceStatus({ uploadResourceId });
        if (status.status !== "succeeded" || status.resource === undefined) {
          throw safeRouteError(status.error);
        }
        const descriptor = status.resource;
        if (descriptor.status !== "reserved") {
          throw new RuntimeRouteError(409, "conflict", "The upload is no longer writable.");
        }
        if (descriptor.binaryUpload.relativeUrl !== request.url.pathname ||
          now().getTime() >= Date.parse(descriptor.binaryUpload.expiresAt)) {
          throw new RuntimeRouteError(410, "upload_expired", "The upload reservation has expired.");
        }
        const contentType = header(request, "content-type")?.trim().toLowerCase();
        if (contentType !== descriptor.declaredMimeType ||
          !descriptor.binaryUpload.allowedMimeTypes.includes(descriptor.declaredMimeType)) {
          throw new RuntimeRouteError(415, "upload_invalid_type", "The upload MIME type does not match its reservation.");
        }
        const contentLength = parseContentLength(request);
        if (contentLength !== descriptor.declaredByteLength ||
          contentLength > descriptor.binaryUpload.maxBytes) {
          throw new RuntimeRouteError(413, "upload_oversize", "The upload length does not match its reservation.");
        }
        const staged = await options.library.stageUpload(
          uploadResourceId,
          boundedUploadBody(request, descriptor.declaredByteLength, descriptor.binaryUpload.maxBytes)
        );
        return jsonResponse(200, { schemaVersion: 1, status: "succeeded", resource: staged });
      }

      if (request.method.toUpperCase() !== "GET") {
        throw new RuntimeRouteError(405, "invalid_request", "Protected resources accept GET only.");
      }
      const resourceId = validIdentifier((libraryMatch ?? ephemeralMatch)?.[1]);
      let backing: ResourceBacking;
      if (libraryMatch !== null) {
        backing = durableBacking(options.library.resolveBrowserResource(resourceId));
      } else {
        backing = ephemeralBacking(await options.ephemeralResources.open(resourceId, session.id));
      }
      let validated: ValidatedResource;
      try {
        validated = await validateResource(backing, now, resourceChunkBytes);
      } catch (error) {
        await backing.close().catch(() => undefined);
        throw error;
      }

      const responseEtag = httpEtag(validated.etag);
      const ifMatch = header(request, "if-match");
      if (ifMatch !== undefined && !etagMatches(ifMatch, validated.etag)) {
        await validated.handle.close().catch(() => undefined);
        await validated.close().catch(() => undefined);
        return { status: 412, headers: { "cache-control": "no-store", etag: responseEtag } };
      }
      if (etagMatches(header(request, "if-none-match"), validated.etag)) {
        await validated.handle.close().catch(() => undefined);
        await validated.close().catch(() => undefined);
        return { status: 304, headers: { "cache-control": "no-store", etag: responseEtag } };
      }
      return {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-type": validated.mimeType,
          "content-length": String(validated.byteLength),
          "x-content-type-options": "nosniff",
          etag: responseEtag
        },
        body: resourceBody(validated, request.signal, resourceChunkBytes)
      };
    } catch (error) {
      return errorResponse(error instanceof RuntimeRouteError ? error :
        (isLibraryCopy || isLibraryDirectorySelection
          ? safeLibraryRouteError(error)
          : safeRouteError(error, true)));
    }
  };
}
