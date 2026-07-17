import { describe, expect, it } from "vitest";

import {
  buildStudioCreationRequest,
  CreationDraftError,
  createInitialCreationDraft,
  type CreationDraft
} from "../src/features/creation";

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

describe("path-free Studio creation request construction", () => {
  it("constructs a text-only generate request with complete output controls", () => {
    const request = buildStudioCreationRequest({
      ...createInitialCreationDraft(defaults),
      prompt: "A precise amber-lit product photograph"
    });
    expect(request).toMatchObject({
      kind: "generate",
      prompt: "A precise amber-lit product photograph",
      references: [],
      format: "png",
      count: 1,
      saveToLibrary: true
    });
    expect(JSON.stringify(request)).not.toMatch(
      /(?:C:\\|\/Users\/|data:image|base64|Authorization|api[_-]?key|rawBytes)/u
    );
  });

  it("keeps ordered upload locators and edit invariants without paths", () => {
    const draft: CreationDraft = {
      ...createInitialCreationDraft(defaults),
      mode: "edit",
      prompt: "Replace only the sky",
      references: [
        {
          id: "ref-1",
          role: "style",
          locator: { source: "upload", uploadResourceId: "upload-reference" }
        }
      ],
      target: {
        id: "target-1",
        role: "previous-output",
        locator: { source: "artifact", artifactId: "artifact-target" }
      },
      supportingImages: [
        {
          id: "support-1",
          role: "supporting",
          locator: { source: "asset", assetId: "asset-support" }
        }
      ],
      invariants: {
        allowedChanges: ["sky color"],
        preserve: ["subject", "text"],
        forbiddenChanges: ["layout"]
      }
    };
    const request = buildStudioCreationRequest(draft);
    expect(request).toMatchObject({
      kind: "edit",
      target: { source: "artifact", artifactId: "artifact-target" },
      references: [{ image: { uploadResourceId: "upload-reference" } }],
      supportingImages: [{ image: { assetId: "asset-support" } }]
    });
    expect(JSON.stringify(request)).not.toContain("path");
  });

  it("blocks incomplete uploads and empty edit invariants without mutating the draft", () => {
    const draft: CreationDraft = {
      ...createInitialCreationDraft(defaults),
      mode: "edit",
      prompt: "Edit safely",
      target: {
        id: "target-upload",
        role: "previous-output",
        upload: {
          id: "target-upload",
          purpose: "target",
          source: { name: "synthetic.png", blob: new Blob(["x"], { type: "image/png" }) },
          status: "uploading"
        }
      }
    };
    expect(() => buildStudioCreationRequest(draft)).toThrow(CreationDraftError);
    expect(draft.target?.upload?.status).toBe("uploading");
  });
});
