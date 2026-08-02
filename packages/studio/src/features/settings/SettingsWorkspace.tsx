import { useEffect, useState, type FormEvent } from "react";

import type { ProviderProfileDescriptor } from "@routego-image/contracts";

import { useI18n } from "../../i18n";
import {
  SettingsFormError,
  activeSettingsProfile,
  applySimpleConnectionEndpoint,
  buildUpsertProviderProfileInput,
  clearApiKeyDraft,
  createProviderProfileDraft,
  mergeActiveProviderProfile,
  mergeRefreshedModels,
  mergeRemovedProviderProfile,
  mergeUpsertProviderProfile
} from "./state";
import type { ProviderProfileDraft, SettingsAsyncState, SettingsWorkspaceProps } from "./types";
import "./settings.css";

const copy = {
  zh: {
    eyebrow: "PROVIDER / LIBRARY",
    title: "供应商管理",
    lead: "选择一个供应商即可切换；需要修改时再打开编辑。API Key 仅保存在本机，页面不会显示它。",
    replayOnboarding: "重新查看新手引导",
    select: "当前供应商",
    empty: "还没有供应商资料",
    newProfile: "新建供应商",
    edit: "编辑",
    remove: "删除供应商",
    removeConfirm: "将删除“{name}”及保存在本机的 API Key，此操作不能撤销。是否继续？",
    removing: "正在删除…",
    removed: "供应商已删除。",
    cancel: "取消",
    name: "名称",
    endpoint: "调用端点",
    endpointPlaceholder: "routego.xyz",
    endpointHelp: "填写服务商提供的 API 地址或完整生图端点，模型地址会自动处理。",
    key: "API Key",
    keyStored: "已保存；留空则不修改",
    keyPlaceholder: "粘贴新的 API Key",
    getModels: "获取模型",
    gettingModels: "正在获取模型…",
    model: "默认模型",
    chooseModel: "请选择模型",
    manualModel: "服务商没有返回模型，请手动填写",
    save: "保存",
    saving: "正在保存…",
    saved: "已保存并切换为当前供应商。",
    switched: "已切换供应商。",
    modelUpdated: "模型列表已更新，请选择一个模型后保存。",
    configured: "已配置 API Key",
    keyMissing: "尚未配置 API Key",
    activeModel: "当前模型",
    retry: "请检查填写内容后重试。"
  },
  en: {
    eyebrow: "PROVIDER / LIBRARY",
    title: "Provider management",
    lead: "Choose a provider to switch. Open Edit only when changes are needed. API keys stay local and are never displayed.",
    replayOnboarding: "Review onboarding",
    select: "Current provider",
    empty: "No provider saved yet",
    newProfile: "New provider",
    edit: "Edit",
    remove: "Remove provider",
    removeConfirm: "Remove “{name}” and its locally stored API key? This cannot be undone.",
    removing: "Removing…",
    removed: "Provider removed.",
    cancel: "Cancel",
    name: "Name",
    endpoint: "API endpoint",
    endpointPlaceholder: "routego.xyz",
    endpointHelp: "Enter the API address or complete image endpoint from the provider. Model discovery is handled automatically.",
    key: "API key",
    keyStored: "Stored; leave blank to keep it",
    keyPlaceholder: "Paste a new API key",
    getModels: "Get models",
    gettingModels: "Getting models…",
    model: "Default model",
    chooseModel: "Choose a model",
    manualModel: "No models returned; enter one manually",
    save: "Save",
    saving: "Saving…",
    saved: "Saved and made current.",
    switched: "Provider switched.",
    modelUpdated: "Model list updated. Choose one and save.",
    configured: "API key configured",
    keyMissing: "No API key configured",
    activeModel: "Current model",
    retry: "Check the form and try again."
  }
} as const;

type Labels = (typeof copy)[keyof typeof copy];

function safeMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "The local provider operation failed safely.";
}

function StateMessage({ state, labels }: { readonly state: SettingsAsyncState; readonly labels: Labels }) {
  if (state.status === "idle") return null;
  if (state.status === "busy") return <p className="settings-operation-state is-busy" role="status">{labels.saving}</p>;
  if (state.status === "failure") return <p className="settings-operation-state is-failure" role="alert">{state.safeMessage} {labels.retry}</p>;
  return <p className="settings-operation-state is-success" role="status">{state.message}</p>;
}

export function SettingsWorkspace({
  gateway,
  settings,
  onSettingsChange,
  firstRunSession = false,
  onboardingPreview = false,
  onReplayOnboarding,
  onProviderSaved
}: SettingsWorkspaceProps) {
  const { language } = useI18n();
  const labels = copy[language];
  const initialProfile = activeSettingsProfile(settings) ?? settings.profiles[0];
  const [selectedProfileId, setSelectedProfileId] = useState(initialProfile?.id ?? "new");
  const [draft, setDraft] = useState<ProviderProfileDraft>(() => createProviderProfileDraft(initialProfile));
  const [editing, setEditing] = useState(firstRunSession || initialProfile === undefined);
  const [state, setState] = useState<SettingsAsyncState>({ status: "idle" });
  const [models, setModels] = useState<readonly string[]>(initialProfile?.models ?? []);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});

  const selectedProfile = settings.profiles.find((profile) => profile.id === selectedProfileId);
  const previewProfile = activeSettingsProfile(settings) ?? settings.profiles[0];
  const busy = state.status === "busy";
  const keyMissing = selectedProfile?.hasApiKey !== true && draft.apiKeyReplacement.trim() === "";

  useEffect(() => {
    if (selectedProfileId !== "new" && !settings.profiles.some((profile) => profile.id === selectedProfileId)) {
      const fallback = activeSettingsProfile(settings) ?? settings.profiles[0];
      setSelectedProfileId(fallback?.id ?? "new");
      setDraft(createProviderProfileDraft(fallback));
      setModels(fallback?.models ?? []);
      setEditing(fallback === undefined);
    }
  }, [selectedProfileId, settings]);

  const selectProfile = async (profile: ProviderProfileDescriptor) => {
    setSelectedProfileId(profile.id);
    setDraft(createProviderProfileDraft(profile));
    setModels(profile.models);
    setEditing(false);
    setFieldErrors({});
    if (profile.isActive) return;
    setState({ status: "busy", operation: "switch" });
    try {
      const result = await gateway.invoke("setActiveProviderProfile", { profileId: profile.id });
      const next = mergeActiveProviderProfile(settings, result);
      onSettingsChange(next);
      setDraft(createProviderProfileDraft(result.profile));
      setState({ status: "success", message: labels.switched });
    } catch (error) {
      setState({ status: "failure", safeMessage: safeMessage(error) });
    }
  };

  const startNew = () => {
    setSelectedProfileId("new");
    setDraft(createProviderProfileDraft());
    setModels([]);
    setFieldErrors({});
    setState({ status: "idle" });
    setEditing(true);
  };

  const removeSelectedProfile = async () => {
    if (selectedProfile === undefined || busy) return;
    if (!window.confirm(labels.removeConfirm.replace("{name}", selectedProfile.name))) return;
    setState({ status: "busy", operation: "remove" });
    try {
      const result = await gateway.invoke("removeProviderProfile", { profileId: selectedProfile.id });
      const next = mergeRemovedProviderProfile(settings, result);
      const fallback = next.profiles.find((profile) => profile.id === result.activeProviderId) ?? next.profiles[0];
      onSettingsChange(next);
      setSelectedProfileId(fallback?.id ?? "new");
      setDraft(createProviderProfileDraft(fallback));
      setModels(fallback?.models ?? []);
      setFieldErrors({});
      setEditing(fallback === undefined);
      setState({ status: "success", message: labels.removed });
    } catch (error) {
      setState({ status: "failure", safeMessage: safeMessage(error) });
    }
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let input;
    try {
      input = buildUpsertProviderProfileInput({ ...draft, setActive: true });
      setFieldErrors({});
    } catch (error) {
      setFieldErrors(error instanceof SettingsFormError ? error.fields : {});
      setState({ status: "failure", safeMessage: safeMessage(error) });
      return;
    }
    setDraft((current) => clearApiKeyDraft(current));
    setState({ status: "busy", operation: "save" });
    try {
      const result = await gateway.invoke("upsertProviderProfile", input);
      const next = mergeUpsertProviderProfile(settings, result);
      onSettingsChange(next);
      setSelectedProfileId(result.profile.id);
      setDraft(createProviderProfileDraft(result.profile));
      setModels(result.profile.models);
      setEditing(false);
      setState({ status: "success", message: labels.saved });
      if (firstRunSession) onProviderSaved?.();
    } catch (error) {
      setState({ status: "failure", safeMessage: safeMessage(error) });
    }
  };

  const getModels = async () => {
    let input;
    try {
      const normalized = applySimpleConnectionEndpoint({ ...draft, setActive: true }, draft.generation.value);
      input = buildUpsertProviderProfileInput(normalized);
      setDraft(normalized);
      setFieldErrors({});
    } catch (error) {
      setFieldErrors(error instanceof SettingsFormError ? error.fields : {});
      setState({ status: "failure", safeMessage: safeMessage(error) });
      return;
    }
    setDraft((current) => clearApiKeyDraft(current));
    setState({ status: "busy", operation: "get-models" });
    try {
      const saved = await gateway.invoke("upsertProviderProfile", input);
      const withSaved = mergeUpsertProviderProfile(settings, saved);
      onSettingsChange(withSaved);
      const refreshed = await gateway.invoke("refreshModels", { providerId: saved.profile.id });
      if (refreshed.status === "failed" || refreshed.models.length === 0) {
        setSelectedProfileId(saved.profile.id);
        setDraft(createProviderProfileDraft(saved.profile));
        setModels([]);
        setState({ status: "failure", safeMessage: refreshed.error?.safeMessage ?? labels.manualModel });
        return;
      }
      const next = mergeRefreshedModels(withSaved, refreshed);
      onSettingsChange(next);
      const profile = next.profiles.find((item) => item.id === saved.profile.id) ?? saved.profile;
      setSelectedProfileId(profile.id);
      setModels(refreshed.models);
      setDraft({ ...createProviderProfileDraft(profile), defaultModel: refreshed.models[0] ?? "" });
      setState({ status: "success", message: labels.modelUpdated });
    } catch (error) {
      setState({ status: "failure", safeMessage: safeMessage(error) });
    }
  };

  return (
    <section className="provider-manager" aria-labelledby="provider-manager-title">
      <header className="provider-manager__heading">
        <div className="provider-manager__heading-copy">
          <p>{labels.eyebrow}</p>
          <h1 id="provider-manager-title" tabIndex={-1}>{labels.title}</h1>
          <span>{labels.lead}</span>
        </div>
        {!onboardingPreview && onReplayOnboarding !== undefined ? (
          <button className="provider-manager__replay" type="button" onClick={onReplayOnboarding}>
            {labels.replayOnboarding}
          </button>
        ) : null}
      </header>

      {onboardingPreview ? (
        <section className="provider-manager__preview" data-onboarding-target="provider-summary" aria-label={labels.select}>
          <div className="provider-manager__summary">
            <strong>{previewProfile?.name ?? labels.empty}</strong>
            <span>{previewProfile?.hasApiKey ? labels.configured : labels.keyMissing}</span>
            <span>{labels.activeModel}：{settings.defaults.model ?? previewProfile?.defaultModel ?? "—"}</span>
          </div>
        </section>
      ) : (
        <>
      <section className="provider-manager__picker" aria-label={labels.select}>
        <label>
          <span>{labels.select}</span>
          <select
            value={selectedProfileId === "new" ? "" : selectedProfileId}
            disabled={busy || settings.profiles.length === 0}
            onChange={(event) => {
              const profile = settings.profiles.find((item) => item.id === event.target.value);
              if (profile) void selectProfile(profile);
            }}
          >
            {settings.profiles.length === 0 ? <option value="">{labels.empty}</option> : null}
            {settings.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}{profile.isActive ? " · ✓" : ""}</option>)}
          </select>
        </label>
        <button type="button" disabled={busy} onClick={startNew}>{labels.newProfile}</button>
        {selectedProfile && !editing ? <button type="button" disabled={busy} onClick={() => setEditing(true)}>{labels.edit}</button> : null}
        {selectedProfile ? <button className="provider-manager__delete" type="button" disabled={busy} onClick={() => void removeSelectedProfile()}>{busy && state.operation === "remove" ? labels.removing : labels.remove}</button> : null}
      </section>

      {!editing && selectedProfile ? (
        <section className="provider-manager__summary" data-onboarding-target="provider-summary">
          <strong>{selectedProfile.name}</strong>
          <span>{selectedProfile.hasApiKey ? labels.configured : labels.keyMissing}</span>
          <span>{labels.activeModel}：{settings.defaults.model ?? selectedProfile.defaultModel ?? "—"}</span>
        </section>
      ) : (
        <form className="provider-manager__form" data-onboarding-target="provider-form" onSubmit={(event) => void save(event)}>
          <label>
            <span>{labels.name}</span>
            <input required maxLength={200} value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
            {fieldErrors["name"] ? <small className="settings-field-error">{fieldErrors["name"]}</small> : null}
          </label>
          <label>
            <span>{labels.endpoint}</span>
            <input className="provider-manager__endpoint-input" required type="url" autoComplete="url" spellCheck={false} placeholder={labels.endpointPlaceholder} value={draft.generation.value} onChange={(event) => setDraft((current) => ({ ...current, generation: { ...current.generation, value: event.target.value, requiresReentry: false } }))} />
            <small>{labels.endpointHelp}</small>
            {fieldErrors["endpoints.generation"] ?? fieldErrors["endpoints.generation.value"] ? <small className="settings-field-error">{fieldErrors["endpoints.generation"] ?? fieldErrors["endpoints.generation.value"]}</small> : null}
          </label>
          <label>
            <span>{labels.key}</span>
            <input type="password" required={selectedProfile?.hasApiKey !== true} autoComplete="new-password" placeholder={selectedProfile?.hasApiKey ? labels.keyStored : labels.keyPlaceholder} value={draft.apiKeyReplacement} onChange={(event) => setDraft((current) => ({ ...current, apiKeyOperation: event.target.value === "" && selectedProfile?.hasApiKey ? "unchanged" : "replace", apiKeyReplacement: event.target.value }))} />
          </label>
          <div className="provider-manager__model-row">
            <label>
              <span>{labels.model}</span>
              {models.length > 0 ? <select value={draft.defaultModel} onChange={(event) => setDraft((current) => ({ ...current, defaultModel: event.target.value }))}><option value="">{labels.chooseModel}</option>{models.map((model) => <option key={model} value={model}>{model}</option>)}</select> : <input value={draft.defaultModel} placeholder={labels.manualModel} onChange={(event) => setDraft((current) => ({ ...current, defaultModel: event.target.value }))} />}
            </label>
            <button type="button" disabled={busy || draft.generation.value.trim() === "" || keyMissing} onClick={() => void getModels()}>{busy && state.operation === "get-models" ? labels.gettingModels : labels.getModels}</button>
          </div>
          <div className="provider-manager__actions">
            <button data-onboarding-target="provider-save" type="submit" disabled={busy}>{busy && state.operation === "save" ? labels.saving : labels.save}</button>
            {selectedProfile ? <button type="button" disabled={busy} onClick={() => { setDraft(createProviderProfileDraft(selectedProfile)); setModels(selectedProfile.models); setEditing(false); setState({ status: "idle" }); }}>{labels.cancel}</button> : null}
          </div>
          <StateMessage state={state} labels={labels} />
        </form>
      )}
      {!editing ? <StateMessage state={state} labels={labels} /> : null}
        </>
      )}
    </section>
  );
}
