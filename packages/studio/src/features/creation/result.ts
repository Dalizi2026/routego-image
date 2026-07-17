import type { StudioImageOperationResult } from "@routego-image/contracts";

export interface CreationResultPresentation {
  readonly tone: "success" | "partial" | "failure" | "degraded";
  readonly title: string;
  readonly receivedAnyOutput: boolean;
  readonly mayHaveBilled: boolean;
  readonly manualRetryWarning?: string;
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
      ...(riskWarning ? { manualRetryWarning: riskWarning } : {})
    };
  }
  if (result.status === "partial") {
    return {
      tone: "partial",
      title: "部分图像已保留",
      receivedAnyOutput: result.execution.receivedAnyOutput,
      mayHaveBilled: result.execution.mayHaveBilled,
      ...(riskWarning ? { manualRetryWarning: riskWarning } : {})
    };
  }
  if (result.execution.degradedContinuation) {
    return {
      tone: "degraded",
      title: "已通过降级路径完成",
      receivedAnyOutput: true,
      mayHaveBilled: result.execution.mayHaveBilled,
      ...(riskWarning ? { manualRetryWarning: riskWarning } : {})
    };
  }
  return {
    tone: "success",
    title: "图像已生成",
    receivedAnyOutput: result.execution.receivedAnyOutput,
    mayHaveBilled: result.execution.mayHaveBilled
  };
}
