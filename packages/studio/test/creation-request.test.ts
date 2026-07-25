import { describe, expect, it } from "vitest";

import {
  buildStudioCreationRequest,
  CreationDraftError,
  createInitialCreationDraft,
  normalizeVisibleControls,
  type CreationDraft
} from "../src/features/creation";

const defaults = {
  model: "mock-image-model",
  size: "auto" as const,
  aspectRatio: "auto" as const,
  quality: "high" as const,
  format: "png" as const,
  count: 1 as const,
  partialImages: 2 as const,
  transparentMode: "off" as const,
  moderation: "low" as const,
  saveToLibrary: true
};

describe("path-free Studio generation request construction", () => {
  it("constructs a text-only generate request with visible output controls only", () => {
    const request = buildStudioCreationRequest({
      ...createInitialCreationDraft(defaults),
      prompt: "A precise amber-lit product photograph",
      controls: {
        size: "1024x1024",
        aspectRatio: "auto",
        format: "png",
        count: 2,
        transparentMode: "native"
      }
    });

    expect(request).toEqual({
      kind: "generate",
      prompt: "A precise amber-lit product photograph",
      size: "1024x1024",
      aspectRatio: "auto",
      format: "png",
      count: 2,
      transparentMode: "native"
    });
    expect(JSON.stringify(request)).not.toMatch(
      /quality|compression|partialImages|moderation|saveToLibrary|model|previousResponse|references|imageIds|fileIds|target|mask|data:image|base64|Authorization|api[_-]?key|rawBytes/u
    );
  });

  it("enforces size and aspect ratio as mutually exclusive browser controls", () => {
    const draft: CreationDraft = {
      ...createInitialCreationDraft(defaults),
      prompt: "A clean Studio submission",
      controls: {
        size: "1024x1024",
        aspectRatio: "portrait",
        format: "png",
        count: 1,
        transparentMode: "off"
      }
    };

    expect(() => buildStudioCreationRequest(draft)).toThrow(CreationDraftError);
    expect(normalizeVisibleControls(draft.controls)).toMatchObject({
      size: "auto",
      aspectRatio: "auto"
    });
  });

  it("forces transparent output to PNG and disables transparency for JPEG or WebP", () => {
    expect(
      normalizeVisibleControls({
        size: "auto",
        aspectRatio: "auto",
        format: "webp",
        count: 1,
        transparentMode: "native"
      })
    ).toMatchObject({ format: "png", transparentMode: "native" });

    expect(
      normalizeVisibleControls({
        size: "auto",
        aspectRatio: "auto",
        format: "jpeg",
        count: 1,
        transparentMode: "off"
      })
    ).toMatchObject({ format: "jpeg", transparentMode: "off" });
  });

  it("blocks empty prompts and keeps the workbench generation-only", () => {
    expect(() => buildStudioCreationRequest(createInitialCreationDraft(defaults))).toThrow(
      CreationDraftError
    );
    expect(
      buildStudioCreationRequest({
        ...createInitialCreationDraft(defaults),
        prompt: "A generation-only Studio request"
      })
    ).toMatchObject({ kind: "generate" });
  });
});
