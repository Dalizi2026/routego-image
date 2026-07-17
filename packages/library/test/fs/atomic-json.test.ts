import { chmod, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupAtomicJsonTemporaryFiles,
  readJsonRecovering,
  writeJsonAtomic
} from "../../src/fs/atomic-json";
import { restrictFileToCurrentUser } from "../../src/fs/permissions";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const parseVersion = (value: unknown): { readonly version: number } => {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as Record<string, unknown>)["version"] !== "number"
  ) {
    throw new Error("invalid");
  }
  return value as { readonly version: number };
};

describe("atomic JSON persistence", () => {
  it("replaces a document and recovers a corrupt target from its validated backup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "routego-atomic-"));
    roots.push(root);
    const file = path.join(root, "配置.json");
    await writeJsonAtomic(file, { version: 1 });
    await writeJsonAtomic(file, { version: 2 });
    await writeFile(file, "{broken", "utf8");
    expect(await readJsonRecovering(file, parseVersion)).toEqual({ version: 1 });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1 });
  });

  it("applies POSIX owner-only permissions", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "routego-mode-"));
    roots.push(root);
    const file = path.join(root, "secret.json");
    await writeFile(file, "{}", { mode: 0o666 });
    await chmod(file, 0o666);
    await restrictFileToCurrentUser({ filePath: file, platform: process.platform });
    const mode = (await import("node:fs/promises")).stat(file).then((value) => value.mode & 0o777);
    await expect(mode).resolves.toBe(0o600);
  });

  it("does not publish a replacement when permission enforcement fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "routego-atomic-permission-"));
    roots.push(root);
    const file = path.join(root, "credentials.json");
    await writeJsonAtomic(file, { version: 1 });
    await expect(
      writeJsonAtomic(file, { version: 2 }, { applyPermissions: async () => Promise.reject(new Error("acl")) })
    ).rejects.toMatchObject({ code: "file_write_failed" });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1 });
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("reports a corrupt backup when the primary document is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "routego-atomic-backup-"));
    roots.push(root);
    const file = path.join(root, "config.json");
    await writeFile(`${file}.bak`, "{broken", "utf8");
    await expect(readJsonRecovering(file, parseVersion)).rejects.toMatchObject({
      code: "config_corrupt"
    });
  });

  it("rejects invalid UTF-8 and removes only stale owned temporary files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "routego-atomic-cleanup-"));
    roots.push(root);
    const file = path.join(root, "配置.json");
    await writeFile(file, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]));
    await expect(readJsonRecovering(file, parseVersion)).rejects.toMatchObject({
      code: "config_corrupt"
    });

    const staleOwned = path.join(root, ".配置.json.token.tmp");
    const freshOwned = path.join(root, ".配置.json.fresh.tmp");
    const unknown = path.join(root, "unknown.tmp");
    await Promise.all([
      writeFile(staleOwned, "stale", "utf8"),
      writeFile(freshOwned, "fresh", "utf8"),
      writeFile(unknown, "unknown", "utf8")
    ]);
    await utimes(staleOwned, new Date(0), new Date(0));
    expect(
      await cleanupAtomicJsonTemporaryFiles(file, {
        olderThanMs: 1_000,
        now: () => Date.now()
      })
    ).toEqual([staleOwned]);
    expect(await readdir(root)).toEqual(
      expect.arrayContaining([path.basename(freshOwned), path.basename(unknown)])
    );
  });

  it("applies private permissions to both the replacement and credential backup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "routego-atomic-private-backup-"));
    roots.push(root);
    const file = path.join(root, "credentials.json");
    const protectedPaths: string[] = [];
    const applyPermissions = async (candidate: string): Promise<void> => {
      protectedPaths.push(path.basename(candidate));
    };
    await writeJsonAtomic(file, { version: 1 }, { applyPermissions });
    await writeJsonAtomic(file, { version: 2 }, { applyPermissions });
    expect(protectedPaths.filter((name) => name.includes(".bak.")).length).toBe(1);
    expect(protectedPaths.filter((name) => name.startsWith(".credentials.json.")).length).toBe(2);
  });
});
