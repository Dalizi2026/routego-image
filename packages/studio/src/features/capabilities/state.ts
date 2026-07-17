import type {
  CapabilityProbeResult,
  CapabilityState,
  ProviderCapability,
  ProviderCapabilityRecord,
  ProviderCapabilitySnapshot,
  RoutegoServiceError
} from "@routego-image/contracts";

export const UNCONFIRMED_CAPABILITY_MESSAGE = "当前中转未确认支持";

export interface CapabilityRegistryState {
  readonly records: readonly ProviderCapabilityRecord[];
  readonly transientFailures: readonly CapabilityTransientFailure[];
}

export interface CapabilityTransientFailure {
  readonly capability: ProviderCapability;
  readonly scope: ProviderCapabilityRecord["scope"];
  readonly error: RoutegoServiceError;
}

export interface CapabilityDecision {
  readonly capability: ProviderCapability;
  readonly state: CapabilityState;
  readonly enabled: boolean;
  readonly detail?: string | undefined;
  readonly unavailableMessage?: string | undefined;
  readonly transientFailure?: string | undefined;
  readonly record?: ProviderCapabilityRecord | undefined;
}

const STATE_PRIORITY: Readonly<Record<CapabilityState, number>> = {
  unknown: 0,
  unsupported: 1,
  degraded: 2,
  supported: 3
};

function capabilityScopeKey(
  capability: ProviderCapability,
  scope: ProviderCapabilityRecord["scope"]
): string {
  return [
    capability,
    scope.providerId,
    scope.model,
    scope.endpointFingerprint,
    scope.transport,
    scope.requestShape
  ].join("\u0000");
}

function recordKey(record: ProviderCapabilityRecord): string {
  return capabilityScopeKey(record.capability, record.scope);
}

function latestDetail(record: ProviderCapabilityRecord): string | undefined {
  return record.degradedReason ?? record.evidence.at(-1)?.summary;
}

export function createCapabilityRegistryState(
  snapshots: readonly ProviderCapabilitySnapshot[]
): CapabilityRegistryState {
  return {
    records: snapshots.flatMap((snapshot) => snapshot.capabilities),
    transientFailures: []
  };
}

export function integrateCapabilityProbeResult(
  state: CapabilityRegistryState,
  result: CapabilityProbeResult
): CapabilityRegistryState {
  const capability = result.record.capability;
  const incomingKey = recordKey(result.record);
  if (result.status === "failed") {
    return {
      records: state.records,
      transientFailures:
        result.error === undefined
          ? state.transientFailures
          : [
              ...state.transientFailures.filter(
                (failure) =>
                  capabilityScopeKey(failure.capability, failure.scope) !== incomingKey
              ),
              { capability, scope: result.record.scope, error: result.error }
            ]
    };
  }

  const existingIndex = state.records.findIndex((record) => recordKey(record) === incomingKey);
  const records = [...state.records];
  if (existingIndex === -1) {
    records.push(result.record);
  } else {
    records[existingIndex] = result.record;
  }
  const transientFailures = state.transientFailures.filter(
    (failure) =>
      capabilityScopeKey(failure.capability, failure.scope) !== incomingKey
  );
  return { records, transientFailures };
}

export function resolveCapability(
  state: CapabilityRegistryState,
  scope: {
    readonly providerId?: string | undefined;
    readonly model?: string | undefined;
    readonly capability: ProviderCapability;
  }
): CapabilityDecision {
  const candidates =
    scope.providerId === undefined || scope.model === undefined
      ? []
      : state.records
          .filter(
            (record) =>
              record.capability === scope.capability &&
              record.scope.providerId === scope.providerId &&
              record.scope.model === scope.model
          )
          .sort((left, right) => STATE_PRIORITY[right.state] - STATE_PRIORITY[left.state]);
  const record = candidates[0];
  const transientFailure = state.transientFailures.find(
    (failure) =>
      failure.capability === scope.capability &&
      failure.scope.providerId === scope.providerId &&
      failure.scope.model === scope.model
  )?.error.safeMessage;
  if (record === undefined) {
    return {
      capability: scope.capability,
      state: "unknown",
      enabled: false,
      unavailableMessage: UNCONFIRMED_CAPABILITY_MESSAGE,
      ...(transientFailure === undefined ? {} : { transientFailure })
    };
  }
  const enabled = record.state === "supported" || record.state === "degraded";
  return {
    capability: scope.capability,
    state: record.state,
    enabled,
    record,
    ...(latestDetail(record) === undefined ? {} : { detail: latestDetail(record) }),
    ...(enabled ? {} : { unavailableMessage: UNCONFIRMED_CAPABILITY_MESSAGE }),
    ...(transientFailure === undefined ? {} : { transientFailure })
  };
}

export function combineCapabilityDecisions(
  capability: ProviderCapability,
  decisions: readonly CapabilityDecision[]
): CapabilityDecision {
  const blocked = decisions.find((decision) => !decision.enabled);
  if (blocked !== undefined) {
    return {
      capability,
      state: decisions.some((decision) => decision.state === "unsupported")
        ? "unsupported"
        : "unknown",
      enabled: false,
      unavailableMessage: UNCONFIRMED_CAPABILITY_MESSAGE,
      ...(blocked.detail === undefined ? {} : { detail: blocked.detail }),
      ...(blocked.transientFailure === undefined
        ? {}
        : { transientFailure: blocked.transientFailure })
    };
  }
  const degraded = decisions.find((decision) => decision.state === "degraded");
  const matchingRecord =
    decisions.find((decision) => decision.capability === capability)?.record ??
    degraded?.record ??
    decisions[0]?.record;
  return {
    capability,
    state: degraded === undefined ? "supported" : "degraded",
    enabled: true,
    ...(matchingRecord === undefined ? {} : { record: matchingRecord }),
    ...(degraded?.detail === undefined ? {} : { detail: degraded.detail }),
    ...(decisions.find((decision) => decision.transientFailure)?.transientFailure === undefined
      ? {}
      : {
          transientFailure: decisions.find((decision) => decision.transientFailure)
            ?.transientFailure
        })
  };
}
