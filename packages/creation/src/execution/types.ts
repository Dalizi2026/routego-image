import type {
  ImageOperationEvent,
  ImageOperationRequest,
  ImageOperationResult,
  RoutegoGenerateInput
} from "@routego-image/contracts";

import type { ProviderRuntimeContext } from "../provider";

export type ProviderContextSource =
  | ProviderRuntimeContext
  | ((request: ImageOperationRequest) => ProviderRuntimeContext | Promise<ProviderRuntimeContext>);

/**
 * Retained as an inert dependency shape for callers compiled before retry removal.
 * The executor never waits or replays a provider request.
 */
export type ExecutionSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export interface ResolvedExecutionOptions {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: ImageOperationEvent) => void | Promise<void>;
}

export interface ImageExecutionDependencies {
  readonly providerContext: ProviderContextSource;
  readonly createRequestId?: () => string;
  readonly sleep?: ExecutionSleep;
  readonly onEvent?: (event: ImageOperationEvent) => void | Promise<void>;
  readonly explicitSameOriginDownloadAuthorization?: boolean;
  readonly maximumImageBytes?: number;
}

export interface ResolvedImageExecutor {
  execute(
    request: ImageOperationRequest,
    options?: ResolvedExecutionOptions
  ): Promise<ImageOperationResult>;
}

export interface CreationImageService {
  generate(input: RoutegoGenerateInput): Promise<ImageOperationResult>;
}

export type VariantExecutionMode = "native" | "single" | "fan-out";
