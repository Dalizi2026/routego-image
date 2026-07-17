import { describe, expect, it } from "vitest";

import {
  apiKeyMutationSchema,
  capabilityProbeInputSchema,
  capabilityProbeResultSchema,
  parseStudioOperationInput,
  parseStudioOperationOutput,
  readSettingsResultSchema,
  refreshModelsResultSchema,
  routegoOperationDefinitions,
  routegoOperationNames,
  studioOperationDefinitions,
  studioOperationNames,
  upsertProviderProfileInputSchema,
  upsertProviderProfileResultSchema
} from "../src/index";
import { TEST_TIMESTAMP } from "./fixtures";

const endpoint = {
  mode: "exact-generation-endpoint" as const,
  origin: "https://relay.example",
  pathname: "/v1/images/generations",
  hasQuery: false,
  display: "https://relay.example/v1/images/generations"
};

const profile = {
  id: "provider-a",
  name: "Synthetic relay",
  endpoints: { generation: endpoint },
  defaultModel: "gpt-image-2",
  models: ["gpt-image-2"],
  hasApiKey: true,
  apiKeyPreview: "sk-…mock",
  isActive: true,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_TIMESTAMP
};

const defaults = {
  model: "gpt-image-2",
  size: "auto" as const,
  aspectRatio: "auto" as const,
  quality: "auto" as const,
  format: "png" as const,
  count: 1,
  partialImages: 0,
  transparentMode: "off" as const,
  moderation: "auto" as const,
  saveToLibrary: true
};

describe("write-only provider profile settings contracts", () => {
  it("distinguishes unchanged, replace, and clear without accepting stray values", () => {
    expect(apiKeyMutationSchema.parse({ operation: "unchanged" })).toEqual({
      operation: "unchanged"
    });
    expect(apiKeyMutationSchema.parse({ operation: "replace", value: "synthetic-key" })).toEqual({
      operation: "replace",
      value: "synthetic-key"
    });
    expect(apiKeyMutationSchema.parse({ operation: "clear" })).toEqual({ operation: "clear" });

    expect(
      apiKeyMutationSchema.safeParse({ operation: "unchanged", value: "synthetic-key" }).success
    ).toBe(false);
    expect(apiKeyMutationSchema.safeParse({ operation: "replace", value: "   " }).success).toBe(
      false
    );
    expect(
      apiKeyMutationSchema.safeParse({ operation: "clear", value: "synthetic-key" }).success
    ).toBe(false);
  });

  it("accepts endpoint writes but exposes only redacted profile secret metadata", () => {
    const input = upsertProviderProfileInputSchema.parse({
      name: "Synthetic relay",
      endpoints: {
        generation: {
          mode: "exact-generation-endpoint",
          value: "https://relay.example/v1/images/generations"
        }
      },
      apiKey: { operation: "replace", value: "synthetic-key" },
      setActive: true
    });
    expect(input.apiKey).toEqual({ operation: "replace", value: "synthetic-key" });

    const result = upsertProviderProfileResultSchema.parse({
      schemaVersion: 1,
      profile,
      activeProviderId: "provider-a"
    });
    expect(result.profile).toMatchObject({ hasApiKey: true, apiKeyPreview: "sk-…mock" });
    expect(JSON.stringify(result)).not.toContain("synthetic-key");
    expect(
      upsertProviderProfileResultSchema.safeParse({
        schemaVersion: 1,
        profile: { ...profile, apiKey: "synthetic-key" },
        activeProviderId: "provider-a"
      }).success
    ).toBe(false);
  });

  it("validates one active profile and rejects preview metadata when no key exists", () => {
    expect(
      readSettingsResultSchema.parse({
        schemaVersion: 1,
        activeProviderId: "provider-a",
        profiles: [profile],
        defaults,
        outputDirectory: { configured: true, display: "Pictures/routego-image" }
      }).profiles
    ).toHaveLength(1);

    expect(
      readSettingsResultSchema.safeParse({
        schemaVersion: 1,
        profiles: [{ ...profile, hasApiKey: false, isActive: false }],
        defaults,
        outputDirectory: { configured: false }
      }).success
    ).toBe(false);
  });
});

describe("model refresh and confirmed capability probe contracts", () => {
  it("marks model refresh as non-billable and requires structured failure metadata", () => {
    expect(
      refreshModelsResultSchema.parse({
        schemaVersion: 1,
        providerId: "provider-a",
        status: "succeeded",
        billable: false,
        models: ["gpt-image-2"],
        refreshedAt: TEST_TIMESTAMP
      })
    ).toMatchObject({ status: "succeeded", billable: false });

    expect(
      refreshModelsResultSchema.safeParse({
        schemaVersion: 1,
        providerId: "provider-a",
        status: "failed",
        billable: false,
        models: []
      }).success
    ).toBe(false);
  });

  it("rejects an unconfirmed probe and accepts scoped four-state records", () => {
    const baseInput = {
      providerId: "provider-a",
      model: "gpt-image-2",
      capability: "single-image-input" as const,
      transport: "single-endpoint-json" as const,
      requestShape: "single-endpoint-json:image"
    };
    expect(capabilityProbeInputSchema.safeParse(baseInput).success).toBe(false);
    expect(
      capabilityProbeInputSchema.parse({ ...baseInput, confirmBillableProbe: true })
        .confirmBillableProbe
    ).toBe(true);

    const scope = {
      providerId: "provider-a",
      model: "gpt-image-2",
      endpointFingerprint: "a".repeat(64),
      transport: "single-endpoint-json" as const,
      requestShape: "single-endpoint-json:image"
    };
    const records = [
      {
        capability: "single-image-input" as const,
        scope,
        state: "unknown" as const,
        evidence: [
          {
            source: "transient-failure" as const,
            observedAt: TEST_TIMESTAMP,
            summary: "Synthetic timeout preserved the prior state."
          }
        ]
      },
      {
        capability: "single-image-input" as const,
        scope,
        state: "supported" as const,
        evidence: [
          {
            source: "successful-request" as const,
            observedAt: TEST_TIMESTAMP,
            summary: "Synthetic request succeeded."
          }
        ],
        verifiedAt: TEST_TIMESTAMP
      },
      {
        capability: "single-image-input" as const,
        scope,
        state: "unsupported" as const,
        evidence: [
          {
            source: "protocol-rejection" as const,
            observedAt: TEST_TIMESTAMP,
            summary: "Synthetic stable rejection."
          }
        ],
        verifiedAt: TEST_TIMESTAMP
      },
      {
        capability: "single-image-input" as const,
        scope,
        state: "degraded" as const,
        evidence: [
          {
            source: "degraded-fallback" as const,
            observedAt: TEST_TIMESTAMP,
            summary: "Synthetic fallback is available."
          }
        ],
        verifiedAt: TEST_TIMESTAMP,
        degradedReason: "Previous output must be uploaded again."
      }
    ];

    for (const record of records) {
      expect(
        capabilityProbeResultSchema.parse({
          schemaVersion: 1,
          providerId: "provider-a",
          model: "gpt-image-2",
          status: "completed",
          record,
          mayHaveBilled: record.state !== "unknown"
        }).record.state
      ).toBe(record.state);
    }
  });
});

describe("separate Studio operation registry", () => {
  it("keeps the seven public operations and MCP tool names frozen", () => {
    expect(routegoOperationNames).toEqual([
      "status",
      "generate",
      "edit",
      "batch",
      "searchLibrary",
      "manageLibrary",
      "openStudio"
    ]);
    expect(Object.values(routegoOperationDefinitions).map((item) => item.toolName)).toEqual([
      "routego_status",
      "routego_generate",
      "routego_edit",
      "routego_batch",
      "routego_search_library",
      "routego_manage_library",
      "routego_open_studio"
    ]);
    expect(studioOperationNames).toEqual([
      "readSettings",
      "upsertProviderProfile",
      "removeProviderProfile",
      "setActiveProviderProfile",
      "refreshModels",
      "probeCapabilities"
    ]);
    expect(studioOperationNames.some((name) => routegoOperationNames.includes(name as never))).toBe(
      false
    );
    expect(Object.values(studioOperationDefinitions).every((item) => !("toolName" in item))).toBe(
      true
    );
  });

  it("validates Studio inputs and outputs through their exact shared definitions", () => {
    expect(parseStudioOperationInput("readSettings", {})).toEqual({ schemaVersion: 1 });

    expect(
      parseStudioOperationOutput("readSettings", {
        schemaVersion: 1,
        activeProviderId: "provider-a",
        profiles: [profile],
        defaults,
        outputDirectory: { configured: false }
      })
    ).toMatchObject({ activeProviderId: "provider-a" });
    expect(() =>
      parseStudioOperationInput("probeCapabilities", {
        providerId: "provider-a",
        model: "gpt-image-2",
        capability: "single-image-input",
        transport: "single-endpoint-json",
        requestShape: "single-endpoint-json:image"
      })
    ).toThrow();
  });
});
