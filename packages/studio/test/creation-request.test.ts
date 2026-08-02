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

  it("keeps an exact saved size when its descriptive aspect ratio is also present", () => {
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

    const normalized = normalizeVisibleControls(draft.controls);
    expect(normalized).toMatchObject({
      size: "1024x1024",
      aspectRatio: "auto"
    });
    expect(buildStudioCreationRequest({ ...draft, controls: normalized })).toMatchObject({
      size: "1024x1024",
      aspectRatio: "auto"
    });
  });

  it("preserves a saved 4K square default rather than silently falling back to auto", () => {
    const draft = createInitialCreationDraft({
      ...defaults,
      size: "2880x2880",
      aspectRatio: "1:1"
    });
    expect(buildStudioCreationRequest({ ...draft, prompt: "A square 4K product render" })).toMatchObject({
      size: "2880x2880",
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
