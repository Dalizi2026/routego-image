import { parentPort } from "node:worker_threads";

import { PNG } from "pngjs";

export const WORKER_MAX_WIDTH = 4_096;
export const WORKER_MAX_HEIGHT = 4_096;
export const WORKER_MAX_PIXELS = 4 * 1_024 * 1_024;
export const WORKER_MAX_INPUT_BYTES = 16 * 1_024 * 1_024;
export const WORKER_MAX_OUTPUT_BYTES = 16 * 1_024 * 1_024;

export const MIN_MASK_COVERAGE = 0.02;
export const MAX_MASK_COVERAGE = 0.98;

export interface BackgroundRemovalWorkerRequest {
  readonly type: "process";
  readonly bytes: Uint8Array;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  /** A bounded mask is accepted for deterministic harnesses and future ONNX adapters. */
  readonly mask?: Uint8Array | Float32Array;
}

export type BackgroundRemovalWorkerResponse =
  | {
      readonly type: "success";
      readonly bytes: Uint8Array;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly type: "failure";
      readonly code: "invalid-input" | "input-too-large" | "output-too-large" | "inference-unavailable" | "worker-failed" | "quality-gate-failed";
      readonly message: string;
    };

export interface BoundedRgba {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

export interface AlphaInspection {
  readonly width: number;
  readonly height: number;
  readonly foregroundPixels: number;
  readonly backgroundPixels: number;
  readonly nonZeroPixels: number;
  readonly edgeForegroundPixels: number;
  readonly edgeBackgroundPixels: number;
  readonly minAlpha: number;
  readonly maxAlpha: number;
}

export interface QualityGateFailure {
  readonly code: "quality-gate-failed";
  readonly message: string;
}

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

function failure(
  code: BackgroundRemovalWorkerResponse extends infer T
    ? T extends { readonly type: "failure"; readonly code: infer C }
      ? C
      : never
    : never,
  message: string
): BackgroundRemovalWorkerResponse {
  return { type: "failure", code, message } as BackgroundRemovalWorkerResponse;
}

function isPngSignature(bytes: Uint8Array): boolean {
  return bytes.byteLength >= PNG_SIGNATURE.byteLength && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

function boundedPngDimensions(bytes: Uint8Array): { width: number; height: number } | BackgroundRemovalWorkerResponse {
  if (bytes.byteLength < 33 || !isPngSignature(bytes) || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8) !== 13 ||
      new TextDecoder().decode(bytes.subarray(12, 16)) !== "IHDR") {
    return failure("invalid-input", "The local background-removal input is not a valid PNG header.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  if (width < 1 || height < 1 || width > WORKER_MAX_WIDTH || height > WORKER_MAX_HEIGHT || bitDepth !== 8 ||
      !new Set([0, 2, 3, 4, 6]).has(colorType ?? -1) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0) {
    return failure("invalid-input", "The local background-removal PNG header exceeds the safe profile.");
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > WORKER_MAX_PIXELS) {
    return failure("invalid-input", "The local background-removal image dimensions exceed the safe limit.");
  }
  return { width, height };
}

function boundedPng(bytes: Uint8Array, maxInputBytes: number): BoundedRgba | BackgroundRemovalWorkerResponse {
  if (bytes.byteLength === 0 || bytes.byteLength > maxInputBytes || bytes.byteLength > WORKER_MAX_INPUT_BYTES) {
    return failure("input-too-large", "The local background-removal input exceeds the byte limit.");
  }
  if (!isPngSignature(bytes)) return failure("invalid-input", "Local background removal requires a PNG input.");
  const dimensions = boundedPngDimensions(bytes);
  if ("type" in dimensions) return dimensions;

  let decoded: PNG;
  try {
    decoded = PNG.sync.read(Buffer.from(bytes));
  } catch {
    return failure("invalid-input", "The local background-removal PNG could not be decoded.");
  }
  if (decoded.width !== dimensions.width || decoded.height !== dimensions.height) return failure("invalid-input", "The PNG dimensions changed during decoding.");
  return { width: decoded.width, height: decoded.height, rgba: new Uint8Array(decoded.data) };
}

function qualityFailure(message: string): QualityGateFailure {
  return { code: "quality-gate-failed", message };
}

function inspectRgbaAlpha(rgba: Uint8Array, width: number, height: number): AlphaInspection | QualityGateFailure {
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels < 1 || rgba.byteLength !== pixels * 4) {
    return qualityFailure("The decoded image dimensions do not match its pixel buffer.");
  }
  let foregroundPixels = 0;
  let backgroundPixels = 0;
  let nonZeroPixels = 0;
  let edgeForegroundPixels = 0;
  let edgeBackgroundPixels = 0;
  let minAlpha = 255;
  let maxAlpha = 0;
  for (let index = 0; index < pixels; index += 1) {
    const alpha = rgba[index * 4 + 3];
    if (alpha === undefined || !Number.isFinite(alpha)) return qualityFailure("The decoded alpha channel contains a non-finite value.");
    minAlpha = Math.min(minAlpha, alpha);
    maxAlpha = Math.max(maxAlpha, alpha);
    if (alpha > 0) nonZeroPixels += 1;
    if (alpha >= 128) foregroundPixels += 1;
    else backgroundPixels += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
      if (alpha >= 128) edgeForegroundPixels += 1;
      else edgeBackgroundPixels += 1;
    }
  }
  return {
    width,
    height,
    foregroundPixels,
    backgroundPixels,
    nonZeroPixels,
    edgeForegroundPixels,
    edgeBackgroundPixels,
    minAlpha,
    maxAlpha
  };
}

function validateCoverage(inspection: AlphaInspection, label: string): QualityGateFailure | undefined {
  const pixels = inspection.width * inspection.height;
  const coverage = inspection.foregroundPixels / pixels;
  if (inspection.foregroundPixels === 0 || inspection.backgroundPixels === 0 ||
      coverage < MIN_MASK_COVERAGE || coverage > MAX_MASK_COVERAGE) {
    return qualityFailure(`The ${label} has empty or full foreground coverage.`);
  }
  if (inspection.edgeBackgroundPixels === 0) {
    return qualityFailure(`The ${label} has anomalous boundary coverage.`);
  }
  return undefined;
}

export function validateMaskQuality(
  mask: Uint8Array | Float32Array,
  width: number,
  height: number
): Uint8Array | QualityGateFailure {
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels < 1 || mask.length !== pixels) {
    return qualityFailure("The inference mask dimensions do not match the source image.");
  }
  const normalized = new Uint8Array(pixels);
  for (let index = 0; index < pixels; index += 1) {
    const value = mask[index];
    if (value === undefined || !Number.isFinite(value)) return qualityFailure("The inference mask contains a non-finite value.");
    if (mask instanceof Uint8Array) {
      normalized[index] = value;
    } else if (value >= 0 && value <= 1) {
      normalized[index] = Math.round(value * 255);
    } else {
      return qualityFailure("The inference mask contains a value outside the normalized range.");
    }
  }
  const rgba = new Uint8Array(pixels * 4);
  for (let index = 0; index < pixels; index += 1) rgba[index * 4 + 3] = normalized[index]!;
  const inspection = inspectRgbaAlpha(rgba, width, height);
  if ("code" in inspection) return inspection;
  return validateCoverage(inspection, "inference mask") ?? normalized;
}

export function inspectPngAlpha(
  bytes: Uint8Array,
  expectedWidth?: number,
  expectedHeight?: number
): AlphaInspection | QualityGateFailure {
  let decoded: PNG;
  try {
    decoded = PNG.sync.read(Buffer.from(bytes));
  } catch {
    return qualityFailure("The transparent PNG could not be decoded for alpha validation.");
  }
  if ((expectedWidth !== undefined && decoded.width !== expectedWidth) ||
      (expectedHeight !== undefined && decoded.height !== expectedHeight)) {
    return qualityFailure("The transparent PNG dimensions do not match the source image.");
  }
  const inspection = inspectRgbaAlpha(new Uint8Array(decoded.data), decoded.width, decoded.height);
  if ("code" in inspection) return inspection;
  return validateCoverage(inspection, "output alpha") ?? inspection;
}

function validateOpaqueSource(rgba: Uint8Array, width: number, height: number): QualityGateFailure | undefined {
  const inspection = inspectRgbaAlpha(rgba, width, height);
  if ("code" in inspection) return inspection;
  if (inspection.minAlpha !== 255 || inspection.maxAlpha !== 255) {
    return qualityFailure("Local background removal requires an opaque source image.");
  }
  return undefined;
}

export function preprocessRgba(rgba: Uint8Array): Float32Array {
  if (rgba.byteLength % 4 !== 0) throw new TypeError("RGBA input must contain complete pixels.");
  const normalized = new Float32Array(rgba.byteLength);
  for (let index = 0; index < rgba.byteLength; index += 1) normalized[index] = rgba[index]! / 255;
  return normalized;
}

export function compositeMask(
  rgba: Uint8Array,
  width: number,
  height: number,
  mask: Uint8Array | Float32Array,
  maxOutputBytes = WORKER_MAX_OUTPUT_BYTES
): Uint8Array {
  const pixels = width * height;
  const sourceFailure = validateOpaqueSource(rgba, width, height);
  if (sourceFailure) throw new TypeError(sourceFailure.message);
  const validatedMask = validateMaskQuality(mask, width, height);
  if ("code" in validatedMask) throw new TypeError(validatedMask.message);
  const output = new PNG({ width, height });
  output.data.set(rgba);
  for (let index = 0; index < pixels; index += 1) output.data[index * 4 + 3] = validatedMask[index]!;
  const encoded = PNG.sync.write(output, { colorType: 6, inputColorType: 6, inputHasAlpha: true });
  if (encoded.byteLength > maxOutputBytes || encoded.byteLength > WORKER_MAX_OUTPUT_BYTES) {
    throw new RangeError("The local background-removal output exceeds the byte limit.");
  }
  const result = new Uint8Array(encoded);
  const outputFailure = inspectPngAlpha(result, width, height);
  if ("code" in outputFailure) throw new TypeError(outputFailure.message);
  return result;
}

export async function processBackgroundRemovalRequest(
  request: BackgroundRemovalWorkerRequest
): Promise<BackgroundRemovalWorkerResponse> {
  const bounded = boundedPng(request.bytes, request.maxInputBytes ?? WORKER_MAX_INPUT_BYTES);
  if ("type" in bounded) return bounded;
  const { width, height, rgba } = bounded;
  const sourceFailure = validateOpaqueSource(rgba, width, height);
  if (sourceFailure) return failure(sourceFailure.code, sourceFailure.message);
  preprocessRgba(rgba);
  if (request.mask === undefined) {
    return failure("inference-unavailable", "The local inference backend is not available in this runtime.");
  }
  const validatedMask = validateMaskQuality(request.mask, width, height);
  if ("code" in validatedMask) return failure(validatedMask.code, validatedMask.message);
  try {
    const bytes = compositeMask(rgba, width, height, validatedMask, request.maxOutputBytes);
    return { type: "success", bytes, width, height };
  } catch (error) {
    const code = error instanceof RangeError ? "output-too-large" : error instanceof TypeError ? "quality-gate-failed" : "worker-failed";
    return failure(code, error instanceof Error ? error.message : "Local background removal failed.");
  }
}

if (parentPort !== null) {
  parentPort.on("message", async (request: BackgroundRemovalWorkerRequest) => {
    let response: BackgroundRemovalWorkerResponse;
    try {
      response = await processBackgroundRemovalRequest(request);
    } catch {
      response = failure("worker-failed", "Local background removal failed.");
    }
    parentPort!.postMessage(response);
  });
}
