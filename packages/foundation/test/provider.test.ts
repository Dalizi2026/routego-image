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
    state?: ProviderCapabilityRecord["state"];
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
        source: state === "unsupported"
          ? "protocol-rejection"
          : state === "degraded"
            ? "degraded-fallback"
            : "successful-request",
        observedAt: OBSERVED_AT,
        summary: `synthetic ${state} evidence`,
        requestShape: options.requestShape ?? PROVIDER_REQUEST_SHAPES.singleEndpointImage,
        ...(state === "unsupported" ? { httpStatus: 400 } : {})
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

  it("uses the OpenAI Images request shape for a legacy API base text request", () => {
    const decision = selectProviderRoute(
      context([], {
        endpoints: {
          generation: { mode: "legacy-api-base", value: "https://relay.example" }
        }
      }),
      { kind: "generate", prompt: "OpenAI-compatible image request" }
    );
    expect(decision).toMatchObject({
      selected: true,
      tier: "B",
      transport: "openai-images",
      endpoint: "https://relay.example/v1/images/generations",
      requestShape: PROVIDER_REQUEST_SHAPES.imagesGenerationsJson
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

  it.each([
    ["unknown", false, false],
    ["unsupported", false, false],
    ["degraded", true, true],
    ["supported", true, false]
  ] as const)("routes %s reference evidence without probing", (state, selected, degraded) => {
    const records = ["single-image-input", "data-url-input"].map((name) =>
      capability(name as ProviderCapability, {
        state,
        requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointImage
      })
    );
    const decision = selectProviderRoute(context(records), {
      kind: "generate",
      prompt: "Reference state",
      references: [{ path: "/synthetic/reference.png", role: "reference" }]
    });
    expect(decision.selected).toBe(selected);
    if (decision.selected) expect(decision.degraded).toBe(degraded);
  });

  it("allows one direct reference-generation submission when its scoped input evidence is unknown", () => {
    const request = {
      kind: "generate",
      prompt: "Use the supplied layout reference",
      references: [{ path: "/synthetic/reference.png", role: "layout" }]
    };
    const selected = selectProviderRoute(
      context([], { allowUnverifiedDirectReferenceGeneration: true }),
      request
    );

    expect(selected).toMatchObject({
      selected: true,
      tier: "A",
      transport: "single-endpoint-json",
      requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointImage,
      effectiveKind: "generate",
      replayPolicy: "never"
    });
  });

  it("keeps explicitly unsupported reference-generation evidence unavailable", () => {
    const shape = PROVIDER_REQUEST_SHAPES.singleEndpointImage;
    const records = ["single-image-input", "data-url-input"].map((name) =>
      capability(name as ProviderCapability, { state: "unsupported", requestShape: shape })
    );
    const decision = selectProviderRoute(
      context(records, { allowUnverifiedDirectReferenceGeneration: true }),
      {
        kind: "generate",
        prompt: "Do not bypass an explicit reference-input rejection",
        references: [{ path: "/synthetic/reference.png", role: "reference" }]
      }
    );

    expect(decision.selected).toBe(false);
    if (!decision.selected) {
      expect(decision.missingCapabilities).toEqual(expect.arrayContaining([
        "single-image-input",
        "data-url-input"
      ]));
    }
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
    expect(unavailable).toMatchObject({ selected: true });

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
    expect(nativeTransparency).toMatchObject({
      selected: true,
      transparency: "native",
      replayPolicy: "never"
    });
  });

  it("forwards a configured custom size without capability-probe evidence", () => {
    const decision = selectProviderRoute(
      context([
        capability("text-generation", {
          requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointText
        })
      ], { preferredTransports: ["single-endpoint-json"] }),
      {
        kind: "generate",
        prompt: "Provider-defined square output",
        size: "1024x1024",
        aspectRatio: "1:1"
      }
    );

    expect(decision).toMatchObject({
      selected: true,
      transport: "single-endpoint-json"
    });
  });

  it("forwards a configured output format without capability-probe evidence", () => {
    const decision = selectProviderRoute(
      context([], { preferredTransports: ["openai-images"] }),
      {
        kind: "generate",
        prompt: "Provider-defined JPEG output",
        format: "jpeg"
      }
    );

    expect(decision).toMatchObject({
      selected: true,
      transport: "openai-images",
      requiredCapabilities: expect.arrayContaining(["output-format"])
    });
  });

  it.each([
    ["unknown", "local-fallback"],
    ["unsupported", "local-fallback"],
    ["degraded", "local-fallback"],
    ["supported", "native"]
  ] as const)("routes %s native-transparency evidence without probing", (state, transparency) => {
    const decision = selectProviderRoute(
      context([
        capability("native-transparency", {
          state,
          requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointText
        })
      ], { preferredTransports: ["single-endpoint-json"] }),
      { kind: "generate", prompt: "Transparency route", transparentMode: "native", format: "png" }
    );
    expect(decision).toMatchObject({ selected: true, transparency });
    if (decision.selected) {
      expect(decision.requiredCapabilities).not.toContain("native-transparency");
    }
  });

  it("keeps an unknown direct-edit route on the local fallback until native transparency is proven", () => {
    const decision = selectProviderRoute(
      context([], {
        preferredTransports: ["single-endpoint-json"],
        allowUnverifiedDirectEdit: true
      }),
      { kind: "edit", prompt: "Transparent product", targetImage: { path: "/tmp/product.png" }, invariants: { preserve: ["product"] }, transparentMode: "native", format: "png" }
    );
    expect(decision).toMatchObject({ selected: true, transparency: "local-fallback" });
  });

  it("requires a routed variant capability before submitting multiple images", () => {
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
    expect(decision).toMatchObject({ selected: false });
  });

  it("allows one authorized direct edit on the configured generation endpoint without deriving an edits endpoint", () => {
    const request = {
      kind: "edit",
      prompt: "Change the dress only",
      targetImage: { path: "/tmp/target.png" },
      invariants: { preserve: ["identity"] }
    };
    const unavailable = selectProviderRoute(context(), request);
    expect(unavailable.selected).toBe(false);

    const selected = selectProviderRoute(context([], { allowUnverifiedDirectEdit: true }), request);
    expect(selected).toMatchObject({
      selected: true,
      tier: "A",
      transport: "single-endpoint-json",
      endpoint: ENDPOINTS.generation.value,
      requestShape: PROVIDER_REQUEST_SHAPES.singleEndpointImage,
      effectiveKind: "edit",
      replayPolicy: "never"
    });
  });

  it("keeps explicitly unsupported direct edit evidence unavailable even with one-request authorization", () => {
    const shape = PROVIDER_REQUEST_SHAPES.singleEndpointImage;
    const records = ["single-image-input", "data-url-input", "target-edit"].map((name) =>
      capability(name as ProviderCapability, { state: "unsupported", requestShape: shape })
    );
    const decision = selectProviderRoute(
      context(records, { allowUnverifiedDirectEdit: true }),
      {
        kind: "edit",
        prompt: "Do not bypass explicit rejection",
        targetImage: { path: "/tmp/target.png" },
        invariants: { preserve: ["identity"] }
      }
    );
    expect(decision.selected).toBe(false);
    if (!decision.selected) {
      expect(decision.missingCapabilities).toEqual(expect.arrayContaining([
        "single-image-input",
        "data-url-input",
        "target-edit"
      ]));
    }
  });

  it("uses multipart only when an explicit Images Edits endpoint is configured", () => {
    const editsEndpoint = "https://relay.example/custom/edits";
    const decision = selectProviderRoute(
      context([], {
        endpoints: { ...ENDPOINTS, edits: editsEndpoint },
        preferredTransports: ["openai-images"],
        allowUnverifiedDirectEdit: true
      }),
      {
        kind: "edit",
        prompt: "Explicit multipart route",
        targetImage: { path: "/tmp/target.png" },
        references: [{ path: "/tmp/reference.png", role: "style" }],
        invariants: { preserve: ["identity"] }
      }
    );
    expect(decision).toMatchObject({
      selected: true,
      tier: "B",
      transport: "openai-images",
      endpoint: editsEndpoint,
      requestShape: PROVIDER_REQUEST_SHAPES.imagesEditsMultipart
    });
  });

  it("derives and prefers the standard Images Edits endpoint for a legacy API base edit", () => {
    const legacyEndpoints: ProviderEndpointSet = {
      generation: { mode: "legacy-api-base", value: "https://relay.example" }
    };
    const decision = selectProviderRoute(
      context([], { endpoints: legacyEndpoints, allowUnverifiedDirectEdit: true }),
      {
        kind: "edit",
        prompt: "Use the provider edit endpoint",
        targetImage: { path: "/tmp/target.png" },
        invariants: { preserve: ["identity"] }
      }
    );
    expect(decision).toMatchObject({
      selected: true,
      tier: "B",
      transport: "openai-images",
      endpoint: "https://relay.example/v1/images/edits",
      requestShape: PROVIDER_REQUEST_SHAPES.imagesEditsMultipart
    });
  });

  it("rejects missing edit fields and removed continuation fields before route selection", () => {
    expect(() => selectProviderRoute(context(), {
      kind: "edit",
      prompt: "Missing edit target and invariants"
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

  it("forbids every automatic replay, including same-transport pre-generation 429/5xx", () => {
    expect(evaluateAutomaticRetry(previous(), "single-endpoint-json")).toEqual({
      allowed: false,
      reason: "automatic-replay-forbidden"
    });
    expect(evaluateAutomaticRetry(
      previous({ errorCode: "provider_5xx", attemptCount: 2 }),
      "single-endpoint-json"
    )).toEqual({ allowed: false, reason: "automatic-replay-forbidden" });
  });

  it.each(["timeout", "auth_failed", "invalid_response", "cancelled"] as const)(
    "blocks same-transport automatic retry for %s",
    (errorCode) => {
      expect(
        evaluateAutomaticRetry(previous({ errorCode }), "single-endpoint-json")
      ).toEqual({ allowed: false, reason: "automatic-replay-forbidden" });
    }
  );

  it("blocks cross-transport, post-submit, partial-output, and billing-risk replay", () => {
    expect(evaluateAutomaticRetry(previous(), "openai-images").reason).toBe(
      "automatic-replay-forbidden"
    );
    expect(
      evaluateAutomaticRetry(previous({ stage: "submitted" }), "single-endpoint-json").reason
    ).toBe("automatic-replay-forbidden");
    expect(
      evaluateAutomaticRetry(
        previous({ receivedAnyOutput: true, mayHaveBilled: true }),
        "single-endpoint-json"
      ).reason
    ).toBe("automatic-replay-forbidden");
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
