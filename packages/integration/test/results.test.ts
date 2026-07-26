import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";

import {
  imageOperationRequestSchema,
  imageOperationResultSchema,
  studioImageOperationRequestSchema,
  type ImageArtifact,
  type ImageOperationRequest,
  type ImageOperationResult,
  type StudioImageOperationRequest
} from "@routego-image/contracts";
import {
  createRoutegoLibraryService,
  type ResolvedStableImageResource,
  type RoutegoLibraryService
} from "@routego-image/library";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveStudioOperationInput } from "../src/composition/inputs";
import type { DurableInputGraphPlan, InputGraphIdFactory } from "../src/composition/graph";
import {
  ResultCompositionError,
  StudioResultResourceProjector,
  finalizePublicOperationResult,
  finalizeStudioOperationResult,
  preflightPublicOutputDestination,
  stagePreparedPublicOperationSources,
  stagePreparedStudioOperationSources,
  type ResultGraphIdFactory,
  type StudioResultLibraryOwner
} from "../src/composition/results";
import {
  createOutputMaterializationTransaction,
  type MaterializationBatchResult,
  type OutputMaterializationTransaction
} from "../src/image/materialize";
import {
  EphemeralImageResourceError,
  createEphemeralImageResourceRegistry
} from "../src/runtime/ephemeral-resources";

const roots: string[] = [];
const BASE_NOW = new Date("2026-07-18T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function pngBytes(width = 3, height = 2, color = 0x44): Buffer {
  const image = new PNG({ width, height });
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = color;
    image.data[offset + 1] = (color + 30) & 0xff;
    image.data[offset + 2] = (color + 60) & 0xff;
    image.data[offset + 3] = 0xff;
  }
  return PNG.sync.write(image);
}

function artifact(
  id: string,
  slot: number,
  phase: "partial" | "final",
  bytes = pngBytes(3 + slot, 2 + slot, 0x40 + slot)
): ImageArtifact {
  const decoded = PNG.sync.read(bytes);
  return {
    id,
    slot,
    phase,
    mimeType: "image/png",
    byteLength: bytes.byteLength,
    width: decoded.width,
    height: decoded.height,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    display: { type: "image", dataUrl: `data:image/png;base64,${bytes.toString("base64")}` },
    createdAt: new Date(BASE_NOW.getTime() + slot * 1_000).toISOString()
  };
}

function request(
  overrides: Partial<ImageOperationRequest> = {}
): ImageOperationRequest {
  return imageOperationRequestSchema.parse({
    kind: "generate",
    prompt: "A synthetic result projection",
    ...overrides
  });
}

function studioRequest(
  overrides: Partial<StudioImageOperationRequest> = {}
): StudioImageOperationRequest {
  return studioImageOperationRequestSchema.parse({
    kind: "generate",
    prompt: "A synthetic Studio result projection",
    ...overrides
  });
}

function result(
  operation: ImageOperationRequest,
  options: {
    readonly status?: ImageOperationResult["status"];
    readonly partial?: readonly ImageArtifact[];
    readonly final?: readonly ImageArtifact[];
    readonly error?: ImageOperationResult["error"];
  } = {}
): ImageOperationResult {
  const partial = options.partial ?? [];
  const final = options.final ?? [artifact("artifact-final-0", 0, "final")];
  const receivedAnyOutput = partial.length + final.length > 0;
  return imageOperationResultSchema.parse({
    schemaVersion: 1,
    requestId: "request-results",
    status: options.status ?? "succeeded",
    requestedParams: operation,
    effectiveParams: operation,
    execution: {
      transport: "openai-images",
      attemptCount: 1,
      providerRequestCount: 1,
      receivedAnyOutput,
      mayHaveBilled: receivedAnyOutput,
      degradedContinuation: false,
      providerImageIds: []
    },
    finalArtifacts: final,
    partialArtifacts: partial,
    failedSlots: [],
    relationships: [
      ...partial.map((item, index) => ({
        inputRole: "stream-partial" as const,
        outputArtifactId: item.id,
        order: index
      })),
      ...final.map((item, index) => ({
        inputRole: "output" as const,
        outputArtifactId: item.id,
        order: partial.length + index
      }))
    ],
    ...(options.error === undefined ? {} : { error: options.error })
  });
}

function emptyGraph(assetId = "asset-operation"): DurableInputGraphPlan {
  return Object.freeze({
    operationAssetId: assetId,
    inputs: Object.freeze([]),
    sourceRenditions: Object.freeze([]),
    relationships: Object.freeze([]),
    physicalImageCount: 0,
    maskCount: 0
  });
}

const inputIdFactory: InputGraphIdFactory = (kind, order, attempt) =>
  `${kind}-${order}-${attempt}`;
const resultIdFactory: ResultGraphIdFactory = (kind, order, attempt) =>
  `${kind}-${order}-${attempt}`;

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `routego-results-${prefix}-`));
  roots.push(root);
  return root;
}

async function createLibrary(root: string, now: () => Date = () => new Date(BASE_NOW)) {
  const counters = new Map<string, number>();
  const next = (kind: string) => {
    const count = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, count);
    return `${kind}-${count}`;
  };
  return createRoutegoLibraryService({
    homeDirectory: path.join(root, "home"),
    now,
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

async function materialize(
  root: string,
  operationResult: ImageOperationResult,
  sourceCount = 0
): Promise<{
  transaction: OutputMaterializationTransaction;
  materialization: MaterializationBatchResult;
}> {
  const transaction = await createOutputMaterializationTransaction({
    stagingRoot: path.join(root, "staging"),
    requestId: operationResult.requestId
  });
  const materialization = await transaction.materializeArtifacts(
    [...operationResult.partialArtifacts, ...operationResult.finalArtifacts],
    { sourceCount, mayHaveBilled: operationResult.execution.mayHaveBilled }
  );
  return { transaction, materialization };
}

async function textOnlyPrepared(studioRequest: StudioImageOperationRequest) {
  return await resolveStudioOperationInput(studioRequest, {
    library: {
      resolveImageResource: async () => {
        throw new Error("Text-only input must not resolve a resource.");
      }
    },
    idFactory: inputIdFactory,
    now: () => new Date(BASE_NOW)
  });
}

async function createProjector(
  root: string,
  now: () => Date,
  owningSessionExpiresAt: string
) {
  const registry = await createEphemeralImageResourceRegistry({
    root: path.join(root, "ephemeral"),
    now,
    idFactory: (() => {
      let value = 0;
      return () => `ephemeral-resource-${++value}`;
    })()
  });
  return {
    registry,
    projector: new StudioResultResourceProjector({
      registry,
      owningSessionId: "session-results",
      owningSessionExpiresAt
    })
  };
}

describe("task 3.4 public output preflight", () => {
  it("rejects an unsaved public request without invoking approval or provider work", async () => {
    const approveOutputDirectory = vi.fn(async (value: string) => value);
    const provider = vi.fn();
    await expect(
      preflightPublicOutputDestination(
        request({ saveToLibrary: false, outputDir: undefined }),
        { approveOutputDirectory }
      )
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ResultCompositionError && error.code === "output-directory-required"
    );
    expect(approveOutputDirectory).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it("binds approval to the exact request and canonical directory", async () => {
    const root = await createRoot("preflight");
    const outputDir = path.join(root, "approved-output");
    await mkdir(outputDir, { recursive: true });
    const plan = await preflightPublicOutputDestination(
      request({ saveToLibrary: false, outputDir }),
      { approveOutputDirectory: async (value) => value }
    );
    expect(plan).toMatchObject({
      requestedOutputDirectory: outputDir,
      approvedDirectory: await realpathForTest(outputDir)
    });
  });

  it("accepts a requested filesystem alias for the approved canonical directory", async () => {
    const root = await createRoot("preflight-alias");
    const requested = path.join(root, "approved-output");
    await mkdir(requested, { recursive: true });
    const canonical = await realpathForTest(requested);
    const approveOutputDirectory = vi.fn(async () => canonical);

    const plan = await preflightPublicOutputDestination(
      request({ saveToLibrary: false, outputDir: requested }),
      { approveOutputDirectory }
    );

    expect(approveOutputDirectory).toHaveBeenCalledWith(requested);
    expect(plan).toMatchObject({
      requestedOutputDirectory: requested,
      approvedDirectory: canonical
    });
  });

  it("rejects an approval callback that silently redirects to another directory", async () => {
    const root = await createRoot("preflight-redirect");
    const requested = path.join(root, "requested");
    const redirected = path.join(root, "redirected");
    await Promise.all([
      mkdir(requested, { recursive: true }),
      mkdir(redirected, { recursive: true })
    ]);
    await expect(
      preflightPublicOutputDestination(
        request({ saveToLibrary: false, outputDir: requested }),
        { approveOutputDirectory: async () => redirected }
      )
    ).rejects.toSatisfy(
      (caught: unknown) =>
        caught instanceof ResultCompositionError && caught.code === "output-directory-unsafe"
    );
  });
});

async function realpathForTest(value: string): Promise<string> {
  return await import("node:fs/promises").then(async ({ realpath }) => await realpath(value));
}

describe("task 3.4 stable upload-source staging", () => {
  it("leaves Studio text-only generation without source staging or Library resolution", async () => {
    const root = await createRoot("studio-text-stage");
    const resolveImageResource = vi.fn(async () => {
      throw new Error("Studio text generation must not resolve image resources.");
    });
    const original = await resolveStudioOperationInput(
      { kind: "generate", prompt: "A synthetic text-only Studio request" },
      {
        library: { resolveImageResource },
        idFactory: inputIdFactory,
        now: () => new Date(BASE_NOW)
      }
    );
    const transaction = await createOutputMaterializationTransaction({
      stagingRoot: path.join(root, "staging"),
      requestId: "request-studio-text-stage"
    });
    const staged = await stagePreparedStudioOperationSources(original, {
      library: { resolveImageResource },
      transaction,
      now: () => new Date(BASE_NOW)
    });
    expect(resolveImageResource).not.toHaveBeenCalled();
    expect(staged.graph.inputs).toEqual([]);
    expect(staged.graph.sourceRenditions).toEqual([]);
    expect(staged.creationRequest.references).toEqual([]);
    await transaction.cleanup();
  });

  it("rejects stale Studio image references before source staging", async () => {
    const root = await createRoot("studio-stale-source");
    const resolveImageResource = vi.fn();
    const transaction = await createOutputMaterializationTransaction({
      stagingRoot: path.join(root, "staging"),
      requestId: "request-studio-stale-source"
    });
    await expect(
      resolveStudioOperationInput(
        {
          kind: "generate",
          prompt: "Use an expired synthetic upload",
          references: [
            {
              image: { source: "upload", uploadResourceId: "upload-expiring" },
              role: "reference"
            }
          ]
        },
        {
          library: { resolveImageResource },
          idFactory: inputIdFactory,
          now: () => new Date(BASE_NOW)
        }
      )
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(resolveImageResource).not.toHaveBeenCalled();
    await transaction.cleanup();
  });

  it("snapshots approved public path inputs into the same request-owned transaction", async () => {
    const root = await createRoot("public-source-stage");
    const sourcePath = path.join(root, "public-reference.png");
    const bytes = pngBytes(3, 3, 0x63);
    await writeFile(sourcePath, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const requestWithReference = request({
      references: [
        {
          id: "artifact-public-source",
          path: sourcePath,
          role: "reference"
        }
      ]
    });
    const relationship = {
      id: "relationship-public-source",
      role: "reference" as const,
      relatedAssetId: "asset-public-source",
      artifactId: "artifact-public-source",
      order: 0
    };
    const sourceRendition = {
      artifactId: "artifact-public-source",
      phase: "source" as const,
      sourceRoot: root,
      sourceRelativePath: "public-reference.png",
      expected: {
        mimeType: "image/png" as const,
        byteLength: bytes.byteLength,
        sha256,
        width: 3,
        height: 3
      }
    };
    const graph: DurableInputGraphPlan = Object.freeze({
      operationAssetId: "asset-public-operation",
      inputs: Object.freeze([
        Object.freeze({
          key: "reference:0" as const,
          role: "reference" as const,
          order: 0,
          origin: "upload" as const,
          relatedAssetId: "asset-public-source",
          artifactId: "artifact-public-source",
          path: sourcePath,
          mimeType: "image/png" as const,
          byteLength: bytes.byteLength,
          sha256,
          width: 3,
          height: 3,
          referenceRole: "reference" as const,
          relationship,
          sourceRendition
        })
      ]),
      sourceRenditions: Object.freeze([sourceRendition]),
      relationships: Object.freeze([relationship]),
      physicalImageCount: 1,
      maskCount: 0
    });
    const transaction = await createOutputMaterializationTransaction({
      stagingRoot: path.join(root, "staging"),
      requestId: "request-public-source-stage"
    });
    const staged = await stagePreparedPublicOperationSources(
      { request: requestWithReference, graph },
      { transaction }
    );
    await unlink(sourcePath);
    expect(staged.request.references[0]?.path).not.toBe(sourcePath);
    expect(await readFile(staged.request.references[0]!.path)).toEqual(bytes);
    await transaction.cleanup();
  });
});

describe("task 3.4 Studio result projection", () => {
  it("atomically saves output graphs and returns the same Library asset/artifact identities", async () => {
    const root = await createRoot("studio-saved");
    const library = await createLibrary(root);
    const prepared = await textOnlyPrepared(studioRequest({
      prompt: "A saved synthetic Studio result",
      saveToLibrary: true
    }));
    const operationResult = result(prepared.creationRequest);
    const { transaction, materialization } = await materialize(root, operationResult);
    const { registry, projector } = await createProjector(
      root,
      () => new Date(BASE_NOW),
      "2026-07-18T12:10:00.000Z"
    );
    const projected = await finalizeStudioOperationResult({
      prepared,
      creationResult: operationResult,
      materialization,
      transaction,
      model: "synthetic-model",
      idFactory: resultIdFactory,
      library,
      resources: projector,
      now: () => new Date(BASE_NOW)
    });
    expect(projected.status).toBe("succeeded");
    expect(projected.finalArtifacts[0]).toMatchObject({
      assetId: prepared.graph.operationAssetId,
      artifactId: operationResult.finalArtifacts[0]!.id,
      phase: "final"
    });
    const detail = await library.getAssetDetail({ assetId: prepared.graph.operationAssetId });
    expect(detail).toMatchObject({
      status: "succeeded",
      asset: {
        id: prepared.graph.operationAssetId,
        primaryArtifactId: operationResult.finalArtifacts[0]!.id
      }
    });
    expect(JSON.stringify(projected)).not.toMatch(/(?:"path"|data:image|base64)/u);
    expect(projected.finalArtifacts[0]?.resource.relativeUrl).toMatch(
      /^\/api\/v1\/library\/resources\//u
    );
    await registry.shutdown();
  });

  it("atomically preserves text-only partial output and exact output relationships", async () => {
    const root = await createRoot("studio-text-partial-graph");
    const library = await createLibrary(root);
    const original = await textOnlyPrepared(studioRequest({
      prompt: "A text-only Studio operation with a partial terminal",
      saveToLibrary: true
    }));
    const transaction = await createOutputMaterializationTransaction({
      stagingRoot: path.join(root, "staging"),
      requestId: "request-source-graph"
    });
    const prepared = await stagePreparedStudioOperationSources(original, {
      library: {
        resolveImageResource: async () => {
          throw new Error("Text-only Studio staging must not resolve resources.");
        }
      },
      transaction,
      now: () => new Date(BASE_NOW)
    });
    const partial = artifact("artifact-source-graph-partial", 0, "partial");
    const providerError = {
      code: "provider_5xx" as const,
      category: "provider" as const,
      stage: "stream" as const,
      safeMessage: "The synthetic provider failed after a partial output.",
      retryDisposition: "user-confirmation" as const,
      partialArtifacts: [partial],
      receivedAnyOutput: true,
      mayHaveBilled: true
    };
    const operationResult = result(prepared.creationRequest, {
      status: "failed",
      partial: [partial],
      final: [],
      error: providerError
    });
    const materialization = await transaction.materializeArtifacts([partial], {
      sourceCount: prepared.graph.sourceRenditions.length,
      mayHaveBilled: true
    });
    const { registry, projector } = await createProjector(
      root,
      () => new Date(BASE_NOW),
      "2026-07-18T12:10:00.000Z"
    );
    const projected = await finalizeStudioOperationResult({
      prepared,
      creationResult: operationResult,
      materialization,
      transaction,
      model: "synthetic-model",
      idFactory: resultIdFactory,
      library,
      resources: projector,
      now: () => new Date(BASE_NOW)
    });
    expect(projected.status).toBe("failed");
    expect(projected.partialArtifacts[0]).toMatchObject({
      assetId: prepared.graph.operationAssetId,
      artifactId: partial.id
    });
    const index = await library.indexStore.read();
    const saved = index.assets.find((item) => item.id === prepared.graph.operationAssetId)!;
    expect(saved.status).toBe("partial");
    expect(saved.renditions.map((item) => ({ id: item.artifactId, phase: item.phase }))).toEqual([
      { id: partial.id, phase: "partial" }
    ]);
    expect(saved.relationships.map((relationship) => ({
      role: relationship.role,
      owner: relationship.relatedAssetId,
      artifactId: relationship.artifactId
    }))).toEqual([
      {
        role: "output",
        owner: prepared.graph.operationAssetId,
        artifactId: partial.id
      }
    ]);
    await registry.shutdown();
  });

  it("preserves a failed-terminal partial resource until its immutable session-capped expiry", async () => {
    const root = await createRoot("studio-partial-lifetime");
    const library = await createLibrary(root);
    const prepared = await textOnlyPrepared(studioRequest({
      prompt: "A failed synthetic Studio stream",
      saveToLibrary: false
    }));
    const partial = artifact("artifact-partial-0", 0, "partial");
    const error = {
      code: "provider_5xx" as const,
      category: "provider" as const,
      stage: "stream" as const,
      safeMessage: "The synthetic provider failed after partial output.",
      retryDisposition: "user-confirmation" as const,
      partialArtifacts: [partial],
      receivedAnyOutput: true,
      mayHaveBilled: true
    };
    const operationResult = result(prepared.creationRequest, {
      status: "failed",
      partial: [partial],
      final: [],
      error
    });
    const { transaction, materialization } = await materialize(root, operationResult);
    let now = new Date(BASE_NOW);
    const sessionExpiry = "2026-07-18T12:02:00.000Z";
    const { registry, projector } = await createProjector(root, () => now, sessionExpiry);
    const earlyArtifact = await projector.projectEphemeral(materialization.outputs[0]!);
    const projected = await finalizeStudioOperationResult({
      prepared,
      creationResult: operationResult,
      materialization,
      transaction,
      model: "synthetic-model",
      idFactory: resultIdFactory,
      library,
      resources: projector,
      now: () => now
    });
    expect(projected).toMatchObject({
      status: "failed",
      execution: { receivedAnyOutput: true, mayHaveBilled: true },
      partialArtifacts: [
        {
          artifactId: partial.id,
          resource: { expiresAt: sessionExpiry }
        }
      ]
    });
    expect(projected.partialArtifacts[0]?.resource.resourceId).toBe(
      earlyArtifact.resource.resourceId
    );
    now = new Date("2026-07-18T12:01:59.999Z");
    const opened = await registry.open(earlyArtifact.resource.resourceId, "session-results");
    await opened.close();
    now = new Date(sessionExpiry);
    await expect(
      registry.open(earlyArtifact.resource.resourceId, "session-results")
    ).rejects.toSatisfy(
      (caught: unknown) =>
        caught instanceof EphemeralImageResourceError && caught.code === "expired"
    );
    expect((await library.indexStore.read()).assets).toHaveLength(0);
    await registry.shutdown();
  });

  it("keeps a normal five-minute descriptor after channel abandonment and revokes it on shutdown", async () => {
    const root = await createRoot("studio-normal-lifetime");
    const operationResult = result(request({ saveToLibrary: false }));
    const { transaction, materialization } = await materialize(root, operationResult);
    let now = new Date(BASE_NOW);
    const { registry, projector } = await createProjector(
      root,
      () => now,
      "2026-07-18T12:10:00.000Z"
    );
    const projected = await projector.projectEphemeral(materialization.outputs[0]!);
    expect(projected.resource.expiresAt).toBe("2026-07-18T12:05:00.000Z");
    now = new Date("2026-07-18T12:04:59.999Z");
    const openResource = await registry.open(projected.resource.resourceId, "session-results");
    await openResource.close();
    await registry.shutdown();
    await expect(
      registry.open(projected.resource.resourceId, "session-results")
    ).rejects.toSatisfy(
      (caught: unknown) =>
        caught instanceof EphemeralImageResourceError && caught.code === "registry-shutdown"
    );
    await transaction.cleanup();
  });

  it("falls back to unsaved protected resources when an atomic Library commit fails", async () => {
    const root = await createRoot("studio-commit-failure");
    const actualLibrary = await createLibrary(root);
    const library: StudioResultLibraryOwner = {
      assetStore: {
        ingestAsset: vi.fn(async () => {
          throw new Error("synthetic commit failure");
        }),
        resolveArtifact: actualLibrary.assetStore.resolveArtifact.bind(actualLibrary.assetStore),
        copyArtifactToProject:
          actualLibrary.assetStore.copyArtifactToProject.bind(actualLibrary.assetStore)
      },
      resourceRegistry: actualLibrary.resourceRegistry
    };
    const prepared = await textOnlyPrepared(studioRequest({
      prompt: "A saved result whose commit fails",
      saveToLibrary: true
    }));
    const operationResult = result(prepared.creationRequest);
    const { transaction, materialization } = await materialize(root, operationResult);
    const { registry, projector } = await createProjector(
      root,
      () => new Date(BASE_NOW),
      "2026-07-18T12:10:00.000Z"
    );
    const projected = await finalizeStudioOperationResult({
      prepared,
      creationResult: operationResult,
      materialization,
      transaction,
      model: "synthetic-model",
      idFactory: resultIdFactory,
      library,
      resources: projector
    });
    expect(projected).toMatchObject({
      status: "partial",
      finalArtifacts: [{ artifactId: operationResult.finalArtifacts[0]!.id }],
      error: {
        code: "file_write_failed",
        receivedAnyOutput: true,
        mayHaveBilled: true
      }
    });
    expect(projected.finalArtifacts[0]?.assetId).toBeUndefined();
    expect(projected.finalArtifacts[0]?.resource.relativeUrl).toMatch(/^\/api\/v1\/resources\//u);
    expect((await actualLibrary.indexStore.read()).assets).toHaveLength(0);
    await registry.shutdown();
  });

  it("keeps the saved identity while falling back ephemerally if durable descriptor registration fails", async () => {
    const root = await createRoot("studio-durable-descriptor-failure");
    const actualLibrary = await createLibrary(root);
    const library: StudioResultLibraryOwner = {
      assetStore: actualLibrary.assetStore,
      resourceRegistry: {
        registerImage: vi.fn(async () => {
          throw new Error("synthetic durable descriptor failure");
        })
      }
    };
    const prepared = await textOnlyPrepared(studioRequest({
      prompt: "A saved result with a transient descriptor failure",
      saveToLibrary: true
    }));
    const operationResult = result(prepared.creationRequest);
    const { transaction, materialization } = await materialize(root, operationResult);
    const { registry, projector } = await createProjector(
      root,
      () => new Date(BASE_NOW),
      "2026-07-18T12:10:00.000Z"
    );
    const projected = await finalizeStudioOperationResult({
      prepared,
      creationResult: operationResult,
      materialization,
      transaction,
      model: "synthetic-model",
      idFactory: resultIdFactory,
      library,
      resources: projector
    });
    expect(projected).toMatchObject({
      status: "partial",
      finalArtifacts: [
        {
          assetId: prepared.graph.operationAssetId,
          artifactId: operationResult.finalArtifacts[0]!.id,
          resource: { relativeUrl: expect.stringMatching(/^\/api\/v1\/resources\//u) }
        }
      ],
      error: { code: "file_write_failed", receivedAnyOutput: true, mayHaveBilled: true }
    });
    expect((await actualLibrary.indexStore.read()).assets).toHaveLength(1);
    await registry.shutdown();
  });
});

describe("task 3.4 public saved and unsaved projection", () => {
  it("writes unsaved public outputs exclusively with display data and no hidden Library record", async () => {
    const root = await createRoot("public-unsaved");
    const outputDir = path.join(root, "output");
    await mkdir(outputDir, { recursive: true });
    const library = await createLibrary(root);
    const operation = request({ saveToLibrary: false, outputDir });
    const operationResult = result(operation);
    const plan = await preflightPublicOutputDestination(operation, {
      approveOutputDirectory: async (value) => value
    });
    const { transaction, materialization } = await materialize(root, operationResult);
    const identity = createHash("sha256")
      .update(`${operationResult.requestId}:${operationResult.finalArtifacts[0]!.id}`, "utf8")
      .digest("hex")
      .slice(0, 16);
    const collision = path.join(outputDir, `routego-final-0-${identity}.png`);
    await writeFile(collision, "existing", "utf8");
    const projected = await finalizePublicOperationResult({
      graph: emptyGraph(),
      creationResult: operationResult,
      materialization,
      transaction,
      model: "synthetic-model",
      idFactory: resultIdFactory,
      library,
      outputDestination: plan!
    });
    expect(projected).toMatchObject({
      status: "succeeded",
      finalArtifacts: [
        {
          id: operationResult.finalArtifacts[0]!.id,
          path: expect.stringContaining(`routego-final-0-${identity}-2.png`),
          display: { type: "image", dataUrl: expect.stringMatching(/^data:image\/png;base64,/u) }
        }
      ]
    });
    expect(await readFile(collision, "utf8")).toBe("existing");
    expect((await library.indexStore.read()).assets).toHaveLength(0);
    await expect(access(transaction.directory)).rejects.toThrow();
  });

  it("cleans request staging when finalization rejects a missing unsaved-output approval", async () => {
    const root = await createRoot("public-missing-plan-cleanup");
    const library = await createLibrary(root);
    const operationResult = result(request({ saveToLibrary: false }));
    const { transaction, materialization } = await materialize(root, operationResult);
    await expect(
      finalizePublicOperationResult({
        graph: emptyGraph(),
        creationResult: operationResult,
        materialization,
        transaction,
        model: "synthetic-model",
        idFactory: resultIdFactory,
        library
      })
    ).rejects.toSatisfy(
      (caught: unknown) =>
        caught instanceof ResultCompositionError && caught.code === "output-directory-required"
    );
    await expect(access(transaction.directory)).rejects.toThrow();
  });

  it("uses Library exclusive project copy after atomic save and preserves colliding files", async () => {
    const root = await createRoot("public-saved-copy");
    const outputDir = path.join(root, "project-output");
    await mkdir(outputDir, { recursive: true });
    const library = await createLibrary(root);
    const operation = request({ saveToLibrary: true, outputDir });
    const operationResult = result(operation);
    const plan = await preflightPublicOutputDestination(operation, {
      approveOutputDirectory: async (value) => value
    });
    await writeFile(path.join(outputDir, "routego-final-0.png"), "existing", "utf8");
    const { transaction, materialization } = await materialize(root, operationResult);
    const projected = await finalizePublicOperationResult({
      graph: emptyGraph("asset-public-saved"),
      creationResult: operationResult,
      materialization,
      transaction,
      model: "synthetic-model",
      idFactory: resultIdFactory,
      library,
      outputDestination: plan!
    });
    expect(projected.status).toBe("succeeded");
    expect(path.basename(projected.finalArtifacts[0]!.path!)).toBe("routego-final-0-2.png");
    expect(await readFile(path.join(outputDir, "routego-final-0.png"), "utf8")).toBe("existing");
    const detail = await library.getAssetDetail({ assetId: "asset-public-saved" });
    expect(detail).toMatchObject({
      status: "succeeded",
      asset: { primaryArtifactId: operationResult.finalArtifacts[0]!.id }
    });
  });

  it("reports project-copy failure without losing the committed Library asset or display bytes", async () => {
    const root = await createRoot("public-copy-failure");
    const outputDir = path.join(root, "project-output");
    await mkdir(outputDir, { recursive: true });
    const actualLibrary = await createLibrary(root);
    const library: StudioResultLibraryOwner = {
      assetStore: {
        ingestAsset: actualLibrary.assetStore.ingestAsset.bind(actualLibrary.assetStore),
        resolveArtifact: actualLibrary.assetStore.resolveArtifact.bind(actualLibrary.assetStore),
        copyArtifactToProject: vi.fn(async () => {
          throw new Error("synthetic copy failure");
        })
      },
      resourceRegistry: actualLibrary.resourceRegistry
    };
    const operation = request({ saveToLibrary: true, outputDir });
    const operationResult = result(operation);
    const plan = await preflightPublicOutputDestination(operation, {
      approveOutputDirectory: async (value) => value
    });
    const { transaction, materialization } = await materialize(root, operationResult);
    const projected = await finalizePublicOperationResult({
      graph: emptyGraph("asset-copy-failure"),
      creationResult: operationResult,
      materialization,
      transaction,
      model: "synthetic-model",
      idFactory: resultIdFactory,
      library,
      outputDestination: plan!
    });
    expect(projected).toMatchObject({
      status: "partial",
      finalArtifacts: [
        {
          id: operationResult.finalArtifacts[0]!.id,
          display: { dataUrl: expect.stringMatching(/^data:image\/png;base64,/u) }
        }
      ],
      error: { code: "file_write_failed", receivedAnyOutput: true, mayHaveBilled: true }
    });
    expect(projected.finalArtifacts[0]?.path).toBeUndefined();
    expect((await actualLibrary.indexStore.read()).assets).toHaveLength(1);
  });
});

describe("task 3.4 graph bounds and chromakey identity", () => {
  it("persists the generation-only five-reference source graph plus partial and final outputs without a second identity", async () => {
    const root = await createRoot("bound-generation");
    const library = await createLibrary(root);
    const sourceRoot = path.join(root, "sources");
    await mkdir(sourceRoot, { recursive: true });
    const sourceBytes = pngBytes(2, 2, 0x71);
    await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        await writeFile(path.join(sourceRoot, `source-${index}.png`), sourceBytes);
      })
    );
    const sourceRenditions = Array.from({ length: 5 }, (_, index) => ({
      artifactId: `artifact-source-${index}`,
      phase: "source" as const,
      sourceRoot,
      sourceRelativePath: `source-${index}.png`,
      expected: {
        mimeType: "image/png" as const,
        byteLength: sourceBytes.byteLength,
        sha256: createHash("sha256").update(sourceBytes).digest("hex"),
        width: 2,
        height: 2
      }
    }));
    const inputRelationships = sourceRenditions.map((source, index) => ({
      id: `relationship-source-${index}`,
      role: "reference" as const,
      relatedAssetId: "asset-bound-generation",
      artifactId: source.artifactId,
      order: index
    }));
    const inputs = sourceRenditions.map((source, index) => ({
      key: `reference:${index}` as const,
      role: "reference" as const,
      order: index,
      origin: "upload" as const,
      relatedAssetId: "asset-bound-generation",
      artifactId: source.artifactId,
      path: path.join(sourceRoot, source.sourceRelativePath),
      mimeType: "image/png" as const,
      byteLength: sourceBytes.byteLength,
      sha256: createHash("sha256").update(sourceBytes).digest("hex"),
      width: 2,
      height: 2,
      relationship: inputRelationships[index]!,
      referenceRole: "reference" as const,
      sourceRendition: source
    }));
    const graph: DurableInputGraphPlan = Object.freeze({
      operationAssetId: "asset-bound-generation",
      inputs: Object.freeze(inputs),
      sourceRenditions: Object.freeze(sourceRenditions),
      relationships: Object.freeze(inputRelationships),
      physicalImageCount: 5,
      maskCount: 0
    });
    const partial = Array.from({ length: 12 }, (_, index) =>
      artifact(`artifact-partial-${index}`, index % 4, "partial", pngBytes(3, 2, 0x20 + index))
    );
    const final = Array.from({ length: 4 }, (_, index) =>
      artifact(`artifact-final-${index}`, index, "final", pngBytes(4, 3, 0x50 + index))
    );
    const operation = request({
      prompt: "A maximum bounded synthetic generation",
      references: Array.from({ length: 5 }, (_, index) => ({
        id: `artifact-source-${index}`,
        path: path.join(sourceRoot, `source-${index}.png`),
        role: "reference" as const
      })),
      saveToLibrary: true,
      count: 4,
      partialImages: 3
    });
    const transaction = await createOutputMaterializationTransaction({
      stagingRoot: path.join(root, "staging"),
      requestId: "request-bound-33"
    });
    const staged = await stagePreparedPublicOperationSources(
      { request: operation, graph },
      { transaction }
    );
    const operationResult = result(staged.request, { status: "succeeded", partial, final });
    const materialization = await transaction.materializeArtifacts(
      [...partial, ...final],
      { sourceCount: 5, mayHaveBilled: true }
    );
    const originalFinal = materialization.outputs.find(
      (output) => output.artifactId === "artifact-final-0"
    )!;
    const processedBytes = pngBytes(5, 4, 0x7a);
    const processed = await transaction.stageReplacement(
      originalFinal,
      processedBytes,
      "image/png"
    );
    const selectedMaterialization: MaterializationBatchResult = {
      ...materialization,
      outputs: materialization.outputs.map((output) =>
        output.artifactId === processed.artifactId ? processed : output
      )
    };
    const projected = await finalizePublicOperationResult({
      graph: staged.graph,
      creationResult: operationResult,
      materialization: selectedMaterialization,
      transaction,
      model: "synthetic-model",
      idFactory: resultIdFactory,
      library
    });
    expect(projected.status).toBe("succeeded");
    const index = await library.indexStore.read();
    expect(index.assets[0]?.renditions).toHaveLength(21);
    expect(new Set(index.assets[0]?.renditions.map((item) => item.artifactId))).toHaveLength(21);
    expect(index.assets[0]?.relationships).toHaveLength(21);
    expect(index.assets[0]?.relationships.slice(0, 5).map((item) => item.role)).toEqual(
      Array.from({ length: 5 }, () => "reference")
    );
    expect(index.assets[0]?.relationships.slice(5).every((item) => item.role === "output")).toBe(true);
    expect(projected.finalArtifacts.map((item) => item.id)).toEqual(
      final.map((item) => item.id)
    );
    expect(projected.finalArtifacts.find((item) => item.id === processed.artifactId)).toMatchObject({
      id: originalFinal.artifactId,
      sha256: processed.sha256
    });
  });
});
