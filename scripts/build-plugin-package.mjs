#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
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
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { verifyPluginPackage } from "./verify-plugin-package.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const PACKAGE_TARGETS = Object.freeze({
  mac: {
    packageName: "routego-image",
    manifestSource: ".codex-plugin/plugin.json",
    skillSource: "skills/routego-image/SKILL.md",
    skillTarget: "skills/routego-image/SKILL.md",
    launcherSource: "scripts/start-routego-image.mjs",
    launcherTarget: "scripts/start-routego-image.mjs"
  },
  windows: {
    packageName: "routego-image-windows",
    manifestSource: ".codex-plugin-windows/plugin.json",
    skillSource: "skills/routego-image-windows/SKILL.md",
    skillTarget: "skills/routego-image-windows/SKILL.md",
    launcherSource: "scripts/start-routego-image-windows.mjs",
    launcherTarget: "scripts/start-routego-image-windows.mjs"
  }
});
const STATIC_SOURCE_FILES = [
  ["assets/composer-icon.png", "assets/composer-icon.png"],
  ["assets/logo.png", "assets/logo.png"],
  ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
  ["licenses/gpt_image_playground-MIT.txt", "licenses/gpt_image_playground-MIT.txt"],
  ["licenses/pngjs-MIT.txt", "licenses/pngjs-MIT.txt"],
  ["licenses/u2netp-Apache-2.0.txt", "licenses/u2netp-Apache-2.0.txt"],
  ["licenses/onnxruntime-web-MIT.txt", "licenses/onnxruntime-web-MIT.txt"]
];
const ALLOWED_STUDIO_EXTENSIONS = new Set([
  ".css", ".gif", ".ico", ".jpeg", ".jpg", ".js", ".json", ".png",
  ".svg", ".ttf", ".webp", ".woff", ".woff2"
]);

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

function childEnvironment() {
  const names = [
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "ComSpec", "PATHEXT",
    "APPDATA", "LOCALAPPDATA", "USERPROFILE"
  ];
  const environment = { CI: "1", NODE_ENV: "production", NO_COLOR: "1" };
  for (const name of names) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

async function run(command, args, cwd, extraEnvironment = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...childEnvironment(), ...extraEnvironment },
      // Windows command shims such as pnpm.cmd cannot be spawned directly
      // without cmd.exe; POSIX binaries must stay shell-free.
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        `Package build command failed (${command} ${args.join(" ")}; code=${String(code)}; signal=${String(signal)}):\n${stderr || stdout}`
      ));
    });
  });
}

async function copyContainedSource(repositoryRoot, sourceRelative, targetRoot, targetRelative) {
  const requested = path.resolve(repositoryRoot, ...sourceRelative.split("/"));
  const resolved = await realpath(requested);
  if (!contained(repositoryRoot, resolved)) throw new Error(`Source path escapes the repository: ${sourceRelative}`);
  const sourceStats = await stat(resolved);
  if (!sourceStats.isFile()) throw new Error(`Source path is not a regular file: ${sourceRelative}`);
  const target = path.join(targetRoot, ...targetRelative.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(resolved, target);
}

function packageTarget(name) {
  const target = PACKAGE_TARGETS[name];
  if (target === undefined) throw new Error(`Unknown plugin package target: ${name}`);
  return target;
}

async function copyPluginSkill(repositoryRoot, packageRoot, target) {
  const source = path.join(repositoryRoot, ...target.skillSource.split("/"));
  const destination = path.join(packageRoot, ...target.skillTarget.split("/"));
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function collectRegularFiles(directory, relativeDirectory = "") {
  const output = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const relativeFile = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
    const absoluteFile = path.join(directory, entry.name);
    const stats = await lstat(absoluteFile);
    if (stats.isSymbolicLink()) throw new Error(`Generated output contains a symbolic link: ${relativeFile}`);
    if (stats.isDirectory()) output.push(...await collectRegularFiles(absoluteFile, relativeFile));
    else if (stats.isFile()) output.push(relativeFile);
    else throw new Error(`Generated output contains a non-regular file: ${relativeFile}`);
  }
  return output;
}

async function copyContainedDirectory(repositoryRoot, sourceRelative, targetRoot, targetRelative) {
  const requested = path.resolve(repositoryRoot, ...sourceRelative.split("/"));
  const sourceRoot = await realpath(requested);
  if (!contained(repositoryRoot, sourceRoot)) throw new Error(`Source path escapes the repository: ${sourceRelative}`);
  const sourceStats = await stat(sourceRoot);
  if (!sourceStats.isDirectory()) throw new Error(`Source path is not a directory: ${sourceRelative}`);
  for (const file of await collectRegularFiles(sourceRoot)) {
    await copyContainedSource(repositoryRoot, `${sourceRelative}/${file}`, targetRoot, `${targetRelative}/${file}`);
  }
}

async function auditRuntimeDependencies(repositoryRoot) {
  const integrationPackageFile = path.join(repositoryRoot, "packages/integration/package.json");
  const requireFromIntegration = createRequire(integrationPackageFile);
  const integrationPackage = JSON.parse(
    await readFile(integrationPackageFile, "utf8")
  );
  if (integrationPackage?.dependencies?.pngjs !== "7.0.0") {
    throw new Error("The Integration runtime must pin pngjs exactly to 7.0.0.");
  }
  if (integrationPackage?.dependencies?.["onnxruntime-web"] !== "1.20.1") {
    throw new Error("The Integration runtime must pin onnxruntime-web exactly to 1.20.1.");
  }
  const packageFile = requireFromIntegration.resolve("pngjs/package.json");
  const dependencyRoot = path.dirname(packageFile);
  const dependencyPackage = JSON.parse(await readFile(packageFile, "utf8"));
  if (dependencyPackage.name !== "pngjs" || dependencyPackage.version !== "7.0.0" ||
      dependencyPackage.license !== "MIT") {
    throw new Error("The installed pngjs dependency does not match the pinned MIT provenance.");
  }
  for (const script of ["preinstall", "install", "postinstall"]) {
    if (dependencyPackage.scripts?.[script] !== undefined) {
      throw new Error(`The pngjs dependency declares a forbidden ${script} script.`);
    }
  }
  const dependencyFiles = await collectRegularFiles(dependencyRoot);
  if (dependencyFiles.some((file) => file.endsWith(".node") || file.endsWith("binding.gyp"))) {
    throw new Error("The pngjs dependency contains a native addon or binding definition.");
  }
  const [installedLicense, pinnedLicense] = await Promise.all([
    readFile(path.join(dependencyRoot, "LICENSE")),
    readFile(path.join(repositoryRoot, "licenses/pngjs-MIT.txt"))
  ]);
  if (sha256(installedLicense) !== sha256(pinnedLicense)) {
    throw new Error("The pinned pngjs MIT license does not match the installed dependency.");
  }

  const onnxruntimePackageFile = requireFromIntegration.resolve("onnxruntime-web");
  const onnxruntimeRoot = path.resolve(path.dirname(onnxruntimePackageFile), "..");
  const onnxruntimePackage = JSON.parse(await readFile(path.join(onnxruntimeRoot, "package.json"), "utf8"));
  if (onnxruntimePackage.name !== "onnxruntime-web" || onnxruntimePackage.version !== "1.20.1" ||
      onnxruntimePackage.license !== "MIT") {
    throw new Error("The installed onnxruntime-web dependency does not match the pinned MIT provenance.");
  }
  for (const script of ["preinstall", "install", "postinstall"]) {
    if (onnxruntimePackage.scripts?.[script] !== undefined) {
      throw new Error(`The onnxruntime-web dependency declares a forbidden ${script} script.`);
    }
  }
  const onnxruntimeFiles = await collectRegularFiles(onnxruntimeRoot);
  if (onnxruntimeFiles.some((file) => file.endsWith(".node") || file.endsWith("binding.gyp"))) {
    throw new Error("The onnxruntime-web dependency contains a native addon or binding definition.");
  }
  // onnxruntime-web's published npm archive omits a LICENSE file. The pinned
  // MIT text is distributed with this plugin and its hash is checked again by
  // the package verifier below.

  const contractsPackageFile = path.join(repositoryRoot, "packages/contracts/package.json");
  const requireFromContracts = createRequire(contractsPackageFile);
  const contractsPackage = JSON.parse(await readFile(contractsPackageFile, "utf8"));
  if (contractsPackage?.dependencies?.zod !== "catalog:") {
    throw new Error("The contracts package must use the workspace-pinned zod catalog dependency.");
  }
  const zodPackageFile = requireFromContracts.resolve("zod/package.json");
  const zodRoot = path.dirname(zodPackageFile);
  const zodPackage = JSON.parse(await readFile(zodPackageFile, "utf8"));
  if (zodPackage.name !== "zod" || zodPackage.version !== "4.4.3" || zodPackage.license !== "MIT") {
    throw new Error("The installed zod dependency does not match the pinned MIT provenance.");
  }
  for (const script of ["preinstall", "install", "postinstall"]) {
    if (zodPackage.scripts?.[script] !== undefined) {
      throw new Error(`The zod dependency declares a forbidden ${script} script.`);
    }
  }
  const zodFiles = await collectRegularFiles(zodRoot);
  if (zodFiles.some((file) => file.endsWith(".node") || file.endsWith("binding.gyp"))) {
    throw new Error("The zod dependency contains a native addon or binding definition.");
  }
  const [zodLicense, notices] = await Promise.all([
    readFile(path.join(zodRoot, "LICENSE"), "utf8"),
    readFile(path.join(repositoryRoot, "THIRD_PARTY_NOTICES.md"), "utf8")
  ]);
  const quotedZodLicense = zodLicense.trim().split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
  if (!notices.includes(quotedZodLicense)) {
    throw new Error("THIRD_PARTY_NOTICES.md does not contain the complete installed zod MIT license.");
  }
}

async function createContentManifest(packageRoot, target) {
  const files = (await collectRegularFiles(packageRoot))
    .filter((file) => file !== "artifact-manifest.json")
    .sort((left, right) => left.localeCompare(right, "en"));
  const entries = [];
  for (const file of files) {
    const bytes = await readFile(path.join(packageRoot, ...file.split("/")));
    entries.push({ path: file, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  const pluginManifest = JSON.parse(
    await readFile(path.join(packageRoot, ".codex-plugin/plugin.json"), "utf8")
  );
  if (typeof pluginManifest?.version !== "string" || pluginManifest.version.length === 0) {
    throw new Error("The Codex plugin manifest must contain a non-empty version.");
  }
  return {
    schemaVersion: 1,
    name: target.packageName,
    version: pluginManifest.version,
    node: ">=20.19.0",
    files: entries
  };
}

function parseViteManifest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Vite emitted an invalid asset manifest.");
  }
  const entries = Object.values(value);
  const entryCandidates = entries.filter(
    (candidate) => candidate?.isEntry === true && candidate?.file?.endsWith(".js")
  );
  const entry = entryCandidates[0];
  if (entryCandidates.length !== 1 || entry === undefined || typeof entry.file !== "string") {
    throw new Error("Vite did not emit one Studio entry module.");
  }
  const css = entry.css ?? [];
  if (!Array.isArray(css) || !css.every((file) => typeof file === "string" && file.endsWith(".css"))) {
    throw new Error("Vite emitted an invalid Studio stylesheet list.");
  }
  return { entryFile: entry.file, styleFiles: [...css].sort((a, b) => a.localeCompare(b, "en")) };
}

export async function buildPluginPackage(options = {}) {
  const repositoryRoot = await realpath(path.resolve(options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT));
  const target = packageTarget(options.target ?? "mac");
  const outputDirectory = path.resolve(
    options.outputDirectory ?? path.join(repositoryRoot, ".routego-plugin-build", target.packageName)
  );
  if (path.basename(outputDirectory) !== target.packageName) {
    throw new Error(`The package output directory must be named ${target.packageName}.`);
  }
  if (outputDirectory === repositoryRoot || contained(outputDirectory, repositoryRoot)) {
    throw new Error("The package output directory cannot contain the source repository.");
  }
  if (contained(repositoryRoot, outputDirectory) &&
      !contained(path.join(repositoryRoot, ".routego-plugin-build"), outputDirectory)) {
    throw new Error("Repository-local package output must stay inside .routego-plugin-build.");
  }
  if (await exists(outputDirectory)) {
    throw new Error("The package output directory already exists; a clean output path is required.");
  }

  const outputParent = path.dirname(outputDirectory);
  await mkdir(outputParent, { recursive: true });
  const workRoot = await mkdtemp(path.join(outputParent, ".routego-plugin-package-work-"));
  const packageRoot = path.join(workRoot, target.packageName);
  const integrationBuild = path.join(workRoot, "integration-build");
  const studioBuild = path.join(workRoot, "studio-build");
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

  try {
    await auditRuntimeDependencies(repositoryRoot);
    await Promise.all([
      run(
        pnpm,
        ["exec", "tsup", "--out-dir", integrationBuild],
        path.join(repositoryRoot, "packages/integration"),
        { ROUTEGO_PLUGIN_BUNDLE: "1", ROUTEGO_PACKAGE_TARGET: target.packageName }
      ),
      run(
        pnpm,
        ["exec", "vite", "build", "--manifest", "--outDir", studioBuild, "--emptyOutDir"],
        path.join(repositoryRoot, "packages/studio")
      )
    ]);

    await mkdir(packageRoot, { recursive: true });
    for (const [source, target] of STATIC_SOURCE_FILES) {
      await copyContainedSource(repositoryRoot, source, packageRoot, target);
    }
    await copyContainedSource(repositoryRoot, target.manifestSource, packageRoot, ".codex-plugin/plugin.json");
    await copyContainedSource(repositoryRoot, target.launcherSource, packageRoot, target.launcherTarget);
    await copyPluginSkill(repositoryRoot, packageRoot, target);
    await chmod(path.join(packageRoot, ...target.launcherTarget.split("/")), 0o755);

    const runtimeSource = path.join(integrationBuild, "index.js");
    if (!(await exists(runtimeSource))) throw new Error("The bundled Integration runtime was not generated.");
    await mkdir(path.join(packageRoot, "runtime"), { recursive: true });
    await copyFile(runtimeSource, path.join(packageRoot, "runtime/index.js"));
    await copyContainedSource(
      repositoryRoot,
      "packages/integration/src/runtime/resource-manifest.json",
      packageRoot,
      "runtime/resource-manifest.json"
    );
    await copyContainedDirectory(
      repositoryRoot,
      "packages/integration/resources/background-removal",
      packageRoot,
      "resources/background-removal"
    );

    const viteManifest = parseViteManifest(
      JSON.parse(await readFile(path.join(studioBuild, ".vite/manifest.json"), "utf8"))
    );
    const generatedStudioFiles = (await collectRegularFiles(path.join(studioBuild, "assets")))
      .map((file) => `assets/${file}`)
      .sort((left, right) => left.localeCompare(right, "en"));
    const assets = {};
    for (const relativeFile of generatedStudioFiles) {
      const extension = path.posix.extname(relativeFile).toLowerCase();
      if (!ALLOWED_STUDIO_EXTENSIONS.has(extension) || !/-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/u.test(relativeFile)) {
        throw new Error(`Vite emitted a non-hashed or unsupported Studio asset: ${relativeFile}`);
      }
      const target = path.join(packageRoot, "runtime/studio", ...relativeFile.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(studioBuild, ...relativeFile.split("/")), target);
      assets[`/${relativeFile}`] = relativeFile;
    }
    if (!Object.hasOwn(assets, `/${viteManifest.entryFile}`)) {
      throw new Error("The Vite entry module is missing from the generated asset set.");
    }
    for (const styleFile of viteManifest.styleFiles) {
      if (!Object.hasOwn(assets, `/${styleFile}`)) {
        throw new Error("A Vite entry stylesheet is missing from the generated asset set.");
      }
    }
    const studioManifest = {
      schemaVersion: 1,
      rootDirectory: "runtime/studio",
      entryModuleRoute: `/${viteManifest.entryFile}`,
      styleRoutes: viteManifest.styleFiles.map((file) => `/${file}`),
      assets
    };
    await writeFile(path.join(packageRoot, "runtime/studio-assets.json"), stableJson(studioManifest), "utf8");

    const contentManifest = await createContentManifest(packageRoot, target);
    await writeFile(path.join(packageRoot, "artifact-manifest.json"), stableJson(contentManifest), "utf8");
    const verification = await verifyPluginPackage(packageRoot);
    await rename(packageRoot, outputDirectory);
    return { outputDirectory, contentManifest: verification.contentManifest, files: verification.files };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if ((argument === "--target" || argument === "--output") && value !== undefined) {
      parsed[argument === "--target" ? "target" : "outputDirectory"] =
        argument === "--target" ? value : path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error("Usage: node scripts/build-plugin-package.mjs [--target mac|windows] [--output <clean-plugin-directory>]");
  }
  return parsed;
}

async function main() {
  const result = await buildPluginPackage(parseArguments(process.argv.slice(2)));
  process.stdout.write(stableJson(result));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Plugin package build failed."}\n`);
    process.exitCode = 1;
  });
}
