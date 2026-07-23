import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import {
  studioGenerateInputSchema,
  studioProviderSwitchResultSchema,
  routegoPrepareRegenerationResultSchema,
  studioServiceErrorSchema,
  type LocalRoutegoService,
  type RoutegoService,
  type StudioImageOperationRequest
} from "@routego-image/contracts";
import {
  createRoutegoHttpDispatcher,
  type RoutegoHttpRequest,
  type RoutegoHttpResponse
} from "@routego-image/creation";
import {
  LibraryError,
  createRoutegoLibraryService,
  type ResolvedBrowserResource
} from "@routego-image/library";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createEphemeralImageResourceRegistry } from "../src/runtime/ephemeral-resources";
import {
  StudioRequestSessionContext,
  createIntegrationRuntimeRoutes,
  type ProductionStudioStreamService
} from "../src/runtime/routes";
import { IntegrationLoopbackHttpHost } from "../src/runtime/http-host";
import { StudioStaticAssetRegistry } from "../src/runtime/static";
import { StudioSessionManager } from "../src/runtime/sessions";
import { STUDIO_CREATION_STREAM_PATH } from "../src/runtime/stream-route";

const ORIGIN = "http://127.0.0.1:43119";
const TOKEN_A = "synthetic-session-token-a-that-is-long-enough";
const TOKEN_B = "synthetic-session-token-b-that-is-long-enough";
const BASE_NOW = Date.parse("2026-07-19T08:00:00.000Z");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(async (cleanup) => await cleanup()));
  vi.restoreAllMocks();
});

function pngBytes(color = 0x35): Uint8Array {
  const png = new PNG({ width: 2, height: 2 });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = color;
    png.data[offset + 1] = color + 20;
    png.data[offset + 2] = color + 40;
    png.data[offset + 3] = 0xff;
  }
  return PNG.sync.write(png);
}

function emptyZipBytes(): Uint8Array {
  return Uint8Array.from([0x50, 0x4b, 0x05, 0x06, ...Array.from({ length: 18 }, () => 0)]);
}

async function* chunks(...values: Array<string | Uint8Array>) {
  for (const value of values) yield value;
}

function unusedService(): RoutegoService {
  return new Proxy({}, {
    get(_target, property) {
      return async () => {
        throw new Error(`Unexpected public service call: ${String(property)}`);
      };
    }
  }) as RoutegoService;
}

function request(
  pathname: string,
  options: {
    readonly method?: string;
    readonly token?: string;
    readonly origin?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: AsyncIterable<string | Uint8Array>;
    readonly signal?: AbortSignal;
  } = {}
): RoutegoHttpRequest {
  return {
    method: options.method ?? "GET",
    url: new URL(pathname, ORIGIN),
    headers: {
      origin: options.origin ?? ORIGIN,
      "x-routego-session": options.token ?? TOKEN_A,
      ...options.headers
    },
    ...(options.body === undefined ? {} : { body: options.body }),
    signal: options.signal ?? new AbortController().signal
  };
}

function jsonRequest(
  pathname: string,
  input: unknown,
  options: { readonly token?: string; readonly origin?: string } = {}
): RoutegoHttpRequest {
  const body = JSON.stringify(input);
  return request(pathname, {
    method: "POST",
    ...options,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: chunks(body)
  });
}

function json(response: RoutegoHttpResponse): Record<string, any> {
  if (typeof response.body !== "string") throw new Error("Expected a JSON response");
  return JSON.parse(response.body) as Record<string, any>;
}

function iterableBody(response: RoutegoHttpResponse): AsyncIterable<string | Uint8Array> {
  if (response.body === undefined || typeof response.body === "string" ||
    response.body instanceof Uint8Array) {
    throw new Error("Expected an iterable response body");
  }
  return response.body;
}

async function responseBytes(response: RoutegoHttpResponse): Promise<Uint8Array> {
  if (response.body instanceof Uint8Array) return response.body;
  const rendered: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of iterableBody(response)) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    rendered.push(bytes);
    total += bytes.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of rendered) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function responseText(response: RoutegoHttpResponse): Promise<string> {
  if (typeof response.body === "string") return response.body;
  return new TextDecoder().decode(await responseBytes(response));
}

function generateRequest(): StudioImageOperationRequest {
  return studioGenerateInputSchema.parse({
    kind: "generate",
    prompt: "A synthetic protected route result"
  });
}

interface Harness {
  readonly root: string;
  readonly clock: { now: number };
  readonly library: ReturnType<typeof createRoutegoLibraryService>;
  readonly registry: Awaited<ReturnType<typeof createEphemeralImageResourceRegistry>>;
  readonly sessionContext: StudioRequestSessionContext;
  readonly durable: Map<string, ResolvedBrowserResource>;
  readonly closeLease: ReturnType<typeof vi.fn>;
  dispatcher(token?: string): ReturnType<typeof createRoutegoHttpDispatcher>;
}

async function createHarness(options: {
  readonly executeStudioStream?: ProductionStudioStreamService["executeStudioStream"];
  readonly resourceChunkBytes?: number;
} = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "routego-runtime-routes-"));
  const clock = { now: BASE_NOW };
  const counters = new Map<string, number>();
  const next = (kind: string) => {
    const value = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, value);
    return `${kind}-${value}`;
  };
  const library = createRoutegoLibraryService({
    homeDirectory: path.join(root, "home"),
    now: () => new Date(clock.now),
    settings: {
      dataRoot: path.join(root, "data"),
      idFactory: () => next("provider"),
      protectCredentialFile: async () => undefined
    },
    uploads: {
      dataRoot: path.join(root, "data"),
      now: () => new Date(clock.now),
      idFactory: () => next("upload")
    },
    index: { root: path.join(root, "library") },
    assets: { protectedRoots: [], idFactory: (kind) => next(kind) },
    resources: {
      now: () => new Date(clock.now),
      idFactory: (kind) => next(`resource-${kind}`)
    },
    read: { folderIdFactory: () => next("folder") },
    mutations: { protectedRoots: [], idFactory: (kind) => next(kind) },
    portability: { idFactory: (kind) => next(kind) },
    publicProtectedRoots: []
  });
  await library.recover();
  const registry = await createEphemeralImageResourceRegistry({
    root: path.join(root, "ephemeral"),
    now: () => new Date(clock.now),
    idFactory: () => next("ephemeral")
  });
  const closeLease = vi.fn();
  const ephemeralResources = {
    open: async (resourceId: string, sessionId: string) => {
      const opened = await registry.open(resourceId, sessionId);
      return {
        ...opened,
        close: async () => {
          closeLease();
          await opened.close();
        }
      };
    }
  };
  const durable = new Map<string, ResolvedBrowserResource>();
  const sessionContext = new StudioRequestSessionContext();
  const sessions = new Map([
    [TOKEN_A, {
      id: "session-a",
      createdAt: new Date(BASE_NOW).toISOString(),
      expiresAt: new Date(BASE_NOW + 10 * 60_000).toISOString()
    }],
    [TOKEN_B, {
      id: "session-b",
      createdAt: new Date(BASE_NOW).toISOString(),
      expiresAt: new Date(BASE_NOW + 10 * 60_000).toISOString()
    }]
  ]);
  const stream = options.executeStudioStream ?? (() => {
    throw new Error("Unexpected Studio stream execution");
  });
  const localTarget = {
    reserveUploadResource: (input: Parameters<LocalRoutegoService["reserveUploadResource"]>[0]) =>
      library.reserveUploadResource(input),
    finalizeUploadResource: (input: Parameters<LocalRoutegoService["finalizeUploadResource"]>[0]) =>
      library.finalizeUploadResource(input),
    getUploadResourceStatus: (input: Parameters<LocalRoutegoService["getUploadResourceStatus"]>[0]) =>
      library.getUploadResourceStatus(input),
    discardUploadResource: (input: Parameters<LocalRoutegoService["discardUploadResource"]>[0]) =>
      library.discardUploadResource(input),
    executeStudioStream: stream
  };
  const routes = createIntegrationRuntimeRoutes({
    service: localTarget,
    library: {
      stageUpload: (uploadResourceId, source) => library.stageUpload(uploadResourceId, source),
      resolveBrowserResource: (resourceId) => {
        const resource = durable.get(resourceId);
        if (resource === undefined) throw new LibraryError("not_found", "Synthetic resource missing");
        return resource;
      },
      preflightLibraryMutation: (input) => library.preflightLibraryMutation(input),
      executeLibraryMutation: (input) => library.executeLibraryMutation(input),
      getAssetDetail: (input) => library.getAssetDetail(input),
      galleryService: {
        copyGenerationInfo: (input) => library.galleryService.copyGenerationInfo(input)
      }
    },
    ephemeralResources,
    sessions: {
      authorizeSessionToken: (token) => sessions.get(token)
    },
    sessionContext,
    now: () => new Date(clock.now),
    resourceChunkBytes: options.resourceChunkBytes ?? 4
  });
  cleanups.push(async () => {
    await registry.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    clock,
    library,
    registry,
    sessionContext,
    durable,
    closeLease,
    dispatcher: (token = TOKEN_A) => createRoutegoHttpDispatcher({
      service: unusedService(),
      localService: localTarget as unknown as LocalRoutegoService,
      expectedSessionToken: token,
      allowedOrigins: [ORIGIN],
      extensionHandler: routes
    })
  };
}

describe("task 4.2 protected upload and resource routes", () => {
  it("maps only the read-only regeneration route and rejects the removed edit route", async () => {
    const prepareRegeneration = vi.fn(async () => routegoPrepareRegenerationResultSchema.parse({
      schemaVersion: 1,
      recipe: {
        schemaVersion: 1,
        kind: "generate",
        sourceRecordId: "record-1",
        prompt: "A safe saved prompt",
        referenceIds: [],
        size: "auto",
        aspectRatio: "auto",
        quality: "auto",
        format: "png",
        count: 1,
        partialImages: 0,
        transparentMode: "off",
        moderation: "auto",
        saveToLibrary: true
      },
      providerRequestCount: 0,
      markUnchanged: true
    }));
    const dispatcher = createRoutegoHttpDispatcher({
      service: new Proxy({ prepareRegeneration }, {
        get(target, property) {
          if (property in target) return target[property as keyof typeof target];
          return async () => { throw new Error(`Unexpected public service call: ${String(property)}`); };
        }
      }) as unknown as RoutegoService,
      expectedSessionToken: TOKEN_A,
      allowedOrigins: [ORIGIN]
    });

    const prepared = await dispatcher.dispatch(jsonRequest("/api/v1/prepare-regeneration", { recordId: "record-1" }));
    expect(prepared.status).toBe(200);
    expect(json(prepared)).toMatchObject({ providerRequestCount: 0, markUnchanged: true });
    expect(prepareRegeneration).toHaveBeenCalledWith({ schemaVersion: 1, recordId: "record-1" });

    const removed = await dispatcher.dispatch(jsonRequest("/api/v1/edit", { kind: "edit" }));
    expect(removed.status).toBe(404);
    expect(prepareRegeneration).toHaveBeenCalledTimes(1);
  });

  it("runs reserve, strict PUT staging, status, finalize, and discard through one protected dispatcher", async () => {
    const { dispatcher } = await createHarness();
    const runtime = dispatcher();
    const bytes = pngBytes();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const reserve = await runtime.dispatch(jsonRequest("/api/v1/uploads/reserve", {
      purpose: "image",
      declaredMimeType: "image/png",
      declaredByteLength: bytes.byteLength,
      expectedSha256: sha256
    }));
    expect(reserve.status).toBe(200);
    const resource = json(reserve)["resource"];
    const resourceId = resource.uploadResourceId as string;

    const preflight = await runtime.dispatch(request(resource.binaryUpload.relativeUrl, {
      method: "OPTIONS",
      headers: {
        "access-control-request-method": "PUT",
        "access-control-request-headers": "content-type, x-routego-session"
      }
    }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers?.["access-control-allow-methods"]).toBe("PUT, OPTIONS");
    const wrongPreflight = await runtime.dispatch(request(resource.binaryUpload.relativeUrl, {
      method: "OPTIONS",
      headers: {
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-routego-session"
      }
    }));
    expect(wrongPreflight.status).toBe(405);

    const wrongMime = await runtime.dispatch(request(resource.binaryUpload.relativeUrl, {
      method: "PUT",
      headers: { "content-type": "image/jpeg", "content-length": String(bytes.byteLength) },
      body: chunks(bytes)
    }));
    expect(wrongMime.status).toBe(415);

    const staged = await runtime.dispatch(request(resource.binaryUpload.relativeUrl, {
      method: "PUT",
      headers: { "content-type": "image/png", "content-length": String(bytes.byteLength) },
      body: chunks(bytes.subarray(0, 7), bytes.subarray(7))
    }));
    expect(staged.status).toBe(200);
    expect(json(staged)).toMatchObject({ status: "succeeded", resource: { status: "uploaded" } });

    const status = await runtime.dispatch(jsonRequest("/api/v1/uploads/status", {
      uploadResourceId: resourceId
    }));
    expect(json(status)).toMatchObject({ status: "succeeded", resource: { status: "uploaded" } });
    const finalized = await runtime.dispatch(jsonRequest("/api/v1/uploads/finalize", {
      uploadResourceId: resourceId
    }));
    expect(json(finalized)).toMatchObject({
      status: "succeeded",
      resource: {
        status: "finalized",
        finalized: { detectedMimeType: "image/png", byteLength: bytes.byteLength, sha256 }
      }
    });

    const secondReserve = await runtime.dispatch(jsonRequest("/api/v1/uploads/reserve", {
      purpose: "mask",
      declaredMimeType: "image/png",
      declaredByteLength: bytes.byteLength
    }));
    const secondId = json(secondReserve)["resource"].uploadResourceId as string;
    const discarded = await runtime.dispatch(jsonRequest("/api/v1/uploads/discard", {
      uploadResourceId: secondId
    }));
    expect(json(discarded)).toMatchObject({ status: "succeeded", resource: { status: "discarded" } });
  });

  it("rejects upload length, abort, expiry, origin, and session violations without retaining partial bytes", async () => {
    const { dispatcher, clock } = await createHarness();
    const runtime = dispatcher();
    const bytes = pngBytes(0x45);
    const reserve = await runtime.dispatch(jsonRequest("/api/v1/uploads/reserve", {
      purpose: "reference",
      declaredMimeType: "image/png",
      declaredByteLength: bytes.byteLength
    }));
    const descriptor = json(reserve)["resource"];

    const missingLength = await runtime.dispatch(request(descriptor.binaryUpload.relativeUrl, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: chunks(bytes)
    }));
    expect(missingLength.status).toBe(411);
    const short = await runtime.dispatch(request(descriptor.binaryUpload.relativeUrl, {
      method: "PUT",
      headers: { "content-type": "image/png", "content-length": String(bytes.byteLength) },
      body: chunks(bytes.subarray(0, bytes.byteLength - 1))
    }));
    expect(short.status).toBe(400);

    const controller = new AbortController();
    controller.abort();
    const cancelled = await runtime.dispatch(request(descriptor.binaryUpload.relativeUrl, {
      method: "PUT",
      headers: { "content-type": "image/png", "content-length": String(bytes.byteLength) },
      body: chunks(bytes),
      signal: controller.signal
    }));
    expect(cancelled.status).toBe(499);

    const status = await runtime.dispatch(jsonRequest("/api/v1/uploads/status", {
      uploadResourceId: descriptor.uploadResourceId
    }));
    expect(json(status)).toMatchObject({ status: "succeeded", resource: { status: "reserved" } });

    const wrongSession = await dispatcher(TOKEN_B).dispatch(request(descriptor.binaryUpload.relativeUrl, {
      method: "PUT",
      token: TOKEN_A,
      headers: { "content-type": "image/png", "content-length": String(bytes.byteLength) },
      body: chunks(bytes)
    }));
    expect(wrongSession.status).toBe(403);
    const wrongOrigin = await runtime.dispatch(request(descriptor.binaryUpload.relativeUrl, {
      method: "PUT",
      origin: "https://example.invalid",
      headers: { "content-type": "image/png", "content-length": String(bytes.byteLength) },
      body: chunks(bytes)
    }));
    expect(wrongOrigin.status).toBe(403);

    clock.now = Date.parse(descriptor.binaryUpload.expiresAt);
    const expired = await runtime.dispatch(request(descriptor.binaryUpload.relativeUrl, {
      method: "PUT",
      headers: { "content-type": "image/png", "content-length": String(bytes.byteLength) },
      body: chunks(bytes)
    }));
    expect(expired.status).toBe(410);
    expect(JSON.stringify(json(expired))).not.toMatch(/synthetic-session|Authorization|[A-Z]:\\/u);
  });

  it("streams validated durable image and ZIP resources with ETag and exact expiry enforcement", async () => {
    const { root, durable, dispatcher, clock } = await createHarness();
    const image = pngBytes(0x55);
    const zip = emptyZipBytes();
    const resourceRoot = path.join(root, "durable");
    await mkdir(resourceRoot, { recursive: true });
    const imagePath = path.join(resourceRoot, "image.png");
    const zipPath = path.join(resourceRoot, "export.zip");
    await writeFile(imagePath, image);
    await writeFile(zipPath, zip);
    const expiresAt = new Date(BASE_NOW + 5 * 60_000).toISOString();
    const imageSha = createHash("sha256").update(image).digest("hex");
    const zipSha = createHash("sha256").update(zip).digest("hex");
    durable.set("durable-image", {
      resourceId: "durable-image",
      rendition: "original",
      path: imagePath,
      mimeType: "image/png",
      byteLength: image.byteLength,
      sha256: imageSha,
      width: 2,
      height: 2,
      etag: `sha256-${imageSha}`,
      expiresAt
    });
    durable.set("durable-zip", {
      resourceId: "durable-zip",
      rendition: "zip",
      path: zipPath,
      mimeType: "application/zip",
      byteLength: zip.byteLength,
      sha256: zipSha,
      etag: `sha256-${zipSha}`,
      expiresAt
    });
    const runtime = dispatcher();

    const imageResponse = await runtime.dispatch(request("/api/v1/library/resources/durable-image"));
    expect(imageResponse.status).toBe(200);
    expect(imageResponse.headers).toMatchObject({
      "content-type": "image/png",
      "content-length": String(image.byteLength),
      etag: `"sha256-${imageSha}"`
    });
    expect(await responseBytes(imageResponse)).toEqual(Uint8Array.from(image));
    const notModified = await runtime.dispatch(request("/api/v1/library/resources/durable-image", {
      headers: { "if-none-match": `"sha256-${imageSha}"` }
    }));
    expect(notModified.status).toBe(304);
    const precondition = await runtime.dispatch(request("/api/v1/library/resources/durable-image", {
      headers: { "if-match": "\"sha256-wrong\"" }
    }));
    expect(precondition.status).toBe(412);

    const zipResponse = await runtime.dispatch(request("/api/v1/library/resources/durable-zip"));
    expect(zipResponse.headers?.["content-type"]).toBe("application/zip");
    expect(await responseBytes(zipResponse)).toEqual(zip);

    clock.now = Date.parse(expiresAt) - 1;
    const beforeExpiry = await runtime.dispatch(request("/api/v1/library/resources/durable-image"));
    expect(beforeExpiry.status).toBe(200);
    await responseBytes(beforeExpiry);
    clock.now = Date.parse(expiresAt);
    const atExpiry = await runtime.dispatch(request("/api/v1/library/resources/durable-image"));
    expect(atExpiry.status).toBe(410);

    clock.now = BASE_NOW;
    await writeFile(imagePath, Uint8Array.from(image, (value, index) => index === 12 ? value ^ 0xff : value));
    const corrupt = await runtime.dispatch(request("/api/v1/library/resources/durable-image"));
    expect(corrupt.status).toBe(422);
    expect(JSON.stringify(json(corrupt))).not.toContain(imagePath);
  });

  it("binds ephemeral resources to the exact session and closes readers without shortening expiry", async () => {
    const { root, registry, dispatcher, clock, closeLease } = await createHarness();
    const bytes = pngBytes(0x65);
    const source = path.join(root, "ephemeral-source.png");
    await writeFile(source, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const descriptor = await registry.registerImage({
      owningSessionId: "session-a",
      owningSessionExpiresAt: new Date(BASE_NOW + 10 * 60_000),
      output: {
        artifactId: "partial-ephemeral",
        slot: 0,
        phase: "partial",
        path: source,
        mimeType: "image/png",
        byteLength: bytes.byteLength,
        width: 2,
        height: 2,
        sha256,
        createdAt: new Date(BASE_NOW).toISOString(),
        source: "provider-original"
      }
    });

    const wrongOwner = await dispatcher(TOKEN_B).dispatch(request(descriptor.relativeUrl, {
      token: TOKEN_B
    }));
    expect(wrongOwner.status).toBe(404);

    const controller = new AbortController();
    const response = await dispatcher().dispatch(request(descriptor.relativeUrl, {
      signal: controller.signal
    }));
    const iterator = iterableBody(response)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    controller.abort();
    await iterator.next();
    await iterator.return?.();
    expect(closeLease).toHaveBeenCalledTimes(1);

    clock.now = Date.parse(descriptor.expiresAt) - 1;
    const beforeExpiry = await dispatcher().dispatch(request(descriptor.relativeUrl));
    expect(beforeExpiry.status).toBe(200);
    expect(await responseBytes(beforeExpiry)).toEqual(Uint8Array.from(bytes));
    expect(closeLease).toHaveBeenCalledTimes(2);

    clock.now = Date.parse(descriptor.expiresAt);
    const expired = await dispatcher().dispatch(request(descriptor.relativeUrl));
    expect(expired.status).toBe(410);
    await registry.shutdown();
    const afterShutdown = await dispatcher().dispatch(request(descriptor.relativeUrl));
    expect(afterShutdown.status).not.toBe(200);
  });

  it("closes a large HTTP resource reader after client disconnect under backpressure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "routego-http-backpressure-"));
    cleanups.push(async () => await rm(root, { recursive: true, force: true }));
    const staticRoot = path.join(root, "static");
    await mkdir(staticRoot, { recursive: true });
    await writeFile(path.join(staticRoot, "index.js"), "export {};\n");
    const largeBytes = new Uint8Array(2 * 1024 * 1024);
    largeBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    largeBytes.fill(0x41, 8);
    const largePath = path.join(root, "large.png");
    await writeFile(largePath, largeBytes);
    const sha256 = createHash("sha256").update(largeBytes).digest("hex");
    const sessions = new StudioSessionManager({
      now: () => BASE_NOW,
      createId: () => "session-http",
      createToken: (() => {
        const values = ["http-session-token-long-enough", "http-launch-token-long-enough"];
        return () => values.shift() ?? "http-token-fallback-long-enough";
      })()
    });
    const sessionContext = new StudioRequestSessionContext();
    const closeLease = vi.fn();
    const routeService: Pick<LocalRoutegoService, "getUploadResourceStatus"> &
      ProductionStudioStreamService = {
      getUploadResourceStatus: async () => {
        throw new Error("Unexpected upload status call");
      },
      executeStudioStream: () => {
        throw new Error("Unexpected stream call");
      }
    };
    const routes = createIntegrationRuntimeRoutes({
      service: routeService,
      library: {
        stageUpload: async () => { throw new Error("Unexpected upload call"); },
        resolveBrowserResource: () => { throw new Error("Unexpected durable call"); },
        preflightLibraryMutation: async () => { throw new Error("Unexpected Library preflight"); },
        executeLibraryMutation: async () => { throw new Error("Unexpected Library execution"); },
        getAssetDetail: async () => { throw new Error("Unexpected Library detail read"); },
        galleryService: {
          copyGenerationInfo: async () => { throw new Error("Unexpected Library copy"); }
        }
      },
      ephemeralResources: {
        open: async () => ({
          descriptor: {
            resourceId: "large-image",
            relativeUrl: "/api/v1/resources/large-image",
            requiresSession: true,
            mimeType: "image/png",
            byteLength: largeBytes.byteLength,
            width: 1,
            height: 1,
            etag: `sha256-${sha256}`,
            expiresAt: new Date(BASE_NOW + 5 * 60_000).toISOString()
          },
          path: largePath,
          mimeType: "image/png",
          byteLength: largeBytes.byteLength,
          width: 1,
          height: 1,
          sha256,
          signal: new AbortController().signal,
          close: async () => { closeLease(); }
        })
      },
      sessions,
      sessionContext,
      now: () => new Date(BASE_NOW),
      resourceChunkBytes: 64 * 1024
    });
    const staticAssets = await StudioStaticAssetRegistry.load({
      rootDirectory: staticRoot,
      assets: { "/assets/index.js": "index.js" }
    });
    const host = new IntegrationLoopbackHttpHost({
      service: unusedService(),
      localService: routeService as unknown as LocalRoutegoService,
      address: "127.0.0.1",
      port: 0,
      staticAssets,
      entryModuleRoute: "/assets/index.js",
      sessions,
      extensionHandler: routes
    });
    cleanups.push(async () => await host.close());
    const launch = await host.openStudioSession();
    const address = host.address;
    if (address === undefined) throw new Error("HTTP host did not start");
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(`${address.origin}/api/v1/resources/large-image`, {
        headers: {
          origin: address.origin,
          "x-routego-session": launch.session.sessionToken
        }
      }, (response) => {
        try {
          expect(response.statusCode).toBe(200);
          expect(response.headers["content-type"]).toBe("image/png");
          expect(response.headers["content-length"]).toBe(String(largeBytes.byteLength));
        } catch (error) {
          response.destroy();
          reject(error);
          return;
        }
        response.once("data", () => {
          response.destroy();
          resolve();
        });
        response.once("error", reject);
      });
      request.once("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
      });
      request.end();
    });
    await vi.waitFor(() => {
      expect(closeLease).toHaveBeenCalledTimes(1);
    });
  });
});

describe("Task 4.4 Studio provider switch route", () => {
  it("uses the registered authenticated Studio route and returns only the safe switch projection", async () => {
    const studioProviderSwitch = vi.fn(async () => studioProviderSwitchResultSchema.parse({
      schemaVersion: 1,
      status: "succeeded",
      activeProviderId: "provider-b",
      selectedModel: "fallback-model",
      modelPreserved: false,
      profile: {
        id: "provider-b",
        name: "Synthetic provider B",
        endpoints: {
          generation: {
            mode: "legacy-api-base",
            origin: "https://relay.example",
            pathname: "/v1",
            hasQuery: false,
            display: "https://relay.example/v1"
          }
        },
        defaultModel: "fallback-model",
        models: ["fallback-model"],
        hasApiKey: true,
        isActive: true,
        createdAt: new Date(BASE_NOW).toISOString(),
        updatedAt: new Date(BASE_NOW).toISOString()
      },
      appliesToFutureSubmissionsOnly: true
    }));
    const dispatcher = createRoutegoHttpDispatcher({
      service: unusedService(),
      localService: new Proxy({ studioProviderSwitch }, {
        get(target, property) {
          if (property in target) return target[property as keyof typeof target];
          return async () => { throw new Error(`Unexpected local call: ${String(property)}`); };
        }
      }) as unknown as LocalRoutegoService,
      expectedSessionToken: TOKEN_A,
      allowedOrigins: [ORIGIN]
    });
    const response = await dispatcher.dispatch(jsonRequest("/api/v1/studio/provider-switch", {
      profileId: "provider-b",
      preferredModel: "active-model"
    }));
    expect(response.status).toBe(200);
    expect(json(response)).toMatchObject({
      activeProviderId: "provider-b",
      selectedModel: "fallback-model",
      appliesToFutureSubmissionsOnly: true
    });
    expect(studioProviderSwitch).toHaveBeenCalledWith({
      schemaVersion: 1,
      profileId: "provider-b",
      preferredModel: "active-model"
    });
    expect(JSON.stringify(json(response))).not.toMatch(/credential|apiKey|authorization/u);
  });
});

describe("Task 4.3 browser-safe Library routes", () => {
  it("marks through the Library preflight/execution flow and copies only projected information", async () => {
    const created = await createHarness();
    const preflight = vi.spyOn(created.library, "preflightLibraryMutation").mockResolvedValue({
      schemaVersion: 1,
      preflightId: "mark-preflight",
      action: "mark",
      status: "ready",
      expiresAt: new Date(BASE_NOW + 60_000).toISOString(),
      requiredConfirmations: [],
      items: [{
        targetId: "asset-output",
        targetKind: "asset",
        eligible: true,
        currentStatus: "succeeded",
        allowedActions: ["mark", "copy-generation-info"],
        requiredConfirmations: [],
        warnings: []
      }],
      warnings: []
    } as never);
    const execute = vi.spyOn(created.library, "executeLibraryMutation").mockResolvedValue({
      schemaVersion: 1,
      preflightId: "mark-preflight",
      action: "mark",
      status: "succeeded",
      items: [{
        targetId: "asset-output",
        status: "succeeded",
        affectedAssetId: "asset-output",
        affectedFolderIds: [],
        warnings: []
      }],
      warnings: []
    } as never);
    const detail = vi.spyOn(created.library, "getAssetDetail")
      .mockResolvedValueOnce({ asset: { currentMark: true } } as never)
      .mockResolvedValueOnce({ asset: { currentMark: false } } as never);
    const copy = vi.spyOn(created.library.galleryService, "copyGenerationInfo").mockResolvedValue({
      schemaVersion: 1,
      status: "succeeded",
      projection: {
        recordId: "asset-output",
        prompt: "A safe deterministic prompt",
        referenceIds: ["reference-one"],
        parameters: {
          size: "auto",
          aspectRatio: "auto",
          quality: "auto",
          format: "png",
          count: 1,
          transparentMode: "off",
          moderation: "auto"
        }
      },
      clipboardText: "A safe deterministic prompt",
      providerRequestCount: 0
    } as never);
    const runtime = created.dispatcher();

    const preflightResponse = await runtime.dispatch(request("/api/v1/library/mark", {
      method: "OPTIONS",
      headers: { "access-control-request-method": "POST" }
    }));
    expect(preflightResponse.status).toBe(204);
    expect(preflightResponse.headers?.["access-control-allow-methods"]).toBe("POST, OPTIONS");

    const marked = await runtime.dispatch(jsonRequest("/api/v1/library/mark", { recordId: "asset-output" }));
    expect(marked.status).toBe(200);
    expect(json(marked)).toMatchObject({
      recordId: "asset-output",
      status: "succeeded",
      currentMarkRecordId: "asset-output",
      markCleared: false,
      providerRequestCount: 0,
    });
    expect(json(marked)).not.toHaveProperty("preflight");
    expect(json(marked)).not.toHaveProperty("execution");
    expect(preflight).toHaveBeenCalledWith({
      schemaVersion: 1,
      mutation: { action: "mark", assetIds: ["asset-output"] }
    });
    expect(execute).toHaveBeenCalledWith({
      schemaVersion: 1,
      preflightId: "mark-preflight",
      action: "mark",
      confirmations: []
    });
    expect(detail).toHaveBeenCalledWith({ schemaVersion: 1, assetId: "asset-output" });

    const cleared = await runtime.dispatch(jsonRequest("/api/v1/library/mark", { recordId: "asset-output" }));
    expect(cleared.status).toBe(200);
    expect(json(cleared)).toEqual({
      schemaVersion: 1,
      status: "succeeded",
      recordId: "asset-output",
      markCleared: true,
      providerRequestCount: 0
    });

    const copied = await runtime.dispatch(jsonRequest("/api/v1/library/copy-generation-info", { recordId: "asset-output" }));
    expect(copied.status).toBe(200);
    expect(json(copied)).toMatchObject({
      status: "succeeded",
      projection: { recordId: "asset-output", referenceIds: ["reference-one"] },
      providerRequestCount: 0
    });
    expect(copy).toHaveBeenCalledWith({ schemaVersion: 1, recordId: "asset-output" });
    expect(JSON.stringify(json(copied))).not.toMatch(/path|Authorization|data:image|base64/u);
  });

  it("rejects invalid, cross-origin, oversized, and removed routes before Library work", async () => {
    const created = await createHarness();
    const preflight = vi.spyOn(created.library, "preflightLibraryMutation");
    const execute = vi.spyOn(created.library, "executeLibraryMutation");
    const copy = vi.spyOn(created.library.galleryService, "copyGenerationInfo");
    const runtime = created.dispatcher();

    const invalid = await runtime.dispatch(jsonRequest("/api/v1/library/mark", {
      recordId: "asset-output",
      unexpected: true
    }));
    expect(invalid.status).toBe(400);
    const evasive = await runtime.dispatch(request("/api/v1/library/mark", {
      method: "POST",
      headers: { "content-type": "application/json-evasive" },
      body: chunks('{"recordId":"asset-output"}')
    }));
    expect(evasive.status).toBe(415);
    const oversized = await runtime.dispatch(request("/api/v1/library/copy-generation-info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chunks(new Uint8Array(64 * 1024 + 1))
    }));
    expect(oversized.status).toBe(413);
    const crossOrigin = await runtime.dispatch(jsonRequest("/api/v1/library/mark", { recordId: "asset-output" }, {
      origin: "https://example.invalid"
    }));
    expect(crossOrigin.status).toBe(403);

    for (const pathname of [
      "/api/v1/edit",
      "/api/v1/library/trash",
      "/api/v1/library/delete",
      "/api/v1/library/restore",
      "/api/v1/library/permanent-delete",
      "/api/v1/library/migration/preflight",
      "/api/v1/library/migration/confirmation"
    ]) {
      const removed = await runtime.dispatch(jsonRequest(pathname, { recordId: "asset-output" }));
      expect(removed.status).toBe(404);
    }
    expect(preflight).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });

  it("does not execute an ineligible mark preflight", async () => {
    const created = await createHarness();
    const preflight = vi.spyOn(created.library, "preflightLibraryMutation").mockResolvedValue({
      schemaVersion: 1,
      preflightId: "blocked-mark-preflight",
      action: "mark",
      status: "blocked",
      expiresAt: new Date(BASE_NOW + 60_000).toISOString(),
      requiredConfirmations: [],
      items: [{
        targetId: "missing-record",
        targetKind: "asset",
        eligible: false,
        allowedActions: [],
        requiredConfirmations: [],
        warnings: [],
        error: {
          code: "not_found",
          category: "persistence",
          stage: "persist",
          safeMessage: "The selected Library asset does not exist.",
          retryDisposition: "never",
          partialArtifacts: [],
          receivedAnyOutput: false,
          mayHaveBilled: false
        }
      }],
      warnings: []
    } as never);
    const execute = vi.spyOn(created.library, "executeLibraryMutation");

    const response = await created.dispatcher().dispatch(
      jsonRequest("/api/v1/library/mark", { recordId: "missing-record" })
    );
    expect(response.status).toBe(409);
    expect(json(response)).toEqual({
      schemaVersion: 1,
      status: "failed",
      recordId: "missing-record",
      markCleared: false,
      providerRequestCount: 0,
      error: {
        code: "not_found",
        category: "persistence",
        stage: "persist",
        safeMessage: "The selected Library asset does not exist.",
        retryDisposition: "never",
        partialArtifacts: [],
        receivedAnyOutput: false,
        mayHaveBilled: false
      }
    });
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("task 4.2 production stream wiring", () => {
  it("uses request-scoped session ownership for the only production stream route", async () => {
    const capturedSessions: string[] = [];
    let sessionContext: StudioRequestSessionContext;
    const executeStudioStream: ProductionStudioStreamService["executeStudioStream"] = (input) => {
      const session = sessionContext.requireSession();
      capturedSessions.push(session.id);
      const requestId = `request-${session.id}`;
      const error = studioServiceErrorSchema.parse({
        code: "capability_unavailable",
        category: "capability",
        stage: "route",
        safeMessage: "The synthetic route is unavailable safely.",
        retryDisposition: "safe-pre-generation",
        partialArtifacts: [],
        receivedAnyOutput: false,
        mayHaveBilled: false
      });
      return (async function* () {
        yield {
          type: "started",
          requestId,
          sequence: 0,
          occurredAt: new Date(BASE_NOW).toISOString(),
          requestedParams: input
        };
        yield {
          type: "failed",
          requestId,
          sequence: 1,
          occurredAt: new Date(BASE_NOW).toISOString(),
          error,
          receivedAnyOutput: false,
          mayHaveBilled: false
        };
      })();
    };
    const harness = await createHarness({ executeStudioStream });
    sessionContext = harness.sessionContext;
    const input = generateRequest();

    for (const token of [TOKEN_A, TOKEN_B]) {
      const body = JSON.stringify(input);
      const response = await harness.dispatcher(token).dispatch(request(
        STUDIO_CREATION_STREAM_PATH,
        {
          method: "POST",
          token,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: chunks(body)
        }
      ));
      expect(response.status).toBe(200);
      expect(await responseText(response)).toMatch(/"type":"started"[\s\S]*"type":"failed"/u);
    }
    expect(capturedSessions).toEqual(["session-a", "session-b"]);

    const alternate = await harness.dispatcher().dispatch(jsonRequest(
      "/api/v1/studio/creation/events",
      input
    ));
    expect(alternate.status).toBe(404);
  });
});
