#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildPluginPackage } from "./build-plugin-package.mjs";
import { verifyPluginPackage } from "./verify-plugin-package.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const WINDOWS_PLUGIN_NAME = "routego-image-windows";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function contained(root, candidate) {
  const offset = path.relative(root, candidate);
  return offset !== "" && offset !== ".." && !offset.startsWith(`..${path.sep}`) && !path.isAbsolute(offset);
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function collectRegularFiles(directory, relativeDirectory = "") {
  const output = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const relativeFile = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
    const absoluteFile = path.join(directory, entry.name);
    const stats = await lstat(absoluteFile);
    if (stats.isSymbolicLink()) throw new Error(`Package source contains a symbolic link: ${relativeFile}`);
    if (stats.isDirectory()) output.push(...await collectRegularFiles(absoluteFile, relativeFile));
    else if (stats.isFile()) output.push(relativeFile);
    else throw new Error(`Package source contains a non-regular file: ${relativeFile}`);
  }
  return output;
}

async function copyDirectory(sourceRoot, targetRoot) {
  for (const file of await collectRegularFiles(sourceRoot)) {
    const source = path.join(sourceRoot, ...file.split("/"));
    const target = path.join(targetRoot, ...file.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
}

async function createContentManifest(packageRoot) {
  const files = (await collectRegularFiles(packageRoot))
    .filter((file) => file !== "artifact-manifest.json")
    .sort((left, right) => left.localeCompare(right, "en"));
  const entries = [];
  for (const file of files) {
    const bytes = await readFile(path.join(packageRoot, ...file.split("/")));
    entries.push({ path: file, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  const pluginManifest = JSON.parse(
    await readFile(path.join(packageRoot, ".codex-plugin", "plugin.json"), "utf8")
  );
  return {
    schemaVersion: 1,
    name: WINDOWS_PLUGIN_NAME,
    version: pluginManifest.version,
    node: ">=20.19.0",
    files: entries
  };
}

export async function buildWindowsPluginPackage(options = {}) {
  const repositoryRoot = await realpath(path.resolve(options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT));
  const outputDirectory = path.resolve(
    options.outputDirectory ?? path.join(repositoryRoot, ".routego-plugin-build", WINDOWS_PLUGIN_NAME)
  );
  if (path.basename(outputDirectory) !== WINDOWS_PLUGIN_NAME) {
    throw new Error("The Windows package output directory must be named routego-image-windows.");
  }
  if (outputDirectory === repositoryRoot || contained(outputDirectory, repositoryRoot)) {
    throw new Error("The Windows package output directory cannot contain the source repository.");
  }
  if (contained(repositoryRoot, outputDirectory) &&
      !contained(path.join(repositoryRoot, ".routego-plugin-build"), outputDirectory)) {
    throw new Error("Repository-local Windows package output must stay inside .routego-plugin-build.");
  }
  if (await exists(outputDirectory)) {
    throw new Error("The Windows package output directory already exists; a clean output path is required.");
  }

  const outputParent = path.dirname(outputDirectory);
  await mkdir(outputParent, { recursive: true });
  const workRoot = await mkdtemp(path.join(outputParent, ".routego-windows-package-work-"));
  const macPackageRoot = path.join(workRoot, "routego-image");
  const windowsPackageRoot = path.join(workRoot, WINDOWS_PLUGIN_NAME);
  try {
    await buildPluginPackage({ repositoryRoot, outputDirectory: macPackageRoot });
    await copyDirectory(macPackageRoot, windowsPackageRoot);
    await rm(path.join(windowsPackageRoot, "skills", "routego-image"), { recursive: true, force: true });
    await rm(path.join(windowsPackageRoot, "scripts", "start-routego-image.mjs"), { force: true });
    await copyFile(
      path.join(repositoryRoot, "windows-plugin", "plugin.json"),
      path.join(windowsPackageRoot, ".codex-plugin", "plugin.json")
    );
    const windowsSkill = path.join(windowsPackageRoot, "skills", WINDOWS_PLUGIN_NAME, "SKILL.md");
    await mkdir(path.dirname(windowsSkill), { recursive: true });
    await copyFile(path.join(repositoryRoot, "windows-plugin", "SKILL.md"), windowsSkill);
    const windowsStarter = path.join(windowsPackageRoot, "scripts", "start-routego-image-windows.mjs");
    await copyFile(path.join(repositoryRoot, "windows-plugin", "start-routego-image-windows.mjs"), windowsStarter);
    await chmod(windowsStarter, 0o755);
    await writeFile(
      path.join(windowsPackageRoot, "artifact-manifest.json"),
      stableJson(await createContentManifest(windowsPackageRoot)),
      "utf8"
    );
    const verification = await verifyPluginPackage(windowsPackageRoot);
    await rename(windowsPackageRoot, outputDirectory);
    return { outputDirectory, contentManifest: verification.contentManifest, files: verification.files };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  if (argv.length === 0) return {};
  if (argv.length === 2 && argv[0] === "--output") return { outputDirectory: path.resolve(argv[1]) };
  throw new Error("Usage: node scripts/build-windows-plugin-package.mjs [--output <clean-routego-image-windows-directory>]");
}

async function main() {
  const result = await buildWindowsPluginPackage(parseArguments(process.argv.slice(2)));
  process.stdout.write(stableJson(result));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Windows plugin package build failed."}\n`);
    process.exitCode = 1;
  });
}
