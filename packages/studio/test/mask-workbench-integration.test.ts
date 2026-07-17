import { describe, expect, it, vi } from "vitest";

import type {
  BrowserResourceDescriptor,
  UploadResourceDescriptor
} from "@routego-image/contracts";

import type { StudioGateway } from "../src/api";
import {
  attachFinalizedMask,
  buildStudioCreationRequest,
  createInitialCreationDraft,
  immediateMaskTarget,
  resolveMaskTarget,
  uploadMaskPng,
  type CreationDraft,
  type DraftImageInput,
  type UploadLifecycleItem
} from "../src/features/creation";
import { bindFinalizedMaskUpload } from "../src/features/mask";

const defaults = {
  model: "mock-image-model",
  size: "auto" as const,
  aspectRatio: "auto" as const,
  quality: "auto" as const,
  format: "png" as const,
  count: 1 as const,
  partialImages: 0 as const,
  transparentMode: "off" as const,
  moderation: "auto" as const,
  saveToLibrary: true
};

function uploadDescriptor(
  purpose: "target" | "mask",
  blob: Blob,
  status: "reserved" | "finalized",
  uploadResourceId: string
): UploadResourceDescriptor {
  return {
    uploadResourceId,
    purpose,
    status,
    reusePolicy: "reusable-until-expiry",
    binaryUpload: {
      method: "PUT",
      relativeUrl: `/api/v1/uploads/${uploadResourceId}/content`,
      requiresSession: true,
      requiresOrigin: true,
      allowedMimeTypes: ["image/png"],
      maxBytes: 52_428_800,
      expiresAt: "2026-07-18T12:10:00.000Z"
    },
    declaredMimeType: "image/png",
    declaredByteLength: blob.size,
    ...(status === "finalized"
      ? {
          finalized: {
            detectedMimeType: "image/png" as const,
            byteLength: blob.size,
            sha256: "a".repeat(64),
            width: 64,
            height: 32,
            finalizedAt: "2026-07-18T12:05:00.000Z"
          }
        }
      : {}),
    createdAt: "2026-07-18T12:00:00.000Z"
  };
}

function editDraft(target: DraftImageInput): CreationDraft {
  return {
    ...createInitialCreationDraft(defaults),
    mode: "edit",
    prompt: "Keep the synthetic subject and adjust the light.",
    target,
    invariants: {
      allowedChanges: ["lighting"],
      preserve: ["subject"],
      forbiddenChanges: []
    }
  };
}

describe("mask workbench integration", () => {
  it("uses finalized target dimensions from a path-free upload without resolving a local path", () => {
    const blob = new Blob(["synthetic-target"], { type: "image/png" });
    const descriptor = uploadDescriptor("target", blob, "finalized", "upload-target-01");
    const target: DraftImageInput = {
      id: "target-local-01",
      role: "reference",
      upload: {
        id: "target-local-01",
        purpose: "target",
        source: { name: "synthetic-target.png", blob },
        status: "ready",
        uploadResourceId: descriptor.uploadResourceId,
        descriptor
      }
    };
    expect(immediateMaskTarget(target)).toEqual({
      key: "upload:upload-target-01",
      blob,
      size: { width: 64, height: 32 }
    });
  });

  it("resolves an asset target to a protected original resource and rejects unresolved artifacts", async () => {
    const resource: BrowserResourceDescriptor = {
      resourceId: "resource-asset-01",
      relativeUrl: "/api/v1/resources/resource-asset-01",
      requiresSession: true,
      mimeType: "image/png",
      byteLength: 16,
      width: 64,
      height: 32,
      etag: "synthetic-resource-v1",
      expiresAt: "2026-07-18T12:30:00.000Z"
    };
    const invoke = vi.fn(async () => ({ schemaVersion: 1, status: "succeeded", resource }));
    const gateway = { invoke } as unknown as StudioGateway;
    const target: DraftImageInput = {
      id: "target-asset-01",
      role: "previous-output",
      locator: { source: "asset", assetId: "asset-01" }
    };
    await expect(resolveMaskTarget(gateway, target)).resolves.toEqual({
      key: "asset:asset-01",
      resource,
      size: { width: 64, height: 32 }
    });
    expect(invoke).toHaveBeenCalledWith("getBrowserResource", {
      assetId: "asset-01",
      rendition: "original"
    });
    await expect(
      resolveMaskTarget(gateway, {
        id: "target-artifact-01",
        role: "previous-output",
        locator: { source: "artifact", artifactId: "artifact-01" }
      })
    ).rejects.toThrow(/protected image resource/u);
  });

  it("uploads and finalizes PNG bytes before attaching only the upload locator to target slot zero", async () => {
    const blob = new Blob(["synthetic-mask"], { type: "image/png" });
    const reserved = uploadDescriptor("mask", blob, "reserved", "upload-mask-01");
    const finalized = uploadDescriptor("mask", blob, "finalized", "upload-mask-01");
    const invoke = vi.fn(async (operation: string) => {
      if (operation === "reserveUploadResource") {
        return { schemaVersion: 1, status: "succeeded", resource: reserved };
      }
      if (operation === "finalizeUploadResource") {
        return { schemaVersion: 1, status: "succeeded", resource: finalized };
      }
      throw new Error(`unexpected operation ${operation}`);
    });
    const gateway = {
      invoke,
      uploadBinary: vi.fn(async () => undefined)
    } as unknown as StudioGateway;
    const states: UploadLifecycleItem[] = [];
    const completed = await uploadMaskPng(
      gateway,
      { blob, purpose: "mask", width: 64, height: 32, targetSlot: 0 },
      (item) => states.push(item),
      "local-mask-01"
    );
    const locator = bindFinalizedMaskUpload(completed.resource, { width: 64, height: 32 });
    const attached = attachFinalizedMask(
      editDraft({
        id: "target-asset-01",
        role: "previous-output",
        locator: { source: "asset", assetId: "asset-01" }
      }),
      locator,
      completed.item
    );
    expect(states.map((item) => item.status)).toEqual([
      "reserving",
      "uploading",
      "finalizing",
      "ready"
    ]);
    expect(states.at(-1)?.descriptor).toEqual(finalized);
    expect(buildStudioCreationRequest(attached)).toMatchObject({
      kind: "edit",
      target: { source: "asset", assetId: "asset-01" },
      mask: {
        image: { source: "upload", uploadResourceId: "upload-mask-01" },
        targetSlot: 0
      }
    });
    expect(JSON.stringify(invoke.mock.calls)).not.toMatch(
      /(?:rawBytes|data:image|base64|C:\\|\/Users\/|Authorization)/u
    );
  });

  it("keeps the edit draft unattached when mask finalization fails", async () => {
    const blob = new Blob(["synthetic-mask"], { type: "image/png" });
    const reserved = uploadDescriptor("mask", blob, "reserved", "upload-mask-failure");
    const gateway = {
      invoke: vi.fn(async (operation: string) =>
        operation === "reserveUploadResource"
          ? { schemaVersion: 1, status: "succeeded", resource: reserved }
          : {
              schemaVersion: 1,
              status: "failed",
              error: { code: "upload_expired", safeMessage: "Synthetic mask upload expired." }
            }
      ),
      uploadBinary: vi.fn(async () => undefined)
    } as unknown as StudioGateway;
    const draft = editDraft({
      id: "target-asset-01",
      role: "previous-output",
      locator: { source: "asset", assetId: "asset-01" }
    });
    const states: UploadLifecycleItem[] = [];
    await expect(
      uploadMaskPng(
        gateway,
        { blob, purpose: "mask", width: 64, height: 32, targetSlot: 0 },
        (item) => states.push(item),
        "local-mask-failure"
      )
    ).rejects.toMatchObject({ status: "expired" });
    expect(states.at(-1)).toMatchObject({
      status: "expired",
      uploadResourceId: "upload-mask-failure"
    });
    expect(draft.mask).toBeUndefined();
    expect(draft.maskUpload).toBeUndefined();
    expect(blob.size).toBeGreaterThan(0);
  });
});
