import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

// @ts-expect-error Task-owned Node ESM scripts intentionally ship without declaration artifacts.
import { ACCEPTANCE_MATRIX, AcceptanceGateError, assertEvidenceSafe, createSyntheticApproval, createSyntheticDryRunExecutor, fingerprintEndpoint, redactEvidence, runAcceptanceHarness, validateAcceptanceEvidence, validateApproval, validateCaseEvidence } from "../../../scripts/run-real-relay-acceptance.mjs";

const execFileAsync = promisify(execFile);
const NOW = new Date("2030-01-01T00:00:00.000Z");
const SCRIPT = path.resolve(import.meta.dirname, "../../../scripts/run-real-relay-acceptance.mjs");

function approval() {
  return createSyntheticApproval({ now: NOW });
}

function expectGate(code: string, callback: () => unknown): void {
  try {
    callback();
    throw new Error("Expected acceptance gate rejection.");
  } catch (error) {
    expect(error).toBeInstanceOf(AcceptanceGateError);
    expect(error).toMatchObject({ code });
  }
}

function transparencyFailure() {
  return {
    caseId: "transparency",
    requestCount: 1,
    costUsd: 0.01,
    mayHaveBilled: true,
    outcome: "failed",
    capabilityState: "degraded",
    transparencyMode: "chromakey-failed",
    transparentSuccess: false,
    providerOriginalAvailable: true,
    durableOriginalArtifactCount: 1,
    artifactGraph: {
      renditionCount: 33,
      outputSlots: [{
        artifactId: "synthetic-transparency-output",
        outputIdentityCount: 1,
        relationshipRoles: ["reference"]
      }]
    },
    sharedLibrary: {
      sameAsset: true,
      assetId: "synthetic-transparency-asset",
      exactSourceRelationships: true
    }
  };
}

describe("task 7.1 approval-gated real-relay acceptance harness", () => {
  it("runs the exact ordered matrix offline without claiming real acceptance", async () => {
    const executeCase = vi.fn(createSyntheticDryRunExecutor());
    const result = await runAcceptanceHarness({
      approval: approval(),
      executeCase,
      now: NOW,
      mode: "offline-dry-run"
    });

    expect(executeCase).toHaveBeenCalledTimes(6);
    expect(executeCase.mock.calls.map((call: Array<{ caseId: string }>) => call[0]?.caseId)).toEqual(
      ACCEPTANCE_MATRIX.map((item: { id: string }) => item.id)
    );
    expect(result).toMatchObject({
      status: "complete",
      realRelayExecuted: false,
      releaseReady: false,
      totals: { requestCount: 8, costUsd: 0.08, mayHaveBilled: true }
    });
    expect(result.cases[3]).toMatchObject({ caseId: "mask-slot-zero", maskTargetSlot: 0 });
    expect(result.cases[4]).toMatchObject({
      caseId: "partial-batch",
      outcome: "partial",
      itemOutcomes: ["success", "failed", "success"]
    });
    expect(() => validateAcceptanceEvidence(result)).not.toThrow();
  });

  it("treats the required partial batch as accepted only after a real approved run", async () => {
    const result = await runAcceptanceHarness({
      approval: approval(),
      executeCase: createSyntheticDryRunExecutor(),
      now: NOW,
      mode: "real-relay"
    });
    expect(result).toMatchObject({
      status: "complete",
      realRelayExecuted: true,
      releaseReady: true
    });
    expect(result.cases[4]).toMatchObject({ caseId: "partial-batch", outcome: "partial" });
  });

  it("refuses missing acknowledgement, expired approval and a narrow matrix before execution", async () => {
    const missing = approval();
    missing.acknowledgements.credentialUse = false;
    expectGate("approval_missing", () => validateApproval(missing, { now: NOW }));

    const expired = approval();
    expired.expiresAt = "2029-12-31T23:59:59.999Z";
    expectGate("approval_expired", () => validateApproval(expired, { now: NOW }));

    const narrow = approval();
    narrow.cases = narrow.cases.slice(0, -1);
    const executeCase = vi.fn(createSyntheticDryRunExecutor());
    await expect(runAcceptanceHarness({
      approval: narrow,
      executeCase,
      now: NOW,
      mode: "offline-dry-run"
    })).rejects.toMatchObject({ code: "approval_narrow" });
    expect(executeCase).not.toHaveBeenCalled();
  });

  it("refuses an inconsistent aggregate budget before any request", async () => {
    const budget = approval();
    budget.maxRequests -= 1;
    const executeCase = vi.fn(createSyntheticDryRunExecutor());
    await expect(runAcceptanceHarness({
      approval: budget,
      executeCase,
      now: NOW,
      mode: "offline-dry-run"
    })).rejects.toMatchObject({ code: "budget_narrow" });
    expect(executeCase).not.toHaveBeenCalled();
  });

  it("stops without replay when a case exceeds its approved request budget", async () => {
    const base = createSyntheticDryRunExecutor();
    const executeCase = vi.fn(async (input: { caseId: string }) => {
      const evidence = await base(input);
      return input.caseId === "direct-edit" ? { ...evidence, requestCount: 2 } : evidence;
    });
    const result = await runAcceptanceHarness({
      approval: approval(),
      executeCase,
      now: NOW,
      mode: "offline-dry-run"
    });

    expect(result).toMatchObject({ status: "stopped", stopReason: "case-budget-exceeded" });
    expect(executeCase).toHaveBeenCalledTimes(3);
    expect(result.cases).toHaveLength(3);
  });

  it("preserves completed facts when approval is withdrawn and starts no later case", async () => {
    let completed = 0;
    const base = createSyntheticDryRunExecutor();
    const executeCase = vi.fn(async (input: { caseId: string }) => {
      const result = await base(input);
      completed += 1;
      return result;
    });
    const result = await runAcceptanceHarness({
      approval: approval(),
      executeCase,
      now: NOW,
      mode: "offline-dry-run",
      isApprovalWithdrawn: () => completed === 1
    });

    expect(result).toMatchObject({ status: "stopped", stopReason: "approval-withdrawn" });
    expect(result.cases).toHaveLength(1);
    expect(executeCase).toHaveBeenCalledTimes(1);
  });

  it("honors cancellation before executing a request", async () => {
    const controller = new AbortController();
    controller.abort();
    const executeCase = vi.fn(createSyntheticDryRunExecutor());
    const result = await runAcceptanceHarness({
      approval: approval(),
      executeCase,
      now: NOW,
      mode: "offline-dry-run",
      signal: controller.signal
    });

    expect(result).toMatchObject({ status: "stopped", stopReason: "cancelled" });
    expect(result.cases).toEqual([]);
    expect(executeCase).not.toHaveBeenCalled();
  });

  it("redacts unsafe fields and rejects recoverable secrets, URLs, paths and image payloads", () => {
    const unsafe = {
      authorization: `Bearer ${["synthetic", "must", "not", "persist"].join("-")}`,
      rawProviderBody: { output: "provider-data" },
      endpoint: "https://provider.invalid/v1/images",
      localPath: "/tmp/synthetic-output.png",
      imageBytes: "data:image/png;base64,AAAA",
      safeFact: "supported"
    };
    expect(redactEvidence(unsafe)).toEqual({
      authorization: "[REDACTED]",
      rawProviderBody: "[REDACTED]",
      endpoint: "[REDACTED_URL]",
      localPath: "[REDACTED]",
      imageBytes: "[REDACTED]",
      safeFact: "supported"
    });
    expectGate("evidence_unsafe", () => assertEvidenceSafe(unsafe));
  });

  it("stores only an HTTPS endpoint fingerprint and rejects endpoint credentials or query data", () => {
    const first = fingerprintEndpoint("https://provider.invalid/v1/images");
    const second = fingerprintEndpoint("https://provider.invalid/v1/images");
    expect(first).toEqual(second);
    expect(first).toEqual({ scheme: "https", fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expectGate("endpoint_invalid", () => fingerprintEndpoint("http://provider.invalid/v1/images"));
    const credentialUrl = `https://${["user", "password"].join(":")}@provider.invalid/v1/images`;
    expectGate("endpoint_invalid", () => fingerprintEndpoint(credentialUrl));
    expectGate("endpoint_invalid", () => fingerprintEndpoint("https://provider.invalid/v1/images?key=synthetic"));
  });

  it("keeps transient failures out of unsupported capability evidence", () => {
    const base = {
      caseId: "text-generation",
      requestCount: 1,
      costUsd: 0,
      mayHaveBilled: false,
      outcome: "transient-failure",
      capabilityState: "unsupported",
      sharedLibrary: { sameAsset: true, assetId: "synthetic-asset" }
    };
    expectGate("evidence_invalid", () => validateCaseEvidence(base, "text-generation"));
    expect(() => validateCaseEvidence({ ...base, capabilityState: "unknown" }, "text-generation")).not.toThrow();
  });

  it("rejects incomplete, reordered or Library-free complete evidence", async () => {
    const valid = await runAcceptanceHarness({
      approval: approval(),
      executeCase: createSyntheticDryRunExecutor(),
      now: NOW,
      mode: "offline-dry-run"
    });
    const incomplete = structuredClone(valid);
    incomplete.cases.pop();
    expectGate("evidence_invalid", () => validateAcceptanceEvidence(incomplete));

    const reordered = structuredClone(valid);
    [reordered.cases[0], reordered.cases[1]] = [reordered.cases[1]!, reordered.cases[0]!];
    expectGate("evidence_invalid", () => validateAcceptanceEvidence(reordered));

    const missingLibrary = structuredClone(valid);
    delete missingLibrary.cases[0]!.sharedLibrary;
    expectGate("evidence_invalid", () => validateAcceptanceEvidence(missingLibrary));
  });

  it("accepts chromakey failure only with one same-identity provider original and no extra role", () => {
    expect(() => validateCaseEvidence(transparencyFailure(), "transparency")).not.toThrow();
    const duplicate = transparencyFailure();
    duplicate.durableOriginalArtifactCount = 2;
    expectGate("evidence_invalid", () => validateCaseEvidence(duplicate, "transparency"));

    const extraRole = transparencyFailure();
    extraRole.artifactGraph.outputSlots[0]!.relationshipRoles.push("transparent");
    expectGate("evidence_invalid", () => validateCaseEvidence(extraRole, "transparency"));

    const overBound = transparencyFailure();
    overBound.artifactGraph.renditionCount = 34;
    expectGate("evidence_invalid", () => validateCaseEvidence(overBound, "transparency"));
  });

  it("keeps the command line locked to the synthetic offline dry run", async () => {
    const dryRun = await execFileAsync(process.execPath, [SCRIPT, "--dry-run"], {
      env: { ...process.env, HOME: "/tmp/synthetic-home", CODEX_HOME: "/tmp/synthetic-codex-home" }
    });
    expect(JSON.parse(dryRun.stdout)).toMatchObject({
      status: "complete",
      realRelayExecuted: false,
      releaseReady: false
    });

    await expect(execFileAsync(process.execPath, [SCRIPT, "--execute"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Task 7.1 permits only --dry-run")
    });
  });
});
