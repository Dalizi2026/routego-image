import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";
import { PNG } from "pngjs";

import {
  ImageMaterializationError,
  type MaterializedImageOutput,
  type OutputMaterializationTransaction
} from "./materialize";

const MAX_DIMENSION_DRIFT_RATIO = 0.01;
const MAX_RESIZE_DIMENSION = 4_096;
const MAX_RESIZE_PIXELS = 16_777_216;
const MAX_SOURCE_DIMENSION = 8_192;
const MAX_SOURCE_PIXELS = 33_554_432;
const DEFAULT_JPEG_QUALITY = 90;

interface RgbaRaster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface NormalizePngDimensionsInput {
  readonly transaction: OutputMaterializationTransaction;
  readonly output: MaterializedImageOutput;
  readonly targetWidth: number;
  readonly targetHeight: number;
}

export interface NormalizeProviderRasterInput extends NormalizePngDimensionsInput {
  readonly targetMimeType: "image/png" | "image/jpeg";
}

function eligibleDimension(actual: number, target: number): boolean {
  return Math.abs(actual - target) / target <= MAX_DIMENSION_DRIFT_RATIO;
}

function eligibleResize(
  actualWidth: number,
  actualHeight: number,
  targetWidth: number,
  targetHeight: number
): boolean {
  if (
    eligibleDimension(actualWidth, targetWidth) &&
    eligibleDimension(actualHeight, targetHeight)
  ) {
    return true;
  }
  const actualRatio = actualWidth / actualHeight;
  const targetRatio = targetWidth / targetHeight;
  const ratioDrift = Math.abs(actualRatio - targetRatio) / targetRatio;
  return (
    actualWidth >= targetWidth &&
    actualHeight >= targetHeight &&
    ratioDrift <= MAX_DIMENSION_DRIFT_RATIO
  );
}

function validateTarget(width: number, height: number): void {
  const pixels = width * height;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_RESIZE_DIMENSION ||
    height > MAX_RESIZE_DIMENSION ||
    !Number.isSafeInteger(pixels) ||
    pixels > MAX_RESIZE_PIXELS
  ) {
    throw new ImageMaterializationError(
      "metadata-mismatch",
      "The requested PNG dimensions exceed the bounded normalization policy."
    );
  }
}

function validateSource(width: number, height: number): void {
  const pixels = width * height;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_SOURCE_DIMENSION ||
    height > MAX_SOURCE_DIMENSION ||
    !Number.isSafeInteger(pixels) ||
    pixels > MAX_SOURCE_PIXELS
  ) {
    throw new ImageMaterializationError(
      "metadata-mismatch",
      "The provider raster dimensions exceed the bounded normalization policy."
    );
  }
}

function sourceOffset(width: number, x: number, y: number): number {
  return (y * width + x) * 4;
}

function resampleBilinear(
  source: RgbaRaster,
  targetWidth: number,
  targetHeight: number
): RgbaRaster {
  const target = {
    width: targetWidth,
    height: targetHeight,
    data: new Uint8Array(targetWidth * targetHeight * 4)
  };
  const scaleX = source.width / targetWidth;
  const scaleY = source.height / targetHeight;
  const sourceX0 = new Int32Array(targetWidth);
  const sourceX1 = new Int32Array(targetWidth);
  const sourceXWeight = new Float64Array(targetWidth);

  for (let x = 0; x < targetWidth; x += 1) {
    const sourceX = (x + 0.5) * scaleX - 0.5;
    const floorX = Math.floor(sourceX);
    const x0 = Math.max(0, Math.min(source.width - 1, floorX));
    sourceX0[x] = x0;
    sourceX1[x] = Math.max(0, Math.min(source.width - 1, x0 + 1));
    sourceXWeight[x] = Math.max(0, Math.min(1, sourceX - floorX));
  }

  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = (y + 0.5) * scaleY - 0.5;
    const floorY = Math.floor(sourceY);
    const y0 = Math.max(0, Math.min(source.height - 1, floorY));
    const y1 = Math.max(0, Math.min(source.height - 1, y0 + 1));
    const yWeight = Math.max(0, Math.min(1, sourceY - floorY));
    const inverseYWeight = 1 - yWeight;
    for (let x = 0; x < targetWidth; x += 1) {
      const x0 = sourceX0[x]!;
      const x1 = sourceX1[x]!;
      const xWeight = sourceXWeight[x]!;
      const inverseXWeight = 1 - xWeight;
      const offset00 = sourceOffset(source.width, x0, y0);
      const offset10 = sourceOffset(source.width, x1, y0);
      const offset01 = sourceOffset(source.width, x0, y1);
      const offset11 = sourceOffset(source.width, x1, y1);
      const weight00 = inverseXWeight * inverseYWeight;
      const weight10 = xWeight * inverseYWeight;
      const weight01 = inverseXWeight * yWeight;
      const weight11 = xWeight * yWeight;
      const alpha00 = (source.data[offset00 + 3] ?? 0) / 255;
      const alpha10 = (source.data[offset10 + 3] ?? 0) / 255;
      const alpha01 = (source.data[offset01 + 3] ?? 0) / 255;
      const alpha11 = (source.data[offset11 + 3] ?? 0) / 255;
      const alphaWeight00 = alpha00 * weight00;
      const alphaWeight10 = alpha10 * weight10;
      const alphaWeight01 = alpha01 * weight01;
      const alphaWeight11 = alpha11 * weight11;
      const targetOffset = sourceOffset(targetWidth, x, y);
      const alpha = alphaWeight00 + alphaWeight10 + alphaWeight01 + alphaWeight11;
      const red =
        (source.data[offset00] ?? 0) * alphaWeight00 +
        (source.data[offset10] ?? 0) * alphaWeight10 +
        (source.data[offset01] ?? 0) * alphaWeight01 +
        (source.data[offset11] ?? 0) * alphaWeight11;
      const green =
        (source.data[offset00 + 1] ?? 0) * alphaWeight00 +
        (source.data[offset10 + 1] ?? 0) * alphaWeight10 +
        (source.data[offset01 + 1] ?? 0) * alphaWeight01 +
        (source.data[offset11 + 1] ?? 0) * alphaWeight11;
      const blue =
        (source.data[offset00 + 2] ?? 0) * alphaWeight00 +
        (source.data[offset10 + 2] ?? 0) * alphaWeight10 +
        (source.data[offset01 + 2] ?? 0) * alphaWeight01 +
        (source.data[offset11 + 2] ?? 0) * alphaWeight11;
      target.data[targetOffset] = alpha === 0 ? 0 : Math.round(red / alpha);
      target.data[targetOffset + 1] = alpha === 0 ? 0 : Math.round(green / alpha);
      target.data[targetOffset + 2] = alpha === 0 ? 0 : Math.round(blue / alpha);
      target.data[targetOffset + 3] = Math.round(alpha * 255);
    }
  }
  return target;
}

function decodeRaster(
  bytes: Uint8Array,
  mimeType: MaterializedImageOutput["mimeType"]
): RgbaRaster | undefined {
  if (mimeType === "image/png") {
    const decoded = PNG.sync.read(Buffer.from(bytes));
    return { width: decoded.width, height: decoded.height, data: decoded.data };
  }
  if (mimeType === "image/jpeg") {
    const decoded = decodeJpeg(Buffer.from(bytes), {
      useTArray: true,
      formatAsRGBA: true,
      tolerantDecoding: false,
      maxResolutionInMP: 34,
      maxMemoryUsageInMB: 512
    });
    return { width: decoded.width, height: decoded.height, data: decoded.data };
  }
  return undefined;
}

function encodePng(raster: RgbaRaster): Uint8Array {
  const png = new PNG({ width: raster.width, height: raster.height });
  png.data = Buffer.from(raster.data);
  return new Uint8Array(PNG.sync.write(png, {
    colorType: 6,
    inputColorType: 6,
    inputHasAlpha: true,
    bitDepth: 8,
    deflateLevel: 9,
    deflateStrategy: 3,
    filterType: 4
  }));
}

function flattenOnWhite(raster: RgbaRaster): RgbaRaster {
  const data = new Uint8Array(raster.data.length);
  for (let offset = 0; offset < raster.data.length; offset += 4) {
    const alpha = (raster.data[offset + 3] ?? 0) / 255;
    data[offset] = Math.round((raster.data[offset] ?? 0) * alpha + 255 * (1 - alpha));
    data[offset + 1] = Math.round((raster.data[offset + 1] ?? 0) * alpha + 255 * (1 - alpha));
    data[offset + 2] = Math.round((raster.data[offset + 2] ?? 0) * alpha + 255 * (1 - alpha));
    data[offset + 3] = 255;
  }
  return { width: raster.width, height: raster.height, data };
}

function encodeJpegRaster(raster: RgbaRaster): Uint8Array {
  return new Uint8Array(encodeJpeg(flattenOnWhite(raster), DEFAULT_JPEG_QUALITY).data);
}

export async function normalizeProviderRasterOutput(
  input: NormalizeProviderRasterInput
): Promise<MaterializedImageOutput | undefined> {
  validateTarget(input.targetWidth, input.targetHeight);
  validateSource(input.output.width, input.output.height);
  if (
    input.output.width === input.targetWidth &&
    input.output.height === input.targetHeight &&
    input.output.mimeType === input.targetMimeType
  ) {
    return input.output;
  }
  const supportedSource = input.targetMimeType === "image/png"
    ? input.output.mimeType === "image/png"
    : input.output.mimeType === "image/png" || input.output.mimeType === "image/jpeg";
  if (
    input.output.source !== "provider-original" ||
    !supportedSource ||
    !eligibleResize(
      input.output.width,
      input.output.height,
      input.targetWidth,
      input.targetHeight
    )
  ) {
    return undefined;
  }

  const bytes = await input.transaction.readValidatedBytes(input.output);
  const decoded = decodeRaster(bytes, input.output.mimeType);
  if (
    decoded === undefined ||
    decoded.width !== input.output.width ||
    decoded.height !== input.output.height
  ) {
    throw new ImageMaterializationError(
      "metadata-mismatch",
      "The decoded raster dimensions do not match the validated provider output."
    );
  }
  const normalized = decoded.width === input.targetWidth && decoded.height === input.targetHeight
    ? decoded
    : resampleBilinear(decoded, input.targetWidth, input.targetHeight);
  const encoded = input.targetMimeType === "image/png"
    ? encodePng(normalized)
    : encodeJpegRaster(normalized);
  return await input.transaction.stageReplacement(
    input.output,
    encoded,
    input.targetMimeType
  );
}

export async function normalizePngOutputDimensions(
  input: NormalizePngDimensionsInput
): Promise<MaterializedImageOutput | undefined> {
  return await normalizeProviderRasterOutput({ ...input, targetMimeType: "image/png" });
}
