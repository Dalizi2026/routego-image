#!/usr/bin/env node

import { mkdir, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertEvidenceSafe,
  assertOwnedReleaseRoot,
  assertSentinelsUnchanged,
  atomicSwitchDryRun,
  fingerprintSentinels,
  validateReleaseApproval
} from "./stage-routego-release.mjs";

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function requireLexicallyContained(root, candidate, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (!isContained(resolvedRoot, resolvedCandidate)) throw new Error(`${label} escapes the dry-run root.`);
}

async function requireContained(root, candidate, label) {
  const [resolvedRoot, resolvedCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  if (!isContained(resolvedRoot, resolvedCandidate)) throw new Error(`${label} escapes the dry-run root.`);
}

export async function restoreArchivedPluginDryRun(options) {
  const {
    releaseRoot,
    targetPluginDirectory,
    archiveDirectory,
    failedCandidateDirectory,
    verifyRestored,
    legacySentinelFiles = [],
    failAfterQuarantine = false
  } = options ?? {};
  if (typeof verifyRestored !== "function") throw new Error("A fresh-task rollback verifier is required.");
  const ownedRoot = await assertOwnedReleaseRoot(releaseRoot);
  requireLexicallyContained(releaseRoot, targetPluginDirectory, "Target");
  requireLexicallyContained(releaseRoot, archiveDirectory, "Archive");
  requireLexicallyContained(releaseRoot, path.dirname(failedCandidateDirectory), "Failed-candidate parent");
  await mkdir(path.dirname(failedCandidateDirectory), { recursive: true });
  await Promise.all([
    requireContained(ownedRoot, targetPluginDirectory, "Target"),
    requireContained(ownedRoot, archiveDirectory, "Archive"),
    requireContained(ownedRoot, path.dirname(failedCandidateDirectory), "Failed-candidate parent")
  ]);
  const beforeSentinels = await fingerprintSentinels(legacySentinelFiles);
  await rename(targetPluginDirectory, failedCandidateDirectory);
  if (failAfterQuarantine) {
    await rename(failedCandidateDirectory, targetPluginDirectory);
    throw new Error("Injected rollback failure after candidate quarantine.");
  }
  try {
    await rename(archiveDirectory, targetPluginDirectory);
  } catch (error) {
    await rename(failedCandidateDirectory, targetPluginDirectory);
    throw error;
  }
  let verified = false;
  try {
    verified = await verifyRestored(targetPluginDirectory) === true;
  } catch {
    verified = false;
  }
  const afterSentinels = await fingerprintSentinels(legacySentinelFiles);
  assertSentinelsUnchanged(beforeSentinels, afterSentinels);
  const evidence = {
    schemaVersion: 1,
    mode: "synthetic-dry-run",
    rollbackAttempted: true,
    rollbackVerified: verified,
    failedCandidatePreserved: true,
    legacySentinelsUnchanged: true
  };
  assertEvidenceSafe(evidence);
  if (!evidence.rollbackVerified) throw new Error("The restored plugin failed fresh-task rollback verification.");
  return evidence;
}

export async function simulateReleaseWithRollback(options) {
  const {
    releaseRoot,
    stageDirectory,
    targetPluginDirectory,
    archiveDirectory,
    failedCandidateDirectory,
    verifyInstalled,
    verifyRestored,
    legacySentinelFiles = []
  } = options ?? {};
  if (typeof verifyInstalled !== "function") throw new Error("A fresh-task install verifier is required.");
  const beforeSentinels = await fingerprintSentinels(legacySentinelFiles);
  const switched = await atomicSwitchDryRun({ releaseRoot, stageDirectory, targetPluginDirectory, archiveDirectory });
  let installedVerified = false;
  try {
    installedVerified = await verifyInstalled(targetPluginDirectory) === true;
  } catch {
    installedVerified = false;
  }
  if (!installedVerified) {
    const rollback = await restoreArchivedPluginDryRun({
      releaseRoot,
      targetPluginDirectory,
      archiveDirectory,
      failedCandidateDirectory,
      verifyRestored,
      legacySentinelFiles
    });
    const afterSentinels = await fingerprintSentinels(legacySentinelFiles);
    assertSentinelsUnchanged(beforeSentinels, afterSentinels);
    return { switched, installedVerified: false, rollback };
  }
  const afterSentinels = await fingerprintSentinels(legacySentinelFiles);
  assertSentinelsUnchanged(beforeSentinels, afterSentinels);
  return { switched, installedVerified: true, rollback: null };
}

export function requireRealReleaseApproval(approval, expected) {
  return validateReleaseApproval(approval, expected);
}

async function main() {
  throw new Error("Rollback execution is locked until Task 8.2 supplies an exact release approval and paths.");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Rollback refused."}\n`);
    process.exitCode = 1;
  });
}
