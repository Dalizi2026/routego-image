import { describe, expect, it } from "vitest";

import type {
  ProviderProfileDescriptor,
  ReadSettingsResult,
  RefreshModelsResult
} from "@routego-image/contracts";

import {
  SettingsFormError,
  activeSettingsProfile,
  buildCapabilityProbeInput,
  buildDefaultsSettingsInput,
  buildOutputDirectorySettingsInput,
  buildUpsertProviderProfileInput,
  clearApiKeyDraft,
  clearOutputDirectorySensitiveDraft,
  createOutputDirectoryDraft,
  createProviderProfileDraft,
  mergeActiveProviderProfile,
  mergeRefreshedModels,
  mergeRemovedProviderProfile,
  mergeUpsertProviderProfile
} from "../src/features/settings";

const endpoint = {
  mode: "exact-generation-endpoint" as const,
  origin: "https://relay.example.invalid",
  pathname: "/v1/images/generations",
  hasQuery: false,
  display: "https://relay.example.invalid/v1/images/generations"
};

const profile: ProviderProfileDescriptor = {
  id: "provider-a",
  name: "Synthetic relay A",
  endpoints: { generation: endpoint },
  defaultModel: "synthetic-image-model",
  models: ["synthetic-image-model"],
  hasApiKey: true,
  apiKeyPreview: "synthetic-present",
  isActive: true,
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z"
};

const settings: ReadSettingsResult = {
  schemaVersion: 1,
  activeProviderId: profile.id,
  profiles: [profile],
  defaults: {
    model: "synthetic-image-model",
    size: "auto",
    aspectRatio: "auto",
    quality: "auto",
    format: "png",
    count: 1,
    partialImages: 0,
    transparentMode: "off",
    moderation: "auto",
    saveToLibrary: true
  },
  outputDirectory: { configured: true, display: "Pictures/routego-image" }
};

describe("secret-safe Settings state and request construction", () => {
  it("never hydrates an existing secret and requires re-entry for hidden endpoint queries", () => {
    const hiddenQueryProfile: ProviderProfileDescriptor = {
      ...profile,
      endpoints: {
        generation: {
          ...endpoint,
          hasQuery: true,
          display: `${endpoint.display}?[REDACTED]`
        }
      }
    };
    const draft = createProviderProfileDraft(hiddenQueryProfile);
    expect(draft).toMatchObject({
      profileId: profile.id,
      generation: { value: "", requiresReentry: true },
      apiKeyOperation: "unchanged",
      apiKeyReplacement: ""
    });
    expect(JSON.stringify(draft)).not.toContain(profile.apiKeyPreview);
    expect(() => buildUpsertProviderProfileInput(draft)).toThrow(SettingsFormError);
  });

  it("submits write-only replacement once and clears it before any retry", () => {
    const replacement = "synthetic-one-shot-secret";
    const draft = {
      ...createProviderProfileDraft(profile),
      apiKeyOperation: "replace" as const,
      apiKeyReplacement: replacement
    };
    expect(buildUpsertProviderProfileInput(draft)).toMatchObject({
      profileId: profile.id,
      apiKey: { operation: "replace", value: replacement }
    });
    const cleared = clearApiKeyDraft(draft);
    expect(cleared).toMatchObject({ apiKeyOperation: "unchanged", apiKeyReplacement: "" });
    expect(JSON.stringify(cleared)).not.toContain(replacement);

    expect(
      buildUpsertProviderProfileInput({
        ...createProviderProfileDraft(profile),
        apiKeyOperation: "unchanged"
      }).apiKey
    ).toEqual({ operation: "unchanged" });
    expect(
      buildUpsertProviderProfileInput({
        ...createProviderProfileDraft(profile),
        apiKeyOperation: "clear"
      }).apiKey
    ).toEqual({ operation: "clear" });
  });

  it("merges create, remove, active selection, and non-billable model refresh results", () => {
    const created = { ...profile, id: "provider-b", name: "Synthetic relay B", isActive: false };
    const afterCreate = mergeUpsertProviderProfile(settings, {
      schemaVersion: 1,
      profile: created,
      activeProviderId: profile.id
    });
    expect(afterCreate.profiles.map((item) => item.id)).toEqual(["provider-a", "provider-b"]);

    const activated = mergeActiveProviderProfile(afterCreate, {
      schemaVersion: 1,
      activeProviderId: created.id,
      profile: { ...created, isActive: true }
    });
    expect(activeSettingsProfile(activated)?.id).toBe(created.id);
    expect(activated.profiles.find((item) => item.id === profile.id)?.isActive).toBe(false);

    const refreshedResult: RefreshModelsResult = {
      schemaVersion: 1,
      providerId: created.id,
      status: "succeeded",
      billable: false,
      models: ["synthetic-image-model-v2"],
      refreshedAt: "2026-07-18T00:05:00.000Z"
    };
    const refreshed = mergeRefreshedModels(activated, refreshedResult);
    expect(refreshed.profiles.find((item) => item.id === created.id)?.models).toEqual([
      "synthetic-image-model-v2"
    ]);

    const removed = mergeRemovedProviderProfile(refreshed, {
      schemaVersion: 1,
      removedProfileId: profile.id,
      activeProviderId: created.id
    });
    expect(removed.profiles.map((item) => item.id)).toEqual([created.id]);
  });

  it("builds complete defaults and all distinct output-directory operations", () => {
    expect(buildDefaultsSettingsInput({ ...settings.defaults, quality: "high", count: 2 }))
      .toMatchObject({ defaults: { quality: "high", count: 2, saveToLibrary: true } });

    for (const operation of ["unchanged", "default", "clear"] as const) {
      expect(
        buildOutputDirectorySettingsInput({ operation, path: "", confirmLocalPath: false })
      ).toEqual({ schemaVersion: 1, outputDirectory: { operation } });
    }
    const candidatePath = "/synthetic/routego-output";
    const replacement = {
      operation: "replace" as const,
      path: candidatePath,
      confirmLocalPath: true
    };
    expect(buildOutputDirectorySettingsInput(replacement)).toMatchObject({
      outputDirectory: { operation: "replace", confirmLocalPath: true }
    });
    const cleared = clearOutputDirectorySensitiveDraft(replacement);
    expect(cleared).toEqual(createOutputDirectoryDraft());
    expect(JSON.stringify(cleared)).not.toContain(candidatePath);
  });

  it("separates non-billable refresh from explicitly confirmed probe input", () => {
    const base = {
      providerId: profile.id,
      model: "synthetic-image-model",
      capability: "target-edit" as const,
      transport: "openai-images" as const,
      requestShape: "images:edit-target",
      confirmBillableProbe: false
    };
    expect(() => buildCapabilityProbeInput(base)).toThrow(/确认/u);
    expect(buildCapabilityProbeInput({ ...base, confirmBillableProbe: true })).toMatchObject({
      providerId: profile.id,
      capability: "target-edit",
      confirmBillableProbe: true
    });

    const failedRefresh: RefreshModelsResult = {
      schemaVersion: 1,
      providerId: profile.id,
      status: "failed",
      billable: false,
      models: [],
      error: {
        code: "timeout",
        category: "timeout",
        stage: "submit",
        safeMessage: "Synthetic model refresh timed out.",
        retryDisposition: "never",
        partialArtifacts: [],
        receivedAnyOutput: false,
        mayHaveBilled: false
      }
    };
    expect(mergeRefreshedModels(settings, failedRefresh)).toBe(settings);
  });
});
