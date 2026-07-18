import { describe, expect, it } from "vitest";

import {
  fitMaskViewport,
  imagePointToScreen,
  panMaskViewport,
  screenPointToImage,
  wheelMaskZoom,
  zoomMaskViewportAt
} from "../src/features/mask/viewport";

describe("mask viewport geometry", () => {
  it("fits and centers the target without changing its aspect ratio", () => {
    expect(
      fitMaskViewport({ width: 1_000, height: 500 }, { width: 500, height: 500 }, 0)
    ).toEqual({ scale: 0.5, offsetX: 0, offsetY: 125 });
  });

  it("keeps the image coordinate under the cursor stable while zooming", () => {
    const before = { scale: 1, offsetX: 0, offsetY: 0 };
    const cursor = { x: 250, y: 200 };
    const imagePoint = screenPointToImage(cursor, before);
    const after = zoomMaskViewportAt(
      before,
      cursor,
      2,
      { width: 1_000, height: 1_000 },
      { width: 500, height: 400 }
    );
    expect(imagePointToScreen(imagePoint, after)).toEqual(cursor);
  });

  it("bounds explicit panning so the transformed plate cannot be lost", () => {
    const panned = panMaskViewport(
      { scale: 1, offsetX: 0, offsetY: 0 },
      { x: 10_000, y: -10_000 },
      { width: 1_000, height: 1_000 },
      { width: 500, height: 500 }
    );
    expect(panned.offsetX).toBe(48);
    expect(panned.offsetY).toBe(500 - 48 - 1_000);
  });

  it("maps screen coordinates back to image pixels after pan and zoom", () => {
    const viewport = { scale: 2.5, offsetX: -120, offsetY: 45 };
    const imagePoint = { x: 73.25, y: 21.5 };
    const screenPoint = imagePointToScreen(imagePoint, viewport);
    expect(screenPointToImage(screenPoint, viewport)).toEqual(imagePoint);
    expect(wheelMaskZoom(1, -320)).toBe(2);
  });
});
