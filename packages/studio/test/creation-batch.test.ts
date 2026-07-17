import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  studioBatchResultSchema,
  studioImageOperationResultSchema,
  type StudioImageOperationRequest,
  type StudioImageOperationResult
} from "@routego-image/contracts";

import { I18nProvider } from "../src/i18n";
import {
  BatchDraftError,
  BatchEditor,
  buildStudioBatchRequest,
  createBatchDraftItem,
  createInitialCreationDraft,
  describeBatchResult
} from "../src/features/creation";

const defaults = {
  model: "mock-image-model",
  size: "auto" as const,
  aspectRatio: "auto" as const,
  quality: "auto" as const,
  format: "png" as const,
  count: 1 as const,
  partialImages: 0 as const,
  transparentMode: "off" as const,
  moderation: "auto" as const,
  saveToLibrary: true
};

function operation(prompt: string) {
  return { ...createInitialCreationDraft(defaults), prompt };
}

function result(
  request: StudioImageOperationRequest,
  status: "succeeded" | "failed",
  requestId: string
): StudioImageOperationResult {
  const succeeded = status === "succeeded";
  return studioImageOperationResultSchema.parse({
    schemaVersion: 1,
    requestId,
    status,
    requestedParams: request,
    effectiveParams: request,
    execution: {
      transport: "single-endpoint-json",
      attemptCount: succeeded ? 1 : 0,
      providerRequestCount: succeeded ? 1 : 0,
      receivedAnyOutput: succeeded,
      mayHaveBilled: succeeded,
      degradedContinuation: false,
      providerImageIds: []
    },
    finalArtifacts: succeeded
      ? [
          {
            artifactId: `artifact-${requestId}`,
            slot: 0,
            phase: "final",
            resource: {
              resourceId: `resource-${requestId}`,
              relativeUrl: `/api/v1/resources/${requestId}`,
              requiresSession: true,
              mimeType: "image/png",
              byteLength: 68,
              width: 1,
              height: 1,
              etag: `etag-${requestId}`,
              expiresAt: "2026-07-18T01:00:00.000Z"
            },
            createdAt: "2026-07-18T00:00:00.000Z"
          }
        ]
      : [],
    partialArtifacts: [],
    failedSlots: [],
    relationships: succeeded
      ? [{ role: "output", outputArtifactId: `artifact-${requestId}`, order: 0 }]
      : [],
    ...(succeeded
      ? {}
      : {
          error: {
            code: "provider_5xx",
            category: "provider",
            stage: "submit",
            safeMessage: "Synthetic failure.",
            retryDisposition: "user-confirmation",
            partialArtifacts: [],
            receivedAnyOutput: false,
            mayHaveBilled: false
          }
        })
  });
}

describe("ordered Studio batch editor", () => {
  it("builds 1-20 tasks in stable order with concurrency 1-10", () => {
    const items = [
      createBatchDraftItem(operation("First"), "task-first"),
      createBatchDraftItem(operation("Second"), "task-second")
    ];
    const request = buildStudioBatchRequest(items, 2);
    expect(request.tasks.map((task) => task.id)).toEqual(["task-first", "task-second"]);
    expect(request.tasks.map((task) => task.operation.prompt)).toEqual(["First", "Second"]);
    expect(JSON.stringify(request)).not.toMatch(/(?:C:\\|\/Users\/|data:image|base64|api[_-]?key)/u);
    expect(() => buildStudioBatchRequest([items[0]!, { ...items[1]!, id: "task-first" }], 11)).toThrow(
      BatchDraftError
    );
    expect(() =>
      buildStudioBatchRequest(
        Array.from({ length: 21 }, (_, index) =>
          createBatchDraftItem(operation(`Task ${index + 1}`), `task-${index + 1}`)
        ),
        3
      )
    ).toThrow(BatchDraftError);
  });

  it("preserves mixed outcomes and requires explicit replay after output or billing risk", () => {
    const request = buildStudioBatchRequest(
      [
        createBatchDraftItem(operation("First"), "task-first"),
        createBatchDraftItem(operation("Second"), "task-second")
      ],
      2
    );
    const batch = studioBatchResultSchema.parse({
      schemaVersion: 1,
      requestId: "batch-mixed",
      status: "partial",
      concurrency: 2,
      taskIds: ["task-first", "task-second"],
      items: [
        { id: "task-first", result: result(request.tasks[0]!.operation, "succeeded", "one") },
        { id: "task-second", result: result(request.tasks[1]!.operation, "failed", "two") }
      ]
    });
    expect(describeBatchResult(batch)).toMatchObject({
      tone: "partial",
      succeeded: 1,
      failed: 1,
      requiresReplayConfirmation: true
    });
  });

  it("renders ordered per-item states and disables risky replay until acknowledged", () => {
    const items = [
      createBatchDraftItem(operation("First"), "task-first"),
      createBatchDraftItem(operation("Second"), "task-second")
    ];
    const request = buildStudioBatchRequest(items, 2);
    const batch = studioBatchResultSchema.parse({
      schemaVersion: 1,
      requestId: "batch-markup",
      status: "partial",
      concurrency: 2,
      taskIds: ["task-first", "task-second"],
      items: [
        { id: "task-first", result: result(request.tasks[0]!.operation, "succeeded", "three") },
        { id: "task-second", result: result(request.tasks[1]!.operation, "failed", "four") }
      ]
    });
    const markup = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(BatchEditor, {
          items,
          selectedId: "task-first",
          concurrency: 2,
          submission: { status: "result", result: batch, replayAcknowledged: false },
          onSelect: () => undefined,
          onAdd: () => undefined,
          onRemove: () => undefined,
          onMove: () => undefined,
          onConcurrencyChange: () => undefined,
          onReplayAcknowledged: () => undefined,
          onSubmit: () => undefined
        })
      )
    );
    expect(markup.indexOf("First")).toBeLessThan(markup.indexOf("Second"));
    expect(markup).toContain("批量任务部分完成");
    expect(markup).toContain("我确认要创建一个新的批量请求");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>作为新批次再次提交<\/button>/u);
  });
});
