import { PNG } from "pngjs";

import {
  ImageMaterializationError,
  type MaterializedImageOutput,
  type OutputMaterializationTransaction
} from "./materialize";

export const MAX_CHROMAKEY_DIMENSION = 4_096;
export const MAX_CHROMAKEY_PIXELS = 4 * 1_024 * 1_024;
export const MAX_CHROMAKEY_RGBA_BYTES = 16 * 1_024 * 1_024;

export type ChromakeyContentClass =
  | "simple"
  | "hair"
  | "fur"
  | "glass"
  | "smoke"
  | "liquid"
  | "uncertain-edges"
  | "unknown";

export interface ChromakeyColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

export interface ApplyPngChromakeyInput {
  readonly transaction: OutputMaterializationTransaction;
  readonly output: MaterializedImageOutput;
  readonly requestedMode: "chromakey" | "auto";
  readonly autoEligible?: boolean;
  readonly contentClass: ChromakeyContentClass;
  readonly keyColor: ChromakeyColor;
  readonly tolerance: number;
}

export type ChromakeyRefusalReason =
  | "non-png"
  | "auto-ineligible"
  | "complex-content"
  | "key-not-found"
  | "key-dominates-image";

export interface ChromakeyWarning {
  readonly code:
    | "chromakey_non_png"
    | "chromakey_auto_ineligible"
    | "chromakey_complex_content"
    | "chromakey_key_not_found"
    | "chromakey_unsafe_coverage"
    | "chromakey_processing_failed";
  readonly safeMessage: string;
}

export type PngChromakeyResult =
  | {
      readonly status: "applied";
      readonly output: MaterializedImageOutput;
      readonly transparencyApplied: true;
      readonly removedPixels: number;
      readonly requestedMode: "chromakey" | "auto";
      readonly effectiveMode: "chromakey";
      readonly degraded: true;
      readonly warning?: never;
      readonly postProcessingError?: never;
    }
  | {
      readonly status: "refused";
      readonly output: MaterializedImageOutput;
      readonly transparencyApplied: false;
      readonly removedPixels: 0;
      readonly reason: ChromakeyRefusalReason;
      readonly requestedMode: "chromakey" | "auto";
      readonly effectiveMode: "original";
      readonly degraded: true;
      readonly warning: ChromakeyWarning;
      readonly postProcessingError?: never;
    }
  | {
      readonly status: "fallback";
      readonly output: MaterializedImageOutput;
      readonly transparencyApplied: false;
      readonly removedPixels: 0;
      readonly requestedMode: "chromakey" | "auto";
      readonly effectiveMode: "original";
      readonly degraded: true;
      readonly warning: ChromakeyWarning;
      readonly postProcessingError: ChromakeyWarning;
    };

interface BoundedPngHeader {
  readonly width: number;
  readonly height: number;
  readonly decodedRgbaBytes: number;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_IHDR_TOTAL_BYTES = 33;
const PNG_8_BIT_COLOR_TYPES = new Set([0, 2, 3, 4, 6]);

function pngCrc32(bytes: Buffer, start: number, end: number): number {
  let crc = 0xffff_ffff;
  for (let position = start; position < end; position += 1) {
    crc ^= bytes[position]!;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function boundedPngHeader(bytes: Buffer): BoundedPngHeader | undefined {
  if (
    bytes.byteLength < PNG_IHDR_TOTAL_BYTES ||
    !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR" ||
    bytes.readUInt32BE(29) !== pngCrc32(bytes, 12, 29)
  ) {
    return undefined;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const compressionMethod = bytes[26];
  const filterMethod = bytes[27];
  const interlaceMethod = bytes[28];
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_CHROMAKEY_DIMENSION ||
    height > MAX_CHROMAKEY_DIMENSION ||
    bitDepth !== 8 ||
    colorType === undefined ||
    !PNG_8_BIT_COLOR_TYPES.has(colorType) ||
    compressionMethod !== 0 ||
    filterMethod !== 0 ||
    interlaceMethod !== 0
  ) {
    return undefined;
  }
  const pixels = width * height;
  const decodedRgbaBytes = pixels * 4;
  if (
    !Number.isSafeInteger(pixels) ||
    !Number.isSafeInteger(decodedRgbaBytes) ||
    pixels > MAX_CHROMAKEY_PIXELS ||
    decodedRgbaBytes > MAX_CHROMAKEY_RGBA_BYTES
  ) {
    return undefined;
  }
  return { width, height, decodedRgbaBytes };
}

function validByte(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 255;
}

function validateOptions(input: ApplyPngChromakeyInput): {
  readonly keyColor: ChromakeyColor;
  readonly tolerance: number;
} {
  const { keyColor, tolerance } = input;
  if (
    !validByte(keyColor.red) ||
    !validByte(keyColor.green) ||
    !validByte(keyColor.blue) ||
    !Number.isInteger(tolerance) ||
    tolerance < 0 ||
    tolerance > 64
  ) {
    throw new TypeError(
      "Chromakey colors must be integer bytes and tolerance must be an integer from 0 through 64."
    );
  }
  return { keyColor, tolerance };
}

function isKeyPixel(
  red: number,
  green: number,
  blue: number,
  keyColor: ChromakeyColor,
  tolerance: number
): boolean {
  return (
    Math.abs(red - keyColor.red) <= tolerance &&
    Math.abs(green - keyColor.green) <= tolerance &&
    Math.abs(blue - keyColor.blue) <= tolerance
  );
}

function isGeneratedGreenScreenPixel(
  red: number,
  green: number,
  blue: number,
  keyColor: ChromakeyColor
): boolean {
  // A provider may turn #00FF00 into a subtly shaded render (for example
  // rgb(25,233,38)). Treat that predictable generator variance as key color
  // only when the configured key itself is vivid green and green clearly
  // dominates both remaining channels. This cannot trigger for arbitrary
  // background colours and is intentionally limited to explicit chromakey.
  if (keyColor.green < 224 || keyColor.red > 32 || keyColor.blue > 32) return false;
  return green >= 160 && green - Math.max(red, blue) >= 42;
}

function removeGreenScreenSpill(decoded: PNG): void {
  const { width, height, data } = decoded;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (data[offset + 3] !== 255) continue;
      let touchesTransparency = false;
      for (let neighborY = Math.max(0, y - 1); neighborY <= Math.min(height - 1, y + 1) && !touchesTransparency; neighborY += 1) {
        for (let neighborX = Math.max(0, x - 1); neighborX <= Math.min(width - 1, x + 1); neighborX += 1) {
          if (data[(neighborY * width + neighborX) * 4 + 3] === 0) {
            touchesTransparency = true;
            break;
          }
        }
      }
      if (!touchesTransparency) continue;
      const red = data[offset]!;
      const green = data[offset + 1]!;
      const blue = data[offset + 2]!;
      const neutral = Math.max(red, blue);
      if (green > neutral + 3) data[offset + 1] = neutral;
    }
  }
}

function refusal(
  output: MaterializedImageOutput,
  reason: ChromakeyRefusalReason,
  requestedMode: ApplyPngChromakeyInput["requestedMode"]
): PngChromakeyResult {
  const warning: ChromakeyWarning =
    reason === "non-png"
      ? {
          code: "chromakey_non_png",
          safeMessage: "Chromakey transparency requires a validated PNG output."
        }
      : reason === "auto-ineligible"
        ? {
            code: "chromakey_auto_ineligible",
            safeMessage:
              "Automatic chromakey was not explicitly eligible for this output and was not attempted."
          }
      : reason === "complex-content"
        ? {
            code: "chromakey_complex_content",
            safeMessage:
              "Chromakey was refused because the subject has complex or uncertain edge semantics."
          }
        : reason === "key-not-found"
          ? {
            code: "chromakey_key_not_found",
            safeMessage: "Chromakey found no pixels inside the configured key range."
            }
          : {
              code: "chromakey_unsafe_coverage",
              safeMessage:
                "Chromakey was refused because the configured key range would remove the complete visible image."
            };
  return {
    status: "refused",
    output,
    transparencyApplied: false,
    removedPixels: 0,
    reason,
    requestedMode,
    effectiveMode: "original",
    degraded: true,
    warning
  };
}

export async function applyPngChromakey(
  input: ApplyPngChromakeyInput
): Promise<PngChromakeyResult> {
  if (input.output.source !== "provider-original") {
    throw new ImageMaterializationError(
      "transaction-ownership",
      "Chromakey can only process the validated provider-original transaction payload."
    );
  }
  if (input.output.mimeType !== "image/png") {
    return refusal(input.output, "non-png", input.requestedMode);
  }
  if (input.requestedMode === "auto" && input.autoEligible !== true) {
    return refusal(input.output, "auto-ineligible", input.requestedMode);
  }
  if (input.contentClass !== "simple") {
    return refusal(input.output, "complex-content", input.requestedMode);
  }
  const { keyColor, tolerance } = validateOptions(input);
  const originalBytes = await input.transaction.readValidatedBytes(input.output);

  try {
    const buffer = Buffer.from(originalBytes);
    const header = boundedPngHeader(buffer);
    if (header === undefined) {
      throw new Error("unsupported-png-profile");
    }
    const decoded = PNG.sync.read(buffer);
    if (
      decoded.width !== header.width ||
      decoded.height !== header.height ||
      decoded.width !== input.output.width ||
      decoded.height !== input.output.height ||
      decoded.data.byteLength !== header.decodedRgbaBytes
    ) {
      throw new Error("decoded-metadata-mismatch");
    }

    let removedPixels = 0;
    let remainingVisiblePixels = 0;
    for (let offset = 0; offset < decoded.data.byteLength; offset += 4) {
      const red = decoded.data[offset];
      const green = decoded.data[offset + 1];
      const blue = decoded.data[offset + 2];
      const alpha = decoded.data[offset + 3];
      if (
        red !== undefined &&
        green !== undefined &&
        blue !== undefined &&
        alpha !== undefined &&
        alpha > 0 &&
        (isKeyPixel(red, green, blue, keyColor, tolerance) ||
          isGeneratedGreenScreenPixel(red, green, blue, keyColor))
      ) {
        decoded.data[offset + 3] = 0;
        removedPixels += 1;
      } else if (alpha !== undefined && alpha > 0) {
        remainingVisiblePixels += 1;
      }
    }
    if (removedPixels === 0) {
      return refusal(input.output, "key-not-found", input.requestedMode);
    }
    if (remainingVisiblePixels === 0) {
      return refusal(input.output, "key-dominates-image", input.requestedMode);
    }
    removeGreenScreenSpill(decoded);

    const encoded = PNG.sync.write(decoded, {
      colorType: 6,
      inputColorType: 6,
      inputHasAlpha: true,
      bitDepth: 8,
      deflateLevel: 9,
      deflateStrategy: 3,
      filterType: 4
    });
    const processedHeader = boundedPngHeader(encoded);
    if (
      processedHeader === undefined ||
      processedHeader.width !== header.width ||
      processedHeader.height !== header.height
    ) {
      throw new Error("encoded-metadata-mismatch");
    }
    const processedDecoded = PNG.sync.read(encoded);
    let hasTransparentPixel = false;
    for (let offset = 3; offset < processedDecoded.data.byteLength; offset += 4) {
      if (processedDecoded.data[offset] === 0) {
        hasTransparentPixel = true;
        break;
      }
    }
    if (!hasTransparentPixel) {
      throw new Error("encoded-alpha-missing");
    }

    const output = await input.transaction.stageReplacement(
      input.output,
      new Uint8Array(encoded),
      "image/png"
    );
    return {
      status: "applied",
      output,
      transparencyApplied: true,
      removedPixels,
      requestedMode: input.requestedMode,
      effectiveMode: "chromakey",
      degraded: true
    };
  } catch (error) {
    if (
      error instanceof ImageMaterializationError &&
      (error.code === "transaction-closed" || error.code === "transaction-ownership")
    ) {
      throw error;
    }
    const warning: ChromakeyWarning = {
      code: "chromakey_processing_failed",
      safeMessage:
        "Chromakey processing failed; the validated provider original remains selected without a transparency success claim."
    };
    return {
      status: "fallback",
      output: input.output,
      transparencyApplied: false,
      removedPixels: 0,
      requestedMode: input.requestedMode,
      effectiveMode: "original",
      degraded: true,
      warning,
      postProcessingError: warning
    };
  }
}
