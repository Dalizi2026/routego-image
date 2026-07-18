import {
  capabilityProbeInputSchema,
  capabilityProbeResultSchema,
  type CapabilityEvidence,
  type CapabilityProbeInput,
  type CapabilityProbeResult,
  type ProviderCapability,
  type ProviderCapabilityRecord,
  type ProviderTransport,
  type RoutegoServiceError
} from "@routego-image/contracts";
import {
  createUnknownCapabilityRecord,
  evaluateCapabilityProbe,
  fingerprintProviderEndpoint,
  PROVIDER_REQUEST_SHAPES,
  transitionCapability
} from "@routego-image/foundation";
import type { RuntimeProviderProfile } from "@routego-image/library";

import { createDeterministicSyntheticPngInputs } from "../image/png";
import {
  ProviderIntegrationError,
  boundedRedactedDiagnostic,
  createProviderServiceError,
  redactProviderText,
  toProviderServiceError,
  type ProviderProfileReader
} from "./context";
import { readBoundedResponseBytes } from "./models";

export const DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS = 120_000;
export const MAX_CAPABILITY_PROBE_ERROR_BYTES = 32 * 1024;

export interface CapabilityProbeOwner extends ProviderProfileReader {
  persistCapabilityProbe(result: CapabilityProbeResult): Promise<void>;
}

export type CapabilityProbeOutcome =
  | { readonly outcome: "supported" }
  | { readonly outcome: "unsupported"; readonly providerCode?: string }
  | { readonly outcome: "degraded"; readonly degradedReason: string }
  | {
      readonly outcome: "transient";
      readonly error: RoutegoServiceError;
      readonly providerCode?: string;
    };

export interface CapabilityProbeRequestDescriptor {
  readonly endpoint: string;
  readonly request: RequestInit;
}

export interface ProbeProviderCapabilityOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  readonly interpretResponse?: (
    response: Response,
    context: {
      readonly input: CapabilityProbeInput;
      readonly responseShape: string;
    }
  ) => CapabilityProbeOutcome | Promise<CapabilityProbeOutcome>;
}

const SHAPE_CAPABILITIES: Readonly<Record<string, ReadonlySet<ProviderCapability>>> = {
  [PROVIDER_REQUEST_SHAPES.singleEndpointText]: new Set([
    "text-generation",
    "native-variants",
    "custom-size",
    "quality-control",
    "output-format",
    "compression",
    "moderation"
  ]),
  [PROVIDER_REQUEST_SHAPES.singleEndpointImage]: new Set([
    "single-image-input",
    "target-edit",
    "canvas-expansion",
    "native-transparency",
    "image-url-input",
    "base64-input",
    "data-url-input"
  ]),
  [PROVIDER_REQUEST_SHAPES.singleEndpointImages]: new Set([
    "multi-image-input",
    "target-edit",
    "image-url-input",
    "base64-input",
    "data-url-input"
  ]),
  [PROVIDER_REQUEST_SHAPES.imagesGenerationsJson]: new Set([
    "text-generation",
    "native-variants",
    "custom-size",
    "quality-control",
    "output-format",
    "compression",
    "native-transparency",
    "moderation"
  ]),
  [PROVIDER_REQUEST_SHAPES.imagesEditsMultipart]: new Set([
    "single-image-input",
    "multi-image-input",
    "target-edit",
    "mask-edit",
    "canvas-expansion",
    "multipart-input"
  ]),
  [PROVIDER_REQUEST_SHAPES.responsesImageGeneration]: new Set([
    "text-generation",
    "single-image-input",
    "multi-image-input",
    "target-edit",
    "streaming",
    "partial-images",
    "responses-state",
    "image-url-input",
    "base64-input",
    "data-url-input"
  ])
};

function expectedTransport(requestShape: string): ProviderTransport | undefined {
  if (requestShape.startsWith("single-endpoint-json:")) return "single-endpoint-json";
  if (requestShape.startsWith("openai-images:")) return "openai-images";
  if (requestShape.startsWith("openai-responses:")) return "openai-responses";
  return undefined;
}

function safeTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000) {
    throw new ProviderIntegrationError(
      createProviderServiceError({
        code: "invalid_input",
        stage: "validate",
        safeMessage: "The capability-probe timeout is invalid."
      })
    );
  }
  return timeout;
}

function exactEndpoint(profile: RuntimeProviderProfile, input: CapabilityProbeInput): string {
  if (input.transport === "single-endpoint-json") {
    return profile.normalizedEndpoints.generationEndpoint;
  }
  if (input.transport === "openai-responses") {
    if (!profile.normalizedEndpoints.responsesEndpoint) {
      throw new ProviderIntegrationError(
        createProviderServiceError({
          code: "config_missing",
          stage: "configure",
          safeMessage: "This provider profile has no explicitly configured Responses endpoint."
        })
      );
    }
    return profile.normalizedEndpoints.responsesEndpoint;
  }
  if (input.requestShape === PROVIDER_REQUEST_SHAPES.imagesEditsMultipart) {
    if (!profile.normalizedEndpoints.editsEndpoint) {
      throw new ProviderIntegrationError(
        createProviderServiceError({
          code: "config_missing",
          stage: "configure",
          safeMessage: "This provider profile has no explicitly configured Edits endpoint."
        })
      );
    }
    return profile.normalizedEndpoints.editsEndpoint;
  }
  return profile.normalizedEndpoints.generationEndpoint;
}

function validateProbeShape(input: CapabilityProbeInput): void {
  const transport = expectedTransport(input.requestShape);
  const capabilities = SHAPE_CAPABILITIES[input.requestShape];
  if (transport !== input.transport || !capabilities?.has(input.capability)) {
    throw new ProviderIntegrationError(
      createProviderServiceError({
        code: "invalid_request",
        stage: "validate",
        safeMessage: "The confirmed capability probe does not match one exact transport and request shape.",
        capability: input.capability,
        details: {
          transport: input.transport,
          requestShape: input.requestShape,
          capability: input.capability
        }
      })
    );
  }
}

function jsonProbeBody(input: CapabilityProbeInput): string {
  const synthetic = createDeterministicSyntheticPngInputs();
  const common = {
    model: input.model,
    prompt: "Routego capability probe: preserve the synthetic blue checkerboard exactly.",
    n: 1,
    size: "256x256",
    response_format: "b64_json"
  };
  const controls = {
    ...(input.capability === "native-variants" ? { n: 2 } : {}),
    ...(input.capability === "custom-size" ? { size: "256x256" } : {}),
    ...(input.capability === "quality-control" ? { quality: "low" } : {}),
    ...(input.capability === "output-format" ? { output_format: "png" } : {}),
    ...(input.capability === "compression" ? { output_compression: 80 } : {}),
    ...(input.capability === "native-transparency" ? { background: "transparent" } : {}),
    ...(input.capability === "moderation" ? { moderation: "low" } : {}),
    ...(input.capability === "streaming" ? { stream: true } : {}),
    ...(input.capability === "partial-images" ? { partial_images: 1, stream: true } : {})
  };
  if (input.requestShape === PROVIDER_REQUEST_SHAPES.singleEndpointImage) {
    return JSON.stringify({ ...common, ...controls, image: synthetic.image.dataUrl });
  }
  if (input.requestShape === PROVIDER_REQUEST_SHAPES.singleEndpointImages) {
    return JSON.stringify({
      ...common,
      ...controls,
      images: [synthetic.image.dataUrl, synthetic.mask.dataUrl]
    });
  }
  if (input.requestShape === PROVIDER_REQUEST_SHAPES.responsesImageGeneration) {
    const needsImage = new Set<ProviderCapability>([
      "single-image-input",
      "multi-image-input",
      "target-edit",
      "image-url-input",
      "base64-input",
      "data-url-input"
    ]).has(input.capability);
    return JSON.stringify({
      model: input.model,
      input: needsImage
        ? [{
            role: "user",
            content: [
              { type: "input_text", text: common.prompt },
              { type: "input_image", image_url: synthetic.image.dataUrl }
            ]
          }]
        : common.prompt,
      tools: [{ type: "image_generation", ...controls }]
    });
  }
  return JSON.stringify({ ...common, ...controls });
}

function requestDescriptor(
  profile: RuntimeProviderProfile,
  input: CapabilityProbeInput
): CapabilityProbeRequestDescriptor {
  const endpoint = exactEndpoint(profile, input);
  const authorization = `Bearer ${profile.credential}`;
  if (input.requestShape === PROVIDER_REQUEST_SHAPES.imagesEditsMultipart) {
    const synthetic = createDeterministicSyntheticPngInputs();
    const body = new FormData();
    body.set("model", input.model);
    body.set("prompt", "Routego capability probe: preserve the synthetic input exactly.");
    body.append(
      "image",
      new Blob([Uint8Array.from(synthetic.image.bytes).buffer], {
        type: synthetic.image.mimeType
      }),
      "routego-probe.png"
    );
    if (input.capability === "mask-edit") {
      body.append(
        "mask",
        new Blob([Uint8Array.from(synthetic.mask.bytes).buffer], {
          type: synthetic.mask.mimeType
        }),
        "routego-probe-mask.png"
      );
    }
    return {
      endpoint,
      request: {
        method: "POST",
        headers: { accept: "application/json", authorization },
        body
      }
    };
  }
  return {
    endpoint,
    request: {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization,
        "content-type": "application/json"
      },
      body: jsonProbeBody(input)
    }
  };
}

function responseShape(response: Response): string {
  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return `http:${response.status};content-type:${(type || "unknown").slice(0, 100)}`;
}

function errorCodeFromBody(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const error = record["error"];
  const candidate =
    typeof record["code"] === "string"
      ? record["code"]
      : error !== null && typeof error === "object" && !Array.isArray(error)
        ? (error as Record<string, unknown>)["code"]
        : undefined;
  return typeof candidate === "string" && candidate.length <= 200 ? candidate : undefined;
}

function unsupportedProviderCode(code: string | undefined): boolean {
  return code !== undefined && /(?:not[_-]?supported|unsupported|unknown[_-]?(?:parameter|feature|endpoint))/iu.test(code);
}

function moderationProviderCode(code: string | undefined): boolean {
  return code !== undefined && /moderation|content[_-]?policy|safety/iu.test(code);
}

async function defaultInterpretResponse(response: Response): Promise<CapabilityProbeOutcome> {
  const shape = responseShape(response);
  if (response.ok) {
    const declaredState = response.headers.get("x-routego-capability-state")?.trim().toLowerCase();
    if (declaredState === "degraded") {
      const reason = response.headers.get("x-routego-degraded-reason")?.trim();
      await response.body?.cancel("probe-evidence-recorded").catch(() => undefined);
      return {
        outcome: "degraded",
        degradedReason: reason && reason.length <= 500
          ? redactProviderText(reason)
          : "The provider completed only a weaker confirmed fallback."
      };
    }
    await response.body?.cancel("probe-evidence-recorded").catch(() => undefined);
    return { outcome: "supported" };
  }
  let providerCode: string | undefined;
  try {
    const bytes = await readBoundedResponseBytes(response, MAX_CAPABILITY_PROBE_ERROR_BYTES);
    if (bytes.byteLength > 0) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      providerCode = errorCodeFromBody(JSON.parse(text) as unknown);
    }
  } catch {
    // Oversized or malformed provider bodies are intentionally discarded.
  }
  if (
    response.status === 404 ||
    response.status === 405 ||
    response.status === 415 ||
    response.status === 501 ||
    ((response.status === 400 || response.status === 422) && unsupportedProviderCode(providerCode))
  ) {
    return { outcome: "unsupported", ...(providerCode ? { providerCode } : {}) };
  }
  const code = response.status === 401 || response.status === 403
    ? "auth_failed"
    : response.status === 429
      ? "rate_limited"
      : response.status === 408
        ? "timeout"
        : response.status >= 500
          ? "provider_5xx"
          : moderationProviderCode(providerCode)
            ? "moderation_blocked"
            : "invalid_response";
  return {
    outcome: "transient",
    ...(providerCode ? { providerCode } : {}),
    error: createProviderServiceError({
      code,
      stage: "submit",
      safeMessage: "The confirmed capability probe did not produce conclusive capability evidence.",
      httpStatus: response.status,
      ...(providerCode === undefined ? {} : { providerCode }),
      mayHaveBilled: true,
      details: { responseShape: shape }
    })
  };
}

function matchingRecord(
  profile: RuntimeProviderProfile,
  input: CapabilityProbeInput,
  endpointFingerprint: string
): ProviderCapabilityRecord | undefined {
  return profile.capabilities.find(
    (record) =>
      record.capability === input.capability &&
      record.scope.providerId === input.providerId &&
      record.scope.model === input.model &&
      record.scope.endpointFingerprint === endpointFingerprint &&
      record.scope.transport === input.transport &&
      record.scope.requestShape === input.requestShape
  );
}

function evidence(input: {
  readonly source: CapabilityEvidence["source"];
  readonly observedAt: string;
  readonly summary: string;
  readonly requestShape: string;
  readonly responseShape?: string;
  readonly httpStatus?: number;
  readonly providerCode?: string;
}): CapabilityEvidence {
  return {
    source: input.source,
    observedAt: input.observedAt,
    summary: input.summary,
    requestShape: input.requestShape,
    ...(input.responseShape === undefined ? {} : { responseShape: input.responseShape }),
    ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
    ...(input.providerCode === undefined
      ? {}
      : { details: boundedRedactedDiagnostic({ providerCode: input.providerCode }) })
  };
}

async function persistedTransientRecord(
  owner: CapabilityProbeOwner,
  profile: RuntimeProviderProfile,
  result: CapabilityProbeResult,
  endpointFingerprint: string
): Promise<ProviderCapabilityRecord> {
  await owner.persistCapabilityProbe(result);
  const refreshed = await owner.getRuntimeProviderProfile(profile.id);
  return matchingRecord(
    refreshed,
    {
      schemaVersion: 1,
      providerId: result.providerId,
      model: result.model,
      capability: result.record.capability,
      transport: result.record.scope.transport,
      requestShape: result.record.scope.requestShape,
      confirmBillableProbe: true
    },
    endpointFingerprint
  ) ?? result.record;
}

export async function probeProviderCapability(
  owner: CapabilityProbeOwner,
  input: CapabilityProbeInput,
  options: ProbeProviderCapabilityOptions = {}
): Promise<CapabilityProbeResult> {
  const parsedResult = capabilityProbeInputSchema.safeParse(input);
  if (!parsedResult.success) {
    throw new ProviderIntegrationError(
      createProviderServiceError({
        code: "invalid_request",
        stage: "validate",
        safeMessage: "A capability probe requires literal confirmation for one exact request shape."
      })
    );
  }
  const parsed = parsedResult.data;
  const decision = evaluateCapabilityProbe({
    kind: "live-provider",
    mayGenerateOutput: true,
    mayCharge: true,
    confirmedByUser: parsed.confirmBillableProbe
  });
  if (!decision.allowed) {
    throw new ProviderIntegrationError(
      createProviderServiceError({
        code: "invalid_request",
        stage: "validate",
        safeMessage: "The billable capability probe was not explicitly confirmed."
      })
    );
  }
  validateProbeShape(parsed);
  let profile: RuntimeProviderProfile;
  try {
    profile = await owner.getRuntimeProviderProfile(parsed.providerId);
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
  if (
    profile.models.length > 0 &&
    !profile.models.includes(parsed.model) &&
    profile.defaultModel !== parsed.model
  ) {
    throw new ProviderIntegrationError(
      createProviderServiceError({
        code: "invalid_input",
        stage: "configure",
        safeMessage: "The probe model is not available to the selected provider profile."
      })
    );
  }
  const descriptor = requestDescriptor(profile, parsed);
  const endpointFingerprint = fingerprintProviderEndpoint(descriptor.endpoint);
  const scope = {
    providerId: parsed.providerId,
    model: parsed.model,
    endpointFingerprint,
    transport: parsed.transport,
    requestShape: parsed.requestShape
  } as const;
  const current = matchingRecord(profile, parsed, endpointFingerprint) ??
    createUnknownCapabilityRecord(parsed.capability, scope);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("capability-probe-timeout"),
    safeTimeout(options.timeoutMs)
  );
  let response: Response | undefined;
  let outcome: CapabilityProbeOutcome | undefined;
  try {
    try {
      response = await (options.fetch ?? globalThis.fetch)(descriptor.endpoint, {
        ...descriptor.request,
        signal: controller.signal
      });
    } catch (error) {
      outcome = {
        outcome: "transient",
        error: createProviderServiceError({
          code: controller.signal.aborted ? "timeout" : "invalid_response",
          stage: "submit",
          safeMessage: controller.signal.aborted
            ? "The confirmed capability probe timed out."
            : "The confirmed capability probe could not reach the provider.",
          mayHaveBilled: true,
          details: error
        })
      };
    }
    if (response) {
      const shape = responseShape(response);
      outcome = await (options.interpretResponse ?? defaultInterpretResponse)(response, {
        input: parsed,
        responseShape: shape
      });
    }
  } finally {
    clearTimeout(timeout);
  }
  if (outcome === undefined) {
    throw new ProviderIntegrationError(
      createProviderServiceError({
        code: "internal_contract",
        stage: "complete",
        safeMessage: "The capability probe did not produce a bounded outcome.",
        mayHaveBilled: response !== undefined
      })
    );
  }
  const finalOutcome = outcome;
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const shape = response === undefined ? undefined : responseShape(response);
  const status = response?.status;
  if (finalOutcome.outcome === "transient") {
    const observation = evidence({
      source: "transient-failure",
      observedAt,
      summary: "A transient provider failure preserved the prior scoped capability state.",
      requestShape: parsed.requestShape,
      ...(shape === undefined ? {} : { responseShape: shape }),
      ...(status === undefined ? {} : { httpStatus: status }),
      ...(finalOutcome.providerCode === undefined
        ? {}
        : { providerCode: finalOutcome.providerCode })
    });
    const transient = capabilityProbeResultSchema.parse({
      schemaVersion: 1,
      providerId: parsed.providerId,
      model: parsed.model,
      status: "failed",
      record: createUnknownCapabilityRecord(parsed.capability, scope, [observation]),
      mayHaveBilled: true,
      error: finalOutcome.error
    });
    let record: ProviderCapabilityRecord;
    try {
      record = await persistedTransientRecord(owner, profile, transient, endpointFingerprint);
    } catch (error) {
      throw new ProviderIntegrationError(
        toProviderServiceError(error, {
          code: "file_write_failed",
          stage: "persist",
          safeMessage: "The capability-probe evidence could not be saved.",
          mayHaveBilled: true
        }),
        { cause: error }
      );
    }
    return capabilityProbeResultSchema.parse({ ...transient, record });
  }
  const observation = finalOutcome.outcome === "supported"
    ? {
        outcome: "supported" as const,
        evidence: evidence({
          source: "successful-request",
          observedAt,
          summary: "The confirmed provider request conclusively accepted this exact capability shape.",
          requestShape: parsed.requestShape,
          ...(shape === undefined ? {} : { responseShape: shape }),
          ...(status === undefined ? {} : { httpStatus: status })
        })
      }
    : finalOutcome.outcome === "unsupported"
      ? {
          outcome: "unsupported" as const,
          evidence: evidence({
            source: "protocol-rejection",
            observedAt,
            summary: "The provider returned a stable protocol-level rejection for this exact capability shape.",
            requestShape: parsed.requestShape,
            ...(shape === undefined ? {} : { responseShape: shape }),
            ...(status === undefined ? {} : { httpStatus: status }),
            ...(finalOutcome.providerCode === undefined
              ? {}
              : { providerCode: finalOutcome.providerCode })
          })
        }
      : {
          outcome: "degraded" as const,
          degradedReason: redactProviderText(finalOutcome.degradedReason),
          evidence: evidence({
            source: "degraded-fallback",
            observedAt,
            summary: "The confirmed provider path completed only with weaker semantics.",
            requestShape: parsed.requestShape,
            ...(shape === undefined ? {} : { responseShape: shape }),
            ...(status === undefined ? {} : { httpStatus: status })
          })
        };
  const record = transitionCapability(current, observation);
  const result = capabilityProbeResultSchema.parse({
    schemaVersion: 1,
    providerId: parsed.providerId,
    model: parsed.model,
    status: "completed",
    record,
    mayHaveBilled: true
  });
  try {
    await owner.persistCapabilityProbe(result);
  } catch (error) {
    throw new ProviderIntegrationError(
      toProviderServiceError(error, {
        code: "file_write_failed",
        stage: "persist",
        safeMessage: "The capability-probe evidence could not be saved.",
        mayHaveBilled: true
      }),
      { cause: error }
    );
  }
  return result;
}
