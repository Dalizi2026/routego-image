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
  type CreationDraft
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

const legacyDraft: CreationDraft = {
  mode: "generate",
  prompt: "Preserve this mounted prompt.",
  controls: {
    size: originalDefaults.size,
    aspectRatio: originalDefaults.aspectRatio,
    format: "png",
    count: originalDefaults.count,
    transparentMode: originalDefaults.transparentMode,
  }
};

describe("mounted generation workbench defaults synchronization", () => {
  it("updates only visible generation controls", () => {
    const synchronized = synchronizeCreationDraftDefaults(legacyDraft, nextDefaults);

    expect(synchronized).toMatchObject({
      mode: "generate",
      prompt: legacyDraft.prompt,
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
      { id: "batch-a", prompt: legacyDraft.prompt, size: legacyDraft.controls.size, aspectRatio: legacyDraft.controls.aspectRatio, count: legacyDraft.controls.count },
      { id: "batch-b", prompt: "Second task", size: legacyDraft.controls.size, aspectRatio: legacyDraft.controls.aspectRatio, count: legacyDraft.controls.count }
    ];
    const synchronizedSingle = synchronizeCreationDraftDefaults(legacyDraft, nextDefaults);
    const synchronizedBatch = synchronizeBatchDraftDefaults(items, nextDefaults);

    expect(synchronizedSingle.prompt).toBe(legacyDraft.prompt);
    expect(synchronizedBatch.map((item) => item.id)).toEqual(["batch-a", "batch-b"]);
    expect(synchronizedBatch.map((item) => item.prompt)).toEqual([
      legacyDraft.prompt,
      "Second task"
    ]);
    expect(synchronizedBatch.every((item) => item.count === 3)).toBe(true);
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
