#!/usr/bin/env node

import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPluginPackage } from "./build-plugin-package.mjs";
import { INSTALLED_PACKAGE_ARGUMENT_PREFIX, runPluginInstallSmoke } from "./smoke-plugin-install.mjs";
import { comparePluginPackages, verifyPluginPackage } from "./verify-plugin-package.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  if (process.platform !== "win32") {
    throw new Error("The Windows plugin smoke test must run on Windows.");
  }
  const temporaryRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), "routego-windows-plugin-smoke-"));
  try {
    const firstPackage = path.join(temporaryRoot, "first", "routego-image-windows");
    const secondPackage = path.join(temporaryRoot, "second", "routego-image-windows");
    await buildPluginPackage({ repositoryRoot, outputDirectory: firstPackage, target: "windows" });
    await buildPluginPackage({ repositoryRoot, outputDirectory: secondPackage, target: "windows" });
    const [verification, comparison] = await Promise.all([
      verifyPluginPackage(firstPackage),
      comparePluginPackages(firstPackage, secondPackage)
    ]);
    if (!comparison.equivalent || comparison.differences.length !== 0) {
      throw new Error("Two clean Windows plugin builds are not byte-equivalent.");
    }
    const smoke = await runPluginInstallSmoke({
      packageDirectory: firstPackage,
      acceptedArtifactManifestSha256: verification.artifactManifestFileSha256,
      freshProcessCommand: {
        executable: process.execPath,
        arguments: [`${INSTALLED_PACKAGE_ARGUMENT_PREFIX}scripts/start-routego-image-windows.mjs`]
      },
      temporaryParent: path.join(temporaryRoot, "install-roots")
    });
    if (smoke.artifact.name !== "routego-image-windows" ||
        smoke.artifact.version !== "1.0.0+codex.20260802" ||
        smoke.codex.freshProcess !== true || smoke.mcp.offlineSafe !== true ||
        smoke.cleanup.removedOwnedRoot !== true) {
      throw new Error("The temporary installed Windows package did not satisfy the offline smoke contract.");
    }
    process.stdout.write(`${JSON.stringify({ platform: process.platform, windowsInstallSmoke: true }, null, 2)}\n`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Windows plugin smoke failed."}\n`);
  process.exitCode = 1;
});
