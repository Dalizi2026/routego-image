import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
const scriptRoot = new URL("../../../scripts/", import.meta.url);
// Keep Node-owned release scripts out of Vite's Windows source transformer.
const { buildPluginPackage } = await import(
  /* @vite-ignore */ new URL("build-plugin-package.mjs", scriptRoot).href
);
const { verifyPluginPackage } = await import(
  /* @vite-ignore */ new URL("verify-plugin-package.mjs", scriptRoot).href
);
const {
  assertEvidenceSafe,
  atomicSwitchDryRun,
  buildPluginCreatorUpdatePlan,
  cleanupOwnedReleaseRoot,
  createOwnedReleaseRoot,
  normalizeCachebuster,
  prepareReleaseStage,
  validateReleaseApproval
} = await import(/* @vite-ignore */ new URL("stage-routego-release.mjs", scriptRoot).href);
const { restoreArchivedPluginDryRun, simulateReleaseWithRollback } = await import(
  /* @vite-ignore */ new URL("rollback-routego-release.mjs", scriptRoot).href
);

describe.sequential("task 8.1 offline release and rollback workflow", () => {
  let suiteRoot: string;
  let packageRoot: string;
  let acceptedArtifactManifestSha256: string;
  const ownedRoots: string[] = [];

  beforeAll(async () => {
    suiteRoot = await mkdtemp(path.join(os.tmpdir(), "routego-release-workflow-test-"));
    packageRoot = path.join(suiteRoot, "accepted", "routego-image");
    await buildPluginPackage({ repositoryRoot: REPOSITORY_ROOT, outputDirectory: packageRoot });
    acceptedArtifactManifestSha256 = (await verifyPluginPackage(packageRoot)).artifactManifestFileSha256;
  }, 120_000);

  afterEach(async () => {
    while (ownedRoots.length > 0) {
      const root = ownedRoots.pop();
      if (root !== undefined) await cleanupOwnedReleaseRoot(root);
    }
  });

  afterAll(async () => {
    await rm(suiteRoot, { recursive: true, force: true });
  });

  async function setup(operationId: string) {
    const root = await createOwnedReleaseRoot(suiteRoot, operationId);
    ownedRoots.push(root);
    const targetPluginDirectory = path.join(root, "live", "routego-image");
    const archiveDirectory = path.join(root, "archives", `routego-image-${operationId}`);
    const failedCandidateDirectory = path.join(root, "failed", operationId, "routego-image");
    const legacySentinel = path.join(root, "legacy", "keep.txt");
    await Promise.all([
      mkdir(targetPluginDirectory, { recursive: true }),
      mkdir(path.dirname(legacySentinel), { recursive: true })
    ]);
    await Promise.all([
      writeFile(path.join(targetPluginDirectory, "old-plugin.txt"), "synthetic old plugin\n", "utf8"),
      writeFile(legacySentinel, "synthetic legacy data\n", "utf8")
    ]);
    const legacyBefore = await stat(legacySentinel);
    const prepared = await prepareReleaseStage({
      packageDirectory: packageRoot,
      acceptedArtifactManifestSha256,
      releaseRoot: root,
      targetPluginDirectory,
      archiveDirectory,
      legacySentinelFiles: [legacySentinel],
      operationId,
      cachebuster: `candidate-${operationId}`
    });
    return {
      root,
      targetPluginDirectory,
      archiveDirectory,
      failedCandidateDirectory,
      legacySentinel,
      legacyBefore,
      stageDirectory: prepared.stageDirectory,
      evidence: prepared.evidence
    };
  }

  it("stages the exact accepted artifact and emits only redacted identities", async () => {
    const release = await setup("stage-success");
    expect(release.evidence).toMatchObject({
      mode: "synthetic-dry-run",
      artifactManifestSha256: acceptedArtifactManifestSha256,
      sameFilesystem: true,
      legacySentinelsUnchanged: true,
      releaseAuthorized: false
    });
    expect(release.evidence.sourceTreeSha256).toBe(release.evidence.stagedTreeSha256);
    expect(JSON.stringify(release.evidence)).not.toContain(release.root);
    expect(await verifyPluginPackage(release.stageDirectory)).toMatchObject({ artifactManifestFileSha256: acceptedArtifactManifestSha256 });
    expect((await stat(release.legacySentinel)).mtimeMs).toBe(release.legacyBefore.mtimeMs);
  });

  it("rejects an artifact that differs from the accepted manifest hash", async () => {
    const root = await createOwnedReleaseRoot(suiteRoot, "wrong-hash");
    ownedRoots.push(root);
    const target = path.join(root, "live", "routego-image");
    await mkdir(target, { recursive: true });
    await expect(prepareReleaseStage({
      packageDirectory: packageRoot,
      acceptedArtifactManifestSha256: "0".repeat(64),
      releaseRoot: root,
      targetPluginDirectory: target,
      archiveDirectory: path.join(root, "archives", "old")
    })).rejects.toThrow(/accepted SHA-256/u);
  });

  it("rejects an escaped archive parent before creating anything outside the owned root", async () => {
    const root = await createOwnedReleaseRoot(suiteRoot, "escaped-parent");
    ownedRoots.push(root);
    const target = path.join(root, "live", "routego-image");
    const escaped = path.join(suiteRoot, "must-not-be-created", "archive");
    await mkdir(target, { recursive: true });
    await expect(prepareReleaseStage({
      packageDirectory: packageRoot,
      acceptedArtifactManifestSha256,
      releaseRoot: root,
      targetPluginDirectory: target,
      archiveDirectory: escaped
    })).rejects.toThrow(/escapes the owned release root/u);
    await expect(stat(path.dirname(escaped))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores the prior target when the atomic switch fails after archival", async () => {
    const release = await setup("partial-switch");
    await expect(atomicSwitchDryRun({
      releaseRoot: release.root,
      stageDirectory: release.stageDirectory,
      targetPluginDirectory: release.targetPluginDirectory,
      archiveDirectory: release.archiveDirectory,
      failAfterArchive: true
    })).rejects.toThrow(/Injected failure/u);
    await expect(readFile(path.join(release.targetPluginDirectory, "old-plugin.txt"), "utf8")).resolves.toBe("synthetic old plugin\n");
    await expect(verifyPluginPackage(release.stageDirectory)).resolves.toBeDefined();
  });

  it("switches atomically and preserves the rollback archive on success", async () => {
    const release = await setup("switch-success");
    const result = await simulateReleaseWithRollback({
      releaseRoot: release.root,
      stageDirectory: release.stageDirectory,
      targetPluginDirectory: release.targetPluginDirectory,
      archiveDirectory: release.archiveDirectory,
      failedCandidateDirectory: release.failedCandidateDirectory,
      legacySentinelFiles: [release.legacySentinel],
      verifyInstalled: async (candidate: string) => (await verifyPluginPackage(candidate)).artifactManifestFileSha256 === acceptedArtifactManifestSha256,
      verifyRestored: async () => true
    });
    expect(result).toMatchObject({ installedVerified: true, rollback: null });
    await expect(verifyPluginPackage(release.targetPluginDirectory)).resolves.toBeDefined();
    await expect(readFile(path.join(release.archiveDirectory, "old-plugin.txt"), "utf8")).resolves.toBe("synthetic old plugin\n");
    expect((await stat(release.legacySentinel)).mtimeMs).toBe(release.legacyBefore.mtimeMs);
  });

  it("automatically restores the archived plugin after fresh-task verification fails", async () => {
    const release = await setup("rollback-success");
    const result = await simulateReleaseWithRollback({
      releaseRoot: release.root,
      stageDirectory: release.stageDirectory,
      targetPluginDirectory: release.targetPluginDirectory,
      archiveDirectory: release.archiveDirectory,
      failedCandidateDirectory: release.failedCandidateDirectory,
      legacySentinelFiles: [release.legacySentinel],
      verifyInstalled: async () => false,
      verifyRestored: async (candidate: string) => (await readFile(path.join(candidate, "old-plugin.txt"), "utf8")) === "synthetic old plugin\n"
    });
    expect(result).toMatchObject({
      installedVerified: false,
      rollback: { rollbackAttempted: true, rollbackVerified: true, failedCandidatePreserved: true }
    });
    await expect(readFile(path.join(release.targetPluginDirectory, "old-plugin.txt"), "utf8")).resolves.toBe("synthetic old plugin\n");
    await expect(verifyPluginPackage(release.failedCandidateDirectory)).resolves.toBeDefined();
  });

  it("preserves both candidates when an injected rollback step fails", async () => {
    const release = await setup("rollback-failure");
    await atomicSwitchDryRun({
      releaseRoot: release.root,
      stageDirectory: release.stageDirectory,
      targetPluginDirectory: release.targetPluginDirectory,
      archiveDirectory: release.archiveDirectory
    });
    await expect(restoreArchivedPluginDryRun({
      releaseRoot: release.root,
      targetPluginDirectory: release.targetPluginDirectory,
      archiveDirectory: release.archiveDirectory,
      failedCandidateDirectory: release.failedCandidateDirectory,
      legacySentinelFiles: [release.legacySentinel],
      verifyRestored: async () => true,
      failAfterQuarantine: true
    })).rejects.toThrow(/Injected rollback failure/u);
    await expect(verifyPluginPackage(release.targetPluginDirectory)).resolves.toBeDefined();
    await expect(readFile(path.join(release.archiveDirectory, "old-plugin.txt"), "utf8")).resolves.toBe("synthetic old plugin\n");
  });

  it("requires a complete exact approval before any future real release", () => {
    const expected = {
      artifactManifestSha256: acceptedArtifactManifestSha256,
      targetIdentity: "a".repeat(64),
      archiveIdentity: "b".repeat(64),
      marketplaceAction: "reinstall-local",
      cachebuster: "release-20260720"
    };
    expect(() => validateReleaseApproval({ releaseAuthorized: true }, expected)).toThrow(/approval/u);
    expect(validateReleaseApproval({
      schemaVersion: 1,
      releaseAuthorized: true,
      ...expected,
      atomicSwitchApproved: true,
      rollbackApproved: true,
      approvedAt: "2026-07-20T10:00:00+08:00"
    }, expected)).toBe(true);
  });

  it("uses the plugin-creator cachebuster and local marketplace reinstall contract", () => {
    expect(normalizeCachebuster("Task.8_1 Dry Run")).toBe("task-8-1-dry-run");
    expect(buildPluginCreatorUpdatePlan({ cachebuster: "release-20260720" })).toEqual({
      schemaVersion: 1,
      helper: "plugin-creator/update_plugin_cachebuster.py",
      helperArguments: ["<plugin-source>", "--cachebuster", "release-20260720"],
      marketplaceNameHelper: "plugin-creator/read_marketplace_name.py",
      reinstallCommand: ["codex", "plugin", "add", "routego-image@<confirmed-local-marketplace>"],
      requiresArtifactRebuildAndReacceptance: true,
      executeAuthorized: false
    });
  });

  it("rejects secret-bearing or unrestricted release evidence", () => {
    expect(() => assertEvidenceSafe({ value: "Authorization: Bearer hidden" })).toThrow(/unsafe/u);
    expect(() => assertEvidenceSafe({ output: "/Users/example/plugin" })).toThrow(/unsafe/u);
    expect(() => assertEvidenceSafe({ sessionToken: "hidden" })).toThrow(/forbidden/u);
  });

  it("refuses to clean an unowned directory", async () => {
    const unowned = path.join(suiteRoot, "unowned");
    await mkdir(unowned, { recursive: true });
    await writeFile(path.join(unowned, "keep.txt"), "keep\n", "utf8");
    await expect(cleanupOwnedReleaseRoot(unowned)).rejects.toThrow(/owned prefix/u);
    await expect(restoreArchivedPluginDryRun({
      releaseRoot: unowned,
      targetPluginDirectory: unowned,
      archiveDirectory: unowned,
      failedCandidateDirectory: unowned,
      verifyRestored: async () => true
    })).rejects.toThrow(/owned prefix/u);
    await expect(readFile(path.join(unowned, "keep.txt"), "utf8")).resolves.toBe("keep\n");
  });
});
