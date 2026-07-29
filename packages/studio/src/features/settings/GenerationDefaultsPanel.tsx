import { useEffect, useState, type FormEvent } from "react";

import type { ReadSettingsResult } from "@routego-image/contracts";

import type { StudioGateway } from "../../api";
import { useI18n } from "../../i18n";
import { CapabilityProbePanel } from "./CapabilityProbePanel";
import {
  configurableRatios,
  normalizeCustomImageSize,
  normalizedRatio,
  parseImageDimensions,
  resolutionTiers,
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
  size: [
    ["auto", "自动"],
    ["1024x1024", "1K（1024 × 1024）"],
    ["2048x2048", "2K（2048 × 2048）"],
    ["4096x4096", "4K（4096 × 4096）"]
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
    provider: "当前服务商",
    model: "当前模型",
    modelHint: "从当前供应商已保存或已获取的模型中选择；保存后会用于后续请求。",
    ratio: "图片比例",
    size: "清晰度",
    transparent: "背景透明",
    quality: "质量",
    format: "文件格式",
    count: "默认张数",
    customSize: "自定义尺寸",
    customWidth: "宽度",
    customHeight: "高度",
    customSizeHint: "保存时会按兼容上游规则对齐到 16 的倍数，并限制在 3840 边长、3:1 比例和 4K 像素预算内；保存后的数值就是实际发送值。",
    responseTimeout: "响应等待上限",
    responseTimeoutHint: "控制 Routego 等待服务商响应的最长时间。服务商自身更短的超时无法由此延长。",
    save: "保存并作为 Codex 默认值",
    saving: "正在保存设置…",
    saved: "已保存。之后在 Codex 对话生图将默认使用这些参数。",
    failed: "设置未保存，请检查选项后重试。",
    nativeHint: "原生透明需要服务商明确支持；当前配置使用安全默认值。",
    resolutionHint: "选择 1K、2K 或 4K 后，插件会按已验证的兼容尺寸矩阵发送给上游。"
  },
  en: {
    eyebrow: "CODEX DEFAULTS / 01",
    title: "Set Codex image defaults",
    body: "Create images by describing them in Codex. These saved values are used whenever a request does not override them.",
    provider: "Active provider",
    model: "Active model",
    modelHint: "Choose from models saved or fetched for the active provider. Saving applies it to future requests.",
    ratio: "Aspect ratio",
    size: "Resolution tier",
    transparent: "Transparent background",
    quality: "Quality",
    format: "Format",
    count: "Default outputs",
    customSize: "Custom dimensions",
    customWidth: "Width",
    customHeight: "Height",
    customSizeHint: "On save, dimensions are aligned to 16 and bounded to a 3840 edge, 3:1 ratio, and the 4K pixel budget. The saved value is the value sent upstream.",
    responseTimeout: "Response wait limit",
    responseTimeoutHint: "This is Routego's maximum wait for a provider response. It cannot extend an earlier timeout imposed by the provider itself.",
    save: "Save as Codex defaults",
    saving: "Saving settings…",
    saved: "Saved. Future Codex image requests will use these defaults unless overridden.",
    failed: "Settings were not saved. Check the options and try again.",
    nativeHint: "Native transparency requires explicit provider support; the current setup keeps a safe default.",
    resolutionHint: "Routego sends the verified compatible size matrix for the selected 1K, 2K, or 4K aspect ratio."
  }
} as const;

export function GenerationDefaultsPanel({
  gateway,
  settings,
  onSettingsChange
}: {
  readonly gateway: StudioGateway;
  readonly settings: ReadSettingsResult;
  readonly onSettingsChange: (settings: ReadSettingsResult) => void;
}) {
  const { language } = useI18n();
  const labels = copy[language];
  const [draft, setDraft] = useState(settings.defaults);
  const [customDimensions, setCustomDimensions] = useState(
    () => parseImageDimensions(settings.defaults.size) ?? { width: "1024", height: "1024" }
  );
  const [customSizeSelected, setCustomSizeSelected] = useState(() => tierForSize(settings.defaults.size) === undefined);
  const [state, setState] = useState<SettingsAsyncState>({ status: "idle" });
  const active = settings.profiles.find((item) => item.id === settings.activeProviderId && item.isActive);
  const selectableModels = [...new Set([
    ...(active?.models ?? []),
    ...(active?.defaultModel === undefined ? [] : [active.defaultModel]),
    ...(draft.model === undefined ? [] : [draft.model])
  ])];
  const selectedTier = tierForSize(draft.size);
  const selectedTierValue: string = selectedTier ?? "custom";
  const responseTimeoutMs = draft.responseTimeoutMs ?? 300_000;

  useEffect(() => {
    setDraft(settings.defaults);
    setCustomDimensions(parseImageDimensions(settings.defaults.size) ?? { width: "1024", height: "1024" });
    setCustomSizeSelected(tierForSize(settings.defaults.size) === undefined);
  }, [settings.defaults]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const customSize = customSizeSelected
      ? normalizeCustomImageSize(customDimensions.width, customDimensions.height)
      : undefined;
    if (customSizeSelected && customSize === undefined) {
      setState({ status: "failure", safeMessage: labels.failed });
      return;
    }
    const nextDraft = customSize === undefined ? draft : { ...draft, size: customSize, aspectRatio: "auto" as const };
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
    } catch {
      setState({ status: "failure", safeMessage: labels.failed });
    }
  };

  const selectTier = (value: string) => {
    if (value === "custom") {
      setCustomSizeSelected(true);
      setDraft((current) => ({ ...current, size: `${customDimensions.width}x${customDimensions.height}`, aspectRatio: "auto" }));
      return;
    }
    setCustomSizeSelected(false);
    setDraft((current) => ({ ...current, size: sizeForTier(value as ResolutionTier, current.aspectRatio) }));
  };

  const setCustomDimension = (axis: "width" | "height", value: string) => {
    const next = { ...customDimensions, [axis]: value };
    setCustomDimensions(next);
    setCustomSizeSelected(true);
    setDraft((current) => ({ ...current, size: `${next.width}x${next.height}`, aspectRatio: "auto" }));
  };

  return (
    <section className="generation-defaults" aria-labelledby="generation-defaults-title">
      <header>
        <p>{labels.eyebrow}</p>
        <h1 id="generation-defaults-title" tabIndex={-1}>{labels.title}</h1>
        <span>{labels.body}</span>
      </header>
      <dl className="generation-defaults__identity">
        <div><dt>{labels.provider}</dt><dd>{active?.name ?? "—"}</dd></div>
        <div><dt>{labels.model}</dt><dd>{draft.model ?? active?.defaultModel ?? "—"}</dd></div>
      </dl>
      <form onSubmit={(event) => void save(event)}>
        <div className="generation-defaults__grid">
          <label className="generation-defaults__wide"><span>{labels.model}</span><select value={draft.model ?? active?.defaultModel ?? ""} disabled={selectableModels.length === 0} onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value || undefined }))}>{selectableModels.length === 0 ? <option value="">—</option> : selectableModels.map((model) => <option key={model} value={model}>{model}</option>)}</select><small>{labels.modelHint}</small></label>
          <label><span>{labels.ratio}</span><select value={normalizedRatio(draft.aspectRatio)} disabled={customSizeSelected} onChange={(event) => setDraft((current) => { const aspectRatio = event.target.value as ConfigurableRatio; const tier = tierForSize(current.size); return { ...current, aspectRatio, ...(tier === undefined ? {} : { size: sizeForTier(tier, aspectRatio) }) }; })}>{configurableRatios.map((value) => <option key={value} value={value}>{value}{language === "zh" && value === "1:1" ? " 方形" : ""}{language === "zh" && value.endsWith(":2") ? " 横向" : ""}{language === "zh" && value.startsWith("2:") ? " 竖向" : ""}</option>)}</select></label>
          <label><span>{labels.size}</span><select value={customSizeSelected ? "custom" : selectedTierValue} onChange={(event) => selectTier(event.target.value)}><option value="custom">{labels.customSize}</option>{resolutionTiers.map((tier) => <option key={tier} value={tier}>{tier === "auto" ? (language === "zh" ? "自动" : "Auto") : tier}</option>)}</select><small>{labels.resolutionHint}</small></label>
          {customSizeSelected ? <div className="generation-defaults__custom-size generation-defaults__wide"><label><span>{labels.customWidth}</span><input inputMode="numeric" pattern="[0-9]*" value={customDimensions.width} onChange={(event) => setCustomDimension("width", event.target.value)} /></label><span>×</span><label><span>{labels.customHeight}</span><input inputMode="numeric" pattern="[0-9]*" value={customDimensions.height} onChange={(event) => setCustomDimension("height", event.target.value)} /></label><small>{labels.customSizeHint}</small></div> : null}
          <label className="generation-defaults__wide"><span>{labels.transparent}</span><select value={draft.transparentMode} onChange={(event) => setDraft((current) => ({ ...current, transparentMode: event.target.value as typeof current.transparentMode }))}>{options.transparent.map(([value, zh]) => <option key={value} value={value}>{language === "zh" ? zh : value}</option>)}</select><small>{labels.nativeHint}</small></label>
          <label><span>{labels.quality}</span><select value={draft.quality} onChange={(event) => setDraft((current) => ({ ...current, quality: event.target.value as typeof current.quality }))}>{["auto", "low", "medium", "high"].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label><span>{labels.format}</span><select value={draft.format} onChange={(event) => setDraft((current) => ({ ...current, format: event.target.value as typeof current.format }))}>{["png", "jpeg", "webp"].map((value) => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label>
          <label><span>{labels.count}</span><select value={draft.count} onChange={(event) => setDraft((current) => ({ ...current, count: Number(event.target.value) }))}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label className="generation-defaults__wide"><span>{labels.responseTimeout}</span><select value={responseTimeoutMs} onChange={(event) => setDraft((current) => ({ ...current, responseTimeoutMs: Number(event.target.value) }))}>{options.responseTimeout.map(([value, zh]) => <option key={value} value={value}>{language === "zh" ? zh : `${value / 60_000} min`}</option>)}</select><small>{labels.responseTimeoutHint}</small></label>
        </div>
        <button className="generation-defaults__save" type="submit" disabled={state.status === "busy"}>{state.status === "busy" ? labels.saving : labels.save}</button>
        {state.status === "success" ? <p className="generation-defaults__message is-success" role="status">{state.message}</p> : null}
        {state.status === "failure" ? <p className="generation-defaults__message is-failure" role="alert">{state.safeMessage}</p> : null}
      </form>
      <CapabilityProbePanel gateway={gateway} settings={settings} />
    </section>
  );
}
