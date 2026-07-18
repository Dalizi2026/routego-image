import { useMemo } from "react";

import { useI18n } from "../../i18n";
import { describeBatchResult } from "./batch";
import type { BatchDraftItem, BatchSubmissionState } from "./types";

const copy = {
  zh: {
    eyebrow: "BATCH / 03",
    title: "有序批量队列",
    body: "每个任务保留稳定标识和顺序；混合结果不会被合并成虚假的成功。",
    add: "新增任务",
    remove: "移除",
    moveUp: "上移",
    moveDown: "下移",
    concurrency: "并发数",
    selected: "正在编辑",
    draft: "草稿",
    queued: "排队中",
    processing: "处理中",
    succeeded: "成功",
    partial: "部分成功",
    failed: "失败",
    submit: "提交整个批次",
    submitAgain: "作为新批次再次提交",
    submitting: "批次处理中…",
    replayWarning: "部分任务已收到输出或可能计费。再次提交会创建全新的明确请求。",
    acknowledge: "我确认要创建一个新的批量请求",
    untitled: "未填写提示词"
  },
  en: {
    eyebrow: "BATCH / 03",
    title: "Ordered batch queue",
    body: "Every task keeps a stable identity and order; mixed outcomes are never collapsed into false success.",
    add: "Add task",
    remove: "Remove",
    moveUp: "Move up",
    moveDown: "Move down",
    concurrency: "Concurrency",
    selected: "Editing",
    draft: "Draft",
    queued: "Queued",
    processing: "Processing",
    succeeded: "Succeeded",
    partial: "Partial",
    failed: "Failed",
    submit: "Submit batch",
    submitAgain: "Submit again as a new batch",
    submitting: "Batch in progress…",
    replayWarning: "Some tasks produced output or may have billed. Submitting again creates a new explicit request.",
    acknowledge: "I understand this creates a new batch request",
    untitled: "Prompt not entered"
  }
} as const;

function taskStatus(
  itemId: string,
  index: number,
  concurrency: number,
  submission: BatchSubmissionState
): "draft" | "queued" | "processing" | "succeeded" | "partial" | "failed" {
  if (submission.status === "submitting") {
    return index < concurrency ? "processing" : "queued";
  }
  if (submission.status === "result") {
    return submission.result.items.find((item) => item.id === itemId)?.result.status ?? "failed";
  }
  return submission.status === "failure" ? "failed" : "draft";
}

export function BatchEditor({
  items,
  selectedId,
  concurrency,
  submission,
  onSelect,
  onAdd,
  onRemove,
  onMove,
  onConcurrencyChange,
  onReplayAcknowledged,
  onSubmit
}: {
  readonly items: readonly BatchDraftItem[];
  readonly selectedId: string;
  readonly concurrency: number;
  readonly submission: BatchSubmissionState;
  readonly onSelect: (item: BatchDraftItem) => void;
  readonly onAdd: () => void;
  readonly onRemove: (item: BatchDraftItem) => void;
  readonly onMove: (itemId: string, direction: -1 | 1) => void;
  readonly onConcurrencyChange: (value: number) => void;
  readonly onReplayAcknowledged: (value: boolean) => void;
  readonly onSubmit: () => void;
}) {
  const { language } = useI18n();
  const labels = copy[language];
  const presentation = useMemo(
    () => (submission.status === "result" ? describeBatchResult(submission.result) : undefined),
    [submission]
  );
  const needsReplayAcknowledgement = presentation?.requiresReplayConfirmation ?? false;
  const replayAcknowledged =
    submission.status === "result" ? submission.replayAcknowledged : false;
  const submitDisabled =
    submission.status === "submitting" ||
    (needsReplayAcknowledgement && !replayAcknowledged);

  return (
    <section className="batch-editor" aria-labelledby="batch-editor-title">
      <div className="batch-editor__heading">
        <div>
          <p>{labels.eyebrow}</p>
          <h2 id="batch-editor-title">{labels.title}</h2>
          <span>{labels.body}</span>
        </div>
        <div className="batch-editor__controls">
          <label className="field">
            <span>{labels.concurrency}</span>
            <input
              type="number"
              min={1}
              max={10}
              value={concurrency}
              onChange={(event) => onConcurrencyChange(Number(event.target.value))}
            />
          </label>
          <button type="button" disabled={items.length >= 20} onClick={onAdd}>
            {labels.add} · {items.length}/20
          </button>
        </div>
      </div>

      <ol className="batch-editor__list">
        {items.map((item, index) => {
          const status = taskStatus(item.id, index, concurrency, submission);
          const selected = item.id === selectedId;
          return (
            <li className={selected ? "is-selected" : undefined} key={item.id}>
              <button
                className="batch-editor__select"
                type="button"
                aria-current={selected ? "step" : undefined}
                onClick={() => onSelect(item)}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{item.draft.prompt.trim() || labels.untitled}</strong>
                <small>
                  {selected ? `${labels.selected} · ` : ""}
                  {item.draft.mode} · {labels[status]}
                </small>
              </button>
              <div className="batch-editor__item-actions">
                <button type="button" disabled={index === 0} onClick={() => onMove(item.id, -1)}>
                  {labels.moveUp}
                </button>
                <button
                  type="button"
                  disabled={index === items.length - 1}
                  onClick={() => onMove(item.id, 1)}
                >
                  {labels.moveDown}
                </button>
                <button type="button" disabled={items.length === 1} onClick={() => onRemove(item)}>
                  {labels.remove}
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      {presentation ? (
        <div className={`batch-editor__summary batch-editor__summary--${presentation.tone}`}>
          <strong>{presentation.title}</strong>
          <span>
            {labels.succeeded} {presentation.succeeded} · {labels.partial} {presentation.partial} · {labels.failed}{" "}
            {presentation.failed}
          </span>
        </div>
      ) : null}
      {submission.status === "failure" ? (
        <p className="creation-error" role="alert">
          {submission.safeMessage}
        </p>
      ) : null}
      {needsReplayAcknowledgement ? (
        <label className="batch-editor__replay-warning">
          <span>{labels.replayWarning}</span>
          <span>
            <input
              type="checkbox"
              checked={replayAcknowledged}
              onChange={(event) => onReplayAcknowledged(event.target.checked)}
            />
            {labels.acknowledge}
          </span>
        </label>
      ) : null}
      <button className="creation-submit" type="button" disabled={submitDisabled} onClick={onSubmit}>
        {submission.status === "submitting"
          ? labels.submitting
          : submission.status === "result"
            ? labels.submitAgain
            : labels.submit}
      </button>
    </section>
  );
}
