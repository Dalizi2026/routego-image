import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);
const capsuleArgument = args.find((value) => !value.startsWith("--"));
const capsulePath = capsuleArgument ?? ".codex/routego-program/handoffs/integration-generation-3.capsule.json";
const allowDirty = args.includes("--allow-dirty");
const failures = [];
const checks = [];

function fail(message) {
  failures.push(message);
}

function pass(message) {
  checks.push(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeUtf8LineEndings(bytes) {
  return Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
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

function git(argsList, encoding = "utf8") {
  return execFileSync("git", argsList, {
    cwd: root,
    encoding,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function reachable(commit) {
  try {
    git(["cat-file", "-e", commit + "^{commit}"]);
    return true;
  } catch {
    return false;
  }
}

function readRepositoryPath(filePath, sourceCommit) {
  const absolute = resolve(root, filePath);
  if (existsSync(absolute)) {
    return readFileSync(absolute);
  }
  return git(["show", sourceCommit + ":" + filePath], null);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(resolve(root, filePath), "utf8"));
}

function requireFields(object, fields, label) {
  for (const field of fields) {
    if (!(field in object)) {
      fail(label + " missing field " + field);
    }
  }
}

function normalizePath(value) {
  return value.replaceAll("\\", "/").replace(/^\.?\//, "");
}

function globPrefix(glob) {
  return normalizePath(glob).split("*")[0].replace(/\/$/, "");
}

function pathOverlap(allowed, forbidden) {
  const left = normalizePath(allowed);
  const prefix = globPrefix(forbidden);
  return Boolean(prefix) && (left === prefix || left.startsWith(prefix + "/"));
}

let capsule;
try {
  capsule = readJson(capsulePath);
} catch (error) {
  console.error("[HANDOFF_AUDIT_FAILED] cannot read capsule: " + error.message);
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
    "change",
    "generation",
    "source",
    "successor",
    "currentState",
    "completedEvidence",
    "authority",
    "gates",
    "context",
    "git",
    "reportingContract",
    "startup",
  ],
  "capsule",
);

if (capsule.schemaVersion !== 1 || capsule.capsuleType !== "successor-handoff") {
  fail("capsule schemaVersion/capsuleType mismatch");
}

for (const commit of [
  capsule.source.acceptedProductCommit,
  capsule.source.handoffCommit,
  capsule.source.handoffParent,
  capsule.successor.startingCommit,
]) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? "") || !reachable(commit)) {
    fail("unreachable full commit SHA " + String(commit));
  }
}

if (reachable(capsule.source.handoffCommit)) {
  const actualParent = git(["rev-parse", capsule.source.handoffCommit + "^"]).trim();
  if (actualParent !== capsule.source.handoffParent) {
    fail("handoff parent mismatch");
  } else {
    pass("handoff parent relation");
  }
}

if (capsule.successor.startingCommit !== capsule.source.handoffCommit) {
  fail("successor startingCommit must equal source handoffCommit");
}

const taskCapsulePath = capsule.currentState.taskCapsule.path;
let taskCapsule;
try {
  taskCapsule = readJson(taskCapsulePath);
} catch (error) {
  fail("cannot read task capsule: " + error.message);
}

if (taskCapsule) {
  requireFields(
    taskCapsule,
    [
      "contentSha256",
      "lane",
      "change",
      "taskId",
      "sourceCommit",
      "taskSource",
      "allowedFiles",
      "forbiddenFileGlobs",
      "directSpecifications",
      "publicContractFingerprint",
      "ownershipFingerprint",
    ],
    "task capsule",
  );
  const calculated = canonicalHash(taskCapsule, "contentSha256");
  if (taskCapsule.contentSha256 !== calculated) {
    fail("task capsule content fingerprint mismatch");
  } else if (capsule.currentState.taskCapsule.sha256 !== calculated) {
    fail("handoff task capsule reference fingerprint mismatch");
  } else {
    pass("task capsule fingerprint");
  }

  if (
    taskCapsule.lane !== capsule.lane ||
    taskCapsule.change !== capsule.change ||
    taskCapsule.taskId !== capsule.currentState.nextTaskId
  ) {
    fail("task capsule identity is inconsistent with handoff capsule");
  }

  let tasksBytes;
  try {
    tasksBytes = git([
      "show",
      taskCapsule.sourceCommit + ":" + taskCapsule.taskSource.path,
    ], null);
  } catch (error) {
    fail("cannot read OpenSpec tasks at source commit: " + error.message);
  }
  if (tasksBytes) {
    const tasksText = tasksBytes.toString("utf8");
    if (sha256(tasksBytes) !== taskCapsule.taskSource.fileSha256) {
      fail("OpenSpec tasks file fingerprint mismatch");
    }
    const taskLine = tasksText
      .split(/\r?\n/)
      .find((line) => line.startsWith("- [ ] " + taskCapsule.taskId + " "));
    if (!taskLine) {
      fail("current task is not an incomplete OpenSpec task at source commit");
    } else if (sha256(Buffer.from(taskLine, "utf8")) !== taskCapsule.taskSource.lineSha256) {
      fail("OpenSpec task line fingerprint mismatch");
    } else {
      pass("OpenSpec current task identity");
    }
  }

  for (const allowed of taskCapsule.allowedFiles) {
    const parent = dirname(normalizePath(allowed));
    try {
      git(["cat-file", "-e", taskCapsule.sourceCommit + ":" + parent]);
    } catch {
      fail("allowed file parent is missing at source commit: " + parent);
    }
    for (const forbidden of taskCapsule.forbiddenFileGlobs) {
      if (pathOverlap(allowed, forbidden)) {
        fail("allowed/forbidden scope overlap: " + allowed + " vs " + forbidden);
      }
    }
  }
  pass("allowed/forbidden scope audit");

  for (const specification of taskCapsule.directSpecifications) {
    try {
      const bytes = git([
        "show",
        taskCapsule.sourceCommit + ":" + specification.path,
      ], null);
      if (sha256(bytes) !== specification.sha256) {
        fail("specification fingerprint mismatch: " + specification.path);
      }
    } catch {
      fail("specification missing at source commit: " + specification.path);
    }
  }
}

for (const evidence of capsule.completedEvidence ?? []) {
  try {
    const evidenceJson = readJson(evidence.path);
    const calculated = canonicalHash(evidenceJson, "contentSha256");
    if (calculated !== evidenceJson.contentSha256 || calculated !== evidence.sha256) {
      fail("evidence fingerprint mismatch: " + evidence.path);
    }
  } catch (error) {
    fail("evidence missing or invalid: " + evidence.path + " (" + error.message + ")");
  }
}

try {
  const historyIndex = readJson(capsule.authority.historyIndex);
  const calculated = canonicalHash(historyIndex, "contentSha256");
  if (calculated !== historyIndex.contentSha256) {
    fail("history index content fingerprint mismatch");
  }
  if (!reachable(historyIndex.sourceCommit)) {
    fail("history source commit is unreachable");
  }
  for (const entry of historyIndex.files) {
    const blob = git(["rev-parse", historyIndex.sourceCommit + ":" + entry.path]).trim();
    const bytes = git(["cat-file", "blob", blob], null);
    if (
      blob !== entry.gitBlobSha1 ||
      sha256(bytes) !== entry.sha256 ||
      bytes.length !== entry.bytes
    ) {
      fail("lossless history entry mismatch: " + entry.path);
    }
  }
  pass("lossless history index");
} catch (error) {
  fail("history index missing or invalid: " + error.message);
}

let program;
let lane;
try {
  program = readJson(".codex/routego-program/program.json");
  lane = readJson(".codex/routego-program/threads/" + capsule.lane + ".json");
} catch (error) {
  fail("cannot read compact current state: " + error.message);
}

if (program && lane) {
  const successorIsCurrent = /^(registered|accepted|activated)/.test(
    capsule.successor.registrationStatus,
  );
  const activated = capsule.successor.registrationStatus.startsWith("activated");
  const laneIdentityMatches = successorIsCurrent
    ? lane.change === capsule.change &&
      lane.generation === capsule.generation.successor &&
      lane.threadId === capsule.successor.threadId &&
      lane.worktree === capsule.successor.worktree &&
      lane.branch === capsule.successor.plannedBranch &&
      lane.sourceOwner?.threadId === capsule.source.threadId &&
      lane.sourceOwner?.worktree === capsule.source.worktree &&
      lane.sourceOwner?.branch === capsule.source.branch &&
      lane.soleApplyOwner === activated &&
      lane.applyAuthorized === activated &&
      lane.sourceOwner?.soleApplyOwner === !activated &&
      lane.sourceOwner?.archived === activated
    : lane.change === capsule.change &&
      lane.generation === capsule.generation.source &&
      lane.threadId === capsule.source.threadId &&
      lane.worktree === capsule.source.worktree &&
      lane.branch === capsule.source.branch;
  const successorMatches = successorIsCurrent
    ? program.successor.threadId === capsule.successor.threadId &&
      program.successor.worktree === capsule.successor.worktree &&
      program.successor.plannedBranch === capsule.successor.plannedBranch
    : program.successor.threadId === null && program.successor.worktree === null;
  if (
    program.currentChange.id !== capsule.change ||
    program.currentChange.openspec.nextTaskId !== capsule.currentState.nextTaskId ||
    !laneIdentityMatches ||
    !successorMatches
  ) {
    fail("program/lane/capsule current identity mismatch");
  } else {
    pass("program/lane/capsule identity");
  }
  if (program.authoritySummary.sha256 !== capsule.authority.summarySha256) {
    fail("program authority-summary fingerprint mismatch");
  }

  const contract = {
    mcpTools: program.governance.publicContract.mcpTools,
    imageArtifactPhase: program.governance.publicContract.imageArtifactPhase,
  };
  const fingerprint = sha256(Buffer.from(JSON.stringify(contract), "utf8"));
  if (
    fingerprint !== program.governance.publicContract.fingerprint ||
    fingerprint !== capsule.authority.publicContractFingerprint ||
    (taskCapsule && fingerprint !== taskCapsule.publicContractFingerprint)
  ) {
    fail("seven-tool/public-phase fingerprint drift");
  } else {
    pass("seven-tool/public-phase fingerprint");
  }
}

try {
  const summaryBytes = readFileSync(resolve(root, capsule.authority.summaryPath));
  const normalizedSummaryBytes = Buffer.from(
    summaryBytes.toString("utf8").replace(/\r\n/g, "\n"),
    "utf8",
  );
  if (sha256(normalizedSummaryBytes) !== capsule.authority.summarySha256) {
    fail("authority summary fingerprint mismatch");
  } else {
    pass("authority summary fingerprint");
  }
} catch (error) {
  fail("authority summary missing: " + error.message);
}

if (taskCapsule && taskCapsule.ownershipFingerprint !== capsule.authority.ownershipFingerprint) {
  fail("ownership fingerprint mismatch");
}

const budgets = {
  authoritySummary: 16 * 1024,
  handoffCapsule: 24 * 1024,
  program: 48 * 1024,
  lane: 32 * 1024,
  startup: capsule.startup.maxUtf8Bytes,
  startupFiles: capsule.startup.maxFiles,
};

const fixedBudgetFiles = [
  [capsule.authority.summaryPath, budgets.authoritySummary],
  [capsulePath, budgets.handoffCapsule],
  [".codex/routego-program/program.json", budgets.program],
  [".codex/routego-program/threads/" + capsule.lane + ".json", budgets.lane],
];

for (const [filePath, limit] of fixedBudgetFiles) {
  const size = statSync(resolve(root, filePath)).size;
  if (size > limit) {
    fail("file budget exceeded: " + filePath + " " + size + " > " + limit);
  }
}

for (const fileName of readdirSync(resolve(root, ".codex/routego-program/threads"))) {
  if (!fileName.endsWith(".json")) {
    continue;
  }
  const filePath = ".codex/routego-program/threads/" + fileName;
  const size = statSync(resolve(root, filePath)).size;
  if (size > budgets.lane) {
    fail("lane state budget exceeded: " + filePath + " " + size + " > " + budgets.lane);
  }
}

if (capsule.startup.mandatoryFiles.length > budgets.startupFiles) {
  fail("startup file count budget exceeded");
}

if (capsule.startup.byteCounting !== "utf8-after-crlf-to-lf-normalization") {
  fail("startup byte-count normalization policy mismatch");
}
if (!Number.isInteger(capsule.startup.expectedNormalizedUtf8Bytes)) {
  fail("startup expected normalized byte count is missing");
}

let startupBytes = 0;
for (const startupFile of capsule.startup.mandatoryFiles) {
  try {
    startupBytes += normalizeUtf8LineEndings(
      readRepositoryPath(startupFile, capsule.successor.startingCommit),
    ).length;
  } catch (error) {
    fail("startup file unavailable: " + startupFile + " (" + error.message + ")");
  }
}
if (startupBytes !== capsule.startup.expectedNormalizedUtf8Bytes) {
  fail(
    "startup normalized byte invariant mismatch: " +
      startupBytes +
      " != " +
      capsule.startup.expectedNormalizedUtf8Bytes,
  );
} else if (startupBytes > budgets.startup) {
  fail("startup byte budget exceeded: " + startupBytes + " > " + budgets.startup);
} else {
  pass(
    "startup budget " +
      capsule.startup.mandatoryFiles.length +
      " files / " +
      startupBytes +
      " normalized UTF-8 bytes",
  );
}

const scanFiles = [
  capsulePath,
  taskCapsulePath,
  capsule.authority.summaryPath,
  ".codex/routego-program/program.json",
  ".codex/routego-program/threads/controller.json",
  ".codex/routego-program/threads/" + capsule.lane + ".json",
  ...capsule.completedEvidence.map((evidence) => evidence.path),
];
const forbiddenPayloadPatterns = [
  /authorization\s*[:=]\s*(?:bearer|basic)\s+[^\s"']+/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /data:image\/[a-z0-9.+-]+;base64,/i,
  /(?:^|[^A-Za-z0-9+/])[A-Za-z0-9+/]{512,}={0,2}(?:$|[^A-Za-z0-9+/])/,
];
for (const filePath of scanFiles) {
  const text = readFileSync(resolve(root, filePath), "utf8");
  for (const pattern of forbiddenPayloadPatterns) {
    if (pattern.test(text)) {
      fail("sensitive payload pattern detected in " + filePath);
    }
  }
}
pass("sensitive payload audit");

const capsuleCalculated = canonicalHash(capsule, "capsuleSha256");
if (capsule.capsuleSha256 !== capsuleCalculated) {
  fail("handoff capsule content fingerprint mismatch");
} else {
  pass("handoff capsule fingerprint");
}

if (!capsule.reportingContract.primary.includes("send_message_to_thread") ||
    !capsule.reportingContract.primary.includes("read_thread") ||
    capsule.reportingContract.fallbackIntervalMinutes !== 30 ||
    capsule.reportingContract.finalAnswerAloneIsInsufficient !== true) {
  fail("dual-path reporting contract is incomplete");
} else {
  pass("dual-path reporting contract");
}

if (!allowDirty) {
  const dirty = git(["status", "--porcelain"]).trim();
  if (dirty) {
    fail("Git worktree is not clean");
  } else {
    pass("Git clean");
  }
}

if (failures.length > 0) {
  console.error("[HANDOFF_AUDIT_FAILED]");
  for (const failure of failures) {
    console.error("- " + failure);
  }
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
