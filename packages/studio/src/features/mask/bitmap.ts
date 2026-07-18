import type { MaskPoint } from "./viewport";

export type MaskTool = "brush" | "eraser";

export interface MaskBitmap {
  readonly width: number;
  readonly height: number;
  readonly alpha: Uint8ClampedArray;
}

const MAX_MASK_PIXELS = 67_108_864;

function checkedPixelCount(width: number, height: number): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError("Mask dimensions must be positive integers.");
  }
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_MASK_PIXELS) {
    throw new RangeError("The target image is too large for a safe browser mask canvas.");
  }
  return pixelCount;
}

export function createEmptyMaskBitmap(width: number, height: number): MaskBitmap {
  return {
    width,
    height,
    alpha: new Uint8ClampedArray(checkedPixelCount(width, height))
  };
}

export function cloneMaskBitmap(mask: MaskBitmap): MaskBitmap {
  const pixelCount = checkedPixelCount(mask.width, mask.height);
  if (mask.alpha.length !== pixelCount) {
    throw new RangeError("Mask alpha data does not match its dimensions.");
  }
  return {
    width: mask.width,
    height: mask.height,
    alpha: mask.alpha.slice()
  };
}

export function maskBitmapsEqual(left: MaskBitmap, right: MaskBitmap): boolean {
  if (
    left.width !== right.width ||
    left.height !== right.height ||
    left.alpha.length !== right.alpha.length
  ) {
    return false;
  }
  for (let index = 0; index < left.alpha.length; index += 1) {
    if (left.alpha[index] !== right.alpha[index]) {
      return false;
    }
  }
  return true;
}

export function countMaskPixels(mask: MaskBitmap): number {
  let count = 0;
  for (const alpha of mask.alpha) {
    if (alpha !== 0) {
      count += 1;
    }
  }
  return count;
}

export function isMaskBitmapEmpty(mask: MaskBitmap): boolean {
  return !mask.alpha.some((alpha) => alpha !== 0);
}

export function clearMaskBitmap(mask: MaskBitmap): number {
  let changed = 0;
  for (let index = 0; index < mask.alpha.length; index += 1) {
    if (mask.alpha[index] !== 0) {
      mask.alpha[index] = 0;
      changed += 1;
    }
  }
  return changed;
}

function paintDab(
  mask: MaskBitmap,
  center: MaskPoint,
  radius: number,
  value: 0 | 255
): number {
  const minimumX = Math.max(0, Math.floor(center.x - radius));
  const maximumX = Math.min(mask.width - 1, Math.ceil(center.x + radius));
  const minimumY = Math.max(0, Math.floor(center.y - radius));
  const maximumY = Math.min(mask.height - 1, Math.ceil(center.y + radius));
  const radiusSquared = radius * radius;
  let changed = 0;

  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) {
      const deltaX = x + 0.5 - center.x;
      const deltaY = y + 0.5 - center.y;
      if (deltaX * deltaX + deltaY * deltaY > radiusSquared) {
        continue;
      }
      const index = y * mask.width + x;
      if (mask.alpha[index] !== value) {
        mask.alpha[index] = value;
        changed += 1;
      }
    }
  }
  return changed;
}

export function paintMaskSegment(
  mask: MaskBitmap,
  from: MaskPoint,
  to: MaskPoint,
  brushSize: number,
  tool: MaskTool
): number {
  if (!Number.isFinite(brushSize) || brushSize < 1 || brushSize > 512) {
    throw new RangeError("Brush size must be between 1 and 512 image pixels.");
  }
  const radius = brushSize / 2;
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const sampleStep = Math.max(0.5, radius * 0.35);
  const steps = Math.max(1, Math.ceil(distance / sampleStep));
  const value = tool === "brush" ? 255 : 0;
  let changed = 0;

  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps;
    changed += paintDab(
      mask,
      {
        x: from.x + (to.x - from.x) * progress,
        y: from.y + (to.y - from.y) * progress
      },
      radius,
      value
    );
  }
  return changed;
}

export function maskBitmapToRgba(
  mask: MaskBitmap,
  color: readonly [number, number, number] = [255, 185, 76]
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(mask.alpha.length * 4);
  for (let index = 0; index < mask.alpha.length; index += 1) {
    const output = index * 4;
    data[output] = color[0];
    data[output + 1] = color[1];
    data[output + 2] = color[2];
    data[output + 3] = mask.alpha[index] ?? 0;
  }
  return data;
}
