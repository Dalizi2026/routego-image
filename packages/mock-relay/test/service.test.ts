import { describe, expect, it } from "vitest";

import {
  discardUploadResourceResultSchema,
  executeLibraryMutationResultSchema,
  finalizeUploadResourceResultSchema,
  getAssetDetailResultSchema,
  getUploadResourceStatusResultSchema,
  imageOperationResultSchema,
  parseStudioOperationOutput,
  parseRoutegoOperationOutput,
  preflightLibraryMutationResultSchema,
  readSettingsResultSchema,
  reserveUploadResourceResultSchema,
  routegoBatchResultSchema,
  studioBatchResultSchema,
  studioImageOperationResultSchema,
  studioLibrarySearchResultSchema,
  studioProviderSwitchResultSchema,
  updateSettingsResultSchema
} from "@routego-image/contracts";
import { createMockRoutegoService } from "../src/index";

function generateInput(overrides: Record<string, unknown> = {}) {
  return {
    kind: "generate" as const,
    prompt: "离线合成提示 🚀\nline two",
    ...overrides
  };
}

function studioGenerateInput(overrides: Record<string, unknown> = {}) {
  return {
    kind: "generate" as const,
    prompt: "Synthetic path-free Studio generate",
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

  it("marks a degraded generation explicitly while keeping a valid success result", async () => {
    const result = await createMockRoutegoService({ fixture: "degraded" }).generate(
      generateInput()
    );
    expect(result.status).toBe("succeeded");
    expect(result.execution.degradedContinuation).toBe(true);
    expect(imageOperationResultSchema.parse(result)).toEqual(result);
  });

  it("exposes invalid-output only so a transport boundary can fail closed", async () => {
    const service = createMockRoutegoService({ fixture: "invalid-output" });
    const output = await service.generate(generateInput());
    expect(() => parseRoutegoOperationOutput("generate", output)).toThrow();
  });

  it("preserves ordered batch identities and explicit per-item partial outcomes", async () => {
    const service = createMockRoutegoService({ fixture: "partial" });
    const result = await service.batch({
      tasks: [
        { id: "task-first", operation: generateInput({ count: 2 }) },
        { id: "task-second", operation: generateInput() }
      ]
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
    expect(search.items.map((item) => item.status)).toEqual(["partial", "succeeded"]);
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

  it("provides active generation-only Library fixtures and relative browser resources", async () => {
    const service = createMockRoutegoService({ fixture: "degraded" });
    const folders = await service.listFolders({ includeDeleted: true });
    const detail = await service.getAssetDetail({ assetId: "mock-asset-output" });
    const resource = await service.getBrowserResource({ assetId: "mock-asset-output" });

    expect(folders.folders.map((folder) => folder.state)).toEqual(["active", "active"]);
    expect(getAssetDetailResultSchema.parse(detail).asset?.relationships.map((item) => item.role)).toEqual([
      "output"
    ]);
    expect(detail.asset?.execution.degradedContinuation).toBe(true);
    expect(resource.resource?.relativeUrl).toMatch(/^\/api\/v1\/library\/resources\//u);
    expect(resource.resource?.requiresSession).toBe(true);
    expect(JSON.stringify({ detail, resource })).not.toContain("C:\\");
    expect(JSON.stringify({ detail, resource })).not.toContain("/Users/");
  });

  it("keeps the deterministic Library detail primary aligned with its seeded output rendition", async () => {
    const detail = await createMockRoutegoService().getAssetDetail({
      assetId: "mock-asset-output"
    });
    const parsed = getAssetDetailResultSchema.parse(detail);

    expect(parsed.status).toBe("succeeded");
    expect(parsed.asset).toBeDefined();
    const asset = parsed.asset!;
    expect(asset.primaryArtifactId).toBe(asset.renditions[0]!.artifactId);
    expect(asset.relationships.find((relationship) => relationship.role === "output")?.artifactId).toBe(
      asset.primaryArtifactId
    );
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

describe("deterministic non-empty Studio gallery", () => {
  it("keeps stable filtering, sorting, and pagination for generation-only Library fixtures", async () => {
    const firstService = createMockRoutegoService();
    const secondService = createMockRoutegoService();
    const firstPage = await firstService.searchStudioLibrary({ limit: 1 });
    const repeatedPage = await secondService.searchStudioLibrary({ limit: 1 });
    expect(firstPage).toEqual(repeatedPage);
    expect(studioLibrarySearchResultSchema.parse(firstPage)).toEqual(firstPage);
    expect(firstPage.items.map((item) => item.assetId)).toEqual(["mock-asset-output"]);
    expect(firstPage.nextCursor).toBe("mock-cursor:1");

    const secondPage = await firstService.searchStudioLibrary({
      limit: 1,
      cursor: firstPage.nextCursor
    });
    expect(secondPage.items.map((item) => item.assetId)).toEqual([
      "mock-asset-generate-success"
    ]);

    const all = await firstService.searchStudioLibrary({ limit: 10 });
    expect(all.total).toBe(2);
    expect(all.items.map((item) => item.status)).toEqual(["partial", "succeeded"]);

    const filters = await Promise.all([
      firstService.searchStudioLibrary({ query: "astronaut" }),
      firstService.searchStudioLibrary({ kinds: ["generate"] }),
      firstService.searchStudioLibrary({ folderIds: ["mock-folder-secondary"] }),
      firstService.searchStudioLibrary({ sizes: ["1536x1024"] })
    ]);
    expect(filters.map((result) => result.items.map((item) => item.assetId))).toEqual([
      ["mock-asset-generate-success"],
      ["mock-asset-output", "mock-asset-generate-success"],
      ["mock-asset-output"],
      ["mock-asset-output"]
    ]);
  });

  it("aligns search IDs with detail, relationships, and protected resources", async () => {
    const service = createMockRoutegoService();
    const search = await service.searchStudioLibrary({ kinds: ["generate"], sizes: ["1536x1024"] });
    const item = search.items[0]!;
    const detail = await service.getAssetDetail({ assetId: item.assetId });
    const resource = await service.getBrowserResource({
      assetId: item.assetId,
      artifactId: item.artifactId,
      rendition: "preview"
    });
    expect(getAssetDetailResultSchema.parse(detail).asset?.renditions[0]?.artifactId).toBe(
      item.artifactId
    );
    expect(detail.asset?.relationships.map((relationship) => relationship.role)).toEqual(["output"]);
    expect(resource.resource?.relativeUrl).toMatch(/^\/api\/v1\/library\/resources\//u);
    const serialized = JSON.stringify(search);
    expect(serialized).not.toContain('"path"');
    expect(serialized).not.toMatch(/(?:C:\\|\/Users\/|data:image|base64)/u);
  });
});

describe("stateful synthetic upload lifecycle", () => {
  it("finalizes image uploads until explicit discard without attaching them to Studio generation", async () => {
    const service = createMockRoutegoService();
    const reserved = await service.reserveUploadResource({
      purpose: "reference",
      declaredMimeType: "image/png",
      declaredByteLength: 68,
      expectedSha256: "a".repeat(64)
    });
    const uploadResourceId = reserved.resource!.uploadResourceId;
    expect(reserveUploadResourceResultSchema.parse(reserved)).toMatchObject({
      status: "succeeded",
      resource: { reusePolicy: "reusable-until-expiry" }
    });

    const finalized = await service.finalizeUploadResource({ uploadResourceId });
    expect(finalizeUploadResourceResultSchema.parse(finalized)).toMatchObject({
      status: "succeeded",
      resource: {
        status: "finalized",
        finalized: { detectedMimeType: "image/png", sha256: "a".repeat(64) }
      }
    });

    expect((await service.studioGenerate(studioGenerateInput())).status).toBe("succeeded");
    expect(
      getUploadResourceStatusResultSchema.parse(
        await service.getUploadResourceStatus({ uploadResourceId })
      ).resource?.status
    ).toBe("finalized");

    const discarded = await service.discardUploadResource({ uploadResourceId });
    expect(discardUploadResourceResultSchema.parse(discarded).resource?.status).toBe("discarded");
    expect(await service.finalizeUploadResource({ uploadResourceId })).toMatchObject({
      status: "failed",
      error: { code: "upload_discarded" }
    });
  });

  it.each([
    ["expired", "upload_expired"],
    ["invalid-type", "upload_invalid_type"],
    ["oversize", "upload_oversize"],
    ["checksum-failed", "upload_checksum_failed"],
    ["consumed", "upload_consumed"],
    ["discarded", "upload_discarded"]
  ] as const)("returns structured %s finalization failure", async (fixture, code) => {
    const service = createMockRoutegoService({
      fixtureByOperation: { finalizeUploadResource: fixture }
    });
    const reserved = await service.reserveUploadResource({
      purpose: fixture === "consumed" ? "zip-import" : "image",
      declaredMimeType: fixture === "consumed" ? "application/zip" : "image/png",
      declaredByteLength: 68
    });
    const result = await service.finalizeUploadResource({
      uploadResourceId: reserved.resource!.uploadResourceId
    });
    expect(finalizeUploadResourceResultSchema.parse(result)).toMatchObject({
      status: "failed",
      error: { code }
    });
  });

  it("reports not-found, oversize reservation, and expired status without paths", async () => {
    const service = createMockRoutegoService();
    expect(await service.finalizeUploadResource({ uploadResourceId: "missing-upload" })).toMatchObject({
      status: "failed",
      error: { code: "not_found" }
    });
    expect(
      await service.reserveUploadResource({
        purpose: "image",
        declaredMimeType: "image/png",
        declaredByteLength: 52_428_801
      })
    ).toMatchObject({ status: "failed", error: { code: "upload_oversize" } });

    const expiring = createMockRoutegoService({
      fixtureByOperation: { getUploadResourceStatus: "expired" }
    });
    const reserved = await expiring.reserveUploadResource({
      purpose: "image",
      declaredMimeType: "image/png",
      declaredByteLength: 68
    });
    const status = await expiring.getUploadResourceStatus({
      uploadResourceId: reserved.resource!.uploadResourceId
    });
    expect(status).toMatchObject({ status: "failed", error: { code: "upload_expired" } });
    expect(JSON.stringify(status)).not.toMatch(/(?:C:\\|\/Users\/|data:image|base64)/u);
  });

  it("consumes a finalized ZIP exactly once through Library import", async () => {
    const service = createMockRoutegoService();
    const reserved = await service.reserveUploadResource({
      purpose: "zip-import",
      declaredMimeType: "application/zip",
      declaredByteLength: 256
    });
    const uploadResourceId = reserved.resource!.uploadResourceId;
    await service.finalizeUploadResource({ uploadResourceId });
    const preflight = await service.preflightLibraryMutation({
      mutation: { action: "import-zip", uploadResourceId }
    });
    expect(preflight).toMatchObject({ status: "ready", requiredConfirmations: ["zip-import"] });
    const imported = await service.executeLibraryMutation({
      preflightId: preflight.preflightId,
      action: "import-zip",
      confirmations: ["zip-import"]
    });
    expect(imported).toMatchObject({
      status: "succeeded",
      importedCount: 1,
      skippedCount: 0
    });
    expect(
      (await service.getUploadResourceStatus({ uploadResourceId })).resource?.status
    ).toBe("consumed");
    expect(await service.finalizeUploadResource({ uploadResourceId })).toMatchObject({
      status: "failed",
      error: { code: "upload_consumed" }
    });

    const repeated = await service.preflightLibraryMutation({
      mutation: { action: "import-zip", uploadResourceId }
    });
    expect(repeated).toMatchObject({
      status: "blocked",
      items: [{ eligible: false, error: { code: "conflict" } }]
    });
  });
});

describe("path-free Studio creation mock outcomes", () => {
  it("returns success, partial batch, degraded generation, and capability failure", async () => {
    const success = await createMockRoutegoService().studioGenerate(studioGenerateInput());
    expect(studioImageOperationResultSchema.parse(success).status).toBe("succeeded");

    const partialService = createMockRoutegoService({
      fixtureByOperation: { studioBatch: "partial" }
    });
    const batch = await partialService.studioBatch({
      tasks: [
        { id: "studio-task-generate", operation: studioGenerateInput() },
        { id: "studio-task-generate-second", operation: studioGenerateInput() }
      ]
    });
    expect(studioBatchResultSchema.parse(batch)).toMatchObject({ status: "partial" });
    expect(batch.items.map((item) => item.result.status)).toEqual(["succeeded", "failed"]);

    const degraded = await createMockRoutegoService({
      fixtureByOperation: { studioGenerate: "degraded" }
    }).studioGenerate(studioGenerateInput());
    expect(degraded).toMatchObject({
      status: "succeeded",
      execution: { degradedContinuation: true }
    });

    const failed = await createMockRoutegoService({
      fixtureByOperation: { studioGenerate: "failure" }
    }).studioGenerate(studioGenerateInput());
    expect(failed).toMatchObject({
      status: "failed",
      error: { code: "capability_unavailable" }
    });

    const serialized = JSON.stringify({ success, batch, degraded, failed });
    expect(serialized).not.toContain('"path"');
    expect(serialized).not.toMatch(/(?:C:\\|\/Users\/|data:image|base64|Authorization)/u);
  });
});

describe("stateful synthetic settings mutation", () => {
  it("switches the active provider for future Studio submissions only", async () => {
    const service = createMockRoutegoService();
    const switched = await service.studioProviderSwitch({
      profileId: "mock-provider",
      preferredModel: "mock-image-model"
    });

    expect(studioProviderSwitchResultSchema.parse(switched)).toMatchObject({
      status: "succeeded",
      activeProviderId: "mock-provider",
      selectedModel: "mock-image-model",
      modelPreserved: true,
      appliesToFutureSubmissionsOnly: true
    });
  });

  it("reflects defaults and every output-directory operation in later reads", async () => {
    const service = createMockRoutegoService();
    const initial = await service.readSettings({});
    const replacementPath = "C:\\Users\\Synthetic User\\Pictures\\routego-image";
    const replaced = await service.updateSettings({
      defaults: { ...initial.defaults, quality: "high", count: 2 },
      outputDirectory: {
        operation: "replace",
        path: replacementPath,
        confirmLocalPath: true
      }
    });
    expect(updateSettingsResultSchema.parse(replaced)).toMatchObject({
      defaults: { quality: "high", count: 2 },
      outputDirectory: { configured: true }
    });
    expect(JSON.stringify(replaced)).not.toContain(replacementPath);
    expect(await service.readSettings({})).toEqual(replaced);

    const unchanged = await service.updateSettings({
      outputDirectory: { operation: "unchanged" }
    });
    expect(unchanged.outputDirectory).toEqual(replaced.outputDirectory);

    const cleared = await service.updateSettings({ outputDirectory: { operation: "clear" } });
    expect(cleared.outputDirectory).toEqual({ configured: false });

    const defaulted = await service.updateSettings({ outputDirectory: { operation: "default" } });
    expect(defaulted.outputDirectory).toEqual({
      configured: true,
      display: "Default Pictures/routego-image"
    });
    expect(readSettingsResultSchema.parse(await service.readSettings({}))).toEqual(defaulted);
  });
});
