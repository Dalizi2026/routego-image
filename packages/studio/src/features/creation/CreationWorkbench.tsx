import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent
} from "react";

import type {
  ReadSettingsResult,
  StudioImageOperationResult
} from "@routego-image/contracts";

import type { StudioGateway } from "../../api";
import { ProtectedImage, ProtectedResourceBoundary } from "../../components";
import { useI18n } from "../../i18n";
import {
  combineCapabilityDecisions,
  CreationCapabilityError,
  normalizeCreationDraftForCapabilities,
  UNCONFIRMED_CAPABILITY_MESSAGE,
  useCapabilityRegistry,
  validateCreationCapabilities,
  type CapabilityDecision,
  type CapabilityResolver
} from "../capabilities";
import {
  MaskEditor,
  type MaskPngUploadRequest,
  type MaskUploadLocator
} from "../mask";
import {
  BatchDraftError,
  buildStudioBatchRequest,
  cloneCreationDraft,
  createBatchDraftItem,
  moveBatchDraftItem
} from "./batch";
import { BatchEditor } from "./BatchEditor";
import {
  buildStudioCreationRequest,
  CreationDraftError,
  createEditHandoff,
  createInitialCreationDraft
} from "./draft";
import {
  describeCreationArtifactAvailability,
  describeCreationArtifactCleanup,
  describeCreationResult,
  describeCreationStreamFailure
} from "./result";
import { consumeCreationStream } from "./stream";
import {
  attachFinalizedMask,
  clearDraftMask,
  immediateMaskTarget,
  MaskIntegrationError,
  maskTargetIdentity,
  resolveMaskTarget,
  uploadMaskPng,
  validateMaskCapability,
  type ReadyMaskTarget
} from "./mask-integration";
import type {
  BatchDraftItem,
  BatchSubmissionState,
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

const UNCONFIRMED_MESSAGE = UNCONFIRMED_CAPABILITY_MESSAGE;

export function creationDefaultsFingerprint(
  defaults: ReadSettingsResult["defaults"]
): string {
  return JSON.stringify([
    defaults.model,
    defaults.size,
    defaults.aspectRatio,
    defaults.quality,
    defaults.format,
    defaults.count,
    defaults.partialImages,
    defaults.transparentMode,
    defaults.moderation,
    defaults.saveToLibrary
  ]);
}

export function synchronizeCreationDraftDefaults(
  draft: CreationDraft,
  defaults: ReadSettingsResult["defaults"],
  resolve: CapabilityResolver
): CreationDraft {
  const normalizedDefaults = normalizeCreationDraftForCapabilities(
    createInitialCreationDraft(defaults),
    resolve
  ).controls;
  return {
    ...draft,
    controls: {
      ...draft.controls,
      size: normalizedDefaults.size,
      aspectRatio: normalizedDefaults.aspectRatio,
      quality: normalizedDefaults.quality,
      format: normalizedDefaults.format,
      count: normalizedDefaults.count,
      partialImages: normalizedDefaults.partialImages,
      transparentMode: normalizedDefaults.transparentMode,
      moderation: normalizedDefaults.moderation,
      saveToLibrary: normalizedDefaults.saveToLibrary
    }
  };
}

export function synchronizeBatchDraftDefaults(
  items: readonly BatchDraftItem[],
  defaults: ReadSettingsResult["defaults"],
  resolve: CapabilityResolver
): readonly BatchDraftItem[] {
  return items.map((item) => ({
    ...item,
    draft: synchronizeCreationDraftDefaults(item.draft, defaults, resolve)
  }));
}

const copy = {
  zh: {
    eyebrow: "CREATE / 01",
    title: "把想法放进显影盘",
    subtitle: "提示词、参考图与输出参数始终保留为本地草稿；失败不会清空当前工作。",
    generate: "生成",
    edit: "编辑",
    singleWorkflow: "单项工作台",
    batchWorkflow: "批量队列",
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
    openMask: "打开遮罩编辑器",
    removeMask: "移除已保存遮罩",
    maskReady: "遮罩已绑定 TARGET[0]",
    maskLoading: "正在准备受保护目标图…",
    maskFailure: "目标图无法建立遮罩画布，请重试上传或更换目标。",
    maskNeedsTarget: "先添加并完成一张编辑目标图。",
    submit: "开始生成",
    submitEdit: "提交编辑",
    submitting: "正在提交受保护请求…",
    streaming: "正在接收受保护的部分图像…",
    cancelStream: "取消当前请求",
    partialStream: "流式显影",
    streamUnavailable: "受保护图像已过期或本地运行时不可用。",
    protectedUntil: "服务端描述符截止",
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
    no: "否",
    continuation: "连续编辑",
    previousResponse: "上一响应标识",
    retryAcknowledge: "我确认要创建一次新的明确请求",
    capabilityTitle: "能力证据",
    capabilityTransient: "最近探测失败，保留此前能力状态",
    handoffInvalid: "图库接力未提供稳定的受保护标识符，当前草稿未被替换。"
  },
  en: {
    eyebrow: "CREATE / 01",
    title: "Place the idea in the developer tray",
    subtitle: "Prompts, references, and output controls remain a local draft. Failures never clear current work.",
    generate: "Generate",
    edit: "Edit",
    singleWorkflow: "Single workbench",
    batchWorkflow: "Batch queue",
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
    openMask: "Open mask editor",
    removeMask: "Remove saved mask",
    maskReady: "Mask bound to TARGET[0]",
    maskLoading: "Preparing the protected target…",
    maskFailure: "The target could not create a mask canvas. Retry the upload or replace it.",
    maskNeedsTarget: "Add and finalize one edit target first.",
    submit: "Generate",
    submitEdit: "Submit edit",
    submitting: "Submitting a protected request…",
    streaming: "Receiving protected partial images…",
    cancelStream: "Cancel current request",
    partialStream: "Streaming development",
    streamUnavailable: "The protected image expired or the local runtime is unavailable.",
    protectedUntil: "Server descriptor until",
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
    no: "No",
    continuation: "Continuation",
    previousResponse: "Previous response ID",
    retryAcknowledge: "I understand this creates a new explicit request",
    capabilityTitle: "Capability evidence",
    capabilityTransient: "The latest probe failed; the previous capability state was preserved",
    handoffInvalid: "The Library handoff did not contain stable protected identifiers; the current draft was preserved."
  }
} as const;

type CreationLabels = { readonly [Key in keyof (typeof copy)["zh"]]: string };

export interface CreationExternalHandoff {
  readonly id: string;
  readonly draft: CreationDraft;
}

function isStableIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value)
  );
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isStableLibraryLocator(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("source" in value)) return false;
  if (value.source === "asset") {
    return (
      "assetId" in value &&
      isStableIdentifier(value.assetId) &&
      hasExactKeys(value, ["assetId", "source"])
    );
  }
  if (value.source === "artifact") {
    return (
      "artifactId" in value &&
      isStableIdentifier(value.artifactId) &&
      hasExactKeys(value, ["artifactId", "source"])
    );
  }
  return false;
}

function isIdentifierOnlyDraftImage(value: DraftImageInput): boolean {
  return (
    isStableIdentifier(value.id) &&
    value.upload === undefined &&
    value.resource === undefined &&
    isStableLibraryLocator(value.locator)
  );
}

export function isIdentifierOnlyCreationExternalHandoff(
  handoff: CreationExternalHandoff | undefined
): handoff is CreationExternalHandoff {
  if (handoff === undefined || !isStableIdentifier(handoff.id)) return false;
  const draft = handoff.draft;
  const images = [
    ...draft.references,
    ...(draft.target === undefined ? [] : [draft.target]),
    ...draft.supportingImages
  ];
  return (
    images.every(isIdentifierOnlyDraftImage) &&
    draft.maskUpload === undefined &&
    (draft.mask === undefined ||
      (draft.mask.targetSlot === 0 && isStableLibraryLocator(draft.mask.image)))
  );
}

export function shouldConsumeCreationExternalHandoff(
  handoff: CreationExternalHandoff | undefined,
  consumedId: string | undefined
): boolean {
  return (
    handoff !== undefined &&
    handoff.id !== consumedId &&
    isIdentifierOnlyCreationExternalHandoff(handoff)
  );
}

export function collectCreationDraftUploads(
  drafts: readonly CreationDraft[]
): readonly UploadLifecycleItem[] {
  const uploads = new Map<string, UploadLifecycleItem>();
  for (const draft of drafts) {
    const images = [
      ...draft.references,
      ...(draft.target === undefined ? [] : [draft.target]),
      ...draft.supportingImages
    ];
    for (const image of images) {
      if (image.upload !== undefined) uploads.set(image.upload.id, image.upload);
    }
    if (draft.maskUpload !== undefined) uploads.set(draft.maskUpload.id, draft.maskUpload);
  }
  return [...uploads.values()];
}

type MaskTargetState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly target: ReadyMaskTarget }
  | { readonly status: "failure"; readonly safeMessage: string };

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
  hint,
  labels,
  onFiles
}: {
  readonly title: string;
  readonly purpose: "reference" | "target" | "supporting";
  readonly slot: CreationInputSlot;
  readonly disabled: boolean;
  readonly hint?: string | undefined;
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
        <small>{disabled ? UNCONFIRMED_MESSAGE : hint ?? labels.dropHint}</small>
      </label>
    </div>
  );
}

function CapabilityHint({ decision }: { readonly decision: CapabilityDecision }) {
  return (
    <small
      className={`capability-hint capability-hint--${decision.state}`}
      data-capability={decision.capability}
    >
      <strong>{decision.state}</strong>
      <span>
        {decision.enabled
          ? decision.detail ?? "已由当前 provider/model 的作用域证据确认。"
          : decision.unavailableMessage}
      </span>
      {decision.transientFailure ? <em>{decision.transientFailure}</em> : null}
    </small>
  );
}

function CapabilityLedger({
  title,
  transientLabel,
  decisions
}: {
  readonly title: string;
  readonly transientLabel: string;
  readonly decisions: readonly CapabilityDecision[];
}) {
  return (
    <section className="capability-ledger" aria-labelledby="capability-ledger-title">
      <h3 id="capability-ledger-title">{title}</h3>
      <ul>
        {decisions.map((decision) => (
          <li key={decision.capability} data-state={decision.state}>
            <span>{decision.capability}</span>
            <strong>{decision.state}</strong>
            {decision.detail ? <small>{decision.detail}</small> : null}
            {decision.transientFailure ? (
              <small>
                {transientLabel}: {decision.transientFailure}
              </small>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ResultPanel({
  gateway,
  result,
  labels,
  editAvailable,
  retryAcknowledged,
  onRetry,
  onRetryAcknowledged,
  onEdit
}: {
  readonly gateway: StudioGateway;
  readonly result: StudioImageOperationResult;
  readonly labels: CreationLabels;
  readonly editAvailable: boolean;
  readonly retryAcknowledged: boolean;
  readonly onRetry: () => void;
  readonly onRetryAcknowledged: (value: boolean) => void;
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
        <label className="creation-result__warning">
          <span>{presentation.manualRetryWarning}</span>
          <span>
            <input
              type="checkbox"
              checked={retryAcknowledged}
              onChange={(event) => onRetryAcknowledged(event.target.checked)}
            />
            {labels.retryAcknowledge}
          </span>
        </label>
      ) : null}
      {result.failedSlots.map((slot) => (
        <p className="creation-result__error" key={slot.slot}>
          Slot {slot.slot}: {slot.error.safeMessage}
        </p>
      ))}
      <button
        className="studio-button"
        type="button"
        disabled={presentation.retryRequiresConfirmation && !retryAcknowledged}
        onClick={onRetry}
      >
        {labels.retryRequest}
      </button>
    </section>
  );
}

function StreamResultPanel({
  gateway,
  state,
  labels,
  retryAcknowledged,
  onRetry,
  onRetryAcknowledged,
  onCancel
}: {
  readonly gateway: StudioGateway;
  readonly state: Extract<SubmissionState, { readonly status: "streaming" | "stream-failure" }>;
  readonly labels: CreationLabels;
  readonly retryAcknowledged: boolean;
  readonly onRetry: () => void;
  readonly onRetryAcknowledged: (value: boolean) => void;
  readonly onCancel: () => void;
}) {
  const presentation =
    state.status === "stream-failure"
      ? describeCreationStreamFailure(state)
      : {
          tone: "partial" as const,
          title: labels.streaming,
          receivedAnyOutput: state.receivedAnyOutput,
          mayHaveBilled: state.mayHaveBilled,
          retryRequiresConfirmation: false
        };
  return (
    <section
      className={`creation-result creation-result--${presentation.tone}`}
      data-stream-state={state.status}
    >
      <div className="creation-result__heading">
        <p>{labels.partialStream}</p>
        <h2>{presentation.title}</h2>
      </div>
      {state.status === "stream-failure" ? (
        <p className="creation-result__error" role="alert">
          {state.safeMessage}
        </p>
      ) : null}
      <div className="creation-result__artifacts">
        {state.partialArtifacts.map((artifact) => {
          const availability = describeCreationArtifactAvailability(artifact.resource);
          const cleanup = describeCreationArtifactCleanup(artifact.resource);
          return (
            <article
              className="result-card"
              key={artifact.artifactId}
              data-resource-state={availability.status}
              data-resource-id={artifact.resource.resourceId}
              data-browser-object-url-cleanup={cleanup.revokeBrowserObjectUrlOnUnmount}
              data-server-descriptor-revocation={cleanup.revokeServerDescriptorOnClientCleanup}
            >
              <ProtectedResourceBoundary
                gateway={gateway}
                descriptor={artifact.resource}
                fallback={labels.streamUnavailable}
              >
                {(resource) => <img src={resource.url} alt="Streamed partial result" />}
              </ProtectedResourceBoundary>
              <div className="result-card__meta">
                <span>{artifact.phase}</span>
                <span>{artifact.resource.mimeType}</span>
                <span>
                  {artifact.resource.width} × {artifact.resource.height}
                </span>
                <time dateTime={availability.expiresAt}>
                  {labels.protectedUntil}: {availability.expiresAt}
                </time>
              </div>
            </article>
          );
        })}
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
      </dl>
      {state.status === "stream-failure" && presentation.manualRetryWarning ? (
        <label className="creation-result__warning">
          <span>{presentation.manualRetryWarning}</span>
          <span>
            <input
              type="checkbox"
              checked={retryAcknowledged}
              onChange={(event) => onRetryAcknowledged(event.target.checked)}
            />
            {labels.retryAcknowledge}
          </span>
        </label>
      ) : null}
      {state.status === "streaming" ? (
        <button className="studio-button" type="button" onClick={onCancel}>
          {labels.cancelStream}
        </button>
      ) : (
        <button
          className="studio-button"
          type="button"
          disabled={presentation.retryRequiresConfirmation && !retryAcknowledged}
          onClick={onRetry}
        >
          {labels.retryRequest}
        </button>
      )}
    </section>
  );
}

export function CreationWorkbench({
  gateway,
  defaults,
  externalHandoff
}: {
  readonly gateway: StudioGateway;
  readonly defaults: ReadSettingsResult["defaults"];
  readonly externalHandoff?: CreationExternalHandoff | undefined;
}) {
  const { language } = useI18n();
  const labels = copy[language];
  const { resolve } = useCapabilityRegistry();
  const singleImageDecision = resolve("single-image-input");
  const multiImageDecision = resolve("multi-image-input");
  const editDecision = resolve("target-edit");
  const maskDecision = resolve("mask-edit");
  const customSizeDecision = resolve("custom-size");
  const qualityDecision = resolve("quality-control");
  const outputFormatDecision = resolve("output-format");
  const compressionDecision = resolve("compression");
  const variantDecision = resolve("native-variants");
  const partialDecision = combineCapabilityDecisions("partial-images", [
    resolve("streaming"),
    resolve("partial-images")
  ]);
  const transparencyDecision = resolve("native-transparency");
  const moderationDecision = resolve("moderation");
  const responsesDecision = resolve("responses-state");
  const initialDraft = useMemo(
    () => normalizeCreationDraftForCapabilities(createInitialCreationDraft(defaults), resolve),
    [defaults, resolve]
  );
  const defaultsFingerprint = creationDefaultsFingerprint(defaults);
  const appliedDefaultsFingerprintRef = useRef(defaultsFingerprint);
  const [draft, setDraft] = useState<CreationDraft>(() => initialDraft);
  const [singleDraft, setSingleDraft] = useState<CreationDraft>(() => cloneCreationDraft(initialDraft));
  const [submission, setSubmission] = useState<SubmissionState>({ status: "idle" });
  const [retryAcknowledged, setRetryAcknowledged] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [workflow, setWorkflow] = useState<"single" | "batch">("single");
  const [batchItems, setBatchItems] = useState<readonly BatchDraftItem[]>(() => [
    createBatchDraftItem(initialDraft)
  ]);
  const [selectedBatchId, setSelectedBatchId] = useState(() => batchItems[0]!.id);
  const [batchConcurrency, setBatchConcurrency] = useState(3);
  const [batchSubmission, setBatchSubmission] = useState<BatchSubmissionState>({
    status: "idle"
  });
  const [maskEditorOpen, setMaskEditorOpen] = useState(false);
  const [maskTarget, setMaskTarget] = useState<MaskTargetState>({ status: "idle" });
  const draftRef = useRef(draft);
  const activeStreamRef = useRef<AbortController | undefined>(undefined);
  const mountedRef = useRef(true);
  const consumedExternalHandoffRef = useRef<string | undefined>(undefined);
  const maskSetupRef = useRef<HTMLDivElement>(null);
  const pendingMaskUploadRef = useRef<UploadLifecycleItem | undefined>(undefined);

  const abandonActiveStream = useCallback(() => {
    const active = activeStreamRef.current;
    activeStreamRef.current = undefined;
    active?.abort();
  }, []);

  const cancelActiveStream = useCallback(() => {
    activeStreamRef.current?.abort();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abandonActiveStream();
    };
  }, [abandonActiveStream]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    if (appliedDefaultsFingerprintRef.current === defaultsFingerprint) return;
    appliedDefaultsFingerprintRef.current = defaultsFingerprint;
    setDraft((current) => {
      const next = synchronizeCreationDraftDefaults(current, defaults, resolve);
      draftRef.current = next;
      return next;
    });
    setSingleDraft((current) =>
      synchronizeCreationDraftDefaults(current, defaults, resolve)
    );
    setBatchItems((current) => synchronizeBatchDraftDefaults(current, defaults, resolve));
  }, [defaults, defaultsFingerprint, resolve]);

  useEffect(() => {
    if (maskEditorOpen && maskTarget.status !== "ready") {
      maskSetupRef.current?.focus();
    }
  }, [maskEditorOpen, maskTarget.status]);

  useEffect(() => {
    if (workflow === "single") {
      setSingleDraft(cloneCreationDraft(draft));
    }
  }, [draft, workflow]);

  useEffect(() => {
    if (workflow !== "batch") return;
    setBatchItems((current) =>
      current.map((item) =>
        item.id === selectedBatchId ? { ...item, draft: cloneCreationDraft(draft) } : item
      )
    );
  }, [draft, selectedBatchId, workflow]);

  const patchUpload = useCallback((item: UploadLifecycleItem) => {
    setDraft((current) => updateImage(current, item.id, (image) => ({ ...image, upload: item })));
  }, []);

  const discardDetachedMaskUpload = useCallback(
    (item: UploadLifecycleItem | undefined) => {
      if (item === undefined) return;
      void discardUploadLifecycle(gateway, item, (next) => {
        if (pendingMaskUploadRef.current?.id === next.id) {
          pendingMaskUploadRef.current = next;
        }
      }).catch(() => undefined);
    },
    [gateway]
  );

  const discardMaskResources = useCallback(
    (saved: UploadLifecycleItem | undefined, pending: UploadLifecycleItem | undefined) => {
      const unique = new Map<string, UploadLifecycleItem>();
      if (saved !== undefined) unique.set(saved.id, saved);
      if (pending !== undefined) unique.set(pending.id, pending);
      unique.forEach(discardDetachedMaskUpload);
      pendingMaskUploadRef.current = undefined;
    },
    [discardDetachedMaskUpload]
  );

  const discardReplacedDraftResources = useCallback(
    (drafts: readonly CreationDraft[]) => {
      const uploads = new Map(
        collectCreationDraftUploads(drafts).map((item) => [item.id, item] as const)
      );
      const pending = pendingMaskUploadRef.current;
      if (pending !== undefined) uploads.set(pending.id, pending);
      uploads.forEach(discardDetachedMaskUpload);
      pendingMaskUploadRef.current = undefined;
    },
    [discardDetachedMaskUpload]
  );

  const resetMaskEditor = useCallback(() => {
    setMaskEditorOpen(false);
    setMaskTarget({ status: "idle" });
  }, []);

  useEffect(() => {
    if (externalHandoff === undefined || externalHandoff.id === consumedExternalHandoffRef.current) {
      return;
    }
    consumedExternalHandoffRef.current = externalHandoff.id;
    abandonActiveStream();
    if (!shouldConsumeCreationExternalHandoff(externalHandoff, undefined)) {
      setSubmission({
        status: "failure",
        safeMessage: labels.handoffInvalid
      });
      return;
    }
    discardReplacedDraftResources(
      workflow === "single" ? [draftRef.current] : [singleDraft]
    );
    resetMaskEditor();
    const next = normalizeCreationDraftForCapabilities(
      cloneCreationDraft(externalHandoff.draft),
      resolve
    );
    draftRef.current = next;
    setDraft(next);
    setSingleDraft(cloneCreationDraft(next));
    setWorkflow("single");
    setSubmission({ status: "idle" });
    setRetryAcknowledged(false);
    setFieldErrors({});
  }, [
    discardReplacedDraftResources,
    abandonActiveStream,
    externalHandoff,
    labels.handoffInvalid,
    resetMaskEditor,
    resolve,
    singleDraft,
    workflow
  ]);

  const clearMaskForTargetChange = useCallback(() => {
    const current = draftRef.current;
    discardMaskResources(current.maskUpload, pendingMaskUploadRef.current);
    resetMaskEditor();
  }, [discardMaskResources, resetMaskEditor]);

  const beginUpload = useCallback(
    (slot: CreationInputSlot, files: readonly File[]) => {
      if (!singleImageDecision.enabled) return;
      const currentPhysicalInputs =
        draft.references.length + draft.supportingImages.length + (draft.target === undefined ? 0 : 1);
      const evidenceLimit = multiImageDecision.record?.limits?.maxImages ?? 16;
      const maximumInputs = multiImageDecision.enabled ? evidenceLimit : 1;
      const replacementCredit = slot === "target" && draft.target !== undefined ? 1 : 0;
      const remaining = Math.max(0, maximumInputs - currentPhysicalInputs + replacementCredit);
      const accepted = slot === "target" ? files.slice(0, Math.min(1, remaining)) : files.slice(0, remaining);
      if (accepted.length === 0) return;
      if (slot === "target") {
        const previousTarget = draftRef.current.target;
        if (previousTarget?.upload !== undefined) {
          void discardUploadLifecycle(gateway, previousTarget.upload, patchUpload).catch(
            () => undefined
          );
        }
        clearMaskForTargetChange();
      }
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
        ...(slot === "target" ? clearDraftMask(current) : current),
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
    [
      draft.references.length,
      draft.supportingImages.length,
      draft.target,
      clearMaskForTargetChange,
      gateway,
      multiImageDecision.enabled,
      multiImageDecision.record?.limits?.maxImages,
      patchUpload,
      singleImageDecision.enabled
    ]
  );

  const removeImage = useCallback(
    (image: DraftImageInput) => {
      const removesTarget = draftRef.current.target?.id === image.id;
      if (image.upload !== undefined) {
        void discardUploadLifecycle(gateway, image.upload, patchUpload).catch(() => undefined);
      }
      if (removesTarget) {
        clearMaskForTargetChange();
      }
      setDraft((current) => ({
        ...(removesTarget ? clearDraftMask(current) : current),
        references: current.references.filter((item) => item.id !== image.id),
        target: current.target?.id === image.id ? undefined : current.target,
        supportingImages: current.supportingImages.filter((item) => item.id !== image.id)
      }));
    },
    [clearMaskForTargetChange, gateway, patchUpload]
  );

  const retryUpload = useCallback(
    (image: DraftImageInput) => {
      if (image.upload !== undefined) {
        if (draftRef.current.target?.id === image.id) {
          clearMaskForTargetChange();
          setDraft((current) => clearDraftMask(current));
        }
        void retryUploadLifecycle(gateway, image.upload, patchUpload).catch(() => undefined);
      }
    },
    [clearMaskForTargetChange, gateway, patchUpload]
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

  const openMaskEditor = useCallback(async () => {
    if (!maskDecision.enabled) return;
    const target = draftRef.current.target;
    const expectedKey = maskTargetIdentity(target);
    setMaskEditorOpen(true);
    if (target === undefined || expectedKey === undefined) {
      setMaskTarget({ status: "failure", safeMessage: labels.maskNeedsTarget });
      return;
    }
    setMaskTarget({ status: "loading" });
    try {
      const resolved = await resolveMaskTarget(gateway, target);
      if (
        draftRef.current.mode !== "edit" ||
        maskTargetIdentity(draftRef.current.target) !== expectedKey
      ) {
        resetMaskEditor();
        return;
      }
      if (resolved.resource !== undefined) {
        setDraft((current) =>
          maskTargetIdentity(current.target) === expectedKey && current.target !== undefined
            ? { ...current, target: { ...current.target, resource: resolved.resource } }
            : current
        );
      }
      setMaskTarget({ status: "ready", target: resolved });
    } catch (error) {
      setMaskTarget({
        status: "failure",
        safeMessage: error instanceof Error ? error.message : labels.maskFailure
      });
    }
  }, [gateway, labels.maskFailure, labels.maskNeedsTarget, maskDecision.enabled, resetMaskEditor]);

  const uploadMask = useCallback(
    async (request: MaskPngUploadRequest) => {
      if (maskTarget.status !== "ready") {
        throw new Error(labels.maskFailure);
      }
      const expectedKey = maskTarget.target.key;
      let latest: UploadLifecycleItem | undefined;
      const finalized = await uploadMaskPng(gateway, request, (item) => {
        latest = item;
        pendingMaskUploadRef.current = item;
      });
      if (maskTargetIdentity(draftRef.current.target) !== expectedKey) {
        discardDetachedMaskUpload(finalized.item);
        pendingMaskUploadRef.current = undefined;
        throw new Error(labels.maskFailure);
      }
      pendingMaskUploadRef.current = latest ?? finalized.item;
      return finalized.resource;
    },
    [discardDetachedMaskUpload, gateway, labels.maskFailure, maskTarget]
  );

  const saveMask = useCallback(
    (locator: MaskUploadLocator) => {
      const upload = pendingMaskUploadRef.current;
      if (upload === undefined || maskTarget.status !== "ready") {
        throw new Error(labels.maskFailure);
      }
      const current = draftRef.current;
      if (maskTargetIdentity(current.target) !== maskTarget.target.key) {
        discardDetachedMaskUpload(upload);
        pendingMaskUploadRef.current = undefined;
        throw new Error(labels.maskFailure);
      }
      const attached = attachFinalizedMask(current, locator, upload);
      const previous = current.maskUpload;
      draftRef.current = attached;
      setDraft(attached);
      pendingMaskUploadRef.current = undefined;
      if (previous !== undefined && previous.id !== upload.id) {
        discardDetachedMaskUpload(previous);
      }
    },
    [discardDetachedMaskUpload, labels.maskFailure, maskTarget]
  );

  const closeMaskEditor = useCallback(() => {
    const pending = pendingMaskUploadRef.current;
    if (pending !== undefined && pending.id !== draftRef.current.maskUpload?.id) {
      discardDetachedMaskUpload(pending);
    }
    pendingMaskUploadRef.current = undefined;
    resetMaskEditor();
  }, [discardDetachedMaskUpload, resetMaskEditor]);

  const handleMaskSetupKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMaskEditor();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        maskSetupRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [closeMaskEditor]
  );

  const removeMask = useCallback(() => {
    const current = draftRef.current;
    discardMaskResources(current.maskUpload, pendingMaskUploadRef.current);
    const cleared = clearDraftMask(current);
    draftRef.current = cleared;
    setDraft(cleared);
    resetMaskEditor();
  }, [discardMaskResources, resetMaskEditor]);

  const selectGenerateMode = useCallback(() => {
    const current = draftRef.current;
    discardMaskResources(current.maskUpload, pendingMaskUploadRef.current);
    resetMaskEditor();
    const next: CreationDraft = {
      ...clearDraftMask(current),
      mode: "generate",
      controls: {
        ...current.controls,
        action: current.controls.action === "edit" ? "auto" : current.controls.action
      }
    };
    draftRef.current = next;
    setDraft(next);
  }, [discardMaskResources, resetMaskEditor]);

  const submit = useCallback(async () => {
    setFieldErrors({});
    let request;
    try {
      validateMaskCapability(draft, maskDecision);
      validateCreationCapabilities(draft, resolve);
      request = buildStudioCreationRequest(draft);
    } catch (error) {
      if (
        error instanceof CreationDraftError ||
        error instanceof CreationCapabilityError ||
        error instanceof MaskIntegrationError
      ) {
        setFieldErrors(error.fields);
        setSubmission({ status: "failure", safeMessage: error.message });
        return;
      }
      setSubmission({ status: "failure", safeMessage: "请求未通过本地契约验证。" });
      return;
    }
    abandonActiveStream();
    const controller = new AbortController();
    activeStreamRef.current = controller;
    setRetryAcknowledged(false);
    await consumeCreationStream(gateway, request, {
      signal: controller.signal,
      onState: (state) => {
        if (mountedRef.current && activeStreamRef.current === controller) {
          setSubmission(state);
        }
      }
    });
    if (activeStreamRef.current === controller) {
      activeStreamRef.current = undefined;
    }
  }, [abandonActiveStream, draft, gateway, maskDecision, resolve]);

  const selectBatchItem = useCallback((item: BatchDraftItem) => {
    setSelectedBatchId(item.id);
    setDraft(cloneCreationDraft(item.draft));
    setFieldErrors({});
    setSubmission({ status: "idle" });
  }, []);

  const addBatchItem = useCallback(() => {
    if (batchItems.length >= 20) return;
    const item = createBatchDraftItem(
      normalizeCreationDraftForCapabilities(createInitialCreationDraft(defaults), resolve)
    );
    setBatchItems((current) => [...current, item]);
    selectBatchItem(item);
  }, [batchItems.length, defaults, resolve, selectBatchItem]);

  const removeBatchItem = useCallback(
    (item: BatchDraftItem) => {
      if (batchItems.length <= 1) return;
      discardDetachedMaskUpload(item.draft.maskUpload);
      const index = batchItems.findIndex((candidate) => candidate.id === item.id);
      const next = batchItems.filter((candidate) => candidate.id !== item.id);
      const nextSelection = next[Math.min(index, next.length - 1)] ?? next[0];
      setBatchItems(next);
      if (item.id === selectedBatchId && nextSelection !== undefined) {
        selectBatchItem(nextSelection);
      }
    },
    [batchItems, discardDetachedMaskUpload, selectedBatchId, selectBatchItem]
  );

  const submitBatch = useCallback(async () => {
    setFieldErrors({});
    try {
      batchItems.forEach((item, index) => {
        try {
          validateMaskCapability(item.draft, resolve("mask-edit"));
          validateCreationCapabilities(item.draft, resolve);
        } catch (error) {
          if (
            error instanceof CreationCapabilityError ||
            error instanceof MaskIntegrationError
          ) {
            throw new BatchDraftError(`批量任务第 ${index + 1} 项被能力证据阻止。`, {
              taskId: item.id,
              fields: error.fields
            });
          }
          throw error;
        }
      });
      const request = buildStudioBatchRequest(batchItems, batchConcurrency);
      setBatchSubmission({ status: "submitting", taskIds: request.tasks.map((task) => task.id) });
      const result = await gateway.invoke("studioBatch", request);
      setBatchSubmission({ status: "result", result, replayAcknowledged: false });
    } catch (error) {
      if (error instanceof BatchDraftError) {
        setFieldErrors(error.fields);
        setBatchSubmission({ status: "failure", safeMessage: error.message });
        return;
      }
      setBatchSubmission({
        status: "failure",
        safeMessage: error instanceof Error ? error.message : "批量请求未完成。"
      });
    }
  }, [batchConcurrency, batchItems, gateway, resolve]);

  const switchWorkflow = useCallback(
    (next: "single" | "batch") => {
      if (next === workflow) return;
      abandonActiveStream();
      setWorkflow(next);
      setFieldErrors({});
      setSubmission({ status: "idle" });
      if (next === "batch") {
        setSingleDraft(cloneCreationDraft(draft));
        const selected = batchItems.find((item) => item.id === selectedBatchId) ?? batchItems[0];
        if (selected !== undefined) setDraft(cloneCreationDraft(selected.draft));
      } else {
        setDraft(cloneCreationDraft(singleDraft));
      }
    },
    [abandonActiveStream, batchItems, draft, selectedBatchId, singleDraft, workflow]
  );

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

  const modeUnavailable = !editDecision.enabled;
  const physicalInputs =
    draft.references.length + draft.supportingImages.length + (draft.target === undefined ? 0 : 1);
  const referenceDisabled =
    !singleImageDecision.enabled || (!multiImageDecision.enabled && physicalInputs >= 1);
  const targetDisabled =
    !editDecision.enabled ||
    !singleImageDecision.enabled ||
    (!multiImageDecision.enabled && physicalInputs >= 1 && draft.target === undefined);
  const supportingDisabled =
    !editDecision.enabled || !singleImageDecision.enabled || !multiImageDecision.enabled;
  const allowedSizes = customSizeDecision.record?.limits?.supportedSizes;
  const sizeOptions = customSizeDecision.enabled
    ? ["auto", "1024x1024", "1536x1024", "1024x1536"].filter(
        (value) => value === "auto" || allowedSizes === undefined || allowedSizes.includes(value)
      )
    : ["auto"];
  const aspectOptions = customSizeDecision.enabled
    ? (["auto", "square", "landscape", "portrait"] as const)
    : (["auto"] as const);
  const allowedQualities = qualityDecision.record?.limits?.supportedQualities;
  const qualityOptions = qualityDecision.enabled
    ? (["auto", "low", "medium", "high"] as const).filter(
        (value) =>
          value === "auto" || allowedQualities === undefined || allowedQualities.includes(value)
      )
    : (["auto"] as const);
  const allowedFormats = outputFormatDecision.record?.limits?.supportedFormats;
  const formatOptions = outputFormatDecision.enabled
    ? (["png", "jpeg", "webp"] as const).filter(
        (value) => value === "png" || allowedFormats === undefined || allowedFormats.includes(value)
      )
    : (["png"] as const);
  const variantMaximum = Math.min(4, variantDecision.record?.limits?.maxVariants ?? 4);
  const partialMaximum = partialDecision.enabled
    ? Math.min(3, partialDecision.record?.limits?.maxPartialImages ?? 3)
    : 0;
  const moderationOptions = moderationDecision.enabled
    ? (["auto", "low"] as const)
    : (["auto"] as const);
  const continuationOptions = responsesDecision.enabled
    ? draft.mode === "edit"
      ? (["auto", "generate", "edit"] as const)
      : (["auto", "generate"] as const)
    : (["auto"] as const);
  const transparencyOptions =
    transparencyDecision.state === "supported"
      ? (["off", "auto", "chromakey", "native"] as const)
      : transparencyDecision.state === "degraded"
        ? (["off", "auto", "chromakey"] as const)
        : (["off"] as const);
  const preparedMaskTarget = immediateMaskTarget(draft.target);
  const canPrepareMaskTarget =
    preparedMaskTarget !== undefined || draft.target?.locator?.source === "asset";
  const maskActionDisabled = !maskDecision.enabled || !canPrepareMaskTarget;
  const capabilityDecisions = [
    singleImageDecision,
    multiImageDecision,
    editDecision,
    maskDecision,
    customSizeDecision,
    qualityDecision,
    outputFormatDecision,
    compressionDecision,
    variantDecision,
    partialDecision,
    transparencyDecision,
    moderationDecision,
    responsesDecision
  ];
  return (
    <section className="creation-workbench">
      <header className="creation-workbench__header">
        <p>{labels.eyebrow}</p>
        <h1 tabIndex={-1}>{labels.title}</h1>
        <span>{labels.subtitle}</span>
      </header>
      <div className="creation-workflow" role="group" aria-label="Creation workflow">
        <button
          type="button"
          aria-pressed={workflow === "single"}
          onClick={() => switchWorkflow("single")}
        >
          {labels.singleWorkflow}
        </button>
        <button
          type="button"
          aria-pressed={workflow === "batch"}
          onClick={() => switchWorkflow("batch")}
        >
          {labels.batchWorkflow}
        </button>
      </div>
      {workflow === "batch" ? (
        <BatchEditor
          items={batchItems}
          selectedId={selectedBatchId}
          concurrency={batchConcurrency}
          submission={batchSubmission}
          onSelect={selectBatchItem}
          onAdd={addBatchItem}
          onRemove={removeBatchItem}
          onMove={(itemId, direction) =>
            setBatchItems((current) => moveBatchDraftItem(current, itemId, direction))
          }
          onConcurrencyChange={(value) =>
            setBatchConcurrency(Number.isFinite(value) ? Math.min(10, Math.max(1, value)) : 1)
          }
          onReplayAcknowledged={(value) =>
            setBatchSubmission((current) =>
              current.status === "result" ? { ...current, replayAcknowledged: value } : current
            )
          }
          onSubmit={() => void submitBatch()}
        />
      ) : null}
      <div className="creation-mode" role="group" aria-label="Creation mode">
        <button
          type="button"
          aria-pressed={draft.mode === "generate"}
          onClick={selectGenerateMode}
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
            disabled={referenceDisabled}
            hint={
              singleImageDecision.state === "degraded"
                ? singleImageDecision.detail
                : undefined
            }
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
                disabled={targetDisabled}
                hint={editDecision.state === "degraded" ? editDecision.detail : undefined}
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
              <section className="mask-workbench" aria-labelledby="mask-workbench-title">
                <div className="mask-workbench__heading">
                  <div>
                    <p>MASK / TARGET[0]</p>
                    <h3 id="mask-workbench-title">{labels.openMask}</h3>
                  </div>
                  {draft.mask !== undefined ? (
                    <span className="mask-workbench__ready" role="status">
                      {labels.maskReady}
                    </span>
                  ) : null}
                </div>
                <div className="mask-workbench__actions">
                  <button
                    type="button"
                    disabled={maskActionDisabled}
                    title={
                      !maskDecision.enabled
                        ? UNCONFIRMED_MESSAGE
                        : !canPrepareMaskTarget
                          ? labels.maskNeedsTarget
                          : undefined
                    }
                    onClick={() => void openMaskEditor()}
                  >
                    {labels.openMask}
                  </button>
                  {draft.mask !== undefined ? (
                    <button type="button" onClick={removeMask}>
                      {labels.removeMask}
                    </button>
                  ) : null}
                </div>
                {!canPrepareMaskTarget ? <small>{labels.maskNeedsTarget}</small> : null}
                <CapabilityHint decision={maskDecision} />
                {fieldErrors["mask"] ? <small role="alert">{fieldErrors["mask"]}</small> : null}
              </section>
              <FileDropzone
                title={labels.supporting}
                purpose="supporting"
                slot="supporting"
                disabled={supportingDisabled}
                hint={multiImageDecision.state === "degraded" ? multiImageDecision.detail : undefined}
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
                disabled={!customSizeDecision.enabled}
                title={customSizeDecision.enabled ? undefined : UNCONFIRMED_MESSAGE}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    controls: { ...current.controls, size: event.target.value }
                  }))
                }
              >
                {sizeOptions.map((value) => (
                  <option value={value} key={value}>
                    {value}
                  </option>
                ))}
              </select>
              <CapabilityHint decision={customSizeDecision} />
            </label>
            <label className="field">
              <span>{labels.ratio}</span>
              <select
                value={draft.controls.aspectRatio}
                disabled={!customSizeDecision.enabled}
                title={customSizeDecision.enabled ? undefined : UNCONFIRMED_MESSAGE}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    controls: { ...current.controls, aspectRatio: event.target.value }
                  }))
                }
              >
                {aspectOptions.map((value) => (
                  <option value={value} key={value}>
                    {value === "square" ? "1:1" : value}
                  </option>
                ))}
              </select>
              <CapabilityHint decision={customSizeDecision} />
            </label>
            <label className="field">
              <span>{labels.quality}</span>
              <select
                value={draft.controls.quality}
                disabled={!qualityDecision.enabled}
                title={qualityDecision.enabled ? undefined : UNCONFIRMED_MESSAGE}
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
                {qualityOptions.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
              <CapabilityHint decision={qualityDecision} />
            </label>
            <label className="field">
              <span>{labels.format}</span>
              <select
                value={draft.controls.format}
                disabled={!outputFormatDecision.enabled}
                title={outputFormatDecision.enabled ? undefined : UNCONFIRMED_MESSAGE}
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
                {formatOptions.map((value) => (
                  <option value={value} key={value}>
                    {value.toUpperCase()}
                  </option>
                ))}
              </select>
              <CapabilityHint decision={outputFormatDecision} />
            </label>
            <label className="field">
              <span>{labels.count}</span>
              <input
                type="number"
                min={1}
                max={variantMaximum}
                disabled={!variantDecision.enabled}
                title={variantDecision.enabled ? undefined : UNCONFIRMED_MESSAGE}
                value={draft.controls.count}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    controls: { ...current.controls, count: Number(event.target.value) }
                  }))
                }
              />
              <CapabilityHint decision={variantDecision} />
            </label>
            <label className="field">
              <span>{labels.compression}</span>
              <input
                type="number"
                min={0}
                max={100}
                disabled={!compressionDecision.enabled || draft.controls.format === "png"}
                title={compressionDecision.enabled ? undefined : UNCONFIRMED_MESSAGE}
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
              <CapabilityHint decision={compressionDecision} />
            </label>
            <label className="field">
              <span>{labels.partial}</span>
              <select
                value={draft.controls.partialImages}
                disabled={!partialDecision.enabled}
                title={partialDecision.enabled ? undefined : UNCONFIRMED_MESSAGE}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    controls: { ...current.controls, partialImages: Number(event.target.value) }
                  }))
                }
              >
                {Array.from({ length: partialMaximum + 1 }, (_, value) => (
                  <option value={value} key={value}>
                    {value}
                  </option>
                ))}
              </select>
              <CapabilityHint decision={partialDecision} />
            </label>
            <label className="field">
              <span>{labels.transparent}</span>
              <select
                value={draft.controls.transparentMode}
                disabled={!transparencyDecision.enabled}
                title={transparencyDecision.enabled ? undefined : UNCONFIRMED_MESSAGE}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    controls: {
                      ...current.controls,
                      transparentMode: event.target.value as CreationDraft["controls"]["transparentMode"],
                      format: event.target.value === "off" ? current.controls.format : "png"
                    }
                  }))
                }
              >
                {transparencyOptions.map((value) => (
                  <option value={value} key={value}>
                    {value}
                  </option>
                ))}
              </select>
              <CapabilityHint decision={transparencyDecision} />
            </label>
            <label className="field">
              <span>{labels.moderation}</span>
              <select
                value={draft.controls.moderation}
                disabled={!moderationDecision.enabled}
                title={moderationDecision.enabled ? undefined : UNCONFIRMED_MESSAGE}
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
                {moderationOptions.map((value) => (
                  <option value={value} key={value}>
                    {value}
                  </option>
                ))}
              </select>
              <CapabilityHint decision={moderationDecision} />
            </label>
            <label className="field">
              <span>{labels.continuation}</span>
              <select
                value={draft.controls.action}
                disabled={!responsesDecision.enabled}
                title={responsesDecision.enabled ? undefined : UNCONFIRMED_MESSAGE}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    controls: {
                      ...current.controls,
                      action: event.target.value as CreationDraft["controls"]["action"]
                    }
                  }))
                }
              >
                {continuationOptions.map((value) => (
                  <option value={value} key={value}>
                    {value}
                  </option>
                ))}
              </select>
              <CapabilityHint decision={responsesDecision} />
            </label>
            <label className="field">
              <span>{labels.previousResponse}</span>
              <input
                value={draft.controls.previousResponseId ?? ""}
                disabled={!responsesDecision.enabled}
                title={responsesDecision.enabled ? undefined : UNCONFIRMED_MESSAGE}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    controls: {
                      ...current.controls,
                      previousResponseId: event.target.value.trim() || undefined
                    }
                  }))
                }
              />
              <CapabilityHint decision={responsesDecision} />
            </label>
          </div>
          <CapabilityLedger
            title={labels.capabilityTitle}
            transientLabel={labels.capabilityTransient}
            decisions={capabilityDecisions}
          />
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
          {workflow === "single" ? (
            <>
              <button
                className="creation-submit"
                type="button"
                disabled={submission.status === "submitting" || submission.status === "streaming"}
                onClick={() => void submit()}
              >
                {submission.status === "submitting" || submission.status === "streaming"
                  ? labels.submitting
                  : draft.mode === "edit"
                    ? labels.submitEdit
                    : labels.submit}
              </button>
              {submission.status === "submitting" ? (
                <button className="studio-button" type="button" onClick={cancelActiveStream}>
                  {labels.cancelStream}
                </button>
              ) : null}
            </>
          ) : null}
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
      {workflow === "single" && submission.status === "result" ? (
        <ResultPanel
          gateway={gateway}
          result={submission.result}
          labels={labels}
          editAvailable={editDecision.enabled}
          retryAcknowledged={retryAcknowledged}
          onRetry={() => void submit()}
          onRetryAcknowledged={setRetryAcknowledged}
          onEdit={(artifactId) => {
            discardMaskResources(draftRef.current.maskUpload, pendingMaskUploadRef.current);
            resetMaskEditor();
            const next = createEditHandoff(submission.result, artifactId);
            draftRef.current = next;
            setDraft(next);
            setSubmission({ status: "idle" });
            setFieldErrors({});
          }}
        />
      ) : null}
      {workflow === "single" &&
      (submission.status === "streaming" || submission.status === "stream-failure") ? (
        <StreamResultPanel
          gateway={gateway}
          state={submission}
          labels={labels}
          retryAcknowledged={retryAcknowledged}
          onRetry={() => void submit()}
          onRetryAcknowledged={setRetryAcknowledged}
          onCancel={cancelActiveStream}
        />
      ) : null}
      {maskEditorOpen ? (
        maskTarget.status === "ready" ? (
          <MaskEditor
            gateway={gateway}
            {...(maskTarget.target.resource === undefined
              ? {}
              : { target: maskTarget.target.resource })}
            {...(maskTarget.target.blob === undefined
              ? {}
              : { targetBlob: maskTarget.target.blob })}
            targetSize={maskTarget.target.size}
            targetKey={maskTarget.target.key}
            targetAlt={labels.target}
            capability={maskDecision.state}
            language={language === "zh" ? "zh-CN" : "en"}
            onUploadMask={uploadMask}
            onSave={saveMask}
            onClose={closeMaskEditor}
          />
        ) : (
          <div
            ref={maskSetupRef}
            className="mask-setup-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mask-setup-title"
            aria-busy={maskTarget.status === "loading"}
            tabIndex={-1}
            onKeyDown={handleMaskSetupKeyDown}
          >
            <section className="mask-setup-panel">
              <p>MASK / TARGET[0]</p>
              <h2 id="mask-setup-title">{labels.openMask}</h2>
              <p role={maskTarget.status === "failure" ? "alert" : "status"}>
                {maskTarget.status === "loading"
                  ? labels.maskLoading
                  : maskTarget.status === "failure"
                    ? maskTarget.safeMessage
                    : labels.maskNeedsTarget}
              </p>
              <div>
                {maskTarget.status === "failure" ? (
                  <button type="button" onClick={() => void openMaskEditor()}>
                    {labels.retry}
                  </button>
                ) : null}
                <button type="button" onClick={closeMaskEditor}>
                  {labels.remove}
                </button>
              </div>
            </section>
          </div>
        )
      ) : null}
    </section>
  );
}
