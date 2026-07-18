import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { LibraryAssetDetail, LibraryOperationParameters } from "@routego-image/contracts";

import { createStudioLibraryHandoffTransition } from "../src/app";
import {
  collectCreationDraftUploads,
  isIdentifierOnlyCreationExternalHandoff,
  shouldConsumeCreationExternalHandoff,
  type CreationDraft,
  type CreationExternalHandoff,
  type UploadLifecycleItem
} from "../src/features/creation";
import {
  createLibraryEditHandoff,
  createLibraryRetryHandoff,
  isIdentifierOnlyLibraryHandoff
} from "../src/features/library";

const parameters: LibraryOperationParameters = {
  kind: "edit",
  prompt: "Preserve the subject and refine the cool studio light.",
  references: [{ assetId: "asset-reference-01", role: "style", label: "Lighting" }],
  target: { assetId: "asset-target-01", label: "Target" },
  supportingImages: [
    { assetId: "asset-supporting-01", role: "supporting", label: "Supporting" }
  ],
  maskAssetId: "asset-mask-01",
  invariants: {
    allowedChanges: ["lighting"],
    preserve: ["subject"],
    forbiddenChanges: ["identity"]
  },
  size: "1024x1024",
  aspectRatio: "square",
  quality: "high",
  format: "png",
  count: 1,
  partialImages: 0,
  transparentMode: "off",
  moderation: "auto",
  action: "edit",
  previousResponseId: "response-01",
  imageIds: [],
  fileIds: [],
  outputDirectoryMode: "default",
  saveToLibrary: true
};

const asset = {
  id: "asset-result-01",
  prompt: parameters.prompt,
  effectiveParams: parameters
} as unknown as LibraryAssetDetail;

function upload(id: string): UploadLifecycleItem {
  return {
    id,
    purpose: "image",
    source: { name: `${id}.png`, blob: new Blob([id], { type: "image/png" }) },
    status: "ready",
    uploadResourceId: `resource-${id}`
  };
}

describe("Library retry/edit handoff", () => {
  it("creates identifier-only retry and edit drafts and routes them to Workbench", () => {
    const retry = createLibraryRetryHandoff(asset);
    const edit = createLibraryEditHandoff(asset);

    expect(retry.draft).toMatchObject({
      mode: "edit",
      target: { locator: { source: "asset", assetId: "asset-target-01" } },
      mask: { image: { source: "asset", assetId: "asset-mask-01" }, targetSlot: 0 }
    });
    expect(edit.draft).toMatchObject({
      mode: "edit",
      target: { locator: { source: "asset", assetId: "asset-result-01" } }
    });
    expect(isIdentifierOnlyLibraryHandoff(retry)).toBe(true);

    const transition = createStudioLibraryHandoffTransition(retry, 3);
    expect(transition.route).toBe("workbench");
    expect(transition.handoff.id).toBe("library:3:retry");
    expect(isIdentifierOnlyCreationExternalHandoff(transition.handoff)).toBe(true);
    expect(JSON.stringify(transition)).not.toMatch(
      /(?:path|file:\/\/|[A-Za-z]:\\|\/Users\/|data:image|base64)/iu
    );
  });

  it("consumes each stable handoff once and rejects path-shaped or temporary resource payloads", () => {
    const transition = createStudioLibraryHandoffTransition(
      createLibraryRetryHandoff(asset),
      1
    );
    expect(shouldConsumeCreationExternalHandoff(transition.handoff, undefined)).toBe(true);
    expect(
      shouldConsumeCreationExternalHandoff(transition.handoff, transition.handoff.id)
    ).toBe(false);

    const unsafe = {
      ...transition.handoff,
      draft: {
        ...transition.handoff.draft,
        target: {
          ...transition.handoff.draft.target!,
          locator: {
            source: "asset",
            assetId: "asset-target-01",
            path: "C:\\private\\target.png"
          }
        }
      }
    } as unknown as CreationExternalHandoff;
    expect(isIdentifierOnlyCreationExternalHandoff(unsafe)).toBe(false);

    const temporary = {
      ...transition.handoff,
      draft: {
        ...transition.handoff.draft,
        target: {
          ...transition.handoff.draft.target!,
          upload: upload("temporary-target")
        }
      }
    };
    expect(isIdentifierOnlyCreationExternalHandoff(temporary)).toBe(false);
  });

  it("collects every replaced upload and mask exactly once for existing cleanup", () => {
    const shared = upload("shared");
    const target = upload("target");
    const supporting = upload("supporting");
    const mask = { ...upload("mask"), purpose: "mask" as const };
    const draft = {
      ...createLibraryRetryHandoff(asset).draft,
      references: [
        { id: "reference-upload", role: "reference" as const, upload: shared },
        { id: "reference-duplicate", role: "reference" as const, upload: shared }
      ],
      target: { id: "target-upload", role: "previous-output" as const, upload: target },
      supportingImages: [
        { id: "supporting-upload", role: "supporting" as const, upload: supporting }
      ],
      maskUpload: mask
    } satisfies CreationDraft;

    expect(collectCreationDraftUploads([draft]).map((item) => item.id)).toEqual([
      "shared",
      "target",
      "supporting",
      "mask"
    ]);
  });

  it("keeps the integration free of storage, URL payload, and global event channels", () => {
    const sources = [
      "../src/app/StudioApp.tsx",
      "../src/features/library/handoff.ts",
      "../src/features/creation/CreationWorkbench.tsx"
    ]
      .map((relative) => readFileSync(new URL(relative, import.meta.url), "utf8"))
      .join("\n");

    expect(sources).not.toMatch(/localStorage|sessionStorage|indexedDB/iu);
    expect(sources).not.toMatch(/new URLSearchParams|location\.(?:hash|search)|history\.(?:push|replace)State/iu);
    expect(sources).not.toMatch(/window\.(?:addEventListener|dispatchEvent)|CustomEvent/iu);
    expect(sources).toContain('hidden={state.route !== "workbench"}');
  });
});
