import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireFileLock, withFileLock } from "../../src/fs/lock";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file locks", () => {
  it("serializes concurrent writers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "routego-lock-"));
    roots.push(root);
    const lockPath = path.join(root, "index.lock");
    const order: string[] = [];
    const first = withFileLock(lockPath, "index", async () => {
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("first-end");
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = withFileLock(
      lockPath,
      "index",
      async () => {
        order.push("second");
      },
      { timeoutMs: 500, retryMinMs: 1, retryMaxMs: 5 }
    );
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("times out without deleting a live lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "routego-lock-timeout-"));
    roots.push(root);
    const lockPath = path.join(root, "index.lock");
    const held = await acquireFileLock(lockPath, "index");
    await expect(
      acquireFileLock(lockPath, "index", { timeoutMs: 5, retryMinMs: 1, retryMaxMs: 1 })
    ).rejects.toMatchObject({ code: "lock_timeout" });
    await held.release();
  });

  it("recovers a stale dead-owner lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "routego-lock-stale-"));
    roots.push(root);
    const lockPath = path.join(root, "index.lock");
    await writeFile(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        token: "old-token",
        pid: 999_999,
        resource: "index",
        createdAt: "2000-01-01T00:00:00.000Z"
      }),
      "utf8"
    );
    const lock = await acquireFileLock(lockPath, "index", {
      timeoutMs: 100,
      staleMs: 1,
      retryMinMs: 1,
      retryMaxMs: 1,
      isProcessAlive: () => false
    });
    expect(lock.token).not.toBe("old-token");
    await lock.release();
  });

  it("does not remove a replacement lock with a different token", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "routego-lock-race-"));
    roots.push(root);
    const lockPath = path.join(root, "index.lock");
    await writeFile(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        token: "stale-token",
        pid: 999_999,
        resource: "index",
        createdAt: "2000-01-01T00:00:00.000Z"
      }),
      "utf8"
    );
    let replaced = false;
    await expect(
      acquireFileLock(lockPath, "index", {
        timeoutMs: 10,
        staleMs: 1,
        retryMinMs: 1,
        retryMaxMs: 1,
        isProcessAlive: (pid) => pid === process.pid,
        beforeStaleTokenRecheck: async () => {
          if (replaced) return;
          replaced = true;
          await rm(lockPath, { force: true });
          await writeFile(
            lockPath,
            JSON.stringify({
              schemaVersion: 1,
              token: "replacement-token",
              pid: process.pid,
              resource: "index",
              createdAt: new Date().toISOString()
            }),
            "utf8"
          );
        }
      })
    ).rejects.toMatchObject({ code: "lock_timeout" });
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
      token: "replacement-token"
    });
  });

  it("releases only its own token", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "routego-lock-release-"));
    roots.push(root);
    const lockPath = path.join(root, "index.lock");
    const lock = await acquireFileLock(lockPath, "index");
    await writeFile(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        token: "other-token",
        pid: process.pid,
        resource: "index",
        createdAt: new Date().toISOString()
      }),
      "utf8"
    );
    await lock.release();
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ token: "other-token" });
  });
});
