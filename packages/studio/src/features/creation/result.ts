import type {
  BrowserResourceDescriptor,
  StudioImageOperationResult
} from "@routego-image/contracts";

import type { SubmissionState } from "./types";

export interface CreationResultPresentation {
  readonly tone: "success" | "partial" | "failure" | "degraded";
  readonly title: string;
  readonly receivedAnyOutput: boolean;
  readonly mayHaveBilled: boolean;
  readonly manualRetryWarning?: string;
  readonly retryRequiresConfirmation: boolean;
}

export interface CreationArtifactAvailability {
  readonly status: "protected" | "available" | "expired";
  readonly expiresAt: string;
}

export interface CreationArtifactCleanupPolicy {
  readonly revokeBrowserObjectUrlOnUnmount: true;
  readonly revokeServerDescriptorOnClientCleanup: false;
  readonly serverDescriptorExpiresAt: string;
}

export function describeCreationArtifactAvailability(
  descriptor: BrowserResourceDescriptor,
  now?: number
): CreationArtifactAvailability {
  if (now === undefined) {
    return { status: "protected", expiresAt: descriptor.expiresAt };
  }
  return {
    status: now < Date.parse(descriptor.expiresAt) ? "available" : "expired",
    expiresAt: descriptor.expiresAt
  };
}

export function describeCreationArtifactCleanup(
  descriptor: BrowserResourceDescriptor
): CreationArtifactCleanupPolicy {
  return {
    revokeBrowserObjectUrlOnUnmount: true,
    revokeServerDescriptorOnClientCleanup: false,
    serverDescriptorExpiresAt: descriptor.expiresAt
  };
}

export function describeCreationStreamFailure(
  state: Extract<SubmissionState, { readonly status: "stream-failure" }>
): CreationResultPresentation {
  const riskWarning = state.receivedAnyOutput || state.mayHaveBilled
    ? "已收到输出或可能计费；只能由你确认后创建新的明确请求。"
    : undefined;
  return {
    tone: state.partialArtifacts.length > 0 ? "partial" : "failure",
    title: state.partialArtifacts.length > 0 ? "部分图像已保留" : "生成未完成",
    receivedAnyOutput: state.receivedAnyOutput,
    mayHaveBilled: state.mayHaveBilled,
    retryRequiresConfirmation: riskWarning !== undefined,
    ...(riskWarning ? { manualRetryWarning: riskWarning } : {})
  };
}

export function describeCreationResult(
  result: StudioImageOperationResult
): CreationResultPresentation {
  const riskWarning = result.execution.receivedAnyOutput || result.execution.mayHaveBilled
    ? "已收到输出或可能计费；重试会创建一次新的明确请求。"
    : undefined;
  if (result.status === "failed") {
    return {
      tone: "failure",
      title: "生成未完成",
      receivedAnyOutput: result.execution.receivedAnyOutput,
      mayHaveBilled: result.execution.mayHaveBilled,
      retryRequiresConfirmation: riskWarning !== undefined,
      ...(riskWarning ? { manualRetryWarning: riskWarning } : {})
    };
  }
  if (result.status === "partial") {
    return {
      tone: "partial",
      title: "部分图像已保留",
      receivedAnyOutput: result.execution.receivedAnyOutput,
      mayHaveBilled: result.execution.mayHaveBilled,
      retryRequiresConfirmation: riskWarning !== undefined,
      ...(riskWarning ? { manualRetryWarning: riskWarning } : {})
    };
  }
  if (result.execution.degradedContinuation) {
    return {
      tone: "degraded",
      title: "已通过降级路径完成",
      receivedAnyOutput: true,
      mayHaveBilled: result.execution.mayHaveBilled,
      retryRequiresConfirmation: riskWarning !== undefined,
      ...(riskWarning ? { manualRetryWarning: riskWarning } : {})
    };
  }
  return {
    tone: "success",
    title: "图像已生成",
    receivedAnyOutput: result.execution.receivedAnyOutput,
    mayHaveBilled: result.execution.mayHaveBilled,
    retryRequiresConfirmation: riskWarning !== undefined,
    ...(riskWarning ? { manualRetryWarning: riskWarning } : {})
  };
}
