import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { ReadSettingsResult } from "@routego-image/contracts";

import {
  buildStudioCreationRequest,
  creationDefaultsFingerprint,
  createInitialCreationDraft,
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
  aspectRatio: "auto",
  quality: "high",
  format: "webp",
  count: 3,
  partialImages: 2,
  transparentMode: "off",
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

const legacyDraft: CreationDraft = {
  mode: "edit",
  prompt: "Preserve this mounted prompt.",
  references: [{ id: "reference-01", role: "style", label: "Reference", upload: upload("reference") }],
  target: { id: "target-01", role: "previous-output", upload: upload("target") },
  supportingImages: [{ id: "supporting-01", role: "supporting", upload: upload("supporting") }],
  mask: {
    image: { source: "upload", uploadResourceId: "resource-mask" },
    targetSlot: 0
  },
  maskUpload: upload("mask", "mask"),
  invariants: {
    allowedChanges: ["lighting"],
    preserve: ["identity"],
    forbiddenChanges: ["composition"]
  },
  controls: {
    size: originalDefaults.size,
    aspectRatio: originalDefaults.aspectRatio,
    format: "png",
    count: originalDefaults.count,
    transparentMode: originalDefaults.transparentMode,
    quality: "high",
    compression: 73,
    partialImages: 2,
    moderation: "low",
    action: "edit",
    previousResponseId: "response-synthetic-01",
    saveToLibrary: false
  }
};

describe("mounted generation workbench defaults synchronization", () => {
  it("updates only visible generation controls and removes resource-bearing edit state", () => {
    const synchronized = synchronizeCreationDraftDefaults(legacyDraft, nextDefaults);

    expect(synchronized).toMatchObject({
      mode: "generate",
      prompt: legacyDraft.prompt,
      references: [],
      target: undefined,
      supportingImages: [],
      mask: undefined,
      maskUpload: undefined,
      invariants: { allowedChanges: [], preserve: [], forbiddenChanges: [] },
      controls: {
        size: "1536x1024",
        aspectRatio: "auto",
        format: "webp",
        count: 3,
        transparentMode: "off"
      }
    });
    expect(buildStudioCreationRequest({ ...synchronized, prompt: "Prompt" })).not.toHaveProperty(
      "quality"
    );
    expect(buildStudioCreationRequest({ ...synchronized, prompt: "Prompt" })).not.toHaveProperty(
      "partialImages"
    );
    expect(buildStudioCreationRequest({ ...synchronized, prompt: "Prompt" })).not.toHaveProperty(
      "moderation"
    );
    expect(buildStudioCreationRequest({ ...synchronized, prompt: "Prompt" })).not.toHaveProperty(
      "saveToLibrary"
    );
    expect(buildStudioCreationRequest({ ...synchronized, prompt: "Prompt" })).not.toHaveProperty(
      "previousResponseId"
    );
  });

  it("updates preserved single and ordered batch prompts without changing task identity", () => {
    const items: readonly BatchDraftItem[] = [
      { id: "batch-a", draft: legacyDraft },
      { id: "batch-b", draft: { ...legacyDraft, prompt: "Second task" } }
    ];
    const synchronizedSingle = synchronizeCreationDraftDefaults(legacyDraft, nextDefaults);
    const synchronizedBatch = synchronizeBatchDraftDefaults(items, nextDefaults);

    expect(synchronizedSingle.prompt).toBe(legacyDraft.prompt);
    expect(synchronizedBatch.map((item) => item.id)).toEqual(["batch-a", "batch-b"]);
    expect(synchronizedBatch.map((item) => item.draft.prompt)).toEqual([
      legacyDraft.prompt,
      "Second task"
    ]);
    expect(synchronizedBatch.every((item) => item.draft.mode === "generate")).toBe(true);
  });

  it("keeps hidden Settings defaults out of the browser request after synchronization", () => {
    const request = buildStudioCreationRequest({
      ...synchronizeCreationDraftDefaults(createInitialCreationDraft(originalDefaults), nextDefaults),
      prompt: "A generation-only request"
    });

    expect(request).toEqual({
      kind: "generate",
      prompt: "A generation-only request",
      size: "1536x1024",
      aspectRatio: "auto",
      format: "webp",
      count: 3,
      transparentMode: "off"
    });
    expect(JSON.stringify(request)).not.toMatch(
      /model|quality|partialImages|moderation|saveToLibrary|compression/u
    );
  });

  it("uses a stable guard so hidden-only defaults do not churn mounted state", () => {
    expect(creationDefaultsFingerprint(originalDefaults)).toBe(
      creationDefaultsFingerprint({ ...originalDefaults })
    );
    expect(creationDefaultsFingerprint(originalDefaults)).toBe(
      creationDefaultsFingerprint({ ...originalDefaults, model: "another-model-only" })
    );
    expect(creationDefaultsFingerprint(originalDefaults)).toBe(
      creationDefaultsFingerprint({ ...originalDefaults, quality: "high" })
    );
    expect(creationDefaultsFingerprint(originalDefaults)).not.toBe(
      creationDefaultsFingerprint({ ...originalDefaults, format: "webp" })
    );
  });

  it("contains no remount, upload, mask, batch, capability, retry, or hidden-control submission seam", () => {
    const source = readFileSync(
      new URL("../src/features/creation/CreationWorkbench.tsx", import.meta.url),
      "utf8"
    ).replace(/\r\n?/gu, "\n");
    expect(source).toContain("synchronizeCreationDraftDefaults");
    expect(source).not.toMatch(/BatchEditor|CapabilityLedger|CapabilityHint|MaskEditor|FileDropzone/iu);
    expect(source).not.toMatch(/quality|compression|partialImages|moderation|saveToLibrary/iu);
    expect(source).not.toMatch(/continueEdit|retryRequest|createEditHandoff/iu);
    expect(source).not.toMatch(/key=\{[^}]*defaults/iu);
  });
});
