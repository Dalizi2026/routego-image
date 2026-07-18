import {
  routegoErrorCodeSchema,
  routegoServiceErrorSchema,
  routegoStatusResultSchema,
  type ProviderCapabilityRecord,
  type ProviderProfileDescriptor,
  type ReadSettingsResult,
  type RoutegoServiceError,
  type RoutegoStatusResult
} from "@routego-image/contracts";
import type {
  ProviderDeadlinePolicy,
  ProviderRetryPolicy,
  ProviderRuntimeContext
} from "@routego-image/creation";
import {
  fingerprintProviderEndpoint,
  redactDiagnostic
} from "@routego-image/foundation";
import type { RuntimeProviderProfile } from "@routego-image/library";

export const DEFAULT_PROVIDER_DEADLINES: ProviderDeadlinePolicy = Object.freeze({
  responseHeaderMs: 30_000,
  bodyMs: 120_000,
  downloadMs: 30_000,
  totalMs: 180_000
});

export const DEFAULT_PROVIDER_RETRY: ProviderRetryPolicy = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5_000
});

const MAX_DIAGNOSTIC_DEPTH = 5;
const MAX_DIAGNOSTIC_ITEMS = 32;
const MAX_DIAGNOSTIC_STRING = 500;
const MAX_DIAGNOSTIC_JSON = 8_192;
const REDACTED_PATH = "[REDACTED_PATH]";

export interface ProviderProfileReader {
  getRuntimeProviderProfile(profileId?: string): Promise<RuntimeProviderProfile>;
}

export interface ProviderStatusReader extends ProviderProfileReader {
  readSettings(input?: Record<string, never>): Promise<ReadSettingsResult>;
}

export interface LoadProviderContextInput {
  readonly providerId?: string;
  readonly model?: string;
}

export interface LoadProviderContextOptions {
  readonly fetch?: typeof fetch;
  readonly deadlines?: ProviderDeadlinePolicy;
  readonly retry?: ProviderRetryPolicy;
  readonly now?: () => number;
  readonly random?: () => number;
}

export interface ProviderStatusOptions {
  readonly service:
    | RoutegoStatusResult["service"]
    | (() =>
        | RoutegoStatusResult["service"]
        | Promise<RoutegoStatusResult["service"]>);
}

export class ProviderIntegrationError extends Error {
  readonly serviceError: RoutegoServiceError;

  constructor(serviceError: RoutegoServiceError, options?: ErrorOptions) {
    super(serviceError.safeMessage, options);
    this.name = "ProviderIntegrationError";
    this.serviceError = routegoServiceErrorSchema.parse(serviceError);
  }
}

function boundedString(value: string): string {
  return value.length <= MAX_DIAGNOSTIC_STRING
    ? value
    : `${value.slice(0, MAX_DIAGNOSTIC_STRING - 14)}...[TRUNCATED]`;
}

function redactLocalPaths(value: string): string {
  return value
    .replace(/\\\\[^\\\s]+\\[^\s,;]+/gu, REDACTED_PATH)
    .replace(/\b[A-Za-z]:[\\/][^\s,;]+/gu, REDACTED_PATH)
    .replace(/(^|[\s("'=])\/(?:Users|home|tmp|var|private|mnt)\/[^\s,;)]+/gu, `$1${REDACTED_PATH}`);
}

export function redactProviderText(value: string): string {
  const redacted = redactDiagnostic(value);
  return boundedString(
    redactLocalPaths(typeof redacted === "string" ? redacted : String(redacted))
  );
}

function boundDiagnostic(value: unknown, depth: number): unknown {
  if (typeof value === "string") return boundedString(redactLocalPaths(value));
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (depth >= MAX_DIAGNOSTIC_DEPTH) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    const output = value
      .slice(0, MAX_DIAGNOSTIC_ITEMS)
      .map((item) => boundDiagnostic(item, depth + 1));
    if (value.length > MAX_DIAGNOSTIC_ITEMS) output.push("[TRUNCATED]");
    return output;
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, child] of entries.slice(0, MAX_DIAGNOSTIC_ITEMS)) {
      output[key] = boundDiagnostic(child, depth + 1);
    }
    if (entries.length > MAX_DIAGNOSTIC_ITEMS) output["truncated"] = true;
    return output;
  }
  return boundedString(String(value));
}

export function boundedRedactedDiagnostic(value: unknown): Readonly<Record<string, unknown>> {
  const redacted = boundDiagnostic(redactDiagnostic(value), 0);
  const record =
    redacted !== null && typeof redacted === "object" && !Array.isArray(redacted)
      ? (redacted as Record<string, unknown>)
      : { value: redacted };
  const serialized = JSON.stringify(record);
  if (serialized.length <= MAX_DIAGNOSTIC_JSON) return record;
  return {
    truncated: true,
    preview: boundedString(redactLocalPaths(serialized.slice(0, MAX_DIAGNOSTIC_JSON - 100)))
  };
}

function errorCategory(code: RoutegoServiceError["code"]): RoutegoServiceError["category"] {
  switch (code) {
    case "config_missing":
    case "config_corrupt":
      return "configuration";
    case "invalid_request":
    case "invalid_input":
      return "validation";
    case "capability_unavailable":
      return "capability";
    case "auth_failed":
      return "authentication";
    case "rate_limited":
      return "rate_limit";
    case "timeout":
      return "timeout";
    case "moderation_blocked":
      return "moderation";
    case "provider_5xx":
      return "provider";
    case "invalid_response":
    case "internal_contract":
      return "protocol";
    case "download_failed":
      return "download";
    case "postprocess_failed":
      return "postprocess";
    case "file_write_failed":
    case "conflict":
      return "persistence";
    case "access_denied":
    case "origin_rejected":
    case "session_invalid":
    case "path_unsafe":
      return "security";
    case "cancelled":
      return "cancelled";
    case "not_found":
      return "validation";
  }
}

export function createProviderServiceError(input: {
  readonly code: RoutegoServiceError["code"];
  readonly stage: RoutegoServiceError["stage"];
  readonly safeMessage: string;
  readonly retryDisposition?: RoutegoServiceError["retryDisposition"];
  readonly httpStatus?: number;
  readonly providerCode?: string;
  readonly capability?: RoutegoServiceError["capability"];
  readonly mayHaveBilled?: boolean;
  readonly details?: unknown;
}): RoutegoServiceError {
  return routegoServiceErrorSchema.parse({
    code: input.code,
    category: errorCategory(input.code),
    stage: input.stage,
    safeMessage: input.safeMessage,
    retryDisposition: input.retryDisposition ?? "never",
    ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
    ...(input.providerCode === undefined
      ? {}
      : { providerCode: redactProviderText(input.providerCode) }),
    ...(input.capability === undefined ? {} : { capability: input.capability }),
    partialArtifacts: [],
    receivedAnyOutput: false,
    mayHaveBilled: input.mayHaveBilled === true,
    ...(input.details === undefined ? {} : { details: boundedRedactedDiagnostic(input.details) })
  });
}

export function toProviderServiceError(
  error: unknown,
  fallback: {
    readonly code: RoutegoServiceError["code"];
    readonly stage: RoutegoServiceError["stage"];
    readonly safeMessage: string;
    readonly mayHaveBilled?: boolean;
  }
): RoutegoServiceError {
  if (error instanceof ProviderIntegrationError) return error.serviceError;
  if (typeof error === "object" && error !== null && "code" in error) {
    const parsedCode = routegoErrorCodeSchema.safeParse((error as { code?: unknown }).code);
    if (parsedCode.success) {
      return createProviderServiceError({
        code: parsedCode.data,
        stage: fallback.stage,
        safeMessage: fallback.safeMessage,
        ...(fallback.mayHaveBilled === undefined
          ? {}
          : { mayHaveBilled: fallback.mayHaveBilled }),
        details: error
      });
    }
  }
  return createProviderServiceError({
    code: fallback.code,
    stage: fallback.stage,
    safeMessage: fallback.safeMessage,
    ...(fallback.mayHaveBilled === undefined
      ? {}
      : { mayHaveBilled: fallback.mayHaveBilled }),
    details: error
  });
}

function selectedModel(profile: RuntimeProviderProfile, requestedModel?: string): string {
  const requested = requestedModel?.trim();
  const model = requested || profile.defaultModel || profile.models[0];
  if (!model) {
    throw new ProviderIntegrationError(
      createProviderServiceError({
        code: "config_missing",
        stage: "configure",
        safeMessage: "The selected provider has no configured default model."
      })
    );
  }
  if (
    requested &&
    profile.models.length > 0 &&
    !profile.models.includes(requested) &&
    profile.defaultModel !== requested
  ) {
    throw new ProviderIntegrationError(
      createProviderServiceError({
        code: "invalid_input",
        stage: "configure",
        safeMessage: "The requested model is not available to the selected provider profile.",
        details: { providerId: profile.id, model: requested }
      })
    );
  }
  return model;
}

export async function loadProviderContext(
  owner: ProviderProfileReader,
  input: LoadProviderContextInput = {},
  options: LoadProviderContextOptions = {}
): Promise<ProviderRuntimeContext> {
  let profile: RuntimeProviderProfile;
  try {
    profile = await owner.getRuntimeProviderProfile(input.providerId);
  } catch (error) {
    throw new ProviderIntegrationError(
      toProviderServiceError(error, {
        code: "config_missing",
        stage: "configure",
        safeMessage: "The selected provider profile is unavailable."
      }),
      { cause: error }
    );
  }
  if (!profile.credential) {
    throw new ProviderIntegrationError(
      createProviderServiceError({
        code: "config_missing",
        stage: "configure",
        safeMessage: "The selected provider profile has no API key."
      })
    );
  }
  return {
    providerId: profile.id,
    model: selectedModel(profile, input.model),
    endpoints: profile.endpoints,
    capabilities: [...profile.capabilities],
    apiKey: profile.credential,
    fetch: options.fetch ?? globalThis.fetch,
    deadlines: options.deadlines ?? DEFAULT_PROVIDER_DEADLINES,
    retry: options.retry ?? DEFAULT_PROVIDER_RETRY,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.random === undefined ? {} : { random: options.random })
  };
}

function endpointForCapability(
  descriptor: ProviderProfileDescriptor,
  runtime: RuntimeProviderProfile,
  record: ProviderCapabilityRecord
): ProviderProfileDescriptor["endpoints"]["generation"] | undefined {
  if (record.scope.transport === "single-endpoint-json") {
    return record.scope.endpointFingerprint ===
      fingerprintProviderEndpoint(runtime.normalizedEndpoints.generationEndpoint)
      ? descriptor.endpoints.generation
      : undefined;
  }
  if (record.scope.transport === "openai-responses") {
    const endpoint = runtime.normalizedEndpoints.responsesEndpoint;
    return endpoint !== undefined &&
      record.scope.endpointFingerprint === fingerprintProviderEndpoint(endpoint)
      ? descriptor.endpoints.responses
      : undefined;
  }
  if (record.scope.requestShape === "openai-images:edits-multipart") {
    const endpoint = runtime.normalizedEndpoints.editsEndpoint;
    return endpoint !== undefined &&
      record.scope.endpointFingerprint === fingerprintProviderEndpoint(endpoint)
      ? descriptor.endpoints.edits
      : undefined;
  }
  return record.scope.endpointFingerprint ===
    fingerprintProviderEndpoint(runtime.normalizedEndpoints.generationEndpoint)
    ? descriptor.endpoints.generation
    : undefined;
}

function capabilitySnapshots(
  descriptor: ProviderProfileDescriptor,
  runtime: RuntimeProviderProfile
): RoutegoStatusResult["capabilities"] {
  const groups = new Map<
    string,
    {
      model: string;
      endpoint: ProviderProfileDescriptor["endpoints"]["generation"];
      records: ProviderCapabilityRecord[];
    }
  >();
  for (const record of runtime.capabilities) {
    const endpoint = endpointForCapability(descriptor, runtime, record);
    if (!endpoint) continue;
    const key = `${record.scope.model}\0${endpoint.display}`;
    const group = groups.get(key) ?? {
      model: record.scope.model,
      endpoint,
      records: []
    };
    group.records.push(record);
    groups.set(key, group);
  }
  return [...groups.values()].slice(0, 100).map((group) => ({
    schemaVersion: 1,
    providerId: runtime.id,
    model: group.model,
    endpoint: group.endpoint,
    capabilities: group.records.slice(0, 128)
  }));
}

export async function readProviderStatus(
  owner: ProviderStatusReader,
  options: ProviderStatusOptions
): Promise<RoutegoStatusResult> {
  let settings: ReadSettingsResult;
  try {
    settings = await owner.readSettings({});
  } catch (error) {
    throw new ProviderIntegrationError(
      toProviderServiceError(error, {
        code: "config_corrupt",
        stage: "configure",
        safeMessage: "Provider settings could not be read safely."
      }),
      { cause: error }
    );
  }
  const active = settings.activeProviderId === undefined
    ? undefined
    : settings.profiles.find((profile) => profile.id === settings.activeProviderId);
  const service = typeof options.service === "function"
    ? await options.service()
    : options.service;
  if (!active) {
    return routegoStatusResultSchema.parse({
      schemaVersion: 1,
      configured: false,
      hasApiKey: false,
      models: [],
      capabilities: [],
      defaults: settings.defaults,
      service
    });
  }
  let runtime: RuntimeProviderProfile;
  try {
    runtime = await owner.getRuntimeProviderProfile(active.id);
  } catch (error) {
    throw new ProviderIntegrationError(
      toProviderServiceError(error, {
        code: "config_corrupt",
        stage: "configure",
        safeMessage: "The active provider profile could not be loaded safely."
      }),
      { cause: error }
    );
  }
  return routegoStatusResultSchema.parse({
    schemaVersion: 1,
    configured: true,
    hasApiKey: active.hasApiKey,
    ...(active.apiKeyPreview === undefined ? {} : { apiKeyPreview: active.apiKeyPreview }),
    providerId: active.id,
    endpoint: active.endpoints.generation,
    models: [...active.models],
    capabilities: capabilitySnapshots(active, runtime),
    defaults: settings.defaults,
    service
  });
}
