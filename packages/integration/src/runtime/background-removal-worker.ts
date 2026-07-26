import { parentPort } from "node:worker_threads";

import { PNG } from "pngjs";

export const WORKER_MAX_WIDTH = 4_096;
export const WORKER_MAX_HEIGHT = 4_096;
export const WORKER_MAX_PIXELS = 4 * 1_024 * 1_024;
export const WORKER_MAX_INPUT_BYTES = 16 * 1_024 * 1_024;
export const WORKER_MAX_OUTPUT_BYTES = 16 * 1_024 * 1_024;

export interface BackgroundRemovalWorkerRequest {
  readonly type: "process";
  readonly bytes: Uint8Array;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  /** A bounded mask is accepted for deterministic harnesses and future ONNX adapters. */
  readonly mask?: Uint8Array;
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
      readonly code: "invalid-input" | "input-too-large" | "output-too-large" | "inference-unavailable" | "worker-failed";
      readonly message: string;
    };

export interface BoundedRgba {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
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
  mask: Uint8Array,
  maxOutputBytes = WORKER_MAX_OUTPUT_BYTES
): Uint8Array {
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels < 1 || mask.byteLength !== pixels) {
    throw new TypeError("The inference mask does not match the decoded image dimensions.");
  }
  const output = new PNG({ width, height });
  output.data.set(rgba);
  for (let index = 0; index < pixels; index += 1) output.data[index * 4 + 3] = mask[index]!;
  const encoded = PNG.sync.write(output, { colorType: 6, inputColorType: 6, inputHasAlpha: true });
  if (encoded.byteLength > maxOutputBytes || encoded.byteLength > WORKER_MAX_OUTPUT_BYTES) {
    throw new RangeError("The local background-removal output exceeds the byte limit.");
  }
  return new Uint8Array(encoded);
}

export async function processBackgroundRemovalRequest(
  request: BackgroundRemovalWorkerRequest
): Promise<BackgroundRemovalWorkerResponse> {
  const bounded = boundedPng(request.bytes, request.maxInputBytes ?? WORKER_MAX_INPUT_BYTES);
  if ("type" in bounded) return bounded;
  const { width, height, rgba } = bounded;
  preprocessRgba(rgba);
  if (request.mask === undefined) {
    return failure("inference-unavailable", "The local inference backend is not available in this runtime.");
  }
  try {
    const bytes = compositeMask(rgba, width, height, request.mask, request.maxOutputBytes);
    return { type: "success", bytes, width, height };
  } catch (error) {
    return failure("worker-failed", error instanceof Error ? error.message : "Local background removal failed.");
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
