import { useEffect, useState, type FormEvent } from "react";

import type { ReadSettingsResult } from "@routego-image/contracts";

import type { StudioGateway } from "../../api";
import { useI18n } from "../../i18n";
import {
  configurableRatios,
  normalizeCustomAspectRatio,
  normalizedRatio,
  ratioForImageSize,
  resolutionTiers,
  suggestedTierForSize,
  sizeForTier,
  tierForSize,
  type ConfigurableRatio,
  type ResolutionTier
} from "./image-size-policy";
import { SettingsFormError, buildDefaultsSettingsInput } from "./state";
import type { SettingsAsyncState } from "./types";
import "./settings.css";

const options = {
  ratio: [
    ["auto", "自动"],
    ["1:1", "1:1 方形"],
    ["4:3", "4:3 横向"],
    ["3:4", "3:4 竖向"],
    ["16:9", "16:9 宽屏"],
    ["9:16", "9:16 竖屏"]
  ],
  transparent: [
    ["off", "不透明：保留普通背景"],
    ["auto", "自动：由服务决定是否处理透明"],
    ["chromakey", "色键去背：生成纯色背景，便于后续去除"],
    ["native", "原生透明：仅在当前模型支持时可用"]
  ],
  responseTimeout: [
    [30_000, "30 秒"],
    [60_000, "1 分钟"],
    [120_000, "2 分钟"],
    [180_000, "3 分钟"],
    [300_000, "5 分钟（默认）"],
    [600_000, "10 分钟"]
  ]
} as const;

const copy = {
  zh: {
    eyebrow: "CODEX DEFAULTS / 01",
    title: "为 Codex 设定默认出图参数",
    body: "在 Codex 对话里直接描述图片并开始生成；这里保存的参数会在你没有特别说明时自动使用。",
    onboardingEyebrow: "开始使用 / 2 OF 3",
    onboardingTitle: "确认 Codex 默认出图参数",
    onboardingBody: "这些设置会在你没有特别说明时自动用于后续生成。",
    onboardingSave: "保存并完成设置",
    onboardingSaved: "第 3 步：回到 Codex 对话，直接描述你想生成的图片即可。",
    onboardingPreviewBody: "这是新手引导预览，不会修改已保存的默认参数。",
    onboardingPreviewSave: "结束引导预览",
    onboardingPreviewSaved: "第 3 步：回到 Codex 对话开始生成。引导预览已结束，原有设置没有改动。",
    provider: "当前服务商",
    model: "当前模型",
    modelHint: "从当前供应商已保存或已获取的模型中选择；保存后会用于后续请求。",
    ratio: "图片比例",
    size: "清晰度",
    transparent: "背景透明",
    quality: "质量",
    format: "文件格式",
    count: "默认张数",
    customRatio: "自定义比例",
    customRatioPlaceholder: "例如 5:4",
    customRatioHint: "按当前清晰度自动换算为",
    customRatioError: "请输入 1:1 到 3:1 范围内的正整数比例，例如 5:4。",
    responseTimeout: "响应等待上限",
    responseTimeoutHint: "控制 Routego 等待服务商响应的最长时间。服务商自身更短的超时无法由此延长。",
    currentConfiguration: "当前配置",
    imageSize: "图像尺寸",
    outputOptions: "输出选项",
    configurationStatus: "配置状态",
    configured: "已配置",
    incomplete: "待完善",
    save: "保存并作为 Codex 默认值",
    saving: "正在保存设置…",
    saved: "已保存。之后在 Codex 对话生图将默认使用这些参数。",
    failed: "设置未保存，请检查选项后重试。",
    nativeHint: "原生透明需要服务商明确支持；当前配置使用安全默认值。",
    resolutionHint: "选择 1K、2K 或 4K 后，插件会直接把所选的精确像素尺寸发送给上游。"
  },
  en: {
    eyebrow: "CODEX DEFAULTS / 01",
    title: "Set Codex image defaults",
    body: "Create images by describing them in Codex. These saved values are used whenever a request does not override them.",
    onboardingEyebrow: "GET STARTED / 2 OF 3",
    onboardingTitle: "Confirm Codex image defaults",
    onboardingBody: "These values will be used for future image requests unless a request overrides them.",
    onboardingSave: "Save and finish setup",
    onboardingSaved: "Step 3: Return to Codex and describe the image you want to create.",
    onboardingPreviewBody: "This onboarding preview does not change your saved image defaults.",
    onboardingPreviewSave: "Finish onboarding preview",
    onboardingPreviewSaved: "Step 3: Return to Codex to create an image. The onboarding preview ended without changing your saved settings.",
    provider: "Active provider",
    model: "Active model",
    modelHint: "Choose from models saved or fetched for the active provider. Saving applies it to future requests.",
    ratio: "Aspect ratio",
    size: "Resolution tier",
    transparent: "Transparent background",
    quality: "Quality",
    format: "Format",
    count: "Default outputs",
    customRatio: "Custom aspect ratio",
    customRatioPlaceholder: "For example, 5:4",
    customRatioHint: "Calculated at this resolution as",
    customRatioError: "Enter a positive integer ratio from 1:1 to 3:1, such as 5:4.",
    responseTimeout: "Response wait limit",
    responseTimeoutHint: "This is Routego's maximum wait for a provider response. It cannot extend an earlier timeout imposed by the provider itself.",
    currentConfiguration: "Current configuration",
    imageSize: "Image size",
    outputOptions: "Output options",
    configurationStatus: "Configuration status",
    configured: "Configured",
    incomplete: "Needs attention",
    save: "Save as Codex defaults",
    saving: "Saving settings…",
    saved: "Saved. Future Codex image requests will use these defaults unless overridden.",
    failed: "Settings were not saved. Check the options and try again.",
    nativeHint: "Native transparency requires explicit provider support; the current setup keeps a safe default.",
    resolutionHint: "Routego sends the exact selected pixel dimensions for the chosen 1K, 2K, or 4K aspect ratio."
  }
} as const;

export function GenerationDefaultsPanel({
  gateway,
  settings,
  onSettingsChange,
  onboardingPreview = false,
  onOnboardingComplete
}: {
  readonly gateway: StudioGateway;
  readonly settings: ReadSettingsResult;
  readonly onSettingsChange: (settings: ReadSettingsResult) => void;
  readonly onboardingPreview?: boolean;
  readonly onOnboardingComplete?: (() => void) | undefined;
}) {
  const { language } = useI18n();
  const labels = copy[language];
  const [draft, setDraft] = useState(settings.defaults);
  const [resolutionTier, setResolutionTier] = useState(() =>
    tierForSize(settings.defaults.size) ?? suggestedTierForSize(settings.defaults.size)
  );
  const [customRatio, setCustomRatio] = useState(() =>
    normalizeCustomAspectRatio(settings.defaults.aspectRatio) ?? ratioForImageSize(settings.defaults.size) ?? "1:1"
  );
  const [customRatioSelected, setCustomRatioSelected] = useState(() =>
    settings.defaults.aspectRatio !== "auto" && !configurableRatios.includes(settings.defaults.aspectRatio as ConfigurableRatio)
  );
  const [state, setState] = useState<SettingsAsyncState>({ status: "idle" });
  const active = settings.profiles.find((item) => item.id === settings.activeProviderId && item.isActive);
  const selectableModels = [...new Set([
    ...(active?.models ?? []),
    ...(active?.defaultModel === undefined ? [] : [active.defaultModel]),
    ...(draft.model === undefined ? [] : [draft.model])
  ])];
  const responseTimeoutMs = draft.responseTimeoutMs ?? 300_000;
  const selectedModel = draft.model ?? active?.defaultModel ?? "—";
  const configurationReady = active?.hasApiKey === true && selectedModel !== "—";
  const summarySize = draft.size === "auto" ? (language === "zh" ? "自动尺寸" : "Auto size") : draft.size.replace("x", " × ");
  const outputCount = language === "zh" ? `${draft.count} 张` : `${draft.count} output${draft.count === 1 ? "" : "s"}`;
  const validCustomRatio = normalizeCustomAspectRatio(customRatio);
  const selectedAspectRatio = customRatioSelected ? validCustomRatio : normalizedRatio(draft.aspectRatio);
  const calculatedCustomSize = customRatioSelected && validCustomRatio !== undefined
    ? sizeForTier(resolutionTier, validCustomRatio)
    : undefined;

  useEffect(() => {
    setDraft(settings.defaults);
    setResolutionTier(tierForSize(settings.defaults.size) ?? suggestedTierForSize(settings.defaults.size));
    setCustomRatio(normalizeCustomAspectRatio(settings.defaults.aspectRatio) ?? ratioForImageSize(settings.defaults.size) ?? "1:1");
    setCustomRatioSelected(
      settings.defaults.aspectRatio !== "auto" && !configurableRatios.includes(settings.defaults.aspectRatio as ConfigurableRatio)
    );
  }, [settings.defaults]);

  const completePreview = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDraft(settings.defaults);
    setResolutionTier(tierForSize(settings.defaults.size) ?? suggestedTierForSize(settings.defaults.size));
    setCustomRatio(normalizeCustomAspectRatio(settings.defaults.aspectRatio) ?? ratioForImageSize(settings.defaults.size) ?? "1:1");
    setCustomRatioSelected(
      settings.defaults.aspectRatio !== "auto" && !configurableRatios.includes(settings.defaults.aspectRatio as ConfigurableRatio)
    );
    setState({ status: "success", message: labels.onboardingPreviewSaved });
    onOnboardingComplete?.();
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (customRatioSelected && (validCustomRatio === undefined || calculatedCustomSize === undefined)) {
      setState({ status: "failure", safeMessage: labels.failed });
      return;
    }
    const nextDraft = customRatioSelected
      ? { ...draft, size: calculatedCustomSize!, aspectRatio: validCustomRatio! }
      : draft;
    let input;
    try {
      input = buildDefaultsSettingsInput(nextDraft);
    } catch (error) {
      setState({ status: "failure", safeMessage: error instanceof SettingsFormError ? error.message : labels.failed });
      return;
    }
    setState({ status: "busy", operation: "update-defaults" });
    try {
      const next = await gateway.invoke("updateSettings", input);
      onSettingsChange(next);
      setDraft(next.defaults);
      setState({ status: "success", message: labels.saved });
      onOnboardingComplete?.();
    } catch {
      setState({ status: "failure", safeMessage: labels.failed });
    }
  };

  const selectTier = (value: ResolutionTier) => {
    setResolutionTier(value);
    setDraft((current) => {
      const ratio = customRatioSelected
        ? normalizeCustomAspectRatio(customRatio) ?? current.aspectRatio
        : normalizedRatio(current.aspectRatio);
      return { ...current, size: sizeForTier(value, ratio), aspectRatio: ratio };
    });
  };

  const selectAspectRatio = (value: string) => {
    if (value === "custom") {
      const ratio = normalizeCustomAspectRatio(customRatio) ?? "1:1";
      const nextTier = resolutionTier === "auto" ? "1K" : resolutionTier;
      setCustomRatioSelected(true);
      setCustomRatio(ratio);
      setResolutionTier(nextTier);
      setDraft((current) => ({ ...current, aspectRatio: ratio, size: sizeForTier(nextTier, ratio) }));
      return;
    }

    const ratio = value as ConfigurableRatio;
    setCustomRatioSelected(false);
    setDraft((current) => ({ ...current, aspectRatio: ratio, size: sizeForTier(resolutionTier, ratio) }));
  };

  const updateCustomRatio = (value: string) => {
    setCustomRatio(value);
    const ratio = normalizeCustomAspectRatio(value);
    if (ratio === undefined) return;
    setDraft((current) => ({ ...current, aspectRatio: ratio, size: sizeForTier(resolutionTier, ratio) }));
  };

  return (
    <section className="generation-defaults" aria-labelledby="generation-defaults-title">
      <header>
        <p>{labels.eyebrow}</p>
        <h1 id="generation-defaults-title" tabIndex={-1}>{labels.title}</h1>
        <span>{labels.body}</span>
      </header>
      <form id="generation-defaults-form" data-onboarding-target="defaults-form" onSubmit={(event) => onboardingPreview ? completePreview(event) : void save(event)}>
        <section className="generation-defaults__group generation-defaults__group--current" aria-labelledby="generation-defaults-current-title">
          <h2 id="generation-defaults-current-title">{labels.currentConfiguration}</h2>
          <div className="generation-defaults__current-grid">
            <dl className="generation-defaults__identity">
              <div><dt>{labels.provider}</dt><dd>{active?.name ?? "—"}</dd></div>
            </dl>
            <label className="generation-defaults__model-control">
              <span>{labels.model}</span>
              <select value={draft.model ?? active?.defaultModel ?? ""} disabled={selectableModels.length === 0} onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value || undefined }))}>
                {selectableModels.length === 0 ? <option value="">—</option> : selectableModels.map((model) => <option key={model} value={model}>{model}</option>)}
              </select>
              <small>{labels.modelHint}</small>
            </label>
            <dl className="generation-defaults__identity">
              <div className={configurationReady ? "is-ready" : "is-incomplete"}>
                <dt>{labels.configurationStatus}</dt>
                <dd>{configurationReady ? labels.configured : labels.incomplete}</dd>
              </div>
            </dl>
          </div>
        </section>

        <section className="generation-defaults__group" aria-labelledby="generation-defaults-size-title">
          <h2 id="generation-defaults-size-title">{labels.imageSize}</h2>
          <div className="generation-defaults__grid generation-defaults__grid--size">
            <div className="generation-defaults__ratio-control">
              <label><span>{labels.ratio}</span><select aria-label={labels.ratio} value={customRatioSelected ? "custom" : selectedAspectRatio} onChange={(event) => selectAspectRatio(event.target.value)}>{configurableRatios.map((value) => <option key={value} value={value}>{value}{language === "zh" && value === "1:1" ? " 方形" : ""}{language === "zh" && value.endsWith(":2") ? " 横向" : ""}{language === "zh" && value.startsWith("2:") ? " 竖向" : ""}</option>)}<option value="custom">{labels.customRatio}</option></select></label>
              {customRatioSelected ? <label className="generation-defaults__custom-ratio"><span>{labels.customRatio}</span><input aria-invalid={validCustomRatio === undefined} aria-describedby="generation-defaults-custom-ratio-message" value={customRatio} placeholder={labels.customRatioPlaceholder} onChange={(event) => updateCustomRatio(event.target.value)} />{validCustomRatio === undefined ? <small id="generation-defaults-custom-ratio-message" role="alert">{labels.customRatioError}</small> : <small id="generation-defaults-custom-ratio-message">{labels.customRatioHint} {calculatedCustomSize?.replace("x", " × ")}</small>}</label> : null}
            </div>
            <label><span>{labels.size}</span><select aria-label={labels.size} value={resolutionTier} onChange={(event) => selectTier(event.target.value as ResolutionTier)}>{resolutionTiers.map((tier) => <option key={tier} value={tier}>{tier === "auto" ? (language === "zh" ? "自动" : "Auto") : tier}</option>)}</select><small>{labels.resolutionHint}</small></label>
          </div>
        </section>

        <section className="generation-defaults__group" aria-labelledby="generation-defaults-output-title">
          <h2 id="generation-defaults-output-title">{labels.outputOptions}</h2>
          <div className="generation-defaults__grid generation-defaults__grid--output">
            <label><span>{labels.transparent}</span><select value={draft.transparentMode} onChange={(event) => setDraft((current) => ({ ...current, transparentMode: event.target.value as typeof current.transparentMode }))}>{options.transparent.map(([value, zh]) => <option key={value} value={value}>{language === "zh" ? zh : value}</option>)}</select><small>{labels.nativeHint}</small></label>
            <label><span>{labels.quality}</span><select value={draft.quality} onChange={(event) => setDraft((current) => ({ ...current, quality: event.target.value as typeof current.quality }))}>{["auto", "low", "medium", "high"].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label><span>{labels.format}</span><select value={draft.format} onChange={(event) => setDraft((current) => ({ ...current, format: event.target.value as typeof current.format }))}>{["png", "jpeg", "webp"].map((value) => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label>
            <label><span>{labels.count}</span><select value={draft.count} onChange={(event) => setDraft((current) => ({ ...current, count: Number(event.target.value) }))}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label><span>{labels.responseTimeout}</span><select value={responseTimeoutMs} onChange={(event) => setDraft((current) => ({ ...current, responseTimeoutMs: Number(event.target.value) }))}>{options.responseTimeout.map(([value, zh]) => <option key={value} value={value}>{language === "zh" ? zh : `${value / 60_000} min`}</option>)}</select><small>{labels.responseTimeoutHint}</small></label>
          </div>
        </section>

        {state.status === "success" ? <p className="generation-defaults__message is-success" role="status">{state.message}</p> : null}
        {state.status === "failure" ? <p className="generation-defaults__message is-failure" role="alert">{state.safeMessage}</p> : null}
      </form>
      <div className="generation-defaults__action-bar">
        <p className="generation-defaults__summary" aria-live="polite">
          <strong>{selectedModel}</strong>
          <span aria-hidden="true">·</span>
          <span>{summarySize}</span>
          <span aria-hidden="true">·</span>
          <span>{draft.format.toUpperCase()}</span>
          <span aria-hidden="true">·</span>
          <span>{outputCount}</span>
        </p>
        <div className="generation-defaults__actions">
          <button className="generation-defaults__save" data-onboarding-target="defaults-save" form="generation-defaults-form" type="submit" disabled={state.status === "busy"}>{state.status === "busy" ? labels.saving : onboardingPreview ? labels.onboardingPreviewSave : labels.save}</button>
        </div>
      </div>
    </section>
  );
}
