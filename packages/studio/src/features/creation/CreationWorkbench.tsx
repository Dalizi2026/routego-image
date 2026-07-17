import {
  useCallback,
  useMemo,
  useState,
  type ChangeEvent,
  type DragEvent
} from "react";

import type { ReadSettingsResult, StudioImageOperationResult } from "@routego-image/contracts";

import type { StudioGateway } from "../../api";
import { ProtectedImage } from "../../components";
import { useI18n } from "../../i18n";
import {
  buildStudioCreationRequest,
  CreationDraftError,
  createEditHandoff,
  createInitialCreationDraft
} from "./draft";
import { describeCreationResult } from "./result";
import type {
  CreationAvailability,
  CreationDraft,
  CreationInputSlot,
  DraftImageInput,
  SubmissionState,
  UploadLifecycleItem
} from "./types";
import {
  createUploadItem,
  discardUploadLifecycle,
  performUploadLifecycle,
  retryUploadLifecycle
} from "./upload";
import "./creation.css";

const UNCONFIRMED_MESSAGE = "当前中转未确认支持";

const copy = {
  zh: {
    eyebrow: "CREATE / 01",
    title: "把想法放进显影盘",
    subtitle: "提示词、参考图与输出参数始终保留为本地草稿；失败不会清空当前工作。",
    generate: "生成",
    edit: "编辑",
    prompt: "提示词",
    promptPlaceholder: "描述画面、光线、构图和必须保留的细节…",
    references: "参考图",
    target: "编辑目标",
    supporting: "辅助图",
    drop: "拖放或选择图像",
    dropHint: "PNG / JPEG / WebP，浏览器只提交受保护的上传标识符",
    options: "输出控制",
    size: "尺寸",
    ratio: "画幅",
    quality: "质量",
    format: "格式",
    count: "数量",
    compression: "压缩率",
    partial: "部分图像",
    transparent: "透明",
    moderation: "内容检查",
    save: "保存到图库",
    allowed: "允许修改",
    preserve: "必须保留",
    forbidden: "禁止修改",
    invariantHint: "每行一项，至少填写一个约束。",
    submit: "开始生成",
    submitEdit: "提交编辑",
    submitting: "正在提交受保护请求…",
    remove: "移除",
    retry: "重试上传",
    moveUp: "上移",
    moveDown: "下移",
    result: "显影结果",
    effective: "实际参数",
    retryRequest: "以当前草稿再次提交",
    continueEdit: "继续编辑",
    billing: "可能计费",
    output: "已收到输出",
    yes: "是",
    no: "否"
  },
  en: {
    eyebrow: "CREATE / 01",
    title: "Place the idea in the developer tray",
    subtitle: "Prompts, references, and output controls remain a local draft. Failures never clear current work.",
    generate: "Generate",
    edit: "Edit",
    prompt: "Prompt",
    promptPlaceholder: "Describe the scene, light, composition, and details that must remain…",
    references: "References",
    target: "Edit target",
    supporting: "Supporting images",
    drop: "Drop or choose images",
    dropHint: "PNG / JPEG / WebP; the browser sends only protected upload identifiers",
    options: "Output controls",
    size: "Size",
    ratio: "Aspect",
    quality: "Quality",
    format: "Format",
    count: "Count",
    compression: "Compression",
    partial: "Partial images",
    transparent: "Transparency",
    moderation: "Moderation",
    save: "Save to Library",
    allowed: "Allowed changes",
    preserve: "Preserve",
    forbidden: "Forbidden changes",
    invariantHint: "One item per line; at least one invariant is required.",
    submit: "Generate",
    submitEdit: "Submit edit",
    submitting: "Submitting a protected request…",
    remove: "Remove",
    retry: "Retry upload",
    moveUp: "Move up",
    moveDown: "Move down",
    result: "Developed result",
    effective: "Effective parameters",
    retryRequest: "Submit current draft again",
    continueEdit: "Continue editing",
    billing: "May have billed",
    output: "Received output",
    yes: "Yes",
    no: "No"
  }
} as const;

type CreationLabels = { readonly [Key in keyof (typeof copy)["zh"]]: string };

function lines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function updateImage(
  draft: CreationDraft,
  imageId: string,
  update: (image: DraftImageInput) => DraftImageInput
): CreationDraft {
  return {
    ...draft,
    references: draft.references.map((image) => (image.id === imageId ? update(image) : image)),
    target: draft.target?.id === imageId ? update(draft.target) : draft.target,
    supportingImages: draft.supportingImages.map((image) =>
      image.id === imageId ? update(image) : image
    )
  };
}

function UploadCard({
  image,
  index,
  count,
  labels,
  onRemove,
  onRetry,
  onMove
}: {
  readonly image: DraftImageInput;
  readonly index: number;
  readonly count: number;
  readonly labels: CreationLabels;
  readonly onRemove: () => void;
  readonly onRetry: () => void;
  readonly onMove: (direction: -1 | 1) => void;
}) {
  const upload = image.upload;
  return (
    <article className="upload-card">
      <span className="upload-card__order">{String(index + 1).padStart(2, "0")}</span>
      <div className="upload-card__copy">
        <strong>{upload?.source.name ?? image.label ?? image.locator?.source}</strong>
        <span className={`upload-status upload-status--${upload?.status ?? "ready"}`}>
          {upload?.status ?? "ready"}
        </span>
        {upload?.safeMessage ? <p role="alert">{upload.safeMessage}</p> : null}
      </div>
      <div className="upload-card__actions">
        {count > 1 ? (
          <>
            <button type="button" disabled={index === 0} onClick={() => onMove(-1)}>
              {labels.moveUp}
            </button>
            <button type="button" disabled={index === count - 1} onClick={() => onMove(1)}>
              {labels.moveDown}
            </button>
          </>
        ) : null}
        {upload?.status === "failed" || upload?.status === "expired" ? (
          <button type="button" onClick={onRetry}>
            {labels.retry}
          </button>
        ) : null}
        <button type="button" onClick={onRemove}>
          {labels.remove}
        </button>
      </div>
    </article>
  );
}

function FileDropzone({
  title,
  purpose,
  slot,
  disabled,
  labels,
  onFiles
}: {
  readonly title: string;
  readonly purpose: "reference" | "target" | "supporting";
  readonly slot: CreationInputSlot;
  readonly disabled: boolean;
  readonly labels: CreationLabels;
  readonly onFiles: (slot: CreationInputSlot, files: readonly File[]) => void;
}) {
  const acceptFiles = (files: FileList | null) => {
    if (!disabled && files !== null) {
      onFiles(slot, Array.from(files));
    }
  };
  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    acceptFiles(event.dataTransfer.files);
  };
  return (
    <div className="file-dropzone-wrap">
      <h3>{title}</h3>
      <label
        className={`file-dropzone${disabled ? " is-disabled" : ""}`}
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
      >
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple={purpose !== "target"}
          disabled={disabled}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            acceptFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <span>{labels.drop}</span>
        <small>{disabled ? UNCONFIRMED_MESSAGE : labels.dropHint}</small>
      </label>
    </div>
  );
}

function ResultPanel({
  gateway,
  result,
  labels,
  editAvailable,
  onRetry,
  onEdit
}: {
  readonly gateway: StudioGateway;
  readonly result: StudioImageOperationResult;
  readonly labels: CreationLabels;
  readonly editAvailable: boolean;
  readonly onRetry: () => void;
  readonly onEdit: (artifactId: string) => void;
}) {
  const presentation = describeCreationResult(result);
  const artifacts = [...result.finalArtifacts, ...result.partialArtifacts];
  return (
    <section className={`creation-result creation-result--${presentation.tone}`}>
      <div className="creation-result__heading">
        <p>{labels.result}</p>
        <h2>{presentation.title}</h2>
      </div>
      {result.error ? <p className="creation-result__error">{result.error.safeMessage}</p> : null}
      <div className="creation-result__artifacts">
        {artifacts.map((artifact) => (
          <article className="result-card" key={artifact.artifactId}>
            <ProtectedImage gateway={gateway} descriptor={artifact.resource} alt="Generated result" />
            <div className="result-card__meta">
              <span>{artifact.phase}</span>
              <span>{artifact.resource.mimeType}</span>
              <span>
                {artifact.resource.width} × {artifact.resource.height}
              </span>
            </div>
            <button
              type="button"
              disabled={!editAvailable}
              title={editAvailable ? undefined : UNCONFIRMED_MESSAGE}
              onClick={() => onEdit(artifact.artifactId)}
            >
              {labels.continueEdit}
            </button>
          </article>
        ))}
      </div>
      <dl className="creation-result__facts">
        <div>
          <dt>{labels.output}</dt>
          <dd>{presentation.receivedAnyOutput ? labels.yes : labels.no}</dd>
        </div>
        <div>
          <dt>{labels.billing}</dt>
          <dd>{presentation.mayHaveBilled ? labels.yes : labels.no}</dd>
        </div>
        <div>
          <dt>{labels.effective}</dt>
          <dd>
            {result.effectiveParams.size} · {result.effectiveParams.quality} · {result.effectiveParams.format}
          </dd>
        </div>
      </dl>
      {presentation.manualRetryWarning ? (
        <p className="creation-result__warning">{presentation.manualRetryWarning}</p>
      ) : null}
      {result.failedSlots.map((slot) => (
        <p className="creation-result__error" key={slot.slot}>
          Slot {slot.slot}: {slot.error.safeMessage}
        </p>
      ))}
      <button className="studio-button" type="button" onClick={onRetry}>
        {labels.retryRequest}
      </button>
    </section>
  );
}

export function CreationWorkbench({
  gateway,
  defaults,
  availability
}: {
  readonly gateway: StudioGateway;
  readonly defaults: ReadSettingsResult["defaults"];
  readonly availability: CreationAvailability;
}) {
  const { language } = useI18n();
  const labels = copy[language];
  const [draft, setDraft] = useState<CreationDraft>(() => {
    const initial = createInitialCreationDraft(defaults);
    return {
      ...initial,
      controls: { ...initial.controls, partialImages: 0, transparentMode: "off" }
    };
  });
  const [submission, setSubmission] = useState<SubmissionState>({ status: "idle" });
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});

  const patchUpload = useCallback((item: UploadLifecycleItem) => {
    setDraft((current) => updateImage(current, item.id, (image) => ({ ...image, upload: item })));
  }, []);

  const beginUpload = useCallback(
    (slot: CreationInputSlot, files: readonly File[]) => {
      const accepted = slot === "target" ? files.slice(0, 1) : files;
      const additions = accepted.map((file) => {
        const purpose = slot === "target" ? "target" : slot;
        const upload = createUploadItem(purpose, { name: file.name, blob: file });
        return {
          id: upload.id,
          role: slot === "supporting" ? ("supporting" as const) : ("reference" as const),
          label: file.name,
          upload
        } satisfies DraftImageInput;
      });
      setDraft((current) => ({
        ...current,
        ...(slot === "reference"
          ? { references: [...current.references, ...additions].slice(0, 16) }
          : slot === "supporting"
            ? { supportingImages: [...current.supportingImages, ...additions].slice(0, 15) }
            : { target: additions[0] })
      }));
      for (const image of additions) {
        if (image.upload !== undefined) {
          void performUploadLifecycle(gateway, image.upload, patchUpload).catch(() => undefined);
        }
      }
    },
    [gateway, patchUpload]
  );

  const removeImage = useCallback(
    (image: DraftImageInput) => {
      if (image.upload !== undefined) {
        void discardUploadLifecycle(gateway, image.upload, patchUpload).catch(() => undefined);
      }
      setDraft((current) => ({
        ...current,
        references: current.references.filter((item) => item.id !== image.id),
        target: current.target?.id === image.id ? undefined : current.target,
        supportingImages: current.supportingImages.filter((item) => item.id !== image.id)
      }));
    },
    [gateway, patchUpload]
  );

  const retryUpload = useCallback(
    (image: DraftImageInput) => {
      if (image.upload !== undefined) {
        void retryUploadLifecycle(gateway, image.upload, patchUpload).catch(() => undefined);
      }
    },
    [gateway, patchUpload]
  );

  const moveImage = (collection: "references" | "supportingImages", index: number, direction: -1 | 1) => {
    setDraft((current) => {
      const next = [...current[collection]];
      const target = index + direction;
      if (target < 0 || target >= next.length) {
        return current;
      }
      const [item] = next.splice(index, 1);
      if (item !== undefined) {
        next.splice(target, 0, item);
      }
      return { ...current, [collection]: next };
    });
  };

  const submit = useCallback(async () => {
    setFieldErrors({});
    let request;
    try {
      request = buildStudioCreationRequest(draft);
    } catch (error) {
      if (error instanceof CreationDraftError) {
        setFieldErrors(error.fields);
        setSubmission({ status: "failure", safeMessage: error.message });
        return;
      }
      setSubmission({ status: "failure", safeMessage: "请求未通过本地契约验证。" });
      return;
    }
    setSubmission({ status: "submitting" });
    try {
      const result =
        request.kind === "generate"
          ? await gateway.invoke("studioGenerate", request)
          : await gateway.invoke("studioEdit", request);
      setSubmission({ status: "result", result });
    } catch (error) {
      setSubmission({
        status: "failure",
        safeMessage: error instanceof Error ? error.message : "本地请求未完成。"
      });
    }
  }, [draft, gateway]);

  const imageRows = useMemo(
    () => [
      { key: "references" as const, images: draft.references },
      { key: "supportingImages" as const, images: draft.supportingImages }
    ],
    [draft.references, draft.supportingImages]
  );

  const setInvariant = (key: keyof CreationDraft["invariants"], value: string) => {
    setDraft((current) => ({
      ...current,
      invariants: { ...current.invariants, [key]: lines(value) }
    }));
  };

  const modeUnavailable = !availability.edit;
  return (
    <section className="creation-workbench">
      <header className="creation-workbench__header">
        <p>{labels.eyebrow}</p>
        <h1 tabIndex={-1}>{labels.title}</h1>
        <span>{labels.subtitle}</span>
      </header>
      <div className="creation-mode" role="group" aria-label="Creation mode">
        <button
          type="button"
          aria-pressed={draft.mode === "generate"}
          onClick={() => setDraft((current) => ({ ...current, mode: "generate" }))}
        >
          {labels.generate}
        </button>
        <button
          type="button"
          aria-pressed={draft.mode === "edit"}
          disabled={modeUnavailable}
          title={modeUnavailable ? UNCONFIRMED_MESSAGE : undefined}
          onClick={() => setDraft((current) => ({ ...current, mode: "edit" }))}
        >
          {labels.edit}
        </button>
        {modeUnavailable ? <span>{UNCONFIRMED_MESSAGE}</span> : null}
      </div>
      <div className="creation-grid">
        <div className="creation-form">
          <label className="field field--prompt">
            <span>{labels.prompt}</span>
            <textarea
              value={draft.prompt}
              placeholder={labels.promptPlaceholder}
              onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
            />
            {fieldErrors["prompt"] ? <small role="alert">{fieldErrors["prompt"]}</small> : null}
          </label>

          <FileDropzone
            title={labels.references}
            purpose="reference"
            slot="reference"
            disabled={!availability.imageInput}
            labels={labels}
            onFiles={beginUpload}
          />
          {draft.references.map((image, index) => (
            <UploadCard
              key={image.id}
              image={image}
              index={index}
              count={draft.references.length}
              labels={labels}
              onRemove={() => removeImage(image)}
              onRetry={() => retryUpload(image)}
              onMove={(direction) => moveImage("references", index, direction)}
            />
          ))}

          {draft.mode === "edit" ? (
            <>
              <FileDropzone
                title={labels.target}
                purpose="target"
                slot="target"
                disabled={!availability.edit}
                labels={labels}
                onFiles={beginUpload}
              />
              {draft.target ? (
                <UploadCard
                  image={draft.target}
                  index={0}
                  count={1}
                  labels={labels}
                  onRemove={() => removeImage(draft.target!)}
                  onRetry={() => retryUpload(draft.target!)}
                  onMove={() => undefined}
                />
              ) : null}
              <FileDropzone
                title={labels.supporting}
                purpose="supporting"
                slot="supporting"
                disabled={!availability.edit}
                labels={labels}
                onFiles={beginUpload}
              />
              {imageRows[1]?.images.map((image, index) => (
                <UploadCard
                  key={image.id}
                  image={image}
                  index={index}
                  count={draft.supportingImages.length}
                  labels={labels}
                  onRemove={() => removeImage(image)}
                  onRetry={() => retryUpload(image)}
                  onMove={(direction) => moveImage("supportingImages", index, direction)}
                />
              ))}
              <div className="invariants-grid">
                {([
                  ["allowedChanges", labels.allowed],
                  ["preserve", labels.preserve],
                  ["forbiddenChanges", labels.forbidden]
                ] as const).map(([key, label]) => (
                  <label className="field" key={key}>
                    <span>{label}</span>
                    <textarea
                      value={draft.invariants[key].join("\n")}
                      onChange={(event) => setInvariant(key, event.target.value)}
                    />
                  </label>
                ))}
                <small>{labels.invariantHint}</small>
                {fieldErrors["invariants"] ? (
                  <small role="alert">{fieldErrors["invariants"]}</small>
                ) : null}
              </div>
            </>
          ) : null}
        </div>

        <aside className="creation-controls" aria-labelledby="creation-output-controls">
          <p>OUTPUT / 02</p>
          <h2 id="creation-output-controls">{labels.options}</h2>
          <div className="control-grid">
            <label className="field">
              <span>{labels.size}</span>
              <select
                value={draft.controls.size}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    controls: { ...current.controls, size: event.target.value }
                  }))
                }
              >
                <option value="auto">auto</option>
                <option value="1024x1024">1024×1024</option>
                <option value="1536x1024">1536×1024</option>
                <option value="1024x1536">1024×1536</option>
              </select>
            </label>
            <label className="field">
              <span>{labels.ratio}</span>
              <select
                value={draft.controls.aspectRatio}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    controls: { ...current.controls, aspectRatio: event.target.value }
                  }))
                }
              >
                <option value="auto">auto</option>
                <option value="square">1:1</option>
                <option value="landscape">landscape</option>
                <option value="portrait">portrait</option>
              </select>
            </label>
            <label className="field">
              <span>{labels.quality}</span>
              <select
                value={draft.controls.quality}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    controls: {
                      ...current.controls,
                      quality: event.target.value as CreationDraft["controls"]["quality"]
                    }
                  }))
                }
              >
                {['auto', 'low', 'medium', 'high'].map((value) => <option key={value}>{value}</option>)}
              </select>
            </label>
            <label className="field">
              <span>{labels.format}</span>
              <select
                value={draft.controls.format}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    controls: {
                      ...current.controls,
                      format: event.target.value as CreationDraft["controls"]["format"],
                      ...(event.target.value === "png" ? { compression: undefined } : {})
                    }
                  }))
                }
              >
                <option value="png">PNG</option>
                <option value="jpeg">JPEG</option>
                <option value="webp">WebP</option>
              </select>
            </label>
            <label className="field">
              <span>{labels.count}</span>
              <input
                type="number"
                min={1}
                max={4}
                value={draft.controls.count}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    controls: { ...current.controls, count: Number(event.target.value) }
                  }))
                }
              />
            </label>
            <label className="field">
              <span>{labels.compression}</span>
              <input
                type="number"
                min={0}
                max={100}
                disabled={draft.controls.format === "png"}
                value={draft.controls.compression ?? ""}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    controls: {
                      ...current.controls,
                      compression: event.target.value === "" ? undefined : Number(event.target.value)
                    }
                  }))
                }
              />
            </label>
            <label className="field">
              <span>{labels.partial}</span>
              <select value={draft.controls.partialImages} disabled>
                <option value={0}>0 · {UNCONFIRMED_MESSAGE}</option>
              </select>
            </label>
            <label className="field">
              <span>{labels.transparent}</span>
              <select value={draft.controls.transparentMode} disabled>
                <option value="off">off · {UNCONFIRMED_MESSAGE}</option>
              </select>
            </label>
            <label className="field">
              <span>{labels.moderation}</span>
              <select
                value={draft.controls.moderation}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    controls: {
                      ...current.controls,
                      moderation: event.target.value as CreationDraft["controls"]["moderation"]
                    }
                  }))
                }
              >
                <option value="auto">auto</option>
                <option value="low">low</option>
              </select>
            </label>
          </div>
          <label className="save-toggle">
            <input
              type="checkbox"
              checked={draft.controls.saveToLibrary}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  controls: { ...current.controls, saveToLibrary: event.target.checked }
                }))
              }
            />
            <span>{labels.save}</span>
          </label>
          <button
            className="creation-submit"
            type="button"
            disabled={submission.status === "submitting"}
            onClick={() => void submit()}
          >
            {submission.status === "submitting"
              ? labels.submitting
              : draft.mode === "edit"
                ? labels.submitEdit
                : labels.submit}
          </button>
          {submission.status === "failure" ? (
            <p className="creation-error" role="alert">
              {submission.safeMessage}
            </p>
          ) : null}
          {Object.entries(fieldErrors).map(([field, message]) =>
            field === "prompt" || field === "invariants" ? null : (
              <p className="creation-error" role="alert" key={field}>
                {message}
              </p>
            )
          )}
        </aside>
      </div>
      {submission.status === "result" ? (
        <ResultPanel
          gateway={gateway}
          result={submission.result}
          labels={labels}
          editAvailable={availability.edit}
          onRetry={() => void submit()}
          onEdit={(artifactId) => {
            setDraft(createEditHandoff(submission.result, artifactId));
            setSubmission({ status: "idle" });
            setFieldErrors({});
          }}
        />
      ) : null}
    </section>
  );
}
