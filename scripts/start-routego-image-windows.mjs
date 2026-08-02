#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeRoot = resolvePluginPath("runtime");

function resolvePluginPath(relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\0")
  ) {
    throw new Error("Invalid plugin-relative runtime path.");
  }
  const resolved = path.resolve(pluginRoot, relativePath);
  const offset = path.relative(pluginRoot, resolved);
  if (offset === "" || offset === ".." || offset.startsWith(`..${path.sep}`) || path.isAbsolute(offset)) {
    throw new Error("Plugin runtime path escapes the plugin root.");
  }
  return resolved;
}

function parseStaticManifest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Studio asset manifest.");
  }
  const { rootDirectory, entryModuleRoute, styleRoutes = [], assets } = value;
  if (
    typeof rootDirectory !== "string" ||
    typeof entryModuleRoute !== "string" ||
    !Array.isArray(styleRoutes) ||
    !styleRoutes.every((route) => typeof route === "string") ||
    assets === null ||
    typeof assets !== "object" ||
    Array.isArray(assets) ||
    !Object.entries(assets).every(
      ([route, file]) => typeof route === "string" && typeof file === "string"
    )
  ) {
    throw new Error("Invalid Studio asset manifest.");
  }
  return {
    staticAssets: {
      rootDirectory: resolvePluginPath(rootDirectory),
      assets
    },
    entryModuleRoute,
    styleRoutes
  };
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("Routego Image for Windows can run only on Windows.");
  }
  process.env.ROUTEGO_PACKAGE_TARGET = "windows";
  const manifestText = await readFile(path.join(runtimeRoot, "studio-assets.json"), "utf8");
  const studio = parseStaticManifest(JSON.parse(manifestText));
  const runtime = await import(pathToFileURL(path.join(runtimeRoot, "index.js")).href);
  if (typeof runtime.runRoutegoImageCli !== "function") {
    throw new Error("Routego Image runtime entry is invalid.");
  }
  // Keep every Windows-specific persisted path rooted at the same user profile.
  // USERPROFILE is the Windows-native source; HOME is retained for portable
  // Codex hosts and test runners that provide an isolated profile that way.
  const homeDirectory = process.env.USERPROFILE?.trim() || process.env.HOME?.trim() || homedir();
  const dataRoot = path.join(homeDirectory, ".codex", "routego-image-windows");
  await runtime.runRoutegoImageCli({
    ...studio,
    homeDirectory,
    dataRoot,
    runtimeRoot: path.join(dataRoot, "runtime")
  });
}

try {
  await main();
} catch {
  process.stderr.write("Routego Image for Windows failed to start safely.\n");
  process.exitCode = 1;
}
