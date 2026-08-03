import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// @ts-expect-error Task-owned Node ESM scripts intentionally ship without declaration artifacts.
import { buildPluginPackage } from "../../../scripts/build-plugin-package.mjs";
// @ts-expect-error Task-owned Node ESM scripts intentionally ship without declaration artifacts.
import { INSTALLED_PACKAGE_ARGUMENT_PREFIX, cleanupOwnedTemporaryRoot, runPluginInstallSmoke } from "../../../scripts/smoke-plugin-install.mjs";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
const EXPECTED_TOOLS = [
  "routego_batch",
  "routego_edit",
  "routego_generate",
  "routego_manage_library",
  "routego_open_studio",
  "routego_prepare_regeneration",
  "routego_search_library",
  "routego_status"
];

async function fingerprint(file: string): Promise<{ sha256: string; mtimeMs: number }> {
  const [bytes, metadata] = await Promise.all([readFile(file), stat(file)]);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mtimeMs: metadata.mtimeMs
  };
}

describe.sequential("task 5.3 isolated plugin install smoke", () => {
  let root: string;
  let packageRoot: string;
  let acceptedArtifactManifestSha256: string;
  let expectedPluginVersion: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "routego-install-smoke-test-"));
    packageRoot = path.join(root, "accepted", "routego-image");
    await buildPluginPackage({
      repositoryRoot: REPOSITORY_ROOT,
      outputDirectory: packageRoot
    });
    const [artifactManifest, pluginManifest] = await Promise.all([
      readFile(path.join(packageRoot, "artifact-manifest.json")),
      readFile(path.join(packageRoot, ".codex-plugin", "plugin.json"), "utf8")
    ]);
    acceptedArtifactManifestSha256 = createHash("sha256").update(artifactManifest).digest("hex");
    expectedPluginVersion = (JSON.parse(pluginManifest) as { version: string }).version;
  }, 120_000);

  afterAll(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it("discovers the accepted package in a fresh isolated Codex process and exercises offline Studio", async () => {
    const legacyHome = path.join(root, "synthetic-legacy-home");
    const legacyCodexHome = path.join(root, "synthetic-legacy-codex-home");
    const legacyHomeSentinel = path.join(legacyHome, "legacy-home.txt");
    const legacyCodexSentinel = path.join(legacyCodexHome, "legacy-codex.txt");
    await Promise.all([
      mkdir(legacyHome, { recursive: true }),
      mkdir(legacyCodexHome, { recursive: true })
    ]);
    await Promise.all([
      writeFile(legacyHomeSentinel, "synthetic legacy home\n", "utf8"),
      writeFile(legacyCodexSentinel, "synthetic legacy Codex home\n", "utf8")
    ]);
    const before = await Promise.all([
      fingerprint(legacyHomeSentinel),
      fingerprint(legacyCodexSentinel)
    ]);
    const previousHome = process.env["HOME"];
    const previousCodexHome = process.env["CODEX_HOME"];
    process.env["HOME"] = legacyHome;
    process.env["CODEX_HOME"] = legacyCodexHome;

    let result;
    try {
      result = await runPluginInstallSmoke({
        packageDirectory: packageRoot,
        acceptedArtifactManifestSha256,
        freshProcessCommand: {
          executable: process.execPath,
          arguments: [
            `${INSTALLED_PACKAGE_ARGUMENT_PREFIX}scripts/start-routego-image.mjs`
          ]
        },
        temporaryParent: path.join(root, "smoke-roots")
      });
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      if (previousCodexHome === undefined) delete process.env["CODEX_HOME"];
      else process.env["CODEX_HOME"] = previousCodexHome;
    }
    const after = await Promise.all([
      fingerprint(legacyHomeSentinel),
      fingerprint(legacyCodexSentinel)
    ]);

    expect(after).toEqual(before);
    expect(result).toMatchObject({
      artifact: {
        manifestSha256: acceptedArtifactManifestSha256,
        name: "routego-image",
        version: expectedPluginVersion,
        strictVerificationPassed: true
      },
      codex: {
        isolatedHome: true,
        isolatedCodexHome: true,
        freshProcess: true,
        pluginDiscovered: true,
        pluginVersion: "1.0.7"
      },
      skill: { bilingual: true, exactPublicToolCount: 8 },
      mcp: {
        tools: EXPECTED_TOOLS,
        publicArtifactPhases: ["partial", "final"],
        configured: false,
        serviceStatus: "ready",
        offlineSafe: true
      },
      studio: {
        bootstrapLoaded: true,
        staticAssetsLoaded: true,
        statusConfigured: false,
        uploadFinalized: true,
        uploadResourceReadable: true,
        missingResourceRejected: true,
        streamTerminalType: "completed",
        sharedLibraryIdentity: true,
        legacyLibraryUpgraded: true
      },
      isolation: {
        sourceCheckoutIndependent: true,
        nodeModulesIndependent: true,
        legacyStateUntouchedByHarness: true
      },
      cleanup: { removedOwnedRoot: true }
    });
  }, 30_000);

  it("rejects a package whose artifact manifest is not the accepted build", async () => {
    await expect(runPluginInstallSmoke({
      packageDirectory: packageRoot,
      acceptedArtifactManifestSha256: "0".repeat(64),
      temporaryParent: path.join(root, "wrong-sha-roots")
    })).rejects.toThrow(/accepted artifact manifest SHA-256/u);
  });

  it("rejects a source or node_modules dependent package before launching Codex", async () => {
    const candidate = path.join(root, "dependent", "routego-image");
    await cp(packageRoot, candidate, { recursive: true });
    await mkdir(path.join(candidate, "node_modules"), { recursive: true });
    await writeFile(path.join(candidate, "node_modules", "dependency.js"), "export {};\n", "utf8");

    await expect(runPluginInstallSmoke({
      packageDirectory: candidate,
      acceptedArtifactManifestSha256,
      temporaryParent: path.join(root, "dependent-roots")
    })).rejects.toThrow(/allowlisted|forbidden/u);
  });

  it("removes its owned temporary root when the Codex child fails", async () => {
    const parent = path.join(root, "failed-child-roots");
    await mkdir(parent, { recursive: true });

    await expect(runPluginInstallSmoke({
      packageDirectory: packageRoot,
      acceptedArtifactManifestSha256,
      codexExecutable: process.execPath,
      temporaryParent: parent
    })).rejects.toThrow(/Codex app-server/u);
    expect(await readdir(parent)).toEqual([]);
  });

  it("refuses to clean a directory that was not created by this smoke", async () => {
    const unrelated = path.join(root, "unrelated-data");
    await mkdir(unrelated, { recursive: true });
    await writeFile(path.join(unrelated, "keep.txt"), "must remain\n", "utf8");

    await expect(cleanupOwnedTemporaryRoot(unrelated)).rejects.toThrow(/owned temporary root/u);
    await expect(readFile(path.join(unrelated, "keep.txt"), "utf8")).resolves.toBe("must remain\n");
  });
});
