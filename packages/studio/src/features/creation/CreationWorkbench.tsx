import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ReadSettingsResult,
  StudioImageOperationResult
} from "@routego-image/contracts";

import type { StudioGateway } from "../../api";
import { ProtectedImage } from "../../components";
import { useI18n } from "../../i18n";
import {
  buildStudioCreationRequest,
  CreationDraftError,
  createInitialCreationDraft,
  normalizeVisibleControls
} from "./draft";
import { describeCreationResult, describeCreationStreamFailure } from "./result";
import { consumeCreationStream } from "./stream";
import type { BatchDraftItem, CreationDraft, SubmissionState } from "./types";
import "./creation.css";

export function creationDefaultsFingerprint(
  defaults: ReadSettingsResult["defaults"]
): string {
  return JSON.stringify([
    defaults.size,
    defaults.aspectRatio,
    defaults.format,
    defaults.count,
    defaults.transparentMode
  ]);
}

export function synchronizeCreationDraftDefaults(
  draft: CreationDraft,
  defaults: ReadSettingsResult["defaults"],
  _resolve?: unknown
): CreationDraft {
  return {
    mode: "generate",
    prompt: draft.prompt,
    controls: {
      ...normalizeVisibleControls({
        ...draft.controls,
        size: defaults.size,
        aspectRatio: defaults.aspectRatio,
        format: defaults.format,
        count: defaults.count,
        transparentMode: defaults.transparentMode
      })
    }
  };
}

export function synchronizeBatchDraftDefaults(
  items: readonly BatchDraftItem[],
  defaults: ReadSettingsResult["defaults"],
  _resolve?: unknown
): readonly BatchDraftItem[] {
  const controls = normalizeVisibleControls({
    size: defaults.size,
    aspectRatio: defaults.aspectRatio,
    format: defaults.format,
    count: defaults.count,
    transparentMode: defaults.transparentMode
  });
  return items.map((item) => ({
    ...item,
    size: controls.size,
    aspectRatio: controls.aspectRatio,
    count: controls.count
  }));
}

const copy = {
  zh: {
    eyebrow: "CREATE / 01",
    title: "把想法放进显影盘",
    subtitle: "Studio 只提交提示词和可见输出控制；高级默认值由本地服务在验证后解析。",
    prompt: "提示词",
    promptPlaceholder: "描述画面、光线、构图和必须保留的细节...",
    options: "输出控制",
    size: "尺寸",
    ratio: "画幅",
    format: "格式",
    count: "数量",
    transparent: "透明",
    submit: "开始生成",
    submitting: "正在提交受保护请求...",
    streaming: "正在接收受保护的部分图像...",
    cancelStream: "取消当前请求",
    partialStream: "流式显影",
    result: "显影结果",
    effective: "实际参数",
    billing: "可能计费",
    output: "已收到输出",
    retryDraft: "以当前草稿再次提交",
    yes: "是",
    no: "否"
  },
  en: {
    eyebrow: "CREATE / 01",
    title: "Place the idea in the developer tray",
    subtitle: "Studio submits only prompt and visible output controls; advanced defaults resolve locally after validation.",
    prompt: "Prompt",
    promptPlaceholder: "Describe the scene, light, composition, and details that must remain...",
    options: "Output controls",
    size: "Size",
    ratio: "Aspect",
    format: "Format",
    count: "Count",
    transparent: "Transparency",
    submit: "Generate",
    submitting: "Submitting a protected request...",
    streaming: "Receiving protected partial images...",
    cancelStream: "Cancel current request",
    partialStream: "Streaming development",
    result: "Developed result",
    effective: "Effective parameters",
    billing: "May have billed",
    output: "Received output",
    retryDraft: "Submit the current draft again",
    yes: "Yes",
    no: "No"
  }
} as const;

type CreationLabels = { readonly [Key in keyof (typeof copy)["zh"]]: string };

function ResultPanel({
  gateway,
  result,
  labels
}: {
  readonly gateway: StudioGateway;
  readonly result: StudioImageOperationResult;
  readonly labels: CreationLabels;
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
      {presentation.manualRetryWarning ? (
        <>
          <p className="creation-result__warning" role="status">
            {presentation.manualRetryWarning}
          </p>
          <button className="studio-button" type="button" disabled>
            {labels.retryDraft}
          </button>
        </>
      ) : null}
      <div className="creation-result__artifacts">
        {artifacts.map((artifact) => (
          <article className="result-card" key={artifact.artifactId}>
            <ProtectedImage gateway={gateway} descriptor={artifact.resource} alt="Generated result" />
            <div className="result-card__meta">
              <span>{artifact.phase}</span>
              <span>{artifact.resource.mimeType}</span>
              <span>
                {artifact.resource.width} x {artifact.resource.height}
              </span>
            </div>
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
            {result.effectiveParams.size} · {result.effectiveParams.aspectRatio} ·{" "}
            {result.effectiveParams.format}
          </dd>
        </div>
      </dl>
      {result.failedSlots.map((slot) => (
        <p className="creation-result__error" key={slot.slot}>
          Slot {slot.slot}: {slot.error.safeMessage}
        </p>
      ))}
    </section>
  );
}

function StreamResultPanel({
  gateway,
  state,
  labels,
  onCancel
}: {
  readonly gateway: StudioGateway;
  readonly state: Extract<SubmissionState, { readonly status: "streaming" | "stream-failure" }>;
  readonly labels: CreationLabels;
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
          manualRetryWarning: undefined
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
      {presentation.manualRetryWarning ? (
        <>
          <p className="creation-result__warning" role="status">
            {presentation.manualRetryWarning}
          </p>
          <button className="studio-button" type="button" disabled>
            {labels.retryDraft}
          </button>
        </>
      ) : null}
      {state.partialArtifacts.length > 0 ? (
        <div className="creation-result__artifacts">
          {state.partialArtifacts.map((artifact) => (
            <article
              className="result-card"
              key={artifact.artifactId}
              data-resource-id={artifact.resource.resourceId}
              data-browser-object-url-cleanup="true"
              data-server-descriptor-revocation="false"
            >
              <ProtectedImage
                gateway={gateway}
                descriptor={artifact.resource}
                alt="Streamed partial result"
              />
              <time dateTime={artifact.resource.expiresAt}>{artifact.resource.expiresAt}</time>
            </article>
          ))}
        </div>
      ) : null}
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
      {state.status === "streaming" ? (
        <button className="studio-button" type="button" onClick={onCancel}>
          {labels.cancelStream}
        </button>
      ) : null}
    </section>
  );
}

export function CreationWorkbench({
  gateway,
  defaults
}: {
  readonly gateway: StudioGateway;
  readonly defaults: ReadSettingsResult["defaults"];
}) {
  const { language } = useI18n();
  const labels = copy[language];
  const defaultsFingerprint = creationDefaultsFingerprint(defaults);
  const appliedDefaultsFingerprintRef = useRef(defaultsFingerprint);
  const [draft, setDraft] = useState<CreationDraft>(() => createInitialCreationDraft(defaults));
  const [submission, setSubmission] = useState<SubmissionState>({ status: "idle" });
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const activeStreamRef = useRef<AbortController | undefined>(undefined);
  const mountedRef = useRef(true);

  const sizeOptions = useMemo(
    () => ["auto", "1024x1024", "1536x1024", "1024x1536"] as const,
    []
  );
  const aspectOptions = useMemo(
    () => ["auto", "square", "landscape", "portrait"] as const,
    []
  );
  const formatOptions = useMemo(() => ["png", "jpeg", "webp"] as const, []);
  const transparencyOptions = useMemo(
    () => ["off", "auto", "chromakey", "native"] as const,
    []
  );

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
    if (appliedDefaultsFingerprintRef.current === defaultsFingerprint) return;
    appliedDefaultsFingerprintRef.current = defaultsFingerprint;
    setDraft((current) => synchronizeCreationDraftDefaults(current, defaults));
  }, [defaults, defaultsFingerprint]);

  const patchControls = useCallback((controls: Partial<CreationDraft["controls"]>) => {
    setDraft((current) => ({
      ...current,
      controls: {
        ...current.controls,
        ...normalizeVisibleControls({ ...current.controls, ...controls })
      }
    }));
  }, []);

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
    abandonActiveStream();
    const controller = new AbortController();
    activeStreamRef.current = controller;
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
  }, [abandonActiveStream, draft, gateway]);

  return (
    <section className="creation-workbench">
      <header className="creation-workbench__header">
        <p>{labels.eyebrow}</p>
        <h1 tabIndex={-1}>{labels.title}</h1>
        <span>{labels.subtitle}</span>
      </header>
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
                  patchControls({
                    size: event.target.value as CreationDraft["controls"]["size"],
                    aspectRatio: event.target.value === "auto" ? draft.controls.aspectRatio : "auto"
                  })
                }
              >
                {sizeOptions.map((value) => (
                  <option value={value} key={value}>
                    {value}
                  </option>
                ))}
              </select>
              {fieldErrors["size"] ? <small role="alert">{fieldErrors["size"]}</small> : null}
            </label>
            <label className="field">
              <span>{labels.ratio}</span>
              <select
                value={draft.controls.aspectRatio}
                onChange={(event) =>
                  patchControls({
                    aspectRatio: event.target.value as CreationDraft["controls"]["aspectRatio"],
                    size: event.target.value === "auto" ? draft.controls.size : "auto"
                  })
                }
              >
                {aspectOptions.map((value) => (
                  <option value={value} key={value}>
                    {value === "square" ? "1:1" : value}
                  </option>
                ))}
              </select>
              {fieldErrors["aspectRatio"] ? (
                <small role="alert">{fieldErrors["aspectRatio"]}</small>
              ) : null}
            </label>
            <label className="field">
              <span>{labels.format}</span>
              <select
                value={draft.controls.format}
                onChange={(event) =>
                  patchControls({
                    format: event.target.value as CreationDraft["controls"]["format"],
                    transparentMode:
                      event.target.value === "png" ? draft.controls.transparentMode : "off"
                  })
                }
              >
                {formatOptions.map((value) => (
                  <option value={value} key={value}>
                    {value.toUpperCase()}
                  </option>
                ))}
              </select>
              {fieldErrors["format"] ? <small role="alert">{fieldErrors["format"]}</small> : null}
            </label>
            <label className="field">
              <span>{labels.count}</span>
              <input
                type="number"
                min={1}
                max={4}
                value={draft.controls.count}
                onChange={(event) =>
                  patchControls({
                    count: Number(event.target.value) as CreationDraft["controls"]["count"]
                  })
                }
              />
              {fieldErrors["count"] ? <small role="alert">{fieldErrors["count"]}</small> : null}
            </label>
            <label className="field">
              <span>{labels.transparent}</span>
              <select
                value={draft.controls.transparentMode}
                onChange={(event) =>
                  patchControls({
                    transparentMode: event.target
                      .value as CreationDraft["controls"]["transparentMode"],
                    format: event.target.value === "off" ? draft.controls.format : "png"
                  })
                }
              >
                {transparencyOptions.map((value) => (
                  <option value={value} key={value}>
                    {value}
                  </option>
                ))}
              </select>
              {fieldErrors["transparentMode"] ? (
                <small role="alert">{fieldErrors["transparentMode"]}</small>
              ) : null}
            </label>
          </div>
          <button
            className="creation-submit"
            type="button"
            disabled={submission.status === "submitting" || submission.status === "streaming"}
            onClick={() => void submit()}
          >
            {submission.status === "submitting" || submission.status === "streaming"
              ? labels.submitting
              : labels.submit}
          </button>
          {submission.status === "streaming" ? (
            <button className="studio-button" type="button" onClick={cancelActiveStream}>
              {labels.cancelStream}
            </button>
          ) : null}
          {submission.status === "failure" ? (
            <p className="creation-error" role="alert">
              {submission.safeMessage}
            </p>
          ) : null}
          {Object.entries(fieldErrors).map(([field, message]) =>
            field === "prompt" ||
            field === "size" ||
            field === "aspectRatio" ||
            field === "format" ||
            field === "count" ||
            field === "transparentMode" ? null : (
              <p className="creation-error" role="alert" key={field}>
                {message}
              </p>
            )
          )}
        </aside>
      </div>
      {submission.status === "result" ? (
        <ResultPanel gateway={gateway} result={submission.result} labels={labels} />
      ) : null}
      {submission.status === "streaming" || submission.status === "stream-failure" ? (
        <StreamResultPanel
          gateway={gateway}
          state={submission}
          labels={labels}
          onCancel={cancelActiveStream}
        />
      ) : null}
    </section>
  );
}
