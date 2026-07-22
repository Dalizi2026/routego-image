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
  readonly effectiveKind: "generate";
  readonly requiredCapabilities: readonly ProviderCapability[];
  readonly degraded: boolean;
  /**
   * A transparent request is sent natively only with scoped, supported evidence.
   * Every other transparency state keeps the single generation request ordinary so
   * the later local-processing stage can handle the returned PNG without probing.
   */
  readonly transparency?: "none" | "native" | "local-fallback";
  readonly replayPolicy: "never" | "never-cross-transport";
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
  readonly effectiveKind: "generate";
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
  return request.references.length;
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
  if (request.moderation === "low") {
    required.push("moderation");
  }
  return required;
}

function transparencyFor(
  context: ProviderRoutingContext,
  request: ImageOperationRequest,
  candidate: RouteCandidate
): NonNullable<SelectedProviderRoute["transparency"]> {
  if (request.transparentMode !== "native") return "none";
  const record = findCapabilityRecord(context, candidate, "native-transparency");
  return record?.state === "supported" ? "native" : "local-fallback";
}

function tierACapabilities(
  request: ImageOperationRequest,
  imageInputs: number
): ProviderCapability[] {
  const required: ProviderCapability[] = imageInputs === 0
    ? ["text-generation"]
    : [imageInputs === 1 ? "single-image-input" : "multi-image-input", "data-url-input"];
  return uniqueCapabilities([...required, ...requestedFeatureCapabilities(request)]);
}

function tierBCapabilities(
  request: ImageOperationRequest,
  imageInputs: number
): ProviderCapability[] {
  const required: ProviderCapability[] = imageInputs === 0
    ? ["text-generation"]
    : [
        imageInputs === 1 ? "single-image-input" : "multi-image-input",
        "multipart-input"
      ];
  return uniqueCapabilities([...required, ...requestedFeatureCapabilities(request)]);
}

function tierCCapabilities(request: ImageOperationRequest): ProviderCapability[] {
  const required: ProviderCapability[] = ["text-generation"];
  const inputs = physicalImageInputCount(request);
  if (inputs > 0) {
    required.push(inputs === 1 ? "single-image-input" : "multi-image-input");
    required.push("data-url-input");
  }
  return uniqueCapabilities([...required, ...requestedFeatureCapabilities(request)]);
}

function configuredCandidates(
  context: ProviderRoutingContext,
  request: ImageOperationRequest
): RouteCandidate[] {
  const endpoints = normalizeProviderEndpoints(providerEndpointSetSchema.parse(context.endpoints));
  const physicalInputs = physicalImageInputCount(request);
  const order = context.preferredTransports ??
    (physicalInputs === 0
      ? ["single-endpoint-json", "openai-responses"]
      : ["single-endpoint-json", "openai-images", "openai-responses"]);

  const candidates: RouteCandidate[] = [];
  for (const transport of order) {
    if (transport === "single-endpoint-json") {
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
        effectiveKind: "generate",
        imageInputCount: physicalInputs,
        requiredCapabilities: tierACapabilities(request, physicalInputs),
        allowUnknownTextBaseline: physicalInputs === 0
      });
      continue;
    }

    if (transport === "openai-images") {
      if (physicalInputs === 0) {
        candidates.push({
          tier: "B",
          transport,
          endpoint: endpoints.generationEndpoint,
          requestShape: PROVIDER_REQUEST_SHAPES.imagesGenerationsJson,
          effectiveKind: "generate",
          imageInputCount: 0,
          requiredCapabilities: tierBCapabilities(request, 0),
          allowUnknownTextBaseline: true
        });
        continue;
      }
      continue;
    }

    if (endpoints.responsesEndpoint !== undefined) {
      candidates.push({
        tier: "C",
        transport,
        endpoint: endpoints.responsesEndpoint,
        requestShape: PROVIDER_REQUEST_SHAPES.responsesImageGeneration,
        effectiveKind: "generate",
        imageInputCount: physicalImageInputCount(request),
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
  candidates: readonly RouteCandidate[]
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

    let degraded = false;
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
      transparency: transparencyFor(context, request, candidate),
      replayPolicy: "never"
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
  return selectFromCandidates(context, request, configuredCandidates(context, request));
}

export interface AutomaticRetryDecision {
  readonly allowed: boolean;
  readonly reason: "automatic-replay-forbidden";
}

export function evaluateAutomaticRetry(
  previous: PreviousProviderAttempt,
  nextTransport: ProviderTransport
): AutomaticRetryDecision {
  void previous;
  void nextTransport;
  return { allowed: false, reason: "automatic-replay-forbidden" };
}
