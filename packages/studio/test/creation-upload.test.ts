import { describe, expect, it, vi } from "vitest";

import type { StudioGateway } from "../src/api";
import {
  createUploadItem,
  discardUploadLifecycle,
  performUploadLifecycle,
  retryUploadLifecycle,
  UploadLifecycleError
} from "../src/features/creation";

function gatewayForUpload(options: { reserveFailure?: boolean; finalizeExpired?: boolean } = {}) {
  const descriptor = {
    uploadResourceId: "upload-synthetic",
    purpose: "reference" as const,
    status: "reserved" as const,
    reusePolicy: "reusable-until-expiry" as const,
    binaryUpload: {
      method: "PUT" as const,
      relativeUrl: "/api/v1/uploads/upload-synthetic/content",
      requiresSession: true as const,
      requiresOrigin: true as const,
      allowedMimeTypes: ["image/png" as const, "image/jpeg" as const, "image/webp" as const],
      maxBytes: 52_428_800,
      expiresAt: "2026-07-18T12:05:00.000Z"
    },
    declaredMimeType: "image/png" as const,
    declaredByteLength: 9,
    createdAt: "2026-07-18T12:00:00.000Z"
  };
  const invoke = vi.fn(async (operation: string) => {
    if (operation === "reserveUploadResource") {
      return options.reserveFailure
        ? {
            schemaVersion: 1,
            status: "failed",
            error: {
              code: "upload_oversize",
              safeMessage: "Synthetic reservation rejected."
            }
          }
        : { schemaVersion: 1, status: "succeeded", resource: descriptor };
    }
    if (operation === "finalizeUploadResource") {
      return options.finalizeExpired
        ? {
            schemaVersion: 1,
            status: "failed",
            error: { code: "upload_expired", safeMessage: "Synthetic upload expired." }
          }
        : {
            schemaVersion: 1,
            status: "succeeded",
            resource: { ...descriptor, status: "finalized" }
          };
    }
    if (operation === "discardUploadResource") {
      return {
        schemaVersion: 1,
        status: "succeeded",
        resource: { ...descriptor, status: "discarded" }
      };
    }
    throw new Error(`unexpected operation ${operation}`);
  });
  return {
    gateway: {
      invoke,
      uploadBinary: vi.fn(async () => undefined)
    } as unknown as StudioGateway,
    invoke
  };
}

describe("Studio upload lifecycle", () => {
  it("runs reserve, binary PUT, and finalize in order while retaining only the locator", async () => {
    const { gateway, invoke } = gatewayForUpload();
    const item = createUploadItem(
      "reference",
      { name: "synthetic.png", blob: new Blob(["synthetic"], { type: "image/png" }) },
      "local-upload"
    );
    const states: string[] = [];
    const ready = await performUploadLifecycle(gateway, item, (next) => states.push(next.status));
    expect(states).toEqual(["reserving", "uploading", "finalizing", "ready"]);
    expect(invoke.mock.calls.map(([operation]) => operation)).toEqual([
      "reserveUploadResource",
      "finalizeUploadResource"
    ]);
    expect(gateway.uploadBinary).toHaveBeenCalledOnce();
    expect(ready).toMatchObject({ status: "ready", uploadResourceId: "upload-synthetic" });
    expect(JSON.stringify(invoke.mock.calls)).not.toMatch(
      /(?:rawBytes|data:image|base64|C:\\|\/Users\/|Authorization)/u
    );
  });

  it("preserves safe failure/expiry states and supports discard", async () => {
    const failedSetup = gatewayForUpload({ reserveFailure: true });
    const item = createUploadItem(
      "reference",
      { name: "test.png", blob: new Blob(["synthetic"], { type: "image/png" }) },
      "local-failure"
    );
    await expect(
      performUploadLifecycle(failedSetup.gateway, item, () => undefined)
    ).rejects.toBeInstanceOf(UploadLifecycleError);

    const expiredSetup = gatewayForUpload({ finalizeExpired: true });
    await expect(
      performUploadLifecycle(expiredSetup.gateway, item, () => undefined)
    ).rejects.toMatchObject({ status: "expired" });

    const discardSetup = gatewayForUpload();
    const discarded = await discardUploadLifecycle(
      discardSetup.gateway,
      { ...item, status: "ready", uploadResourceId: "upload-synthetic" },
      () => undefined
    );
    expect(discarded.status).toBe("discarded");
  });

  it("discards a previous reservation before retrying and closes thrown failures", async () => {
    const retrySetup = gatewayForUpload();
    const source = { name: "test.png", blob: new Blob(["synthetic"], { type: "image/png" }) };
    const previous = {
      ...createUploadItem("reference", source, "local-retry"),
      status: "failed" as const,
      uploadResourceId: "upload-synthetic"
    };
    await retryUploadLifecycle(retrySetup.gateway, previous, () => undefined);
    expect(retrySetup.invoke.mock.calls.map(([operation]) => operation)).toEqual([
      "discardUploadResource",
      "reserveUploadResource",
      "finalizeUploadResource"
    ]);

    const states: string[] = [];
    const throwingGateway = {
      invoke: vi.fn(async () => {
        throw new Error("Synthetic local service unavailable.");
      })
    } as unknown as StudioGateway;
    await expect(
      performUploadLifecycle(
        throwingGateway,
        createUploadItem("reference", source, "local-network-failure"),
        (item) => states.push(item.status)
      )
    ).rejects.toBeInstanceOf(UploadLifecycleError);
    expect(states).toEqual(["reserving", "failed"]);
  });
});
