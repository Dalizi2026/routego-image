import { describe, expect, it } from "vitest";

import {
  capabilityProbeResultSchema,
  executeLibraryMutationResultSchema,
  getAssetDetailResultSchema,
  imageOperationResultSchema,
  parseStudioOperationOutput,
  parseRoutegoOperationOutput,
  preflightLibraryMutationResultSchema,
  readSettingsResultSchema,
  routegoBatchResultSchema
} from "@routego-image/contracts";
import { createMockRoutegoService } from "../src/index";

function generateInput(overrides: Record<string, unknown> = {}) {
  return {
    kind: "generate" as const,
    prompt: "离线合成提示 🚀\nline two",
    ...overrides
  };
}

function editInput(overrides: Record<string, unknown> = {}) {
  return {
    kind: "edit" as const,
    prompt: "离线编辑提示 🎨",
    targetImage: { path: "/synthetic/target image.png" },
    invariants: { preserve: ["subject and composition"] },
    ...overrides
  };
}

describe("deterministic mock application service", () => {
  it("returns stable schema-valid success for the same fixture and request", async () => {
    const service = createMockRoutegoService({ fixture: "success" });
    const first = await service.generate(generateInput());
    const second = await service.generate(generateInput());

    expect(first).toEqual(second);
    expect(imageOperationResultSchema.parse(first)).toEqual(first);
    expect(first).toMatchObject({
      status: "succeeded",
      execution: {
        transport: "single-endpoint-json",
        attemptCount: 1,
        providerRequestCount: 1,
        receivedAnyOutput: true,
        mayHaveBilled: true
      }
    });
    expect(first.finalArtifacts).toHaveLength(1);
  });

  it("returns a structured failure without false success", async () => {
    const result = await createMockRoutegoService({ fixture: "failure" }).generate(
      generateInput()
    );
    expect(result.status).toBe("failed");
    expect(result.finalArtifacts).toEqual([]);
    expect(result.error).toMatchObject({
      code: "capability_unavailable",
      receivedAnyOutput: false,
      mayHaveBilled: false
    });
    expect(imageOperationResultSchema.parse(result)).toEqual(result);
  });

  it("represents partial output with billing risk and no automatic retry disposition", async () => {
    const result = await createMockRoutegoService({ fixture: "partial" }).generate(
      generateInput()
    );
    expect(result).toMatchObject({
      status: "partial",
      execution: { receivedAnyOutput: true, mayHaveBilled: true },
      error: { retryDisposition: "never", receivedAnyOutput: true, mayHaveBilled: true }
    });
    expect(result.partialArtifacts).toHaveLength(1);
    expect(result.failedSlots).toHaveLength(1);
    expect(imageOperationResultSchema.parse(result)).toEqual(result);
  });

  it("marks degraded continuation explicitly while keeping a valid success result", async () => {
    const result = await createMockRoutegoService({ fixture: "degraded" }).edit(editInput());
    expect(result.status).toBe("succeeded");
    expect(result.execution.degradedContinuation).toBe(true);
    expect(imageOperationResultSchema.parse(result)).toEqual(result);
  });

  it("exposes invalid-output only so a transport boundary can fail closed", async () => {
    const service = createMockRoutegoService({ fixture: "invalid-output" });
    const output = await service.generate(generateInput());
    expect(() => parseRoutegoOperationOutput("generate", output)).toThrow();
  });

  it("parses generate and edit with their dedicated schemas", async () => {
    const service = createMockRoutegoService();
    await expect(service.generate(editInput())).rejects.toThrow(/kind=generate/u);
    await expect(service.edit(generateInput())).rejects.toThrow(/kind=edit/u);
  });

  it("preserves ordered batch identities and explicit per-item partial outcomes", async () => {
    const service = createMockRoutegoService({ fixture: "partial" });
    const result = await service.batch({
      tasks: [
        { id: "task-first", operation: generateInput({ count: 2 }) },
        { id: "task-second", operation: editInput() }
      ],
      concurrency: 2
    });

    expect(routegoBatchResultSchema.parse(result)).toEqual(result);
    expect(result.status).toBe("partial");
    expect(result.items.map((item) => item.id)).toEqual(["task-first", "task-second"]);
    expect(result.items[0]?.result.status).toBe("succeeded");
    expect(result.items[1]?.result.status).toBe("failed");
  });

  it("keeps non-image operations deterministic and synthetic", async () => {
    const service = createMockRoutegoService({ requestId: "mock-request-fixed" });
    const status = await service.status({ refreshCapabilities: false, confirmBillableProbe: false });
    const search = await service.searchLibrary({});
    const manage = await service.manageLibrary({ action: "create-folder", name: "离线收藏夹" });
    const studio = await service.openStudio({ reuseExisting: true, address: "127.0.0.1" });

    expect(status.apiKeyPreview).toBe("mock-present");
    expect(status.endpoint?.display).not.toContain("token=");
    expect(search.items).toEqual([]);
    expect(manage.affectedFolderIds).toEqual(["mock-folder"]);
    expect(studio.url).toBe("http://127.0.0.1:43119/?token=mock-session-token");
  });

  it("returns deterministic redacted settings and write-only profile updates", async () => {
    const service = createMockRoutegoService();
    const first = await service.readSettings({});
    const second = await service.readSettings({});
    expect(first).toEqual(second);
    expect(readSettingsResultSchema.parse(first)).toEqual(first);
    expect(first.profiles[0]).toMatchObject({ hasApiKey: true, apiKeyPreview: "mock-present" });

    const replacement = "synthetic-replacement-value";
    const updated = await service.upsertProviderProfile({
      name: "Updated synthetic relay",
      endpoints: {
        generation: {
          mode: "exact-generation-endpoint",
          value: "https://mock.invalid/v1/images/generations"
        }
      },
      apiKey: { operation: "replace", value: replacement },
      setActive: true
    });
    expect(updated.profile).toMatchObject({ hasApiKey: true, isActive: true });
    expect(JSON.stringify(updated)).not.toContain(replacement);

    const cleared = await service.upsertProviderProfile({
      profileId: updated.profile.id,
      name: "Updated synthetic relay",
      endpoints: {
        generation: {
          mode: "exact-generation-endpoint",
          value: "https://mock.invalid/v1/images/generations"
        }
      },
      apiKey: { operation: "clear" }
    });
    expect(cleared.profile).toMatchObject({ hasApiKey: false });
    expect(cleared.profile).not.toHaveProperty("apiKeyPreview");
  });

  it("models supported, failed, and degraded capability probes without real requests", async () => {
    const input = {
      providerId: "mock-provider",
      model: "mock-image-model",
      capability: "single-image-input" as const,
      transport: "single-endpoint-json" as const,
      requestShape: "single-endpoint-json:image",
      confirmBillableProbe: true as const
    };
    const supported = await createMockRoutegoService({ fixture: "success" }).probeCapabilities(
      input
    );
    const failed = await createMockRoutegoService({ fixture: "failure" }).probeCapabilities(input);
    const degraded = await createMockRoutegoService({ fixture: "degraded" }).probeCapabilities(
      input
    );

    expect(capabilityProbeResultSchema.parse(supported).record.state).toBe("supported");
    expect(capabilityProbeResultSchema.parse(failed)).toMatchObject({
      status: "failed",
      record: { state: "unknown" },
      error: { code: "timeout" }
    });
    expect(capabilityProbeResultSchema.parse(degraded)).toMatchObject({
      status: "completed",
      record: { state: "degraded" }
    });
  });

  it("provides synthetic folders, full relationships, and relative browser resources", async () => {
    const service = createMockRoutegoService({ fixture: "degraded" });
    const folders = await service.listFolders({ includeDeleted: true });
    const detail = await service.getAssetDetail({ assetId: "mock-asset-output" });
    const resource = await service.getBrowserResource({ assetId: "mock-asset-output" });

    expect(folders.folders.map((folder) => folder.state)).toEqual(["active", "deleted"]);
    expect(getAssetDetailResultSchema.parse(detail).asset?.relationships.map((item) => item.role)).toEqual([
      "source",
      "target",
      "reference",
      "supporting",
      "mask",
      "output"
    ]);
    expect(detail.asset?.execution.degradedContinuation).toBe(true);
    expect(resource.resource?.relativeUrl).toMatch(/^\/api\/v1\/library\/resources\//u);
    expect(resource.resource?.requiresSession).toBe(true);
    expect(JSON.stringify({ detail, resource })).not.toContain("C:\\");
    expect(JSON.stringify({ detail, resource })).not.toContain("/Users/");
  });

  it("preserves per-item partial mutation outcomes from a deterministic preflight", async () => {
    const service = createMockRoutegoService({
      fixtureByOperation: {
        preflightLibraryMutation: "partial",
        executeLibraryMutation: "partial"
      }
    });
    const preflight = await service.preflightLibraryMutation({
      mutation: { action: "permanent-delete", assetIds: ["mock-asset-a", "mock-asset-b"] }
    });
    expect(preflightLibraryMutationResultSchema.parse(preflight)).toMatchObject({
      status: "partial",
      requiredConfirmations: ["permanent-delete"]
    });
    expect(preflight.items.map((item) => item.eligible)).toEqual([true, false]);

    const result = await service.executeLibraryMutation({
      preflightId: preflight.preflightId,
      action: "permanent-delete",
      confirmations: ["permanent-delete"]
    });
    expect(executeLibraryMutationResultSchema.parse(result)).toMatchObject({ status: "partial" });
    expect(result.items.map((item) => item.status)).toEqual(["succeeded", "failed"]);
  });

  it("returns structured local-service failures and exposes invalid-output for boundary tests", async () => {
    await expect(
      createMockRoutegoService({ fixtureByOperation: { readSettings: "failure" } }).readSettings({})
    ).rejects.toMatchObject({ code: "not_found", receivedAnyOutput: false });

    const missing = await createMockRoutegoService({
      fixtureByOperation: { getAssetDetail: "failure" }
    }).getAssetDetail({ assetId: "mock-missing" });
    expect(missing).toMatchObject({ status: "failed", error: { code: "not_found" } });

    const invalid = await createMockRoutegoService({
      fixtureByOperation: { getBrowserResource: "invalid-output" }
    }).getBrowserResource({ assetId: "mock-asset" });
    expect(() => parseStudioOperationOutput("getBrowserResource", invalid)).toThrow();
  });
});
