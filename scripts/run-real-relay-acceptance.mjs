import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const ACCEPTANCE_MATRIX = Object.freeze([
  Object.freeze({ id: "text-generation", maxRequests: 1 }),
  Object.freeze({ id: "two-references", maxRequests: 1 }),
  Object.freeze({ id: "direct-edit", maxRequests: 1 }),
  Object.freeze({ id: "mask-slot-zero", maxRequests: 1 }),
  Object.freeze({ id: "partial-batch", maxRequests: 3 }),
  Object.freeze({ id: "transparency", maxRequests: 1 })
]);

export const CAPABILITY_STATES = Object.freeze([
  "unknown",
  "supported",
  "unsupported",
  "degraded"
]);

const CASE_IDS = new Set(ACCEPTANCE_MATRIX.map((item) => item.id));
const OUTCOMES = new Set([
  "success",
  "partial",
  "unavailable",
  "transient-failure",
  "failed"
]);
const FORBIDDEN_KEYS = /(?:^|_)(?:api_?key|authorization|credential|secret|token|raw(?:_?provider)?_?body|image_?bytes|data_?url|full_?endpoint|local_?path|file_?path)(?:$|_)/iu;
const SECRET_TEXT = /(?:\bBearer\s+[A-Za-z0-9._~+/-]{8,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{12,})/u;
const IMAGE_PAYLOAD = /data:image\/[a-z0-9.+-]+;base64,/iu;
const URL_TEXT = /https?:\/\/[^\s]+/iu;
const LOCAL_PATH = /(?:^|[\s("'=])(?:\/(?:Users|home|tmp|var|private|mnt)\/[^\s,;)]+|[A-Za-z]:[\\/][^\s,;]+)/u;
const MAX_STRING = 1_000;
const MAX_DEPTH = 8;
const MAX_ITEMS = 128;

export class AcceptanceGateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AcceptanceGateError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new AcceptanceGateError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_STRING) {
    fail("approval_invalid", `${name} must be a non-empty bounded string.`);
  }
  return value;
}

function requireFiniteNonNegative(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("approval_invalid", `${name} must be a finite non-negative number.`);
  }
  return value;
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail("approval_invalid", `${name} must be a positive safe integer.`);
  }
  return value;
}

function isoMillis(value, name) {
  const millis = Date.parse(requireString(value, name));
  if (!Number.isFinite(millis)) fail("approval_invalid", `${name} must be an ISO timestamp.`);
  return millis;
}

function hashText(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function fingerprintEndpoint(endpoint) {
  const parsed = new URL(requireString(endpoint, "endpoint"));
  if (parsed.protocol !== "https:") {
    fail("endpoint_invalid", "Approved provider endpoints must use HTTPS.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail("endpoint_invalid", "Approved provider endpoints cannot contain credentials, query or fragment data.");
  }
  return Object.freeze({
    scheme: parsed.protocol.slice(0, -1),
    fingerprint: hashText(`${parsed.protocol}//${parsed.host}${parsed.pathname}`)
  });
}

function validateCaseApproval(value, expected) {
  if (!isRecord(value) || value.id !== expected.id) {
    fail("approval_narrow", `Approval must contain the ordered ${expected.id} case.`);
  }
  const maxRequests = requirePositiveInteger(value.maxRequests, `${expected.id}.maxRequests`);
  if (maxRequests < expected.maxRequests) {
    fail("approval_narrow", `${expected.id} does not authorize its required request count.`);
  }
  const maxCostUsd = requireFiniteNonNegative(value.maxCostUsd, `${expected.id}.maxCostUsd`);
  return Object.freeze({ id: expected.id, maxRequests, maxCostUsd });
}

export function validateApproval(value, options = {}) {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    fail("approval_missing", "A schemaVersion 1 real-relay approval is required.");
  }
  const now = options.now instanceof Date ? options.now.getTime() : options.now ?? Date.now();
  if (!Number.isFinite(now)) fail("approval_invalid", "The approval clock is invalid.");
  const issuedAt = isoMillis(value.issuedAt, "issuedAt");
  const expiresAt = isoMillis(value.expiresAt, "expiresAt");
  if (issuedAt > now || expiresAt <= issuedAt) {
    fail("approval_invalid", "Approval timestamps are inconsistent.");
  }
  if (expiresAt <= now) fail("approval_expired", "The real-relay approval has expired.");
  if (
    !isRecord(value.acknowledgements) ||
    value.acknowledgements.credentialUse !== true ||
    value.acknowledgements.syntheticInputs !== true ||
    value.acknowledgements.potentialCharges !== true
  ) {
    fail("approval_missing", "Credential use, synthetic inputs and potential charges require explicit acknowledgement.");
  }
  if (!isRecord(value.relayProfile)) fail("approval_missing", "An exact relay profile is required.");
  const relayProfile = Object.freeze({
    providerId: requireString(value.relayProfile.providerId, "relayProfile.providerId"),
    profileId: requireString(value.relayProfile.profileId, "relayProfile.profileId"),
    model: requireString(value.relayProfile.model, "relayProfile.model"),
    endpointFingerprint: requireString(
      value.relayProfile.endpointFingerprint,
      "relayProfile.endpointFingerprint"
    )
  });
  if (!/^[0-9a-f]{64}$/u.test(relayProfile.endpointFingerprint)) {
    fail("approval_invalid", "The relay endpoint fingerprint must be SHA-256.");
  }
  if (!Array.isArray(value.cases) || value.cases.length !== ACCEPTANCE_MATRIX.length) {
    fail("approval_narrow", "Approval must bind the complete ordered request matrix.");
  }
  const cases = ACCEPTANCE_MATRIX.map((item, index) =>
    validateCaseApproval(value.cases[index], item)
  );
  const maxRequests = requirePositiveInteger(value.maxRequests, "maxRequests");
  const maxCostUsd = requireFiniteNonNegative(value.maxCostUsd, "maxCostUsd");
  const reservedRequests = cases.reduce((sum, item) => sum + item.maxRequests, 0);
  const reservedCostUsd = cases.reduce((sum, item) => sum + item.maxCostUsd, 0);
  if (maxRequests < reservedRequests || maxCostUsd < reservedCostUsd) {
    fail("budget_narrow", "The total approval budget is narrower than its case budgets.");
  }
  const evidenceLocationFingerprint = requireString(
    value.evidenceLocationFingerprint,
    "evidenceLocationFingerprint"
  );
  if (!/^[0-9a-f]{64}$/u.test(evidenceLocationFingerprint)) {
    fail("approval_invalid", "The evidence location fingerprint must be SHA-256.");
  }
  return Object.freeze({
    schemaVersion: 1,
    approvalId: requireString(value.approvalId, "approvalId"),
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    relayProfile,
    evidenceLocationFingerprint,
    cases: Object.freeze(cases),
    maxRequests,
    maxCostUsd
  });
}

function redactString(value) {
  if (SECRET_TEXT.test(value)) return "[REDACTED_SECRET]";
  if (IMAGE_PAYLOAD.test(value)) return "[REDACTED_IMAGE_PAYLOAD]";
  if (URL_TEXT.test(value)) return "[REDACTED_URL]";
  if (LOCAL_PATH.test(value)) return "[REDACTED_PATH]";
  return value.length <= MAX_STRING ? value : `${value.slice(0, MAX_STRING - 14)}...[TRUNCATED]`;
}

export function redactEvidence(value, depth = 0) {
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "[INVALID_NUMBER]";
  if (Array.isArray(value)) {
    const output = value.slice(0, MAX_ITEMS).map((item) => redactEvidence(item, depth + 1));
    if (value.length > MAX_ITEMS) output.push("[TRUNCATED]");
    return output;
  }
  if (!isRecord(value)) return redactString(String(value));
  const output = {};
  for (const [key, child] of Object.entries(value).slice(0, MAX_ITEMS)) {
    output[key] = FORBIDDEN_KEYS.test(key) ? "[REDACTED]" : redactEvidence(child, depth + 1);
  }
  if (Object.keys(value).length > MAX_ITEMS) output.truncated = true;
  return output;
}

function inspectEvidence(value, path = "$", depth = 0) {
  if (depth > MAX_DEPTH) fail("evidence_unsafe", `${path} exceeds the evidence depth limit.`);
  if (typeof value === "string") {
    if (value.length > MAX_STRING) fail("evidence_unsafe", `${path} exceeds the evidence string limit.`);
    if (SECRET_TEXT.test(value) || IMAGE_PAYLOAD.test(value) || URL_TEXT.test(value) || LOCAL_PATH.test(value)) {
      fail("evidence_unsafe", `${path} contains sensitive or recoverable data.`);
    }
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("evidence_unsafe", `${path} contains a non-finite number.`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ITEMS) fail("evidence_unsafe", `${path} exceeds the evidence item limit.`);
    value.forEach((item, index) => inspectEvidence(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isRecord(value)) fail("evidence_unsafe", `${path} contains an unsupported value.`);
  const entries = Object.entries(value);
  if (entries.length > MAX_ITEMS) fail("evidence_unsafe", `${path} exceeds the evidence item limit.`);
  for (const [key, child] of entries) {
    if (FORBIDDEN_KEYS.test(key)) fail("evidence_unsafe", `${path}.${key} is forbidden in evidence.`);
    inspectEvidence(child, `${path}.${key}`, depth + 1);
  }
}

export function assertEvidenceSafe(value) {
  inspectEvidence(value);
  return value;
}

function validateArtifactGraph(caseId, graph) {
  if (!isRecord(graph)) fail("evidence_invalid", `${caseId} requires an artifact graph.`);
  const renditionCount = requirePositiveInteger(graph.renditionCount, `${caseId}.renditionCount`);
  if (renditionCount > 33) fail("evidence_invalid", `${caseId} exceeds the 33-rendition bound.`);
  if (!Array.isArray(graph.outputSlots) || graph.outputSlots.length === 0) {
    fail("evidence_invalid", `${caseId} requires output slots.`);
  }
  for (const slot of graph.outputSlots) {
    if (!isRecord(slot)) fail("evidence_invalid", `${caseId} has an invalid output slot.`);
    requireString(slot.artifactId, `${caseId}.artifactId`);
    if (slot.outputIdentityCount !== 1) {
      fail("evidence_invalid", `${caseId} must retain one output identity per slot.`);
    }
    if (!Array.isArray(slot.relationshipRoles)) {
      fail("evidence_invalid", `${caseId} requires relationship roles.`);
    }
    if (slot.relationshipRoles.some((role) => !["target", "reference", "supporting", "mask"].includes(role))) {
      fail("evidence_invalid", `${caseId} contains an extra relationship role.`);
    }
  }
}

function validateTransparencyEvidence(value) {
  const mode = value.transparencyMode;
  if (!["native", "chromakey", "chromakey-failed"].includes(mode)) {
    fail("evidence_invalid", "Transparency evidence requires an exact mode.");
  }
  validateArtifactGraph("transparency", value.artifactGraph);
  if (mode === "chromakey") {
    if (value.capabilityState !== "degraded" || value.transparentSuccess !== true) {
      fail("evidence_invalid", "Chromakey success must be truthful degraded transparent success.");
    }
  }
  if (mode === "chromakey-failed") {
    if (
      value.providerOriginalAvailable !== true ||
      value.transparentSuccess !== false ||
      value.durableOriginalArtifactCount !== 1
    ) {
      fail("evidence_invalid", "Chromakey failure must preserve one provider original under the same identity.");
    }
  }
}

export function validateCaseEvidence(value, expectedCaseId) {
  if (!CASE_IDS.has(expectedCaseId) || !isRecord(value) || value.caseId !== expectedCaseId) {
    fail("evidence_invalid", `Evidence does not match ${expectedCaseId}.`);
  }
  const requestCount = requirePositiveInteger(value.requestCount, `${expectedCaseId}.requestCount`);
  const costUsd = requireFiniteNonNegative(value.costUsd, `${expectedCaseId}.costUsd`);
  if (typeof value.mayHaveBilled !== "boolean") {
    fail("evidence_invalid", `${expectedCaseId}.mayHaveBilled must be boolean.`);
  }
  if (!OUTCOMES.has(value.outcome)) fail("evidence_invalid", `${expectedCaseId} has an invalid outcome.`);
  if (!CAPABILITY_STATES.includes(value.capabilityState)) {
    fail("evidence_invalid", `${expectedCaseId} has an invalid capability state.`);
  }
  if (value.outcome === "transient-failure" && value.capabilityState === "unsupported") {
    fail("evidence_invalid", "Transient failures cannot become unsupported capability evidence.");
  }
  if (expectedCaseId === "partial-batch") {
    if (
      value.outcome !== "partial" ||
      !Array.isArray(value.itemOutcomes) ||
      value.itemOutcomes.length < 2 ||
      !value.itemOutcomes.some((item) => item === "success") ||
      !value.itemOutcomes.some((item) => item === "failed")
    ) {
      fail("evidence_invalid", "The partial batch requires ordered success and failure outcomes.");
    }
  }
  if (expectedCaseId === "mask-slot-zero" && value.maskTargetSlot !== 0) {
    fail("evidence_invalid", "The acceptance mask must target slot zero.");
  }
  if (expectedCaseId === "transparency") validateTransparencyEvidence(value);
  if (!isRecord(value.sharedLibrary) || value.sharedLibrary.sameAsset !== true) {
    fail("evidence_invalid", `${expectedCaseId} must prove shared Codex and Studio Library identity.`);
  }
  requireString(value.sharedLibrary.assetId, `${expectedCaseId}.sharedLibrary.assetId`);
  const redacted = redactEvidence(value);
  assertEvidenceSafe(redacted);
  return Object.freeze(redacted);
}

function createBaseSyntheticEvidence(caseId) {
  return {
    caseId,
    requestCount: caseId === "partial-batch" ? 3 : 1,
    costUsd: caseId === "partial-batch" ? 0.03 : 0.01,
    mayHaveBilled: true,
    outcome: caseId === "partial-batch" ? "partial" : "success",
    capabilityState: caseId === "transparency" ? "degraded" : "supported",
    transport: "synthetic-tier-a",
    requestShape: `${caseId}-synthetic-v1`,
    sharedLibrary: {
      sameAsset: true,
      assetId: `synthetic-${caseId}-asset`,
      exactSourceRelationships: true,
      codexArtifactIds: [`synthetic-${caseId}-output`],
      studioArtifactIds: [`synthetic-${caseId}-output`]
    },
    ...(caseId === "mask-slot-zero" ? { maskTargetSlot: 0 } : {}),
    ...(caseId === "partial-batch" ? { itemOutcomes: ["success", "failed", "success"] } : {}),
    ...(caseId === "transparency"
      ? {
          transparencyMode: "chromakey",
          transparentSuccess: true,
          artifactGraph: {
            renditionCount: 33,
            outputSlots: [{
              artifactId: "synthetic-transparency-output",
              outputIdentityCount: 1,
              relationshipRoles: ["reference"]
            }]
          }
        }
      : {})
  };
}

export function createSyntheticApproval(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? "2030-01-01T00:00:00.000Z");
  const endpoint = fingerprintEndpoint("https://synthetic.invalid/v1/images");
  const cases = ACCEPTANCE_MATRIX.map((item) => ({
    id: item.id,
    maxRequests: item.maxRequests,
    maxCostUsd: item.id === "partial-batch" ? 0.03 : 0.01
  }));
  return {
    schemaVersion: 1,
    approvalId: "synthetic-offline-approval",
    issuedAt: new Date(now.getTime() - 60_000).toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
    relayProfile: {
      providerId: "synthetic-provider",
      profileId: "synthetic-profile",
      model: "synthetic-model",
      endpointFingerprint: endpoint.fingerprint
    },
    acknowledgements: {
      credentialUse: true,
      syntheticInputs: true,
      potentialCharges: true
    },
    evidenceLocationFingerprint: hashText("synthetic-task-owned-evidence"),
    cases,
    maxRequests: cases.reduce((sum, item) => sum + item.maxRequests, 0),
    maxCostUsd: cases.reduce((sum, item) => sum + item.maxCostUsd, 0)
  };
}

export function createSyntheticDryRunExecutor(overrides = {}) {
  return async ({ caseId }) => {
    const custom = overrides[caseId];
    return custom === undefined ? createBaseSyntheticEvidence(caseId) : structuredClone(custom);
  };
}

function stoppedRecord(base, reason, totals, cases) {
  return Object.freeze({
    ...base,
    status: "stopped",
    stopReason: reason,
    totals: Object.freeze({ ...totals }),
    cases: Object.freeze([...cases]),
    releaseReady: false
  });
}

export async function runAcceptanceHarness(options) {
  if (!isRecord(options) || typeof options.executeCase !== "function") {
    fail("executor_missing", "An explicit acceptance case executor is required.");
  }
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const approval = validateApproval(options.approval, { now });
  const base = Object.freeze({
    schemaVersion: 1,
    approvalId: approval.approvalId,
    relayProfile: approval.relayProfile,
    evidenceLocationFingerprint: approval.evidenceLocationFingerprint,
    startedAt: now.toISOString(),
    realRelayExecuted: options.mode === "real-relay"
  });
  const totals = { requestCount: 0, costUsd: 0, mayHaveBilled: false };
  const cases = [];
  for (let index = 0; index < ACCEPTANCE_MATRIX.length; index += 1) {
    const expected = ACCEPTANCE_MATRIX[index];
    const caseApproval = approval.cases[index];
    if (options.signal?.aborted) return stoppedRecord(base, "cancelled", totals, cases);
    if (options.isApprovalWithdrawn?.() === true) {
      return stoppedRecord(base, "approval-withdrawn", totals, cases);
    }
    if (
      totals.requestCount + caseApproval.maxRequests > approval.maxRequests ||
      totals.costUsd + caseApproval.maxCostUsd > approval.maxCostUsd + Number.EPSILON
    ) {
      return stoppedRecord(base, "budget-exhausted", totals, cases);
    }
    let observed;
    try {
      observed = await options.executeCase({
        caseId: expected.id,
        approval: caseApproval,
        relayProfile: approval.relayProfile,
        signal: options.signal
      });
    } catch (error) {
      cases.push(Object.freeze({
        caseId: expected.id,
        outcome: "transient-failure",
        capabilityState: "unknown",
        requestCount: 0,
        costUsd: 0,
        mayHaveBilled: false,
        safeError: redactString(error instanceof Error ? error.message : String(error))
      }));
      return stoppedRecord(base, "executor-failure", totals, cases);
    }
    const evidence = validateCaseEvidence(observed, expected.id);
    if (
      evidence.requestCount > caseApproval.maxRequests ||
      evidence.costUsd > caseApproval.maxCostUsd + Number.EPSILON
    ) {
      cases.push(evidence);
      totals.requestCount += evidence.requestCount;
      totals.costUsd += evidence.costUsd;
      totals.mayHaveBilled ||= evidence.mayHaveBilled;
      return stoppedRecord(base, "case-budget-exceeded", totals, cases);
    }
    cases.push(evidence);
    totals.requestCount += evidence.requestCount;
    totals.costUsd += evidence.costUsd;
    totals.mayHaveBilled ||= evidence.mayHaveBilled;
  }
  const acceptanceSatisfied = cases.every((item) =>
    item.outcome === (item.caseId === "partial-batch" ? "partial" : "success")
  );
  const record = Object.freeze({
    ...base,
    status: "complete",
    completedAt: new Date(now.getTime() + 1).toISOString(),
    totals: Object.freeze({ ...totals }),
    cases: Object.freeze(cases),
    releaseReady: options.mode === "real-relay" && acceptanceSatisfied
  });
  assertEvidenceSafe(record);
  return record;
}

export function validateAcceptanceEvidence(value) {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    fail("evidence_invalid", "Acceptance evidence must use schemaVersion 1.");
  }
  if (!["complete", "stopped"].includes(value.status)) {
    fail("evidence_invalid", "Acceptance evidence has an invalid status.");
  }
  if (!Array.isArray(value.cases)) fail("evidence_invalid", "Acceptance evidence requires cases.");
  if (value.status === "complete" && value.cases.length !== ACCEPTANCE_MATRIX.length) {
    fail("evidence_invalid", "Complete acceptance evidence requires the exact matrix.");
  }
  value.cases.forEach((item, index) => {
    if (index >= ACCEPTANCE_MATRIX.length) fail("evidence_invalid", "Acceptance evidence has extra cases.");
    const expected = ACCEPTANCE_MATRIX[index];
    if (!isRecord(item) || item.caseId !== expected.id) {
      fail("evidence_invalid", "Acceptance evidence cases are missing or out of order.");
    }
    if ("sharedLibrary" in item) {
      validateCaseEvidence(item, expected.id);
    } else if (value.status !== "stopped" || item.outcome !== "transient-failure") {
      fail("evidence_invalid", `${expected.id} is missing its shared Library evidence.`);
    }
  });
  assertEvidenceSafe(value);
  if (value.releaseReady === true && value.realRelayExecuted !== true) {
    fail("evidence_invalid", "Offline evidence cannot claim release readiness.");
  }
  if (value.status === "stopped" && typeof value.stopReason !== "string") {
    fail("evidence_invalid", "Stopped evidence requires a stop reason.");
  }
  return value;
}

async function main(argv) {
  if (argv.length !== 1 || argv[0] !== "--dry-run") {
    fail("real_execution_locked", "Task 7.1 permits only --dry-run; real relay execution requires Task 7.2 approval.");
  }
  const now = new Date("2030-01-01T00:00:00.000Z");
  const result = await runAcceptanceHarness({
    approval: createSyntheticApproval({ now }),
    executeCase: createSyntheticDryRunExecutor(),
    now,
    mode: "offline-dry-run"
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedAsScript = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  main(process.argv.slice(2)).catch((error) => {
    const safe = redactString(error instanceof Error ? error.message : String(error));
    process.stderr.write(`Routego real-relay acceptance refused: ${safe}\n`);
    process.exitCode = 1;
  });
}
