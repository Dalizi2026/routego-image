import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// @ts-expect-error Task-owned Node ESM scripts intentionally ship without declaration artifacts.
import { buildPluginPackage } from "../../../scripts/build-plugin-package.mjs";
// @ts-expect-error Task-owned Node ESM scripts intentionally ship without declaration artifacts.
import { comparePluginPackages, verifyPluginPackage } from "../../../scripts/verify-plugin-package.mjs";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
const execFileAsync = promisify(execFile);

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
    expect(first.files).toContain("THIRD_PARTY_NOTICES.md");
    expect(first.files).toContain("licenses/pngjs-MIT.txt");
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
});
