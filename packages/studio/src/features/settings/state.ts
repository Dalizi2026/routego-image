import {
  capabilityProbeInputSchema,
  routegoDefaultsSchema,
  updateSettingsInputSchema,
  upsertProviderProfileInputSchema,
  type CapabilityProbeInput,
  type ProviderProfileDescriptor,
  type ReadSettingsResult,
  type RefreshModelsResult,
  type RemoveProviderProfileResult,
  type SetActiveProviderProfileResult,
  type UpdateSettingsInput,
  type UpsertProviderProfileInput,
  type UpsertProviderProfileResult
} from "@routego-image/contracts";

import type {
  CapabilityProbeDraft,
  OptionalProviderEndpointDraft,
  OutputDirectoryDraft,
  ProviderEndpointDraft,
  ProviderProfileDraft,
  ProviderSwitchFeedback
} from "./types";

export class SettingsFormError extends Error {
  readonly fields: Readonly<Record<string, string>>;

  constructor(message: string, fields: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "SettingsFormError";
    this.fields = fields;
  }
}

function fieldsFromIssues(
  issues: readonly { readonly path: PropertyKey[]; readonly message: string }[]
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    issues.map((issue) => [issue.path.map(String).join(".") || "form", issue.message])
  );
}

function generationEndpoint(
  descriptor: ProviderProfileDescriptor["endpoints"]["generation"] | undefined
): ProviderEndpointDraft {
  return {
    mode: descriptor?.mode ?? "exact-generation-endpoint",
    value:
      descriptor === undefined || descriptor.hasQuery
        ? ""
        : `${descriptor.origin}${descriptor.pathname}`,
    requiresReentry: descriptor?.hasQuery ?? false
  };
}

function optionalEndpoint(
  descriptor:
    | ProviderProfileDescriptor["endpoints"]["models"]
    | ProviderProfileDescriptor["endpoints"]["edits"]
    | ProviderProfileDescriptor["endpoints"]["responses"]
): OptionalProviderEndpointDraft {
  return {
    value:
      descriptor === undefined || descriptor.hasQuery
        ? ""
        : `${descriptor.origin}${descriptor.pathname}`,
    requiresReentry: descriptor?.hasQuery ?? false
  };
}

export function createProviderProfileDraft(
  profile?: ProviderProfileDescriptor
): ProviderProfileDraft {
  return {
    ...(profile === undefined ? {} : { profileId: profile.id }),
    name: profile?.name ?? "",
    generation: generationEndpoint(profile?.endpoints.generation),
    models: optionalEndpoint(profile?.endpoints.models),
    edits: optionalEndpoint(profile?.endpoints.edits),
    responses: optionalEndpoint(profile?.endpoints.responses),
    defaultModel: profile?.defaultModel ?? "",
    apiKeyOperation: profile === undefined || !profile.hasApiKey ? "replace" : "unchanged",
    apiKeyReplacement: "",
    setActive: profile?.isActive ?? true
  };
}

export function clearApiKeyDraft(draft: ProviderProfileDraft): ProviderProfileDraft {
  return {
    ...draft,
    apiKeyOperation: "unchanged",
    apiKeyReplacement: ""
  };
}

export function applySimpleConnectionEndpoint(
  draft: ProviderProfileDraft,
  callEndpoint: string
): ProviderProfileDraft {
  const value = callEndpoint.trim();
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new SettingsFormError("请输入服务商提供的完整调用端点。", {
      "endpoints.generation.value": "调用端点必须是完整的网址。"
    });
  }

  const pathname = endpoint.pathname.replace(/\/+$/u, "") || "/";
  const exactGenerationEndpoint = pathname.endsWith("/images/generations");
  const modelsEndpoint = new URL(endpoint.href);
  modelsEndpoint.search = "";
  modelsEndpoint.hash = "";
  if (exactGenerationEndpoint) {
    modelsEndpoint.pathname = pathname.replace(/\/images\/generations$/u, "/models");
  } else if (pathname.endsWith("/v1")) {
    modelsEndpoint.pathname = `${pathname}/models`;
  } else {
    modelsEndpoint.pathname = `${pathname === "/" ? "" : pathname}/v1/models`;
  }

  return {
    ...draft,
    name: draft.name.trim() || endpoint.hostname,
    generation: {
      mode: exactGenerationEndpoint ? "exact-generation-endpoint" : "legacy-api-base",
      value,
      requiresReentry: false
    },
    models: {
      value: modelsEndpoint.href,
      requiresReentry: false
    },
    setActive: true
  };
}

function requireEndpointReentry(draft: ProviderProfileDraft): void {
  const fields: Record<string, string> = {};
  for (const [name, endpoint] of [
    ["generation", draft.generation],
    ["models", draft.models],
    ["edits", draft.edits],
    ["responses", draft.responses]
  ] as const) {
    if (endpoint.requiresReentry && endpoint.value.trim() === "") {
      fields[`endpoints.${name}`] =
        "原端点包含已隐藏的查询参数；保存前请重新输入完整端点。";
    }
  }
  if (Object.keys(fields).length > 0) {
    throw new SettingsFormError("请重新输入无法安全回填的端点。", fields);
  }
}

export function buildUpsertProviderProfileInput(
  draft: ProviderProfileDraft
): UpsertProviderProfileInput {
  requireEndpointReentry(draft);
  const apiKey =
    draft.apiKeyOperation === "replace"
      ? { operation: "replace" as const, value: draft.apiKeyReplacement }
      : { operation: draft.apiKeyOperation };
  const candidate = {
    ...(draft.profileId === undefined ? {} : { profileId: draft.profileId }),
    name: draft.name.trim(),
    endpoints: {
      generation: {
        mode: draft.generation.mode,
        value: draft.generation.value.trim()
      },
      ...(draft.models.value.trim() === "" ? {} : { models: draft.models.value.trim() }),
      ...(draft.edits.value.trim() === "" ? {} : { edits: draft.edits.value.trim() }),
      ...(draft.responses.value.trim() === ""
        ? {}
        : { responses: draft.responses.value.trim() })
    },
    ...(draft.defaultModel.trim() === "" ? {} : { defaultModel: draft.defaultModel.trim() }),
    apiKey,
    setActive: draft.setActive
  };
  const parsed = upsertProviderProfileInputSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new SettingsFormError(
      "提供方资料不符合本地设置契约。",
      fieldsFromIssues(parsed.error.issues)
    );
  }
  return parsed.data;
}

function activeProviderIdAfter(
  current: ReadSettingsResult,
  nextActiveProviderId: string | undefined
): string | undefined {
  return nextActiveProviderId ?? current.activeProviderId;
}

function alignActiveProfiles(
  profiles: readonly ProviderProfileDescriptor[],
  activeProviderId: string | undefined
): ProviderProfileDescriptor[] {
  return profiles.map((profile) => ({
    ...profile,
    isActive: activeProviderId !== undefined && profile.id === activeProviderId
  }));
}

export function mergeUpsertProviderProfile(
  current: ReadSettingsResult,
  result: UpsertProviderProfileResult
): ReadSettingsResult {
  const existingIndex = current.profiles.findIndex((profile) => profile.id === result.profile.id);
  const profiles = [...current.profiles];
  if (existingIndex === -1) profiles.push(result.profile);
  else profiles[existingIndex] = result.profile;
  const activeProviderId = activeProviderIdAfter(current, result.activeProviderId);
  return {
    ...current,
    ...(activeProviderId === undefined ? { activeProviderId: undefined } : { activeProviderId }),
    profiles: alignActiveProfiles(profiles, activeProviderId)
  };
}

export function mergeRemovedProviderProfile(
  current: ReadSettingsResult,
  result: RemoveProviderProfileResult
): ReadSettingsResult {
  const profiles = current.profiles.filter((profile) => profile.id !== result.removedProfileId);
  return {
    ...current,
    ...(result.activeProviderId === undefined
      ? { activeProviderId: undefined }
      : { activeProviderId: result.activeProviderId }),
    profiles: alignActiveProfiles(profiles, result.activeProviderId)
  };
}

export function mergeActiveProviderProfile(
  current: ReadSettingsResult,
  result: SetActiveProviderProfileResult
): ReadSettingsResult {
  const profiles = current.profiles.map((profile) =>
    profile.id === result.profile.id ? result.profile : profile
  );
  return {
    ...current,
    activeProviderId: result.activeProviderId,
    profiles: alignActiveProfiles(profiles, result.activeProviderId),
    defaults:
      result.profile.defaultModel === undefined
        ? current.defaults
        : { ...current.defaults, model: result.profile.defaultModel }
  };
}

export function activeSettingsModel(settings: ReadSettingsResult): string | undefined {
  const activeProfile = activeSettingsProfile(settings);
  return (
    settings.defaults.model?.trim() ||
    activeProfile?.defaultModel?.trim() ||
    activeProfile?.models[0]?.trim() ||
    undefined
  );
}

export function providerSwitchFeedback(
  settings: ReadSettingsResult,
  providerId: string
): ProviderSwitchFeedback {
  const target = settings.profiles.find((profile) => profile.id === providerId);
  const currentModel = activeSettingsModel(settings);
  if (target === undefined) {
    return { providerId, retainedModel: false };
  }
  if (currentModel !== undefined && target.models.includes(currentModel)) {
    return { providerId, model: currentModel, retainedModel: true };
  }
  const model = target.defaultModel?.trim() || target.models[0]?.trim() || undefined;
  return {
    providerId,
    ...(model === undefined ? {} : { model }),
    retainedModel: false
  };
}

export function isValidatedActiveProviderResult(
  value: unknown,
  requestedProviderId: string
): value is SetActiveProviderProfileResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SetActiveProviderProfileResult>;
  return (
    candidate.schemaVersion === 1 &&
    candidate.activeProviderId === requestedProviderId &&
    typeof candidate.profile === "object" &&
    candidate.profile !== null &&
    candidate.profile.id === requestedProviderId &&
    candidate.profile.isActive === true
  );
}

export function mergeRefreshedModels(
  current: ReadSettingsResult,
  result: RefreshModelsResult
): ReadSettingsResult {
  if (result.status !== "succeeded") return current;
  return {
    ...current,
    profiles: current.profiles.map((profile) =>
      profile.id === result.providerId ? { ...profile, models: result.models } : profile
    )
  };
}

export function buildDefaultsSettingsInput(
  defaults: ReadSettingsResult["defaults"]
): UpdateSettingsInput {
  const parsedDefaults = routegoDefaultsSchema.safeParse(defaults);
  if (!parsedDefaults.success) {
    throw new SettingsFormError(
      "默认生成参数不符合本地设置契约。",
      fieldsFromIssues(parsedDefaults.error.issues)
    );
  }
  return updateSettingsInputSchema.parse({ defaults: parsedDefaults.data });
}

export function createOutputDirectoryDraft(): OutputDirectoryDraft {
  return { operation: "unchanged", path: "", confirmLocalPath: false };
}

export function clearOutputDirectorySensitiveDraft(
  draft: OutputDirectoryDraft
): OutputDirectoryDraft {
  return { ...draft, operation: "unchanged", path: "", confirmLocalPath: false };
}

export function buildOutputDirectorySettingsInput(
  draft: OutputDirectoryDraft
): UpdateSettingsInput {
  const outputDirectory =
    draft.operation === "replace"
      ? {
          operation: "replace" as const,
          path: draft.path,
          confirmLocalPath: draft.confirmLocalPath
        }
      : { operation: draft.operation };
  const parsed = updateSettingsInputSchema.safeParse({ outputDirectory });
  if (!parsed.success) {
    throw new SettingsFormError(
      "输出目录操作不符合本地设置契约。",
      fieldsFromIssues(parsed.error.issues)
    );
  }
  return parsed.data;
}

export function buildCapabilityProbeInput(
  draft: CapabilityProbeDraft
): CapabilityProbeInput {
  const parsed = capabilityProbeInputSchema.safeParse({
    providerId: draft.providerId,
    model: draft.model.trim(),
    capability: draft.capability,
    transport: draft.transport,
    requestShape: draft.requestShape.trim(),
    ...(draft.confirmBillableProbe ? { confirmBillableProbe: true } : {})
  });
  if (!parsed.success) {
    throw new SettingsFormError(
      "能力探测需要完整范围和明确的潜在计费确认。",
      fieldsFromIssues(parsed.error.issues)
    );
  }
  return parsed.data;
}

export function activeSettingsProfile(
  settings: ReadSettingsResult
): ProviderProfileDescriptor | undefined {
  return settings.profiles.find(
    (profile) => profile.id === settings.activeProviderId && profile.isActive
  );
}
