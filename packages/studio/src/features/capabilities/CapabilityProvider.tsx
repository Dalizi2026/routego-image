import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode
} from "react";

import type {
  CapabilityProbeResult,
  ProviderCapability,
  ProviderCapabilitySnapshot
} from "@routego-image/contracts";

import {
  createCapabilityRegistryState,
  integrateCapabilityProbeResult,
  resolveCapability,
  type CapabilityDecision,
  type CapabilityRegistryState
} from "./state";

interface CapabilityContextValue {
  readonly providerId?: string | undefined;
  readonly model?: string | undefined;
  readonly state: CapabilityRegistryState;
  readonly resolve: (capability: ProviderCapability) => CapabilityDecision;
  readonly integrateProbeResult: (result: CapabilityProbeResult) => void;
}

type CapabilityAction =
  | { readonly type: "probe-result"; readonly result: CapabilityProbeResult }
  | {
      readonly type: "reset";
      readonly snapshots: readonly ProviderCapabilitySnapshot[];
    };

const CapabilityContext = createContext<CapabilityContextValue | undefined>(undefined);

function capabilityReducer(
  state: CapabilityRegistryState,
  action: CapabilityAction
): CapabilityRegistryState {
  return action.type === "reset"
    ? createCapabilityRegistryState(action.snapshots)
    : integrateCapabilityProbeResult(state, action.result);
}

export function CapabilityProvider({
  providerId,
  model,
  snapshots,
  children
}: {
  readonly providerId?: string | undefined;
  readonly model?: string | undefined;
  readonly snapshots: readonly ProviderCapabilitySnapshot[];
  readonly children?: ReactNode | undefined;
}) {
  const [state, dispatch] = useReducer(
    capabilityReducer,
    snapshots,
    createCapabilityRegistryState
  );
  useEffect(() => {
    dispatch({ type: "reset", snapshots });
  }, [snapshots]);
  const resolve = useCallback(
    (capability: ProviderCapability) =>
      resolveCapability(state, { providerId, model, capability }),
    [model, providerId, state]
  );
  const integrateProbeResult = useCallback((result: CapabilityProbeResult) => {
    dispatch({ type: "probe-result", result });
  }, []);
  const value = useMemo(
    () => ({ providerId, model, state, resolve, integrateProbeResult }),
    [integrateProbeResult, model, providerId, resolve, state]
  );
  return <CapabilityContext.Provider value={value}>{children}</CapabilityContext.Provider>;
}

export function useCapabilityRegistry(): CapabilityContextValue {
  const value = useContext(CapabilityContext);
  if (value === undefined) {
    throw new Error("Studio capability state must be provided by CapabilityProvider.");
  }
  return value;
}
