#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { comparePluginPackages, verifyPluginPackage } from "./verify-plugin-package.mjs";

const OWNED_PREFIX = "routego-release-dry-run-";
const OWNER_MARKER = ".routego-release-owner.json";
const MAX_EVIDENCE_STRING = 512;
const MAX_SENTINELS = 64;
const CACHEBUSTER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const FORBIDDEN_EVIDENCE = /(?:authorization|bearer\s|sk-[A-Za-z0-9]|data:image|file:\/\/|\/(?:Users|home)\/|[A-Za-z]:\\)/iu;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function assertSafeToken(value, name) {
  requireString(value, name);
  if (!CACHEBUSTER_PATTERN.test(value)) throw new Error(`${name} is not a bounded safe token.`);
  return value;
}

export function normalizeCachebuster(value) {
  requireString(value, "cachebuster");
  const normalized = value.trim().toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-|-$/gu, "");
  if (!normalized || !CACHEBUSTER_PATTERN.test(normalized)) {
    throw new Error("cachebuster cannot be normalized to a bounded token.");
  }
  return normalized;
}

function pathIdentity(value) {
  return sha256(Buffer.from(path.resolve(value), "utf8"));
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertLexicallyContained(root, candidate, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (!isContained(resolvedRoot, resolvedCandidate)) throw new Error(`${label} escapes the owned release root.`);
  return resolvedCandidate;
}

async function assertContained(root, candidate, label) {
  const [resolvedRoot, resolvedCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  if (!isContained(resolvedRoot, resolvedCandidate)) throw new Error(`${label} escapes the owned release root.`);
  return resolvedCandidate;
}

async function readOwnerMarker(root) {
  const resolvedRoot = await realpath(root);
  if (!path.basename(resolvedRoot).startsWith(OWNED_PREFIX)) throw new Error("Release root lacks the owned prefix.");
  const markerPath = path.join(resolvedRoot, OWNER_MARKER);
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  if (marker?.schemaVersion !== 1 || marker.kind !== "routego-release-dry-run" ||
      marker.rootName !== path.basename(resolvedRoot) || typeof marker.nonceHash !== "string") {
    throw new Error("Release root ownership marker is invalid.");
  }
  return { resolvedRoot, marker };
}

export async function assertOwnedReleaseRoot(root) {
  return (await readOwnerMarker(root)).resolvedRoot;
}

export async function createOwnedReleaseRoot(parentDirectory = os.tmpdir(), operationId = "task-8.1") {
  assertSafeToken(operationId, "operationId");
  await mkdir(parentDirectory, { recursive: true });
  const root = await mkdtemp(path.join(parentDirectory, `${OWNED_PREFIX}${operationId}-`));
  const marker = {
    schemaVersion: 1,
    kind: "routego-release-dry-run",
    rootName: path.basename(root),
    operationId,
    nonceHash: sha256(randomUUID())
  };
  await writeFile(path.join(root, OWNER_MARKER), stableJson(marker), { mode: 0o600 });
  return root;
}

export async function cleanupOwnedReleaseRoot(root) {
  const { resolvedRoot } = await readOwnerMarker(root);
  await rm(resolvedRoot, { recursive: true, force: false });
  return { removedOwnedRoot: true, rootIdentity: pathIdentity(resolvedRoot) };
}

async function collectTree(root) {
  const files = [];
  async function visit(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativeFile = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      const absoluteFile = path.join(directory, entry.name);
      const metadata = await lstat(absoluteFile);
      if (metadata.isSymbolicLink()) throw new Error(`Release trees cannot contain symbolic links: ${relativeFile}`);
      if (metadata.isDirectory()) await visit(absoluteFile, relativeFile);
      else if (metadata.isFile()) {
        const bytes = await readFile(absoluteFile);
        files.push({ path: relativeFile, bytes: bytes.length, sha256: sha256(bytes) });
      } else throw new Error(`Release trees cannot contain special files: ${relativeFile}`);
    }
  }
  await visit(root);
  return files;
}

export async function fingerprintSentinels(files) {
  if (!Array.isArray(files) || files.length > MAX_SENTINELS) throw new Error("Legacy sentinel list is invalid.");
  const result = [];
  for (const file of files) {
    const [bytes, metadata] = await Promise.all([readFile(file), stat(file)]);
    result.push({ identity: pathIdentity(file), bytes: bytes.length, sha256: sha256(bytes), mtimeMs: metadata.mtimeMs });
  }
  return result;
}

export function assertSentinelsUnchanged(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Legacy sentinel content, hash, size, or mtime changed.");
}

export function assertEvidenceSafe(value, location = "evidence", depth = 0) {
  if (depth > 12) throw new Error(`${location} exceeds the evidence depth limit.`);
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value === "string") {
    if (value.length > MAX_EVIDENCE_STRING || FORBIDDEN_EVIDENCE.test(value)) {
      throw new Error(`${location} contains an unsafe or unrestricted value.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 512) throw new Error(`${location} contains too many items.`);
    value.forEach((item, index) => assertEvidenceSafe(item, `${location}[${index}]`, depth + 1));
    return;
  }
  if (typeof value !== "object") throw new Error(`${location} has an unsupported value.`);
  for (const [key, item] of Object.entries(value)) {
    if (/(?:credential|authorization|token|secret|session|absolutePath|home|codexHome)/iu.test(key)) {
      throw new Error(`${location}.${key} is forbidden in release evidence.`);
    }
    assertEvidenceSafe(item, `${location}.${key}`, depth + 1);
  }
}

export function buildPluginCreatorUpdatePlan(options = {}) {
  const pluginName = options.pluginName ?? "routego-image";
  const cachebuster = normalizeCachebuster(options.cachebuster ?? "release-candidate");
  if (pluginName !== "routego-image") throw new Error("Only the accepted routego-image plugin may be planned.");
  return Object.freeze({
    schemaVersion: 1,
    helper: "plugin-creator/update_plugin_cachebuster.py",
    helperArguments: ["<plugin-source>", "--cachebuster", cachebuster],
    marketplaceNameHelper: "plugin-creator/read_marketplace_name.py",
    reinstallCommand: ["codex", "plugin", "add", "routego-image@<confirmed-local-marketplace>"],
    requiresArtifactRebuildAndReacceptance: true,
    executeAuthorized: false
  });
}

export function validateReleaseApproval(approval, expected) {
  if (approval?.schemaVersion !== 1 || approval?.releaseAuthorized !== true ||
      approval.artifactManifestSha256 !== expected.artifactManifestSha256 ||
      approval.targetIdentity !== expected.targetIdentity || approval.archiveIdentity !== expected.archiveIdentity ||
      approval.marketplaceAction !== expected.marketplaceAction || approval.cachebuster !== expected.cachebuster ||
      approval.atomicSwitchApproved !== true || approval.rollbackApproved !== true ||
      typeof approval.approvedAt !== "string") {
    throw new Error("Exact Task 8.2 release approval is missing or does not match this release plan.");
  }
  return true;
}

export async function prepareReleaseStage(options) {
  const {
    packageDirectory,
    acceptedArtifactManifestSha256,
    releaseRoot,
    targetPluginDirectory,
    archiveDirectory,
    legacySentinelFiles = [],
    operationId = "task-8.1",
    cachebuster = "release-candidate"
  } = options ?? {};
  requireString(packageDirectory, "packageDirectory");
  requireString(acceptedArtifactManifestSha256, "acceptedArtifactManifestSha256");
  if (!/^[a-f0-9]{64}$/u.test(acceptedArtifactManifestSha256)) throw new Error("Accepted artifact hash is invalid.");
  assertSafeToken(operationId, "operationId");
  const normalizedCachebuster = normalizeCachebuster(cachebuster);
  const { resolvedRoot } = await readOwnerMarker(releaseRoot);
  const targetParent = path.dirname(targetPluginDirectory);
  const archiveParent = path.dirname(archiveDirectory);
  assertLexicallyContained(releaseRoot, targetParent, "Target parent");
  assertLexicallyContained(releaseRoot, archiveParent, "Archive parent");
  await Promise.all([mkdir(targetParent, { recursive: true }), mkdir(archiveParent, { recursive: true })]);
  await Promise.all([
    assertContained(resolvedRoot, targetParent, "Target parent"),
    assertContained(resolvedRoot, archiveParent, "Archive parent")
  ]);
  const beforeSentinels = await fingerprintSentinels(legacySentinelFiles);
  const sourceVerification = await verifyPluginPackage(packageDirectory);
  if (sourceVerification.artifactManifestFileSha256 !== acceptedArtifactManifestSha256) {
    throw new Error("The source artifact manifest does not match the accepted SHA-256.");
  }
  const stageDirectory = path.join(releaseRoot, "staged", "routego-image");
  await mkdir(path.dirname(stageDirectory), { recursive: true });
  await cp(packageDirectory, stageDirectory, { recursive: true, errorOnExist: true, force: false });
  const comparison = await comparePluginPackages(packageDirectory, stageDirectory);
  if (!comparison.equivalent || comparison.second.artifactManifestFileSha256 !== acceptedArtifactManifestSha256) {
    throw new Error("The staged package differs from the accepted source artifact.");
  }
  const afterSentinels = await fingerprintSentinels(legacySentinelFiles);
  assertSentinelsUnchanged(beforeSentinels, afterSentinels);
  const stageDevice = (await stat(stageDirectory)).dev;
  const targetDevice = (await stat(targetParent)).dev;
  if (stageDevice !== targetDevice) throw new Error("Stage and target are not on the same filesystem.");
  const evidence = {
    schemaVersion: 1,
    mode: "synthetic-dry-run",
    operationId,
    artifactManifestSha256: acceptedArtifactManifestSha256,
    sourceTreeSha256: sha256(Buffer.from(JSON.stringify(await collectTree(packageDirectory)))),
    stagedTreeSha256: sha256(Buffer.from(JSON.stringify(await collectTree(stageDirectory)))),
    stageIdentity: pathIdentity(stageDirectory),
    targetIdentity: pathIdentity(targetPluginDirectory),
    archiveIdentity: pathIdentity(archiveDirectory),
    sameFilesystem: true,
    cachebusterPlan: buildPluginCreatorUpdatePlan({ cachebuster: normalizedCachebuster }),
    legacySentinelsUnchanged: true,
    releaseAuthorized: false
  };
  assertEvidenceSafe(evidence);
  return { stageDirectory, evidence };
}

export async function atomicSwitchDryRun(options) {
  const { releaseRoot, stageDirectory, targetPluginDirectory, archiveDirectory, failAfterArchive = false } = options ?? {};
  const { resolvedRoot } = await readOwnerMarker(releaseRoot);
  assertLexicallyContained(releaseRoot, stageDirectory, "Stage");
  assertLexicallyContained(releaseRoot, targetPluginDirectory, "Target");
  assertLexicallyContained(releaseRoot, path.dirname(archiveDirectory), "Archive parent");
  await Promise.all([
    assertContained(resolvedRoot, stageDirectory, "Stage"),
    assertContained(resolvedRoot, targetPluginDirectory, "Target"),
    assertContained(resolvedRoot, path.dirname(archiveDirectory), "Archive parent")
  ]);
  await mkdir(path.dirname(archiveDirectory), { recursive: true });
  await rename(targetPluginDirectory, archiveDirectory);
  try {
    if (failAfterArchive) throw new Error("Injected failure after archival.");
    await rename(stageDirectory, targetPluginDirectory);
  } catch (error) {
    await rename(archiveDirectory, targetPluginDirectory);
    throw error;
  }
  return {
    switched: true,
    targetIdentity: pathIdentity(targetPluginDirectory),
    archiveIdentity: pathIdentity(archiveDirectory)
  };
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === "--print-plan") return { printPlan: true };
  throw new Error("Usage: node scripts/stage-routego-release.mjs --print-plan");
}

async function main() {
  parseArguments(process.argv.slice(2));
  process.stdout.write(stableJson(buildPluginCreatorUpdatePlan()));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Release staging refused."}\n`);
    process.exitCode = 1;
  });
}
