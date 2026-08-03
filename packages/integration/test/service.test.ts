import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";

import {
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
import { decode as decodeJpeg } from "jpeg-js";
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

describe("Task 4.2 batch snapshots", () => {
  it("uses fixed concurrency two and preserves public batch order", async () => {
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
      tasks: ids.map((id) => ({
        id,
        operation: publicRequest({ prompt: id, saveToLibrary: false, outputDir: output })
      }))
    });
    expect(result.concurrency).toBe(2);
    expect(maximum).toBe(2);
    expect(result.items.map((item) => item.id)).toEqual(ids);
  });

  it("keeps Studio global controls from the submission snapshot", async () => {
    const observed: ImageOperationRequest[] = [];
    let release: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const execute: CreationExecution = async (request, context) => {
      observed.push(request);
      await hold;
      return succeededResult(request, context.requestId);
    };
    const { service } = await createHarness({ executeCreation: execute });
    const submitted = {
      tasks: ["studio-1", "studio-2"].map((id) => ({
        id,
        operation: studioGenerateInputSchema.parse({
          kind: "generate", prompt: id, format: "png", transparentMode: "native"
        })
      }))
    };
    const pending = service.studioBatch(submitted);
    submitted.tasks[0]!.operation.format = "jpeg";
    submitted.tasks[0]!.operation.transparentMode = "off";
    release?.();
    const result = await pending;
    expect(result.concurrency).toBe(2);
    expect(observed.map((request) => [request.format, request.transparentMode])).toEqual([
      ["png", "native"],
      ["png", "native"]
    ]);
  });
});

const LOCAL_METHODS = [
  "status",
  "generate",
  "edit",
  "prepareRegeneration",
  "batch",
  "searchLibrary",
  "manageLibrary",
  "openStudio",
  "readSettings",
  "upsertProviderProfile",
  "removeProviderProfile",
  "setActiveProviderProfile",
  "studioProviderSwitch",
  "refreshModels",
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

function jpegBytes(width = 4, height = 3): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x12, 0x34, 0xff, 0x00, 0x56,
    0xff, 0xd9
  ]);
}

function artifact(
  id: string,
  phase: "partial" | "final",
  slot = 0,
  color = phase === "partial" ? 0x25 : 0x55,
  width = 3 + slot,
  height = 2 + slot
): ImageArtifact {
  const bytes = pngBytes(width, height, color);
  return {
    id,
    slot,
    phase,
    mimeType: "image/png",
    byteLength: bytes.byteLength,
    width,
    height,
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
  const exactSizeMatch = request.size === "auto" ? undefined : /^(\d+)x(\d+)$/u.exec(request.size);
  const exactSize = exactSizeMatch === null ? undefined : exactSizeMatch;
  const width = exactSize === undefined ? request.aspectRatio === "square" || request.aspectRatio === "1:1" ? 3 : 3 : Number(exactSize[1]);
  const height = exactSize === undefined ? request.aspectRatio === "square" || request.aspectRatio === "1:1" ? 3 : 2 : Number(exactSize[2]);
  const finals = Array.from({ length: request.count }, (_, slot) => artifact(`${requestId}:final:${slot}`, "final", slot, 0x55, width, height));
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
    finalArtifacts: finals,
    partialArtifacts: partial,
    failedSlots: [],
    relationships: [
      ...partial.map((item, index) => ({
        inputRole: "stream-partial" as const,
        outputArtifactId: item.id,
        order: index
      })),
      ...finals.map((item, index) => ({ inputRole: "output" as const, outputArtifactId: item.id, order: partial.length + index }))
    ]
  });
}

function succeededJpegResult(request: ImageOperationRequest, requestId: string): ImageOperationResult {
  const bytes = jpegBytes();
  const final = {
    id: `${requestId}:final`,
    slot: 0,
    phase: "final" as const,
    mimeType: "image/jpeg" as const,
    byteLength: bytes.byteLength,
    width: 4,
    height: 3,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    display: { type: "image" as const, dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}` },
    createdAt: BASE_NOW.toISOString()
  };
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
      degradedContinuation: false,
      providerImageIds: []
    },
    finalArtifacts: [final],
    partialArtifacts: [],
    failedSlots: [],
    relationships: [{ inputRole: "output", outputArtifactId: final.id, order: 0 }]
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
    mutations: { idFactory: (kind) => next(kind) },
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
    ...overrides
  });
}

async function collectEvents(source: AsyncIterable<StudioImageOperationEvent>) {
  const events: StudioImageOperationEvent[] = [];
  for await (const event of source) events.push(studioImageOperationEventSchema.parse(event));
  return events;
}

describe("task 3.5 contract surface and recovery", () => {
  it("implements the exact local method matrix while preserving eight public tools and phases", async () => {
    const { service } = await createHarness();
    expect(LOCAL_METHODS).toHaveLength(28);
    for (const method of LOCAL_METHODS) expect(typeof service[method]).toBe("function");
    expect(routegoOperationNames).toEqual([
      "status", "generate", "edit", "prepareRegeneration", "batch", "searchLibrary", "manageLibrary", "openStudio"
    ]);
    expect(Object.values(routegoOperationDefinitions).map((definition) => definition.toolName)).toEqual([
      "routego_status",
      "routego_generate",
      "routego_edit",
      "routego_prepare_regeneration",
      "routego_batch",
      "routego_search_library",
      "routego_manage_library",
      "routego_open_studio"
    ]);
    expect(studioOperationNames).toHaveLength(22);
    expect(imageArtifactPhaseSchema.options).toEqual(["partial", "final"]);
    expect(imageArtifactPhaseSchema.safeParse("source").success).toBe(false);
  });

  it("resolves regeneration recipes through Library without invoking Creation", async () => {
    const execute = vi.fn<CreationExecution>();
    const { service, library } = await createHarness({ executeCreation: execute });
    const prepare = vi.spyOn(library.galleryService, "prepareRegeneration");

    await expect(service.prepareRegeneration({ recordId: "asset-output" })).rejects.toThrow();

    expect(prepare).toHaveBeenCalledWith({ schemaVersion: 1, recordId: "asset-output" });
    expect(execute).not.toHaveBeenCalled();
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

  it("waits for a long Studio-configured generation instead of returning an ephemeral queued result", async () => {
    let markStarted: (() => void) | undefined;
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn<CreationExecution>(async (request, context) => {
      markStarted?.();
      await held;
      return succeededResult(request, context.requestId);
    });
    const { service } = await createHarness({ executeCreation: execute });
    const settings = await service.readSettings({});
    await service.updateSettings({
      defaults: { ...settings.defaults, responseTimeoutMs: 600_000 }
    });

    const pending = service.generate(publicRequest());
    await started;
    expect(execute).toHaveBeenCalledTimes(1);

    release?.();
    await expect(pending).resolves.toMatchObject({
      status: "succeeded",
      execution: { providerRequestCount: 1 }
    });
    await service.close();
    const saved = await service.searchLibrary({ query: "synthetic production service result" });
    expect(saved).toMatchObject({ total: 1, items: [{ status: "succeeded" }] });
  });
});

describe("Task 4.4 provider activation projection", () => {
  it("returns safe fallback selection and preserves prior snapshots for submitted work", async () => {
    const { service, library } = await createHarness();
    await library.upsertProviderProfile({
      profileId: "provider-a",
      name: "Provider A",
      endpoints: { generation: { mode: "legacy-api-base", value: "https://a.example/v1" } },
      defaultModel: "active-model",
      apiKey: { operation: "unchanged" },
      setActive: true
    });
    await library.upsertProviderProfile({
      profileId: "provider-b",
      name: "Provider B",
      endpoints: { generation: { mode: "legacy-api-base", value: "https://b.example/v1" } },
      defaultModel: "fallback-model",
      apiKey: { operation: "unchanged" },
      setActive: false
    });
    const switched = await service.studioProviderSwitch({
      profileId: "provider-b",
      preferredModel: "active-model"
    });
    const failed = await service.studioProviderSwitch({ profileId: "missing-provider" });
    expect(switched).toMatchObject({
      status: "succeeded",
      activeProviderId: "provider-b",
      selectedModel: "fallback-model",
      modelPreserved: false,
      appliesToFutureSubmissionsOnly: true
    });
    expect(JSON.stringify(switched)).not.toMatch(/credential|apiKey|authorization/u);
    expect(failed).toMatchObject({ status: "failed", error: { code: "not_found" } });
    expect(failed).not.toHaveProperty("activeProviderId");
  });
});

describe("task 3.5 public composition", () => {
  it("resolves omitted public controls from one active default snapshot while preserving explicit overrides", async () => {
    const observed: ImageOperationRequest[] = [];
    const execute: CreationExecution = async (request, context) => {
      observed.push(request);
      return succeededResult(request, context.requestId);
    };
    const { service, library, output } = await createHarness({ executeCreation: execute });
    const settings = await library.readSettings({});
    await library.updateSettings({
      defaults: {
        ...settings.defaults,
        size: "30x20",
        aspectRatio: "1:1",
        quality: "medium",
        format: "png",
        count: 1,
        partialImages: 0,
        transparentMode: "off",
        moderation: "auto",
        saveToLibrary: true
      }
    });

    const single = await service.generate({
      kind: "generate",
      prompt: "Use the saved square defaults"
    });
    const batch = await service.batch({
      tasks: [
        { id: "defaulted", operation: { kind: "generate", prompt: "Defaulted batch item" } },
        {
          id: "explicit",
          operation: {
            kind: "generate",
            prompt: "Explicit batch item",
            size: "40x30",
            aspectRatio: "landscape",
            quality: "high",
            format: "png",
            count: 1,
            partialImages: 0,
            transparentMode: "off",
            moderation: "low",
            saveToLibrary: false,
            outputDir: output
          }
        }
      ]
    });

    expect(single).toMatchObject({
      requestedParams: { size: "30x20", aspectRatio: "1:1" },
      effectiveParams: { size: "30x20", aspectRatio: "1:1" }
    });
    expect(batch.status).toBe("succeeded");
    expect(observed.map((request) => ({
      size: request.size,
      aspectRatio: request.aspectRatio,
      quality: request.quality,
      format: request.format,
      moderation: request.moderation,
      saveToLibrary: request.saveToLibrary
    }))).toEqual([
      { size: "30x20", aspectRatio: "1:1", quality: "medium", format: "png", moderation: "auto", saveToLibrary: true },
      { size: "30x20", aspectRatio: "1:1", quality: "medium", format: "png", moderation: "auto", saveToLibrary: true },
      { size: "40x30", aspectRatio: "landscape", quality: "high", format: "png", moderation: "low", saveToLibrary: false }
    ]);
  });

  it("resolves omitted public edit controls from active defaults while retaining explicit overrides", async () => {
    const observed: ImageOperationRequest[] = [];
    const execute: CreationExecution = async (request, context) => {
      observed.push(request);
      return request.format === "jpeg"
        ? succeededJpegResult(request, context.requestId)
        : succeededResult(request, context.requestId);
    };
    const { service, library, output } = await createHarness({ executeCreation: execute });
    const settings = await library.readSettings({});
    await library.updateSettings({
      defaults: {
        ...settings.defaults,
        size: "216x384",
        aspectRatio: "9:16",
        quality: "high",
        format: "jpeg",
        count: 1,
        partialImages: 0,
        transparentMode: "off",
        moderation: "auto",
        saveToLibrary: true
      }
    });
    const targetPath = path.join(output, "edit-target.png");
    await writeFile(targetPath, pngBytes());
    const baseEdit = {
      kind: "edit" as const,
      prompt: "Apply the saved defaults to this edit",
      targetImage: { path: targetPath, label: "Target" },
      invariants: { preserve: ["Keep the subject unchanged"] }
    };

    const inherited = await service.edit(baseEdit);
    const explicit = await service.edit({
      ...baseEdit,
      prompt: "Keep explicit edit controls",
      size: "30x20",
      aspectRatio: "3:2",
      quality: "medium",
      format: "png",
      count: 1,
      partialImages: 0,
      transparentMode: "off",
      moderation: "low",
      saveToLibrary: false,
      outputDir: output
    });

    expect(inherited).toMatchObject({
      status: "succeeded",
      requestedParams: { kind: "edit", size: "216x384", aspectRatio: "9:16", quality: "high", format: "jpeg" },
      effectiveParams: { kind: "edit", size: "216x384", aspectRatio: "9:16", quality: "high", format: "jpeg" }
    });
    expect(explicit).toMatchObject({
      status: "succeeded",
      requestedParams: { kind: "edit", size: "30x20", aspectRatio: "3:2", quality: "medium", format: "png", moderation: "low", saveToLibrary: false },
      effectiveParams: { kind: "edit", size: "30x20", aspectRatio: "3:2", quality: "medium", format: "png", moderation: "low", saveToLibrary: false }
    });
    expect(observed.map((request) => ({
      kind: request.kind,
      size: request.size,
      aspectRatio: request.aspectRatio,
      quality: request.quality,
      format: request.format,
      moderation: request.moderation,
      saveToLibrary: request.saveToLibrary,
      targetLabel: request.kind === "edit" ? request.targetImage.label : undefined
    }))).toEqual([
      {
        kind: "edit",
        size: "216x384",
        aspectRatio: "9:16",
        quality: "high",
        format: "jpeg",
        moderation: "auto",
        saveToLibrary: true,
        targetLabel: "Target"
      },
      {
        kind: "edit",
        size: "30x20",
        aspectRatio: "3:2",
        quality: "medium",
        format: "png",
        moderation: "low",
        saveToLibrary: false,
        targetLabel: "Target"
      }
    ]);
  });

  it("stops before Creation when public defaults cannot be read", async () => {
    const execute = vi.fn<CreationExecution>();
    const { service, library } = await createHarness({ executeCreation: execute });
    vi.spyOn(library, "readSettings").mockRejectedValueOnce(new Error("synthetic settings failure"));

    const result = await service.generate({ kind: "generate", prompt: "Cannot resolve defaults" });

    expect(result).toMatchObject({ status: "failed", error: { code: "config_corrupt" } });
    expect(execute).not.toHaveBeenCalled();
  });

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

  it("rejects a provider output whose file format differs from the effective preference", async () => {
    const { service } = await createHarness({
      executeCreation: async (request, context) => succeededJpegResult(request, context.requestId)
    });

    const result = await service.generate(publicRequest({ format: "png" }));
    const library = await service.searchLibrary({});

    expect(result).toMatchObject({
      status: "failed",
      effectiveParams: { format: "png" },
      error: { code: "invalid_response" }
    });
    expect(library.items).toHaveLength(0);
  });

  it("converts a larger same-ratio provider PNG into the exact requested JPEG", async () => {
    const { service } = await createHarness({
      executeCreation: async (request, context) => {
        const result = succeededResult(request, context.requestId);
        const final = artifact(`${context.requestId}:jpeg-source`, "final", 0, 0x68, 125, 125);
        return imageOperationResultSchema.parse({
          ...result,
          finalArtifacts: [final],
          relationships: [{ inputRole: "output", outputArtifactId: final.id, order: 0 }]
        });
      }
    });

    const result = await service.generate(publicRequest({ size: "100x100", format: "jpeg" }));

    expect(result).toMatchObject({
      status: "succeeded",
      finalArtifacts: [{ width: 100, height: 100, mimeType: "image/jpeg" }]
    });
    const bytes = await readFile(result.finalArtifacts[0]!.path!);
    expect(decodeJpeg(bytes, { useTArray: true })).toMatchObject({ width: 100, height: 100 });
  });

  it("saves a complete image whose dimensions differ from the request", async () => {
    const { service } = await createHarness({
      executeCreation: async (request, context) => {
        const result = succeededResult(request, context.requestId);
        const first = artifact(`${context.requestId}:mismatched-size`, "final", 0, 0x55, 3, 2);
        return imageOperationResultSchema.parse({
          ...result,
          finalArtifacts: [first],
          relationships: [{ inputRole: "output", outputArtifactId: first.id, order: 0 }]
        });
      }
    });
    const result = await service.generate(publicRequest({
      size: "100x100",
      aspectRatio: "1:1",
      format: "png"
    }));
    const library = await service.searchLibrary({});
    const detail = await service.getAssetDetail({ assetId: library.items[0]!.id });

    expect(result).toMatchObject({
      status: "succeeded",
      requestedParams: { size: "100x100" },
      finalArtifacts: [{ width: 3, height: 2, mimeType: "image/png" }]
    });
    expect(library.items).toHaveLength(1);
    expect(detail.asset).toMatchObject({
      width: 3,
      height: 2,
      requestedParams: { size: "100x100" }
    });
  });

  it("still rejects a provider result with an incorrect output count", async () => {
    const { service } = await createHarness({
      executeCreation: async (request, context) => {
        const result = succeededResult(request, context.requestId);
        return imageOperationResultSchema.parse({
          ...result,
          finalArtifacts: [result.finalArtifacts[0]!],
          relationships: [{ inputRole: "output", outputArtifactId: result.finalArtifacts[0]!.id, order: 0 }]
        });
      }
    });

    const result = await service.generate(publicRequest({ count: 2 }));
    const library = await service.searchLibrary({});

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "invalid_response",
        details: {
          mismatches: ["count"],
          observedExecution: { transport: "single-endpoint-json", providerRequestCount: 1 }
        }
      }
    });
    expect(library.items).toHaveLength(0);
  });

  it("normalizes bounded provider PNG rounding to the exact requested dimensions before saving", async () => {
    const { service } = await createHarness({
      executeCreation: async (request, context) => {
        const result = succeededResult(request, context.requestId);
        const final = artifact(`${context.requestId}:rounded-final`, "final", 0, 0x58, 101, 99);
        return imageOperationResultSchema.parse({
          ...result,
          finalArtifacts: [final],
          relationships: [{ inputRole: "output", outputArtifactId: final.id, order: 0 }]
        });
      }
    });

    const result = await service.generate(publicRequest({ size: "100x100", format: "png" }));

    expect(result).toMatchObject({
      status: "succeeded",
      finalArtifacts: [{ width: 100, height: 100, mimeType: "image/png" }]
    });
    const bytes = await readFile(result.finalArtifacts[0]!.path!);
    expect(PNG.sync.read(bytes)).toMatchObject({ width: 100, height: 100 });
  });

  it("downscales a larger same-ratio provider PNG to the exact requested resolution", async () => {
    const { service } = await createHarness({
      executeCreation: async (request, context) => {
        const result = succeededResult(request, context.requestId);
        const final = artifact(`${context.requestId}:larger-final`, "final", 0, 0x5a, 125, 125);
        return imageOperationResultSchema.parse({
          ...result,
          finalArtifacts: [final],
          relationships: [{ inputRole: "output", outputArtifactId: final.id, order: 0 }]
        });
      }
    });

    const result = await service.generate(publicRequest({ size: "100x100", format: "png" }));

    expect(result).toMatchObject({
      status: "succeeded",
      finalArtifacts: [{ width: 100, height: 100, mimeType: "image/png" }]
    });
    const bytes = await readFile(result.finalArtifacts[0]!.path!);
    expect(PNG.sync.read(bytes)).toMatchObject({ width: 100, height: 100 });
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

  it("keeps twelve result partials while bounding the nested error and emitting one failed terminal", async () => {
    const execute: CreationExecution = async (_request, context) => {
      for (let index = 0; index < 12; index += 1) {
        await context.onEvent?.({
          type: "partial",
          requestId: context.requestId,
          sequence: index + 1,
          occurredAt: BASE_NOW.toISOString(),
          artifact: artifact(`${context.requestId}:partial:${index}`, "partial", index % 4, 0x20 + index)
        });
      }
      throw new Error(
        "Authorization: Bearer synthetic-secret C:\\Users\\Synthetic\\Library\\private.png"
      );
    };
    const { service } = await createHarness({ executeCreation: execute });

    const events = await collectEvents(service.executeStudioStream(studioRequest()));
    expect(events.map((event) => event.type)).toEqual([
      "started",
      ...Array.from({ length: 12 }, () => "partial"),
      "failed"
    ]);
    expect(events.map((event) => event.sequence)).toEqual(Array.from({ length: 14 }, (_, index) => index));
    expect(events.filter((event) => event.type === "completed" || event.type === "failed")).toHaveLength(1);
    const terminal = events.at(-1);
    expect(terminal).toMatchObject({
      type: "failed",
      error: {
        code: "internal_contract",
        partialArtifacts: Array.from({ length: 4 }, () => ({ phase: "partial" })),
        receivedAnyOutput: true,
        mayHaveBilled: true
      },
      receivedAnyOutput: true,
      mayHaveBilled: true
    });

    const result = await service.studioGenerate(studioRequest());
    expect(result).toMatchObject({
      status: "failed",
      execution: { receivedAnyOutput: true, mayHaveBilled: true },
      error: { receivedAnyOutput: true, mayHaveBilled: true }
    });
    expect(result.partialArtifacts).toHaveLength(12);
    expect(result.error?.partialArtifacts).toHaveLength(4);
    expect(result.failedSlots[0]?.error.partialArtifacts).toHaveLength(4);
    const rendered = JSON.stringify({ events, result });
    expect(rendered).not.toContain("synthetic-secret");
    expect(rendered).not.toContain("C:\\Users\\Synthetic");
    expect(rendered).not.toMatch(/data:image|base64|"path"/u);
  });

  it("keeps five result partials when cancellation produces the unique failed terminal", async () => {
    let serviceUnderTest: ProductionLocalRoutegoService;
    const execute: CreationExecution = async (_request, context) => {
      for (let index = 0; index < 5; index += 1) {
        await context.onEvent?.({
          type: "partial",
          requestId: context.requestId,
          sequence: index + 1,
          occurredAt: BASE_NOW.toISOString(),
          artifact: artifact(`${context.requestId}:partial:${index}`, "partial", index % 4, 0x30 + index)
        });
      }
      serviceUnderTest.cancelOperation(context.requestId);
      throw Object.assign(new Error("The synthetic operation was cancelled after partial output."), {
        code: "cancelled"
      });
    };
    const { service } = await createHarness({ executeCreation: execute });
    serviceUnderTest = service;

    const events = await collectEvents(service.executeStudioStream(studioRequest()));
    expect(events.map((event) => event.type)).toEqual([
      "started",
      ...Array.from({ length: 5 }, () => "partial"),
      "failed"
    ]);
    expect(events.map((event) => event.sequence)).toEqual(Array.from({ length: 7 }, (_, index) => index));
    expect(events.filter((event) => event.type === "completed" || event.type === "failed")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      error: {
        code: "cancelled",
        partialArtifacts: Array.from({ length: 4 }, () => ({ phase: "partial" })),
        receivedAnyOutput: true,
        mayHaveBilled: true
      },
      receivedAnyOutput: true,
      mayHaveBilled: true
    });

    const result = await service.studioGenerate(studioRequest());
    expect(result).toMatchObject({
      status: "failed",
      execution: { receivedAnyOutput: true, mayHaveBilled: true },
      error: { code: "cancelled", receivedAnyOutput: true, mayHaveBilled: true }
    });
    expect(result.partialArtifacts).toHaveLength(5);
    expect(result.error?.partialArtifacts).toHaveLength(4);
    expect(result.failedSlots[0]?.error.partialArtifacts).toHaveLength(4);
    expect(JSON.stringify({ events, result })).not.toMatch(/data:image|base64|[A-Z]:\\|"path"|Authorization/u);
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
