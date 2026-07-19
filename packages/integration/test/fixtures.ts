import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";

import {
  imageOperationRequestSchema,
  imageOperationResultSchema,
  studioGenerateInputSchema,
  studioImageOperationEventSchema,
  type ImageArtifact,
  type ImageOperationRequest,
  type ImageOperationResult,
  type RoutegoService,
  type StudioImageOperationEvent,
  type StudioImageOperationRequest
} from "@routego-image/contracts";
import {
  createRoutegoHttpDispatcher,
  type RoutegoHttpRequest,
  type RoutegoHttpResponse
} from "@routego-image/creation";
import { createRoutegoLibraryService, type RoutegoLibraryService } from "@routego-image/library";
import { PNG } from "pngjs";

import {
  ProductionLocalRoutegoService,
  createLocalRoutegoService,
  type CreationExecution
} from "../src/composition/service";
import {
  createEphemeralImageResourceRegistry,
  type EphemeralImageResourceRegistry
} from "../src/runtime/ephemeral-resources";
import {
  StudioRequestSessionContext,
  createIntegrationRuntimeRoutes
} from "../src/runtime/routes";
import { STUDIO_CREATION_STREAM_PATH } from "../src/runtime/stream-route";
import type { RoutegoMcpInput, RoutegoMcpOutput } from "../src/runtime/mcp-process";

export const FIXED_NOW = Date.parse("2026-07-20T08:00:00.000Z");
export const STUDIO_ORIGIN = "http://127.0.0.1:43119";
export const STUDIO_TOKEN = "synthetic-task-6-1-session-token";
export const STUDIO_SESSION_ID = "synthetic-task-6-1-session";

export interface OfflineHarness {
  readonly root: string;
  readonly outputRoot: string;
  readonly clock: { now: number };
  readonly library: RoutegoLibraryService;
  readonly registry: EphemeralImageResourceRegistry;
  readonly service: ProductionLocalRoutegoService;
  readonly executeCreation: CreationExecution;
  dispatchStudio(input: StudioImageOperationRequest, options?: {
    readonly token?: string;
    readonly pathname?: string;
    readonly signal?: AbortSignal;
  }): Promise<RoutegoHttpResponse>;
  close(): Promise<void>;
}

export function syntheticPng(width = 2, height = 2, color = 0x35): Buffer {
  const png = new PNG({ width, height });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = color;
    png.data[offset + 1] = (color + 31) & 0xff;
    png.data[offset + 2] = (color + 63) & 0xff;
    png.data[offset + 3] = 0xff;
  }
  const bytes = PNG.sync.write(png);
  const decoded = PNG.sync.read(bytes);
  if (decoded.width !== width || decoded.height !== height) {
    throw new Error("The deterministic PNG fixture failed validation.");
  }
  return bytes;
}

export function syntheticArtifact(
  id: string,
  phase: "partial" | "final",
  slot = 0,
  color = phase === "partial" ? 0x25 : 0x55
): ImageArtifact {
  const bytes = syntheticPng(2 + slot, 2 + slot, color);
  return {
    id,
    slot,
    phase,
    mimeType: "image/png",
    byteLength: bytes.byteLength,
    width: 2 + slot,
    height: 2 + slot,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    display: { type: "image", dataUrl: `data:image/png;base64,${bytes.toString("base64")}` },
    createdAt: new Date(FIXED_NOW).toISOString()
  };
}

export function syntheticResult(
  request: ImageOperationRequest,
  requestId: string,
  options: {
    readonly partialCount?: number;
    readonly finalCount?: number;
    readonly degradedContinuation?: boolean;
  } = {}
): ImageOperationResult {
  const partial = Array.from({ length: options.partialCount ?? 0 }, (_, index) =>
    syntheticArtifact(`${requestId}:partial:${index}`, "partial", index % 4, 0x20 + index)
  );
  const final = Array.from({ length: options.finalCount ?? 1 }, (_, index) =>
    syntheticArtifact(`${requestId}:final:${index}`, "final", index, 0x50 + index)
  );
  return imageOperationResultSchema.parse({
    schemaVersion: 1,
    requestId,
    status: "succeeded",
    requestedParams: request,
    effectiveParams: request,
    execution: {
      transport: "single-endpoint-json",
      attemptCount: 1,
      providerRequestCount: 1,
      receivedAnyOutput: true,
      mayHaveBilled: true,
      degradedContinuation: options.degradedContinuation ?? false,
      providerImageIds: []
    },
    finalArtifacts: final,
    partialArtifacts: partial,
    failedSlots: [],
    relationships: [
      ...partial.map((artifact, order) => ({
        inputRole: "stream-partial" as const,
        outputArtifactId: artifact.id,
        order
      })),
      ...final.map((artifact, index) => ({
        inputRole: "output" as const,
        outputArtifactId: artifact.id,
        order: partial.length + index
      }))
    ]
  });
}

export function publicGenerate(overrides: Partial<ImageOperationRequest> = {}): ImageOperationRequest {
  return imageOperationRequestSchema.parse({
    kind: "generate",
    prompt: "A deterministic offline Routego image",
    ...overrides
  });
}

export function studioGenerate(
  overrides: Partial<Extract<StudioImageOperationRequest, { kind: "generate" }>> = {}
): Extract<StudioImageOperationRequest, { kind: "generate" }> {
  return studioGenerateInputSchema.parse({
    kind: "generate",
    prompt: "一张完全离线的合成图片",
    references: [],
    ...overrides
  });
}

export async function collectStudioEvents(
  source: AsyncIterable<StudioImageOperationEvent>
): Promise<StudioImageOperationEvent[]> {
  const events: StudioImageOperationEvent[] = [];
  for await (const value of source) events.push(studioImageOperationEventSchema.parse(value));
  return events;
}

function unusedPublicService(): RoutegoService {
  return new Proxy({}, {
    get(_target, property) {
      return async () => {
        throw new Error(`Unexpected legacy public route: ${String(property)}`);
      };
    }
  }) as RoutegoService;
}

async function* bodyChunks(value: string): AsyncGenerator<string> {
  const middle = Math.floor(value.length / 2);
  yield value.slice(0, middle);
  yield value.slice(middle);
}

export async function responseText(response: RoutegoHttpResponse): Promise<string> {
  if (typeof response.body === "string") return response.body;
  if (response.body instanceof Uint8Array) return new TextDecoder().decode(response.body);
  if (response.body === undefined) return "";
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function createOfflineHarness(options: {
  readonly executeCreation?: CreationExecution;
  readonly recoverFailure?: Error;
  readonly sessionExpiresAt?: string;
} = {}): Promise<OfflineHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "routego-task-6-1-"));
  const clock = { now: FIXED_NOW };
  const outputRoot = path.join(root, "output");
  await mkdir(outputRoot, { recursive: true });
  const counters = new Map<string, number>();
  const next = (kind: string): string => {
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
    resources: { now: () => new Date(clock.now), idFactory: (kind) => next(`resource-${kind}`) },
    read: { folderIdFactory: () => next("folder") },
    mutations: { protectedRoots: [], idFactory: (kind) => next(kind) },
    portability: { idFactory: (kind) => next(kind) },
    publicProtectedRoots: []
  });
  if (options.recoverFailure !== undefined) {
    const failure = options.recoverFailure;
    library.recover = async () => await Promise.reject(failure);
  }
  const registry = await createEphemeralImageResourceRegistry({
    root: path.join(root, "ephemeral"),
    now: () => new Date(clock.now),
    idFactory: () => next("ephemeral")
  });
  const sessionExpiresAt = options.sessionExpiresAt ??
    new Date(FIXED_NOW + 10 * 60_000).toISOString();
  const executeCreation: CreationExecution = options.executeCreation ??
    (async (request, context) => syntheticResult(request, context.requestId));
  const service = await createLocalRoutegoService({
    library,
    stagingRoot: path.join(root, "staging"),
    ephemeralResources: registry,
    studioSession: () => ({ id: STUDIO_SESSION_ID, expiresAt: sessionExpiresAt }),
    openStudio: async (input) => ({
      schemaVersion: 1,
      url: `${STUDIO_ORIGIN}/?token=${STUDIO_TOKEN}`,
      expiresAt: sessionExpiresAt,
      reused: input.reuseExisting,
      address: input.address
    }),
    serviceHealth: {
      status: "ready",
      version: "1.0.0",
      nodeVersion: process.version,
      uptimeSeconds: 0,
      mcpAvailable: true,
      httpAvailable: true,
      studioAvailable: true
    },
    approveOutputDirectory: async (requested) => requested,
    now: () => new Date(clock.now),
    createId: (scope) => next(scope),
    executeCreation,
    defaultModel: "synthetic-offline-model",
    fetch: async () => {
      throw new Error("NETWORK_FORBIDDEN_TASK_6_1");
    }
  });
  const sessionContext = new StudioRequestSessionContext();
  const sessions = new Map([[STUDIO_TOKEN, {
    id: STUDIO_SESSION_ID,
    createdAt: new Date(FIXED_NOW).toISOString(),
    expiresAt: sessionExpiresAt
  }]]);
  const routes = createIntegrationRuntimeRoutes({
    service,
    library,
    ephemeralResources: registry,
    sessions: { authorizeSessionToken: (token) => sessions.get(token) },
    sessionContext,
    now: () => new Date(clock.now)
  });
  let closed = false;
  return {
    root,
    outputRoot,
    clock,
    library,
    registry,
    service,
    executeCreation,
    async dispatchStudio(input, dispatchOptions = {}) {
      const token = dispatchOptions.token ?? STUDIO_TOKEN;
      const body = JSON.stringify(input);
      const request: RoutegoHttpRequest = {
        method: "POST",
        url: new URL(dispatchOptions.pathname ?? STUDIO_CREATION_STREAM_PATH, STUDIO_ORIGIN),
        headers: {
          origin: STUDIO_ORIGIN,
          "x-routego-session": token,
          "content-type": "application/json; charset=utf-8"
        },
        body: bodyChunks(body),
        signal: dispatchOptions.signal ?? new AbortController().signal
      };
      return await createRoutegoHttpDispatcher({
        service: unusedPublicService(),
        localService: service,
        expectedSessionToken: token,
        allowedOrigins: [STUDIO_ORIGIN],
        extensionHandler: routes
      }).dispatch(request);
    },
    async close() {
      if (closed) return;
      closed = true;
      await service.close().catch(() => undefined);
      await registry.shutdown().catch(() => 0);
      await rm(root, { recursive: true, force: true });
    }
  };
}

export function sseRecord(event: StudioImageOperationEvent): string {
  return `id: ${event.requestId}:${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function readableSse(text: string, chunkSize = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      }
      controller.close();
    }
  });
}

export class ControlledMcpInput implements RoutegoMcpInput {
  readonly #queued: Array<Uint8Array | string> = [];
  readonly #waiting: Array<(value: IteratorResult<Uint8Array | string>) => void> = [];
  #ended = false;

  readonly destroy = (): void => this.end();

  push(value: string): void {
    const waiting = this.#waiting.shift();
    if (waiting === undefined) this.#queued.push(value);
    else waiting({ done: false, value });
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiting of this.#waiting.splice(0)) waiting({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array | string> {
    return {
      next: async () => {
        const value = this.#queued.shift();
        if (value !== undefined) return { done: false, value };
        if (this.#ended) return { done: true, value: undefined };
        return await new Promise((resolve) => this.#waiting.push(resolve));
      }
    };
  }
}

export class MemoryMcpOutput extends EventEmitter implements RoutegoMcpOutput {
  readonly chunks: string[] = [];
  destroyed = false;
  writableEnded = false;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  responses(): Array<Record<string, unknown>> {
    return this.chunks.join("").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}
