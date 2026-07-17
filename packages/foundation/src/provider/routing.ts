import {
  imageOperationRequestSchema,
  providerEndpointSetSchema,
  routegoServiceErrorSchema,
  type ImageOperationRequest,
  type ProviderCapability,
  type ProviderCapabilityRecord,
  type ProviderEndpointSet,
  type ProviderTransport,
  type RoutegoServiceError
} from "@routego-image/contracts";

import { fingerprintProviderEndpoint, normalizeProviderEndpoints } from "./endpoints";

export const PROVIDER_REQUEST_SHAPES = {
  singleEndpointText: "single-endpoint-json:text",
  singleEndpointImage: "single-endpoint-json:image",
  singleEndpointImages: "single-endpoint-json:images",
  imagesGenerationsJson: "openai-images:generations-json",
  imagesEditsMultipart: "openai-images:edits-multipart",
  responsesImageGeneration: "openai-responses:image-generation"
} as const;

export type ProviderTier = "A" | "B" | "C";

export interface PreviousProviderAttempt {
  readonly transport: ProviderTransport;
  readonly errorCode:
    | "auth_failed"
    | "rate_limited"
    | "timeout"
    | "provider_5xx"
    | "invalid_response"
    | "cancelled"
    | "other";
  readonly stage: "pre-generation" | "submitted" | "streaming" | "completed";
  readonly attemptCount: number;
  readonly receivedAnyOutput: boolean;
  readonly mayHaveBilled: boolean;
}

export interface ProviderRoutingContext {
  readonly providerId: string;
  readonly model: string;
  readonly endpoints: ProviderEndpointSet;
  readonly capabilities: readonly ProviderCapabilityRecord[];
  readonly preferredTransports?: readonly ProviderTransport[];
  readonly previousAttempt?: PreviousProviderAttempt;
  readonly allowDegradedContinuation?: boolean;
  readonly previousOutputAvailable?: boolean;
}

export interface CapabilityLimitViolation {
  readonly capability: ProviderCapability;
  readonly limit: "maxImages" | "maxVariants" | "maxPartialImages" | "supportedSizes" | "supportedQualities" | "supportedFormats";
  readonly requested: unknown;
  readonly supported: unknown;
}

export interface SelectedProviderRoute {
  readonly selected: true;
  readonly tier: ProviderTier;
  readonly transport: ProviderTransport;
  readonly endpoint: string;
  readonly requestShape: string;
  readonly effectiveKind: "generate" | "edit";
  readonly requiredCapabilities: readonly ProviderCapability[];
  readonly degraded: boolean;
  readonly degradedContinuation: boolean;
  readonly continuationInput?: "previous-output-as-target";
  readonly replayPolicy: "never-cross-transport";
}

export interface UnavailableProviderRoute {
  readonly selected: false;
  readonly error: RoutegoServiceError;
  readonly attemptedTransports: readonly ProviderTransport[];
  readonly missingCapabilities: readonly ProviderCapability[];
  readonly limitViolations: readonly CapabilityLimitViolation[];
  readonly retryBlockReasons: readonly AutomaticRetryDecision["reason"][];
}

export type ProviderRouteDecision = SelectedProviderRoute | UnavailableProviderRoute;

interface RouteCandidate {
  readonly tier: ProviderTier;
  readonly transport: ProviderTransport;
  readonly endpoint: string;
  readonly requestShape: string;
  readonly effectiveKind: "generate" | "edit";
  readonly imageInputCount: number;
  readonly requiredCapabilities: readonly ProviderCapability[];
  readonly allowUnknownTextBaseline?: boolean;
}

function uniqueCapabilities(capabilities: readonly ProviderCapability[]): ProviderCapability[] {
  return [...new Set(capabilities)];
}

function makeUnavailable(
  attemptedTransports: readonly ProviderTransport[],
  missingCapabilities: readonly ProviderCapability[],
  limitViolations: readonly CapabilityLimitViolation[] = [],
  retryBlockReasons: readonly AutomaticRetryDecision["reason"][] = [],
  safeMessage = "The configured provider has no verified route for this operation.",
  blockedAttempt?: PreviousProviderAttempt
): UnavailableProviderRoute {
  const attempted = [...new Set(attemptedTransports)];
  const missing = uniqueCapabilities(missingCapabilities);
  const retryReasons = [...new Set(retryBlockReasons)];
  const receivedAnyOutput = blockedAttempt?.receivedAnyOutput ?? false;
  const mayHaveBilled = blockedAttempt?.mayHaveBilled ?? false;
  return {
    selected: false,
    attemptedTransports: attempted,
    missingCapabilities: missing,
    limitViolations,
    retryBlockReasons: retryReasons,
    error: routegoServiceErrorSchema.parse({
      code: "capability_unavailable",
      category: "capability",
      stage: "route",
      safeMessage,
      retryDisposition: blockedAttempt === undefined ? "user-confirmation" : "never",
      partialArtifacts: [],
      receivedAnyOutput,
      mayHaveBilled,
      details: {
        attemptedTransports: attempted,
        missingCapabilities: missing,
        limitViolations,
        retryBlockReasons: retryReasons,
        ...(blockedAttempt === undefined
          ? {}
          : {
              previousAttempt: {
                transport: blockedAttempt.transport,
                errorCode: blockedAttempt.errorCode,
                stage: blockedAttempt.stage,
                attemptCount: blockedAttempt.attemptCount
              }
            })
      }
    })
  };
}

function physicalImageInputCount(request: ImageOperationRequest): number {
  return (
    request.references.length +
    request.supportingImages.length +
    (request.targetImage === undefined ? 0 : 1)
  );
}

function tierCImageInputCount(request: ImageOperationRequest): number {
  return physicalImageInputCount(request) + request.imageIds.length + request.fileIds.length;
}

function requestedFeatureCapabilities(request: ImageOperationRequest): ProviderCapability[] {
  const required: ProviderCapability[] = [];
  if (request.count > 1) {
    required.push("native-variants");
  }
  if (request.size !== "auto" || request.aspectRatio !== "auto") {
    required.push("custom-size");
  }
  if (request.quality !== "auto") {
    required.push("quality-control");
  }
  if (request.format === "jpeg" || request.format === "webp") {
    required.push("output-format");
  }
  if (request.compression !== undefined) {
    required.push("compression");
  }
  if (request.partialImages > 0) {
    required.push("streaming", "partial-images");
  }
  if (request.transparentMode === "native") {
    required.push("native-transparency");
  }
  if (request.moderation === "low") {
    required.push("moderation");
  }
  return required;
}

function tierACapabilities(
  request: ImageOperationRequest,
  imageInputs: number,
  effectiveKind: "generate" | "edit"
): ProviderCapability[] {
  const required: ProviderCapability[] = imageInputs === 0
    ? ["text-generation"]
    : [imageInputs === 1 ? "single-image-input" : "multi-image-input", "data-url-input"];
  if (request.maskPath !== undefined) {
    required.push("mask-edit");
  }
  if (effectiveKind === "edit") {
    required.push("target-edit");
  }
  return uniqueCapabilities([...required, ...requestedFeatureCapabilities(request)]);
}

function tierBCapabilities(
  request: ImageOperationRequest,
  imageInputs: number,
  effectiveKind: "generate" | "edit"
): ProviderCapability[] {
  const required: ProviderCapability[] = imageInputs === 0
    ? ["text-generation"]
    : [
        imageInputs === 1 ? "single-image-input" : "multi-image-input",
        "multipart-input"
      ];
  if (effectiveKind === "edit") {
    required.push("target-edit");
  }
  if (request.maskPath !== undefined) {
    required.push("mask-edit");
  }
  return uniqueCapabilities([...required, ...requestedFeatureCapabilities(request)]);
}

function tierCCapabilities(request: ImageOperationRequest): ProviderCapability[] {
  const required: ProviderCapability[] = ["text-generation"];
  const inputs = tierCImageInputCount(request);
  const localInputs = physicalImageInputCount(request);
  if (inputs > 0) {
    required.push(inputs === 1 ? "single-image-input" : "multi-image-input");
  }
  if (localInputs > 0) {
    required.push("data-url-input");
  }
  if (request.kind === "edit") {
    required.push("target-edit");
  }
  if (request.fileIds.length > 0) {
    required.push("file-id-input");
  }
  if (request.imageIds.length > 0) {
    required.push("image-id-input");
  }
  if (request.previousResponseId !== undefined || request.fileIds.length > 0 || request.imageIds.length > 0) {
    required.push("responses-state");
  }
  if (request.maskPath !== undefined) {
    required.push("mask-edit");
  }
  return uniqueCapabilities([...required, ...requestedFeatureCapabilities(request)]);
}

function configuredCandidates(
  context: ProviderRoutingContext,
  request: ImageOperationRequest,
  forcedPreviousOutput: boolean
): RouteCandidate[] {
  const endpoints = normalizeProviderEndpoints(providerEndpointSetSchema.parse(context.endpoints));
  const physicalInputs = physicalImageInputCount(request) + (forcedPreviousOutput ? 1 : 0);
  const stateful =
    request.previousResponseId !== undefined || request.imageIds.length > 0 || request.fileIds.length > 0;
  const order = context.preferredTransports ??
    (stateful
      ? ["openai-responses"]
      : physicalInputs === 0 && request.kind === "generate"
        ? ["single-endpoint-json", "openai-responses"]
        : ["single-endpoint-json", "openai-images", "openai-responses"]);

  const candidates: RouteCandidate[] = [];
  for (const transport of order) {
    if (transport === "single-endpoint-json") {
      if (stateful && !forcedPreviousOutput) {
        continue;
      }
      candidates.push({
        tier: "A",
        transport,
        endpoint: endpoints.generationEndpoint,
        requestShape:
          physicalInputs === 0
            ? PROVIDER_REQUEST_SHAPES.singleEndpointText
            : physicalInputs === 1
              ? PROVIDER_REQUEST_SHAPES.singleEndpointImage
              : PROVIDER_REQUEST_SHAPES.singleEndpointImages,
        effectiveKind: forcedPreviousOutput ? "edit" : request.kind,
        imageInputCount: physicalInputs,
        requiredCapabilities: tierACapabilities(
          request,
          physicalInputs,
          forcedPreviousOutput ? "edit" : request.kind
        ),
        allowUnknownTextBaseline: physicalInputs === 0
      });
      continue;
    }

    if (transport === "openai-images") {
      if (stateful && !forcedPreviousOutput) {
        continue;
      }
      if (physicalInputs === 0 && request.kind === "generate") {
        candidates.push({
          tier: "B",
          transport,
          endpoint: endpoints.generationEndpoint,
          requestShape: PROVIDER_REQUEST_SHAPES.imagesGenerationsJson,
          effectiveKind: "generate",
          imageInputCount: 0,
          requiredCapabilities: tierBCapabilities(request, 0, "generate"),
          allowUnknownTextBaseline: true
        });
        continue;
      }
      if (endpoints.editsEndpoint === undefined) {
        continue;
      }
      candidates.push({
        tier: "B",
        transport,
        endpoint: endpoints.editsEndpoint,
        requestShape: PROVIDER_REQUEST_SHAPES.imagesEditsMultipart,
        effectiveKind: "edit",
        imageInputCount: physicalInputs,
        requiredCapabilities: tierBCapabilities(request, physicalInputs, "edit")
      });
      continue;
    }

    if (endpoints.responsesEndpoint !== undefined && !forcedPreviousOutput) {
      candidates.push({
        tier: "C",
        transport,
        endpoint: endpoints.responsesEndpoint,
        requestShape: PROVIDER_REQUEST_SHAPES.responsesImageGeneration,
        effectiveKind: request.kind,
        imageInputCount: tierCImageInputCount(request),
        requiredCapabilities: tierCCapabilities(request)
      });
    }
  }
  return candidates;
}

function findCapabilityRecord(
  context: ProviderRoutingContext,
  candidate: RouteCandidate,
  capability: ProviderCapability
): ProviderCapabilityRecord | undefined {
  const fingerprint = fingerprintProviderEndpoint(candidate.endpoint);
  return context.capabilities.find(
    (record) =>
      record.capability === capability &&
      record.scope.providerId === context.providerId &&
      record.scope.model === context.model &&
      record.scope.transport === candidate.transport &&
      record.scope.endpointFingerprint === fingerprint &&
      record.scope.requestShape === candidate.requestShape
  );
}

function capabilityLimitViolations(
  record: ProviderCapabilityRecord,
  request: ImageOperationRequest,
  imageInputCount: number
): CapabilityLimitViolation[] {
  const limits = record.limits;
  if (limits === undefined) {
    return [];
  }
  const violations: CapabilityLimitViolation[] = [];
  if (
    (record.capability === "single-image-input" || record.capability === "multi-image-input") &&
    limits.maxImages !== undefined &&
    imageInputCount > limits.maxImages
  ) {
    violations.push({
      capability: record.capability,
      limit: "maxImages",
      requested: imageInputCount,
      supported: limits.maxImages
    });
  }
  if (
    record.capability === "native-variants" &&
    limits.maxVariants !== undefined &&
    request.count > limits.maxVariants
  ) {
    violations.push({
      capability: record.capability,
      limit: "maxVariants",
      requested: request.count,
      supported: limits.maxVariants
    });
  }
  if (record.capability === "custom-size" && limits.supportedSizes !== undefined) {
    if (request.size !== "auto" && !limits.supportedSizes.includes(request.size)) {
      violations.push({
        capability: record.capability,
        limit: "supportedSizes",
        requested: request.size,
        supported: limits.supportedSizes
      });
    }
    const ratioValues = limits.supportedSizes.filter(
      (value) =>
        value === "square" ||
        value === "portrait" ||
        value === "landscape" ||
        /^\d{1,3}:\d{1,3}$/u.test(value)
    );
    if (
      request.aspectRatio !== "auto" &&
      ratioValues.length > 0 &&
      !ratioValues.includes(request.aspectRatio)
    ) {
      violations.push({
        capability: record.capability,
        limit: "supportedSizes",
        requested: request.aspectRatio,
        supported: ratioValues
      });
    }
  }
  if (
    record.capability === "quality-control" &&
    limits.supportedQualities !== undefined &&
    !limits.supportedQualities.includes(request.quality)
  ) {
    violations.push({
      capability: record.capability,
      limit: "supportedQualities",
      requested: request.quality,
      supported: limits.supportedQualities
    });
  }
  if (
    record.capability === "output-format" &&
    limits.supportedFormats !== undefined &&
    !limits.supportedFormats.includes(request.format)
  ) {
    violations.push({
      capability: record.capability,
      limit: "supportedFormats",
      requested: request.format,
      supported: limits.supportedFormats
    });
  }
  if (
    record.capability === "partial-images" &&
    limits.maxPartialImages !== undefined &&
    request.partialImages > limits.maxPartialImages
  ) {
    violations.push({
      capability: record.capability,
      limit: "maxPartialImages",
      requested: request.partialImages,
      supported: limits.maxPartialImages
    });
  }
  return violations;
}

function selectFromCandidates(
  context: ProviderRoutingContext,
  request: ImageOperationRequest,
  candidates: readonly RouteCandidate[],
  degradedContinuation: boolean
): ProviderRouteDecision {
  const attempted: ProviderTransport[] = [];
  const missing: ProviderCapability[] = [];
  const limitViolations: CapabilityLimitViolation[] = [];
  const retryBlockReasons: AutomaticRetryDecision["reason"][] = [];

  for (const candidate of candidates) {
    attempted.push(candidate.transport);
    if (context.previousAttempt !== undefined) {
      const retry = evaluateAutomaticRetry(context.previousAttempt, candidate.transport);
      if (!retry.allowed) {
        retryBlockReasons.push(retry.reason);
        continue;
      }
    }

    let degraded = degradedContinuation;
    let candidateUnavailable = false;
    for (const capability of candidate.requiredCapabilities) {
      const record = findCapabilityRecord(context, candidate, capability);
      if (
        candidate.allowUnknownTextBaseline === true &&
        capability === "text-generation" &&
        (record === undefined || record.state === "unknown")
      ) {
        continue;
      }
      if (record === undefined || record.state === "unknown" || record.state === "unsupported") {
        missing.push(capability);
        candidateUnavailable = true;
        continue;
      }
      if (record.state === "degraded") {
        degraded = true;
      }
      const violations = capabilityLimitViolations(record, request, candidate.imageInputCount);
      if (violations.length > 0) {
        limitViolations.push(...violations);
        candidateUnavailable = true;
      }
    }
    if (candidateUnavailable) {
      continue;
    }

    return {
      selected: true,
      tier: candidate.tier,
      transport: candidate.transport,
      endpoint: candidate.endpoint,
      requestShape: candidate.requestShape,
      effectiveKind: candidate.effectiveKind,
      requiredCapabilities: candidate.requiredCapabilities,
      degraded,
      degradedContinuation,
      ...(degradedContinuation ? { continuationInput: "previous-output-as-target" as const } : {}),
      replayPolicy: "never-cross-transport"
    };
  }

  const retryBlocked = retryBlockReasons.length > 0 && retryBlockReasons.length === attempted.length;
  return makeUnavailable(
    attempted,
    missing,
    limitViolations,
    retryBlockReasons,
    retryBlocked
      ? "The previous provider attempt is not safe for automatic replay."
      : "The configured provider has no verified route for this operation.",
    retryBlocked ? context.previousAttempt : undefined
  );
}

export function selectProviderRoute(
  context: ProviderRoutingContext,
  requestInput: unknown
): ProviderRouteDecision {
  const request = imageOperationRequestSchema.parse(requestInput);
  const stateful =
    request.previousResponseId !== undefined || request.imageIds.length > 0 || request.fileIds.length > 0;

  const direct = selectFromCandidates(
    context,
    request,
    configuredCandidates(context, request, false),
    false
  );
  if (direct.selected || !stateful) {
    return direct;
  }
  if (context.allowDegradedContinuation !== true || context.previousOutputAvailable !== true) {
    return direct;
  }

  const requestedFallbacks = context.preferredTransports?.filter(
    (transport) => transport !== "openai-responses"
  );
  const fallbackContext: ProviderRoutingContext = {
    ...context,
    preferredTransports:
      requestedFallbacks !== undefined && requestedFallbacks.length > 0
        ? requestedFallbacks
        : ["single-endpoint-json", "openai-images"]
  };
  return selectFromCandidates(
    fallbackContext,
    request,
    configuredCandidates(fallbackContext, request, true),
    true
  );
}

export interface AutomaticRetryDecision {
  readonly allowed: boolean;
  readonly reason:
    | "safe-same-transport-pre-generation"
    | "cross-transport-replay-forbidden"
    | "output-or-billing-risk"
    | "failure-not-retryable"
    | "retry-limit-reached";
}

export function evaluateAutomaticRetry(
  previous: PreviousProviderAttempt,
  nextTransport: ProviderTransport
): AutomaticRetryDecision {
  if (previous.transport !== nextTransport) {
    return { allowed: false, reason: "cross-transport-replay-forbidden" };
  }
  if (previous.receivedAnyOutput || previous.mayHaveBilled) {
    return { allowed: false, reason: "output-or-billing-risk" };
  }
  if (
    previous.stage !== "pre-generation" ||
    (previous.errorCode !== "rate_limited" && previous.errorCode !== "provider_5xx")
  ) {
    return { allowed: false, reason: "failure-not-retryable" };
  }
  if (previous.attemptCount >= 3) {
    return { allowed: false, reason: "retry-limit-reached" };
  }
  return { allowed: true, reason: "safe-same-transport-pre-generation" };
}
