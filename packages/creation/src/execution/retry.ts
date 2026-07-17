import type { RoutegoServiceError } from "@routego-image/contracts";

import type { ProviderRetryPolicy } from "../provider";
import type { ExecutionSleep } from "./types";

export interface ProviderRetryDecision {
  readonly retry: boolean;
  readonly delayMs: number;
  readonly reason:
    | "safe-pre-generation"
    | "respect-retry-after"
    | "retry-after-too-long"
    | "attempt-limit"
    | "output-or-billing-risk"
    | "error-not-retryable";
}

function retryAfterMs(error: RoutegoServiceError): number | undefined {
  const value = error.details?.["retryAfterMs"];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function decideProviderRetry(
  error: RoutegoServiceError,
  attemptCount: number,
  policy: ProviderRetryPolicy,
  random: () => number = Math.random
): ProviderRetryDecision {
  if (attemptCount >= policy.maxAttempts) {
    return { retry: false, delayMs: 0, reason: "attempt-limit" };
  }
  if (error.receivedAnyOutput || error.mayHaveBilled) {
    return { retry: false, delayMs: 0, reason: "output-or-billing-risk" };
  }
  if (
    (error.code !== "rate_limited" && error.code !== "provider_5xx") ||
    error.stage !== "submit" ||
    (error.retryDisposition !== "safe-pre-generation" &&
      error.retryDisposition !== "respect-retry-after")
  ) {
    return { retry: false, delayMs: 0, reason: "error-not-retryable" };
  }
  const explicit = error.retryDisposition === "respect-retry-after" ? retryAfterMs(error) : undefined;
  if (explicit !== undefined) {
    if (explicit > policy.maxDelayMs) {
      return { retry: false, delayMs: 0, reason: "retry-after-too-long" };
    }
    return {
      retry: true,
      delayMs: explicit,
      reason: "respect-retry-after"
    };
  }
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.max(0, attemptCount - 1)
  );
  const boundedRandom = Math.min(1, Math.max(0, random()));
  return {
    retry: true,
    delayMs: Math.round(exponential * (0.8 + boundedRandom * 0.2)),
    reason: "safe-pre-generation"
  };
}

export const defaultExecutionSleep: ExecutionSleep = (milliseconds, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
