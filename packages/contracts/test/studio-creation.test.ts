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
  studioImageInputRefSchema,
  studioImageOperationEventSchema,
  studioImageOperationResultSchema,
  studioOperationDefinitions,
  studioServiceErrorSchema,
  type StudioImageArtifact,
  type StudioImageOperationRequest,
  type StudioImageOperationResult
} from "../src/index";
import { TEST_TIMESTAMP } from "./fixtures";

type StudioGenerateRequest = Extract<StudioImageOperationRequest, { kind: "generate" }>;
type StudioEditRequest = Extract<StudioImageOperationRequest, { kind: "edit" }>;

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
): StudioGenerateRequest {
  return studioGenerateInputSchema.parse({
    kind: "generate",
    prompt: "生成路径安全的宇航猫 🚀",
    ...overrides
  });
}

function editRequest(overrides: Record<string, unknown> = {}): StudioEditRequest {
  return studioEditInputSchema.parse({
    kind: "edit",
    prompt: "只替换天空并保留主体",
    references: [
      {
        image: { source: "asset", assetId: "asset-reference" },
        role: "style",
        label: "Color reference"
      }
    ],
    target: { source: "artifact", artifactId: "artifact-target" },
    supportingImages: [
      {
        image: { source: "upload", uploadResourceId: "upload-supporting" },
        role: "supporting"
      }
    ],
    mask: {
      image: { source: "upload", uploadResourceId: "upload-mask" },
      targetSlot: 0
    },
    invariants: {
      allowedChanges: ["sky"],
      preserve: ["subject and composition"],
      forbiddenChanges: ["text"]
    },
    action: "edit",
    size: "1024x1024",
    aspectRatio: "1:1",
    quality: "high",
    format: "png",
    count: 1,
    partialImages: 1,
    moderation: "auto",
    transparentMode: "off",
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
    safeMessage: "The synthetic provider cannot accept image input.",
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

describe("path-free Studio image inputs", () => {
  it("accepts exactly one asset, artifact, or upload locator", () => {
    expect(studioImageInputRefSchema.parse({ source: "asset", assetId: "asset-a" })).toEqual({
      source: "asset",
      assetId: "asset-a"
    });
    expect(
      studioImageInputRefSchema.parse({ source: "artifact", artifactId: "artifact-a" })
    ).toEqual({ source: "artifact", artifactId: "artifact-a" });
    expect(
      studioImageInputRefSchema.parse({ source: "upload", uploadResourceId: "upload-a" })
    ).toEqual({ source: "upload", uploadResourceId: "upload-a" });

    for (const value of [
      { source: "asset", assetId: "asset-a", artifactId: "artifact-a" },
      { source: "upload", uploadResourceId: "upload-a", path: "C:\\image.png" },
      { source: "upload", uploadResourceId: "upload-a", url: "https://example.invalid/a.png" },
      { source: "upload", uploadResourceId: "upload-a", dataUrl: "data:image/png;base64,AAAA" }
    ]) {
      expect(studioImageInputRefSchema.safeParse(value).success).toBe(false);
    }
  });

  it("accepts text-only generate with full controls and no local output path", () => {
    const request = generateRequest({
      references: [
        {
          image: { source: "upload", uploadResourceId: "upload-reference" },
          role: "reference"
        }
      ],
      quality: "medium",
      format: "webp",
      compression: 80,
      count: 4,
      partialImages: 3,
      moderation: "low",
      action: "auto",
      previousResponseId: "response-a",
      imageIds: ["provider-image-a"],
      fileIds: ["provider-file-a"],
      saveToLibrary: false
    });
    expect(request).toMatchObject({ count: 4, partialImages: 3, format: "webp" });
    expect(JSON.stringify(request)).not.toMatch(/(?:outputDir|path|dataUrl|base64|https?:\/\/)/u);
  });

  it("binds an edit mask to target slot zero and preserves ordered inputs", () => {
    const request = editRequest();
    expect(request.references[0]?.image).toEqual({ source: "asset", assetId: "asset-reference" });
    expect(request.target).toEqual({ source: "artifact", artifactId: "artifact-target" });
    expect(request.supportingImages[0]?.image).toEqual({
      source: "upload",
      uploadResourceId: "upload-supporting"
    });
    expect(request.mask?.targetSlot).toBe(0);
  });

  it("rejects invalid limits, controls, or edit invariants", () => {
    const tooManyReferences = Array.from({ length: 16 }, (_, index) => ({
      image: { source: "asset" as const, assetId: `asset-${index}` },
      role: "reference" as const
    }));
    for (const value of [
      { kind: "generate", prompt: "bad edit action", action: "edit" },
      { kind: "generate", prompt: "bad PNG compression", format: "png", compression: 50 },
      { kind: "generate", prompt: "bad transparency", format: "jpeg", transparentMode: "native" },
      {
        kind: "edit",
        prompt: "missing invariants",
        target: { source: "asset", assetId: "asset-target" }
      },
      {
        kind: "edit",
        prompt: "too many",
        target: { source: "asset", assetId: "asset-target" },
        references: tooManyReferences,
        invariants: { preserve: ["subject"] }
      },
      {
        kind: "edit",
        prompt: "bad mask",
        target: { source: "asset", assetId: "asset-target" },
        mask: { image: { source: "upload", uploadResourceId: "upload-mask" }, targetSlot: 1 },
        invariants: { preserve: ["subject"] }
      }
    ]) {
      expect(
        (value.kind === "generate" ? studioGenerateInputSchema : studioEditInputSchema).safeParse(
          value
        ).success
      ).toBe(false);
    }
  });
});

describe("path-free Studio results, relationships, and SSE events", () => {
  it("accepts path-free artifacts and rejects unsafe browser resources", () => {
    const result = successResult(editRequest());
    expect(result.finalArtifacts[0]).toMatchObject({
      artifactId: "artifact-final",
      resource: { requiresSession: true, mimeType: "image/png" }
    });
    expect(JSON.stringify(result)).not.toMatch(/(?:C:\\|\/Users\/|data:image|base64|Authorization)/u);

    expect(
      studioImageOperationResultSchema.safeParse({
        ...result,
        finalArtifacts: [
          {
            ...result.finalArtifacts[0],
            resource: {
              ...result.finalArtifacts[0]?.resource,
              relativeUrl: "https://example.invalid/result.png"
            }
          }
        ]
      }).success
    ).toBe(false);
  });

  it("represents partial output and matching billing/output flags", () => {
    const request = generateRequest();
    const partialArtifact = artifact("artifact-partial", "partial");
    const error = studioServiceErrorSchema.parse({
      code: "invalid_response",
      category: "protocol",
      stage: "stream",
      safeMessage: "The synthetic stream ended after partial output.",
      retryDisposition: "never",
      partialArtifacts: [partialArtifact],
      receivedAnyOutput: true,
      mayHaveBilled: true
    });
    const result = studioImageOperationResultSchema.parse({
      schemaVersion: 1,
      requestId: "studio-request-partial",
      status: "partial",
      requestedParams: request,
      effectiveParams: request,
      execution: execution({ transport: "openai-responses" }),
      finalArtifacts: [],
      partialArtifacts: [partialArtifact],
      failedSlots: [{ slot: 0, error }],
      relationships: [
        {
          role: "stream-partial",
          outputArtifactId: partialArtifact.artifactId,
          order: 0
        }
      ],
      error
    });
    expect(result).toMatchObject({
      status: "partial",
      execution: { receivedAnyOutput: true, mayHaveBilled: true },
      error: { retryDisposition: "never" }
    });
  });

  it("marks degraded continuation explicitly without changing path-free artifacts", () => {
    const result = successResult(editRequest(), {
      execution: execution({ degradedContinuation: true })
    });
    expect(result.execution.degradedContinuation).toBe(true);
    expect(JSON.stringify(result.finalArtifacts)).not.toMatch(/(?:path|dataUrl|base64)/u);
  });

  it("validates target/reference/supporting/mask/output relationships", () => {
    const request = editRequest();
    const output = artifact("artifact-edit-output");
    const result = studioImageOperationResultSchema.parse({
      schemaVersion: 1,
      requestId: "studio-request-edit",
      status: "succeeded",
      requestedParams: request,
      effectiveParams: request,
      execution: execution(),
      finalArtifacts: [output],
      relationships: [
        {
          role: "target",
          input: request.target,
          outputArtifactId: output.artifactId,
          order: 0
        },
        {
          role: "reference",
          input: request.references[0]?.image,
          outputArtifactId: output.artifactId,
          order: 1
        },
        {
          role: "supporting",
          input: request.supportingImages[0]?.image,
          outputArtifactId: output.artifactId,
          order: 2
        },
        {
          role: "mask",
          input: request.mask?.image,
          outputArtifactId: output.artifactId,
          order: 3,
          targetSlot: 0
        },
        { role: "output", outputArtifactId: output.artifactId, order: 4 }
      ]
    });
    expect(result.relationships.map((relationship) => relationship.role)).toEqual([
      "target",
      "reference",
      "supporting",
      "mask",
      "output"
    ]);
  });

  it("covers started, partial, completed, and failed SSE projections", () => {
    const request = generateRequest();
    const partialArtifact = artifact("artifact-event-partial", "partial");
    const failed = failureError();
    const events = [
      {
        type: "started",
        requestId: "studio-event-request",
        sequence: 0,
        occurredAt: TEST_TIMESTAMP,
        requestedParams: request
      },
      {
        type: "partial",
        requestId: "studio-event-request",
        sequence: 1,
        occurredAt: TEST_TIMESTAMP,
        artifact: partialArtifact,
        receivedAnyOutput: true,
        mayHaveBilled: true
      },
      {
        type: "completed",
        requestId: "studio-event-request",
        sequence: 2,
        occurredAt: TEST_TIMESTAMP,
        result: successResult(request)
      },
      {
        type: "failed",
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
  it("preserves task order and derives succeeded, partial, and failed status", () => {
    const first = generateRequest();
    const second = editRequest();
    const input = studioBatchInputSchema.parse({
      tasks: [
        { id: "task-first", operation: first },
        { id: "task-second", operation: second }
      ],
      concurrency: 2
    });
    expect(input.tasks.map((task) => task.id)).toEqual(["task-first", "task-second"]);

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

  it("rejects duplicate task identities and invalid bounds", () => {
    const operation = generateRequest();
    expect(
      studioBatchInputSchema.safeParse({
        tasks: [
          { id: "duplicate", operation },
          { id: "duplicate", operation }
        ],
        concurrency: 11
      }).success
    ).toBe(false);
  });
});

describe("Studio creation operation definitions", () => {
  it("registers path-free creation internally without changing the public seven", () => {
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
    for (const operation of ["studioGenerate", "studioEdit", "studioBatch"] as const) {
      expect(studioOperationDefinitions[operation].http.path).toMatch(
        /^\/api\/v1\/studio\/creation\//u
      );
      expect("toolName" in studioOperationDefinitions[operation]).toBe(false);
    }
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
        outputDir: "C:\\Users\\person\\Pictures"
      })
    ).toThrow();
  });
});
