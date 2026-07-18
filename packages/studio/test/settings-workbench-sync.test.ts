import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { ProviderCapability, ReadSettingsResult } from "@routego-image/contracts";

import type { CapabilityResolver } from "../src/features/capabilities";
import {
  creationDefaultsFingerprint,
  synchronizeBatchDraftDefaults,
  synchronizeCreationDraftDefaults,
  type BatchDraftItem,
  type CreationDraft,
  type UploadLifecycleItem
} from "../src/features/creation";

const originalDefaults: ReadSettingsResult["defaults"] = {
  model: "synthetic-model-a",
  size: "auto",
  aspectRatio: "auto",
  quality: "auto",
  format: "png",
  count: 1,
  partialImages: 0,
  transparentMode: "off",
  moderation: "auto",
  saveToLibrary: true
};

const nextDefaults: ReadSettingsResult["defaults"] = {
  model: "synthetic-model-b",
  size: "1536x1024",
  aspectRatio: "3:2",
  quality: "high",
  format: "webp",
  count: 3,
  partialImages: 2,
  transparentMode: "chromakey",
  moderation: "low",
  saveToLibrary: false
};

function upload(id: string, purpose: UploadLifecycleItem["purpose"] = "image"): UploadLifecycleItem {
  return {
    id,
    purpose,
    source: { name: `${id}.png`, blob: new Blob([id], { type: "image/png" }) },
    status: "ready",
    uploadResourceId: `resource-${id}`
  };
}

const referenceUpload = upload("reference");
const targetUpload = upload("target");
const supportingUpload = upload("supporting");
const maskUpload = upload("mask", "mask");

const draft: CreationDraft = {
  mode: "edit",
  prompt: "Preserve this mounted workbench draft.",
  references: [
    { id: "reference-01", role: "style", label: "Reference", upload: referenceUpload }
  ],
  target: { id: "target-01", role: "previous-output", upload: targetUpload },
  supportingImages: [
    { id: "supporting-01", role: "supporting", upload: supportingUpload }
  ],
  mask: {
    image: { source: "upload", uploadResourceId: "resource-mask" },
    targetSlot: 0
  },
  maskUpload,
  invariants: {
    allowedChanges: ["lighting"],
    preserve: ["identity"],
    forbiddenChanges: ["composition"]
  },
  controls: {
    size: originalDefaults.size,
    aspectRatio: originalDefaults.aspectRatio,
    quality: originalDefaults.quality,
    format: "jpeg",
    compression: 73,
    count: originalDefaults.count,
    partialImages: originalDefaults.partialImages,
    transparentMode: originalDefaults.transparentMode,
    moderation: originalDefaults.moderation,
    action: "edit",
    previousResponseId: "response-synthetic-01",
    saveToLibrary: originalDefaults.saveToLibrary
  }
};

function supportedResolver() {
  return vi.fn((capability: ProviderCapability) => ({
    capability,
    state: "supported" as const,
    enabled: true
  })) satisfies CapabilityResolver;
}

describe("mounted workbench defaults synchronization", () => {
  it("updates only default-derived controls and preserves every resource-bearing field", () => {
    const resolve = supportedResolver();
    const synchronized = synchronizeCreationDraftDefaults(draft, nextDefaults, resolve);

    expect(synchronized.controls).toMatchObject({
      size: "1536x1024",
      aspectRatio: "3:2",
      quality: "high",
      format: "webp",
      count: 3,
      partialImages: 2,
      transparentMode: "chromakey",
      moderation: "low",
      saveToLibrary: false
    });
    expect(synchronized.controls).toMatchObject({
      compression: 73,
      action: "edit",
      previousResponseId: "response-synthetic-01"
    });
    expect(synchronized.prompt).toBe(draft.prompt);
    expect(synchronized.references).toBe(draft.references);
    expect(synchronized.target).toBe(draft.target);
    expect(synchronized.supportingImages).toBe(draft.supportingImages);
    expect(synchronized.mask).toBe(draft.mask);
    expect(synchronized.maskUpload).toBe(maskUpload);
    expect(synchronized.invariants).toBe(draft.invariants);
    expect(synchronized.references[0]?.upload).toBe(referenceUpload);
    expect(synchronized.target?.upload).toBe(targetUpload);
    expect(synchronized.supportingImages[0]?.upload).toBe(supportingUpload);
    expect(resolve).toHaveBeenCalled();
  });

  it("updates preserved single and ordered batch drafts without changing task identity", () => {
    const resolve = supportedResolver();
    const items: readonly BatchDraftItem[] = [
      { id: "batch-a", draft },
      { id: "batch-b", draft: { ...draft, prompt: "Second task" } }
    ];
    const synchronizedSingle = synchronizeCreationDraftDefaults(draft, nextDefaults, resolve);
    const synchronizedBatch = synchronizeBatchDraftDefaults(items, nextDefaults, resolve);

    expect(synchronizedSingle.prompt).toBe(draft.prompt);
    expect(synchronizedBatch.map((item) => item.id)).toEqual(["batch-a", "batch-b"]);
    expect(synchronizedBatch.map((item) => item.draft.prompt)).toEqual([
      draft.prompt,
      "Second task"
    ]);
    expect(synchronizedBatch.every((item) => item.draft.controls.quality === "high")).toBe(true);
    expect(synchronizedBatch[0]?.draft.maskUpload).toBe(maskUpload);
  });

  it("reapplies capability normalization only to incoming default-derived fields", () => {
    const unsupported = vi.fn((capability: ProviderCapability) => ({
      capability,
      state: "unknown" as const,
      enabled: false,
      unavailableMessage: "当前中转未确认支持"
    })) satisfies CapabilityResolver;
    const synchronized = synchronizeCreationDraftDefaults(draft, nextDefaults, unsupported);

    expect(synchronized.controls).toMatchObject({
      size: "auto",
      aspectRatio: "auto",
      quality: "auto",
      format: "png",
      count: 1,
      partialImages: 0,
      transparentMode: "off",
      moderation: "auto",
      saveToLibrary: false,
      compression: 73,
      action: "edit",
      previousResponseId: "response-synthetic-01"
    });
  });

  it("uses a stable guard so equivalent defaults do not churn mounted state", () => {
    expect(creationDefaultsFingerprint(originalDefaults)).toBe(
      creationDefaultsFingerprint({ ...originalDefaults })
    );
    expect(creationDefaultsFingerprint(originalDefaults)).toBe(
      creationDefaultsFingerprint({ ...originalDefaults, model: "another-model-only" })
    );
    expect(creationDefaultsFingerprint(originalDefaults)).not.toBe(
      creationDefaultsFingerprint({ ...originalDefaults, quality: "high" })
    );
  });

  it("contains no remount, resource discard, gateway dispatch, or unrelated state reset seam", () => {
    const source = readFileSync(
      new URL("../src/features/creation/CreationWorkbench.tsx", import.meta.url),
      "utf8"
    );
    const start = source.indexOf("useEffect(() => {\n    if (appliedDefaultsFingerprintRef.current");
    const end = source.indexOf("if (maskEditorOpen", start + 20);
    const seam = source.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(seam).toContain("synchronizeCreationDraftDefaults");
    expect(seam).toContain("synchronizeBatchDraftDefaults");
    expect(seam).not.toMatch(/discard|gateway\.invoke|setSubmission|setWorkflow|setSelectedBatchId/iu);
    expect(source).not.toMatch(/key=\{[^}]*defaults/iu);
  });
});
