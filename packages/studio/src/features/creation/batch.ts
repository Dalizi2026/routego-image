import {
  studioBatchInputSchema,
  type StudioBatchResult
} from "@routego-image/contracts";

import { buildStudioCreationRequest, CreationDraftError } from "./draft";
import type { BatchDraftItem, CreationDraft } from "./types";

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

export function cloneCreationDraft(draft: CreationDraft): CreationDraft {
  return {
    ...draft,
    references: draft.references.map((reference) => ({ ...reference })),
    target: draft.target === undefined ? undefined : { ...draft.target },
    supportingImages: draft.supportingImages.map((supporting) => ({ ...supporting })),
    invariants: {
      allowedChanges: [...draft.invariants.allowedChanges],
      preserve: [...draft.invariants.preserve],
      forbiddenChanges: [...draft.invariants.forbiddenChanges]
    },
    controls: { ...draft.controls }
  };
}

export function createBatchDraftItem(
  draft: CreationDraft,
  id: string = globalThis.crypto.randomUUID()
): BatchDraftItem {
  return { id, draft: cloneCreationDraft(draft) };
}

export function moveBatchDraftItem(
  items: readonly BatchDraftItem[],
  itemId: string,
  direction: -1 | 1
): readonly BatchDraftItem[] {
  const index = items.findIndex((item) => item.id === itemId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= items.length) {
    return items;
  }
  const next = [...items];
  const [item] = next.splice(index, 1);
  if (item !== undefined) next.splice(target, 0, item);
  return next;
}

export function buildStudioBatchRequest(
  items: readonly BatchDraftItem[],
  concurrency: number
): ReturnType<typeof studioBatchInputSchema.parse> {
  const tasks = items.map((item) => {
    try {
      return { id: item.id, operation: buildStudioCreationRequest(item.draft) };
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
  const parsed = studioBatchInputSchema.safeParse({ tasks, concurrency });
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
