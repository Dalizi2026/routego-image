import {
  routegoServiceErrorSchema,
  type ImageArtifact,
  type RoutegoServiceError
} from "@routego-image/contracts";
import { redactDiagnostic, redactFreeText } from "@routego-image/foundation";

export type ProviderFailureStage = "submit" | "stream" | "parse" | "download";

export interface ProviderErrorContext {
  readonly stage: ProviderFailureStage;
  readonly receivedAnyOutput?: boolean;
  readonly mayHaveBilled?: boolean;
  readonly partialArtifacts?: readonly ImageArtifact[] | undefined;
  readonly retryAfterMs?: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, maximum = 500): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = redactFreeText(value).trim();
  return sanitized.length === 0 ? undefined : sanitized.slice(0, maximum);
}

export interface ProviderErrorShape {
  readonly providerCode?: string;
  readonly providerType?: string;
  readonly safeProviderMessage?: string;
}

export function extractProviderErrorShape(body: unknown): ProviderErrorShape {
  const container = isRecord(body) && isRecord(body["error"])
    ? body["error"]
    : isRecord(body)
      ? body
      : {};
  const providerCode = boundedText(container["code"], 200);
  const providerType = boundedText(container["type"], 200);
  const safeProviderMessage = boundedText(container["message"]);
  return {
    ...(providerCode === undefined ? {} : { providerCode }),
    ...(providerType === undefined ? {} : { providerType }),
    ...(safeProviderMessage === undefined ? {} : { safeProviderMessage })
  };
}

function partialArtifacts(context: ProviderErrorContext): ImageArtifact[] {
  return [...(context.partialArtifacts ?? [])].slice(0, 4);
}

function errorFlags(context: ProviderErrorContext): {
  readonly receivedAnyOutput: boolean;
  readonly mayHaveBilled: boolean;
} {
  const receivedAnyOutput = context.receivedAnyOutput === true || partialArtifacts(context).length > 0;
  return {
    receivedAnyOutput,
    mayHaveBilled: receivedAnyOutput || context.mayHaveBilled === true
  };
}

export function createProviderError(
  input: Omit<RoutegoServiceError, "partialArtifacts" | "receivedAnyOutput" | "mayHaveBilled">,
  context: ProviderErrorContext
): RoutegoServiceError {
  const flags = errorFlags(context);
  return routegoServiceErrorSchema.parse({
    ...input,
    partialArtifacts: partialArtifacts(context),
    ...flags,
    ...(input.details === undefined ? {} : { details: redactDiagnostic(input.details) })
  });
}

function moderationFailure(shape: ProviderErrorShape): boolean {
  return /moderation|content[_ -]?policy|safety|blocked/iu.test(
    `${shape.providerCode ?? ""} ${shape.providerType ?? ""} ${shape.safeProviderMessage ?? ""}`
  );
}

export function mapProviderHttpError(
  status: number,
  body: unknown,
  context: ProviderErrorContext
): RoutegoServiceError {
  const shape = extractProviderErrorShape(body);
  const flags = errorFlags(context);
  const details = {
    ...(shape.providerType === undefined ? {} : { providerType: shape.providerType }),
    ...(shape.safeProviderMessage === undefined
      ? {}
      : { providerMessage: shape.safeProviderMessage }),
    ...(context.retryAfterMs === undefined ? {} : { retryAfterMs: context.retryAfterMs })
  };
  const base = {
    stage: context.stage,
    httpStatus: status,
    ...(shape.providerCode === undefined ? {} : { providerCode: shape.providerCode }),
    details
  } as const;
  if (status === 401 || status === 403) {
    return createProviderError(
      {
        ...base,
        code: "auth_failed",
        category: "authentication",
        safeMessage: "The provider rejected the configured credentials or authorization.",
        retryDisposition: "never"
      },
      context
    );
  }
  if (moderationFailure(shape)) {
    return createProviderError(
      {
        ...base,
        code: "moderation_blocked",
        category: "moderation",
        safeMessage: "The provider blocked the request under its safety or moderation policy.",
        retryDisposition: "never"
      },
      context
    );
  }
  if (status === 429) {
    return createProviderError(
      {
        ...base,
        code: "rate_limited",
        category: "rate_limit",
        safeMessage: "The provider rate limit was reached before any output was received.",
        retryDisposition: "user-confirmation"
      },
      context
    );
  }
  if (status >= 500 && status <= 599) {
    return createProviderError(
      {
        ...base,
        code: "provider_5xx",
        category: "provider",
        safeMessage: "The provider returned a server error before any output was received.",
        retryDisposition: "user-confirmation"
      },
      context
    );
  }
  return createProviderError(
    {
      ...base,
      code: "invalid_response",
      category: "provider",
      safeMessage: "The provider rejected the request or returned an unsupported error response.",
      retryDisposition: "never"
    },
    context
  );
}

export function invalidProviderResponseError(
  safeMessage: string,
  reason: string,
  context: ProviderErrorContext = { stage: "parse", mayHaveBilled: true },
  diagnosticDetails: Readonly<Record<string, unknown>> = {}
): RoutegoServiceError {
  return createProviderError(
    {
      code: "invalid_response",
      category: "protocol",
      stage: context.stage,
      safeMessage,
      retryDisposition: "never",
      details: { reason, ...diagnosticDetails }
    },
    { ...context, mayHaveBilled: context.mayHaveBilled ?? true }
  );
}

export function providerDownloadError(
  safeMessage: string,
  reason: string,
  context: ProviderErrorContext = { stage: "download", mayHaveBilled: true }
): RoutegoServiceError {
  return createProviderError(
    {
      code: reason === "timeout" ? "timeout" : reason === "cancelled" ? "cancelled" : "download_failed",
      category: reason === "timeout" ? "timeout" : reason === "cancelled" ? "cancelled" : "download",
      stage: "download",
      safeMessage,
      retryDisposition: "never",
      details: { reason }
    },
    { ...context, mayHaveBilled: context.mayHaveBilled ?? true }
  );
}

export function providerStreamError(
  body: unknown,
  context: ProviderErrorContext
): RoutegoServiceError {
  return providerReportedFailure(body, { ...context, stage: "stream" });
}

export function providerReportedFailure(
  body: unknown,
  context: ProviderErrorContext
): RoutegoServiceError {
  const shape = extractProviderErrorShape(body);
  return createProviderError(
    {
      code: moderationFailure(shape) ? "moderation_blocked" : "invalid_response",
      category: moderationFailure(shape) ? "moderation" : "protocol",
      stage: context.stage,
      safeMessage: moderationFailure(shape)
        ? "The provider stopped the stream under its safety or moderation policy."
        : context.stage === "stream"
          ? "The provider stream failed before completion."
          : "The provider reported that image generation failed.",
      retryDisposition: "never",
      ...(shape.providerCode === undefined ? {} : { providerCode: shape.providerCode }),
      details: {
        ...(shape.providerType === undefined ? {} : { providerType: shape.providerType }),
        ...(shape.safeProviderMessage === undefined
          ? {}
          : { providerMessage: shape.safeProviderMessage })
      }
    },
    { ...context, mayHaveBilled: true }
  );
}
