import { describe, expect, it } from "vitest";

import type { StudioImageOperationResult } from "@routego-image/contracts";

import { describeCreationResult } from "../src/features/creation";

function result(
  status: "succeeded" | "partial" | "failed",
  options: { receivedAnyOutput: boolean; mayHaveBilled: boolean; degraded?: boolean }
) {
  return {
    status,
    execution: {
      receivedAnyOutput: options.receivedAnyOutput,
      mayHaveBilled: options.mayHaveBilled,
      degradedContinuation: options.degraded ?? false
    }
  } as StudioImageOperationResult;
}

describe("honest creation result presentation", () => {
  it("distinguishes success, degraded, partial, and failure", () => {
    expect(
      describeCreationResult(result("succeeded", { receivedAnyOutput: true, mayHaveBilled: true }))
        .tone
    ).toBe("success");
    expect(
      describeCreationResult(
        result("succeeded", { receivedAnyOutput: true, mayHaveBilled: true, degraded: true })
      ).tone
    ).toBe("degraded");
    expect(
      describeCreationResult(result("partial", { receivedAnyOutput: true, mayHaveBilled: true }))
    ).toMatchObject({ tone: "partial", manualRetryWarning: expect.any(String) });
    expect(
      describeCreationResult(result("failed", { receivedAnyOutput: false, mayHaveBilled: false }))
        .tone
    ).toBe("failure");
  });
});
