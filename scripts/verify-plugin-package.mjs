#!/usr/bin/env node

import { builtinModules } from "node:module";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ARTIFACT_MANIFEST = "artifact-manifest.json";
const MAXIMUM_FILES = 512;
const MAXIMUM_FILE_BYTES = 24 * 1_024 * 1_024;
const MAXIMUM_TOTAL_BYTES = 64 * 1_024 * 1_024;
const PNGJS_LICENSE_SHA256 = "be75ef59c5cf59715588a17a82dff7dd3e83c4dba3c458676bb9311e05fbedc5";
const U2NETP_LICENSE_SHA256 = "44ad51c5f588276b85d65f599087034c3a3c957f67cb8f7de92bb9b58cad9bb3";
const ONNXRUNTIME_WEB_LICENSE_SHA256 = "7df20dcdf9197e9945c14858d41c60f11b52b93e5b69e2b63416b874d598d322";
const BACKGROUND_REMOVAL_RESOURCES = new Map([
  ["u2netp-model", { path: "u2netp.onnx", bytes: 4574861, sha256: "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8", version: "u2netp", license: "Apache-2.0", source: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx" }],
  ["onnxruntime-web-simd-threaded-jsep", { path: "ort-wasm-simd-threaded.jsep.wasm", bytes: 21663894, sha256: "185b0861a6cd6cbdfb057289338090436483cc59e10a7bc83bd167b15531a51b", version: "1.20.1", license: "MIT", source: "https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.20.1.tgz" }],
  ["onnxruntime-web-simd-threaded", { path: "ort-wasm-simd-threaded.wasm", bytes: 11246032, sha256: "207d02be4591c156b0a98f024f3d58005b5b04c92274d759fb390338c63559ea", version: "1.20.1", license: "MIT", source: "https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.20.1.tgz" }]
]);
const MINIMUM_RAW_BASE64_PAYLOAD_CHARS = 96;
const ACCEPTED_PLUGIN_VERSION = /^1\.0\.0(?:\+codex\.[a-z0-9](?:[a-z0-9-]{0,79})?)?$/u;
const ACCEPTED_PLUGIN_MANIFEST = {
  name: "routego-image",
  description: "Create, edit, organize, and review images with the local Routego Image runtime.",
  author: {
    name: "Routego Image"
  },
  skills: "./skills/",
  mcpServers: {
    "routego-image": {
      command: "node",
      args: ["./scripts/start-routego-image.mjs"],
      cwd: "."
    }
  },
  interface: {
    displayName: "Routego Image",
    shortDescription: "本地图片生成、编辑、图库与 Studio 工作流。\nLocal image creation, editing, Library, and Studio workflows.",
    longDescription: "生成和编辑图片、运行独立批次、管理图库并继续在本地 Studio 工作。\nGenerate and edit images, run independent batches, manage the Library, and continue in the local Studio.",
    developerName: "Routego Image",
    category: "Productivity",
    capabilities: ["Interactive", "Write"],
    defaultPrompt: [
      "配置 Routego Image\nConfigure Routego Image",
      "生成或编辑一张图片\nGenerate or edit an image",
      "打开 Routego Image Studio\nOpen Routego Image Studio"
    ],
    composerIcon: "./assets/composer-icon.png",
    logo: "./assets/logo.png"
  }
};
const EXACT_FILES = new Set([
  ".codex-plugin/plugin.json",
  "assets/composer-icon.png",
  "assets/logo.png",
  "skills/routego-image/SKILL.md",
  "scripts/start-routego-image.mjs",
  "runtime/index.js",
  "runtime/resource-manifest.json",
  "runtime/studio-assets.json",
  "THIRD_PARTY_NOTICES.md",
  "licenses/gpt_image_playground-MIT.txt",
  "licenses/pngjs-MIT.txt",
  "licenses/u2netp-Apache-2.0.txt",
  "licenses/onnxruntime-web-MIT.txt",
  ARTIFACT_MANIFEST
]);
const FORBIDDEN_SEGMENTS = new Set([
  "node_modules",
  "src",
  "source",
  "coverage",
  "reports",
  "test-results",
  "playwright-report",
  "library",
  "outputs",
  ".cache",
  ".git"
]);
const ALLOWED_STUDIO_EXTENSIONS = new Set([
  ".css", ".gif", ".ico", ".jpeg", ".jpg", ".js", ".json", ".png",
  ".svg", ".ttf", ".webp", ".woff", ".woff2"
]);
const BUILTINS = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/u, "")])
);

function fail(message) {
  throw new Error(`Plugin package verification failed: ${message}`);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || path.posix.isAbsolute(value) || value.includes("\\")) {
    return false;
  }
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function boundedRead(file) {
  const bytes = await readFile(file);
  if (bytes.byteLength > MAXIMUM_FILE_BYTES) fail("a file exceeds the size limit");
  return bytes;
}

async function collectFiles(root) {
  const files = [];
  let totalBytes = 0;
  async function visit(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (!safeRelativePath(relativePath)) fail("an unsafe relative path was found");
      const absolutePath = path.join(directory, entry.name);
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) fail(`a symbolic link is forbidden: ${relativePath}`);
      if (stats.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!stats.isFile()) fail(`a non-regular file is forbidden: ${relativePath}`);
      if (stats.size > MAXIMUM_FILE_BYTES) fail(`a file exceeds the size limit: ${relativePath}`);
      totalBytes += stats.size;
      if (totalBytes > MAXIMUM_TOTAL_BYTES) fail("the package exceeds the total size limit");
      files.push(relativePath);
      if (files.length > MAXIMUM_FILES) fail("the package contains too many files");
    }
  }
  await visit(root);
  return files;
}

async function readJson(root, relativePath) {
  let value;
  try {
    value = JSON.parse((await boundedRead(path.join(root, ...relativePath.split("/")))).toString("utf8"));
  } catch (error) {
    fail(`${relativePath} is not valid UTF-8 JSON (${error instanceof Error ? error.message : "unknown error"})`);
  }
  return value;
}

function validateContentManifest(value, expectedVersion) {
  if (!plainObject(value) || value.schemaVersion !== 1 || value.name !== "routego-image" ||
      value.version !== expectedVersion || value.node !== ">=20.19.0" || !Array.isArray(value.files)) {
    fail("artifact-manifest.json has an invalid shape");
  }
  const entries = [];
  const seen = new Set();
  for (const entry of value.files) {
    if (!plainObject(entry) || !safeRelativePath(entry.path) || entry.path === ARTIFACT_MANIFEST ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
        typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
      fail("artifact-manifest.json contains an invalid file entry");
    }
    if (seen.has(entry.path)) fail("artifact-manifest.json contains a duplicate path");
    seen.add(entry.path);
    entries.push({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 });
  }
  const sorted = [...entries].sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (JSON.stringify(entries) !== JSON.stringify(sorted)) {
    fail("artifact-manifest.json file entries are not sorted");
  }
  return { schemaVersion: 1, name: value.name, version: value.version, node: value.node, files: entries };
}

function validatePluginManifest(value) {
  const version = plainObject(value) ? value.version : undefined;
  if (typeof version !== "string" || !ACCEPTED_PLUGIN_VERSION.test(version) ||
      !isDeepStrictEqual(value, { ...ACCEPTED_PLUGIN_MANIFEST, version })) {
    fail("the Codex plugin manifest does not exactly match the accepted canonical manifest");
  }
  return version;
}

function validateStudioManifest(value, fileSet) {
  if (!plainObject(value) || value.schemaVersion !== 1 || value.rootDirectory !== "runtime/studio" ||
      typeof value.entryModuleRoute !== "string" || !Array.isArray(value.styleRoutes) ||
      !value.styleRoutes.every((route) => typeof route === "string") || !plainObject(value.assets)) {
    fail("runtime/studio-assets.json has an invalid shape");
  }
  const assetEntries = Object.entries(value.assets);
  if (assetEntries.length === 0) fail("the Studio asset allowlist is empty");
  const routes = assetEntries.map(([route]) => route);
  if (JSON.stringify(routes) !== JSON.stringify([...routes].sort((a, b) => a.localeCompare(b, "en")))) {
    fail("Studio asset routes are not sorted");
  }
  const allowlistedFiles = new Set();
  for (const [route, relativeFile] of assetEntries) {
    if (route !== `/${relativeFile}` || !route.startsWith("/assets/") || !safeRelativePath(relativeFile)) {
      fail("a Studio route is not contained in the static asset root");
    }
    const extension = path.posix.extname(relativeFile).toLowerCase();
    if (!ALLOWED_STUDIO_EXTENSIONS.has(extension) || !/-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/u.test(relativeFile)) {
      fail("a Studio asset does not use an allowlisted hashed filename");
    }
    const packagedPath = `runtime/studio/${relativeFile}`;
    if (!fileSet.has(packagedPath)) fail("a Studio manifest file is missing from the package");
    allowlistedFiles.add(packagedPath);
  }
  if (!Object.hasOwn(value.assets, value.entryModuleRoute) || !value.entryModuleRoute.endsWith(".js")) {
    fail("the Studio entry module is not allowlisted");
  }
  for (const styleRoute of value.styleRoutes) {
    if (!Object.hasOwn(value.assets, styleRoute) || !styleRoute.endsWith(".css")) {
      fail("a Studio stylesheet route is not allowlisted");
    }
  }
  for (const file of fileSet) {
    if (file.startsWith("runtime/studio/") && !allowlistedFiles.has(file)) {
      fail(`a Studio file is not allowlisted: ${file}`);
    }
  }
}

function validateAllowlist(files) {
  for (const file of files) {
    const segments = file.toLowerCase().split("/");
    if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment)) ||
        file.endsWith(".map") || file.endsWith(".node") || file.endsWith(".ts") ||
        file.endsWith(".tsx") || file.endsWith(".env") || file.includes("binding.gyp")) {
      fail(`a forbidden path is present: ${file}`);
    }
    if (!EXACT_FILES.has(file) && !file.startsWith("runtime/studio/assets/") &&
        !file.startsWith("resources/background-removal/")) {
      fail(`a file is not allowlisted: ${file}`);
    }
  }
}

function validateBackgroundRemovalResources(manifest, fileSet) {
  if (!plainObject(manifest) || manifest.schemaVersion !== 1 || manifest.offlineOnly !== true ||
      !Array.isArray(manifest.resources) || manifest.resources.length !== BACKGROUND_REMOVAL_RESOURCES.size ||
      !Array.isArray(manifest.licenses) ||
      JSON.stringify(manifest.licenses) !== JSON.stringify(["licenses/u2netp-Apache-2.0.txt", "licenses/onnxruntime-web-MIT.txt"])) {
    fail("the background-removal resource manifest has an invalid shape");
  }
  const expectedPaths = new Set();
  const seenIds = new Set();
  for (const resource of manifest.resources) {
    if (!plainObject(resource) || typeof resource.id !== "string" || typeof resource.path !== "string" ||
        !Number.isSafeInteger(resource.bytes) || typeof resource.sha256 !== "string") {
      fail("the background-removal resource manifest contains an invalid resource");
    }
    const expected = BACKGROUND_REMOVAL_RESOURCES.get(resource.id);
    if (expected === undefined || seenIds.has(resource.id) || resource.path !== expected.path ||
        resource.bytes !== expected.bytes || resource.sha256 !== expected.sha256 ||
        resource.version !== expected.version || resource.license !== expected.license || resource.source !== expected.source) {
      fail("the background-removal resource manifest does not match the approved resources");
    }
    seenIds.add(resource.id);
    const packagedPath = `resources/background-removal/${resource.path}`;
    if (!fileSet.has(packagedPath)) fail(`a required background-removal resource is missing: ${resource.path}`);
    expectedPaths.add(packagedPath);
  }
  if (seenIds.size !== BACKGROUND_REMOVAL_RESOURCES.size) {
    fail("the background-removal resource manifest omits an approved resource");
  }
  for (const file of fileSet) {
    if (file.startsWith("resources/background-removal/") && !expectedPaths.has(file)) {
      fail(`an unapproved background-removal resource is present: ${file}`);
    }
  }
}

function validateRuntimeImports(runtimeText) {
  const specifiers = [];
  const patterns = [
    /\bimport\s+(?:[^"'`;]+?\s+from\s*)?["']([^"']+)["']/gu,
    /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s*["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*(?:,\s*[\s\S]*?)?\)/gu,
    /\b(?:require|__require)\s*\(\s*["']([^"']+)["']\s*\)/gu
  ];
  for (const pattern of patterns) {
    for (const match of runtimeText.matchAll(pattern)) specifiers.push(match[1]);
  }
  for (const specifier of specifiers) {
    const normalized = specifier.replace(/^node:/u, "").split("/")[0];
    if (specifier.startsWith("./") || specifier.startsWith("../") || BUILTINS.has(specifier) || BUILTINS.has(normalized)) {
      continue;
    }
    fail(`the runtime has an unresolved external import: ${specifier}`);
  }
}

function validateTextSecurity(relativePath, text, packageRoot) {
  const forbiddenRoots = [packageRoot, process.cwd()].map((root) => root.replaceAll("\\", "/"));
  const normalizedText = text.replaceAll("\\", "/");
  const textWithoutHttpUrls = normalizedText.replace(/https?:\/\/[^\s<>"'`]+/giu, "");
  if (forbiddenRoots.some((root) => root.length > 1 && textWithoutHttpUrls.includes(root)) ||
      /file:\/\/\/(?:Users|home|private\/var\/folders|var\/folders|tmp)\//u.test(textWithoutHttpUrls) ||
      /\/(?:Users|home)\/[A-Za-z0-9._-]+\//u.test(textWithoutHttpUrls) ||
      /\/(?:private\/var\/folders|var\/folders|tmp)\//u.test(textWithoutHttpUrls) ||
      /[A-Za-z]:\/{1,2}(?!\/)[^\s<>"'`]+/u.test(textWithoutHttpUrls)) {
    fail(`a source checkout or local user path is embedded in ${relativePath}`);
  }
  const imageDataUrlPattern = /data:image\/[a-z0-9][a-z0-9.+-]*(?:;[^,\\\s"'`]*)*,(?!\$\{)(?=[^\s"'`])/iu;
  const rawBase64Pattern = new RegExp(
    `(?:^|[^A-Za-z0-9+/])([A-Za-z0-9+/]{${MINIMUM_RAW_BASE64_PAYLOAD_CHARS},}={0,2})(?![A-Za-z0-9+/=])`,
    "mu"
  );
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(text) ||
      /\bsk-[A-Za-z0-9_-]{20,}\b/u.test(text) ||
      /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/u.test(text) ||
      imageDataUrlPattern.test(text) || rawBase64Pattern.test(text)) {
    fail(`a credential or image payload is embedded in ${relativePath}`);
  }
}

export async function verifyPluginPackage(packageDirectory) {
  const requestedRoot = path.resolve(packageDirectory);
  const requestedRootStats = await lstat(requestedRoot);
  if (requestedRootStats.isSymbolicLink()) {
    fail("the package root must not be a symbolic link");
  }
  if (!requestedRootStats.isDirectory() || path.basename(requestedRoot) !== "routego-image") {
    fail("the package root must be a real directory named routego-image");
  }
  const root = await realpath(requestedRoot);
  const files = await collectFiles(root);
  validateAllowlist(files);
  const fileSet = new Set(files);
  for (const required of EXACT_FILES) {
    if (!fileSet.has(required)) fail(`a required file is missing: ${required}`);
  }

  const pluginVersion = validatePluginManifest(await readJson(root, ".codex-plugin/plugin.json"));
  const artifactManifestBytes = await boundedRead(path.join(root, ARTIFACT_MANIFEST));
  let artifactManifestValue;
  try {
    artifactManifestValue = JSON.parse(artifactManifestBytes.toString("utf8"));
  } catch {
    fail("artifact-manifest.json is not valid UTF-8 JSON");
  }
  const contentManifest = validateContentManifest(artifactManifestValue, pluginVersion);
  const expected = [...files]
    .filter((file) => file !== ARTIFACT_MANIFEST)
    .sort((left, right) => left.localeCompare(right, "en"));
  const declared = contentManifest.files.map((entry) => entry.path);
  if (JSON.stringify(expected) !== JSON.stringify(declared)) {
    fail("the package file set is not exactly represented by the content manifest");
  }
  for (const entry of contentManifest.files) {
    const bytes = await boundedRead(path.join(root, ...entry.path.split("/")));
    if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) {
      fail(`a content hash or byte count does not match: ${entry.path}`);
    }
  }

  validateStudioManifest(await readJson(root, "runtime/studio-assets.json"), fileSet);
  validateBackgroundRemovalResources(await readJson(root, "runtime/resource-manifest.json"), fileSet);
  const runtimeText = (await boundedRead(path.join(root, "runtime/index.js"))).toString("utf8");
  validateRuntimeImports(runtimeText);

  const textFiles = files.filter((file) => /\.(?:css|js|json|md|mjs|txt)$/u.test(file));
  for (const file of textFiles) {
    const text = (await boundedRead(path.join(root, ...file.split("/")))).toString("utf8");
    validateTextSecurity(file, text, root);
  }
  const notices = (await boundedRead(path.join(root, "THIRD_PARTY_NOTICES.md"))).toString("utf8");
  if (!notices.includes("gpt_image_playground") || !notices.includes("pngjs 7.0.0") ||
      !notices.includes("licenses/pngjs-MIT.txt") || !notices.includes("zod 4.4.3") ||
      !notices.includes("Copyright (c) 2025 Colin McDonnell") ||
      !notices.includes("THE SOFTWARE IS PROVIDED \"AS IS\"")) {
    fail("third-party notices are incomplete");
  }
  const pngjsLicense = await boundedRead(path.join(root, "licenses/pngjs-MIT.txt"));
  if (sha256(pngjsLicense) !== PNGJS_LICENSE_SHA256) fail("the pinned pngjs MIT license differs");
  const u2netpLicense = await boundedRead(path.join(root, "licenses/u2netp-Apache-2.0.txt"));
  if (sha256(u2netpLicense) !== U2NETP_LICENSE_SHA256) fail("the pinned U-2-Netp Apache-2.0 license differs");
  const onnxruntimeLicense = await boundedRead(path.join(root, "licenses/onnxruntime-web-MIT.txt"));
  if (sha256(onnxruntimeLicense) !== ONNXRUNTIME_WEB_LICENSE_SHA256) fail("the pinned ONNX Runtime Web MIT license differs");

  return {
    root,
    files,
    contentManifest,
    contentManifestSha256: sha256(Buffer.from(stableJson(contentManifest))),
    artifactManifestFileSha256: sha256(artifactManifestBytes)
  };
}

export async function comparePluginPackages(firstDirectory, secondDirectory) {
  const [first, second] = await Promise.all([
    verifyPluginPackage(firstDirectory),
    verifyPluginPackage(secondDirectory)
  ]);
  const firstEntries = new Map(first.contentManifest.files.map((entry) => [entry.path, entry]));
  const secondEntries = new Map(second.contentManifest.files.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...firstEntries.keys(), ...secondEntries.keys()])].sort((a, b) => a.localeCompare(b, "en"));
  const differences = paths.filter((file) => JSON.stringify(firstEntries.get(file)) !== JSON.stringify(secondEntries.get(file)));
  if (first.artifactManifestFileSha256 !== second.artifactManifestFileSha256) {
    differences.unshift(ARTIFACT_MANIFEST);
  }
  return { equivalent: differences.length === 0, differences, first, second };
}

function parseArguments(argv) {
  if (argv.length < 1 || argv.length > 2) {
    throw new Error("Usage: node scripts/verify-plugin-package.mjs <package> [comparison-package]");
  }
  return argv.map((value) => path.resolve(value));
}

async function main() {
  const [first, second] = parseArguments(process.argv.slice(2));
  const result = second === undefined
    ? { verification: await verifyPluginPackage(first) }
    : { comparison: await comparePluginPackages(first, second) };
  process.stdout.write(stableJson(result));
  if ("comparison" in result && !result.comparison.equivalent) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Plugin package verification failed."}\n`);
    process.exitCode = 1;
  });
}
