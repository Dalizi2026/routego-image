import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { StudioLibrarySearchItem } from "@routego-image/contracts";

import type { StudioGateway } from "../src/api";
import { GalleryCard } from "../src/features/library";

const item: StudioLibrarySearchItem = {
  assetId: "asset-gallery-01",
  artifactId: "artifact-gallery-01",
  prompt: "This prompt belongs in detail only",
  model: "image-2",
  kind: "generate",
  mimeType: "image/jpeg",
  width: 2048,
  height: 2048,
  status: "succeeded",
  folderIds: [],
  createdAt: "2026-07-28T08:00:00.000Z",
  currentMark: false
};

describe("sidebar-first Library gallery markup", () => {
  it("keeps prompts out of thumbnail text while retaining accessible detail labels", () => {
    const markup = renderToStaticMarkup(
      createElement(GalleryCard, {
        gateway: {} as StudioGateway,
        item,
        labels: {
          selectItem: "Select Library item",
          openDetail: "Open detail",
          noPreview: "No protected thumbnail"
        },
        language: "en",
        detailSelected: false,
        checked: false,
        onCheckedChange: () => undefined,
        onOpen: () => undefined
      })
    );
    const visibleText = markup.replace(/<[^>]+>/gu, " ");

    expect(markup).toContain('aria-label="Open detail: This prompt belongs in detail only"');
    expect(visibleText).not.toContain(item.prompt);
    expect(markup).toContain("2048 × 2048");
    expect(markup).toContain("image-2");
    expect(markup).not.toContain("library-card__body");
  });
});
