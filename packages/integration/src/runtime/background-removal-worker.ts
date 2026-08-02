import { parentPort } from "node:worker_threads";
import path from "node:path";

import * as ort from "onnxruntime-web";
import { PNG } from "pngjs";

import { verifyBackgroundRemovalResources } from "./background-removal-resources";

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
      readonly code: "invalid-input" | "input-too-large" | "output-too-large" | "inference-unavailable" | "worker-failed" | "quality-gate-failed" | "timeout" | "cancelled";
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
const U2NET_INPUT_SIZE = 320;
const U2NET_MEAN = [0.485, 0.456, 0.406] as const;
const U2NET_STANDARD_DEVIATION = [0.229, 0.224, 0.225] as const;

let u2netSession: Promise<ort.InferenceSession> | undefined;

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

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function bilinearSample(
  values: Uint8Array | Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  channels: number,
  channel: number
): number {
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const a = values[(y0 * width + x0) * channels + channel]!;
  const b = values[(y0 * width + x1) * channels + channel]!;
  const c = values[(y1 * width + x0) * channels + channel]!;
  const d = values[(y1 * width + x1) * channels + channel]!;
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/**
 * U²-Netp uses ImageNet-normalized NCHW input. This is equivalent to the
 * preprocessing used by rembg's U²-Net session, while keeping the pixels and
 * model entirely local to the plugin runtime.
 */
export function createU2netInput(rgba: Uint8Array, width: number, height: number): Float32Array {
  const pixels = U2NET_INPUT_SIZE * U2NET_INPUT_SIZE;
  const input = new Float32Array(3 * pixels);
  for (let y = 0; y < U2NET_INPUT_SIZE; y += 1) {
    const sourceY = ((y + 0.5) * height) / U2NET_INPUT_SIZE - 0.5;
    for (let x = 0; x < U2NET_INPUT_SIZE; x += 1) {
      const sourceX = ((x + 0.5) * width) / U2NET_INPUT_SIZE - 0.5;
      const destination = y * U2NET_INPUT_SIZE + x;
      for (let channel = 0; channel < 3; channel += 1) {
        const normalized = bilinearSample(rgba, width, height, sourceX, sourceY, 4, channel) / 255;
        input[channel * pixels + destination] = (normalized - U2NET_MEAN[channel]!) / U2NET_STANDARD_DEVIATION[channel]!;
      }
    }
  }
  return input;
}

export function resizeU2netMask(
  mask: Float32Array,
  outputWidth: number,
  outputHeight: number
): Uint8Array {
  if (mask.length !== U2NET_INPUT_SIZE * U2NET_INPUT_SIZE) {
    throw new TypeError("The U²-Net output mask has an unexpected shape.");
  }
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of mask) {
    if (!Number.isFinite(value)) throw new TypeError("The U²-Net output mask contains a non-finite value.");
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  if (!(maximum > minimum)) throw new TypeError("The U²-Net output mask has no usable contrast.");
  const normalized = new Float32Array(mask.length);
  const scale = 1 / (maximum - minimum);
  for (let index = 0; index < mask.length; index += 1) normalized[index] = (mask[index]! - minimum) * scale;

  const output = new Uint8Array(outputWidth * outputHeight);
  for (let y = 0; y < outputHeight; y += 1) {
    const sourceY = ((y + 0.5) * U2NET_INPUT_SIZE) / outputHeight - 0.5;
    for (let x = 0; x < outputWidth; x += 1) {
      const sourceX = ((x + 0.5) * U2NET_INPUT_SIZE) / outputWidth - 0.5;
      output[y * outputWidth + x] = clampByte(
        bilinearSample(normalized, U2NET_INPUT_SIZE, U2NET_INPUT_SIZE, sourceX, sourceY, 1, 0) * 255
      );
    }
  }
  return output;
}

async function loadU2netSession(): Promise<ort.InferenceSession> {
  const verified = await verifyBackgroundRemovalResources();
  const modelPath = verified.resources.get("u2netp-model");
  const loaderPath = verified.resources.get("onnxruntime-web-simd-threaded-loader");
  if (modelPath === undefined || loaderPath === undefined) {
    throw new Error("The packaged U²-Netp inference resources are incomplete.");
  }
  ort.env.wasm.wasmPaths = `${path.dirname(loaderPath)}${path.sep}`;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  return await ort.InferenceSession.create(modelPath, { executionProviders: ["wasm"] });
}

async function inferU2netMask(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  u2netSession ??= loadU2netSession();
  const session = await u2netSession;
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (inputName === undefined || outputName === undefined) throw new Error("The packaged U²-Netp model has an invalid input or output contract.");
  const output = await session.run({
    [inputName]: new ort.Tensor("float32", createU2netInput(rgba, width, height), [1, 3, U2NET_INPUT_SIZE, U2NET_INPUT_SIZE])
  });
  const tensor = output[outputName];
  if (tensor === undefined || tensor.type !== "float32" || !(tensor.data instanceof Float32Array)) {
    throw new Error("The packaged U²-Netp model returned an invalid alpha mask.");
  }
  return resizeU2netMask(tensor.data, width, height);
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
  let inferredMask: Uint8Array | Float32Array;
  try {
    inferredMask = request.mask ?? await inferU2netMask(rgba, width, height);
  } catch (error) {
    return failure(
      "inference-unavailable",
      error instanceof Error ? `The local U²-Netp inference backend is unavailable: ${error.message}` : "The local U²-Netp inference backend is unavailable."
    );
  }
  const validatedMask = validateMaskQuality(inferredMask, width, height);
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
