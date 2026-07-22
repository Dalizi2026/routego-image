import { describe, expect, it } from "vitest";

import {
  parseStudioOperationInput,
  parseStudioOperationOutput,
  routegoOperationDefinitions,
  routegoOperationNames,
  studioBatchInputSchema,
  studioBatchResultSchema,
  studioEditInputSchema,
  studioGenerateInputSchema,
  studioImageOperationEventSchema,
  studioImageOperationResultSchema,
  studioOperationDefinitions,
  studioServiceErrorSchema,
  type StudioImageArtifact,
  type StudioImageOperationRequest,
  type StudioImageOperationResult
} from "../src/index";
import { TEST_TIMESTAMP } from "./fixtures";

const EXPIRES_AT = "2026-07-17T12:39:56.000Z";

function resource(resourceId: string) {
  return {
    resourceId,
    relativeUrl: `/api/v1/resources/${resourceId}`,
    requiresSession: true as const,
    mimeType: "image/png" as const,
    byteLength: 68,
    width: 1,
    height: 1,
    etag: `etag-${resourceId}`,
    expiresAt: EXPIRES_AT
  };
}

function artifact(
  artifactId: string,
  phase: "partial" | "final" = "final"
): StudioImageArtifact {
  return {
    artifactId,
    assetId: `asset-${artifactId}`,
    slot: 0,
    phase,
    resource: resource(`resource-${artifactId}`),
    createdAt: TEST_TIMESTAMP
  };
}

function generateRequest(
  overrides: Record<string, unknown> = {}
): StudioImageOperationRequest {
  return studioGenerateInputSchema.parse({
    kind: "generate",
    prompt: "生成路径安全的宇航猫 🚀",
    ...overrides
  });
}

function execution(overrides: Record<string, unknown> = {}) {
  return {
    transport: "single-endpoint-json" as const,
    attemptCount: 1,
    providerRequestCount: 1,
    receivedAnyOutput: true,
    mayHaveBilled: true,
    degradedContinuation: false,
    providerImageIds: [],
    ...overrides
  };
}

function successResult(
  request: StudioImageOperationRequest = generateRequest(),
  overrides: Record<string, unknown> = {}
): StudioImageOperationResult {
  const finalArtifact = artifact("artifact-final");
  return studioImageOperationResultSchema.parse({
    schemaVersion: 1,
    requestId: "studio-request-success",
    status: "succeeded",
    requestedParams: request,
    effectiveParams: request,
    execution: execution(),
    finalArtifacts: [finalArtifact],
    partialArtifacts: [],
    failedSlots: [],
    relationships: [
      {
        role: "output",
        outputArtifactId: finalArtifact.artifactId,
        order: 0
      }
    ],
    ...overrides
  });
}

function failureError(overrides: Record<string, unknown> = {}) {
  return studioServiceErrorSchema.parse({
    code: "capability_unavailable",
    category: "capability",
    stage: "route",
    safeMessage: "The synthetic provider cannot accept the request.",
    retryDisposition: "user-confirmation",
    partialArtifacts: [],
    receivedAnyOutput: false,
    mayHaveBilled: false,
    ...overrides
  });
}

function failedResult(request: StudioImageOperationRequest): StudioImageOperationResult {
  const error = failureError();
  return studioImageOperationResultSchema.parse({
    schemaVersion: 1,
    requestId: "studio-request-failed",
    status: "failed",
    requestedParams: request,
    effectiveParams: request,
    execution: {
      attemptCount: 0,
      providerRequestCount: 0,
      receivedAnyOutput: false,
      mayHaveBilled: false,
      degradedContinuation: false,
      providerImageIds: []
    },
    finalArtifacts: [],
    partialArtifacts: [],
    failedSlots: [],
    relationships: [],
    error
  });
}

describe("text-only Studio generation contracts", () => {
  it("accepts non-empty text-only requests with the five approved control groups", () => {
    const request = generateRequest({
      size: "1024x1024",
      aspectRatio: "auto",
      format: "png",
      count: 2,
      transparentMode: "auto",
      saveToLibrary: true
    });
    expect(request).toMatchObject({
      kind: "generate",
      prompt: "生成路径安全的宇航猫 🚀",
      size: "1024x1024",
      format: "png",
      count: 2,
      transparentMode: "auto",
      saveToLibrary: true
    });
    expect(request).not.toHaveProperty("references");
    expect(request).not.toHaveProperty("quality");
    expect(request).not.toHaveProperty("compression");
    expect(request).not.toHaveProperty("partialImages");
    expect(request).not.toHaveProperty("moderation");
    expect(request).not.toHaveProperty("outputDir");
  });

  it("rejects image locators, edit fields, and removed advanced workbench controls", () => {
    for (const overrides of [
      { references: [{ image: { source: "asset", assetId: "asset-a" }, role: "style" }] },
      { quality: "high" },
      { compression: 80, format: "jpeg" },
      { partialImages: 1 },
      { moderation: "low" },
      { action: "generate" },
      { previousResponseId: "resp-1" },
      { imageIds: ["img-1"] },
      { fileIds: ["file-1"] },
      { outputDir: "C:\\\\Users\\\\person\\\\Pictures" },
      { target: { source: "asset", assetId: "asset-target" } },
      { mask: { image: { source: "upload", uploadResourceId: "upload-mask" }, targetSlot: 0 } }
    ]) {
      expect(studioGenerateInputSchema.safeParse({ kind: "generate", prompt: "ok", ...overrides }).success).toBe(
        false
      );
    }
  });

  it("rejects transparency conflicts with JPEG or WebP rather than rewriting the contract", () => {
    expect(
      studioGenerateInputSchema.safeParse({
        kind: "generate",
        prompt: "transparent jpeg",
        format: "jpeg",
        transparentMode: "native"
      }).success
    ).toBe(false);
    expect(
      studioGenerateInputSchema.safeParse({
        kind: "generate",
        prompt: "transparent webp",
        format: "webp",
        transparentMode: "auto"
      }).success
    ).toBe(false);
    expect(
      studioGenerateInputSchema.parse({
        kind: "generate",
        prompt: "transparent png",
        format: "png",
        transparentMode: "native"
      }).transparentMode
    ).toBe("native");
  });

  it("rejects the removed studioEdit operation before any resource resolution", () => {
    expect(
      studioEditInputSchema.safeParse({
        kind: "edit",
        prompt: "edit me",
        target: { source: "asset", assetId: "asset-a" }
      }).success
    ).toBe(false);
    expect(studioEditInputSchema.safeParse({ kind: "edit" }).success).toBe(false);
  });
});

describe("path-free Studio generation results and events", () => {
  it("accepts protected browser artifacts without local paths", () => {
    const result = successResult();
    expect(result.finalArtifacts[0]?.resource.requiresSession).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/(?:filePath|"path"|C:\\|\/Users\/)/u);
    expect(
      studioImageOperationResultSchema.safeParse({
        ...result,
        finalArtifacts: [
          {
            ...result.finalArtifacts[0],
            resource: {
              ...result.finalArtifacts[0]!.resource,
              relativeUrl: "C:\\\\Users\\\\person\\\\image.png"
            }
          }
        ]
      }).success
    ).toBe(false);
  });

  it("preserves ordered started, partial, completed, and failed events", () => {
    const request = generateRequest();
    const partialArtifact = artifact("artifact-event-partial", "partial");
    const failed = failureError();
    const events = [
      {
        type: "started" as const,
        requestId: "studio-event-request",
        sequence: 0,
        occurredAt: TEST_TIMESTAMP,
        requestedParams: request
      },
      {
        type: "partial" as const,
        requestId: "studio-event-request",
        sequence: 1,
        occurredAt: TEST_TIMESTAMP,
        artifact: partialArtifact,
        receivedAnyOutput: true,
        mayHaveBilled: true
      },
      {
        type: "completed" as const,
        requestId: "studio-event-request",
        sequence: 2,
        occurredAt: TEST_TIMESTAMP,
        result: successResult(request)
      },
      {
        type: "failed" as const,
        requestId: "studio-event-request-failed",
        sequence: 0,
        occurredAt: TEST_TIMESTAMP,
        error: failed,
        receivedAnyOutput: false,
        mayHaveBilled: false
      }
    ];
    expect(events.map((event) => studioImageOperationEventSchema.parse(event).type)).toEqual([
      "started",
      "partial",
      "completed",
      "failed"
    ]);
    expect(
      studioImageOperationEventSchema.safeParse({
        ...events[3],
        receivedAnyOutput: true
      }).success
    ).toBe(false);
  });
});

describe("ordered path-free Studio batch contracts", () => {
  it("uses fixed concurrency two, preserves order, and derives succeeded/partial/failed", () => {
    const first = generateRequest({ prompt: "first", count: 1, size: "1024x1024" });
    const second = generateRequest({ prompt: "second", count: 2, aspectRatio: "1:1" });
    const input = studioBatchInputSchema.parse({
      tasks: [
        { id: "task-first", operation: first },
        { id: "task-second", operation: second }
      ]
    });
    expect(input.concurrency).toBe(2);
    expect(input.tasks.map((task) => task.id)).toEqual(["task-first", "task-second"]);
    expect(input.tasks[0]?.operation.format).toBe("png");
    expect(input.tasks[0]?.operation.count).toBe(1);
    expect(input.tasks[1]?.operation.count).toBe(2);

    const partial = studioBatchResultSchema.parse({
      schemaVersion: 1,
      requestId: "studio-batch-partial",
      status: "partial",
      concurrency: 2,
      taskIds: ["task-first", "task-second"],
      items: [
        { id: "task-first", result: successResult(first) },
        { id: "task-second", result: failedResult(second) }
      ]
    });
    expect(partial.items.map((item) => item.id)).toEqual(["task-first", "task-second"]);
    expect(
      studioBatchResultSchema.safeParse({
        ...partial,
        taskIds: ["task-second", "task-first"]
      }).success
    ).toBe(false);

    expect(
      studioBatchResultSchema.parse({
        schemaVersion: 1,
        requestId: "studio-batch-succeeded",
        status: "succeeded",
        concurrency: 2,
        taskIds: ["task-first", "task-second"],
        items: [
          { id: "task-first", result: successResult(first) },
          { id: "task-second", result: successResult(second) }
        ]
      }).status
    ).toBe("succeeded");

    expect(
      studioBatchResultSchema.parse({
        schemaVersion: 1,
        requestId: "studio-batch-failed",
        status: "failed",
        concurrency: 2,
        taskIds: ["task-first", "task-second"],
        items: [
          { id: "task-first", result: failedResult(first) },
          { id: "task-second", result: failedResult(second) }
        ]
      }).status
    ).toBe("failed");
  });

  it("rejects duplicate task identities, edit items, concurrency overrides, and oversized batches", () => {
    const operation = generateRequest();
    expect(
      studioBatchInputSchema.safeParse({
        tasks: [
          { id: "duplicate", operation },
          { id: "duplicate", operation }
        ]
      }).success
    ).toBe(false);
    expect(
      studioBatchInputSchema.safeParse({
        tasks: [{ id: "task-edit", operation: { kind: "edit", prompt: "no" } }]
      }).success
    ).toBe(false);
    expect(
      studioBatchInputSchema.safeParse({
        tasks: [{ id: "task-one", operation }],
        concurrency: 4
      }).success
    ).toBe(false);
    expect(
      studioBatchInputSchema.safeParse({
        tasks: Array.from({ length: 21 }, (_, index) => ({
          id: `task-${index}`,
          operation
        }))
      }).success
    ).toBe(false);
  });
});

describe("Studio creation operation definitions", () => {
  it("registers path-free generation/batch internally without changing the public seven", () => {
    expect(routegoOperationNames).toEqual([
      "status",
      "generate",
      "prepareRegeneration",
      "batch",
      "searchLibrary",
      "manageLibrary",
      "openStudio"
    ]);
    expect(Object.values(routegoOperationDefinitions).map((item) => item.toolName)).toEqual([
      "routego_status",
      "routego_generate",
      "routego_prepare_regeneration",
      "routego_batch",
      "routego_search_library",
      "routego_manage_library",
      "routego_open_studio"
    ]);
    expect(studioOperationDefinitions.studioGenerate.http.path).toMatch(
      /^\/api\/v1\/studio\/creation\//u
    );
    expect(studioOperationDefinitions.studioBatch.http.path).toMatch(
      /^\/api\/v1\/studio\/creation\//u
    );
    expect("toolName" in studioOperationDefinitions.studioGenerate).toBe(false);
  });

  it("dispatches exact path-free inputs and outputs", () => {
    const request = generateRequest();
    expect(parseStudioOperationInput("studioGenerate", request)).toEqual(request);
    expect(parseStudioOperationOutput("studioGenerate", successResult(request))).toMatchObject({
      status: "succeeded"
    });
    expect(() =>
      parseStudioOperationInput("studioGenerate", {
        ...request,
        outputDir: "C:\\\\Users\\\\person\\\\Pictures"
      })
    ).toThrow();
  });
});
