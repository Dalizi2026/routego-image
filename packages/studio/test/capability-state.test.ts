import { describe, expect, it } from "vitest";

import type {
  CapabilityProbeResult,
  CapabilityState,
  ProviderCapability,
  ProviderCapabilityRecord
} from "@routego-image/contracts";

import {
  CreationCapabilityError,
  createCapabilityRegistryState,
  integrateCapabilityProbeResult,
  resolveCapability,
  UNCONFIRMED_CAPABILITY_MESSAGE,
  validateCreationCapabilities
} from "../src/features/capabilities";
import {
  createInitialCreationDraft,
  MaskIntegrationError,
  validateMaskCapability,
  type CreationDraft
} from "../src/features/creation";

const defaults = {
  model: "mock-image-model",
  size: "auto" as const,
  aspectRatio: "auto" as const,
  quality: "auto" as const,
  format: "png" as const,
  count: 1 as const,
  partialImages: 0 as const,
  transparentMode: "off" as const,
  moderation: "auto" as const,
  saveToLibrary: true
};

function record(
  capability: ProviderCapability,
  state: CapabilityState,
  overrides: Partial<ProviderCapabilityRecord> = {}
): ProviderCapabilityRecord {
  const evidence =
    state === "supported"
      ? [{ source: "successful-request" as const, observedAt: "2026-07-18T00:00:00.000Z", summary: "Confirmed." }]
      : state === "unsupported"
        ? [{ source: "protocol-rejection" as const, observedAt: "2026-07-18T00:00:00.000Z", summary: "Rejected." }]
        : state === "degraded"
          ? [{ source: "degraded-fallback" as const, observedAt: "2026-07-18T00:00:00.000Z", summary: "Fallback." }]
          : [];
  return {
    capability,
    state,
    scope: {
      providerId: "mock-provider",
      model: "mock-image-model",
      endpointFingerprint: "a".repeat(64),
      transport: "single-endpoint-json",
      requestShape: "synthetic"
    },
    evidence,
    ...(state === "unknown" ? {} : { verifiedAt: "2026-07-18T00:00:00.000Z" }),
    ...(state === "degraded" ? { degradedReason: "Uses a visible weaker fallback." } : {}),
    ...overrides
  };
}

function decisionFor(records: readonly ProviderCapabilityRecord[]) {
  const state = { records, transientFailures: [] };
  return (capability: ProviderCapability) =>
    resolveCapability(state, {
      providerId: "mock-provider",
      model: "mock-image-model",
      capability
    });
}

describe("scoped four-state capability evidence", () => {
  it("distinguishes unknown, supported, unsupported, and degraded states", () => {
    const unknown = decisionFor([])("single-image-input");
    const supported = decisionFor([record("single-image-input", "supported")])(
      "single-image-input"
    );
    const unsupported = decisionFor([record("single-image-input", "unsupported")])(
      "single-image-input"
    );
    const degraded = decisionFor([record("single-image-input", "degraded")])(
      "single-image-input"
    );

    expect(unknown).toMatchObject({ state: "unknown", enabled: false });
    expect(unknown.unavailableMessage).toBe(UNCONFIRMED_CAPABILITY_MESSAGE);
    expect(supported).toMatchObject({ state: "supported", enabled: true });
    expect(unsupported).toMatchObject({ state: "unsupported", enabled: false });
    expect(unsupported.unavailableMessage).toBe("当前中转未确认支持");
    expect(degraded).toMatchObject({ state: "degraded", enabled: true });
    expect(degraded.detail).toContain("weaker fallback");
  });

  it("integrates completed probes and preserves the previous state on transient failure", () => {
    const initial = createCapabilityRegistryState([]);
    const completed = integrateCapabilityProbeResult(initial, {
      status: "completed",
      record: record("target-edit", "supported")
    } as CapabilityProbeResult);
    expect(decisionFor(completed.records)("target-edit").state).toBe("supported");

    const failed = integrateCapabilityProbeResult(completed, {
      status: "failed",
      record: record("target-edit", "unknown"),
      error: { safeMessage: "Synthetic timeout." }
    } as CapabilityProbeResult);
    const decision = resolveCapability(failed, {
      providerId: "mock-provider",
      model: "mock-image-model",
      capability: "target-edit"
    });
    expect(decision.state).toBe("supported");
    expect(decision.transientFailure).toBe("Synthetic timeout.");

    const otherProviderFailure = integrateCapabilityProbeResult(completed, {
      status: "failed",
      record: {
        ...record("target-edit", "unknown"),
        scope: {
          ...record("target-edit", "unknown").scope,
          providerId: "other-provider"
        }
      },
      error: { safeMessage: "Other provider timeout." }
    } as CapabilityProbeResult);
    expect(
      resolveCapability(otherProviderFailure, {
        providerId: "mock-provider",
        model: "mock-image-model",
        capability: "target-edit"
      }).transientFailure
    ).toBeUndefined();
  });

  it.each([
    "Authentication failed.",
    "Rate limited.",
    "Timed out.",
    "Moderation interrupted the probe.",
    "Provider failed transiently."
  ])("keeps conclusive evidence across the transient failure matrix: %s", (safeMessage) => {
    const supported = {
      records: [record("target-edit", "supported")],
      transientFailures: []
    };
    const failed = integrateCapabilityProbeResult(supported, {
      status: "failed",
      record: record("target-edit", "unknown"),
      error: { safeMessage }
    } as CapabilityProbeResult);
    const decision = resolveCapability(failed, {
      providerId: "mock-provider",
      model: "mock-image-model",
      capability: "target-edit"
    });
    expect(decision).toMatchObject({ state: "supported", transientFailure: safeMessage });
  });

  it("blocks unconfirmed feature combinations and permits an explained degraded fallback", () => {
    const draft: CreationDraft = {
      ...createInitialCreationDraft(defaults),
      prompt: "Transparent result",
      controls: {
        ...createInitialCreationDraft(defaults).controls,
        transparentMode: "chromakey"
      }
    };
    expect(() => validateCreationCapabilities(draft, decisionFor([]))).toThrow(
      CreationCapabilityError
    );
    const degraded = decisionFor([record("native-transparency", "degraded")]);
    expect(validateCreationCapabilities(draft, degraded)).toEqual([
      "Uses a visible weaker fallback."
    ]);
    expect(() =>
      validateCreationCapabilities(
        { ...draft, controls: { ...draft.controls, transparentMode: "native" } },
        degraded
      )
    ).toThrow(CreationCapabilityError);
  });

  it("enforces evidence limits in addition to the four-state gate", () => {
    const limited = decisionFor([
      record("native-variants", "supported", { limits: { maxVariants: 2 } })
    ]);
    const draft: CreationDraft = {
      ...createInitialCreationDraft(defaults),
      prompt: "Three variants",
      controls: { ...createInitialCreationDraft(defaults).controls, count: 3 }
    };
    expect(() => validateCreationCapabilities(draft, limited)).toThrow(CreationCapabilityError);
    try {
      validateCreationCapabilities(draft, limited);
    } catch (error) {
      expect((error as CreationCapabilityError).fields["count"]).toContain("最多允许 2 个变体");
    }
  });

  it("blocks every non-default output or continuation control without scoped evidence", () => {
    const base = { ...createInitialCreationDraft(defaults), prompt: "Gated controls" };
    const cases: Array<[CreationDraft, string]> = [
      [{ ...base, controls: { ...base.controls, size: "1024x1024" } }, "size"],
      [{ ...base, controls: { ...base.controls, quality: "high" } }, "quality"],
      [{ ...base, controls: { ...base.controls, format: "jpeg" } }, "format"],
      [
        { ...base, controls: { ...base.controls, format: "jpeg", compression: 80 } },
        "compression"
      ],
      [{ ...base, controls: { ...base.controls, partialImages: 1 } }, "partialImages"],
      [{ ...base, controls: { ...base.controls, action: "generate" } }, "continuation"]
    ];
    for (const [draft, expectedField] of cases) {
      try {
        validateCreationCapabilities(draft, decisionFor([]));
        throw new Error("Expected the capability gate to reject the draft.");
      } catch (error) {
        expect(error).toBeInstanceOf(CreationCapabilityError);
        expect((error as CreationCapabilityError).fields[expectedField]).toBe(
          UNCONFIRMED_CAPABILITY_MESSAGE
        );
      }
    }
  });

  it("requires scoped mask evidence and literal target slot zero before edit submission", () => {
    const base: CreationDraft = {
      ...createInitialCreationDraft(defaults),
      mode: "edit",
      prompt: "Mask the synthetic target.",
      target: {
        id: "target-01",
        role: "previous-output",
        locator: { source: "asset", assetId: "asset-01" }
      },
      mask: {
        image: { source: "upload", uploadResourceId: "upload-mask-01" },
        targetSlot: 0
      },
      invariants: { allowedChanges: ["background"], preserve: ["subject"], forbiddenChanges: [] }
    };
    const editOnly = decisionFor([
      record("single-image-input", "supported"),
      record("target-edit", "supported")
    ]);
    expect(validateCreationCapabilities(base, editOnly)).toEqual([]);
    expect(() => validateMaskCapability(base, editOnly("mask-edit"))).toThrow(
      MaskIntegrationError
    );
    try {
      validateMaskCapability(base, editOnly("mask-edit"));
    } catch (error) {
      expect((error as MaskIntegrationError).fields["mask"]).toBe(
        UNCONFIRMED_CAPABILITY_MESSAGE
      );
    }
    const supported = decisionFor([
      record("single-image-input", "supported"),
      record("target-edit", "supported"),
      record("mask-edit", "supported")
    ]);
    expect(validateCreationCapabilities(base, supported)).toEqual([]);
    expect(validateMaskCapability(base, supported("mask-edit"))).toEqual([]);
    const degraded = decisionFor([
      record("single-image-input", "supported"),
      record("target-edit", "supported"),
      record("mask-edit", "degraded")
    ]);
    expect(validateMaskCapability(base, degraded("mask-edit"))).toEqual([
      "Uses a visible weaker fallback."
    ]);
  });
});
