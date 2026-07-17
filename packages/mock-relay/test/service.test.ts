import { describe, expect, it } from "vitest";

import {
  imageOperationResultSchema,
  parseRoutegoOperationOutput,
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
});
