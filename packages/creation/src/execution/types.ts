import type {
  ImageOperationEvent,
  ImageOperationRequest,
  ImageOperationResult,
  RoutegoEditInput,
  RoutegoGenerateInput
} from "@routego-image/contracts";

import type { ProviderRuntimeContext } from "../provider";

export type ProviderContextSource =
  | ProviderRuntimeContext
  | ((request: ImageOperationRequest) => ProviderRuntimeContext | Promise<ProviderRuntimeContext>);

export type ExecutionSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export interface ResolvedPreviousOutput {
  readonly id?: string;
  readonly path: string;
  readonly label?: string;
}

export interface ResolvedExecutionOptions {
  readonly signal?: AbortSignal;
  readonly previousOutput?: ResolvedPreviousOutput;
  readonly degradedContinuationRequest?: ImageOperationRequest;
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
  edit(input: RoutegoEditInput): Promise<ImageOperationResult>;
}

export type VariantExecutionMode = "native" | "single" | "fan-out";
