import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readdir, realpath, rm } from "node:fs/promises";

import {
  confirmLegacyLibraryMigrationInputSchema,
  confirmLegacyLibraryMigrationResultSchema,
  discardUploadResourceInputSchema,
  discardUploadResourceResultSchema,
  executeLibraryMutationInputSchema,
  executeLibraryMutationResultSchema,
  finalizeUploadResourceInputSchema,
  finalizeUploadResourceResultSchema,
  getAssetDetailInputSchema,
  getAssetDetailResultSchema,
  getBrowserResourceInputSchema,
  getBrowserResourceResultSchema,
  getUploadResourceStatusInputSchema,
  getUploadResourceStatusResultSchema,
  imageOperationRequestSchema,
  imageOperationResultSchema,
  listFoldersInputSchema,
  listFoldersResultSchema,
  preflightLibraryMutationInputSchema,
  preflightLibraryMutationResultSchema,
  readLegacyLibraryMigrationInputSchema,
  legacyLibraryMigrationStateSchema,
  readSettingsInputSchema,
  readSettingsResultSchema,
  refreshModelsInputSchema,
  refreshModelsResultSchema,
  removeProviderProfileInputSchema,
  removeProviderProfileResultSchema,
  reorderFoldersInputSchema,
  reorderFoldersResultSchema,
  reserveUploadResourceInputSchema,
  reserveUploadResourceResultSchema,
  routegoBatchInputSchema,
  routegoBatchResultSchema,
  routegoEditInputSchema,
  routegoGenerateInputSchema,
  routegoManageLibraryInputSchema,
  routegoManageLibraryResultSchema,
  routegoOpenStudioInputSchema,
  routegoOpenStudioResultSchema,
  routegoPrepareRegenerationInputSchema,
  routegoPrepareRegenerationResultSchema,
  routegoSearchLibraryInputSchema,
  routegoSearchLibraryResultSchema,
  routegoServiceErrorSchema,
  routegoStatusInputSchema,
  routegoStatusResultSchema,
  routegoServiceHealthSchema,
  setActiveProviderProfileInputSchema,
  setActiveProviderProfileResultSchema,
  studioProviderSwitchInputSchema,
  studioProviderSwitchResultSchema,
  studioBatchInputSchema,
  studioBatchResultSchema,
  studioGenerateInputSchema,
  studioImageOperationEventSchema,
  studioImageOperationResultSchema,
  studioImageOperationRequestSchema,
  studioLibrarySearchInputSchema,
  studioLibrarySearchResultSchema,
  studioServiceErrorSchema,
  updateSettingsInputSchema,
  updateSettingsResultSchema,
  upsertProviderProfileInputSchema,
  upsertProviderProfileResultSchema,
  type ConfirmLegacyLibraryMigrationInput,
  type ConfirmLegacyLibraryMigrationResult,
  type DiscardUploadResourceInput,
  type DiscardUploadResourceResult,
  type ExecuteLibraryMutationInput,
  type ExecuteLibraryMutationResult,
  type FinalizeUploadResourceInput,
  type FinalizeUploadResourceResult,
  type GetAssetDetailInput,
  type GetAssetDetailResult,
  type GetBrowserResourceInput,
  type GetBrowserResourceResult,
  type GetUploadResourceStatusInput,
  type GetUploadResourceStatusResult,
  type ImageOperationEvent,
  type ImageOperationRequest,
  type ImageOperationResult,
  type ListFoldersInput,
  type ListFoldersResult,
  type LegacyLibraryMigrationState,
  type LocalRoutegoService,
  type PreflightLibraryMutationInput,
  type PreflightLibraryMutationResult,
  type ReadSettingsInput,
  type ReadSettingsResult,
  type ReadLegacyLibraryMigrationInput,
  type RefreshModelsInput,
  type RefreshModelsResult,
  type RemoveProviderProfileInput,
  type RemoveProviderProfileResult,
  type ReorderFoldersInput,
  type ReorderFoldersResult,
  type ReserveUploadResourceInput,
  type ReserveUploadResourceResult,
  type RoutegoBatchInput,
  type RoutegoBatchResult,
  type RoutegoEditInput,
  type RoutegoGenerateInput,
  type RoutegoManageLibraryInput,
  type RoutegoManageLibraryResult,
  type RoutegoOpenStudioInput,
  type RoutegoOpenStudioResult,
  type RoutegoPrepareRegenerationInput,
  type RoutegoPrepareRegenerationResult,
  type RoutegoSearchLibraryInput,
  type RoutegoSearchLibraryResult,
  type RoutegoServiceError,
  type RoutegoStatusInput,
  type RoutegoStatusResult,
  type SetActiveProviderProfileInput,
  type SetActiveProviderProfileResult,
  type StudioProviderSwitchInput,
  type StudioProviderSwitchResult,
  type StudioBatchInput,
  type StudioBatchResult,
  type StudioGenerateInput,
  type StudioImageOperationEvent,
  type StudioImageArtifact,
  type StudioImageOperationRequest,
  type StudioImageOperationResult,
  type StudioLibrarySearchInput,
  type StudioLibrarySearchResult,
  type UpdateSettingsInput,
  type UpdateSettingsResult,
  type UpsertProviderProfileInput,
  type UpsertProviderProfileResult
} from "@routego-image/contracts";
import {
  createResolvedImageExecutor,
  prepareImageInputs,
  type ImageExecutionDependencies,
  type ProviderRuntimeContext,
  type PreparedImageInput
} from "@routego-image/creation";
import {
  LibraryError,
  type ResolvedStableImageResource,
  type RoutegoLibraryService
} from "@routego-image/library";

import {
  applyPngChromakey,
  type ApplyPngChromakeyInput,
  type ChromakeyContentClass
} from "../image/chromakey";
import {
  removeBackground,
  type BackgroundRemovalResult
} from "../runtime/background-removal";
import { inspectPngAlpha } from "../runtime/background-removal-worker";
import {
  createOutputMaterializationTransaction,
  ImageMaterializationError,
  type MaterializationBatchResult,
  type MaterializationFailure,
  type MaterializedImageOutput,
  type OutputMaterializationTransaction
} from "../image/materialize";
import { normalizeProviderRasterOutput } from "../image/resize";
import {
  buildDurableInputGraph,
  type DurableInputGraphPlan,
  type InputGraphIdFactory,
  type ResolvedStudioPhysicalInput,
  type StudioPhysicalInputKey,
  type VerifiedStudioImageResource
} from "./graph";
import { resolveStudioOperationInput } from "./inputs";
import {
  finalizePublicOperationResult,
  finalizeStudioOperationResult,
  preflightPublicOutputDestination,
  stagePreparedPublicOperationSources,
  stagePreparedStudioOperationSources,
  StudioResultResourceProjector,
  type ResultGraphIdFactory
} from "./results";
import {
  boundedRedactedDiagnostic,
  createProviderServiceError,
  loadProviderContext,
  ProviderIntegrationError,
  redactProviderText,
  readProviderStatus,
  type LoadProviderContextOptions
} from "../provider/context";
import {
  refreshProviderModels,
  type RefreshProviderModelsOptions
} from "../provider/models";
import { EphemeralImageResourceRegistry } from "../runtime/ephemeral-resources";

export interface StudioSessionContext {
  readonly id: string;
  readonly expiresAt: string | Date;
}

export interface ChromakeyPolicy {
  readonly contentClass: ChromakeyContentClass;
  readonly keyColor: ApplyPngChromakeyInput["keyColor"];
  readonly tolerance: number;
  readonly autoEligible?: boolean;
}

const DEFAULT_CHROMAKEY_POLICY: ChromakeyPolicy = {
  contentClass: "simple",
  keyColor: { red: 0, green: 255, blue: 0 },
  // Image generators commonly vary a requested #00FF00 background by a few
  // dozen RGB values. The chromakey implementation also verifies green
  // dominance, so this remains limited to deliberate green-screen jobs.
  tolerance: 64
};

function defaultChromakeyPolicy(
  request: ImageOperationRequest
): ChromakeyPolicy | undefined {
  // Both modes use the executor's deterministic green-screen instruction on
  // routes without verified native alpha. Auto is therefore a controlled
  // choice made before generation, never an attempt to key an arbitrary scene.
  return request.transparentMode === "chromakey"
    ? DEFAULT_CHROMAKEY_POLICY
    : request.transparentMode === "auto"
      ? { ...DEFAULT_CHROMAKEY_POLICY, autoEligible: true }
      : undefined;
}

export interface CreationExecutionContext {
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly provider?: ProviderRuntimeContext;
  readonly onEvent?: (event: ImageOperationEvent) => void | Promise<void>;
}

export type CreationExecution = (
  request: ImageOperationRequest,
  context: CreationExecutionContext
) => Promise<unknown>;

export interface LocalRoutegoServiceOptions {
  readonly library: RoutegoLibraryService;
  readonly stagingRoot: string;
  readonly ephemeralResources: EphemeralImageResourceRegistry;
  readonly studioSession: () => StudioSessionContext | Promise<StudioSessionContext>;
  readonly openStudio: (input: RoutegoOpenStudioInput) => Promise<unknown>;
  readonly serviceHealth?:
    | RoutegoStatusResult["service"]
    | (() => RoutegoStatusResult["service"] | Promise<RoutegoStatusResult["service"]>);
  readonly approveOutputDirectory?: (requestedDirectory: string) => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly providerContextOptions?: Omit<LoadProviderContextOptions, "fetch">;
  readonly modelRefreshOptions?: Omit<RefreshProviderModelsOptions, "fetch">;
  readonly now?: () => Date;
  readonly createId?: (scope: string, order?: number, attempt?: number) => string;
  readonly maximumImageBytes?: number;
  readonly executeCreation?: CreationExecution;
  readonly defaultModel?: string;
  readonly chromakeyPolicy?: (
    request: ImageOperationRequest,
    output: MaterializedImageOutput
  ) => ChromakeyPolicy | undefined;
  readonly backgroundRemoval?: (
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal }
  ) => Promise<BackgroundRemovalResult>;
}

export interface StudioExecutionOptions {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: StudioImageOperationEvent) => void | Promise<void>;
}

interface ActiveOperation {
  readonly controller: AbortController;
  readonly promise: Promise<unknown>;
}

interface PreparedPublicOperation {
  readonly request: ImageOperationRequest;
  readonly graph: DurableInputGraphPlan;
}

interface PublicInputDescriptor {
  readonly key: StudioPhysicalInputKey;
  readonly role: "target" | "reference";
  readonly order: number;
  readonly path: string;
  readonly prepared: PreparedImageInput;
  readonly id?: string;
  readonly label?: string;
  readonly referenceRole?: ImageOperationRequest["references"][number]["role"];
  readonly targetSlot?: 0;
}

type ParsedStudioBatchInput = ReturnType<typeof studioBatchInputSchema.parse>;

const FIXED_BATCH_CONCURRENCY = 2 as const;

interface ProviderSnapshot {
  readonly context?: ProviderRuntimeContext;
  readonly model: string;
}

function freezeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}

function freezeProviderSnapshot(provider: ProviderSnapshot): ProviderSnapshot {
  if (provider.context === undefined) return Object.freeze({ model: provider.model });
  const context = provider.context;
  return Object.freeze({
    model: provider.model,
    context: Object.freeze({
      ...context,
      endpoints: Object.freeze({ ...context.endpoints }),
      capabilities: Object.freeze([...context.capabilities]),
      deadlines: Object.freeze({ ...context.deadlines }),
      retry: Object.freeze({ ...context.retry })
    })
  });
}

class StudioEventQueue implements AsyncIterable<StudioImageOperationEvent> {
  readonly #events: StudioImageOperationEvent[] = [];
  readonly #waiters: Array<(result: IteratorResult<StudioImageOperationEvent>) => void> = [];
  #closed = false;

  push(event: StudioImageOperationEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter({ done: false, value: event });
    else this.#events.push(event);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    while (this.#waiters.length > 0) this.#waiters.shift()?.({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<StudioImageOperationEvent> {
    return {
      next: async () => {
        const event = this.#events.shift();
        if (event !== undefined) return { done: false, value: event };
        if (this.#closed) return { done: true, value: undefined };
        return await new Promise<IteratorResult<StudioImageOperationEvent>>((resolve) => {
          this.#waiters.push(resolve);
        });
      },
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      }
    };
  }
}

function nowDate(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("The Integration clock is invalid.");
  }
  return value;
}

function defaultDefaults(): RoutegoStatusResult["defaults"] {
  return {
    size: "auto",
    aspectRatio: "auto",
    quality: "auto",
    format: "png",
    count: 1,
    partialImages: 0,
    transparentMode: "off",
    moderation: "auto",
    saveToLibrary: true
  };
}

const PUBLIC_DEFAULT_CONTROL_KEYS = [
  "size",
  "aspectRatio",
  "quality",
  "format",
  "count",
  "partialImages",
  "transparentMode",
  "moderation",
  "saveToLibrary"
] as const;

function hasOwn(input: unknown, key: string): boolean {
  return input !== null && typeof input === "object" && Object.hasOwn(input, key);
}

function resolvePublicImageRequest(
  input: RoutegoGenerateInput | RoutegoEditInput,
  defaults: RoutegoStatusResult["defaults"]
): ImageOperationRequest {
  const parsed = imageOperationRequestSchema.parse(input);
  const resolved = { ...parsed } as Record<string, unknown>;
  for (const key of PUBLIC_DEFAULT_CONTROL_KEYS) {
    if (!hasOwn(input, key)) resolved[key] = defaults[key];
  }
  return imageOperationRequestSchema.parse(resolved);
}

function outputContractError(
  request: ImageOperationRequest,
  result: ImageOperationResult
): ProviderIntegrationError | undefined {
  if (result.status !== "succeeded") return undefined;
  const expectedMimeType = request.format === "png"
    ? "image/png"
    : request.format === "jpeg"
      ? "image/jpeg"
      : "image/webp";
  const violations: string[] = [];
  if (result.finalArtifacts.length !== request.count) {
    violations.push("count");
  }
  for (const artifact of result.finalArtifacts) {
    if (artifact.mimeType !== expectedMimeType) violations.push("format");
  }
  if (violations.length === 0) return undefined;
  const actualOutputs = result.finalArtifacts.map((artifact) => ({
    ...(artifact.width === undefined ? {} : { width: artifact.width }),
    ...(artifact.height === undefined ? {} : { height: artifact.height }),
    ...(artifact.mimeType === undefined ? {} : { mimeType: artifact.mimeType })
  }));
  const observedExecution = {
    ...(result.execution.transport === undefined ? {} : { transport: result.execution.transport }),
    providerRequestCount: result.execution.providerRequestCount
  };
  return new ProviderIntegrationError(createProviderServiceError({
    code: "invalid_response",
    stage: "complete",
    safeMessage: "The provider output does not match the requested format or output count.",
    mayHaveBilled: result.execution.mayHaveBilled,
    details: {
      mismatches: [...new Set(violations)],
      ...(actualOutputs.length === 0 ? {} : { actualOutputs }),
      observedExecution
    }
  }));
}

function defaultHealth(status: RoutegoStatusResult["service"]["status"]): RoutegoStatusResult["service"] {
  return routegoServiceHealthSchema.parse({
    status,
    version: "1.0.6",
    nodeVersion: process.version,
    uptimeSeconds: 0,
    mcpAvailable: false,
    httpAvailable: false,
    studioAvailable: false
  });
}

function safeMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0 && error.message.length <= 1_000) {
    return redactProviderText(error.message);
  }
  return fallback;
}

function errorFromUnknown(
  error: unknown,
  fallbackCode: RoutegoServiceError["code"] = "internal_contract",
  receivedAnyOutput = false,
  mayHaveBilled = false
): RoutegoServiceError {
  const withObservedExecution = (serviceError: RoutegoServiceError): RoutegoServiceError => {
    const observedOutput = serviceError.receivedAnyOutput || receivedAnyOutput;
    const observedBilling = serviceError.mayHaveBilled || mayHaveBilled || observedOutput;
    return routegoServiceErrorSchema.parse({
      ...serviceError,
      receivedAnyOutput: observedOutput,
      mayHaveBilled: observedBilling,
      ...(observedOutput || observedBilling ? { retryDisposition: "never" } : {})
    });
  };
  if (error instanceof ProviderIntegrationError) {
    return withObservedExecution(error.serviceError);
  }
  const codeCandidate =
    error !== null && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  const known = [
    "config_missing", "config_corrupt", "invalid_request", "invalid_input",
    "capability_unavailable", "auth_failed", "rate_limited", "timeout",
    "moderation_blocked", "provider_5xx", "invalid_response", "internal_contract",
    "download_failed", "postprocess_failed", "file_write_failed", "conflict",
    "access_denied", "origin_rejected", "session_invalid", "path_unsafe",
    "cancelled", "not_found"
  ] as const;
  const code = typeof codeCandidate === "string" && (known as readonly string[]).includes(codeCandidate)
    ? codeCandidate as RoutegoServiceError["code"]
    : fallbackCode;
  const stage: RoutegoServiceError["stage"] = code === "cancelled" ? "complete" : "validate";
  return withObservedExecution(createProviderServiceError({
    code,
    stage,
    safeMessage: safeMessage(error, "The local image operation failed safely."),
    mayHaveBilled: mayHaveBilled || receivedAnyOutput,
    details: boundedRedactedDiagnostic(error)
  }));
}

function failureResult(
  request: ImageOperationRequest,
  requestId: string,
  error: RoutegoServiceError,
  status: ImageOperationResult["status"] = error.code === "cancelled" ? "cancelled" : "failed"
): ImageOperationResult {
  return imageOperationResultSchema.parse({
    schemaVersion: 1,
    requestId,
    status,
    requestedParams: request,
    effectiveParams: request,
    execution: {
      attemptCount: 0,
      providerRequestCount: 0,
      receivedAnyOutput: error.receivedAnyOutput,
      mayHaveBilled: error.mayHaveBilled,
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

function studioError(
  error: RoutegoServiceError,
  partialArtifacts: readonly StudioImageArtifact[] = []
): ReturnType<typeof studioServiceErrorSchema.parse> {
  return studioServiceErrorSchema.parse({
    code: error.code,
    category: error.category,
    stage: error.stage,
    safeMessage: error.safeMessage,
    retryDisposition: error.retryDisposition,
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
    ...(error.capability === undefined ? {} : { capability: error.capability }),
    partialArtifacts: partialArtifacts.slice(0, 4),
    receivedAnyOutput: error.receivedAnyOutput,
    mayHaveBilled: error.mayHaveBilled
  });
}

function studioFailureResult(
  request: StudioImageOperationRequest,
  requestId: string,
  error: RoutegoServiceError,
  partialArtifacts: readonly StudioImageArtifact[] = []
): StudioImageOperationResult {
  const projectedError = studioError(error, partialArtifacts);
  return studioImageOperationResultSchema.parse({
    schemaVersion: 1,
    requestId,
    status: "failed",
    requestedParams: request,
    effectiveParams: request,
    execution: {
      attemptCount: 0,
      providerRequestCount: 0,
      receivedAnyOutput: error.receivedAnyOutput,
      mayHaveBilled: error.mayHaveBilled,
      degradedContinuation: false,
      providerImageIds: []
    },
    finalArtifacts: [],
    partialArtifacts,
    failedSlots: [{ slot: 0, error: projectedError }],
    relationships: [],
    error: projectedError
  });
}

function inputIdFactory(
  makeId: (scope: string, order?: number, attempt?: number) => string
): InputGraphIdFactory {
  return (kind, order, attempt) => makeId(kind, order, attempt);
}

function resultIdFactory(
  makeId: (scope: string, order?: number, attempt?: number) => string
): ResultGraphIdFactory {
  return (kind, order, attempt) => makeId(kind, order, attempt);
}

function normalizedPath(value: string): string {
  return path.normalize(value).replaceAll("\\", "/").toLowerCase();
}

function resourceMatchesPrepared(
  resource: ResolvedStableImageResource,
  prepared: PreparedImageInput,
  requestedPath: string
): resource is VerifiedStudioImageResource {
  return (
    path.isAbsolute(resource.path) &&
    normalizedPath(resource.path) === normalizedPath(requestedPath) &&
    resource.mimeType === prepared.mimeType &&
    resource.byteLength === prepared.byteLength &&
    resource.width === prepared.width &&
    resource.height === prepared.height
  );
}

function descriptorResource(
  descriptor: PublicInputDescriptor,
  resource: ResolvedStableImageResource | undefined,
  makeId: (scope: string, order?: number, attempt?: number) => string,
  now: Date
): VerifiedStudioImageResource {
  if (resource !== undefined) {
    if (!resourceMatchesPrepared(resource, descriptor.prepared, descriptor.path)) {
      throw new Error("The public image identity does not match its validated path.");
    }
    return resource;
  }
  const uploadResourceId = makeId(`public-upload-${descriptor.role}`, descriptor.order, 0);
  return {
    source: "upload",
    uploadResourceId,
    purpose: descriptor.role,
    path: descriptor.path,
    mimeType: descriptor.prepared.mimeType,
    byteLength: descriptor.prepared.byteLength,
    sha256: createHash("sha256").update(descriptor.prepared.bytes).digest("hex"),
    width: descriptor.prepared.width,
    height: descriptor.prepared.height,
    expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    reusePolicy: "reusable-until-expiry"
  };
}

function publicRequestWithIds(
  request: ImageOperationRequest,
  graph: DurableInputGraphPlan
): ImageOperationRequest {
  const byKey = new Map(graph.inputs.map((item) => [item.key, item]));
  const references = request.references.map((reference, index) => ({
    ...reference,
    id: byKey.get(`reference:${index}`)?.artifactId
  }));
  if (request.kind !== "edit") {
    return imageOperationRequestSchema.parse({ ...request, references });
  }
  return imageOperationRequestSchema.parse({
    ...request,
    targetImage: {
      ...request.targetImage,
      id: byKey.get("target")?.artifactId
    },
    references
  });
}

function outputArtifactWithBytes(
  artifact: ImageOperationResult["finalArtifacts"][number],
  output: MaterializedImageOutput,
  bytes: Uint8Array
): ImageOperationResult["finalArtifacts"][number] {
  return {
    ...artifact,
    mimeType: output.mimeType,
    byteLength: output.byteLength,
    width: output.width,
    height: output.height,
    sha256: output.sha256,
    display: {
      type: "image",
      dataUrl: `data:${output.mimeType};base64,${Buffer.from(bytes).toString("base64")}`
    }
  };
}

function combineMaterialization(
  transaction: OutputMaterializationTransaction,
  result: ImageOperationResult,
  failures: MaterializationBatchResult["failures"]
): MaterializationBatchResult {
  const outputs = [...transaction.selectedOutputs].filter((output) =>
    [...result.partialArtifacts, ...result.finalArtifacts].some((artifact) => artifact.id === output.artifactId)
  );
  return {
    outputs,
    failures,
    receivedAnyOutput: result.execution.receivedAnyOutput || outputs.length > 0,
    mayHaveBilled: result.execution.mayHaveBilled || outputs.length > 0
  };
}

export class ProductionLocalRoutegoService implements LocalRoutegoService {
  readonly #options: LocalRoutegoServiceOptions;
  readonly #startedAt: Date;
  readonly #active = new Map<string, ActiveOperation>();
  readonly #activePromises = new Set<Promise<unknown>>();
  #status: RoutegoStatusResult["service"]["status"] = "starting";
  #recoveryError: RoutegoServiceError | undefined;

  constructor(options: LocalRoutegoServiceOptions) {
    if (!options || typeof options.library !== "object" || typeof options.stagingRoot !== "string") {
      throw new TypeError("Integration requires one Library owner and an approved staging root.");
    }
    this.#options = options;
    this.#startedAt = nowDate(options.now ?? (() => new Date()));
  }

  #now(): Date {
    return nowDate(this.#options.now ?? (() => new Date()));
  }

  #id(scope: string, order = 0, attempt = 0): string {
    const value = this.#options.createId?.(scope, order, attempt) ?? randomUUID();
    const parsed = String(value).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(parsed) || parsed.length > 120) {
      throw new Error("The Integration identity allocator returned an invalid identifier.");
    }
    return `${scope}:${parsed}`;
  }

  async recover(): Promise<void> {
    try {
      await this.#options.library.recover();
      await this.#options.ephemeralResources.cleanupExpired();
      await this.#cleanupStaging();
      this.#recoveryError = undefined;
      this.#status = "ready";
    } catch (error) {
      this.#recoveryError = errorFromUnknown(error, "config_corrupt");
      this.#status = "degraded";
    }
  }

  async close(): Promise<void> {
    this.#status = "stopping";
    for (const active of this.#active.values()) active.controller.abort("service-shutdown");
    await Promise.allSettled([...this.#activePromises]);
    await this.#options.ephemeralResources.shutdown().catch(() => 0);
  }

  cancelOperation(requestId: string): boolean {
    const active = this.#active.get(requestId);
    if (active === undefined) return false;
    active.controller.abort("operation-cancelled");
    return true;
  }

  async #cleanupStaging(): Promise<void> {
    await mkdir(this.#options.stagingRoot, { recursive: true, mode: 0o700 });
    const root = await realpath(this.#options.stagingRoot);
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      if (!entry.name.startsWith("request-") || !entry.isDirectory()) return;
      const candidate = path.join(root, entry.name);
      const resolved = await realpath(candidate).catch(() => undefined);
      if (resolved === undefined || !normalizedPath(resolved).startsWith(`${normalizedPath(root)}/`)) return;
      await rm(resolved, { recursive: true, force: true });
    }));
  }

  async #health(): Promise<RoutegoStatusResult["service"]> {
    const configured = typeof this.#options.serviceHealth === "function"
      ? await this.#options.serviceHealth()
      : this.#options.serviceHealth ?? defaultHealth(this.#status);
    return routegoServiceHealthSchema.parse({
      ...configured,
      status: this.#status,
      uptimeSeconds: Math.max(0, (this.#now().getTime() - this.#startedAt.getTime()) / 1_000)
    });
  }

  async status(input: RoutegoStatusInput): Promise<RoutegoStatusResult> {
    const parsed = routegoStatusInputSchema.parse(input);
    const service = await this.#health();
    try {
      // The public status contract has no exact probe descriptor. These flags only request a fresh
      // redacted status snapshot; billable probes remain the explicit Studio operation.
      void parsed;
      return routegoStatusResultSchema.parse(
        await readProviderStatus(this.#options.library.settingsStore, { service })
      );
    } catch (error) {
      this.#recoveryError = errorFromUnknown(error, "config_corrupt");
      this.#status = "degraded";
      return routegoStatusResultSchema.parse({
        schemaVersion: 1,
        configured: false,
        hasApiKey: false,
        models: [],
        capabilities: [],
        defaults: defaultDefaults(),
        service: await this.#health()
      });
    }
  }

  async readSettings(input: ReadSettingsInput): Promise<ReadSettingsResult> {
    return readSettingsResultSchema.parse(await this.#options.library.readSettings(readSettingsInputSchema.parse(input)));
  }

  async readLegacyLibraryMigration(
    input: ReadLegacyLibraryMigrationInput
  ): Promise<LegacyLibraryMigrationState> {
    return legacyLibraryMigrationStateSchema.parse(
      await this.#options.library.readLegacyLibraryMigration(readLegacyLibraryMigrationInputSchema.parse(input))
    );
  }

  async confirmLegacyLibraryMigration(
    input: ConfirmLegacyLibraryMigrationInput
  ): Promise<ConfirmLegacyLibraryMigrationResult> {
    const result = confirmLegacyLibraryMigrationResultSchema.parse(
      await this.#options.library.confirmLegacyLibraryMigration(
        confirmLegacyLibraryMigrationInputSchema.parse(input)
      )
    );
    if (result.status === "succeeded") await this.recover();
    return result;
  }

  async upsertProviderProfile(input: UpsertProviderProfileInput): Promise<UpsertProviderProfileResult> {
    return upsertProviderProfileResultSchema.parse(await this.#options.library.upsertProviderProfile(upsertProviderProfileInputSchema.parse(input)));
  }

  async removeProviderProfile(input: RemoveProviderProfileInput): Promise<RemoveProviderProfileResult> {
    return removeProviderProfileResultSchema.parse(await this.#options.library.removeProviderProfile(removeProviderProfileInputSchema.parse(input)));
  }

  async setActiveProviderProfile(input: SetActiveProviderProfileInput): Promise<SetActiveProviderProfileResult> {
    return setActiveProviderProfileResultSchema.parse(await this.#options.library.setActiveProviderProfile(setActiveProviderProfileInputSchema.parse(input)));
  }

  async studioProviderSwitch(input: StudioProviderSwitchInput): Promise<StudioProviderSwitchResult> {
    const parsed = studioProviderSwitchInputSchema.parse(input);
    try {
      return studioProviderSwitchResultSchema.parse(await this.#options.library.studioProviderSwitch(parsed));
    } catch (error) {
      return studioProviderSwitchResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        error: errorFromUnknown(error, "config_missing")
      });
    }
  }

  async refreshModels(input: RefreshModelsInput): Promise<RefreshModelsResult> {
    const parsed = refreshModelsInputSchema.parse(input);
    const options = {
      ...(this.#options.modelRefreshOptions ?? {}),
      ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch })
    };
    return refreshModelsResultSchema.parse(await refreshProviderModels(this.#options.library.settingsStore, parsed, options));
  }

  async updateSettings(input: UpdateSettingsInput): Promise<UpdateSettingsResult> {
    return updateSettingsResultSchema.parse(await this.#options.library.updateSettings(updateSettingsInputSchema.parse(input)));
  }

  async searchLibrary(input: RoutegoSearchLibraryInput): Promise<RoutegoSearchLibraryResult> {
    return routegoSearchLibraryResultSchema.parse(await this.#options.library.searchLibrary(routegoSearchLibraryInputSchema.parse(input)));
  }

  async manageLibrary(input: RoutegoManageLibraryInput): Promise<RoutegoManageLibraryResult> {
    return routegoManageLibraryResultSchema.parse(await this.#options.library.manageLibrary(routegoManageLibraryInputSchema.parse(input)));
  }

  async prepareRegeneration(
    input: RoutegoPrepareRegenerationInput
  ): Promise<RoutegoPrepareRegenerationResult> {
    const parsed = routegoPrepareRegenerationInputSchema.parse(input);
    return routegoPrepareRegenerationResultSchema.parse(
      await this.#options.library.galleryService.prepareRegeneration(parsed)
    );
  }

  async searchStudioLibrary(input: StudioLibrarySearchInput): Promise<StudioLibrarySearchResult> {
    return studioLibrarySearchResultSchema.parse(await this.#options.library.searchStudioLibrary(studioLibrarySearchInputSchema.parse(input)));
  }

  async listFolders(input: ListFoldersInput): Promise<ListFoldersResult> {
    return listFoldersResultSchema.parse(await this.#options.library.listFolders(listFoldersInputSchema.parse(input)));
  }

  async reorderFolders(input: ReorderFoldersInput): Promise<ReorderFoldersResult> {
    return reorderFoldersResultSchema.parse(await this.#options.library.reorderFolders(reorderFoldersInputSchema.parse(input)));
  }

  async getAssetDetail(input: GetAssetDetailInput): Promise<GetAssetDetailResult> {
    return getAssetDetailResultSchema.parse(await this.#options.library.getAssetDetail(getAssetDetailInputSchema.parse(input)));
  }

  async getBrowserResource(input: GetBrowserResourceInput): Promise<GetBrowserResourceResult> {
    return getBrowserResourceResultSchema.parse(await this.#options.library.getBrowserResource(getBrowserResourceInputSchema.parse(input)));
  }

  async preflightLibraryMutation(input: PreflightLibraryMutationInput): Promise<PreflightLibraryMutationResult> {
    return preflightLibraryMutationResultSchema.parse(await this.#options.library.preflightLibraryMutation(preflightLibraryMutationInputSchema.parse(input)));
  }

  async executeLibraryMutation(input: ExecuteLibraryMutationInput): Promise<ExecuteLibraryMutationResult> {
    return executeLibraryMutationResultSchema.parse(await this.#options.library.executeLibraryMutation(executeLibraryMutationInputSchema.parse(input)));
  }

  async reserveUploadResource(input: ReserveUploadResourceInput): Promise<ReserveUploadResourceResult> {
    return reserveUploadResourceResultSchema.parse(await this.#options.library.reserveUploadResource(reserveUploadResourceInputSchema.parse(input)));
  }

  async finalizeUploadResource(input: FinalizeUploadResourceInput): Promise<FinalizeUploadResourceResult> {
    return finalizeUploadResourceResultSchema.parse(await this.#options.library.finalizeUploadResource(finalizeUploadResourceInputSchema.parse(input)));
  }

  async getUploadResourceStatus(input: GetUploadResourceStatusInput): Promise<GetUploadResourceStatusResult> {
    return getUploadResourceStatusResultSchema.parse(await this.#options.library.getUploadResourceStatus(getUploadResourceStatusInputSchema.parse(input)));
  }

  async discardUploadResource(input: DiscardUploadResourceInput): Promise<DiscardUploadResourceResult> {
    return discardUploadResourceResultSchema.parse(await this.#options.library.discardUploadResource(discardUploadResourceInputSchema.parse(input)));
  }

  async openStudio(input: RoutegoOpenStudioInput): Promise<RoutegoOpenStudioResult> {
    const parsed = routegoOpenStudioInputSchema.parse(input);
    return routegoOpenStudioResultSchema.parse(await this.#options.openStudio(parsed));
  }

  async #approveOutputDirectory(requestedDirectory: string): Promise<string> {
    if (this.#options.approveOutputDirectory !== undefined) {
      return await this.#options.approveOutputDirectory(requestedDirectory);
    }
    const configured = await this.#options.library.settingsStore.resolveOutputDirectory();
    if (configured === undefined || normalizedPath(configured) !== normalizedPath(requestedDirectory)) {
      throw new Error("The requested output directory is not the configured approved directory.");
    }
    return configured;
  }

  async #preparePublic(request: ImageOperationRequest): Promise<PreparedPublicOperation> {
    const prepared = await prepareImageInputs(request);
    const descriptors: PublicInputDescriptor[] = [];
    let order = 0;
    if (request.kind === "edit") {
      const target = prepared.images.find((item) => item.kind === "target");
      if (target === undefined) throw new Error("The prepared target image is missing.");
      descriptors.push({
        key: "target",
        role: "target",
        order: order++,
        path: target.path,
        prepared: target,
        ...(request.targetImage.id === undefined ? {} : { id: request.targetImage.id }),
        ...(request.targetImage.label === undefined ? {} : { label: request.targetImage.label })
      });
    }
    const preparedReferences = prepared.images.filter((item) => item.kind === "reference");
    request.references.forEach((reference, index) => {
      const item = preparedReferences[index];
      if (item === undefined) throw new Error("The prepared reference image is missing.");
      descriptors.push({ key: `reference:${index}`, role: "reference", order: order++, path: item.path, prepared: item, ...(reference.id === undefined ? {} : { id: reference.id }), referenceRole: reference.role, ...(reference.label === undefined ? {} : { label: reference.label }) });
    });
    const now = this.#now();
    const resolved: ResolvedStudioPhysicalInput[] = [];
    for (const descriptor of descriptors) {
      let libraryResource: ResolvedStableImageResource | undefined;
      if (descriptor.id !== undefined) {
        libraryResource = await this.#options.library.resolveImageResource({ source: "artifact", artifactId: descriptor.id });
      }
      const resource = descriptorResource(descriptor, libraryResource, this.#id.bind(this), now);
      resolved.push({
        key: descriptor.key,
        role: descriptor.role,
        order: descriptor.order,
        resource,
        ...(descriptor.referenceRole === undefined ? {} : { referenceRole: descriptor.referenceRole }),
        ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
        ...(descriptor.targetSlot === undefined ? {} : { targetSlot: descriptor.targetSlot })
      });
    }
    const graph = buildDurableInputGraph(resolved, { idFactory: inputIdFactory(this.#id.bind(this)) });
    return { request: publicRequestWithIds(request, graph), graph };
  }

  async #provider(
    requestId: string,
    signal: AbortSignal
  ): Promise<ProviderSnapshot> {
    if (this.#options.executeCreation !== undefined) {
      return freezeProviderSnapshot({ model: this.#options.defaultModel ?? "synthetic-model" });
    }
    const providerOptions = {
      ...(this.#options.providerContextOptions ?? {}),
      ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch })
    };
    void requestId;
    void signal;
    const context = await loadProviderContext(this.#options.library.settingsStore, {}, providerOptions);
    return freezeProviderSnapshot({ context, model: context.model });
  }

  async #publicDefaults(): Promise<RoutegoStatusResult["defaults"]> {
    return (await this.#options.library.readSettings({})).defaults;
  }

  async #executeCreation(
    request: ImageOperationRequest,
    context: CreationExecutionContext
  ): Promise<unknown> {
    if (this.#options.executeCreation !== undefined) {
      return await this.#options.executeCreation(request, context);
    }
    if (context.provider === undefined) throw new Error("Provider context is unavailable.");
    const dependencies: ImageExecutionDependencies = {
      providerContext: context.provider,
      createRequestId: () => context.requestId,
      ...(this.#options.maximumImageBytes === undefined ? {} : { maximumImageBytes: this.#options.maximumImageBytes })
    };
    const executor = createResolvedImageExecutor(dependencies);
    return await executor.execute(request, {
      signal: context.signal,
      ...(context.onEvent === undefined ? {} : { onEvent: context.onEvent })
    });
  }

  async #materialize(
    transaction: OutputMaterializationTransaction,
    result: ImageOperationResult,
    sourceCount: number
  ): Promise<MaterializationBatchResult> {
    const artifacts = [...result.partialArtifacts, ...result.finalArtifacts];
    const failures: MaterializationFailure[] = [];
    for (const artifact of artifacts) {
      if (transaction.selectedOutput(artifact.id) !== undefined) continue;
      try {
        await transaction.materializeArtifact(artifact);
      } catch (error) {
        const materialization = error instanceof ImageMaterializationError
          ? error
          : new ImageMaterializationError("staging-write-failed", "The provider output could not be materialized.");
        failures.push({ artifactId: artifact.id, slot: artifact.slot, phase: artifact.phase, code: materialization.code, safeMessage: materialization.message });
      }
    }
    void sourceCount;
    return combineMaterialization(transaction, result, failures);
  }

  async #postprocess(
    request: ImageOperationRequest,
    result: ImageOperationResult,
    materialization: MaterializationBatchResult,
    transaction: OutputMaterializationTransaction,
    signal?: AbortSignal
  ): Promise<{ readonly result: ImageOperationResult; readonly materialization: MaterializationBatchResult }> {
    if (request.transparentMode === "native") {
      return await this.#postprocessNativeTransparency(result, materialization, transaction, signal);
    }
    if (request.transparentMode !== "chromakey" && request.transparentMode !== "auto") {
      return { result, materialization };
    }
    const issues: string[] = [];
    const replacements = new Map<string, MaterializedImageOutput>();
    for (const output of materialization.outputs.filter((candidate) => candidate.phase === "final")) {
      const policy = this.#options.chromakeyPolicy?.(request, output) ?? defaultChromakeyPolicy(request);
      if (policy === undefined) {
        issues.push("Transparency processing requires an explicit approved chromakey policy.");
        continue;
      }
      try {
        const processed = await applyPngChromakey({
          transaction,
          output,
          requestedMode: request.transparentMode,
          ...policy
        });
        if (processed.status === "applied") replacements.set(output.artifactId, processed.output);
        else issues.push(processed.warning.safeMessage);
      } catch {
        issues.push("Transparency post-processing failed safely.");
      }
    }
    if (replacements.size === 0 && issues.length === 0) return { result, materialization };
    const updatedFinal = await Promise.all(result.finalArtifacts.map(async (artifact) => {
      const replacement = replacements.get(artifact.id);
      if (replacement === undefined) return artifact;
      return outputArtifactWithBytes(artifact, replacement, await transaction.readValidatedBytes(replacement));
    }));
    const updatedResult = imageOperationResultSchema.parse({
      ...result,
      finalArtifacts: updatedFinal,
      ...(issues.length === 0 ? {} : {
        status: result.status === "failed" ? "failed" : "partial",
        error: createProviderServiceError({
          code: "postprocess_failed",
          stage: "postprocess",
          safeMessage: issues[0] ?? "Transparency post-processing did not complete.",
          mayHaveBilled: result.execution.mayHaveBilled,
          details: { warnings: issues.slice(0, 4) }
        })
      })
    });
    return {
      result: updatedResult,
      materialization: combineMaterialization(transaction, updatedResult, materialization.failures)
    };
  }

  async #normalizeOutputDimensions(
    request: ImageOperationRequest,
    result: ImageOperationResult,
    materialization: MaterializationBatchResult,
    transaction: OutputMaterializationTransaction
  ): Promise<{ readonly result: ImageOperationResult; readonly materialization: MaterializationBatchResult }> {
    if (
      result.status !== "succeeded" ||
      (request.format !== "png" && request.format !== "jpeg") ||
      request.size === "auto"
    ) {
      return { result, materialization };
    }
    const match = /^(\d+)x(\d+)$/u.exec(request.size);
    if (match === null) return { result, materialization };
    const targetWidth = Number(match[1]);
    const targetHeight = Number(match[2]);
    const replacements = new Map<string, MaterializedImageOutput>();
    for (const output of materialization.outputs.filter((candidate) => candidate.phase === "final")) {
      try {
        const replacement = await normalizeProviderRasterOutput({
          transaction,
          output,
          targetWidth,
          targetHeight,
          targetMimeType: request.format === "png" ? "image/png" : "image/jpeg"
        });
        if (replacement !== undefined && replacement.path !== output.path) {
          replacements.set(output.artifactId, replacement);
        }
      } catch {
        // The strict output contract below reports any format or dimension that
        // could not be normalized within the bounded raster policy.
      }
    }
    if (replacements.size === 0) return { result, materialization };
    const finalArtifacts = await Promise.all(result.finalArtifacts.map(async (artifact) => {
      const replacement = replacements.get(artifact.id);
      if (replacement === undefined) return artifact;
      return outputArtifactWithBytes(
        artifact,
        replacement,
        await transaction.readValidatedBytes(replacement)
      );
    }));
    const normalizedResult = imageOperationResultSchema.parse({ ...result, finalArtifacts });
    return {
      result: normalizedResult,
      materialization: combineMaterialization(transaction, normalizedResult, materialization.failures)
    };
  }

  async #postprocessNativeTransparency(
    result: ImageOperationResult,
    materialization: MaterializationBatchResult,
    transaction: OutputMaterializationTransaction,
    signal?: AbortSignal
  ): Promise<{ readonly result: ImageOperationResult; readonly materialization: MaterializationBatchResult }> {
    const replacements = new Map<string, MaterializedImageOutput>();
    const issues: string[] = [];
    const outputs = materialization.outputs.filter((candidate) => candidate.phase === "final");
    for (const output of outputs) {
      let originalBytes: Uint8Array;
      try {
        originalBytes = await transaction.readValidatedBytes(output);
      } catch {
        issues.push("The validated provider original could not be read for transparency inspection.");
        continue;
      }
      const alpha = inspectPngAlpha(originalBytes, output.width, output.height);
      if (!("code" in alpha)) continue;

      let processed: BackgroundRemovalResult;
      try {
        const removalOptions = signal === undefined ? undefined : { signal };
        processed = await (this.#options.backgroundRemoval ?? removeBackground)(originalBytes, removalOptions);
      } catch {
        issues.push("Local transparency processing failed safely; the provider original remains available.");
        continue;
      }
      if (processed.status !== "succeeded") {
        issues.push(processed.error.message);
        continue;
      }
      try {
        replacements.set(
          output.artifactId,
          await transaction.stageReplacement(output, processed.transparentBytes, "image/png")
        );
        // A local segmentation result has real alpha but is not proof that
        // this provider delivered the requested native alpha. Preserve it for
        // review without ever presenting it as a verified native success.
        issues.push(
          "The provider did not return verified native alpha; the local transparent fallback requires visual review."
        );
      } catch {
        issues.push("The transparent rendition failed bounded output validation; the provider original remains available.");
      }
    }
    if (replacements.size === 0 && issues.length === 0) return { result, materialization };
    const updatedFinal = await Promise.all(result.finalArtifacts.map(async (artifact) => {
      const replacement = replacements.get(artifact.id);
      if (replacement === undefined) return artifact;
      return outputArtifactWithBytes(artifact, replacement, await transaction.readValidatedBytes(replacement));
    }));
    const updatedResult = imageOperationResultSchema.parse({
      ...result,
      finalArtifacts: updatedFinal,
      ...(issues.length === 0 ? {} : {
        status: result.status === "failed" ? "failed" : "partial",
        error: createProviderServiceError({
          code: "postprocess_failed",
          stage: "postprocess",
          safeMessage: issues[0] ?? "Transparent rendition processing did not complete.",
          mayHaveBilled: result.execution.mayHaveBilled,
          details: { warnings: issues.slice(0, 4), providerRequestCount: result.execution.providerRequestCount }
        })
      })
    });
    return {
      result: updatedResult,
      materialization: combineMaterialization(transaction, updatedResult, materialization.failures)
    };
  }

  async #executePublic(
    input: ImageOperationRequest,
    signal?: AbortSignal,
    providerSnapshot?: ProviderSnapshot,
    allowUnverifiedDirectEdit = false
  ): Promise<ImageOperationResult> {
    const requestId = this.#id("request");
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason ?? "operation-cancelled");
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener("abort", forwardAbort, { once: true });
    const promise = this.#executePublicInner(
      requestId,
      input,
      controller.signal,
      providerSnapshot,
      allowUnverifiedDirectEdit
    );
    this.#active.set(requestId, { controller, promise });
    this.#activePromises.add(promise);
    try {
      return await promise;
    } finally {
      this.#active.delete(requestId);
      this.#activePromises.delete(promise);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  async #executePublicInner(
    requestId: string,
    input: ImageOperationRequest,
    signal: AbortSignal,
    providerSnapshot?: ProviderSnapshot,
    allowUnverifiedDirectEdit = false
  ): Promise<ImageOperationResult> {
    let transaction: OutputMaterializationTransaction | undefined;
    let creationInvoked = false;
    try {
      if (signal.aborted) return failureResult(input, requestId, errorFromUnknown({ code: "cancelled" }, "cancelled"));
      const plan = await preflightPublicOutputDestination(input, {
        approveOutputDirectory: (directory) => this.#approveOutputDirectory(directory)
      });
      const prepared = await this.#preparePublic(input);
      transaction = await createOutputMaterializationTransaction({
        stagingRoot: this.#options.stagingRoot,
        requestId,
        ...(this.#options.maximumImageBytes === undefined ? {} : { maximumImageBytes: this.#options.maximumImageBytes })
      });
      const staged = await stagePreparedPublicOperationSources(prepared, { transaction });
      const selectedProvider = providerSnapshot ?? await this.#provider(requestId, signal);
      const isDirectReferenceGeneration = input.kind === "generate" && input.references.length > 0;
      const allowUnverifiedImageInput = allowUnverifiedDirectEdit || isDirectReferenceGeneration;
      const provider = allowUnverifiedImageInput && selectedProvider.context !== undefined
        ? freezeProviderSnapshot({
            ...selectedProvider,
            context: {
              ...selectedProvider.context,
              ...(allowUnverifiedDirectEdit ? { allowUnverifiedDirectEdit: true } : {}),
              ...(isDirectReferenceGeneration ? { allowUnverifiedDirectReferenceGeneration: true } : {})
            }
          })
        : selectedProvider;
      creationInvoked = true;
      const raw = await this.#executeCreation(staged.request, {
        requestId,
        signal,
        ...(provider.context === undefined ? {} : { provider: provider.context })
      });
      const parsedCreation = imageOperationResultSchema.safeParse(raw);
      if (!parsedCreation.success) {
        throw new ProviderIntegrationError(createProviderServiceError({
          code: "internal_contract",
          stage: "complete",
          safeMessage: "Creation returned an invalid image operation result.",
          mayHaveBilled: true
        }));
      }
      const creation = parsedCreation.data;
      const materialized = await this.#materialize(transaction, creation, staged.graph.sourceRenditions.length);
      const normalized = await this.#normalizeOutputDimensions(
        staged.request,
        creation,
        materialized,
        transaction
      );
      const outputMismatch = outputContractError(staged.request, normalized.result);
      if (outputMismatch !== undefined) throw outputMismatch;
      const processed = await this.#postprocess(
        staged.request,
        normalized.result,
        normalized.materialization,
        transaction,
        signal
      );
      return imageOperationResultSchema.parse(await finalizePublicOperationResult({
        graph: staged.graph,
        creationResult: processed.result,
        materialization: processed.materialization,
        transaction,
        model: provider.model,
        ...(provider.context === undefined ? {} : { providerId: provider.context.providerId }),
        idFactory: resultIdFactory(this.#id.bind(this)),
        library: this.#options.library,
        ...(plan === undefined ? {} : { outputDestination: plan })
      }));
    } catch (error) {
      const serviceError = errorFromUnknown(
        error,
        creationInvoked || error instanceof LibraryError ? "internal_contract" : "invalid_input",
        false,
        creationInvoked
      );
      if (transaction !== undefined) await transaction.cleanup().catch(() => undefined);
      return failureResult(input, requestId, serviceError);
    }
  }

  async generate(input: RoutegoGenerateInput): Promise<ImageOperationResult> {
    const parsed = routegoGenerateInputSchema.parse(input);
    if (this.#status !== "ready") return failureResult(parsed, this.#id("request"), this.#recoveryError ?? errorFromUnknown({ code: "config_corrupt" }, "config_corrupt"));
    try {
      const defaults = await this.#publicDefaults();
      const request = resolvePublicImageRequest(input, defaults);
      return await this.#executePublic(request);
    } catch (error) {
      return failureResult(parsed, this.#id("request"), errorFromUnknown(error, "config_corrupt"));
    }
  }

  async edit(input: RoutegoEditInput): Promise<ImageOperationResult> {
    const parsed = routegoEditInputSchema.parse(input);
    if (this.#status !== "ready") {
      return failureResult(
        parsed,
        this.#id("request"),
        this.#recoveryError ?? errorFromUnknown({ code: "config_corrupt" }, "config_corrupt")
      );
    }
    try {
      const defaults = await this.#publicDefaults();
      const request = resolvePublicImageRequest(input, defaults);
      return await this.#executePublic(request, undefined, undefined, true);
    } catch (error) {
      return failureResult(parsed, this.#id("request"), errorFromUnknown(error, "config_corrupt"));
    }
  }

  async #runPublicBatch(input: RoutegoBatchInput, signal?: AbortSignal): Promise<RoutegoBatchResult> {
    const parsed = routegoBatchInputSchema.parse(input);
    const requestId = this.#id("batch");
    let defaults: RoutegoStatusResult["defaults"];
    try {
      defaults = await this.#publicDefaults();
    } catch (error) {
      const serviceError = errorFromUnknown(error, "config_corrupt");
      return routegoBatchResultSchema.parse({
        schemaVersion: 1,
        requestId,
        status: "failed",
        concurrency: FIXED_BATCH_CONCURRENCY,
        items: parsed.tasks.map((task) => ({
          id: task.id,
          result: failureResult(task.operation, this.#id("batch-item"), serviceError)
        })),
        error: serviceError
      });
    }
    const tasks = parsed.tasks.map((task, index) => Object.freeze({
      id: task.id,
      operation: freezeSnapshot(resolvePublicImageRequest(input.tasks[index]!.operation, defaults))
    }));
    let provider: ProviderSnapshot;
    try {
      provider = await this.#provider(requestId, signal ?? new AbortController().signal);
    } catch (error) {
      const serviceError = errorFromUnknown(error, "config_missing");
      return routegoBatchResultSchema.parse({
        schemaVersion: 1,
        requestId,
        status: "failed",
        concurrency: FIXED_BATCH_CONCURRENCY,
        items: tasks.map((task) => ({
          id: task.id,
          result: failureResult(task.operation, this.#id("batch-item"), serviceError)
        }))
      });
    }
    const items: Array<{ id: string; result: ImageOperationResult }> = new Array(tasks.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = next++;
        const task = tasks[index];
        if (task === undefined) return;
        if (signal?.aborted) {
          items[index] = { id: task.id, result: failureResult(task.operation, this.#id("batch-item"), errorFromUnknown({ code: "cancelled" }, "cancelled")) };
          continue;
        }
        try {
          items[index] = { id: task.id, result: await this.#executePublic(task.operation, signal, provider) };
        } catch (error) {
          items[index] = { id: task.id, result: failureResult(task.operation, this.#id("batch-item"), errorFromUnknown(error)) };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(FIXED_BATCH_CONCURRENCY, tasks.length) }, () => worker()));
    const ordered = tasks.map((task, index) => items[index] ?? {
      id: task.id,
      result: failureResult(task.operation, this.#id("batch-item"), errorFromUnknown({ code: "cancelled" }, "cancelled"))
    });
    const statuses = ordered.map((item) => item.result.status);
    const status: RoutegoBatchResult["status"] = statuses.every((value) => value === "succeeded")
      ? "succeeded"
      : statuses.every((value) => value === "cancelled")
        ? "cancelled"
        : statuses.every((value) => value === "failed")
          ? "failed"
          : "partial";
    return routegoBatchResultSchema.parse({
      schemaVersion: 1,
      requestId,
      status,
      concurrency: FIXED_BATCH_CONCURRENCY,
      items: ordered,
      ...(status === "cancelled" ? { error: errorFromUnknown({ code: "cancelled" }, "cancelled") } : {})
    });
  }

  async batch(input: RoutegoBatchInput): Promise<RoutegoBatchResult> {
    const parsed = routegoBatchInputSchema.parse(input);
    if (this.#status !== "ready") {
      const error = this.#recoveryError ?? errorFromUnknown({ code: "config_corrupt" }, "config_corrupt");
      return routegoBatchResultSchema.parse({ schemaVersion: 1, requestId: this.#id("batch"), status: "failed", concurrency: FIXED_BATCH_CONCURRENCY, items: parsed.tasks.map((task) => ({ id: task.id, result: failureResult(task.operation, this.#id("batch-item"), error) })), error });
    }
    return await this.#runPublicBatch(input);
  }

  async #executeStudio(
    input: StudioImageOperationRequest,
    options: StudioExecutionOptions = {},
    providerSnapshot?: ProviderSnapshot
  ): Promise<StudioImageOperationResult> {
    const requestId = this.#id("studio-request");
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(options.signal?.reason ?? "operation-cancelled");
    if (options.signal?.aborted) forwardAbort();
    else options.signal?.addEventListener("abort", forwardAbort, { once: true });
    const promise = this.#executeStudioInner(requestId, input, controller.signal, options.onEvent, providerSnapshot);
    this.#active.set(requestId, { controller, promise });
    this.#activePromises.add(promise);
    try {
      return await promise;
    } finally {
      this.#active.delete(requestId);
      this.#activePromises.delete(promise);
      options.signal?.removeEventListener("abort", forwardAbort);
    }
  }

  async #executeStudioInner(
    requestId: string,
    input: StudioImageOperationRequest,
    signal: AbortSignal,
    onEvent?: (event: StudioImageOperationEvent) => void | Promise<void>,
    providerSnapshot?: ProviderSnapshot
  ): Promise<StudioImageOperationResult> {
    const emit = async (event: StudioImageOperationEvent): Promise<void> => {
      if (onEvent === undefined) return;
      await onEvent(studioImageOperationEventSchema.parse(event));
    };
    let projector: StudioResultResourceProjector | undefined;
    let transaction: OutputMaterializationTransaction | undefined;
    let partialArtifacts: StudioImageOperationResult["partialArtifacts"] = [];
    let sequence = 0;
    let creationInvoked = false;
    try {
      await emit({ type: "started", requestId, sequence: sequence++, occurredAt: this.#now().toISOString(), requestedParams: input });
      if (this.#status !== "ready") {
        const error = this.#recoveryError ?? errorFromUnknown({ code: "config_corrupt" }, "config_corrupt");
        const failed = studioFailureResult(input, requestId, error, partialArtifacts);
        await emit({ type: "failed", requestId, sequence: sequence++, occurredAt: this.#now().toISOString(), error: failed.error!, receivedAnyOutput: false, mayHaveBilled: false });
        return failed;
      }
      if (signal.aborted) {
        const error = errorFromUnknown({ code: "cancelled" }, "cancelled");
        const failed = studioFailureResult(input, requestId, error, partialArtifacts);
        await emit({ type: "failed", requestId, sequence: sequence++, occurredAt: this.#now().toISOString(), error: failed.error!, receivedAnyOutput: false, mayHaveBilled: false });
        return failed;
      }
      const session = await this.#options.studioSession();
      projector = new StudioResultResourceProjector({
        registry: this.#options.ephemeralResources,
        owningSessionId: session.id,
        owningSessionExpiresAt: session.expiresAt
      });
      const prepared = await resolveStudioOperationInput(input, {
        library: this.#options.library,
        idFactory: inputIdFactory(this.#id.bind(this)),
        now: () => this.#now()
      });
      transaction = await createOutputMaterializationTransaction({
        stagingRoot: this.#options.stagingRoot,
        requestId,
        ...(this.#options.maximumImageBytes === undefined ? {} : { maximumImageBytes: this.#options.maximumImageBytes })
      });
      const staged = await stagePreparedStudioOperationSources(prepared, {
        library: this.#options.library,
        transaction,
        now: () => this.#now()
      });
      const provider = providerSnapshot ?? await this.#provider(requestId, signal);
      creationInvoked = true;
      const raw = await this.#executeCreation(staged.creationRequest, {
        requestId,
        signal,
        ...(provider.context === undefined ? {} : { provider: provider.context }),
        onEvent: async (event) => {
          if (event.type !== "partial") return;
          try {
            const output = transaction!.selectedOutput(event.artifact.id) ?? await transaction!.materializeArtifact(event.artifact);
            const projected = await projector!.projectEphemeral(output);
            const projectedEvent = studioImageOperationEventSchema.parse({
              type: "partial",
              requestId,
              sequence: sequence++,
              occurredAt: this.#now().toISOString(),
              artifact: projected,
              receivedAnyOutput: true,
              mayHaveBilled: true
            });
            partialArtifacts = [...partialArtifacts, projected];
            await emit(projectedEvent);
          } catch (error) {
            throw error;
          }
        }
      });
      const parsedCreation = imageOperationResultSchema.safeParse(raw);
      if (!parsedCreation.success) {
        throw new ProviderIntegrationError(createProviderServiceError({
          code: "internal_contract",
          stage: "complete",
          safeMessage: "Creation returned an invalid image operation result.",
          mayHaveBilled: true
        }));
      }
      const creation = parsedCreation.data;
      const materialized = await this.#materialize(transaction, creation, staged.graph.sourceRenditions.length);
      const normalized = await this.#normalizeOutputDimensions(
        staged.creationRequest,
        creation,
        materialized,
        transaction
      );
      const outputMismatch = outputContractError(staged.creationRequest, normalized.result);
      if (outputMismatch !== undefined) throw outputMismatch;
      const processed = await this.#postprocess(
        staged.creationRequest,
        normalized.result,
        normalized.materialization,
        transaction,
        signal
      );
      const final = await finalizeStudioOperationResult({
        prepared: { ...staged, studioRequest: prepared.studioRequest },
        creationResult: processed.result,
        materialization: processed.materialization,
        transaction,
        model: provider.model,
        ...(provider.context === undefined ? {} : { providerId: provider.context.providerId }),
        idFactory: resultIdFactory(this.#id.bind(this)),
        library: this.#options.library,
        resources: projector,
        now: () => this.#now()
      });
      if (final.status === "failed") {
        const error = final.error ?? studioError(errorFromUnknown({ code: "internal_contract" }));
        await emit({ type: "failed", requestId, sequence: sequence++, occurredAt: this.#now().toISOString(), error, receivedAnyOutput: final.execution.receivedAnyOutput, mayHaveBilled: final.execution.mayHaveBilled });
      } else {
        await emit({ type: "completed", requestId, sequence: sequence++, occurredAt: this.#now().toISOString(), result: final });
      }
      return final;
    } catch (error) {
      const serviceError = errorFromUnknown(
        error,
        creationInvoked ? "internal_contract" : "invalid_input",
        partialArtifacts.length > 0,
        creationInvoked || partialArtifacts.length > 0
      );
      if (transaction !== undefined) await transaction.cleanup().catch(() => undefined);
      const failed = studioFailureResult(input, requestId, serviceError, partialArtifacts);
      await emit({ type: "failed", requestId, sequence: sequence++, occurredAt: this.#now().toISOString(), error: failed.error!, receivedAnyOutput: failed.execution.receivedAnyOutput, mayHaveBilled: failed.execution.mayHaveBilled });
      return failed;
    }
  }

  async studioGenerate(input: StudioGenerateInput): Promise<StudioImageOperationResult> {
    const parsed = studioGenerateInputSchema.parse(input);
    if (this.#status !== "ready") return studioFailureResult(parsed, this.#id("studio-request"), this.#recoveryError ?? errorFromUnknown({ code: "config_corrupt" }, "config_corrupt"));
    return await this.#executeStudio(parsed);
  }

  async #runStudioBatch(parsed: ParsedStudioBatchInput, signal?: AbortSignal): Promise<StudioBatchResult> {
    const requestId = this.#id("studio-batch");
    const tasks = parsed.tasks.map((task) => Object.freeze({
      id: task.id,
      operation: freezeSnapshot(studioImageOperationRequestSchema.parse(task.operation))
    }));
    let provider: ProviderSnapshot;
    try {
      provider = await this.#provider(requestId, signal ?? new AbortController().signal);
    } catch (error) {
      const serviceError = errorFromUnknown(error, "config_missing");
      const failedItems = tasks.map((task) => ({
        id: task.id,
        result: studioFailureResult(task.operation, this.#id("studio-item"), serviceError)
      }));
      return studioBatchResultSchema.parse({
        schemaVersion: 1,
        requestId,
        status: "failed",
        concurrency: FIXED_BATCH_CONCURRENCY,
        taskIds: tasks.map((task) => task.id),
        items: failedItems
      });
    }
    const items: Array<{ id: string; result: StudioImageOperationResult }> = new Array(tasks.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = next++;
        const task = tasks[index];
        if (task === undefined) return;
        if (signal?.aborted) {
          items[index] = { id: task.id, result: studioFailureResult(task.operation, this.#id("studio-item"), errorFromUnknown({ code: "cancelled" }, "cancelled")) };
          continue;
        }
        items[index] = {
          id: task.id,
          result: await this.#executeStudio(
            task.operation,
            signal === undefined ? {} : { signal },
            provider
          )
        };
      }
    };
    await Promise.all(Array.from({ length: Math.min(FIXED_BATCH_CONCURRENCY, tasks.length) }, () => worker()));
    const ordered = tasks.map((task, index) => items[index] ?? { id: task.id, result: studioFailureResult(task.operation, this.#id("studio-item"), errorFromUnknown({ code: "cancelled" }, "cancelled")) });
    const allSucceeded = ordered.every((item) => item.result.status === "succeeded");
    const allFailed = ordered.every((item) => item.result.status === "failed");
    return studioBatchResultSchema.parse({ schemaVersion: 1, requestId, status: allSucceeded ? "succeeded" : allFailed ? "failed" : "partial", concurrency: FIXED_BATCH_CONCURRENCY, taskIds: tasks.map((task) => task.id), items: ordered });
  }

  async studioBatch(input: StudioBatchInput): Promise<StudioBatchResult> {
    const parsed = studioBatchInputSchema.parse(input);
    if (this.#status !== "ready") {
      const error = this.#recoveryError ?? errorFromUnknown({ code: "config_corrupt" }, "config_corrupt");
      const items = parsed.tasks.map((task) => ({ id: task.id, result: studioFailureResult(task.operation, this.#id("studio-item"), error) }));
      return studioBatchResultSchema.parse({ schemaVersion: 1, requestId: this.#id("studio-batch"), status: "failed", concurrency: FIXED_BATCH_CONCURRENCY, taskIds: parsed.tasks.map((task) => task.id), items });
    }
    return await this.#runStudioBatch(parsed);
  }

  executeStudioStream(
    input: StudioImageOperationRequest,
    options: Pick<StudioExecutionOptions, "signal"> = {}
  ): AsyncIterable<StudioImageOperationEvent> {
    const parsed = studioImageOperationRequestSchema.parse(input);
    const queue = new StudioEventQueue();
    void this.#executeStudio(parsed, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onEvent: (event) => queue.push(event)
    }).then(() => queue.close(), () => queue.close());
    return queue;
  }
}

export async function createLocalRoutegoService(
  options: LocalRoutegoServiceOptions
): Promise<ProductionLocalRoutegoService> {
  const service = new ProductionLocalRoutegoService(options);
  await service.recover();
  return service;
}
