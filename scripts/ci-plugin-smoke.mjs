#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPluginPackage } from "./build-plugin-package.mjs";
import {
  INSTALLED_PACKAGE_ARGUMENT_PREFIX,
  runPluginInstallSmoke
} from "./smoke-plugin-install.mjs";
import { comparePluginPackages, verifyPluginPackage } from "./verify-plugin-package.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_PREFIX = "routego-plugin-ci-smoke-";
const OWNER_MARKER = ".routego-plugin-ci-smoke-owner.json";
const OWNER_PURPOSE = "routego-image-plugin-ci-smoke";
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

function fail(message) {
  throw new Error(`Routego CI plugin smoke failed: ${message}`);
}

function exactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, "en"));
  const expected = [...keys].sort((left, right) => left.localeCompare(right, "en"));
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function assertSupportedNode() {
  const [major = 0, minor = 0] = process.versions.node
    .split(".")
    .slice(0, 2)
    .map((value) => Number.parseInt(value, 10));
  if (major < 20 || (major === 20 && minor < 19)) {
    fail(`Node.js 20.19 or newer is required; received ${process.versions.node}`);
  }
}

async function createOwnedRoot() {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, ROOT_PREFIX));
  const marker = {
    schemaVersion: 1,
    purpose: OWNER_PURPOSE,
    rootName: path.basename(root),
    nonce: randomUUID()
  };
  try {
    await writeFile(path.join(root, OWNER_MARKER), `${JSON.stringify(marker)}\n`, {
      encoding: "utf8",
      flag: "wx"
    });
  } catch (error) {
    await rm(root, { recursive: true, force: false });
    throw error;
  }
  return root;
}

async function cleanupOwnedRoot(root) {
  const requested = path.resolve(root);
  const metadata = await lstat(requested);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() ||
      !path.basename(requested).startsWith(ROOT_PREFIX)) {
    fail("cleanup refused a path that is not an owned plugin smoke temporary root");
  }
  let marker;
  try {
    const markerPath = path.join(requested, OWNER_MARKER);
    const markerMetadata = await lstat(markerPath);
    if (markerMetadata.isSymbolicLink() || !markerMetadata.isFile()) {
      fail("cleanup refused an invalid plugin smoke owner marker");
    }
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Routego CI plugin smoke failed:")) {
      throw error;
    }
    fail("cleanup refused a root without a valid plugin smoke owner marker");
  }
  if (!exactKeys(marker, ["schemaVersion", "purpose", "rootName", "nonce"]) ||
      marker.schemaVersion !== 1 || marker.purpose !== OWNER_PURPOSE ||
      marker.rootName !== path.basename(requested) ||
      typeof marker.nonce !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(marker.nonce)) {
    fail("cleanup refused an invalid plugin smoke owner marker");
  }
  await rm(requested, { recursive: true, force: false });
}

function assertSmokeResult(result, acceptedArtifactManifestSha256) {
  if (result.artifact?.manifestSha256 !== acceptedArtifactManifestSha256 ||
      result.artifact?.name !== "routego-image" ||
      typeof result.artifact?.version !== "string" ||
      !/^1\.0\.2\+codex\.[a-z0-9](?:[a-z0-9-]{0,79})?$/u.test(result.artifact.version) ||
      result.artifact?.strictVerificationPassed !== true ||
      result.codex?.freshProcess !== true || result.codex?.pluginDiscovered !== true ||
      result.codex?.pluginVersion !== "1.0.5" ||
      result.skill?.bilingual !== true || result.skill?.exactPublicToolCount !== 8 ||
      JSON.stringify(result.mcp?.tools) !== JSON.stringify(EXPECTED_TOOLS) ||
      JSON.stringify(result.mcp?.publicArtifactPhases) !== JSON.stringify(["partial", "final"]) ||
      result.mcp?.configured !== false || result.mcp?.serviceStatus !== "ready" ||
      result.mcp?.offlineSafe !== true ||
      result.studio?.bootstrapLoaded !== true || result.studio?.staticAssetsLoaded !== true ||
      result.studio?.statusConfigured !== false || result.studio?.uploadFinalized !== true ||
      result.studio?.uploadResourceReadable !== true || result.studio?.missingResourceRejected !== true ||
      result.studio?.streamTerminalType !== "completed" || result.studio?.sharedLibraryIdentity !== true ||
      result.isolation?.sourceCheckoutIndependent !== true ||
      result.isolation?.nodeModulesIndependent !== true ||
      result.isolation?.legacyStateUntouchedByHarness !== true ||
      result.cleanup?.removedOwnedRoot !== true) {
    fail("the temporary installed package did not satisfy the complete offline smoke contract");
  }
}

async function run() {
  assertSupportedNode();
  const root = await createOwnedRoot();
  let operationError;
  try {
    const firstPackage = path.join(root, "first", "routego-image");
    const secondPackage = path.join(root, "second", "routego-image");
    await buildPluginPackage({
      repositoryRoot: REPOSITORY_ROOT,
      outputDirectory: firstPackage
    });
    await buildPluginPackage({
      repositoryRoot: REPOSITORY_ROOT,
      outputDirectory: secondPackage
    });

    const [firstVerification, comparison] = await Promise.all([
      verifyPluginPackage(firstPackage),
      comparePluginPackages(firstPackage, secondPackage)
    ]);
    if (!comparison.equivalent || comparison.differences.length !== 0) {
      fail("two clean plugin builds are not byte-equivalent");
    }
    const smoke = await runPluginInstallSmoke({
      packageDirectory: firstPackage,
      acceptedArtifactManifestSha256: firstVerification.artifactManifestFileSha256,
      freshProcessCommand: {
        executable: process.execPath,
        arguments: [
          `${INSTALLED_PACKAGE_ARGUMENT_PREFIX}scripts/start-routego-image.mjs`
        ]
      },
      temporaryParent: path.join(root, "install-roots")
    });
    assertSmokeResult(smoke, firstVerification.artifactManifestFileSha256);
    process.stdout.write(`${JSON.stringify({
      node: process.versions.node,
      platform: process.platform,
      artifactManifestSha256: firstVerification.artifactManifestFileSha256,
      reproducible: true,
      temporaryInstallSmoke: true
    }, null, 2)}\n`);
  } catch (error) {
    operationError = error;
  }
  try {
    await cleanupOwnedRoot(root);
  } catch (cleanupError) {
    if (operationError !== undefined) {
      throw new AggregateError([operationError, cleanupError], "CI plugin smoke and cleanup failed");
    }
    throw cleanupError;
  }
  if (operationError !== undefined) throw operationError;
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Routego CI plugin smoke failed."}\n`);
  process.exitCode = 1;
});
