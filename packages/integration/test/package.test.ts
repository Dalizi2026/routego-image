import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// @ts-expect-error Task-owned Node ESM scripts intentionally ship without declaration artifacts.
import { buildPluginPackage } from "../../../scripts/build-plugin-package.mjs";
// @ts-expect-error Task-owned Node ESM scripts intentionally ship without declaration artifacts.
import { comparePluginPackages, verifyPluginPackage } from "../../../scripts/verify-plugin-package.mjs";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
const execFileAsync = promisify(execFile);

interface ArtifactManifest {
  version: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

async function readPng(packageRoot: string, relativeFile: string): Promise<PNG> {
  return PNG.sync.read(await readFile(path.join(packageRoot, ...relativeFile.split("/"))));
}

function cornerAlpha(png: PNG): number[] {
  return [
    png.data[3]!,
    png.data[(png.width - 1) * 4 + 3]!,
    png.data[((png.height - 1) * png.width) * 4 + 3]!,
    png.data[(png.width * png.height - 1) * 4 + 3]!
  ];
}

function foregroundRatio(png: PNG): number {
  let foreground = 0;
  for (let index = 3; index < png.data.length; index += 4) {
    if (png.data[index]! > 12) foreground += 1;
  }
  return foreground / (png.width * png.height);
}

async function rewriteFileAndManifest(
  packageRoot: string,
  relativeFile: string,
  content: string
): Promise<void> {
  await writeFile(path.join(packageRoot, ...relativeFile.split("/")), content, "utf8");
  const manifestPath = path.join(packageRoot, "artifact-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ArtifactManifest;
  const entry = manifest.files.find((candidate) => candidate.path === relativeFile);
  if (entry === undefined) throw new Error(`Missing manifest entry for ${relativeFile}`);
  const bytes = Buffer.from(content, "utf8");
  entry.bytes = bytes.byteLength;
  entry.sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

describe("Routego Image plugin package", () => {
  let temporaryRoot: string;
  let firstPackage: string;
  let secondPackage: string;

  beforeAll(async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "routego-plugin-package-test-"));
    firstPackage = path.join(temporaryRoot, "first", "routego-image");
    secondPackage = path.join(temporaryRoot, "second", "routego-image");
    await buildPluginPackage({
      repositoryRoot: REPOSITORY_ROOT,
      outputDirectory: firstPackage
    });
    await buildPluginPackage({
      repositoryRoot: REPOSITORY_ROOT,
      outputDirectory: secondPackage
    });
  }, 120_000);

  afterAll(async () => {
    if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("builds two equivalent self-contained packages from clean inputs", async () => {
    const first = await verifyPluginPackage(firstPackage);
    const second = await verifyPluginPackage(secondPackage);
    const comparison = await comparePluginPackages(firstPackage, secondPackage);

    expect(comparison.equivalent).toBe(true);
    expect(comparison.differences).toEqual([]);
    expect(first.contentManifest).toEqual(second.contentManifest);
    expect(first.files).toContain("runtime/index.js");
    expect(first.files).toContain("runtime/studio-assets.json");
    expect(first.files).toContain("assets/composer-icon.png");
    expect(first.files).toContain("assets/logo.png");
    expect(first.files).toContain("THIRD_PARTY_NOTICES.md");
    expect(first.files).toContain("licenses/pngjs-MIT.txt");

    const logo = await readPng(firstPackage, "assets/logo.png");
    const composerIcon = await readPng(firstPackage, "assets/composer-icon.png");
    expect([logo.width, logo.height]).toEqual([512, 512]);
    expect([composerIcon.width, composerIcon.height]).toEqual([128, 128]);
    expect(cornerAlpha(logo)).toEqual([0, 0, 0, 0]);
    expect(cornerAlpha(composerIcon)).toEqual([0, 0, 0, 0]);
    expect(foregroundRatio(logo)).toBeGreaterThan(0.25);
    expect(foregroundRatio(logo)).toBeLessThan(0.35);
    expect(foregroundRatio(composerIcon)).toBeGreaterThan(0.25);
    expect(foregroundRatio(composerIcon)).toBeLessThan(0.35);
  });

  it("loads the bundled runtime without workspace or package imports", async () => {
    const runtimePath = path.join(firstPackage, "runtime/index.js");
    const runtimeText = await readFile(runtimePath, "utf8");
    const runtime = await import(`${pathToFileURL(runtimePath).href}?test=${Date.now()}`);

    expect(runtime.runRoutegoImageCli).toBeTypeOf("function");
    expect(runtimeText).not.toMatch(/(?:from\s+|import\s*\()["']@routego-image\//u);
    expect(runtimeText).not.toMatch(/(?:from\s+|import\s*\()["']pngjs["']/u);
    expect(runtimeText).not.toContain(REPOSITORY_ROOT);

    const importScript = [
      `const runtime = await import(${JSON.stringify(pathToFileURL(runtimePath).href)});`,
      `if (typeof runtime.runRoutegoImageCli !== "function") throw new Error("runtime export missing");`
    ].join("\n");
    await expect(execFileAsync(process.execPath, ["--input-type=module", "-e", importScript]))
      .resolves.toMatchObject({ stderr: "" });
  });

  it("rejects unlisted dependency trees and sensitive configuration", async () => {
    const candidate = path.join(temporaryRoot, "forbidden", "routego-image");
    await cp(firstPackage, candidate, { recursive: true });
    await mkdir(path.join(candidate, "node_modules"), { recursive: true });
    await writeFile(path.join(candidate, "node_modules", "payload.js"), "export {};\n");
    await writeFile(path.join(candidate, ".env"), "ROUTEGO_API_KEY=synthetic\n");

    await expect(verifyPluginPackage(candidate)).rejects.toThrow(/not allowlisted|forbidden/u);
  });

  it("rejects content hash changes and extra files", async () => {
    const candidate = path.join(temporaryRoot, "tampered", "routego-image");
    await cp(firstPackage, candidate, { recursive: true });
    await writeFile(path.join(candidate, "runtime/index.js"), "export const tampered = true;\n");
    await writeFile(path.join(candidate, "report.json"), "{}\n");

    await expect(verifyPluginPackage(candidate)).rejects.toThrow(/hash|allowlisted/u);
  });

  it("rejects symlinks even when they point inside the package", async () => {
    const candidate = path.join(temporaryRoot, "symlink", "routego-image");
    await cp(firstPackage, candidate, { recursive: true });
    await symlink(
      path.join(candidate, "runtime/index.js"),
      path.join(candidate, "runtime/linked-runtime.js")
    );

    await expect(verifyPluginPackage(candidate)).rejects.toThrow(/symbolic link|symlink/u);
  });

  it("rejects a package root that is itself a symbolic link", async () => {
    const linkParent = path.join(temporaryRoot, "root-link");
    const candidate = path.join(linkParent, "routego-image");
    await mkdir(linkParent, { recursive: true });
    await symlink(firstPackage, candidate, "dir");

    await expect(verifyPluginPackage(candidate)).rejects.toThrow(/symbolic link|symlink/u);
  });

  it.each([
    ["a second MCP server", (manifest: Record<string, any>) => {
      manifest["mcpServers"]["unexpected"] = {
        command: "node",
        args: ["./runtime/index.js"],
        cwd: "."
      };
    }],
    ["an extra component", (manifest: Record<string, any>) => {
      manifest["apps"] = { unexpected: "./apps/unexpected.json" };
      manifest["hooks"] = { unexpected: "./hooks/unexpected.json" };
    }],
    ["unknown manifest and server keys", (manifest: Record<string, any>) => {
      manifest["unexpected"] = true;
      manifest["mcpServers"]["routego-image"]["unexpected"] = true;
    }],
    ["an invalid cachebuster version", (manifest: Record<string, any>) => {
      manifest["version"] = "1.0.0+codex.INVALID_token";
    }]
  ])("rejects a rehashed canonical manifest with %s", async (_label, mutate) => {
    const candidate = path.join(temporaryRoot, `manifest-${String(_label).replaceAll(" ", "-")}`, "routego-image");
    await cp(firstPackage, candidate, { recursive: true });
    const manifestPath = path.join(candidate, ".codex-plugin/plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
    mutate(manifest);
    await rewriteFileAndManifest(
      candidate,
      ".codex-plugin/plugin.json",
      `${JSON.stringify(manifest, null, 2)}\n`
    );

    await expect(verifyPluginPackage(candidate)).rejects.toThrow(/accepted|canonical|manifest/u);
  });

  it("accepts an official cachebuster when both manifests use the same version", async () => {
    const candidate = path.join(temporaryRoot, "cachebuster", "routego-image");
    await cp(firstPackage, candidate, { recursive: true });
    const version = "1.0.0+codex.local-20260720-g11";
    const pluginManifestPath = path.join(candidate, ".codex-plugin/plugin.json");
    const pluginManifest = JSON.parse(await readFile(pluginManifestPath, "utf8")) as Record<string, any>;
    pluginManifest["version"] = version;
    await rewriteFileAndManifest(
      candidate,
      ".codex-plugin/plugin.json",
      `${JSON.stringify(pluginManifest, null, 2)}\n`
    );
    const artifactManifestPath = path.join(candidate, "artifact-manifest.json");
    const artifactManifest = JSON.parse(await readFile(artifactManifestPath, "utf8")) as ArtifactManifest;
    artifactManifest.version = version;
    await writeFile(artifactManifestPath, `${JSON.stringify(artifactManifest, null, 2)}\n`, "utf8");

    await expect(verifyPluginPackage(candidate)).resolves.toMatchObject({
      contentManifest: { version }
    });
  });

  it("rejects a cachebuster when the artifact and plugin versions differ", async () => {
    const candidate = path.join(temporaryRoot, "cachebuster-mismatch", "routego-image");
    await cp(firstPackage, candidate, { recursive: true });
    const pluginManifestPath = path.join(candidate, ".codex-plugin/plugin.json");
    const pluginManifest = JSON.parse(await readFile(pluginManifestPath, "utf8")) as Record<string, any>;
    pluginManifest["version"] = "1.0.0+codex.local-20260720-g11";
    await rewriteFileAndManifest(
      candidate,
      ".codex-plugin/plugin.json",
      `${JSON.stringify(pluginManifest, null, 2)}\n`
    );

    await expect(verifyPluginPackage(candidate)).rejects.toThrow(/artifact-manifest|invalid shape/u);
  });

  it.each([
    ["percent-encoded SVG data URL", "data:image/svg+xml,%3Csvg%3E%3C/svg%3E"],
    ["short Base64 image data URL", "data:image/png;base64,iVBORw0KGgo="],
    ["short raw SVG data URL", "data:image/svg+xml,<svg></svg>"],
    [
      "parameterized raw SVG data URL adjacent to text",
      "prefix];data:image/svg+xml;charset=utf-8,<svg/>;suffix"
    ],
    ["96-character generic Base64 token", "A".repeat(96)]
  ])("rejects a rehashed runtime containing a %s", async (_label, payload) => {
    const candidate = path.join(temporaryRoot, `payload-${String(_label).replaceAll(" ", "-")}`, "routego-image");
    await cp(firstPackage, candidate, { recursive: true });
    const runtimePath = path.join(candidate, "runtime/index.js");
    const runtime = await readFile(runtimePath, "utf8");
    await rewriteFileAndManifest(
      candidate,
      "runtime/index.js",
      `${runtime}\nconst semanticPayloadProbe = ${JSON.stringify(payload)};\n`
    );

    await expect(verifyPluginPackage(candidate)).rejects.toThrow(/Base64|image payload|credential/u);
  });

  it("preserves HTTPS text, SHA-256 values, and identifiers below the raw Base64 boundary", async () => {
    const candidate = path.join(temporaryRoot, "safe-text-boundaries", "routego-image");
    await cp(firstPackage, candidate, { recursive: true });
    const runtimePath = path.join(candidate, "runtime/index.js");
    const runtime = await readFile(runtimePath, "utf8");
    const safeValues = {
      urls: [
        "https://example.com/assets/reference.png",
        "https://example.com/tmp/reference.png",
        "https://example.com/var/folders/reference.png"
      ],
      sha256: "a".repeat(64),
      identifier: "A".repeat(95)
    };
    await rewriteFileAndManifest(
      candidate,
      "runtime/index.js",
      `${runtime}\nconst semanticSafeTextProbe = ${JSON.stringify(safeValues)};\n`
    );

    await expect(verifyPluginPackage(candidate)).resolves.toMatchObject({
      files: expect.arrayContaining(["runtime/index.js"])
    });
  });

  it.each([
    ["private macOS temp", "/private/var/folders/ab/build/source.ts"],
    ["macOS temp alias", "/var/folders/ab/build/source.ts"],
    ["Unix temp", "/tmp/routego-build/source.ts"],
    ["file URL", "file:///private/var/folders/ab/build/source.ts"],
    ["non-C Windows checkout", "D:\\workspace\\routego-image\\source.ts"],
    ["Windows slash checkout", "E:/workspace/routego-image/source.ts"],
    ["semicolon-prefixed Unix temp", "note;/tmp/routego-build/source.ts"],
    ["bracket-prefixed macOS temp alias", "note]/var/folders/ab/build/source.ts"],
    ["brace-prefixed private macOS temp", "note}/private/var/folders/ab/build/source.ts"],
    ["parenthesis-prefixed Windows checkout", "note)D:/workspace/routego-image/source.ts"],
    ["punctuation-prefixed Windows checkout", "note@E:\\workspace\\routego-image\\source.ts"],
    ["alphanumeric-adjacent Windows slash checkout", "noteD:/workspace/routego-image/source.ts"],
    ["alphanumeric-adjacent Windows escaped checkout", "noteD:\\workspace\\routego-image\\source.ts"]
  ])("rejects a rehashed runtime containing a %s path", async (_label, localPath) => {
    const candidate = path.join(temporaryRoot, `path-${String(_label).replaceAll(" ", "-")}`, "routego-image");
    await cp(firstPackage, candidate, { recursive: true });
    const runtimePath = path.join(candidate, "runtime/index.js");
    const runtime = await readFile(runtimePath, "utf8");
    await rewriteFileAndManifest(
      candidate,
      "runtime/index.js",
      `${runtime}\nconst semanticPathProbe = ${JSON.stringify(localPath)};\n`
    );

    await expect(verifyPluginPackage(candidate)).rejects.toThrow(/local|path|checkout/u);
  });

  it.each([
    ["export-from external", 'export * from "unexpected-external";'],
    ["dynamic import with options", 'void import("unexpected-external", { with: { type: "json" } });']
  ])("rejects a rehashed runtime containing an %s", async (_label, statement) => {
    const candidate = path.join(temporaryRoot, `import-${String(_label).replaceAll(" ", "-")}`, "routego-image");
    await cp(firstPackage, candidate, { recursive: true });
    const runtimePath = path.join(candidate, "runtime/index.js");
    const runtime = await readFile(runtimePath, "utf8");
    await rewriteFileAndManifest(candidate, "runtime/index.js", `${runtime}\n${statement}\n`);

    await expect(verifyPluginPackage(candidate)).rejects.toThrow(/external import|unresolved/u);
  });
});
