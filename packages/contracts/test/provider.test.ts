import { describe, expect, it } from "vitest";

import {
  capabilityEvidenceSchema,
  generationEndpointInputSchema,
  providerCapabilityRecordSchema,
  providerCapabilitySnapshotSchema,
  providerEndpointSetSchema,
  providerUrlSchema
} from "../src/index";
import { TEST_TIMESTAMP } from "./fixtures";

const scope = {
  providerId: "provider-a",
  model: "gpt-image-2",
  endpointFingerprint: "a".repeat(64),
  transport: "single-endpoint-json" as const,
  requestShape: "single-endpoint-json:image"
};

function evidence(source: string) {
  return capabilityEvidenceSchema.parse({
    source,
    observedAt: TEST_TIMESTAMP,
    summary: `synthetic ${source} evidence`,
    requestShape: scope.requestShape
  });
}

describe("provider endpoint contracts", () => {
  it("preserves exact and explicit legacy input semantics without deriving sibling endpoints", () => {
    expect(
      generationEndpointInputSchema.parse({
        mode: "exact-generation-endpoint",
        value: "https://relay.example/custom/image-endpoint?tenant=test"
      })
    ).toEqual({
      mode: "exact-generation-endpoint",
      value: "https://relay.example/custom/image-endpoint?tenant=test"
    });

    const endpoints = providerEndpointSetSchema.parse({
      generation: {
        mode: "legacy-api-base",
        value: "http://127.0.0.1:43119/api"
      }
    });
    expect(endpoints).toEqual({
      generation: {
        mode: "legacy-api-base",
        value: "http://127.0.0.1:43119/api"
      }
    });
    expect(endpoints).not.toHaveProperty("models");
    expect(endpoints).not.toHaveProperty("edits");
    expect(endpoints).not.toHaveProperty("responses");
  });

  it.each([
    "ftp://relay.example/v1/images/generations",
    "https://user:password@relay.example/v1/images/generations",
    "http://relay.example/v1/images/generations",
    "https://relay.example/v1/images/generations#secret",
    "not a URL"
  ])("rejects unsafe provider URL %s", (value) => {
    expect(providerUrlSchema.safeParse(value).success).toBe(false);
  });

  it("accepts loopback cleartext endpoints but rejects unknown fields", () => {
    expect(providerUrlSchema.safeParse("http://[::1]:43119/v1/images/generations").success).toBe(true);
    expect(
      providerEndpointSetSchema.safeParse({
        generation: {
          mode: "exact-generation-endpoint",
          value: "https://relay.example/v1/images/generations"
        },
        guessedModels: "https://relay.example/v1/models"
      }).success
    ).toBe(false);
  });
});

describe("four-state capability contracts", () => {
  it("accepts unknown with no evidence as the default evidence state", () => {
    expect(
      providerCapabilityRecordSchema.parse({
        capability: "single-image-input",
        scope,
        state: "unknown"
      })
    ).toMatchObject({ state: "unknown", evidence: [] });
  });

  it("accepts supported, unsupported, and degraded only with conclusive evidence", () => {
    const supported = providerCapabilityRecordSchema.parse({
      capability: "single-image-input",
      scope,
      state: "supported",
      evidence: [evidence("successful-request")],
      verifiedAt: TEST_TIMESTAMP,
      limits: { maxImages: 1, supportedImageFields: ["image"] }
    });
    const unsupported = providerCapabilityRecordSchema.parse({
      capability: "multi-image-input",
      scope: { ...scope, requestShape: "single-endpoint-json:images" },
      state: "unsupported",
      evidence: [evidence("protocol-rejection")],
      verifiedAt: TEST_TIMESTAMP
    });
    const degraded = providerCapabilityRecordSchema.parse({
      capability: "responses-state",
      scope,
      state: "degraded",
      evidence: [evidence("degraded-fallback")],
      verifiedAt: TEST_TIMESTAMP,
      degradedReason: "Previous output must be uploaded again."
    });

    expect([supported.state, unsupported.state, degraded.state]).toEqual([
      "supported",
      "unsupported",
      "degraded"
    ]);
  });

  it("does not allow transient or synthetic evidence to claim support or lack of support", () => {
    for (const state of ["supported", "unsupported"] as const) {
      expect(
        providerCapabilityRecordSchema.safeParse({
          capability: "single-image-input",
          scope,
          state,
          evidence: [evidence("transient-failure")],
          verifiedAt: TEST_TIMESTAMP
        }).success
      ).toBe(false);
      expect(
        providerCapabilityRecordSchema.safeParse({
          capability: "single-image-input",
          scope,
          state,
          evidence: [evidence("synthetic-fixture")],
          verifiedAt: TEST_TIMESTAMP
        }).success
      ).toBe(false);
    }
  });

  it("validates a redacted snapshot and rejects unknown snapshot fields", () => {
    const value = {
      schemaVersion: 1,
      providerId: "provider-a",
      model: "gpt-image-2",
      endpoint: {
        mode: "exact-generation-endpoint",
        origin: "https://relay.example",
        pathname: "/v1/images/generations",
        hasQuery: true,
        display: "https://relay.example/v1/images/generations?[REDACTED]"
      },
      capabilities: [],
      refreshedAt: TEST_TIMESTAMP
    };
    expect(providerCapabilitySnapshotSchema.parse(value)).toEqual(value);
    expect(
      providerCapabilitySnapshotSchema.safeParse({ ...value, apiKey: "synthetic-secret" }).success
    ).toBe(false);
  });
});
