import {
  capabilityEvidenceSchema,
  providerCapabilityRecordSchema,
  type CapabilityEvidence,
  type ProviderCapability,
  type ProviderCapabilityRecord
} from "@routego-image/contracts";

export type CapabilityScope = ProviderCapabilityRecord["scope"];

export type CapabilityObservation =
  | { readonly outcome: "supported"; readonly evidence: CapabilityEvidence }
  | { readonly outcome: "unsupported"; readonly evidence: CapabilityEvidence }
  | {
      readonly outcome: "degraded";
      readonly evidence: CapabilityEvidence;
      readonly degradedReason: string;
    }
  | { readonly outcome: "transient"; readonly evidence: CapabilityEvidence }
  | { readonly outcome: "synthetic"; readonly evidence: CapabilityEvidence };

const SUPPORTED_SOURCES = new Set([
  "user-configuration",
  "provider-documentation",
  "successful-request"
]);

const UNSUPPORTED_SOURCES = new Set([
  "user-configuration",
  "provider-documentation",
  "protocol-rejection"
]);

function appendEvidence(
  current: readonly CapabilityEvidence[],
  evidence: CapabilityEvidence
): CapabilityEvidence[] {
  return [...current, evidence].slice(-32);
}

export function createUnknownCapabilityRecord(
  capability: ProviderCapability,
  scope: CapabilityScope,
  evidence: readonly CapabilityEvidence[] = []
): ProviderCapabilityRecord {
  return providerCapabilityRecordSchema.parse({
    capability,
    scope,
    state: "unknown",
    evidence
  });
}

export function transitionCapability(
  record: ProviderCapabilityRecord,
  observation: CapabilityObservation
): ProviderCapabilityRecord {
  const current = providerCapabilityRecordSchema.parse(record);
  const evidence = capabilityEvidenceSchema.parse(observation.evidence);
  const nextEvidence = appendEvidence(current.evidence, evidence);

  if (observation.outcome === "transient") {
    if (evidence.source !== "transient-failure") {
      throw new Error("Transient observations require transient-failure evidence");
    }

    return providerCapabilityRecordSchema.parse({
      ...current,
      evidence: nextEvidence
    });
  }

  if (observation.outcome === "synthetic") {
    if (evidence.source !== "synthetic-fixture") {
      throw new Error("Synthetic observations require synthetic-fixture evidence");
    }

    return providerCapabilityRecordSchema.parse({
      ...current,
      evidence: nextEvidence
    });
  }

  if (observation.outcome === "supported") {
    if (!SUPPORTED_SOURCES.has(evidence.source)) {
      throw new Error("Supported capabilities require explicit successful or authoritative evidence");
    }

    const { degradedReason: _degradedReason, ...withoutDegradedReason } = current;
    return providerCapabilityRecordSchema.parse({
      ...withoutDegradedReason,
      state: "supported",
      evidence: nextEvidence,
      verifiedAt: evidence.observedAt
    });
  }

  if (observation.outcome === "unsupported") {
    if (!UNSUPPORTED_SOURCES.has(evidence.source)) {
      throw new Error("Unsupported capabilities require stable protocol or authoritative evidence");
    }

    const {
      degradedReason: _degradedReason,
      limits: _limits,
      ...withoutDegradedFields
    } = current;
    return providerCapabilityRecordSchema.parse({
      ...withoutDegradedFields,
      state: "unsupported",
      evidence: nextEvidence,
      verifiedAt: evidence.observedAt
    });
  }

  if (evidence.source !== "degraded-fallback") {
    throw new Error("Degraded capabilities require degraded-fallback evidence");
  }

  return providerCapabilityRecordSchema.parse({
    ...current,
    state: "degraded",
    evidence: nextEvidence,
    verifiedAt: evidence.observedAt,
    degradedReason: observation.degradedReason
  });
}

export interface CapabilityProbeRequest {
  readonly kind: "synthetic" | "documentary" | "live-provider";
  readonly mayGenerateOutput: boolean;
  readonly mayCharge: boolean;
  readonly confirmedByUser: boolean;
}

export interface CapabilityProbeDecision {
  readonly allowed: boolean;
  readonly requiresConfirmation: boolean;
  readonly reason: "non-billable-evidence" | "user-confirmed" | "confirmation-required";
}

export function evaluateCapabilityProbe(request: CapabilityProbeRequest): CapabilityProbeDecision {
  const requiresConfirmation =
    request.kind === "live-provider" && (request.mayGenerateOutput || request.mayCharge);

  if (!requiresConfirmation) {
    return { allowed: true, requiresConfirmation: false, reason: "non-billable-evidence" };
  }

  if (request.confirmedByUser) {
    return { allowed: true, requiresConfirmation: true, reason: "user-confirmed" };
  }

  return { allowed: false, requiresConfirmation: true, reason: "confirmation-required" };
}
