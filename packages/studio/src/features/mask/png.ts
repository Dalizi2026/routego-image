import { maskBitmapToRgba, type MaskBitmap } from "./bitmap";

export interface MaskCanvasContext {
  createImageData(width: number, height: number): ImageData;
  putImageData(imageData: ImageData, x: number, y: number): void;
}

export interface MaskCanvas {
  width: number;
  height: number;
  getContext(contextId: "2d"): MaskCanvasContext | null;
  toBlob(callback: (blob: Blob | null) => void, type?: string): void;
}

export type MaskCanvasFactory = (width: number, height: number) => MaskCanvas;

function browserMaskCanvas(width: number, height: number): MaskCanvas {
  if (typeof document === "undefined") {
    throw new Error("Mask PNG encoding requires a browser canvas.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function writeMaskBitmapToCanvas(
  context: MaskCanvasContext,
  mask: MaskBitmap,
  color?: readonly [number, number, number]
): void {
  const imageData = context.createImageData(mask.width, mask.height);
  imageData.data.set(maskBitmapToRgba(mask, color));
  context.putImageData(imageData, 0, 0);
}

export async function encodeMaskPng(
  mask: MaskBitmap,
  createCanvas: MaskCanvasFactory = browserMaskCanvas
): Promise<Blob> {
  const canvas = createCanvas(mask.width, mask.height);
  canvas.width = mask.width;
  canvas.height = mask.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("The browser could not initialize the mask canvas.");
  }
  writeMaskBitmapToCanvas(context, mask, [255, 255, 255]);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
  if (!blob || blob.size === 0 || blob.type !== "image/png") {
    throw new Error("The browser could not encode a valid PNG mask.");
  }
  return blob;
}
