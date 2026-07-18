import {
  refreshModelsInputSchema,
  refreshModelsResultSchema,
  type RefreshModelsInput,
  type RefreshModelsResult
} from "@routego-image/contracts";
import type { RuntimeProviderProfile } from "@routego-image/library";

import {
  createProviderServiceError,
  toProviderServiceError,
  type ProviderProfileReader
} from "./context";

export const MAX_MODEL_RESPONSE_BYTES = 256 * 1024;
export const DEFAULT_MODEL_REFRESH_TIMEOUT_MS = 30_000;

export interface ModelRefreshOwner extends ProviderProfileReader {
  persistModelRefresh(result: RefreshModelsResult): Promise<void>;
}

export interface RefreshProviderModelsOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

function failedResult(
  providerId: string,
  error: ReturnType<typeof createProviderServiceError>
): RefreshModelsResult {
  return refreshModelsResultSchema.parse({
    schemaVersion: 1,
    providerId,
    status: "failed",
    billable: false,
    models: [],
    error
  });
}

function mediaType(headers: Headers): string | undefined {
  const value = headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return value || undefined;
}

function jsonMediaType(value: string | undefined): boolean {
  return value === "application/json" || value?.endsWith("+json") === true;
}

export async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maximumBytes) {
    await response.body?.cancel("response-too-large").catch(() => undefined);
    throw new Error("response-too-large");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("response-too-large").catch(() => undefined);
        throw new Error("response-too-large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function modelId(value: unknown): string {
  const candidate = typeof value === "string"
    ? value
    : value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)["id"]
      : undefined;
  if (typeof candidate !== "string" || candidate.trim().length < 1 || candidate.length > 200) {
    throw new Error("invalid-model-entry");
  }
  return candidate.trim();
}

export function parseBoundedModelPayload(value: unknown): readonly string[] {
  const list = Array.isArray(value)
    ? value
    : value !== null && typeof value === "object" && !Array.isArray(value)
      ? Array.isArray((value as Record<string, unknown>)["data"])
        ? ((value as Record<string, unknown>)["data"] as unknown[])
        : Array.isArray((value as Record<string, unknown>)["models"])
          ? ((value as Record<string, unknown>)["models"] as unknown[])
          : undefined
      : undefined;
  if (!list || list.length > 500) throw new Error("invalid-model-list");
  const models = list.map(modelId);
  return [...new Set(models)];
}

function responseError(response: Response) {
  const status = response.status;
  const code = status === 401 || status === 403
    ? "auth_failed"
    : status === 429
      ? "rate_limited"
      : status === 408
        ? "timeout"
        : status >= 500
          ? "provider_5xx"
          : "invalid_response";
  return createProviderServiceError({
    code,
    stage: "submit",
    safeMessage: "The configured models endpoint did not return an accepted model list.",
    httpStatus: status,
    retryDisposition: code === "rate_limited" ? "respect-retry-after" : "never",
    details: { httpStatus: status, responseType: mediaType(response.headers) }
  });
}

function safeTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_MODEL_REFRESH_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) {
    throw new Error("invalid-timeout");
  }
  return timeout;
}

export async function refreshProviderModels(
  owner: ModelRefreshOwner,
  input: RefreshModelsInput,
  options: RefreshProviderModelsOptions = {}
): Promise<RefreshModelsResult> {
  const parsed = refreshModelsInputSchema.parse(input);
  let profile: RuntimeProviderProfile;
  try {
    profile = await owner.getRuntimeProviderProfile(parsed.providerId);
  } catch (error) {
    return failedResult(
      parsed.providerId,
      toProviderServiceError(error, {
        code: "config_missing",
        stage: "configure",
        safeMessage: "The selected provider profile is unavailable."
      })
    );
  }
  const endpoint = profile.normalizedEndpoints.modelsEndpoint;
  if (!endpoint) {
    return failedResult(
      parsed.providerId,
      createProviderServiceError({
        code: "config_missing",
        stage: "configure",
        safeMessage: "This provider profile has no explicitly configured models endpoint."
      })
    );
  }
  if (!profile.credential) {
    return failedResult(
      parsed.providerId,
      createProviderServiceError({
        code: "config_missing",
        stage: "configure",
        safeMessage: "The selected provider profile has no API key."
      })
    );
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    timeout = setTimeout(() => controller.abort("model-refresh-timeout"), safeTimeout(options.timeoutMs));
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${profile.credential}`
        },
        signal: controller.signal
      });
    } catch (error) {
      return failedResult(
        parsed.providerId,
        createProviderServiceError({
          code: controller.signal.aborted ? "timeout" : "invalid_response",
          stage: "submit",
          safeMessage: controller.signal.aborted
            ? "The non-billable model refresh timed out."
            : "The configured models endpoint could not be reached.",
          details: error
        })
      );
    }
    if (!response.ok) {
      await response.body?.cancel("model-refresh-rejected").catch(() => undefined);
      return failedResult(parsed.providerId, responseError(response));
    }
    const type = mediaType(response.headers);
    if (!jsonMediaType(type)) {
      await response.body?.cancel("invalid-content-type").catch(() => undefined);
      return failedResult(
        parsed.providerId,
        createProviderServiceError({
          code: "invalid_response",
          stage: "parse",
          safeMessage: "The configured models endpoint returned a non-JSON response.",
          details: { responseType: type }
        })
      );
    }
    let models: readonly string[];
    try {
      const bytes = await readBoundedResponseBytes(
        response,
        options.maxResponseBytes ?? MAX_MODEL_RESPONSE_BYTES
      );
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      models = parseBoundedModelPayload(JSON.parse(text) as unknown);
    } catch (error) {
      return failedResult(
        parsed.providerId,
        createProviderServiceError({
          code: "invalid_response",
          stage: "parse",
          safeMessage: "The configured models endpoint returned an invalid or oversized model list.",
          details: error
        })
      );
    }
    const refreshedAt = (options.now ?? (() => new Date()))().toISOString();
    const result = refreshModelsResultSchema.parse({
      schemaVersion: 1,
      providerId: parsed.providerId,
      status: "succeeded",
      billable: false,
      models,
      refreshedAt
    });
    try {
      await owner.persistModelRefresh(result);
    } catch (error) {
      return failedResult(
        parsed.providerId,
        toProviderServiceError(error, {
          code: "file_write_failed",
          stage: "persist",
          safeMessage: "The refreshed model list could not be saved."
        })
      );
    }
    return result;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
