import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  imageFormatSchema,
  imageQualitySchema,
  moderationSchema,
  transparentModeSchema,
  type ProviderProfileDescriptor,
  type ReadSettingsResult
} from "@routego-image/contracts";

import { useI18n } from "../../i18n";
import {
  SettingsFormError,
  activeSettingsProfile,
  applySimpleConnectionEndpoint,
  buildDefaultsSettingsInput,
  buildOutputDirectorySettingsInput,
  buildUpsertProviderProfileInput,
  clearApiKeyDraft,
  clearOutputDirectorySensitiveDraft,
  createOutputDirectoryDraft,
  createProviderProfileDraft,
  mergeActiveProviderProfile,
  mergeRefreshedModels,
  mergeRemovedProviderProfile,
  mergeUpsertProviderProfile
} from "./state";
import type {
  OutputDirectoryDraft,
  ProviderProfileDraft,
  SettingsAsyncState,
  SettingsWorkspaceProps
} from "./types";
import "./settings.css";

const copy = {
  zh: {
    eyebrow: "CONTROL ROOM / 04",
    title: "中转配置与能力校准",
    lead: "管理脱敏提供方资料、写入型密钥、生成默认值和明确确认的能力探测。敏感值不会进入诊断或持久浏览器状态。",
    firstRunEyebrow: "FIRST RUN / LOCAL SETUP",
    firstRunTitle: "完成首次连接",
    firstRunLead: "填写服务商给你的调用端点和 API Key，然后获取模型并选择一个即可。",
    firstRunConnection: "提供方连接",
    firstRunConnectionPending: "填写资料名称与生成端点",
    firstRunConnectionReady: "活动资料已保存",
    firstRunKey: "API Key",
    firstRunKeyPending: "输入密钥并安全保存",
    firstRunKeyReady: "密钥已配置，不会回显",
    firstRunModel: "生成模型",
    firstRunModelPending: "填写服务商支持的模型名称",
    firstRunModelReady: "默认模型已设置",
    firstRunActive: "当前提供方",
    firstRunActivePending: "保存时勾选设为当前提供方",
    firstRunActiveReady: "当前提供方已启用",
    firstRunStart: "填写提供方资料",
    firstRunComplete: "首次配置已完成",
    firstRunOpenWorkbench: "进入工作台",
    setupDirectTitle: "配置一次，之后直接在 Codex 生图",
    setupDirectBody: "这个页面只负责连接你的图片 API。完成后关闭页面，回到 Codex 对话描述想要的图片即可；Studio 不是生图的必经入口。",
    setupStepConnection: "连接图片 API",
    setupStepCodex: "返回 Codex 直接创作",
    callEndpoint: "调用端点",
    callEndpointPlaceholder: "例如 https://api.example.com/",
    callEndpointHelp: "粘贴服务商提供的 API 地址或完整生图调用端点，其他地址由插件自动处理。",
    keyPlaceholder: "粘贴 API Key",
    keyStoredPlaceholder: "已安全保存；留空表示不修改",
    connectAndFetch: "连接并获取模型",
    connectHelp: "只读取一次上游模型列表，不会生成图片，也不会自动重试。",
    chooseModel: "选择生图模型",
    finishSetup: "完成配置",
    manualModel: "手动填写模型",
    manualModelHelp: "上游没有返回模型列表。请填写服务商提供的模型名称后完成配置。",
    setupReadyBody: "连接已经保存。现在回到 Codex，直接说“生成一张……”即可。",
    modelRequired: "请选择或填写一个生图模型。",
    settingsEyebrow: "SETTINGS / IMAGE API",
    connectionTitle: "图片 API 配置",
    advancedSettings: "高级设置",
    advancedSettingsHelp: "多中转、能力探测、默认参数和输出目录",
    active: "当前启用",
    inactive: "未启用",
    profiles: "提供方资料",
    emptyProfiles: "尚未配置提供方资料。创建资料后仍需明确选择启用项。",
    newProfile: "新建资料",
    editProfile: "编辑资料",
    profileName: "资料名称",
    generationMode: "生成端点模式",
    exactEndpoint: "精确生成端点",
    legacyBase: "旧版 API 基地址",
    generationEndpoint: "生成端点",
    modelsEndpoint: "模型列表端点（可选）",
    editsEndpoint: "编辑端点（可选）",
    responsesEndpoint: "Responses 端点（可选）",
    endpointReentry: "原端点含已隐藏查询参数，不能安全回填；保存前请重新输入完整端点。",
    defaultModel: "资料默认模型",
    apiKeyOperation: "API Key 写入操作",
    apiUnchanged: "保持不变",
    apiReplace: "替换",
    apiClear: "清除",
    apiReplacement: "新 API Key",
    apiSafe: "密钥只写入本机配置，页面不会回显；提交后输入框立即清空。",
    setActive: "保存后设为当前提供方",
    saveProfile: "保存提供方资料",
    activate: "设为当前提供方",
    remove: "移除资料",
    confirmRemove: "我确认移除此资料；若它仍为当前资料，服务可能拒绝。",
    hasKey: "已配置密钥",
    noKey: "未配置密钥",
    redacted: "脱敏端点",
    modelRefresh: "模型清单刷新",
    nonBillable: "非计费操作：仅读取模型清单，不发送图像能力测试。",
    refreshModels: "刷新模型（非计费）",
    refreshedModels: "已验证模型",
    capabilityProbe: "能力探测",
    probeWarning: "潜在计费：探测会发送提供方形状的请求，必须单次明确确认，失败不会自动重放。",
    provider: "提供方",
    model: "模型",
    capability: "能力",
    transport: "传输形状",
    requestShape: "请求形状标识",
    confirmProbe: "我确认本次探测可能产生费用",
    runProbe: "执行一次能力探测",
    probeResult: "最近探测结果",
    mayHaveBilled: "可能已计费",
    evidence: "证据",
    degradedReason: "降级原因",
    capabilityLedger: "四态能力证据",
    transient: "瞬时失败",
    defaults: "生成默认值",
    defaultsLead: "保存完整默认对象，并同步已挂载工作台中仅由默认值派生的控制项；提示词、图片、遮罩和任务不会被替换。",
    size: "尺寸",
    aspect: "宽高比",
    quality: "质量",
    format: "格式",
    count: "变体数",
    partialImages: "部分图像数",
    transparency: "透明模式",
    moderation: "内容审核",
    saveToLibrary: "默认保存到图库",
    saveDefaults: "保存完整默认值",
    outputDirectory: "输出目录",
    outputLead: "原始路径只存在于确认表单，提交开始后立即清空；结果只显示服务返回的脱敏状态。",
    unchanged: "保持不变",
    useDefault: "使用默认目录",
    clear: "清除配置",
    replace: "替换目录",
    localPath: "绝对本地目录",
    confirmPath: "我确认这是用于输出配置的本地路径",
    applyOutput: "应用输出目录操作",
    configured: "已配置",
    notConfigured: "未配置",
    busy: "正在安全提交…",
    saved: "设置已保存，并仅采用验证后的脱敏结果。",
    removed: "提供方资料已移除。",
    activated: "当前提供方已更新。",
    modelsUpdated: "模型清单已通过非计费刷新更新。",
    probeCompleted: "能力探测已完成并写入当前会话证据。",
    retry: "可修正表单或再次执行此操作。"
  },
  en: {
    eyebrow: "CONTROL ROOM / 04",
    title: "Relay configuration & capability calibration",
    lead: "Manage redacted provider profiles, write-only keys, generation defaults, and explicitly confirmed probes. Sensitive values never enter diagnostics or persistent browser state.",
    firstRunEyebrow: "FIRST RUN / LOCAL SETUP",
    firstRunTitle: "Complete the first connection",
    firstRunLead: "Enter the call endpoint and API key from your provider, then fetch and choose a model.",
    firstRunConnection: "Provider connection",
    firstRunConnectionPending: "Enter a profile name and generation endpoint",
    firstRunConnectionReady: "Active profile saved",
    firstRunKey: "API key",
    firstRunKeyPending: "Enter the key and save it securely",
    firstRunKeyReady: "Key configured and never displayed",
    firstRunModel: "Generation model",
    firstRunModelPending: "Enter a provider-supported model name",
    firstRunModelReady: "Default model configured",
    firstRunActive: "Active provider",
    firstRunActivePending: "Select Make active when saving",
    firstRunActiveReady: "Active provider enabled",
    firstRunStart: "Fill provider profile",
    firstRunComplete: "First-run setup complete",
    firstRunOpenWorkbench: "Open Workbench",
    setupDirectTitle: "Configure once, then create directly in Codex",
    setupDirectBody: "This page only connects your image API. When setup is complete, close it and describe the image in Codex; Studio is not required for normal generation.",
    setupStepConnection: "Connect image API",
    setupStepCodex: "Create directly in Codex",
    callEndpoint: "Call endpoint",
    callEndpointPlaceholder: "For example, https://api.example.com/",
    callEndpointHelp: "Paste the API address or complete image-generation endpoint from your provider. Routego handles the other addresses internally.",
    keyPlaceholder: "Paste API key",
    keyStoredPlaceholder: "Stored securely; leave blank to keep it",
    connectAndFetch: "Connect and fetch models",
    connectHelp: "Reads the upstream model list once. It does not generate an image or retry automatically.",
    chooseModel: "Choose image model",
    finishSetup: "Finish setup",
    manualModel: "Enter model manually",
    manualModelHelp: "The upstream service did not return a model list. Enter the model name supplied by your provider.",
    setupReadyBody: "The connection is saved. Return to Codex and ask it to generate an image.",
    modelRequired: "Choose or enter an image model.",
    settingsEyebrow: "SETTINGS / IMAGE API",
    connectionTitle: "Image API settings",
    advancedSettings: "Advanced settings",
    advancedSettingsHelp: "Multiple relays, capability probes, defaults, and output directory",
    active: "Active",
    inactive: "Inactive",
    profiles: "Provider profiles",
    emptyProfiles: "No provider profile is configured. Create one, then explicitly select the active profile.",
    newProfile: "New profile",
    editProfile: "Edit profile",
    profileName: "Profile name",
    generationMode: "Generation endpoint mode",
    exactEndpoint: "Exact generation endpoint",
    legacyBase: "Legacy API base",
    generationEndpoint: "Generation endpoint",
    modelsEndpoint: "Models endpoint (optional)",
    editsEndpoint: "Edits endpoint (optional)",
    responsesEndpoint: "Responses endpoint (optional)",
    endpointReentry: "The saved endpoint has hidden query data and cannot be safely hydrated. Re-enter the complete endpoint before saving.",
    defaultModel: "Profile default model",
    apiKeyOperation: "API key write operation",
    apiUnchanged: "Keep unchanged",
    apiReplace: "Replace",
    apiClear: "Clear",
    apiReplacement: "New API key",
    apiSafe: "The key is written only to local configuration, never displayed, and cleared from the field on submit.",
    setActive: "Make active after save",
    saveProfile: "Save provider profile",
    activate: "Make active",
    remove: "Remove profile",
    confirmRemove: "I confirm profile removal; the service may reject removal while it is active.",
    hasKey: "Key configured",
    noKey: "No key configured",
    redacted: "Redacted endpoints",
    modelRefresh: "Model catalogue refresh",
    nonBillable: "Non-billable: this only reads the model catalogue and does not run an image capability test.",
    refreshModels: "Refresh models (non-billable)",
    refreshedModels: "Validated models",
    capabilityProbe: "Capability probe",
    probeWarning: "Potentially billable: a probe sends one provider-shaped request, requires one explicit confirmation, and is never replayed automatically.",
    provider: "Provider",
    model: "Model",
    capability: "Capability",
    transport: "Transport shape",
    requestShape: "Request-shape identifier",
    confirmProbe: "I confirm this probe may incur a charge",
    runProbe: "Run one capability probe",
    probeResult: "Latest probe result",
    mayHaveBilled: "May have billed",
    evidence: "Evidence",
    degradedReason: "Degraded reason",
    capabilityLedger: "Four-state capability evidence",
    transient: "Transient failure",
    defaults: "Generation defaults",
    defaultsLead: "Save one complete defaults object and synchronize only default-derived controls in the mounted workbench; prompts, images, masks, and task identity are preserved.",
    size: "Size",
    aspect: "Aspect ratio",
    quality: "Quality",
    format: "Format",
    count: "Variant count",
    partialImages: "Partial-image count",
    transparency: "Transparency",
    moderation: "Moderation",
    saveToLibrary: "Save to Library by default",
    saveDefaults: "Save complete defaults",
    outputDirectory: "Output directory",
    outputLead: "The raw path exists only in the confirmed form and is cleared when submission starts; results show only the redacted service state.",
    unchanged: "Keep unchanged",
    useDefault: "Use default directory",
    clear: "Clear configuration",
    replace: "Replace directory",
    localPath: "Absolute local directory",
    confirmPath: "I confirm this local path is for output configuration",
    applyOutput: "Apply output-directory operation",
    configured: "Configured",
    notConfigured: "Not configured",
    busy: "Submitting safely…",
    saved: "Settings were saved using only the validated redacted result.",
    removed: "The provider profile was removed.",
    activated: "The active provider was updated.",
    modelsUpdated: "The model catalogue was updated by a non-billable refresh.",
    probeCompleted: "The capability probe completed and updated session evidence.",
    retry: "Correct the form or run this operation again."
  }
} as const;

type Labels = { readonly [Key in keyof (typeof copy)["zh"]]: string };
const transportOptions = ["single-endpoint-json", "openai-images", "openai-responses"] as const;

function safeMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "The local settings operation failed safely.";
}

function FieldError({ value }: { readonly value?: string | undefined }) {
  return value ? <small className="settings-field-error" role="alert">{value}</small> : null;
}

function StateMessage({ state, labels }: { readonly state: SettingsAsyncState; readonly labels: Labels }) {
  if (state.status === "idle") return null;
  return state.status === "busy" ? (
    <p className="settings-operation-state is-busy" role="status">{labels.busy}</p>
  ) : state.status === "failure" ? (
    <p className="settings-operation-state is-failure" role="alert">{state.safeMessage} {labels.retry}</p>
  ) : (
    <p className="settings-operation-state is-success" role="status">{state.message}</p>
  );
}

function endpointList(profile: ProviderProfileDescriptor): readonly string[] {
  return [
    profile.endpoints.generation.display,
    profile.endpoints.models?.display,
    profile.endpoints.responses?.display
  ].filter((value): value is string => value !== undefined);
}

export function SettingsWorkspace({
  gateway,
  settings,
  onSettingsChange,
  firstRunSession = false,
  onOpenWorkbench
}: SettingsWorkspaceProps) {
  const { language } = useI18n();
  const labels = copy[language];
  const initialProfile = activeSettingsProfile(settings) ?? settings.profiles[0];
  const [selectedProfileId, setSelectedProfileId] = useState(initialProfile?.id ?? "new");
  const [profileDraft, setProfileDraft] = useState<ProviderProfileDraft>(() =>
    createProviderProfileDraft(initialProfile)
  );
  const [profileErrors, setProfileErrors] = useState<Readonly<Record<string, string>>>({});
  const [profileState, setProfileState] = useState<SettingsAsyncState>({ status: "idle" });
  const [removeConfirmed, setRemoveConfirmed] = useState(false);
  const [modelState, setModelState] = useState<SettingsAsyncState>({ status: "idle" });
  const [availableModels, setAvailableModels] = useState<readonly string[]>([]);
  const [manualModelFallback, setManualModelFallback] = useState(false);
  const [defaultsDraft, setDefaultsDraft] = useState(settings.defaults);
  const [defaultsErrors, setDefaultsErrors] = useState<Readonly<Record<string, string>>>({});
  const [defaultsState, setDefaultsState] = useState<SettingsAsyncState>({ status: "idle" });
  const [outputDraft, setOutputDraft] = useState<OutputDirectoryDraft>(createOutputDirectoryDraft);
  const [outputErrors, setOutputErrors] = useState<Readonly<Record<string, string>>>({});
  const [outputState, setOutputState] = useState<SettingsAsyncState>({ status: "idle" });
  const profileNameRef = useRef<HTMLInputElement>(null);

  const activeProfile = activeSettingsProfile(settings);
  const firstRunComplete =
    activeProfile?.hasApiKey === true &&
    ((settings.defaults.model?.trim().length ?? 0) > 0 ||
      (activeProfile.defaultModel?.trim().length ?? 0) > 0);
  const [setupFinished, setSetupFinished] = useState(firstRunSession && firstRunComplete);

  useEffect(() => {
    if (
      selectedProfileId !== "new" &&
      !settings.profiles.some((profile) => profile.id === selectedProfileId)
    ) {
      const fallback = activeSettingsProfile(settings) ?? settings.profiles[0];
      setSelectedProfileId(fallback?.id ?? "new");
      setProfileDraft(createProviderProfileDraft(fallback));
    }
  }, [selectedProfileId, settings]);

  const selectedProfile = settings.profiles.find((profile) => profile.id === selectedProfileId);

  const selectProfile = (profile: ProviderProfileDescriptor | undefined) => {
    setSelectedProfileId(profile?.id ?? "new");
    setProfileDraft(createProviderProfileDraft(profile));
    setProfileErrors({});
    setProfileState({ status: "idle" });
    setRemoveConfirmed(false);
  };

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let input;
    try {
      input = buildUpsertProviderProfileInput(profileDraft);
      setProfileErrors({});
    } catch (error) {
      setProfileState({ status: "failure", safeMessage: safeMessage(error) });
      setProfileErrors(error instanceof SettingsFormError ? error.fields : {});
      return;
    }
    setProfileDraft((current) => clearApiKeyDraft(current));
    setProfileState({ status: "busy", operation: "upsert-profile" });
    try {
      const result = await gateway.invoke("upsertProviderProfile", input);
      const next = mergeUpsertProviderProfile(settings, result);
      onSettingsChange(next);
      setSelectedProfileId(result.profile.id);
      setProfileDraft(createProviderProfileDraft(result.profile));
      setProfileState({ status: "success", message: labels.saved });
    } catch (error) {
      setProfileState({ status: "failure", safeMessage: safeMessage(error) });
    }
  };

  const connectAndFetchModels = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let connectionDraft: ProviderProfileDraft;
    let input;
    try {
      connectionDraft = applySimpleConnectionEndpoint(
        profileDraft,
        profileDraft.generation.value
      );
      input = buildUpsertProviderProfileInput(connectionDraft);
      setProfileErrors({});
    } catch (error) {
      setProfileState({ status: "failure", safeMessage: safeMessage(error) });
      setProfileErrors(error instanceof SettingsFormError ? error.fields : {});
      return;
    }

    setProfileDraft((current) => clearApiKeyDraft(current));
    setProfileState({ status: "busy", operation: "connect-provider" });
    setModelState({ status: "idle" });
    setManualModelFallback(false);
    setAvailableModels([]);

    let saved;
    try {
      saved = await gateway.invoke("upsertProviderProfile", input);
      const next = mergeUpsertProviderProfile(settings, saved);
      onSettingsChange(next);
      setSelectedProfileId(saved.profile.id);
      setProfileDraft(createProviderProfileDraft(saved.profile));
      setProfileState({ status: "success", message: labels.saved });
    } catch (error) {
      setProfileState({ status: "failure", safeMessage: safeMessage(error) });
      return;
    }

    setModelState({ status: "busy", operation: "refresh-models" });
    try {
      const refreshed = await gateway.invoke("refreshModels", {
        providerId: saved.profile.id
      });
      if (refreshed.status === "failed" || refreshed.models.length === 0) {
        setManualModelFallback(true);
        setModelState({
          status: "failure",
          safeMessage:
            refreshed.error?.safeMessage ?? "The upstream service returned no image models."
        });
        return;
      }
      const withSavedProfile = mergeUpsertProviderProfile(settings, saved);
      const next = mergeRefreshedModels(withSavedProfile, refreshed);
      const refreshedProfile = next.profiles.find((profile) => profile.id === saved.profile.id);
      onSettingsChange(next);
      setAvailableModels(refreshed.models);
      setProfileDraft({
        ...createProviderProfileDraft(refreshedProfile ?? saved.profile),
        defaultModel: refreshed.models[0] ?? ""
      });
      setModelState({ status: "success", message: labels.modelsUpdated });
    } catch (error) {
      setManualModelFallback(true);
      setModelState({ status: "failure", safeMessage: safeMessage(error) });
    }
  };

  const finishFirstRun = async () => {
    if (profileDraft.defaultModel.trim() === "") {
      setProfileErrors({ defaultModel: labels.modelRequired });
      setProfileState({ status: "failure", safeMessage: labels.modelRequired });
      return;
    }
    let input;
    try {
      input = buildUpsertProviderProfileInput(profileDraft);
      setProfileErrors({});
    } catch (error) {
      setProfileState({ status: "failure", safeMessage: safeMessage(error) });
      setProfileErrors(error instanceof SettingsFormError ? error.fields : {});
      return;
    }
    setProfileState({ status: "busy", operation: "finish-setup" });
    try {
      const result = await gateway.invoke("upsertProviderProfile", input);
      const next = mergeUpsertProviderProfile(settings, result);
      onSettingsChange(next);
      setSelectedProfileId(result.profile.id);
      setProfileDraft(createProviderProfileDraft(result.profile));
      setSetupFinished(true);
      setProfileState({ status: "success", message: labels.saved });
    } catch (error) {
      setProfileState({ status: "failure", safeMessage: safeMessage(error) });
    }
  };

  const removeProfile = async () => {
    if (selectedProfile === undefined || !removeConfirmed) return;
    setProfileState({ status: "busy", operation: "remove-profile" });
    try {
      const result = await gateway.invoke("removeProviderProfile", {
        profileId: selectedProfile.id
      });
      const next = mergeRemovedProviderProfile(settings, result);
      onSettingsChange(next);
      const fallback = activeSettingsProfile(next) ?? next.profiles[0];
      setSelectedProfileId(fallback?.id ?? "new");
      setProfileDraft(createProviderProfileDraft(fallback));
      setRemoveConfirmed(false);
      setProfileState({ status: "success", message: labels.removed });
    } catch (error) {
      setProfileState({ status: "failure", safeMessage: safeMessage(error) });
    }
  };

  const activateProfile = async () => {
    if (selectedProfile === undefined) return;
    setProfileState({ status: "busy", operation: "activate-profile" });
    try {
      const result = await gateway.invoke("setActiveProviderProfile", {
        profileId: selectedProfile.id
      });
      const next = mergeActiveProviderProfile(settings, result);
      onSettingsChange(next);
      setProfileDraft(createProviderProfileDraft(result.profile));
      setProfileState({ status: "success", message: labels.activated });
    } catch (error) {
      setProfileState({ status: "failure", safeMessage: safeMessage(error) });
    }
  };

  const refreshModels = async () => {
    if (selectedProfile === undefined) return;
    setModelState({ status: "busy", operation: "refresh-models" });
    try {
      const result = await gateway.invoke("refreshModels", {
        providerId: selectedProfile.id
      });
      if (result.status === "failed") {
        setModelState({
          status: "failure",
          safeMessage: result.error?.safeMessage ?? "The model refresh failed safely."
        });
        return;
      }
      const next = mergeRefreshedModels(settings, result);
      onSettingsChange(next);
      setModelState({ status: "success", message: labels.modelsUpdated });
    } catch (error) {
      setModelState({ status: "failure", safeMessage: safeMessage(error) });
    }
  };


  const saveDefaults = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let input;
    try {
      input = buildDefaultsSettingsInput(defaultsDraft);
      setDefaultsErrors({});
    } catch (error) {
      setDefaultsState({ status: "failure", safeMessage: safeMessage(error) });
      setDefaultsErrors(error instanceof SettingsFormError ? error.fields : {});
      return;
    }
    setDefaultsState({ status: "busy", operation: "update-defaults" });
    try {
      const result = await gateway.invoke("updateSettings", input);
      onSettingsChange(result);
      setDefaultsDraft(result.defaults);
      setDefaultsState({ status: "success", message: labels.saved });
    } catch (error) {
      setDefaultsState({ status: "failure", safeMessage: safeMessage(error) });
    }
  };

  const saveOutputDirectory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let input;
    try {
      input = buildOutputDirectorySettingsInput(outputDraft);
      setOutputErrors({});
    } catch (error) {
      setOutputState({ status: "failure", safeMessage: safeMessage(error) });
      setOutputErrors(error instanceof SettingsFormError ? error.fields : {});
      return;
    }
    setOutputDraft((current) => clearOutputDirectorySensitiveDraft(current));
    setOutputState({ status: "busy", operation: "update-output-directory" });
    try {
      const result = await gateway.invoke("updateSettings", input);
      onSettingsChange(result);
      setOutputState({ status: "success", message: labels.saved });
    } catch (error) {
      setOutputState({ status: "failure", safeMessage: safeMessage(error) });
    }
  };

  const hasStoredKey = selectedProfile?.hasApiKey === true;
  const connectionBusy =
    profileState.status === "busy" || modelState.status === "busy";
  const keyMissing = !hasStoredKey && profileDraft.apiKeyReplacement.trim() === "";
  const showFirstRunComplete = firstRunSession && setupFinished;
  const simpleConnection = (
      <section
        className={`settings-setup${firstRunSession ? "" : " settings-setup--reconfigure"}`}
        aria-labelledby="settings-setup-title"
      >
        <header className="settings-setup__intro">
          <p>{firstRunSession ? labels.firstRunEyebrow : labels.settingsEyebrow}</p>
          <h1 id="settings-setup-title" tabIndex={-1}>
            {showFirstRunComplete
              ? labels.firstRunComplete
              : firstRunSession
                ? labels.firstRunTitle
                : labels.connectionTitle}
          </h1>
          <span>{labels.setupDirectBody}</span>
        </header>

        <ol className="settings-setup__steps" aria-label={labels.setupDirectTitle}>
          <li data-state={showFirstRunComplete ? "complete" : "current"}>
            <span aria-hidden="true">1</span>
            <strong>{labels.setupStepConnection}</strong>
          </li>
          <li data-state={showFirstRunComplete ? "current" : "pending"}>
            <span aria-hidden="true">2</span>
            <strong>{labels.setupStepCodex}</strong>
          </li>
        </ol>

        {showFirstRunComplete ? (
          <section className="settings-setup__complete" aria-live="polite">
            <span aria-hidden="true">✓</span>
            <div>
              <h2>{labels.setupDirectTitle}</h2>
              <p>{labels.setupReadyBody}</p>
              <code>{language === "zh" ? "生成一张雨夜霓虹街道的电影感照片" : "Generate a cinematic photo of a neon street at night"}</code>
            </div>
            <button type="button" onClick={onOpenWorkbench}>{labels.firstRunOpenWorkbench}</button>
          </section>
        ) : (
          <form className="settings-setup__form" onSubmit={(event) => void connectAndFetchModels(event)}>
            <div className="settings-setup__form-heading">
              <span>01</span>
              <div>
                <h2>{labels.setupStepConnection}</h2>
                <p>{labels.firstRunLead}</p>
              </div>
            </div>

            <label className="settings-setup__field">
              <span>{labels.callEndpoint}</span>
              <input
                ref={profileNameRef}
                type="url"
                required
                autoComplete="url"
                spellCheck={false}
                placeholder={labels.callEndpointPlaceholder}
                value={profileDraft.generation.value}
                onChange={(event) => setProfileDraft((current) => ({
                  ...current,
                  generation: {
                    ...current.generation,
                    value: event.target.value,
                    requiresReentry: false
                  }
                }))}
              />
              <small>{labels.callEndpointHelp}</small>
              <FieldError value={profileErrors["endpoints.generation"] ?? profileErrors["endpoints.generation.value"]} />
            </label>

            <label className="settings-setup__field">
              <span>API Key</span>
              <input
                type="password"
                required={!hasStoredKey}
                autoComplete="new-password"
                placeholder={hasStoredKey ? labels.keyStoredPlaceholder : labels.keyPlaceholder}
                value={profileDraft.apiKeyReplacement}
                onChange={(event) => {
                  const value = event.target.value;
                  setProfileDraft((current) => ({
                    ...current,
                    apiKeyOperation: value === "" && hasStoredKey ? "unchanged" : "replace",
                    apiKeyReplacement: value
                  }));
                }}
              />
              <small>{labels.apiSafe}</small>
              <FieldError value={profileErrors["apiKey.value"]} />
            </label>

            <div className="settings-setup__connect">
              <button
                type="submit"
                disabled={connectionBusy || profileDraft.generation.value.trim() === "" || keyMissing}
              >
                {connectionBusy ? labels.busy : labels.connectAndFetch}
              </button>
              <p>{labels.connectHelp}</p>
            </div>

            {availableModels.length > 0 ? (
              <section className="settings-setup__model" aria-live="polite">
                <label>
                  <span>{labels.chooseModel}</span>
                  <select
                    value={profileDraft.defaultModel}
                    onChange={(event) => setProfileDraft((current) => ({
                      ...current,
                      defaultModel: event.target.value
                    }))}
                  >
                    {availableModels.map((model) => <option key={model} value={model}>{model}</option>)}
                  </select>
                </label>
                <button type="button" disabled={profileState.status === "busy"} onClick={() => void finishFirstRun()}>
                  {labels.finishSetup}
                </button>
              </section>
            ) : null}

            {manualModelFallback ? (
              <section className="settings-setup__model settings-setup__model--fallback" aria-live="polite">
                <label>
                  <span>{labels.manualModel}</span>
                  <input
                    value={profileDraft.defaultModel}
                    onChange={(event) => setProfileDraft((current) => ({
                      ...current,
                      defaultModel: event.target.value
                    }))}
                  />
                  <small>{labels.manualModelHelp}</small>
                  <FieldError value={profileErrors["defaultModel"]} />
                </label>
                <button type="button" disabled={profileState.status === "busy"} onClick={() => void finishFirstRun()}>
                  {labels.finishSetup}
                </button>
              </section>
            ) : null}

            <StateMessage state={modelState.status === "idle" ? profileState : modelState} labels={labels} />
          </form>
        )}
      </section>
  );

  if (firstRunSession) return simpleConnection;

  return (
    <section className="settings-workspace settings-workspace--simple">
      {simpleConnection}
      <details className="settings-advanced">
        <summary>
          <span>{labels.advancedSettings}</span>
          <small>{labels.advancedSettingsHelp}</small>
        </summary>
        <div className="settings-advanced__content">
      <header className="settings-workspace__header">
        <p>{labels.eyebrow}</p>
        <h1 tabIndex={-1}>{labels.title}</h1>
        <span>{labels.lead}</span>
        <dl>
          <div><dt>{labels.profiles}</dt><dd>{settings.profiles.length}</dd></div>
          <div><dt>{labels.active}</dt><dd>{activeSettingsProfile(settings)?.name ?? "—"}</dd></div>
          <div><dt>{labels.outputDirectory}</dt><dd>{settings.outputDirectory.configured ? settings.outputDirectory.display ?? labels.configured : labels.notConfigured}</dd></div>
        </dl>
      </header>

      <section className="settings-profiles" aria-labelledby="settings-profiles-title">
        <div className="settings-section-heading">
          <p>PROFILES / REDACTED</p>
          <h2 id="settings-profiles-title">{labels.profiles}</h2>
        </div>
        <div className="settings-profiles__layout">
          <nav className="settings-profile-list" aria-label={labels.profiles}>
            <button type="button" aria-pressed={selectedProfileId === "new"} onClick={() => selectProfile(undefined)}>
              <span>+</span><strong>{labels.newProfile}</strong>
            </button>
            {settings.profiles.length === 0 ? <p>{labels.emptyProfiles}</p> : settings.profiles.map((profile) => (
              <button key={profile.id} type="button" aria-pressed={selectedProfileId === profile.id} onClick={() => selectProfile(profile)}>
                <span className={profile.isActive ? "is-active" : ""}>{profile.isActive ? "●" : "○"}</span>
                <strong>{profile.name}</strong>
                <small>{profile.isActive ? labels.active : labels.inactive}</small>
                <small>{profile.hasApiKey ? `${labels.hasKey}${profile.apiKeyPreview ? ` · ${profile.apiKeyPreview}` : ""}` : labels.noKey}</small>
              </button>
            ))}
          </nav>

          <form id="settings-profile-editor" className="settings-profile-editor" onSubmit={(event) => void saveProfile(event)}>
            <header><h3>{selectedProfile ? labels.editProfile : labels.newProfile}</h3><span>{profileDraft.profileId ?? "NEW"}</span></header>
            <div className="settings-form-grid">
              <label><span>{labels.profileName}</span><input ref={profileNameRef} required maxLength={200} value={profileDraft.name} onChange={(event) => setProfileDraft((current) => ({ ...current, name: event.target.value }))} /><FieldError value={profileErrors["name"]} /></label>
              <label><span>{labels.defaultModel}</span><input list="settings-profile-models" value={profileDraft.defaultModel} onChange={(event) => setProfileDraft((current) => ({ ...current, defaultModel: event.target.value }))} /><FieldError value={profileErrors["defaultModel"]} /></label>
              <label><span>{labels.generationMode}</span><select value={profileDraft.generation.mode} onChange={(event) => setProfileDraft((current) => ({ ...current, generation: { ...current.generation, mode: event.target.value as ProviderProfileDraft["generation"]["mode"] } }))}><option value="exact-generation-endpoint">{labels.exactEndpoint}</option><option value="legacy-api-base">{labels.legacyBase}</option></select></label>
              <label className="settings-form-grid__wide"><span>{labels.generationEndpoint}</span><input required value={profileDraft.generation.value} onChange={(event) => setProfileDraft((current) => ({ ...current, generation: { ...current.generation, value: event.target.value, requiresReentry: false } }))} />{profileDraft.generation.requiresReentry ? <small>{labels.endpointReentry}</small> : null}<FieldError value={profileErrors["endpoints.generation"] ?? profileErrors["endpoints.generation.value"]} /></label>
              {(["models", "responses"] as const).map((name) => {
                const label = name === "models" ? labels.modelsEndpoint : labels.responsesEndpoint;
                return <label key={name} className="settings-form-grid__wide"><span>{label}</span><input value={profileDraft[name].value} onChange={(event) => setProfileDraft((current) => ({ ...current, [name]: { ...current[name], value: event.target.value, requiresReentry: false } }))} />{profileDraft[name].requiresReentry ? <small>{labels.endpointReentry}</small> : null}<FieldError value={profileErrors[`endpoints.${name}`]} /></label>;
              })}
            </div>
            <fieldset className="settings-secret-control"><legend>{labels.apiKeyOperation}</legend>{(["unchanged", "replace", "clear"] as const).map((operation) => <label key={operation}><input type="radio" name="api-key-operation" checked={profileDraft.apiKeyOperation === operation} onChange={() => setProfileDraft((current) => ({ ...current, apiKeyOperation: operation, apiKeyReplacement: "" }))} />{operation === "unchanged" ? labels.apiUnchanged : operation === "replace" ? labels.apiReplace : labels.apiClear}</label>)}{profileDraft.apiKeyOperation === "replace" ? <label className="settings-secret-control__replacement"><span>{labels.apiReplacement}</span><input type="password" autoComplete="new-password" value={profileDraft.apiKeyReplacement} onChange={(event) => setProfileDraft((current) => ({ ...current, apiKeyReplacement: event.target.value }))} /><FieldError value={profileErrors["apiKey.value"]} /></label> : null}<p>{labels.apiSafe}</p></fieldset>
            <label className="settings-check"><input type="checkbox" checked={profileDraft.setActive} onChange={(event) => setProfileDraft((current) => ({ ...current, setActive: event.target.checked }))} />{labels.setActive}</label>
            <div className="settings-profile-editor__actions"><button type="submit">{labels.saveProfile}</button>{selectedProfile && !selectedProfile.isActive ? <button type="button" onClick={() => void activateProfile()}>{labels.activate}</button> : null}</div>
            {selectedProfile ? <div className="settings-profile-editor__remove"><label className="settings-check"><input type="checkbox" checked={removeConfirmed} onChange={(event) => setRemoveConfirmed(event.target.checked)} />{labels.confirmRemove}</label><button type="button" className="is-danger" disabled={!removeConfirmed} onClick={() => void removeProfile()}>{labels.remove}</button></div> : null}
            <StateMessage state={profileState} labels={labels} />
          </form>
        </div>
        {selectedProfile ? <div className="settings-redacted-endpoints"><strong>{labels.redacted}</strong>{endpointList(selectedProfile).map((value) => <code key={value}>{value}</code>)}</div> : null}
      </section>

      <section className="settings-models" aria-labelledby="settings-models-title"><div className="settings-section-heading"><p>CATALOG / FREE</p><h2 id="settings-models-title">{labels.modelRefresh}</h2></div><p>{labels.nonBillable}</p><button type="button" disabled={!selectedProfile} onClick={() => void refreshModels()}>{labels.refreshModels}</button><div className="settings-models__list"><strong>{labels.refreshedModels}</strong>{selectedProfile?.models.length ? selectedProfile.models.map((model) => <span key={model}>{model}</span>) : <span>—</span>}</div><StateMessage state={modelState} labels={labels} /></section>

      <div className="settings-output-grid">
        <form className="settings-defaults" onSubmit={(event) => void saveDefaults(event)}><div className="settings-section-heading"><p>DEFAULTS / COMPLETE</p><h2>{labels.defaults}</h2></div><p>{labels.defaultsLead}</p><div className="settings-form-grid"><label className="settings-form-grid__wide"><span>{labels.model}</span><input list="settings-profile-models" value={defaultsDraft.model ?? ""} onChange={(event) => setDefaultsDraft((current) => ({ ...current, model: event.target.value || undefined }))} /><datalist id="settings-profile-models">{settings.profiles.flatMap((profile) => profile.models).filter((model, index, models) => models.indexOf(model) === index).map((model) => <option key={model} value={model} />)}</datalist><FieldError value={defaultsErrors["model"]} /></label><label><span>{labels.size}</span><input list="settings-size-options" value={defaultsDraft.size} onChange={(event) => setDefaultsDraft((current) => ({ ...current, size: event.target.value as typeof current.size }))} /><datalist id="settings-size-options">{["auto", "1024x1024", "1536x1024", "1024x1536"].map((value) => <option key={value} value={value} />)}</datalist><FieldError value={defaultsErrors["size"]} /></label><label><span>{labels.aspect}</span><input list="settings-aspect-options" value={defaultsDraft.aspectRatio} onChange={(event) => setDefaultsDraft((current) => ({ ...current, aspectRatio: event.target.value as typeof current.aspectRatio }))} /><datalist id="settings-aspect-options">{["auto", "square", "portrait", "landscape", "1:1", "3:2", "2:3"].map((value) => <option key={value} value={value} />)}</datalist><FieldError value={defaultsErrors["aspectRatio"]} /></label><label><span>{labels.quality}</span><select value={defaultsDraft.quality} onChange={(event) => setDefaultsDraft((current) => ({ ...current, quality: event.target.value as typeof current.quality }))}>{imageQualitySchema.options.map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label><span>{labels.format}</span><select value={defaultsDraft.format} onChange={(event) => setDefaultsDraft((current) => ({ ...current, format: event.target.value as typeof current.format }))}>{imageFormatSchema.options.map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label><span>{labels.count}</span><input type="number" min={1} max={4} value={defaultsDraft.count} onChange={(event) => setDefaultsDraft((current) => ({ ...current, count: Number(event.target.value) }))} /></label><label><span>{labels.partialImages}</span><input type="number" min={0} max={3} value={defaultsDraft.partialImages} onChange={(event) => setDefaultsDraft((current) => ({ ...current, partialImages: Number(event.target.value) }))} /></label><label><span>{labels.transparency}</span><select value={defaultsDraft.transparentMode} onChange={(event) => setDefaultsDraft((current) => ({ ...current, transparentMode: event.target.value as typeof current.transparentMode }))}>{transparentModeSchema.options.map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label><span>{labels.moderation}</span><select value={defaultsDraft.moderation} onChange={(event) => setDefaultsDraft((current) => ({ ...current, moderation: event.target.value as typeof current.moderation }))}>{moderationSchema.options.map((value) => <option key={value} value={value}>{value}</option>)}</select></label></div><label className="settings-check"><input type="checkbox" checked={defaultsDraft.saveToLibrary} onChange={(event) => setDefaultsDraft((current) => ({ ...current, saveToLibrary: event.target.checked }))} />{labels.saveToLibrary}</label><button type="submit">{labels.saveDefaults}</button><StateMessage state={defaultsState} labels={labels} /></form>

        <form className="settings-output-directory" onSubmit={(event) => void saveOutputDirectory(event)}><div className="settings-section-heading"><p>OUTPUT / REDACTED</p><h2>{labels.outputDirectory}</h2></div><p>{labels.outputLead}</p><div className="settings-output-directory__current"><span>{settings.outputDirectory.configured ? labels.configured : labels.notConfigured}</span><strong>{settings.outputDirectory.display ?? "—"}</strong></div><fieldset><legend>{labels.outputDirectory}</legend>{(["unchanged", "default", "clear", "replace"] as const).map((operation) => <label key={operation}><input type="radio" name="output-operation" checked={outputDraft.operation === operation} onChange={() => setOutputDraft({ operation, path: "", confirmLocalPath: false })} />{operation === "unchanged" ? labels.unchanged : operation === "default" ? labels.useDefault : operation === "clear" ? labels.clear : labels.replace}</label>)}</fieldset>{outputDraft.operation === "replace" ? <div className="settings-output-directory__replace"><label><span>{labels.localPath}</span><input autoComplete="off" spellCheck={false} value={outputDraft.path} onChange={(event) => setOutputDraft((current) => ({ ...current, path: event.target.value, confirmLocalPath: false }))} /><FieldError value={outputErrors["outputDirectory.path"]} /></label><label className="settings-check settings-check--warning"><input type="checkbox" checked={outputDraft.confirmLocalPath} onChange={(event) => setOutputDraft((current) => ({ ...current, confirmLocalPath: event.target.checked }))} />{labels.confirmPath}</label></div> : null}<button type="submit" disabled={outputDraft.operation === "replace" && !outputDraft.confirmLocalPath}>{labels.applyOutput}</button><StateMessage state={outputState} labels={labels} /></form>
      </div>
        </div>
      </details>
    </section>
  );
}
