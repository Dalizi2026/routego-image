#!/usr/bin/env node

import { readFile } from "node:fs/promises";
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
  const manifestText = await readFile(path.join(runtimeRoot, "studio-assets.json"), "utf8");
  const studio = parseStaticManifest(JSON.parse(manifestText));
  const runtime = await import(pathToFileURL(path.join(runtimeRoot, "index.js")).href);
  if (typeof runtime.runRoutegoImageCli !== "function") {
    throw new Error("Routego Image runtime entry is invalid.");
  }
  await runtime.runRoutegoImageCli(studio);
}

try {
  await main();
} catch {
  process.stderr.write("Routego Image failed to start safely.\n");
  process.exitCode = 1;
}
