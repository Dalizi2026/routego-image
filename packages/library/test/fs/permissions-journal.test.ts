import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createTransactionRecoveryPlan,
  listTransactionJournals,
  markTransactionJournalCommitted,
  removeTransactionJournal,
  writeTransactionJournal
} from "../../src/fs/journal";
import {
  restrictFileToCurrentUser,
  type CommandRunner,
  type PosixPermissionAdapter
} from "../../src/fs/permissions";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("permissions and journals", () => {
  it("uses SID-based Windows ACL commands and verifies the SID", async () => {
    const calls: { file: string; args: readonly string[] }[] = [];
    const runner: CommandRunner = async (file, args) => {
      calls.push({ file, args });
      return file === "whoami.exe"
        ? { stdout: '"HOST\\user","S-1-5-21-100-200-300-400"', stderr: "" }
        : { stdout: "S-1-5-21-100-200-300-400:(F)", stderr: "" };
    };
    await restrictFileToCurrentUser({
      filePath: "C:\\safe\\credentials.json",
      platform: "win32",
      runner
    });
    expect(calls.map((call) => call.file)).toEqual(["whoami.exe", "icacls.exe", "icacls.exe"]);
    expect(calls[1]?.args.join(" ")).toContain("*S-1-5-21-100-200-300-400:(F)");
  });

  it("accepts Windows ACL verification that reports the account name", async () => {
    const runner: CommandRunner = async (file, args) => {
      if (file === "whoami.exe") {
        return { stdout: '"HOST\\user","S-1-5-21-100-200-300-400"', stderr: "" };
      }
      return args.length === 1
        ? { stdout: "C:\\safe\\credentials.json HOST\\user:(F)", stderr: "" }
        : { stdout: "processed", stderr: "" };
    };
    await expect(
      restrictFileToCurrentUser({ filePath: "C:\\safe\\credentials.json", platform: "win32", runner })
    ).resolves.toBeUndefined();
  });

  it("fails when Windows ACL verification omits the current SID", async () => {
    const runner: CommandRunner = async (file) =>
      file === "whoami.exe"
        ? { stdout: '"HOST\\user","S-1-5-21-1-2-3-4"', stderr: "" }
        : { stdout: "no matching principal", stderr: "" };
    await expect(
      restrictFileToCurrentUser({ filePath: "C:\\safe\\credentials.json", platform: "win32", runner })
    ).rejects.toMatchObject({ code: "access_denied" });
  });

  it("fails when Windows ACL verification omits full control", async () => {
    const runner: CommandRunner = async (file) =>
      file === "whoami.exe"
        ? { stdout: '"HOST\\user","S-1-5-21-1-2-3-4"', stderr: "" }
        : { stdout: "S-1-5-21-1-2-3-4:(R)", stderr: "" };
    await expect(
      restrictFileToCurrentUser({ filePath: "C:\\safe\\credentials.json", platform: "win32", runner })
    ).rejects.toMatchObject({ code: "access_denied" });
  });

  it("fails closed when POSIX mode verification is not owner-only", async () => {
    const posix: PosixPermissionAdapter = {
      chmod: async () => undefined,
      stat: async () => ({ mode: 0o100640 })
    };
    await expect(
      restrictFileToCurrentUser({
        filePath: "/safe/credentials.json",
        platform: "linux",
        posix
      })
    ).rejects.toMatchObject({ code: "access_denied" });
  });

  it("writes, lists, and removes versioned transaction journals", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "routego-journal-"));
    roots.push(root);
    await writeTransactionJournal(root, {
      schemaVersion: 1,
      id: "tx-1",
      kind: "synthetic",
      state: "prepared",
      createdAt: "2026-01-01T00:00:00.000Z",
      createdPaths: ["assets/new.png"],
      deleteAfterCommitPaths: []
    });
    const listed = await listTransactionJournals(root);
    expect(listed).toHaveLength(1);
    expect(
      createTransactionRecoveryPlan(root, listed[0]!).removePaths[0]
    ).toBe(path.join(root, "assets", "new.png"));
    const committed = await markTransactionJournalCommitted(root, listed[0]!);
    expect(committed.state).toBe("committed");
    expect((await listTransactionJournals(root))[0]?.state).toBe("committed");
    await removeTransactionJournal(root, "tx-1");
    expect(await listTransactionJournals(root)).toEqual([]);
  });

  it("rejects transaction-owned paths that escape the approved root", () => {
    expect(() =>
      createTransactionRecoveryPlan("C:\\safe", {
        schemaVersion: 1,
        id: "tx-escape",
        kind: "synthetic",
        state: "prepared",
        createdAt: "2026-01-01T00:00:00.000Z",
        createdPaths: ["..\\escape.png"],
        deleteAfterCommitPaths: []
      })
    ).toThrow(/outside the approved root/u);
  });
});
