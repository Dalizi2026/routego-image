import {
  studioBatchInputSchema,
  type StudioBatchResult
} from "@routego-image/contracts";

import {
  buildStudioCreationRequest,
  CreationDraftError,
  normalizeVisibleControls
} from "./draft";
import type { BatchDraftItem, CreationDraft } from "./types";

export const STUDIO_BATCH_CONCURRENCY = 2;

export class BatchDraftError extends Error {
  readonly taskId?: string | undefined;
  readonly fields: Readonly<Record<string, string>>;

  constructor(
    message: string,
    options: {
      readonly taskId?: string | undefined;
      readonly fields?: Readonly<Record<string, string>> | undefined;
    } = {}
  ) {
    super(message);
    this.name = "BatchDraftError";
    this.taskId = options.taskId;
    this.fields = options.fields ?? {};
  }
}

export function createBatchDraftItem(
  draft: Pick<CreationDraft, "prompt" | "controls">,
  id: string = globalThis.crypto.randomUUID()
): BatchDraftItem {
  return {
    id,
    prompt: draft.prompt,
    size: draft.controls.size,
    aspectRatio: draft.controls.aspectRatio,
    count: draft.controls.count
  };
}

export function buildStudioBatchRequest(
  items: readonly BatchDraftItem[],
  submissionDraft: CreationDraft
): ReturnType<typeof studioBatchInputSchema.parse> {
  const tasks = items.map((item) => {
    try {
      return {
        id: item.id,
        operation: buildStudioCreationRequest({
          ...submissionDraft,
          mode: "generate",
          prompt: item.prompt,
          controls: normalizeVisibleControls({
            ...submissionDraft.controls,
            size: item.size,
            aspectRatio: item.aspectRatio,
            count: item.count
          })
        })
      };
    } catch (error) {
      if (error instanceof CreationDraftError) {
        throw new BatchDraftError(`批量任务 ${item.id} 的输入无效。`, {
          taskId: item.id,
          fields: error.fields
        });
      }
      throw error;
    }
  });
  const parsed = studioBatchInputSchema.safeParse({ tasks });
  if (!parsed.success) {
    throw new BatchDraftError("批量任务不符合本地契约。", {
      fields: Object.fromEntries(
        parsed.error.issues.map((issue) => [
          issue.path.map(String).join(".") || "batch",
          issue.message
        ])
      )
    });
  }
  return parsed.data;
}

export interface BatchResultPresentation {
  readonly tone: "success" | "partial" | "failure";
  readonly title: string;
  readonly succeeded: number;
  readonly partial: number;
  readonly failed: number;
  readonly requiresReplayConfirmation: boolean;
}

export function describeBatchResult(result: StudioBatchResult): BatchResultPresentation {
  const succeeded = result.items.filter((item) => item.result.status === "succeeded").length;
  const partial = result.items.filter((item) => item.result.status === "partial").length;
  const failed = result.items.filter((item) => item.result.status === "failed").length;
  return {
    tone:
      result.status === "succeeded"
        ? "success"
        : result.status === "failed"
          ? "failure"
          : "partial",
    title:
      result.status === "succeeded"
        ? "批量任务全部完成"
        : result.status === "partial"
          ? "批量任务部分完成"
          : "批量任务全部失败",
    succeeded,
    partial,
    failed,
    requiresReplayConfirmation: result.items.some(
      (item) => item.result.execution.receivedAnyOutput || item.result.execution.mayHaveBilled
    )
  };
}
