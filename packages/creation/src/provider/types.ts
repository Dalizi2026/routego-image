import type {
  ImageOperationRequest,
  ProviderCapabilityRecord,
  ProviderEndpointSet,
  RoutegoServiceError
} from "@routego-image/contracts";
import type {
  ProviderRoutingContext,
  SelectedProviderRoute,
  UnavailableProviderRoute
} from "@routego-image/foundation";

export const MAX_PROVIDER_INPUT_BYTES = 50 * 1024 * 1024;
export const MAX_PROVIDER_INPUTS = 16;

export type SupportedImageMimeType = "image/png" | "image/jpeg" | "image/webp";

export interface ImageFileMetadata {
  readonly mimeType: SupportedImageMimeType;
  readonly width: number;
  readonly height: number;
  readonly hasAlpha: boolean;
}

export type PreparedImageKind = "target" | "reference";

export interface PreparedImageInput extends ImageFileMetadata {
  readonly slot: number;
  readonly kind: PreparedImageKind;
  readonly role: ImageOperationRequest["references"][number]["role"] | "target";
  readonly sourceIndex: number;
  readonly path: string;
  readonly fileName: string;
  readonly byteLength: number;
  readonly bytes: Uint8Array;
  readonly id?: string;
  readonly label?: string;
}

export interface PreparedImageInputs {
  readonly images: readonly PreparedImageInput[];
  readonly totalBytes: number;
}

export interface PrepareImageInputOptions {
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
}

export type ProviderPreparationFailureReason =
  | "invalid-file"
  | "unsupported-image"
  | "image-too-large"
  | "too-many-images"
  | "request-shape-mismatch";

export class ProviderPreparationError extends Error {
  readonly reason: ProviderPreparationFailureReason;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    reason: ProviderPreparationFailureReason,
    safeMessage: string,
    details: Readonly<Record<string, unknown>> = {}
  ) {
    super(safeMessage);
    this.name = "ProviderPreparationError";
    this.reason = reason;
    this.details = details;
  }
}

export interface ProviderDeadlinePolicy {
  readonly responseHeaderMs: number;
  readonly bodyMs: number;
  readonly downloadMs: number;
  readonly totalMs: number;
}

export interface ProviderRetryPolicy {
  readonly maxAttempts: 1 | 2 | 3;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export interface ProviderRuntimeContext extends ProviderRoutingContext {
  readonly apiKey: string;
  readonly fetch: typeof fetch;
  readonly deadlines: ProviderDeadlinePolicy;
  readonly retry: ProviderRetryPolicy;
  readonly now?: () => number;
  readonly random?: () => number;
}

export interface ProviderRequestPreparationContext extends ProviderRoutingContext {
  readonly providerId: string;
  readonly model: string;
  readonly endpoints: ProviderEndpointSet;
  readonly capabilities: readonly ProviderCapabilityRecord[];
}

export interface EffectiveProviderControls {
  readonly n: number;
  readonly size: string;
  readonly quality: ImageOperationRequest["quality"];
  readonly outputFormat: ImageOperationRequest["format"];
  readonly outputCompression?: number;
  readonly partialImages?: number;
  readonly nativeTransparency: boolean;
  readonly moderation: ImageOperationRequest["moderation"];
  readonly stream: boolean;
}

export interface EffectiveProviderPlan {
  readonly effectiveParams: ImageOperationRequest;
  readonly controls: EffectiveProviderControls;
  readonly degraded: boolean;
}

export type ProviderJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ProviderJsonValue[]
  | { readonly [key: string]: ProviderJsonValue };

export type ProviderJsonObject = { readonly [key: string]: ProviderJsonValue };

export interface ProviderJsonSubmission {
  readonly bodyType: "json";
  readonly method: "POST";
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ProviderJsonObject;
}

export interface ProviderMultipartSubmission {
  readonly bodyType: "multipart";
  readonly method: "POST";
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: FormData;
}

export type ProviderSubmission = ProviderJsonSubmission | ProviderMultipartSubmission;

export interface PreparedProviderRequest {
  readonly route: SelectedProviderRoute;
  readonly requestedParams: ImageOperationRequest;
  readonly effective: EffectiveProviderPlan;
  readonly inputs: PreparedImageInputs;
  readonly submission: ProviderSubmission;
}

export interface ProviderRequestPreparedResult {
  readonly prepared: true;
  readonly value: PreparedProviderRequest;
}

export interface ProviderRequestUnavailableResult {
  readonly prepared: false;
  readonly error: RoutegoServiceError;
  readonly route?: UnavailableProviderRoute | SelectedProviderRoute;
}

export type ProviderRequestPreparationResult =
  | ProviderRequestPreparedResult
  | ProviderRequestUnavailableResult;
