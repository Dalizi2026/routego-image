import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);
const capsulePath =
  args.find((value) => !value.startsWith("--")) ??
  ".codex/routego-program/handoffs/controller-generation-6.capsule.json";
const allowDirty = args.includes("--allow-dirty");
const failures = [];
const checks = [];

function fail(message) {
  failures.push(message);
}

function pass(message) {
  checks.push(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizedBytes(path) {
  return Buffer.from(
    readFileSync(resolve(root, path), "utf8").replace(/\r\n/g, "\n"),
    "utf8",
  );
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])]),
    );
  }
  return value;
}

function canonicalHash(value, selfField) {
  const copy = structuredClone(value);
  copy[selfField] = null;
  return sha256(Buffer.from(JSON.stringify(sortValue(copy)), "utf8"));
}

function git(arguments_, encoding = "utf8") {
  return execFileSync("git", arguments_, {
    cwd: root,
    encoding,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function reachable(commit) {
  try {
    git(["cat-file", "-e", `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function isAncestor(ancestor, descendant = "HEAD") {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function requireFields(object, fields, label) {
  for (const field of fields) {
    if (!(field in object)) {
      fail(`${label} missing field ${field}`);
    }
  }
}

let capsule;
try {
  capsule = readJson(capsulePath);
} catch (error) {
  console.error(`[HANDOFF_AUDIT_FAILED] cannot read capsule: ${error.message}`);
  process.exit(1);
}

requireFields(
  capsule,
  [
    "schemaVersion",
    "capsuleType",
    "capsuleSha256",
    "lane",
    "role",
    "program",
    "generation",
    "source",
    "successor",
    "currentIntegration",
    "authority",
    "context",
    "reportingContract",
    "startup",
    "validator",
    "safety",
  ],
  "controller capsule",
);

if (
  capsule.capsuleType !== "controller-successor-handoff" ||
  capsule.lane !== "controller" ||
  capsule.role !== "program-controller" ||
  capsule.generation.successor !== capsule.generation.source + 1
) {
  fail("controller capsule role or generation mismatch");
}

if (
  !reachable(capsule.source.handoffCommit) ||
  capsule.successor.startingCommit !== capsule.source.handoffCommit
) {
  fail("controller handoff starting commit is missing or inconsistent");
} else {
  const parents = git(["show", "-s", "--format=%P", capsule.source.handoffCommit]).split(
    /\s+/,
  );
  if (!parents.includes(capsule.source.handoffParent)) {
    fail("controller handoff parent mismatch");
  } else if (!isAncestor(capsule.source.handoffCommit)) {
    fail("current HEAD does not contain the controller handoff baseline");
  } else {
    pass("controller handoff commit and parent relation");
  }
}

let program;
let controller;
let integration;
let taskCapsule;
let integrationCapsule;
try {
  program = readJson(".codex/routego-program/program.json");
  controller = readJson(".codex/routego-program/threads/controller.json");
  integration = readJson(".codex/routego-program/threads/integration.json");
  taskCapsule = readJson(capsule.currentIntegration.taskCapsule.path);
  integrationCapsule = readJson(capsule.currentIntegration.handoffCapsule.path);
} catch (error) {
  fail(`cannot read compact authority files: ${error.message}`);
}

if (program && controller) {
  const activated = capsule.successor.registrationStatus.startsWith("activated");
  const sourceMatches = activated
    ? program.controllerPredecessor?.threadId === capsule.source.threadId &&
      program.controllerPredecessor?.generation === capsule.generation.source &&
      program.controllerPredecessor?.worktree === capsule.source.worktree &&
      program.controllerPredecessor?.branch === capsule.source.branch &&
      program.controllerPredecessor?.authorityRevoked === true &&
      controller.predecessor?.threadId === capsule.source.threadId &&
      controller.predecessor?.generation === capsule.generation.source &&
      controller.predecessor?.worktree === capsule.source.worktree &&
      controller.predecessor?.branch === capsule.source.branch &&
      controller.predecessor?.authorityRevoked === true
    : program.controller.threadId === capsule.source.threadId &&
      program.controller.generation === capsule.generation.source &&
      program.controller.worktree === capsule.source.worktree &&
      program.controller.branch === capsule.source.branch &&
      program.controller.status.startsWith("authoritative-pre-handoff") &&
      controller.threadId === capsule.source.threadId &&
      controller.generation === capsule.generation.source &&
      controller.worktree === capsule.source.worktree &&
      controller.branch === capsule.source.branch &&
      controller.authoritative === true;
  const programSuccessor = program.controllerSuccessor;
  const controllerSuccessor = controller.successor;
  const successorMatches =
    programSuccessor?.threadId === capsule.successor.threadId &&
    programSuccessor?.generation === capsule.generation.successor &&
    programSuccessor?.worktree === capsule.successor.worktree &&
    programSuccessor?.plannedBranch === capsule.successor.plannedBranch &&
    programSuccessor?.startingCommit === capsule.successor.startingCommit &&
    programSuccessor?.observableCompactions === 0 &&
    controllerSuccessor?.threadId === capsule.successor.threadId &&
    controllerSuccessor?.generation === capsule.generation.successor &&
    controllerSuccessor?.worktree === capsule.successor.worktree &&
    controllerSuccessor?.plannedBranch === capsule.successor.plannedBranch &&
    controllerSuccessor?.observableCompactions === 0 &&
    (!activated ||
      (program.controller.threadId === capsule.successor.threadId &&
        program.controller.generation === capsule.generation.successor &&
        program.controller.worktree === capsule.successor.worktree &&
        program.controller.branch === capsule.successor.plannedBranch &&
        program.controller.authoritative === true &&
        controller.threadId === capsule.successor.threadId &&
        controller.generation === capsule.generation.successor &&
        controller.worktree === capsule.successor.worktree &&
        controller.branch === capsule.successor.plannedBranch &&
        controller.authoritative === true));
  if (!sourceMatches || !successorMatches) {
    fail("program/controller/capsule authority identity mismatch");
  } else {
    pass("program/controller/capsule authority identity");
  }
}

if (program && integration && taskCapsule && integrationCapsule) {
  const current = capsule.currentIntegration;
  const expectedSoleApplyOwner = current.sourceFrozen !== true;
  const expectedApplyAuthorized = current.sourceFrozen !== true;
  const integrationMatches =
    program.applyOwner.threadId === current.threadId &&
    program.applyOwner.generation === current.generation &&
    program.applyOwner.worktree === current.worktree &&
    program.applyOwner.branch === current.branch &&
    program.applyOwner.currentHead === current.activationIncorporationHead &&
    program.applyOwner.soleApplyOwner === expectedSoleApplyOwner &&
    program.applyOwner.applyAuthorized === expectedApplyAuthorized &&
    integration.threadId === current.threadId &&
    integration.generation === current.generation &&
    integration.worktree === current.worktree &&
    integration.branch === current.branch &&
    integration.currentHead === current.activationIncorporationHead &&
    integration.soleApplyOwner === expectedSoleApplyOwner &&
    integration.applyAuthorized === expectedApplyAuthorized &&
    integration.currentTask.id === current.currentTaskId;
  if (!integrationMatches) {
    fail("current Integration owner mismatch");
  } else {
    pass("current Integration owner and task identity");
  }

  const taskHash = canonicalHash(taskCapsule, "contentSha256");
  if (
    taskHash !== taskCapsule.contentSha256 ||
    taskHash !== current.taskCapsule.sha256
  ) {
    fail("current Integration task capsule fingerprint mismatch");
  } else {
    pass("current Integration task capsule fingerprint");
  }

  const integrationCapsuleHash = canonicalHash(
    integrationCapsule,
    "capsuleSha256",
  );
  if (
    integrationCapsuleHash !== integrationCapsule.capsuleSha256 ||
    integrationCapsuleHash !== current.handoffCapsule.sha256
  ) {
    fail("current Integration handoff capsule fingerprint mismatch");
  } else {
    pass("current Integration handoff capsule fingerprint");
  }
}

for (const evidence of capsule.completedEvidence ?? []) {
  try {
    const value = readJson(evidence.path);
    const calculated = canonicalHash(value, "contentSha256");
    if (value.contentSha256 !== calculated || evidence.sha256 !== calculated) {
      fail(`evidence fingerprint mismatch: ${evidence.path}`);
    }
  } catch (error) {
    fail(`evidence unavailable: ${evidence.path} (${error.message})`);
  }
}
if (!failures.some((failure) => failure.startsWith("evidence"))) {
  pass("lossless Integration evidence references");
}

try {
  const summary = normalizedBytes(capsule.authority.summaryPath);
  if (sha256(summary) !== capsule.authority.summarySha256) {
    fail("authority summary fingerprint mismatch");
  } else {
    pass("authority summary fingerprint");
  }
} catch (error) {
  fail(`authority summary unavailable: ${error.message}`);
}

if (program) {
  const contract = {
    mcpTools: program.governance.publicContract.mcpTools,
    imageArtifactPhase: program.governance.publicContract.imageArtifactPhase,
  };
  const fingerprint = sha256(Buffer.from(JSON.stringify(contract), "utf8"));
  if (
    fingerprint !== program.governance.publicContract.fingerprint ||
    fingerprint !== capsule.authority.publicContractFingerprint
  ) {
    fail("seven-tool/public-phase fingerprint drift");
  } else {
    pass("seven-tool/public-phase fingerprint");
  }
}

if (
  capsule.startup.mandatoryFiles.length > capsule.startup.maxFiles ||
  capsule.startup.maxFiles > 12 ||
  capsule.startup.maxUtf8Bytes > 122880 ||
  capsule.startup.byteCounting !== "utf8-after-crlf-to-lf-normalization"
) {
  fail("startup budget policy mismatch");
}

let startupBytes = 0;
for (const file of capsule.startup.mandatoryFiles) {
  try {
    startupBytes += normalizedBytes(file).length;
  } catch (error) {
    fail(`startup file unavailable: ${file} (${error.message})`);
  }
}
if (
  startupBytes !== capsule.startup.expectedNormalizedUtf8Bytes ||
  startupBytes > capsule.startup.maxUtf8Bytes
) {
  fail(
    `startup normalized byte invariant mismatch: ${startupBytes} != ${capsule.startup.expectedNormalizedUtf8Bytes}`,
  );
} else {
  pass(
    `startup budget ${capsule.startup.mandatoryFiles.length} files / ${startupBytes} normalized UTF-8 bytes`,
  );
}

const fixedBudgets = [
  [capsule.authority.summaryPath, capsule.startup.authoritySummaryMaxBytes],
  [capsulePath, capsule.startup.handoffCapsuleMaxBytes],
  [".codex/routego-program/program.json", capsule.startup.programStateMaxBytes],
  [".codex/routego-program/threads/controller.json", capsule.startup.laneStateMaxBytes],
  [".codex/routego-program/threads/integration.json", capsule.startup.laneStateMaxBytes],
];
for (const [file, limit] of fixedBudgets) {
  if (statSync(resolve(root, file)).size > limit) {
    fail(`file budget exceeded: ${file}`);
  }
}

if (
  capsule.reportingContract.fallbackIntervalMinutes !== 30 ||
  capsule.reportingContract.finalAnswerAloneIsInsufficient !== true ||
  capsule.reportingContract.heartbeatInheritanceAssumed !== false ||
  program?.governance.reportingContract.fallbackIntervalMinutes !== 30 ||
  program?.automation.intervalMinutes !== 30 ||
  program?.automation.fallbackOnly !== true
) {
  fail("dual-path reporting contract mismatch");
} else {
  pass("dual-path reporting contract");
}

const sensitiveText = capsule.startup.mandatoryFiles
  .map((file) => readFileSync(resolve(root, file), "utf8"))
  .join("\n");
if (
  /data:image\/[a-z0-9][a-z0-9.+-]*;base64,[a-z0-9+/]{16,}={0,2}/i.test(
    sensitiveText,
  ) ||
  /Authorization\s*[:=]\s*(?:Bearer\s+)?[A-Za-z0-9._~-]{16,}/i.test(
    sensitiveText,
  ) ||
  /[A-Za-z0-9+/]{512,}={0,2}/.test(sensitiveText)
) {
  fail("sensitive payload audit failed");
} else {
  pass("sensitive payload audit");
}

const calculatedCapsuleHash = canonicalHash(capsule, "capsuleSha256");
if (calculatedCapsuleHash !== capsule.capsuleSha256) {
  fail("controller capsule content fingerprint mismatch");
} else {
  pass("controller capsule fingerprint");
}

const branch = git(["branch", "--show-current"]);
if (
  (!allowDirty && branch !== capsule.successor.plannedBranch) ||
  (allowDirty &&
    branch !== capsule.source.branch &&
    branch !== capsule.successor.plannedBranch)
) {
  fail(`branch mismatch: ${branch || "detached"}`);
} else {
  pass("Controller successor branch identity");
}

if (!allowDirty && git(["status", "--porcelain"])) {
  fail("Git worktree is not clean");
} else {
  pass(allowDirty ? "Git clean check deferred by --allow-dirty" : "Git clean");
}

if (failures.length > 0) {
  console.error(
    JSON.stringify(
      {
        status: "failed",
        label: "HANDOFF_AUDIT_FAILED",
        capsule: capsulePath,
        failures,
        checks,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: "passed",
      capsule: capsulePath,
      phase: capsule.successor.registrationStatus,
      checks,
      startupFiles: capsule.startup.mandatoryFiles.length,
      startupUtf8Bytes: startupBytes,
      gitCleanChecked: !allowDirty,
    },
    null,
    2,
  ),
);
