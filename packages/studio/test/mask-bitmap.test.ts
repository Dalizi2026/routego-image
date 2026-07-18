import { describe, expect, it } from "vitest";

import {
  clearMaskBitmap,
  countMaskPixels,
  createEmptyMaskBitmap,
  isMaskBitmapEmpty,
  maskBitmapToRgba,
  paintMaskSegment
} from "../src/features/mask/bitmap";

describe("mask alpha bitmap", () => {
  it("draws a continuous brush stroke in image coordinates", () => {
    const mask = createEmptyMaskBitmap(32, 8);
    const sourceSentinel = new Uint8ClampedArray([11, 22, 33, 44]);
    paintMaskSegment(mask, { x: 2, y: 4 }, { x: 30, y: 4 }, 3, "brush");
    for (let x = 2; x < 30; x += 1) {
      expect(mask.alpha[3 * mask.width + x]).toBe(255);
    }
    expect(sourceSentinel).toEqual(new Uint8ClampedArray([11, 22, 33, 44]));
  });

  it("erases only covered alpha pixels and supports clear", () => {
    const mask = createEmptyMaskBitmap(20, 20);
    paintMaskSegment(mask, { x: 4, y: 10 }, { x: 16, y: 10 }, 8, "brush");
    const painted = countMaskPixels(mask);
    paintMaskSegment(mask, { x: 10, y: 10 }, { x: 10, y: 10 }, 4, "eraser");
    expect(countMaskPixels(mask)).toBeLessThan(painted);
    expect(clearMaskBitmap(mask)).toBeGreaterThan(0);
    expect(isMaskBitmapEmpty(mask)).toBe(true);
  });

  it("changes overlay presentation bytes without changing stored alpha", () => {
    const mask = createEmptyMaskBitmap(2, 1);
    mask.alpha[0] = 255;
    const before = mask.alpha.slice();
    expect(maskBitmapToRgba(mask, [1, 2, 3])).toEqual(
      new Uint8ClampedArray([1, 2, 3, 255, 1, 2, 3, 0])
    );
    expect(mask.alpha).toEqual(before);
  });
});
