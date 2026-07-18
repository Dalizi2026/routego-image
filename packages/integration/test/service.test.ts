import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { access, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";

import {
  capabilityProbeInputSchema,
  imageArtifactPhaseSchema,
  imageOperationRequestSchema,
  imageOperationResultSchema,
  routegoOperationDefinitions,
  routegoOperationNames,
  routegoServiceErrorSchema,
  studioGenerateInputSchema,
  studioImageOperationEventSchema,
  studioOperationNames,
  type ImageArtifact,
  type ImageOperationRequest,
  type ImageOperationResult,
  type LocalRoutegoService,
  type StudioImageOperationEvent,
  type StudioImageOperationRequest
} from "@routego-image/contracts";
import { createRoutegoLibraryService, type RoutegoLibraryService } from "@routego-image/library";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ProductionLocalRoutegoService,
  createLocalRoutegoService,
  type CreationExecution,
  type LocalRoutegoServiceOptions
} from "../src/composition/service";
import {
  createEphemeralImageResourceRegistry,
  type EphemeralImageResourceRegistry
} from "../src/runtime/ephemeral-resources";

const BASE_NOW = new Date("2026-07-19T08:00:00.000Z");
const roots: string[] = [];
const services: ProductionLocalRoutegoService[] = [];

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map(async (service) => await service.close()));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

const LOCAL_METHODS = [
  "status",
  "generate",
  "edit",
  "batch",
  "searchLibrary",
  "manageLibrary",
  "openStudio",
  "readSettings",
  "upsertProviderProfile",
  "removeProviderProfile",
  "setActiveProviderProfile",
  "refreshModels",
  "probeCapabilities",
  "updateSettings",
  "searchStudioLibrary",
  "listFolders",
  "reorderFolders",
  "getAssetDetail",
  "getBrowserResource",
  "preflightLibraryMutation",
  "executeLibraryMutation",
  "reserveUploadResource",
  "finalizeUploadResource",
  "getUploadResourceStatus",
  "discardUploadResource",
  "studioGenerate",
  "studioEdit",
  "studioBatch"
] as const satisfies readonly (keyof LocalRoutegoService)[];

function pngBytes(width = 3, height = 2, color = 0x45): Buffer {
  const png = new PNG({ width, height });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = color;
    png.data[offset + 1] = (color + 30) & 0xff;
    png.data[offset + 2] = (color + 60) & 0xff;
    png.data[offset + 3] = 0xff;
  }
  return PNG.sync.write(png);
}

function artifact(
  id: string,
  phase: "partial" | "final",
  slot = 0,
  color = phase === "partial" ? 0x25 : 0x55
): ImageArtifact {
  const bytes = pngBytes(3 + slot, 2 + slot, color);
  return {
    id,
    slot,
    phase,
    mimeType: "image/png",
    byteLength: bytes.byteLength,
    width: 3 + slot,
    height: 2 + slot,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    display: { type: "image", dataUrl: `data:image/png;base64,${bytes.toString("base64")}` },
    createdAt: BASE_NOW.toISOString()
  };
}

function succeededResult(
  request: ImageOperationRequest,
  requestId: string,
  options: { readonly partial?: boolean; readonly degraded?: boolean } = {}
): ImageOperationResult {
  const final = artifact(`${requestId}:final`, "final");
  const partial = options.partial ? [artifact(`${requestId}:partial`, "partial")] : [];
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
      degradedContinuation: options.degraded === true,
      providerImageIds: []
    },
    finalArtifacts: [final],
    partialArtifacts: partial,
    failedSlots: [],
    relationships: [
      ...partial.map((item, index) => ({
        inputRole: "stream-partial" as const,
        outputArtifactId: item.id,
        order: index
      })),
      { inputRole: "output" as const, outputArtifactId: final.id, order: partial.length }
    ]
  });
}

function cancelledResult(request: ImageOperationRequest, requestId: string): ImageOperationResult {
  const error = routegoServiceErrorSchema.parse({
    code: "cancelled",
    category: "cancelled",
    stage: "complete",
    safeMessage: "The synthetic operation was cancelled.",
    retryDisposition: "never",
    partialArtifacts: [],
    receivedAnyOutput: false,
    mayHaveBilled: false
  });
  return imageOperationResultSchema.parse({
    schemaVersion: 1,
    requestId,
    status: "cancelled",
    requestedParams: request,
    effectiveParams: request,
    execution: {
      attemptCount: 0,
      providerRequestCount: 0,
      receivedAnyOutput: false,
      mayHaveBilled: false,
      degradedContinuation: false,
      providerImageIds: []
    },
    finalArtifacts: [],
    partialArtifacts: [],
    failedSlots: [{ slot: 0, error }],
    relationships: [],
    error
  });
}

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `routego-service-${prefix}-`));
  roots.push(root);
  return root;
}

async function createLibrary(root: string): Promise<RoutegoLibraryService> {
  const counters = new Map<string, number>();
  const next = (kind: string) => {
    const value = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, value);
    return `${kind}-${value}`;
  };
  return createRoutegoLibraryService({
    homeDirectory: path.join(root, "home"),
    now: () => new Date(BASE_NOW),
    settings: {
      dataRoot: path.join(root, "data"),
      idFactory: () => next("provider"),
      protectCredentialFile: async () => undefined
    },
    uploads: { dataRoot: path.join(root, "data"), idFactory: () => next("upload") },
    index: { root: path.join(root, "library") },
    assets: { protectedRoots: [], idFactory: (kind) => next(kind) },
    resources: { idFactory: (kind) => next(`resource-${kind}`) },
    read: { folderIdFactory: () => next("folder") },
    mutations: { protectedRoots: [], idFactory: (kind) => next(kind) },
    portability: { idFactory: (kind) => next(kind) },
    publicProtectedRoots: []
  });
}

interface Harness {
  readonly root: string;
  readonly output: string;
  readonly library: RoutegoLibraryService;
  readonly registry: EphemeralImageResourceRegistry;
  readonly service: ProductionLocalRoutegoService;
}

async function createHarness(options: {
  readonly executeCreation?: CreationExecution;
  readonly fetch?: typeof fetch;
  readonly recoverFailure?: boolean;
} = {}): Promise<Harness> {
  const root = await createRoot("harness");
  const output = path.join(root, "output");
  await mkdir(output, { recursive: true });
  const library = await createLibrary(root);
  if (options.recoverFailure === true) {
    vi.spyOn(library, "recover").mockRejectedValueOnce(new Error("synthetic recovery failure"));
  }
  const registry = await createEphemeralImageResourceRegistry({
    root: path.join(root, "ephemeral"),
    now: () => new Date(BASE_NOW),
    idFactory: (() => {
      let value = 0;
      return () => `ephemeral-${++value}`;
    })()
  });
  let identity = 0;
  const defaultExecution: CreationExecution = async (request, context) =>
    succeededResult(request, context.requestId);
  const serviceOptions: LocalRoutegoServiceOptions = {
    library,
    stagingRoot: path.join(root, "staging"),
    ephemeralResources: registry,
    studioSession: () => ({
      id: "session-service-test",
      expiresAt: new Date(BASE_NOW.getTime() + 10 * 60_000).toISOString()
    }),
    openStudio: async (input) => ({
      schemaVersion: 1,
      url: `http://${input.address === "::1" ? "[::1]" : input.address}:43119/?token=synthetic-session-token`,
      expiresAt: new Date(BASE_NOW.getTime() + 5 * 60_000).toISOString(),
      reused: input.reuseExisting,
      address: input.address
    }),
    serviceHealth: {
      status: "ready",
      version: "1.0.0-test",
      nodeVersion: process.version,
      uptimeSeconds: 0,
      mcpAvailable: false,
      httpAvailable: false,
      studioAvailable: true
    },
    approveOutputDirectory: async (requested) => requested,
    now: () => new Date(BASE_NOW),
    createId: (scope) => `${scope}-${++identity}`,
    executeCreation: options.executeCreation ?? defaultExecution,
    defaultModel: "synthetic-model",
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  };
  const service = await createLocalRoutegoService(serviceOptions);
  services.push(service);
  return { root, output, library, registry, service };
}

function publicRequest(overrides: Partial<ImageOperationRequest> = {}): ImageOperationRequest {
  return imageOperationRequestSchema.parse({
    kind: "generate",
    prompt: "A synthetic production service result",
    ...overrides
  });
}

function studioRequest(
  overrides: Partial<Extract<StudioImageOperationRequest, { kind: "generate" }>> = {}
): Extract<StudioImageOperationRequest, { kind: "generate" }> {
  return studioGenerateInputSchema.parse({
    kind: "generate",
    prompt: "A synthetic production service result",
    references: [],
    ...overrides
  });
}

async function collectEvents(source: AsyncIterable<StudioImageOperationEvent>) {
  const events: StudioImageOperationEvent[] = [];
  for await (const event of source) events.push(studioImageOperationEventSchema.parse(event));
  return events;
}

describe("task 3.5 contract surface and recovery", () => {
  it("implements the exact local method matrix while preserving seven public tools and phases", async () => {
    const { service } = await createHarness();
    expect(LOCAL_METHODS).toHaveLength(28);
    for (const method of LOCAL_METHODS) expect(typeof service[method]).toBe("function");
    expect(routegoOperationNames).toEqual([
      "status", "generate", "edit", "batch", "searchLibrary", "manageLibrary", "openStudio"
    ]);
    expect(Object.values(routegoOperationDefinitions).map((definition) => definition.toolName)).toEqual([
      "routego_status",
      "routego_generate",
      "routego_edit",
      "routego_batch",
      "routego_search_library",
      "routego_manage_library",
      "routego_open_studio"
    ]);
    expect(studioOperationNames).toHaveLength(21);
    expect(imageArtifactPhaseSchema.options).toEqual(["partial", "final"]);
    expect(imageArtifactPhaseSchema.safeParse("source").success).toBe(false);
  });

  it("reports ready health without turning status refresh into an unscoped billable probe", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { service } = await createHarness({ fetch: fetchMock });
    const status = await service.status({ refreshCapabilities: true, confirmBillableProbe: true });
    expect(status).toMatchObject({
      configured: false,
      hasApiKey: false,
      service: { status: "ready", studioAvailable: true }
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const refresh = await service.refreshModels({ providerId: "missing-provider" });
    expect(refresh).toMatchObject({ status: "failed", billable: false, models: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => capabilityProbeInputSchema.parse({
      providerId: "missing-provider",
      model: "synthetic-model",
      capability: "single-image-input",
      transport: "single-endpoint-json",
      requestShape: "single-endpoint:image",
      confirmBillableProbe: false
    })).toThrow();
  });

  it("stays degraded after recovery failure and never invokes Creation", async () => {
    const execute = vi.fn<CreationExecution>();
    const { service } = await createHarness({ executeCreation: execute, recoverFailure: true });
    expect((await service.status({})).service.status).toBe("degraded");
    const result = await service.generate(publicRequest());
    expect(result).toMatchObject({ status: "failed", error: { code: "config_corrupt" } });
    const events = await collectEvents(service.executeStudioStream(studioRequest()));
    expect(events.map((event) => event.type)).toEqual(["started", "failed"]);
    expect(events[1]).toMatchObject({ type: "failed", error: { code: "config_corrupt" } });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("task 3.5 public composition", () => {
  it("materializes one saved public result and exposes the same durable state to Studio", async () => {
    const { service } = await createHarness();
    const result = await service.generate(publicRequest());
    expect(result).toMatchObject({
      status: "succeeded",
      execution: { providerRequestCount: 1 },
      finalArtifacts: [{ phase: "final", display: { dataUrl: expect.stringMatching(/^data:image\/png;base64,/u) } }]
    });
    await expect(access(result.finalArtifacts[0]!.path!)).resolves.toBeUndefined();
    const publicSearch = await service.searchLibrary({});
    const studioSearch = await service.searchStudioLibrary({});
    expect(publicSearch.items).toHaveLength(1);
    expect(studioSearch.items).toHaveLength(1);
    expect(studioSearch.items[0]?.assetId).toBe(publicSearch.items[0]?.id);
    expect(JSON.stringify(studioSearch)).not.toMatch(/data:image|base64|"path"/u);
  });

  it("rejects an unsaved request without an output directory before provider work", async () => {
    const execute = vi.fn<CreationExecution>();
    const { service, library } = await createHarness({ executeCreation: execute });
    const result = await service.generate(publicRequest({ saveToLibrary: false }));
    expect(result).toMatchObject({ status: "failed", error: { code: "invalid_input" } });
    expect(execute).not.toHaveBeenCalled();
    expect((await library.indexStore.read()).assets).toHaveLength(0);
  });

  it("fails closed on an invalid Creation result and cleans request staging", async () => {
    const execute = vi.fn<CreationExecution>(async () => ({ unsafe: true }));
    const { service, library, root } = await createHarness({ executeCreation: execute });
    const result = await service.generate(publicRequest());
    expect(result).toMatchObject({ status: "failed", error: { code: "internal_contract" } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await library.indexStore.read()).assets).toHaveLength(0);
    expect(await readdir(path.join(root, "staging"))).toEqual([]);
  });

  it("bounds batch concurrency and preserves input order and per-item request counts", async () => {
    let active = 0;
    let maximum = 0;
    const execute: CreationExecution = async (request, context) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, request.prompt.endsWith("2") ? 5 : 15));
      active -= 1;
      return succeededResult(request, context.requestId);
    };
    const { service, output } = await createHarness({ executeCreation: execute });
    const ids = ["task-1", "task-2", "task-3", "task-4"];
    const result = await service.batch({
      concurrency: 2,
      tasks: ids.map((id) => ({
        id,
        operation: publicRequest({ prompt: id, saveToLibrary: false, outputDir: output })
      }))
    });
    expect(maximum).toBeLessThanOrEqual(2);
    expect(result.status).toBe("succeeded");
    expect(result.items.map((item) => item.id)).toEqual(ids);
    expect(result.items.map((item) => item.result.execution.providerRequestCount)).toEqual([1, 1, 1, 1]);
  });
});

describe("task 3.5 Studio composition, events, and cancellation", () => {
  it("streams path-free partials, commits one result, and emits one ordered terminal event", async () => {
    const execute: CreationExecution = async (request, context) => {
      const result = succeededResult(request, context.requestId, { partial: true });
      await context.onEvent?.({
        type: "partial",
        requestId: context.requestId,
        sequence: 1,
        occurredAt: BASE_NOW.toISOString(),
        artifact: result.partialArtifacts[0]!
      });
      return result;
    };
    const { service } = await createHarness({ executeCreation: execute });
    const events = await collectEvents(service.executeStudioStream(studioRequest({ saveToLibrary: true })));
    expect(events.map((event) => event.type)).toEqual(["started", "partial", "completed"]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(new Set(events.map((event) => event.requestId)).size).toBe(1);
    const partial = events[1];
    expect(partial?.type).toBe("partial");
    if (partial?.type === "partial") {
      expect(partial.artifact.resource.relativeUrl).toMatch(/^\/api\/v1\/resources\//u);
      expect(partial.artifact.resource.expiresAt).toBe("2026-07-19T08:05:00.000Z");
    }
    const completed = events[2];
    expect(completed?.type).toBe("completed");
    if (completed?.type === "completed") expect(completed.result.status).toBe("succeeded");
    expect(JSON.stringify(events)).not.toMatch(/data:image|base64|[A-Z]:\\|"path"/u);
  });

  it("retains a validated partial and redacts internal failure details in the terminal event", async () => {
    const execute: CreationExecution = async (_request, context) => {
      await context.onEvent?.({
        type: "partial",
        requestId: context.requestId,
        sequence: 1,
        occurredAt: BASE_NOW.toISOString(),
        artifact: artifact(`${context.requestId}:partial`, "partial")
      });
      throw new Error(
        "Authorization: Bearer synthetic-secret C:\\Users\\Synthetic\\Library\\private.png"
      );
    };
    const { service } = await createHarness({ executeCreation: execute });
    const events = await collectEvents(service.executeStudioStream(studioRequest()));
    expect(events.map((event) => event.type)).toEqual(["started", "partial", "failed"]);
    const failed = events[2];
    expect(failed).toMatchObject({
      type: "failed",
      error: {
        code: "internal_contract",
        receivedAnyOutput: true,
        mayHaveBilled: true,
        partialArtifacts: [{ phase: "partial" }]
      },
      receivedAnyOutput: true,
      mayHaveBilled: true
    });
    const rendered = JSON.stringify(events);
    expect(rendered).not.toContain("synthetic-secret");
    expect(rendered).not.toContain("C:\\Users\\Synthetic");
    expect(rendered).not.toMatch(/data:image|base64|"path"/u);
  });

  it("uses the same Library instance for Studio creation and public search", async () => {
    const { service } = await createHarness();
    const result = await service.studioGenerate(studioRequest({ saveToLibrary: true }));
    expect(result.status).toBe("succeeded");
    const assetId = result.finalArtifacts[0]?.assetId;
    expect(assetId).toBeDefined();
    expect((await service.searchLibrary({})).items[0]?.id).toBe(assetId);
    const detail = await service.getAssetDetail({ assetId: assetId! });
    expect(detail.asset?.primaryArtifactId).toBe(result.finalArtifacts[0]?.artifactId);
    expect(JSON.stringify(result)).not.toMatch(/data:image|base64|"path"/u);
  });

  it("propagates cancellation to the active operation and returns one failed terminal event", async () => {
    const execute: CreationExecution = async (request, context) => {
      if (!context.signal.aborted) {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return cancelledResult(request, context.requestId);
    };
    const { service } = await createHarness({ executeCreation: execute });
    const iterator = service.executeStudioStream(studioRequest())[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.type).toBe("started");
    expect(service.cancelOperation(first.value!.requestId)).toBe(true);
    const rest: StudioImageOperationEvent[] = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({
      type: "failed",
      sequence: 1,
      error: { code: "cancelled" },
      receivedAnyOutput: false,
      mayHaveBilled: false
    });
  });
});
