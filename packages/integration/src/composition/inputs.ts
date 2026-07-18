import path from "node:path";

import {
  imageOperationRequestSchema,
  identifierSchema,
  studioImageOperationRequestSchema,
  type ImageOperationRequest,
  type StudioImageInputRef,
  type StudioImageOperationRequest,
  type UploadResourcePurpose
} from "@routego-image/contracts";
import {
  DEFAULT_LIBRARY_IMAGE_MAX_BYTES,
  LibraryError,
  type RoutegoLibraryService
} from "@routego-image/library";

import {
  DurableInputGraphError,
  MAX_STUDIO_MASK_INPUTS,
  MAX_STUDIO_PHYSICAL_IMAGE_INPUTS,
  buildDurableInputGraph,
  type DurableInputGraphPlan,
  type InputGraphIdFactory,
  type ResolvedStudioPhysicalInput,
  type StudioPhysicalInputKey,
  type StudioPhysicalInputRole,
  type VerifiedStudioImageResource
} from "./graph";

const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type StudioInputResolutionErrorCode =
  | "identity-conflict"
  | "input-limit"
  | "invalid-request"
  | "not-found"
  | "purpose-mismatch"
  | "resource-integrity"
  | "resource-unavailable";

export class StudioInputResolutionError extends Error {
  readonly code: StudioInputResolutionErrorCode;

  constructor(code: StudioInputResolutionErrorCode, message: string) {
    super(message);
    this.name = "StudioInputResolutionError";
    this.code = code;
  }
}

export interface ResolveStudioOperationInputOptions {
  readonly library: Pick<RoutegoLibraryService, "resolveImageResource">;
  readonly idFactory: InputGraphIdFactory;
  readonly now?: () => Date;
}

export interface PreparedStudioOperationInput {
  readonly studioRequest: StudioImageOperationRequest;
  readonly creationRequest: ImageOperationRequest;
  readonly graph: DurableInputGraphPlan;
}

interface UnresolvedStudioPhysicalInput {
  readonly key: StudioPhysicalInputKey;
  readonly role: StudioPhysicalInputRole;
  readonly order: number;
  readonly locator: StudioImageInputRef;
  readonly expectedUploadPurposes: readonly UploadResourcePurpose[];
  readonly referenceRole?: ImageOperationRequest["references"][number]["role"];
  readonly label?: string;
  readonly targetSlot?: 0;
}

function parseCurrentTime(now: () => Date): number {
  const milliseconds = now().getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new StudioInputResolutionError(
      "invalid-request",
      "The input resolution clock is invalid."
    );
  }
  return milliseconds;
}

function expectedPurposes(role: StudioPhysicalInputRole): readonly UploadResourcePurpose[] {
  switch (role) {
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

function mappedLibraryError(error: LibraryError): StudioInputResolutionError {
  switch (error.code) {
    case "not_found":
      return new StudioInputResolutionError("not-found", "A required image input was not found.");
    case "upload_expired":
    case "upload_consumed":
    case "upload_discarded":
    case "conflict":
      return new StudioInputResolutionError(
        "resource-unavailable",
        "A required image input is no longer available."
      );
    case "upload_invalid_type":
      return new StudioInputResolutionError(
        "purpose-mismatch",
        "An uploaded image does not have the required input purpose."
      );
    case "upload_checksum_failed":
    case "config_corrupt":
    case "internal_contract":
    case "path_unsafe":
    case "access_denied":
      return new StudioInputResolutionError(
        "resource-integrity",
        "A required image input failed integrity validation."
      );
    default:
      return new StudioInputResolutionError(
        "invalid-request",
        "A required image input could not be resolved safely."
      );
  }
}

function validateResourceIdentity(
  unresolved: UnresolvedStudioPhysicalInput,
  resource: unknown,
  nowMs: number
): asserts resource is VerifiedStudioImageResource {
  if (resource === null || typeof resource !== "object" || Array.isArray(resource)) {
    throw new StudioInputResolutionError(
      "resource-integrity",
      "A resolved image input has an invalid runtime structure."
    );
  }
  const record = resource as Record<string, unknown>;
  const source = record["source"];
  const filePath = record["path"];
  const mimeType = record["mimeType"];
  const byteLength = record["byteLength"];
  const sha256 = record["sha256"];
  const width = record["width"];
  const height = record["height"];
  if (source !== unresolved.locator.source) {
    throw new StudioInputResolutionError(
      "resource-integrity",
      "A resolved image input does not match its requested locator."
    );
  }
  if (
    unresolved.locator.source === "asset" &&
    (source !== "asset" ||
      !identifierSchema.safeParse(record["assetId"]).success ||
      !identifierSchema.safeParse(record["artifactId"]).success ||
      record["assetId"] !== unresolved.locator.assetId)
  ) {
    throw new StudioInputResolutionError(
      "resource-integrity",
      "A resolved asset input has inconsistent ownership."
    );
  }
  if (
    unresolved.locator.source === "artifact" &&
    (source !== "artifact" ||
      !identifierSchema.safeParse(record["assetId"]).success ||
      !identifierSchema.safeParse(record["artifactId"]).success ||
      record["artifactId"] !== unresolved.locator.artifactId)
  ) {
    throw new StudioInputResolutionError(
      "resource-integrity",
      "A resolved artifact input has inconsistent ownership."
    );
  }
  if (
    unresolved.locator.source === "upload" &&
    (source !== "upload" ||
      !identifierSchema.safeParse(record["uploadResourceId"]).success ||
      record["uploadResourceId"] !== unresolved.locator.uploadResourceId)
  ) {
    throw new StudioInputResolutionError(
      "resource-integrity",
      "A resolved upload input has inconsistent ownership."
    );
  }
  if (
    typeof filePath !== "string" ||
    filePath.length < 1 ||
    filePath.length > 32_767 ||
    !path.isAbsolute(filePath) ||
    filePath.includes("\0") ||
    typeof mimeType !== "string" ||
    !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) ||
    typeof byteLength !== "number" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    byteLength > DEFAULT_LIBRARY_IMAGE_MAX_BYTES ||
    typeof sha256 !== "string" ||
    !SHA256_PATTERN.test(sha256) ||
    typeof width !== "number" ||
    !Number.isSafeInteger(width) ||
    width < 1 ||
    width > 65_535 ||
    typeof height !== "number" ||
    !Number.isSafeInteger(height) ||
    height < 1 ||
    height > 65_535
  ) {
    throw new StudioInputResolutionError(
      "resource-integrity",
      "A resolved image input has invalid verified metadata."
    );
  }
  if (unresolved.role === "mask" && mimeType !== "image/png") {
    throw new StudioInputResolutionError(
      "purpose-mismatch",
      "A mask input must resolve to a verified PNG image."
    );
  }
  if (source === "upload") {
    const purpose = record["purpose"];
    const reusePolicy = record["reusePolicy"];
    const expiresAt = record["expiresAt"];
    if (
      typeof purpose !== "string" ||
      !unresolved.expectedUploadPurposes.includes(purpose as UploadResourcePurpose) ||
      reusePolicy !== "reusable-until-expiry"
    ) {
      throw new StudioInputResolutionError(
        "purpose-mismatch",
        "An uploaded image does not have the required reusable input purpose."
      );
    }
    const expiresAtMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
      throw new StudioInputResolutionError(
        "resource-unavailable",
        "An uploaded image expired before input preparation completed."
      );
    }
  }
}

async function resolvePhysicalInput(
  unresolved: UnresolvedStudioPhysicalInput,
  options: ResolveStudioOperationInputOptions,
  now: () => Date
): Promise<ResolvedStudioPhysicalInput> {
  let resource: unknown;
  try {
    resource = await options.library.resolveImageResource(
      unresolved.locator,
      unresolved.expectedUploadPurposes
    );
  } catch (error) {
    if (error instanceof LibraryError) throw mappedLibraryError(error);
    throw new StudioInputResolutionError(
      "resource-unavailable",
      "A required image input could not be resolved safely."
    );
  }
  validateResourceIdentity(unresolved, resource, parseCurrentTime(now));
  return {
    key: unresolved.key,
    role: unresolved.role,
    order: unresolved.order,
    resource,
    ...(unresolved.referenceRole === undefined
      ? {}
      : { referenceRole: unresolved.referenceRole }),
    ...(unresolved.label === undefined ? {} : { label: unresolved.label }),
    ...(unresolved.targetSlot === undefined ? {} : { targetSlot: unresolved.targetSlot })
  };
}

function resourceFingerprint(resource: VerifiedStudioImageResource): string {
  return JSON.stringify(
    resource.source === "upload"
      ? {
          source: resource.source,
          uploadResourceId: resource.uploadResourceId,
          purpose: resource.purpose,
          path: resource.path,
          mimeType: resource.mimeType,
          byteLength: resource.byteLength,
          sha256: resource.sha256,
          width: resource.width,
          height: resource.height,
          expiresAt: resource.expiresAt,
          reusePolicy: resource.reusePolicy
        }
      : {
          source: "library",
          assetId: resource.assetId,
          artifactId: resource.artifactId,
          path: resource.path,
          mimeType: resource.mimeType,
          byteLength: resource.byteLength,
          sha256: resource.sha256,
          width: resource.width,
          height: resource.height
        }
  );
}

function validateResolvedResourceConsistency(
  inputs: readonly ResolvedStudioPhysicalInput[]
): void {
  const libraryArtifacts = new Map<string, string>();
  const uploads = new Map<string, string>();
  for (const input of inputs) {
    const resource = input.resource;
    const identities = resource.source === "upload" ? uploads : libraryArtifacts;
    const identity = resource.source === "upload"
      ? resource.uploadResourceId
      : resource.artifactId;
    const fingerprint = resourceFingerprint(resource);
    const previous = identities.get(identity);
    if (previous !== undefined && previous !== fingerprint) {
      throw new StudioInputResolutionError(
        "resource-integrity",
        "Repeated image input resolution produced inconsistent ownership or metadata."
      );
    }
    identities.set(identity, fingerprint);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function unresolvedInputs(request: StudioImageOperationRequest): readonly UnresolvedStudioPhysicalInput[] {
  const inputs: UnresolvedStudioPhysicalInput[] = [];
  let order = 0;
  if (request.kind === "edit") {
    inputs.push({
      key: "target",
      role: "target",
      order: order++,
      locator: request.target,
      expectedUploadPurposes: expectedPurposes("target")
    });
  }
  request.references.forEach((reference, index) => {
    inputs.push({
      key: `reference:${index}`,
      role: "reference",
      order: order++,
      locator: reference.image,
      expectedUploadPurposes: expectedPurposes("reference"),
      referenceRole: reference.role,
      ...(reference.label === undefined ? {} : { label: reference.label })
    });
  });
  if (request.kind === "edit") {
    request.supportingImages.forEach((supporting, index) => {
      inputs.push({
        key: `supporting:${index}`,
        role: "supporting",
        order: order++,
        locator: supporting.image,
        expectedUploadPurposes: expectedPurposes("supporting"),
        referenceRole: supporting.role,
        ...(supporting.label === undefined ? {} : { label: supporting.label })
      });
    });
    if (request.mask !== undefined) {
      inputs.push({
        key: "mask",
        role: "mask",
        order,
        locator: request.mask.image,
        expectedUploadPurposes: expectedPurposes("mask"),
        targetSlot: request.mask.targetSlot
      });
    }
  }
  return inputs;
}

function copySharedControls(request: StudioImageOperationRequest) {
  return {
    schemaVersion: request.schemaVersion,
    kind: request.kind,
    prompt: request.prompt,
    size: request.size,
    aspectRatio: request.aspectRatio,
    quality: request.quality,
    format: request.format,
    ...(request.compression === undefined ? {} : { compression: request.compression }),
    count: request.count,
    partialImages: request.partialImages,
    transparentMode: request.transparentMode,
    moderation: request.moderation,
    action: request.action,
    ...(request.previousResponseId === undefined
      ? {}
      : { previousResponseId: request.previousResponseId }),
    imageIds: [...request.imageIds],
    fileIds: [...request.fileIds],
    saveToLibrary: request.saveToLibrary
  } as const;
}

function graphItem(graph: DurableInputGraphPlan, key: StudioPhysicalInputKey) {
  const item = graph.inputs.find((candidate) => candidate.key === key);
  if (item === undefined) {
    throw new StudioInputResolutionError(
      "resource-integrity",
      "The resolved image input graph is incomplete."
    );
  }
  return item;
}

function creationRequest(
  request: StudioImageOperationRequest,
  graph: DurableInputGraphPlan
): ImageOperationRequest {
  const references = request.references.map((reference, index) => {
    const item = graphItem(graph, `reference:${index}`);
    return {
      id: item.artifactId,
      path: item.path,
      role: reference.role,
      ...(reference.label === undefined ? {} : { label: reference.label })
    };
  });
  const controls = copySharedControls(request);
  if (request.kind === "generate") {
    return imageOperationRequestSchema.parse({
      ...controls,
      references
    });
  }
  const target = graphItem(graph, "target");
  const supportingImages = request.supportingImages.map((supporting, index) => {
    const item = graphItem(graph, `supporting:${index}`);
    return {
      id: item.artifactId,
      path: item.path,
      role: supporting.role,
      ...(supporting.label === undefined ? {} : { label: supporting.label })
    };
  });
  return imageOperationRequestSchema.parse({
    ...controls,
    references,
    targetImage: {
      id: target.artifactId,
      path: target.path
    },
    supportingImages,
    ...(request.mask === undefined ? {} : { maskPath: graphItem(graph, "mask").path }),
    invariants: request.invariants
  });
}

export async function resolveStudioOperationInput(
  input: unknown,
  options: ResolveStudioOperationInputOptions
): Promise<PreparedStudioOperationInput> {
  if (
    options === null ||
    typeof options !== "object" ||
    options.library === null ||
    typeof options.library !== "object" ||
    typeof options.library.resolveImageResource !== "function" ||
    typeof options.idFactory !== "function"
  ) {
    throw new StudioInputResolutionError(
      "invalid-request",
      "Studio input resolution requires explicit Library ownership and deterministic identity allocation."
    );
  }
  const parsed = studioImageOperationRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new StudioInputResolutionError(
      "invalid-request",
      "The Studio image operation request is invalid."
    );
  }
  const descriptors = unresolvedInputs(parsed.data);
  const physicalImageCount = descriptors.filter((descriptor) => descriptor.role !== "mask").length;
  const maskCount = descriptors.length - physicalImageCount;
  if (
    physicalImageCount > MAX_STUDIO_PHYSICAL_IMAGE_INPUTS ||
    maskCount > MAX_STUDIO_MASK_INPUTS
  ) {
    throw new StudioInputResolutionError(
      "input-limit",
      "The Studio operation exceeds the sixteen-image plus optional-mask boundary."
    );
  }
  const now = options.now ?? (() => new Date());
  parseCurrentTime(now);
  const resolved: ResolvedStudioPhysicalInput[] = [];
  for (const descriptor of descriptors) {
    resolved.push(await resolvePhysicalInput(descriptor, options, now));
  }
  const completionNowMs = parseCurrentTime(now);
  for (const inputResource of resolved) {
    if (
      inputResource.resource.source === "upload" &&
      Date.parse(inputResource.resource.expiresAt) <= completionNowMs
    ) {
      throw new StudioInputResolutionError(
        "resource-unavailable",
        "An uploaded image expired before input preparation completed."
      );
    }
  }
  validateResolvedResourceConsistency(resolved);
  let graph: DurableInputGraphPlan;
  try {
    graph = buildDurableInputGraph(resolved, { idFactory: options.idFactory });
  } catch (error) {
    if (error instanceof DurableInputGraphError) {
      throw new StudioInputResolutionError(
        error.code === "invalid-input" ? "invalid-request" : error.code,
        error.message
      );
    }
    throw error;
  }
  const creation = deepFreeze(creationRequest(parsed.data, graph));
  const studio = deepFreeze(parsed.data);
  return Object.freeze({
    studioRequest: studio,
    creationRequest: creation,
    graph
  });
}
