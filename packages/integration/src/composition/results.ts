import { createHash } from "node:crypto";
import path from "node:path";
import { lstat, open, realpath, unlink } from "node:fs/promises";

import {
  identifierSchema,
  imageOperationRequestSchema,
  imageOperationResultSchema,
  libraryOperationParametersSchema,
  routegoServiceErrorSchema,
  studioImageOperationRequestSchema,
  studioImageOperationResultSchema,
  studioServiceErrorSchema,
  type BrowserResourceDescriptor,
  type ImageArtifact,
  type ImageOperationRequest,
  type ImageOperationResult,
  type LibraryOperationParameters,
  type RoutegoServiceError,
  type StudioImageArtifact,
  type StudioImageInputRef,
  type StudioImageOperationRequest,
  type StudioImageOperationResult,
  type StudioImageRelationship,
  type UploadResourcePurpose
} from "@routego-image/contracts";
import { detectImageMetadata } from "@routego-image/creation";
import {
  LibraryError,
  type BrowserResourceRegistry,
  type IngestLibraryAssetInput,
  type IngestLibraryAssetResult,
  type LibraryAssetStore,
  type LibraryRelationship,
  type ResolvedStableImageResource,
  type RoutegoLibraryService,
  type StoredImageBlob
} from "@routego-image/library";

import type { PreparedStudioOperationInput } from "./inputs";
import type {
  DurableInputGraphItem,
  DurableInputGraphPlan,
  PlannedSourceRendition,
  StudioPhysicalInputKey
} from "./graph";
import {
  ImageMaterializationError,
  assertOperationRenditionBound,
  type MaterializationBatchResult,
  type MaterializedImageOutput,
  type OutputMaterializationTransaction
} from "../image/materialize";
import {
  EphemeralImageResourceError,
  type EphemeralImageResourceRegistry
} from "../runtime/ephemeral-resources";

const PUBLIC_OUTPUT_PLAN = Symbol("routego-public-output-plan");
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export type ResultCompositionErrorCode =
  | "identity-conflict"
  | "invalid-input"
  | "output-directory-required"
  | "output-directory-unsafe"
  | "projection-failed"
  | "relationship-invalid"
  | "source-changed"
  | "source-unavailable";

export class ResultCompositionError extends Error {
  readonly code: ResultCompositionErrorCode;

  constructor(code: ResultCompositionErrorCode, safeMessage: string) {
    super(safeMessage);
    this.name = "ResultCompositionError";
    this.code = code;
  }
}

export type ResultGraphIdentityKind = "output-relationship";
export type ResultGraphIdFactory = (
  kind: ResultGraphIdentityKind,
  order: number,
  attempt: number
) => string;

export interface StagePreparedStudioSourcesOptions {
  readonly library: Pick<RoutegoLibraryService, "resolveImageResource">;
  readonly transaction: OutputMaterializationTransaction;
  readonly now?: () => Date;
}

export interface PreparedPublicOperationInput {
  readonly request: ImageOperationRequest;
  readonly graph: DurableInputGraphPlan;
}

export interface StagePreparedPublicSourcesOptions {
  readonly transaction: OutputMaterializationTransaction;
}

export interface PublicOutputDestinationPlan {
  readonly requestedOutputDirectory: string;
  readonly approvedDirectory: string;
  readonly [PUBLIC_OUTPUT_PLAN]: true;
}

export interface PreflightPublicOutputDestinationOptions {
  readonly approveOutputDirectory: (requestedDirectory: string) => Promise<string>;
}

export interface StudioResultLibraryOwner {
  readonly assetStore: Pick<
    LibraryAssetStore,
    "ingestAsset" | "resolveArtifact" | "copyArtifactToProject"
  >;
  readonly resourceRegistry: Pick<BrowserResourceRegistry, "registerImage">;
}

export interface StudioResourceSessionOptions {
  readonly registry: EphemeralImageResourceRegistry;
  readonly owningSessionId: string;
  readonly owningSessionExpiresAt: string | Date;
}

export interface FinalizeStudioOperationResultInput {
  readonly prepared: PreparedStudioOperationInput;
  readonly creationResult: unknown;
  readonly materialization: MaterializationBatchResult;
  readonly transaction: OutputMaterializationTransaction;
  readonly model: string;
  readonly idFactory: ResultGraphIdFactory;
  readonly library: StudioResultLibraryOwner;
  readonly resources: StudioResultResourceProjector;
  readonly now?: () => Date;
}

export interface FinalizePublicOperationResultInput {
  readonly graph: DurableInputGraphPlan;
  readonly creationResult: unknown;
  readonly materialization: MaterializationBatchResult;
  readonly transaction: OutputMaterializationTransaction;
  readonly model: string;
  readonly idFactory: ResultGraphIdFactory;
  readonly library: StudioResultLibraryOwner;
  readonly outputDestination?: PublicOutputDestinationPlan;
  readonly now?: () => Date;
}

interface ResultIssue {
  readonly code: RoutegoServiceError["code"];
  readonly category: RoutegoServiceError["category"];
  readonly stage: RoutegoServiceError["stage"];
  readonly safeMessage: string;
}

interface ValidatedResultContext {
  readonly result: ImageOperationResult;
  readonly outputs: readonly MaterializedImageOutput[];
  readonly issues: ResultIssue[];
}

interface SavedOperationProjection {
  readonly ingestion: IngestLibraryAssetResult;
  readonly blobByArtifactId: ReadonlyMap<string, StoredImageBlob>;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function extensionFor(mimeType: MaterializedImageOutput["mimeType"]): "png" | "jpg" | "webp" {
  return mimeType === "image/png" ? "png" : mimeType === "image/jpeg" ? "jpg" : "webp";
}

function currentTime(now: () => Date): Date {
  const value = now();
  if (!Number.isFinite(value.getTime())) {
    throw new ResultCompositionError("invalid-input", "The result projection clock is invalid.");
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function normalizePathForComparison(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

async function verifyApprovedDirectory(directory: string): Promise<string> {
  if (
    typeof directory !== "string" ||
    directory.length < 1 ||
    directory.length > 32_767 ||
    directory.includes("\0") ||
    !path.isAbsolute(directory)
  ) {
    throw new ResultCompositionError(
      "output-directory-unsafe",
      "The approved output directory is invalid."
    );
  }
  let metadata;
  let canonical: string;
  try {
    metadata = await lstat(directory);
    canonical = await realpath(directory);
  } catch {
    throw new ResultCompositionError(
      "output-directory-unsafe",
      "The approved output directory is unavailable."
    );
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink()
  ) {
    throw new ResultCompositionError(
      "output-directory-unsafe",
      "The approved output directory is unsafe."
    );
  }
  return canonical;
}

export async function preflightPublicOutputDestination(
  input: unknown,
  options: PreflightPublicOutputDestinationOptions
): Promise<PublicOutputDestinationPlan | undefined> {
  const request = imageOperationRequestSchema.safeParse(input);
  if (!request.success || typeof options?.approveOutputDirectory !== "function") {
    throw new ResultCompositionError(
      "invalid-input",
      "Public output preflight requires a valid request and output-directory approval owner."
    );
  }
  if (!request.data.saveToLibrary && request.data.outputDir === undefined) {
    throw new ResultCompositionError(
      "output-directory-required",
      "Unsaved public image operations require an approved output directory."
    );
  }
  if (request.data.outputDir === undefined) return undefined;
  let approved: string;
  try {
    approved = await options.approveOutputDirectory(request.data.outputDir);
  } catch {
    throw new ResultCompositionError(
      "output-directory-unsafe",
      "The requested public output directory was not approved."
    );
  }
  const [requestedDirectory, approvedDirectory] = await Promise.all([
    verifyApprovedDirectory(request.data.outputDir),
    verifyApprovedDirectory(approved)
  ]);
  if (
    normalizePathForComparison(approvedDirectory) !==
    normalizePathForComparison(requestedDirectory)
  ) {
    throw new ResultCompositionError(
      "output-directory-unsafe",
      "The approved output directory does not match the requested destination."
    );
  }
  return Object.freeze({
    requestedOutputDirectory: request.data.outputDir,
    approvedDirectory,
    [PUBLIC_OUTPUT_PLAN]: true as const
  });
}

function studioLocator(
  _request: StudioImageOperationRequest,
  _key: StudioPhysicalInputKey
): StudioImageInputRef {
  throw new ResultCompositionError(
    "invalid-input",
    "Studio generation does not accept physical image inputs."
  );
}

function expectedUploadPurposes(item: DurableInputGraphItem): readonly UploadResourcePurpose[] {
  switch (item.role) {
    case "target":
      return ["target", "image"];
    case "reference":
      return ["reference", "image"];
    case "supporting":
      return ["supporting", "image"];
    case "mask":
      return ["mask"];
  }
}

function validateRefreshedUpload(
  item: DurableInputGraphItem,
  locator: StudioImageInputRef,
  resource: ResolvedStableImageResource,
  nowMs: number
): asserts resource is Extract<ResolvedStableImageResource, { readonly source: "upload" }> {
  if (
    locator.source !== "upload" ||
    resource.source !== "upload" ||
    resource.uploadResourceId !== locator.uploadResourceId ||
    !expectedUploadPurposes(item).includes(resource.purpose) ||
    resource.reusePolicy !== "reusable-until-expiry" ||
    typeof resource.path !== "string" ||
    resource.path.includes("\0") ||
    !path.isAbsolute(resource.path) ||
    normalizePathForComparison(resource.path) !== normalizePathForComparison(item.path) ||
    !SUPPORTED_IMAGE_MIME_TYPES.has(resource.mimeType) ||
    resource.mimeType !== item.mimeType ||
    resource.byteLength !== item.byteLength ||
    resource.sha256 !== item.sha256 ||
    resource.width !== item.width ||
    resource.height !== item.height
  ) {
    throw new ResultCompositionError(
      "source-changed",
      "An uploaded source changed after Studio input preparation."
    );
  }
  const expiry = Date.parse(resource.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= nowMs) {
    throw new ResultCompositionError(
      "source-unavailable",
      "An uploaded source expired before stable request staging completed."
    );
  }
}

async function readVerifiedSource(
  filePath: string,
  item: Pick<
    DurableInputGraphItem,
    "mimeType" | "byteLength" | "sha256" | "width" | "height"
  >
): Promise<Uint8Array> {
  let metadata;
  let handle;
  let bytes: Uint8Array;
  try {
    metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== item.byteLength) {
      throw new Error("invalid-source");
    }
    handle = await open(filePath, "r");
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile() || openedMetadata.size !== item.byteLength) {
      throw new Error("invalid-source");
    }
    const buffer = Buffer.alloc(item.byteLength + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== item.byteLength) throw new Error("invalid-source");
    bytes = new Uint8Array(buffer.subarray(0, offset));
  } catch {
    throw new ResultCompositionError(
      "source-unavailable",
      "An uploaded source is unavailable for stable request staging."
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
  let detected;
  try {
    detected = detectImageMetadata(bytes);
  } catch {
    throw new ResultCompositionError(
      "source-changed",
      "An uploaded source failed image validation during stable staging."
    );
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (
    detected.mimeType !== item.mimeType ||
    detected.width !== item.width ||
    detected.height !== item.height ||
    bytes.byteLength !== item.byteLength ||
    sha256 !== item.sha256
  ) {
    throw new ResultCompositionError(
      "source-changed",
      "An uploaded source changed during stable request staging."
    );
  }
  return bytes;
}

async function writeExclusive(filePath: string, bytes: Uint8Array): Promise<void> {
  let handle;
  try {
    handle = await open(filePath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
      await unlink(filePath).catch(() => undefined);
    }
    throw new ResultCompositionError(
      isNodeError(error, "EEXIST") ? "identity-conflict" : "projection-failed",
      isNodeError(error, "EEXIST")
        ? "A stable request staging path already exists."
        : "A stable request source could not be written."
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function replaceCreationPaths(
  request: ImageOperationRequest,
  graph: DurableInputGraphPlan
): ImageOperationRequest {
  const pathByArtifact = new Map(graph.inputs.map((item) => [item.artifactId, item.path]));
  const references = request.references.map((reference) => ({
    ...reference,
    path: reference.id === undefined ? reference.path : pathByArtifact.get(reference.id) ?? reference.path
  }));
  return imageOperationRequestSchema.parse({ ...request, references });
}

function stagedSourceName(item: DurableInputGraphItem): string {
  return `source-${item.order}-${createHash("sha256")
    .update(item.artifactId, "utf8")
    .digest("hex")
    .slice(0, 20)}.${extensionFor(item.mimeType)}`;
}

export async function stagePreparedPublicOperationSources(
  prepared: PreparedPublicOperationInput,
  options: StagePreparedPublicSourcesOptions
): Promise<PreparedPublicOperationInput> {
  const parsedRequest = imageOperationRequestSchema.safeParse(prepared?.request);
  if (!parsedRequest.success || options?.transaction === undefined) {
    throw new ResultCompositionError(
      "invalid-input",
      "Stable public source staging requires a valid request, graph, and request transaction."
    );
  }
  validateGraphRequest(parsedRequest.data, prepared.graph);
  const updatedInputs: DurableInputGraphItem[] = [];
  const updatedSources: PlannedSourceRendition[] = [];
  try {
    for (const item of prepared.graph.inputs) {
      if (item.sourceRendition === undefined) {
        updatedInputs.push(item);
        continue;
      }
      const bytes = await readVerifiedSource(item.path, item);
      const stagedName = stagedSourceName(item);
      const stagedPath = path.join(options.transaction.directory, stagedName);
      await writeExclusive(stagedPath, bytes);
      const sourceRendition = Object.freeze({
        ...item.sourceRendition,
        sourceRoot: options.transaction.directory,
        sourceRelativePath: stagedName
      });
      updatedSources.push(sourceRendition);
      updatedInputs.push(Object.freeze({ ...item, path: stagedPath, sourceRendition }));
    }
  } catch (error) {
    await options.transaction.cleanup().catch(() => undefined);
    throw error;
  }
  const graph = Object.freeze({
    ...prepared.graph,
    inputs: Object.freeze(updatedInputs),
    sourceRenditions: Object.freeze(updatedSources)
  });
  return Object.freeze({
    request: deepFreeze(replaceCreationPaths(parsedRequest.data, graph)),
    graph
  });
}

export async function stagePreparedStudioOperationSources(
  prepared: PreparedStudioOperationInput,
  options: StagePreparedStudioSourcesOptions
): Promise<PreparedStudioOperationInput> {
  if (
    options === null ||
    typeof options !== "object" ||
    options.library === null ||
    typeof options.library !== "object" ||
    typeof options.library.resolveImageResource !== "function" ||
    !(options.transaction instanceof Object)
  ) {
    throw new ResultCompositionError(
      "invalid-input",
      "Stable Studio source staging requires Library ownership and a request transaction."
    );
  }
  validateGraphRequest(prepared.creationRequest, prepared.graph);
  const now = options.now ?? (() => new Date());
  const updatedInputs: DurableInputGraphItem[] = [];
  const updatedSources: PlannedSourceRendition[] = [];
  try {
    for (const item of prepared.graph.inputs) {
      if (item.origin !== "upload") {
        updatedInputs.push(item);
        continue;
      }
      const locator = studioLocator(prepared.studioRequest, item.key);
      let refreshed: ResolvedStableImageResource;
      try {
        refreshed = await options.library.resolveImageResource(
          locator,
          expectedUploadPurposes(item)
        );
      } catch {
        throw new ResultCompositionError(
          "source-unavailable",
          "An uploaded source is no longer available for stable request staging."
        );
      }
      const startMs = currentTime(now).getTime();
      validateRefreshedUpload(item, locator, refreshed, startMs);
      const bytes = await readVerifiedSource(refreshed.path, item);
      const stagedName = stagedSourceName(item);
      const stagedPath = path.join(options.transaction.directory, stagedName);
      await writeExclusive(stagedPath, bytes);
      if (Date.parse(refreshed.expiresAt) <= currentTime(now).getTime()) {
        await unlink(stagedPath).catch(() => undefined);
        throw new ResultCompositionError(
          "source-unavailable",
          "An uploaded source expired before stable request staging completed."
        );
      }
      const sourceRendition = Object.freeze({
        ...item.sourceRendition!,
        sourceRoot: options.transaction.directory,
        sourceRelativePath: stagedName
      });
      updatedSources.push(sourceRendition);
      updatedInputs.push(Object.freeze({
        ...item,
        path: stagedPath,
        sourceRendition
      }));
    }
  } catch (error) {
    await options.transaction.cleanup().catch(() => undefined);
    throw error;
  }
  const graph = Object.freeze({
    ...prepared.graph,
    inputs: Object.freeze(updatedInputs),
    sourceRenditions: Object.freeze(updatedSources)
  });
  return Object.freeze({
    studioRequest: prepared.studioRequest,
    creationRequest: deepFreeze(replaceCreationPaths(prepared.creationRequest, graph)),
    graph
  });
}

function outputIssue(safeMessage: string): ResultIssue {
  return {
    code: "invalid_response",
    category: "protocol",
    stage: "download",
    safeMessage
  };
}

function persistenceIssue(safeMessage: string): ResultIssue {
  return {
    code: "file_write_failed",
    category: "persistence",
    stage: "persist",
    safeMessage
  };
}

function validateResultContext(
  creationResult: unknown,
  materialization: MaterializationBatchResult,
  transaction: OutputMaterializationTransaction,
  graph: DurableInputGraphPlan
): ValidatedResultContext {
  const parsed = imageOperationResultSchema.safeParse(creationResult);
  if (!parsed.success || !["succeeded", "partial", "failed", "cancelled"].includes(parsed.data.status)) {
    throw new ResultCompositionError(
      "invalid-input",
      "Only a terminal shared image operation result can be projected."
    );
  }
  validateGraphRequest(parsed.data.requestedParams, graph);
  const providerArtifacts = new Map(
    [...parsed.data.partialArtifacts, ...parsed.data.finalArtifacts].map((artifact) => [artifact.id, artifact])
  );
  const used = new Set<string>([
    graph.operationAssetId,
    ...graph.inputs.flatMap((item) => [item.relatedAssetId, item.artifactId, item.relationship.id])
  ]);
  const outputs: MaterializedImageOutput[] = [];
  const outputIds = new Set<string>();
  for (const output of materialization.outputs) {
    const providerArtifact = providerArtifacts.get(output.artifactId);
    const selected = transaction.selectedOutput(output.artifactId);
    if (
      providerArtifact === undefined ||
      providerArtifact.phase !== output.phase ||
      providerArtifact.slot !== output.slot ||
      selected?.path !== output.path ||
      selected.sha256 !== output.sha256 ||
      outputIds.has(output.artifactId) ||
      used.has(output.artifactId)
    ) {
      throw new ResultCompositionError(
        "identity-conflict",
        "The materialized output identities do not match the prepared operation graph."
      );
    }
    outputIds.add(output.artifactId);
    used.add(output.artifactId);
    outputs.push(output);
  }
  assertOperationRenditionBound({
    sourceCount: graph.sourceRenditions.length,
    partialOutputCount: outputs.filter((output) => output.phase === "partial").length,
    finalOutputCount: outputs.filter((output) => output.phase === "final").length
  });
  const issues = materialization.failures.map(() =>
    outputIssue("One or more provider outputs failed bounded materialization.")
  );
  return { result: parsed.data, outputs, issues };
}

function allocateOutputRelationshipId(
  order: number,
  used: Set<string>,
  idFactory: ResultGraphIdFactory
): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    let candidate: unknown;
    try {
      candidate = idFactory("output-relationship", order, attempt);
    } catch {
      throw new ResultCompositionError(
        "identity-conflict",
        "The deterministic output relationship allocator failed."
      );
    }
    const parsed = identifierSchema.safeParse(candidate);
    if (parsed.success && !used.has(parsed.data)) {
      used.add(parsed.data);
      return parsed.data;
    }
  }
  throw new ResultCompositionError(
    "identity-conflict",
    "A unique deterministic output relationship identity could not be allocated."
  );
}

function outputRelationships(
  graph: DurableInputGraphPlan,
  outputs: readonly MaterializedImageOutput[],
  idFactory: ResultGraphIdFactory
): readonly LibraryRelationship[] {
  const used = new Set<string>([
    graph.operationAssetId,
    ...graph.inputs.flatMap((item) => [item.relatedAssetId, item.artifactId, item.relationship.id]),
    ...outputs.map((output) => output.artifactId)
  ]);
  return outputs.map((output, index) => {
    const order = graph.relationships.length + index;
    return Object.freeze({
      id: allocateOutputRelationshipId(order, used, idFactory),
      role: "output" as const,
      relatedAssetId: graph.operationAssetId,
      artifactId: output.artifactId,
      order
    });
  });
}

function operationParameters(
  request: ImageOperationRequest,
  graph: DurableInputGraphPlan
): LibraryOperationParameters {
  const ordered = [...graph.inputs].sort((left, right) => left.order - right.order);
  const references = ordered
    .filter((item) => item.role === "reference")
    .map((item) => ({
      assetId: item.relatedAssetId,
      role: item.referenceRole ?? "reference",
      ...(item.label === undefined ? {} : { label: item.label })
    }));
  return libraryOperationParametersSchema.parse({
    kind: request.kind,
    prompt: request.prompt,
    references,
    size: request.size,
    aspectRatio: request.aspectRatio,
    quality: request.quality,
    format: request.format,
    ...(request.compression === undefined ? {} : { compression: request.compression }),
    count: request.count,
    partialImages: request.partialImages,
    transparentMode: request.transparentMode,
    moderation: request.moderation,
    outputDirectoryMode: request.outputDir === undefined ? "default" : "custom",
    saveToLibrary: request.saveToLibrary
  });
}

function safePersistedError(error: RoutegoServiceError | undefined): RoutegoServiceError | undefined {
  if (error === undefined) return undefined;
  return routegoServiceErrorSchema.parse({
    ...error,
    partialArtifacts: [],
    ...(error.details === undefined ? {} : { details: error.details })
  });
}

function issueError(
  issue: ResultIssue,
  execution: ImageOperationResult["execution"],
  partialArtifacts: readonly ImageArtifact[] = []
): RoutegoServiceError {
  return routegoServiceErrorSchema.parse({
    code: issue.code,
    category: issue.category,
    stage: issue.stage,
    safeMessage: issue.safeMessage,
    retryDisposition: execution.receivedAnyOutput || execution.mayHaveBilled
      ? "user-confirmation"
      : "safe-pre-generation",
    partialArtifacts: partialArtifacts.slice(0, 4),
    receivedAnyOutput: execution.receivedAnyOutput,
    mayHaveBilled: execution.mayHaveBilled
  });
}

function ensureStableSources(
  graph: DurableInputGraphPlan,
  transaction: OutputMaterializationTransaction
): void {
  if (
    graph.sourceRenditions.some(
      (source) =>
        normalizePathForComparison(source.sourceRoot) !==
        normalizePathForComparison(transaction.directory)
    )
  ) {
    throw new ResultCompositionError(
      "source-unavailable",
      "Upload-origin inputs must be stably staged before provider submission."
    );
  }
}

function validateGraphRequest(
  request: ImageOperationRequest,
  graph: DurableInputGraphPlan
): void {
  const orderedInputs = [...graph.inputs].sort((left, right) => left.order - right.order);
  const physicalImageCount = orderedInputs.filter((item) => item.role !== "mask").length;
  const maskCount = orderedInputs.length - physicalImageCount;
  if (
    graph.relationships.length !== orderedInputs.length ||
    graph.physicalImageCount !== physicalImageCount ||
    graph.maskCount !== maskCount ||
    orderedInputs.some((item, index) => {
      const relationship = graph.relationships[index];
      return (
        item.order !== index ||
        relationship === undefined ||
        item.relationship.id !== relationship.id ||
        relationship.role !== item.role ||
        relationship.relatedAssetId !== item.relatedAssetId ||
        relationship.artifactId !== item.artifactId ||
        relationship.order !== item.order ||
        (item.origin === "upload") !== (item.sourceRendition !== undefined) ||
        (item.role === "mask") !== (item.targetSlot === 0)
      );
    })
  ) {
    throw new ResultCompositionError(
      "relationship-invalid",
      "The prepared input relationships are incomplete or inconsistent."
    );
  }
  const sources = new Map(
    graph.sourceRenditions.map((source) => [source.artifactId, source])
  );
  const plannedSources = graph.inputs.filter((item) => item.sourceRendition !== undefined);
  if (
    sources.size !== graph.sourceRenditions.length ||
    plannedSources.length !== sources.size ||
    plannedSources.some(
      (item) => {
        const source = sources.get(item.artifactId);
        return (
          item.sourceRendition?.artifactId !== item.artifactId ||
          source === undefined ||
          JSON.stringify(source) !== JSON.stringify(item.sourceRendition)
        );
      }
    )
  ) {
    throw new ResultCompositionError(
      "relationship-invalid",
      "The prepared source rendition graph is incomplete or inconsistent."
    );
  }
  const expectedCount = request.references.length;
  if (graph.inputs.length !== expectedCount) {
    throw new ResultCompositionError(
      "relationship-invalid",
      "The prepared input graph does not match the physical operation inputs."
    );
  }
  for (const item of graph.inputs) {
    let id: string | undefined;
    let inputPath: string | undefined;
    if (item.key.startsWith("reference:")) {
      const reference = request.references[
        Number.parseInt(item.key.slice("reference:".length), 10)
      ];
      id = reference?.id;
      inputPath = reference?.path;
    }
    if (
      id !== item.artifactId ||
      inputPath === undefined ||
      normalizePathForComparison(inputPath) !== normalizePathForComparison(item.path)
    ) {
      throw new ResultCompositionError(
        "relationship-invalid",
        "The prepared input graph identity or path does not match its operation request."
      );
    }
  }
}

async function persistOperation(
  context: ValidatedResultContext,
  graph: DurableInputGraphPlan,
  library: StudioResultLibraryOwner,
  model: string,
  idFactory: ResultGraphIdFactory,
  now: () => Date
): Promise<SavedOperationProjection | undefined> {
  if (context.outputs.length === 0) return undefined;
  if (typeof model !== "string" || model.trim() === "" || model.length > 200) {
    throw new ResultCompositionError("invalid-input", "The selected output model is invalid.");
  }
  const outputs = context.outputs;
  const finalOutputs = outputs.filter((output) => output.phase === "final");
  const status = context.result.status === "succeeded" && finalOutputs.length > 0
    ? "succeeded"
    : "partial";
  const issue = context.issues[0];
  const error = safePersistedError(
    context.result.error ??
      (issue === undefined ? undefined : issueError(issue, context.result.execution))
  );
  const timestamp = currentTime(now).toISOString();
  const relationships = [
    ...graph.relationships,
    ...outputRelationships(graph, outputs, idFactory)
  ];
  const renditions = [
    ...graph.sourceRenditions,
    ...outputs.map((output) => ({
      artifactId: output.artifactId,
      phase: output.phase,
      sourceRoot: path.dirname(output.path),
      sourceRelativePath: path.basename(output.path),
      requestedBaseName: `${output.phase}-${output.slot}`,
      expected: {
        mimeType: output.mimeType,
        byteLength: output.byteLength,
        sha256: output.sha256,
        width: output.width,
        height: output.height
      }
    }))
  ];
  const input: IngestLibraryAssetInput = {
    assetId: graph.operationAssetId,
    primaryArtifactId: (finalOutputs.at(-1) ?? outputs.at(-1))!.artifactId,
    prompt: context.result.requestedParams.prompt,
    model: model.trim(),
    status,
    requestedParams: operationParameters(context.result.requestedParams, graph),
    effectiveParams: operationParameters(context.result.effectiveParams, graph),
    execution: context.result.execution,
    ...(error === undefined ? {} : { error }),
    renditions,
    relationships,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const ingestion = await library.assetStore.ingestAsset(input);
  const blobByArtifactId = new Map<string, StoredImageBlob>();
  ingestion.asset.renditions.forEach((rendition, index) => {
    const blob = ingestion.blobs[index];
    if (blob !== undefined) blobByArtifactId.set(rendition.artifactId, blob);
  });
  return { ingestion, blobByArtifactId };
}

function descriptorFingerprint(output: MaterializedImageOutput): string {
  return JSON.stringify({
    artifactId: output.artifactId,
    slot: output.slot,
    phase: output.phase,
    mimeType: output.mimeType,
    byteLength: output.byteLength,
    width: output.width,
    height: output.height,
    sha256: output.sha256,
    providerImageId: output.providerImageId,
    createdAt: output.createdAt
  });
}

export class StudioResultResourceProjector {
  readonly #registry: EphemeralImageResourceRegistry;
  readonly #owningSessionId: string;
  readonly #owningSessionExpiresAt: string | Date;
  readonly #projected = new Map<
    string,
    { readonly fingerprint: string; readonly artifact: StudioImageArtifact }
  >();

  constructor(options: StudioResourceSessionOptions) {
    this.#registry = options.registry;
    this.#owningSessionId = options.owningSessionId;
    this.#owningSessionExpiresAt = options.owningSessionExpiresAt;
  }

  projected(artifactId: string): StudioImageArtifact | undefined {
    return this.#projected.get(artifactId)?.artifact;
  }

  async projectEphemeral(output: MaterializedImageOutput): Promise<StudioImageArtifact> {
    const fingerprint = descriptorFingerprint(output);
    const existing = this.#projected.get(output.artifactId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new ResultCompositionError(
          "identity-conflict",
          "A Studio output identity was projected with inconsistent bytes."
        );
      }
      return existing.artifact;
    }
    const resource = await this.#registry.registerImage({
      output,
      owningSessionId: this.#owningSessionId,
      owningSessionExpiresAt: this.#owningSessionExpiresAt
    });
    const artifact = Object.freeze({
      artifactId: output.artifactId,
      slot: output.slot,
      phase: output.phase,
      resource,
      ...(output.providerImageId === undefined
        ? {}
        : { providerImageId: output.providerImageId }),
      createdAt: output.createdAt
    });
    this.#projected.set(output.artifactId, { fingerprint, artifact });
    return artifact;
  }
}

function studioRequestWithEffectiveControls(
  request: StudioImageOperationRequest,
  effective: ImageOperationRequest
): StudioImageOperationRequest {
  return studioImageOperationRequestSchema.parse({
    ...request,
    prompt: effective.prompt,
    size: effective.size,
    aspectRatio: effective.aspectRatio,
    quality: effective.quality,
    format: effective.format,
    ...(effective.compression === undefined
      ? { compression: undefined }
      : { compression: effective.compression }),
    count: effective.count,
    partialImages: effective.partialImages,
    transparentMode: effective.transparentMode,
    moderation: effective.moderation,
    action: effective.action,
    ...(effective.previousResponseId === undefined
      ? { previousResponseId: undefined }
      : { previousResponseId: effective.previousResponseId }),
    imageIds: effective.imageIds,
    fileIds: effective.fileIds
  });
}

function studioInputForGraphItem(
  prepared: PreparedStudioOperationInput,
  item: DurableInputGraphItem
): StudioImageInputRef {
  return studioLocator(prepared.studioRequest, item.key);
}

function studioRelationships(
  prepared: PreparedStudioOperationInput,
  result: ImageOperationResult,
  artifactIds: ReadonlySet<string>,
  issues: ResultIssue[]
): readonly StudioImageRelationship[] {
  const inputByArtifact = new Map(
    prepared.graph.inputs.map((item) => [item.artifactId, item])
  );
  const relationships: StudioImageRelationship[] = [];
  for (const relationship of result.relationships) {
    if (!artifactIds.has(relationship.outputArtifactId)) continue;
    if (relationship.inputRole === "transparent-original") {
      issues.push(outputIssue("A forbidden extra transparency relationship was rejected."));
      continue;
    }
    if (relationship.inputRole === "output" || relationship.inputRole === "stream-partial") {
      relationships.push({
        role: relationship.inputRole,
        outputArtifactId: relationship.outputArtifactId,
        order: relationship.order
      });
      continue;
    }
    const item = relationship.inputId === undefined
      ? undefined
      : inputByArtifact.get(relationship.inputId);
    if (item === undefined || item.role !== relationship.inputRole) {
      issues.push(outputIssue("An inconsistent output relationship was rejected."));
      continue;
    }
    relationships.push({
      role: item.role,
      input: studioInputForGraphItem(prepared, item),
      outputArtifactId: relationship.outputArtifactId,
      order: relationship.order,
      ...(item.role === "mask" ? { targetSlot: 0 as const } : {})
    });
  }
  return relationships;
}

function studioError(
  error: RoutegoServiceError,
  execution: ImageOperationResult["execution"],
  partialArtifacts: readonly StudioImageArtifact[]
) {
  return studioServiceErrorSchema.parse({
    ...(error.id === undefined ? {} : { id: error.id }),
    code: error.code,
    category: error.category,
    stage: error.stage,
    safeMessage: error.safeMessage,
    retryDisposition: error.retryDisposition,
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
    ...(error.capability === undefined ? {} : { capability: error.capability }),
    partialArtifacts: partialArtifacts.slice(0, 4),
    receivedAnyOutput: execution.receivedAnyOutput,
    mayHaveBilled: execution.mayHaveBilled
  });
}

function projectedStatus(
  original: ImageOperationResult["status"],
  hasArtifacts: boolean,
  hasIssues: boolean,
  studio: boolean
): "succeeded" | "partial" | "failed" | "cancelled" {
  if (original === "failed" || (studio && original === "cancelled")) return "failed";
  if (original === "cancelled") return "cancelled";
  if (hasIssues) return hasArtifacts ? "partial" : "failed";
  if (original === "succeeded" || original === "partial") return original;
  throw new ResultCompositionError(
    "invalid-input",
    "Only terminal image operation states can be projected."
  );
}

function materializedExecution(
  result: ImageOperationResult,
  outputs: readonly MaterializedImageOutput[]
): ImageOperationResult["execution"] {
  const receivedAnyOutput = result.execution.receivedAnyOutput || outputs.length > 0;
  return {
    ...result.execution,
    receivedAnyOutput,
    mayHaveBilled: result.execution.mayHaveBilled || receivedAnyOutput
  };
}

async function durableStudioArtifact(
  output: MaterializedImageOutput,
  saved: SavedOperationProjection,
  library: StudioResultLibraryOwner
): Promise<StudioImageArtifact> {
  const blob = saved.blobByArtifactId.get(output.artifactId);
  if (blob === undefined) {
    throw new ResultCompositionError(
      "projection-failed",
      "The saved output blob could not be projected to Studio."
    );
  }
  const resource = await library.resourceRegistry.registerImage(blob, "original");
  return Object.freeze({
    artifactId: output.artifactId,
    assetId: saved.ingestion.asset.id,
    slot: output.slot,
    phase: output.phase,
    resource,
    ...(output.providerImageId === undefined ? {} : { providerImageId: output.providerImageId }),
    createdAt: output.createdAt
  });
}

export async function finalizeStudioOperationResult(
  input: FinalizeStudioOperationResultInput
): Promise<StudioImageOperationResult> {
  const now = input.now ?? (() => new Date());
  try {
    ensureStableSources(input.prepared.graph, input.transaction);
    const context = validateResultContext(
      input.creationResult,
      input.materialization,
      input.transaction,
      input.prepared.graph
    );
    const execution = materializedExecution(context.result, context.outputs);
    let saved: SavedOperationProjection | undefined;
    if (input.prepared.studioRequest.saveToLibrary && context.outputs.length > 0) {
      try {
        saved = await persistOperation(
          context,
          input.prepared.graph,
          input.library,
          input.model,
          input.idFactory,
          now
        );
      } catch {
        context.issues.push(
          persistenceIssue("The operation output could not be committed to the Library atomically.")
        );
      }
    }
    const projected: StudioImageArtifact[] = [];
    for (const output of context.outputs) {
      try {
        const cached = input.resources.projected(output.artifactId);
        let artifact: StudioImageArtifact;
        if (cached !== undefined) {
          artifact = Object.freeze({
            ...cached,
            ...(saved === undefined ? {} : { assetId: saved.ingestion.asset.id })
          });
        } else if (saved !== undefined) {
          try {
            artifact = await durableStudioArtifact(output, saved, input.library);
          } catch {
            context.issues.push(
              persistenceIssue(
                "A saved output could not use its durable descriptor and was projected ephemerally."
              )
            );
            artifact = Object.freeze({
              ...(await input.resources.projectEphemeral(output)),
              assetId: saved.ingestion.asset.id
            });
          }
        } else {
          artifact = await input.resources.projectEphemeral(output);
        }
        projected.push(artifact);
      } catch {
        context.issues.push(
          persistenceIssue("A validated output could not be projected as a protected Studio resource.")
        );
      }
    }
    const finalArtifacts = projected.filter((artifact) => artifact.phase === "final");
    const partialArtifacts = projected.filter((artifact) => artifact.phase === "partial");
    const relationships = studioRelationships(
      input.prepared,
      context.result,
      new Set(projected.map((artifact) => artifact.artifactId)),
      context.issues
    );
    const status = projectedStatus(
      context.result.status,
      projected.length > 0,
      context.issues.length > 0,
      true
    ) as "succeeded" | "partial" | "failed";
    const sourceError = context.result.error ??
      (context.issues[0] === undefined
        ? status === "failed"
          ? issueError(
              {
                code: "cancelled",
                category: "cancelled",
                stage: "complete",
                safeMessage: "The image operation did not complete."
              },
              execution
            )
          : undefined
        : issueError(context.issues[0], execution));
    const error = sourceError === undefined
      ? undefined
      : studioError(sourceError, execution, partialArtifacts);
    const failedSlots = context.result.failedSlots.slice(0, 4).map((failed) => ({
      slot: failed.slot,
      error: studioError(failed.error, execution, partialArtifacts)
    }));
    return studioImageOperationResultSchema.parse({
      schemaVersion: 1,
      requestId: context.result.requestId,
      status,
      requestedParams: input.prepared.studioRequest,
      effectiveParams: studioRequestWithEffectiveControls(
        input.prepared.studioRequest,
        context.result.effectiveParams
      ),
      execution,
      finalArtifacts,
      partialArtifacts,
      failedSlots,
      relationships,
      ...(error === undefined ? {} : { error })
    });
  } finally {
    await input.transaction.cleanup();
  }
}

async function publicDisplayArtifact(
  output: MaterializedImageOutput,
  transaction: OutputMaterializationTransaction,
  outputPath: string | undefined
): Promise<ImageArtifact> {
  const bytes = await transaction.readValidatedBytes(output);
  return {
    id: output.artifactId,
    slot: output.slot,
    phase: output.phase,
    ...(outputPath === undefined ? {} : { path: outputPath }),
    mimeType: output.mimeType,
    byteLength: output.byteLength,
    width: output.width,
    height: output.height,
    sha256: output.sha256,
    ...(output.providerImageId === undefined ? {} : { providerImageId: output.providerImageId }),
    display: {
      type: "image",
      dataUrl: `data:${output.mimeType};base64,${Buffer.from(bytes).toString("base64")}`
    },
    createdAt: output.createdAt
  };
}

async function writePublicOutput(
  output: MaterializedImageOutput,
  transaction: OutputMaterializationTransaction,
  directory: string,
  requestId: string
): Promise<string> {
  const bytes = await transaction.readValidatedBytes(output);
  const identity = createHash("sha256")
    .update(`${requestId}:${output.artifactId}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  const base = `routego-${output.phase}-${output.slot}-${identity}`;
  for (let attempt = 1; attempt <= 10_000; attempt += 1) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const candidate = path.join(directory, `${base}${suffix}.${extensionFor(output.mimeType)}`);
    let handle;
    try {
      handle = await open(candidate, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      await flushDirectory(directory);
      return candidate;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (isNodeError(error, "EEXIST")) continue;
      await unlink(candidate).catch(() => undefined);
      throw error;
    }
  }
  throw new ResultCompositionError(
    "projection-failed",
    "No exclusive public output filename was available."
  );
}

async function flushDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      !isNodeError(error, "EINVAL") &&
      !isNodeError(error, "EPERM") &&
      !isNodeError(error, "EISDIR")
    ) {
      throw error;
    }
  }
}

function validateOutputPlan(
  request: ImageOperationRequest,
  plan: PublicOutputDestinationPlan | undefined
): void {
  if (!request.saveToLibrary && plan === undefined) {
    throw new ResultCompositionError(
      "output-directory-required",
      "Unsaved public image operations require an approved output directory."
    );
  }
  if (request.outputDir === undefined) {
    if (plan !== undefined) {
      throw new ResultCompositionError(
        "invalid-input",
        "The public output plan does not match the operation request."
      );
    }
    return;
  }
  if (
    plan === undefined ||
    plan[PUBLIC_OUTPUT_PLAN] !== true ||
    plan.requestedOutputDirectory !== request.outputDir
  ) {
    throw new ResultCompositionError(
      "output-directory-unsafe",
      "The public output directory was not preflighted for this request."
    );
  }
}

function publicError(
  error: RoutegoServiceError,
  execution: ImageOperationResult["execution"],
  partialArtifacts: readonly ImageArtifact[]
): RoutegoServiceError {
  return routegoServiceErrorSchema.parse({
    ...error,
    partialArtifacts: partialArtifacts.slice(0, 4),
    receivedAnyOutput: execution.receivedAnyOutput,
    mayHaveBilled: execution.mayHaveBilled
  });
}

export async function finalizePublicOperationResult(
  input: FinalizePublicOperationResultInput
): Promise<ImageOperationResult> {
  const now = input.now ?? (() => new Date());
  try {
    ensureStableSources(input.graph, input.transaction);
    const context = validateResultContext(
      input.creationResult,
      input.materialization,
      input.transaction,
      input.graph
    );
    validateOutputPlan(context.result.requestedParams, input.outputDestination);
    const execution = materializedExecution(context.result, context.outputs);
    let saved: SavedOperationProjection | undefined;
    if (context.result.requestedParams.saveToLibrary && context.outputs.length > 0) {
      try {
        saved = await persistOperation(
          context,
          input.graph,
          input.library,
          input.model,
          input.idFactory,
          now
        );
      } catch {
        context.issues.push(
          persistenceIssue("The operation output could not be committed to the Library atomically.")
        );
      }
    }
    const projected: ImageArtifact[] = [];
    let approvedDirectory: string | undefined;
    if (input.outputDestination !== undefined) {
      try {
        approvedDirectory = await verifyApprovedDirectory(
          input.outputDestination.approvedDirectory
        );
      } catch {
        context.issues.push(
          persistenceIssue("The approved public output directory became unavailable.")
        );
      }
    }
    for (const output of context.outputs) {
      let outputPath: string | undefined;
      try {
        if (context.result.requestedParams.saveToLibrary) {
          if (saved !== undefined) {
            if (approvedDirectory !== undefined) {
              outputPath = (
                await input.library.assetStore.copyArtifactToProject({
                  artifactId: output.artifactId,
                  projectRoot: approvedDirectory,
                  requestedBaseName: `routego-${output.phase}-${output.slot}`
                })
              ).path;
            } else {
              outputPath = (await input.library.assetStore.resolveArtifact(output.artifactId)).path;
            }
          }
        } else if (approvedDirectory !== undefined) {
          outputPath = await writePublicOutput(
            output,
            input.transaction,
            approvedDirectory,
            context.result.requestId
          );
        }
      } catch {
        context.issues.push(
          persistenceIssue("A validated output could not be placed at its approved public path.")
        );
      }
      try {
        projected.push(await publicDisplayArtifact(output, input.transaction, outputPath));
      } catch {
        context.issues.push(outputIssue("A validated output could not be projected for display."));
      }
    }
    const finalArtifacts = projected.filter((artifact) => artifact.phase === "final");
    const partialArtifacts = projected.filter((artifact) => artifact.phase === "partial");
    const artifactIds = new Set(projected.map((artifact) => artifact.id));
    const relationships = context.result.relationships.filter((relationship) => {
      if (relationship.inputRole === "transparent-original") {
        context.issues.push(outputIssue("A forbidden extra transparency relationship was rejected."));
        return false;
      }
      return artifactIds.has(relationship.outputArtifactId);
    });
    const status = projectedStatus(
      context.result.status,
      projected.length > 0,
      context.issues.length > 0,
      false
    );
    const sourceError = context.result.error ??
      (context.issues[0] === undefined ? undefined : issueError(context.issues[0], execution));
    const error = sourceError === undefined
      ? undefined
      : publicError(sourceError, execution, partialArtifacts);
    const failedSlots = context.result.failedSlots.slice(0, 4).map((failed) => ({
      slot: failed.slot,
      error: publicError(failed.error, execution, partialArtifacts)
    }));
    return imageOperationResultSchema.parse({
      schemaVersion: 1,
      requestId: context.result.requestId,
      status,
      requestedParams: context.result.requestedParams,
      effectiveParams: context.result.effectiveParams,
      execution,
      finalArtifacts,
      partialArtifacts,
      failedSlots,
      relationships,
      ...(error === undefined ? {} : { error })
    });
  } finally {
    await input.transaction.cleanup();
  }
}

export function isResultProjectionFailure(error: unknown): boolean {
  return (
    error instanceof ResultCompositionError ||
    error instanceof ImageMaterializationError ||
    error instanceof EphemeralImageResourceError ||
    error instanceof LibraryError
  );
}
