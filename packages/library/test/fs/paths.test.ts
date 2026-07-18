import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createExclusiveFile, resolveApprovedPath, sanitizeBaseName } from "../../src/fs/paths";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Library paths", () => {
  it("preserves Unicode while removing unsafe filename characters", () => {
    expect(sanitizeBaseName('  中文 🙂 <bad>:name. ')).toBe("中文 🙂 -bad-name");
  });

  it("replaces Windows device names and does not split Unicode suffixes", () => {
    expect(sanitizeBaseName("CON")).toBe("routego-image");
    expect(sanitizeBaseName(`${"a".repeat(119)}🙂tail`)).toBe(`${"a".repeat(119)}🙂`);
  });

  it("creates exclusive versioned files without overwriting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "routego-library-path-"));
    roots.push(root);
    const first = await createExclusiveFile({
      directory: root,
      requestedBaseName: "结果",
      extension: "png"
    });
    await first.handle.writeFile("first", "utf8");
    await first.handle.close();
    const second = await createExclusiveFile({
      directory: root,
      requestedBaseName: "结果",
      extension: ".png"
    });
    await second.handle.writeFile("second", "utf8");
    await second.handle.close();
    expect(path.basename(first.path)).toBe("结果.png");
    expect(path.basename(second.path)).toBe("结果-2.png");
    expect(await readFile(first.path, "utf8")).toBe("first");
  });

  it("rejects traversal outside an approved root", () => {
    expect(() => resolveApprovedPath({ root: "C:\\safe", candidate: "..\\escape", platform: "win32" }))
      .toThrow(/outside the approved root/u);
  });

  it("rejects destructive overlap with a protected legacy root", () => {
    expect(() =>
      resolveApprovedPath({
        root: "C:\\Users\\person",
        candidate: "Pictures\\routego-image",
        operation: "delete",
        platform: "win32",
        protectedRoots: ["C:\\Users\\person\\Pictures\\routego-image"]
      })
    ).toThrow(/outside the approved root/u);
  });

  it("rejects an invalid version-attempt bound", async () => {
    await expect(
      createExclusiveFile({
        directory: "C:\\unused",
        requestedBaseName: "result",
        extension: "png",
        maxAttempts: 0
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
