import { describe, expect, it } from "vitest";

import {
  providerCapabilityRecordSchema,
  type ProviderCapability,
  type ProviderCapabilityRecord,
  type ProviderEndpointSet,
  type ProviderTransport
} from "@routego-image/contracts";
import {
  createUnknownCapabilityRecord,
  evaluateAutomaticRetry,
  evaluateCapabilityProbe,
  fingerprintProviderEndpoint,
  normalizeGenerationEndpoint,
  normalizeProviderEndpoints,
  PROVIDER_REQUEST_SHAPES,
  selectProviderRoute,
  transitionCapability,
  type PreviousProviderAttempt,
  type ProviderRoutingContext
} from "../src/index";

const OBSERVED_AT = "2026-07-17T12:34:56.000Z";
const ENDPOINTS: ProviderEndpointSet = {
  generation: {
    mode: "exact-generation-endpoint",
    value: "https://relay.example/custom/generate?tenant=test"
  }
};

function capability(
  capabilityName: ProviderCapability,
  options: {
    endpoint?: string;
    transport?: ProviderTransport;
    requestShape?: string;
    state?: "supported" | "degraded";
    limits?: Record<string, unknown>;
  } = {}
): ProviderCapabilityRecord {
  const state = options.state ?? "supported";
  return providerCapabilityRecordSchema.parse({
    capability: capabilityName,
    scope: {
      providerId: "provider-a",
      model: "gpt-image-2",
      endpointFingerprint: fingerprintProviderEndpoint(
        options.endpoint ?? ENDPOINTS.generation.value
      ),
      transport: options.transport ?? "single-endpoint-json",
      requestShape: options.requestShape ?? PROVIDER_REQUEST_SHAPES.singleEndpointImage
    },
    state,
    evidence: [
      {
        source: state === "degraded" ? "degraded-fallback" : "successful-request",
        observedAt: OBSERVED_AT,
        summary: `synthetic ${state} evidence`,
        requestShape: options.requestShape ?? PROVIDER_REQUEST_SHAPES.singleEndpointImage
      }
    ],
    verifiedAt: OBSERVED_AT,
    ...(state === "degraded" ? { degradedReason: "Reduced provider semantics." } : {}),
    ...(options.limits === undefined ? {} : { limits: options.limits })
  });
}

function context(
  capabilities: readonly ProviderCapabilityRecord[] = [],
  overrides: Partial<ProviderRoutingContext> = {}
): ProviderRoutingContext {
  return {
    providerId: "provider-a",
    model: "gpt-image-2",
    endpoints: ENDPOINTS,
    capabilities,
    ...overrides
  };
}

describe("endpoint normalization and no-guessing policy", () => {
  it("keeps an exact generation endpoint exact, including its configured path and query", () => {
    expect(normalizeGenerationEndpoint(ENDPOINTS.generation)).toBe(
      "https://relay.example/custom/generate?tenant=test"
    );
  });

  it.each([
    ["https://relay.example", "https://relay.example/v1/images/generations"],
    ["https://relay.example/v1", "https://relay.example/v1/images/generations"],
    [
      "https://relay.example/v1/images/generations",
      "https://relay.example/v1/images/generations"
    ]
  ])("applies legacy normalization only when explicitly selected", (value, expected) => {
    expect(
      normalizeGenerationEndpoint({ mode: "legacy-api-base", value })
    ).toBe(expected);
  });

  it("leaves models, Edits, and Responses absent unless independently configured", () => {
    const normalized = normalizeProviderEndpoints(ENDPOINTS);
    expect(normalized).toMatchObject({
      mode: "exact-generation-endpoint",
      generationEndpoint: ENDPOINTS.generation.value
    });
    expect(normalized.modelsEndpoint).toBeUndefined();
    expect(normalized.editsEndpoint).toBeUndefined();
    expect(normalized.responsesEndpoint).toBeUndefined();
  });
});

describe("capability evidence transitions and probes", () => {
  const scope = {
    providerId: "provider-a",
    model: "gpt-image-2",
    endpointFingerprint: fingerprintProviderEndpoint(ENDPOINTS.generation.value),
    transport: "single-endpoint-json" as const,
    requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointImage
  };

  it("preserves the current state and limits after authentication, timeout, or other transient evidence", () => {
    const current = capability("single-image-input", { limits: { maxImages: 1 } });
    const next = transitionCapability(current, {
      outcome: "transient",
      evidence: {
        source: "transient-failure",
        observedAt: OBSERVED_AT,
        summary: "Synthetic authentication failure"
      }
    });

    expect(next.state).toBe("supported");
    expect(next.verifiedAt).toBe(current.verifiedAt);
    expect(next.limits).toEqual({ maxImages: 1 });
    expect(next.evidence.at(-1)?.source).toBe("transient-failure");
  });

  it("requires stable protocol evidence before transitioning to unsupported", () => {
    const unknown = createUnknownCapabilityRecord("single-image-input", scope);
    expect(() =>
      transitionCapability(unknown, {
        outcome: "unsupported",
        evidence: {
          source: "transient-failure",
          observedAt: OBSERVED_AT,
          summary: "Synthetic timeout"
        }
      })
    ).toThrow(/stable protocol/u);

    expect(
      transitionCapability(unknown, {
        outcome: "unsupported",
        evidence: {
          source: "protocol-rejection",
          observedAt: OBSERVED_AT,
          summary: "Synthetic stable unsupported response",
          httpStatus: 400
        }
      }).state
    ).toBe("unsupported");
  });

  it("does not let synthetic fixtures become production support evidence", () => {
    const unknown = createUnknownCapabilityRecord("multi-image-input", {
      ...scope,
      requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointImages
    });
    const next = transitionCapability(unknown, {
      outcome: "synthetic",
      evidence: {
        source: "synthetic-fixture",
        observedAt: OBSERVED_AT,
        summary: "Offline mock only"
      }
    });
    expect(next.state).toBe("unknown");
  });

  it("requires explicit confirmation for potentially billable live probes", () => {
    expect(
      evaluateCapabilityProbe({
        kind: "live-provider",
        mayGenerateOutput: true,
        mayCharge: true,
        confirmedByUser: false
      })
    ).toEqual({
      allowed: false,
      requiresConfirmation: true,
      reason: "confirmation-required"
    });
    expect(
      evaluateCapabilityProbe({
        kind: "live-provider",
        mayGenerateOutput: true,
        mayCharge: true,
        confirmedByUser: true
      }).allowed
    ).toBe(true);
    expect(
      evaluateCapabilityProbe({
        kind: "documentary",
        mayGenerateOutput: false,
        mayCharge: false,
        confirmedByUser: false
      }).allowed
    ).toBe(true);
  });
});

describe("provider route selection", () => {
  it("uses the exact Tier A endpoint as the default text-only baseline", () => {
    const decision = selectProviderRoute(context(), {
      kind: "generate",
      prompt: "中文提示 🚀\nline two"
    });
    expect(decision).toMatchObject({
      selected: true,
      tier: "A",
      transport: "single-endpoint-json",
      endpoint: ENDPOINTS.generation.value,
      requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointText
    });
  });

  it("supports explicitly preferred Tier B text generation without using an edit endpoint", () => {
    const text = selectProviderRoute(
      context([], { preferredTransports: ["openai-images"] }),
      { kind: "generate", prompt: "Tier B text" }
    );
    expect(text).toMatchObject({
      selected: true,
      tier: "B",
      transport: "openai-images",
      endpoint: ENDPOINTS.generation.value,
      requestShape: PROVIDER_REQUEST_SHAPES.imagesGenerationsJson
    });

    expect(text.selected).toBe(true);
  });

  it("gates Tier A generation references on exact scoped evidence", () => {
    const request = {
      kind: "generate",
      prompt: "Reference generation",
      references: [{ path: "/tmp/reference.png", role: "subject" }]
    };
    const required = [
      capability("single-image-input"),
      capability("data-url-input")
    ];
    expect(selectProviderRoute(context(required), request)).toMatchObject({
      selected: true,
      tier: "A",
      requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointImage,
      effectiveKind: "generate"
    });

    const wrongShape = required.map((record) => ({
      ...record,
      scope: { ...record.scope, requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointImages }
    }));
    const unavailable = selectProviderRoute(context(wrongShape), request);
    expect(unavailable.selected).toBe(false);
    if (!unavailable.selected) {
      expect(unavailable.missingCapabilities).toEqual(
        expect.arrayContaining(["single-image-input", "data-url-input"])
      );
    }
  });

  it("selects Tier C Responses reference generation only with an explicit endpoint and scoped capabilities", () => {
    const responsesEndpoint = "https://relay.example/custom/responses";
    const tierC = ["text-generation", "single-image-input", "data-url-input"].map((name) =>
      capability(name as ProviderCapability, {
        endpoint: responsesEndpoint,
        transport: "openai-responses",
        requestShape: PROVIDER_REQUEST_SHAPES.responsesImageGeneration
      })
    );
    const responsesDecision = selectProviderRoute(
      context(tierC, {
        endpoints: { ...ENDPOINTS, responses: responsesEndpoint }
      }),
      {
        kind: "generate",
        prompt: "Responses reference",
        references: [{ path: "/tmp/reference.png", role: "reference" }]
      }
    );
    expect(responsesDecision).toMatchObject({
      selected: true,
      tier: "C",
      endpoint: responsesEndpoint,
      requestShape: PROVIDER_REQUEST_SHAPES.responsesImageGeneration
    });
  });

  it("requires evidence for every non-default requested feature", () => {
    const featureCapabilities: ProviderCapability[] = [
      "native-variants",
      "custom-size",
      "quality-control",
      "output-format",
      "compression",
      "streaming",
      "partial-images",
      "moderation"
    ];
    const records = featureCapabilities.map((name) => {
      const limits =
        name === "native-variants"
          ? { maxVariants: 4 }
          : name === "custom-size"
            ? { supportedSizes: ["1024x1024", "square"] }
            : name === "quality-control"
              ? { supportedQualities: ["high"] }
              : name === "output-format"
                ? { supportedFormats: ["webp"] }
                : name === "partial-images"
                  ? { maxPartialImages: 1 }
                  : undefined;
      return capability(name, {
        requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointText,
        ...(limits === undefined ? {} : { limits })
      });
    });
    const request = {
      kind: "generate",
      prompt: "All explicit features",
      count: 2,
      size: "1024x1024",
      aspectRatio: "square",
      quality: "high",
      format: "webp",
      compression: 80,
      partialImages: 1,
      moderation: "low"
    };
    expect(
      selectProviderRoute(context(records, { preferredTransports: ["single-endpoint-json"] }), request)
    ).toMatchObject({ selected: true });

    const withoutModeration = records.filter((record) => record.capability !== "moderation");
    const unavailable = selectProviderRoute(
      context(withoutModeration, { preferredTransports: ["single-endpoint-json"] }),
      request
    );
    expect(unavailable.selected).toBe(false);
    if (!unavailable.selected) {
      expect(unavailable.missingCapabilities).toContain("moderation");
    }

    const nativeTransparency = selectProviderRoute(
      context(
        [
          capability("native-transparency", {
            requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointText
          })
        ],
        { preferredTransports: ["single-endpoint-json"] }
      ),
      { kind: "generate", prompt: "Transparent", transparentMode: "native", format: "png" }
    );
    expect(nativeTransparency).toMatchObject({ selected: true });
  });

  it("enforces capability limits instead of silently degrading them", () => {
    const decision = selectProviderRoute(
      context(
        [
          capability("native-variants", {
            requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointText,
            limits: { maxVariants: 2 }
          })
        ],
        { preferredTransports: ["single-endpoint-json"] }
      ),
      { kind: "generate", prompt: "Too many variants", count: 3 }
    );
    expect(decision.selected).toBe(false);
    if (!decision.selected) {
      expect(decision.limitViolations).toContainEqual({
        capability: "native-variants",
        limit: "maxVariants",
        requested: 3,
        supported: 2
      });
    }
  });

  it("rejects removed edit and continuation request fields before route selection", () => {
    expect(() => selectProviderRoute(context(), {
      kind: "edit",
      prompt: "Removed edit"
    })).toThrow();
    expect(() => selectProviderRoute(context(), {
      kind: "generate",
      prompt: "Removed continuation",
      previousResponseId: "response-previous"
    })).toThrow();
  });
});

describe("automatic retry and replay prohibitions", () => {
  function previous(overrides: Partial<PreviousProviderAttempt> = {}): PreviousProviderAttempt {
    return {
      transport: "single-endpoint-json",
      errorCode: "rate_limited",
      stage: "pre-generation",
      attemptCount: 1,
      receivedAnyOutput: false,
      mayHaveBilled: false,
      ...overrides
    };
  }

  it("allows only bounded same-transport pre-generation 429/5xx retries", () => {
    expect(evaluateAutomaticRetry(previous(), "single-endpoint-json")).toEqual({
      allowed: true,
      reason: "safe-same-transport-pre-generation"
    });
    expect(
      evaluateAutomaticRetry(previous({ errorCode: "provider_5xx", attemptCount: 2 }), "single-endpoint-json")
        .allowed
    ).toBe(true);
    expect(evaluateAutomaticRetry(previous({ attemptCount: 3 }), "single-endpoint-json")).toEqual({
      allowed: false,
      reason: "retry-limit-reached"
    });
  });

  it.each(["timeout", "auth_failed", "invalid_response", "cancelled"] as const)(
    "blocks same-transport automatic retry for %s",
    (errorCode) => {
      expect(
        evaluateAutomaticRetry(previous({ errorCode }), "single-endpoint-json")
      ).toEqual({ allowed: false, reason: "failure-not-retryable" });
    }
  );

  it("blocks cross-transport, post-submit, partial-output, and billing-risk replay", () => {
    expect(evaluateAutomaticRetry(previous(), "openai-images").reason).toBe(
      "cross-transport-replay-forbidden"
    );
    expect(
      evaluateAutomaticRetry(previous({ stage: "submitted" }), "single-endpoint-json").reason
    ).toBe("failure-not-retryable");
    expect(
      evaluateAutomaticRetry(
        previous({ receivedAnyOutput: true, mayHaveBilled: true }),
        "single-endpoint-json"
      ).reason
    ).toBe("output-or-billing-risk");
  });

  it("returns an unavailable decision rather than routing after a timeout or partial output", () => {
    for (const attempt of [
      previous({ errorCode: "timeout" }),
      previous({ receivedAnyOutput: true, mayHaveBilled: true, stage: "streaming" })
    ]) {
      const decision = selectProviderRoute(context([], { previousAttempt: attempt }), {
        kind: "generate",
        prompt: "Do not replay"
      });
      expect(decision.selected).toBe(false);
      if (!decision.selected) {
        expect(decision.error.retryDisposition).toBe("never");
        expect(decision.retryBlockReasons.length).toBeGreaterThan(0);
      }
    }
  });
});
