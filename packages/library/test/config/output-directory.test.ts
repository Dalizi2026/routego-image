import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  redactOutputDirectoryDisplay,
  validateOutputDirectory,
  type OutputDirectoryFileSystem,
  type OutputDirectoryStat
} from "../../src/config/output-directory";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function syntheticStat(options: {
  readonly directory?: boolean;
  readonly symbolicLink?: boolean;
  readonly uid?: number;
} = {}): OutputDirectoryStat {
  return {
    uid: options.uid ?? 1_000,
    isDirectory: () => options.directory ?? true,
    isSymbolicLink: () => options.symbolicLink ?? false
  };
}

function syntheticFileSystem(overrides: Partial<OutputDirectoryFileSystem> = {}): OutputDirectoryFileSystem {
  return {
    lstat: async () => syntheticStat(),
    mkdir: async () => undefined,
    realpath: async (value) => value,
    open: async () => ({ sync: async () => undefined, close: async () => undefined }),
    unlink: async () => undefined,
    ...overrides
  };
}

describe("strict output-directory validation", () => {
  it("canonicalizes an owned writable directory and returns only a redacted display", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "routego-output-home-"));
    roots.push(home);
    const selected = path.join(home, "custom", "results");
    const canonical = await validateOutputDirectory(selected, { homeDirectory: home });
    expect(canonical).toBe(await realpath(selected));
    const display = redactOutputDirectoryDisplay(canonical);
    expect(display).toBe("…/custom/results");
    expect(display).not.toContain(home);
  });

  it("allows the approved new default subtree without treating its legacy parent as mutable", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "routego-default-home-"));
    roots.push(home);
    const selected = path.join(home, "Pictures", "routego-image", "library", "exports");
    await expect(validateOutputDirectory(selected, { homeDirectory: home })).resolves.toBe(
      await realpath(selected).catch(() => selected)
    );
  });

  it("rejects roots, traversal, URLs, unsafe Windows roots, and protected legacy paths", async () => {
    const cases: Array<Promise<unknown>> = [
      validateOutputDirectory("/", { homeDirectory: "/home/synthetic", platform: "posix" }),
      validateOutputDirectory("/home/synthetic/../escape", {
        homeDirectory: "/home/synthetic",
        platform: "posix"
      }),
      validateOutputDirectory("https://example.invalid/output", {
        homeDirectory: "/home/synthetic",
        platform: "posix"
      }),
      validateOutputDirectory("\\\\server\\share\\output", {
        homeDirectory: "C:\\Users\\Synthetic",
        platform: "win32"
      }),
      validateOutputDirectory("C:\\Users\\Synthetic\\plugins\\routego-image", {
        homeDirectory: "C:\\Users\\Synthetic",
        platform: "win32"
      })
    ];
    for (const candidate of cases) {
      await expect(candidate).rejects.toMatchObject({ code: "path_unsafe" });
    }
  });

  it("rejects an existing non-directory and a symlink component", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "routego-output-file-"));
    roots.push(home);
    const file = path.join(home, "not-a-directory");
    await writeFile(file, "synthetic", "utf8");
    await expect(validateOutputDirectory(file, { homeDirectory: home })).rejects.toMatchObject({
      code: "path_unsafe"
    });

    const fileSystem = syntheticFileSystem({
      lstat: async (value) =>
        value.endsWith("link") ? syntheticStat({ symbolicLink: true }) : syntheticStat()
    });
    await expect(
      validateOutputDirectory("/home/synthetic/link/output", {
        homeDirectory: "/home/synthetic",
        platform: "posix",
        currentUid: 1_000,
        fileSystem
      })
    ).rejects.toMatchObject({ code: "path_unsafe" });
  });

  it("fails closed for unsafe POSIX ownership and an unwritable Windows destination", async () => {
    await expect(
      validateOutputDirectory("/home/synthetic/output", {
        homeDirectory: "/home/synthetic",
        platform: "posix",
        currentUid: 2_000,
        fileSystem: syntheticFileSystem({ lstat: async () => syntheticStat({ uid: 1_000 }) })
      })
    ).rejects.toMatchObject({ code: "access_denied" });

    await expect(
      validateOutputDirectory("C:\\Users\\Synthetic\\Output", {
        homeDirectory: "C:\\Users\\Synthetic",
        platform: "win32",
        fileSystem: syntheticFileSystem({
          open: async () => Promise.reject(new Error("synthetic access failure"))
        })
      })
    ).rejects.toMatchObject({ code: "access_denied" });
  });
});
