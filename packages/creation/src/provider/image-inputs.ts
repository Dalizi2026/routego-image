import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

import type { ImageOperationRequest } from "@routego-image/contracts";

import {
  MAX_PROVIDER_INPUT_BYTES,
  MAX_PROVIDER_INPUTS,
  ProviderPreparationError,
  type ImageFileMetadata,
  type PrepareImageInputOptions,
  type PreparedImageInput,
  type PreparedImageInputs,
  type SupportedImageMimeType
} from "./types";

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const MAX_IMAGE_DIMENSION = 65_535;
const MAX_GENERATION_REFERENCES = 5;

function matches(bytes: Uint8Array, offset: number, expected: Uint8Array): boolean {
  if (offset + expected.length > bytes.length) {
    return false;
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected[index]) {
      return false;
    }
  }
  return true;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function uint16Be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function uint24Le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16)
  );
}

function uint32Be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000) +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

function uint32Le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) +
    ((bytes[offset + 1] ?? 0) << 8) +
    ((bytes[offset + 2] ?? 0) << 16) +
    ((bytes[offset + 3] ?? 0) * 0x1000000)
  );
}

function validateDimensions(width: number, height: number): void {
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION
  ) {
    throw new ProviderPreparationError(
      "unsupported-image",
      "The image dimensions are invalid or exceed the supported bound.",
      { width, height, maximum: MAX_IMAGE_DIMENSION }
    );
  }
}

function parsePng(bytes: Uint8Array): ImageFileMetadata | undefined {
  if (!matches(bytes, 0, PNG_SIGNATURE)) {
    return undefined;
  }
  if (bytes.length < 33 || ascii(bytes, 12, 4) !== "IHDR" || uint32Be(bytes, 8) !== 13) {
    throw new ProviderPreparationError(
      "unsupported-image",
      "The PNG header is incomplete or malformed."
    );
  }

  const width = uint32Be(bytes, 16);
  const height = uint32Be(bytes, 20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  if (
    bitDepth === undefined ||
    colorType === undefined ||
    ![0, 2, 3, 4, 6].includes(colorType)
  ) {
    throw new ProviderPreparationError(
      "unsupported-image",
      "The PNG color metadata is unsupported."
    );
  }
  validateDimensions(width, height);

  let offset = 8;
  let sawEnd = false;
  let hasTransparencyChunk = false;
  while (offset + 12 <= bytes.length) {
    const length = uint32Be(bytes, offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.length) {
      throw new ProviderPreparationError(
        "unsupported-image",
        "The PNG contains a truncated chunk."
      );
    }
    const type = ascii(bytes, offset + 4, 4);
    if (type === "tRNS" && length > 0) {
      hasTransparencyChunk = true;
    }
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
    offset = chunkEnd;
  }
  if (!sawEnd) {
    throw new ProviderPreparationError(
      "unsupported-image",
      "The PNG does not contain a complete end marker."
    );
  }

  return {
    mimeType: "image/png",
    width,
    height,
    hasAlpha: colorType === 4 || colorType === 6 || hasTransparencyChunk
  };
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc5,
  0xc6,
  0xc7,
  0xc9,
  0xca,
  0xcb,
  0xcd,
  0xce,
  0xcf
]);

function parseJpeg(bytes: Uint8Array): ImageFileMetadata | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }
  let offset = 2;
  while (offset < bytes.length) {
    while (bytes[offset] === 0xff) {
      offset += 1;
    }
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9) {
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > bytes.length) {
      break;
    }
    const segmentLength = uint16Be(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      throw new ProviderPreparationError(
        "unsupported-image",
        "The JPEG contains a truncated segment."
      );
    }
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 7) {
        break;
      }
      const height = uint16Be(bytes, offset + 3);
      const width = uint16Be(bytes, offset + 5);
      validateDimensions(width, height);
      return { mimeType: "image/jpeg", width, height, hasAlpha: false };
    }
    offset += segmentLength;
  }
  throw new ProviderPreparationError(
    "unsupported-image",
    "The JPEG does not contain readable dimensions."
  );
}

function webpMetadataFromChunk(
  bytes: Uint8Array,
  chunkType: string,
  dataOffset: number,
  chunkLength: number
): ImageFileMetadata | undefined {
  if (chunkType === "VP8X") {
    if (chunkLength < 10 || dataOffset + 10 > bytes.length) {
      throw new ProviderPreparationError("unsupported-image", "The WebP VP8X header is truncated.");
    }
    const width = uint24Le(bytes, dataOffset + 4) + 1;
    const height = uint24Le(bytes, dataOffset + 7) + 1;
    validateDimensions(width, height);
    return {
      mimeType: "image/webp",
      width,
      height,
      hasAlpha: ((bytes[dataOffset] ?? 0) & 0x10) !== 0
    };
  }
  if (chunkType === "VP8L") {
    if (chunkLength < 5 || dataOffset + 5 > bytes.length || bytes[dataOffset] !== 0x2f) {
      throw new ProviderPreparationError("unsupported-image", "The WebP VP8L header is malformed.");
    }
    const bits = uint32Le(bytes, dataOffset + 1);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    validateDimensions(width, height);
    return {
      mimeType: "image/webp",
      width,
      height,
      hasAlpha: ((bits >>> 28) & 1) === 1
    };
  }
  if (chunkType === "VP8 ") {
    if (
      chunkLength < 10 ||
      dataOffset + 10 > bytes.length ||
      bytes[dataOffset + 3] !== 0x9d ||
      bytes[dataOffset + 4] !== 0x01 ||
      bytes[dataOffset + 5] !== 0x2a
    ) {
      throw new ProviderPreparationError("unsupported-image", "The WebP VP8 header is malformed.");
    }
    const width = uint16Be(Uint8Array.of(bytes[dataOffset + 7] ?? 0, bytes[dataOffset + 6] ?? 0), 0) & 0x3fff;
    const height = uint16Be(Uint8Array.of(bytes[dataOffset + 9] ?? 0, bytes[dataOffset + 8] ?? 0), 0) & 0x3fff;
    validateDimensions(width, height);
    return { mimeType: "image/webp", width, height, hasAlpha: false };
  }
  return undefined;
}

function parseWebp(bytes: Uint8Array): ImageFileMetadata | undefined {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
    return undefined;
  }
  if (bytes.length < 20 || uint32Le(bytes, 4) + 8 > bytes.length) {
    throw new ProviderPreparationError("unsupported-image", "The WebP RIFF container is truncated.");
  }
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkType = ascii(bytes, offset, 4);
    const chunkLength = uint32Le(bytes, offset + 4);
    const dataOffset = offset + 8;
    const chunkEnd = dataOffset + chunkLength;
    if (chunkEnd > bytes.length) {
      throw new ProviderPreparationError("unsupported-image", "The WebP contains a truncated chunk.");
    }
    const metadata = webpMetadataFromChunk(bytes, chunkType, dataOffset, chunkLength);
    if (metadata !== undefined) {
      return metadata;
    }
    offset = chunkEnd + (chunkLength % 2);
  }
  throw new ProviderPreparationError(
    "unsupported-image",
    "The WebP does not contain a supported image header."
  );
}

export function detectImageMetadata(bytes: Uint8Array): ImageFileMetadata {
  if (bytes.length === 0) {
    throw new ProviderPreparationError("invalid-file", "The image file is empty.");
  }
  const metadata = parsePng(bytes) ?? parseJpeg(bytes) ?? parseWebp(bytes);
  if (metadata === undefined) {
    throw new ProviderPreparationError(
      "unsupported-image",
      "Only PNG, JPEG, and WebP image files are supported."
    );
  }
  return metadata;
}

function extensionMime(path: string): SupportedImageMimeType | undefined {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return undefined;
  }
}

function safeExtension(mimeType: SupportedImageMimeType): string {
  return mimeType === "image/png" ? "png" : mimeType === "image/jpeg" ? "jpg" : "webp";
}

async function readValidatedImage(
  path: string,
  maxBytes: number,
  tooLargeReason: "image-too-large" | "mask-too-large"
): Promise<{ readonly bytes: Uint8Array; readonly metadata: ImageFileMetadata }> {
  let fileStats;
  try {
    fileStats = await stat(path);
  } catch {
    throw new ProviderPreparationError(
      "invalid-file",
      "An image input cannot be read.",
      { cause: "unreadable" }
    );
  }
  if (!fileStats.isFile()) {
    throw new ProviderPreparationError(
      "invalid-file",
      "An image input must resolve to a regular file.",
      { cause: "not-regular-file" }
    );
  }
  if (fileStats.size < 1 || fileStats.size > maxBytes) {
    throw new ProviderPreparationError(
      tooLargeReason,
      fileStats.size < 1 ? "The image file is empty." : "The image file exceeds the byte limit.",
      { byteLength: fileStats.size, maximumBytes: maxBytes }
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch {
    throw new ProviderPreparationError(
      "invalid-file",
      "An image input cannot be read.",
      { cause: "read-failed" }
    );
  }
  if (bytes.byteLength > maxBytes) {
    throw new ProviderPreparationError(tooLargeReason, "The image file exceeds the byte limit.", {
      byteLength: bytes.byteLength,
      maximumBytes: maxBytes
    });
  }
  const metadata = detectImageMetadata(bytes);
  const declaredMime = extensionMime(path);
  if (declaredMime !== undefined && declaredMime !== metadata.mimeType) {
    throw new ProviderPreparationError(
      "unsupported-image",
      "The image file extension does not match its detected format.",
      { declaredMimeType: declaredMime, detectedMimeType: metadata.mimeType }
    );
  }
  return { bytes, metadata };
}

export function imageDataUrl(input: Pick<PreparedImageInput, "bytes" | "mimeType">): string {
  return `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString("base64")}`;
}

export async function prepareImageInputs(
  request: ImageOperationRequest,
  options: PrepareImageInputOptions = {}
): Promise<PreparedImageInputs> {
  const maxFileBytes = options.maxFileBytes ?? MAX_PROVIDER_INPUT_BYTES;
  const maxTotalBytes =
    options.maxTotalBytes ??
    Math.min(MAX_PROVIDER_INPUTS, MAX_GENERATION_REFERENCES) * MAX_PROVIDER_INPUT_BYTES;
  const descriptors = request.references.map((value, sourceIndex) => ({
    kind: "reference" as const,
    sourceIndex,
    role: value.role,
    value
  }));
  if (descriptors.length > MAX_GENERATION_REFERENCES) {
    throw new ProviderPreparationError(
      "too-many-images",
      "A generation request can contain at most five ordered reference images.",
      { requested: descriptors.length, maximum: MAX_GENERATION_REFERENCES }
    );
  }

  const images: PreparedImageInput[] = [];
  let totalBytes = 0;
  for (const [slot, descriptor] of descriptors.entries()) {
    const { bytes, metadata } = await readValidatedImage(
      descriptor.value.path,
      maxFileBytes,
      "image-too-large"
    );
    totalBytes += bytes.byteLength;
    if (totalBytes > maxTotalBytes) {
      throw new ProviderPreparationError(
        "image-too-large",
        "The combined image inputs exceed the byte limit.",
        { totalBytes, maximumBytes: maxTotalBytes }
      );
    }
    images.push({
      slot,
      kind: descriptor.kind,
      role: descriptor.role,
      sourceIndex: descriptor.sourceIndex,
      path: descriptor.value.path,
      fileName: `${descriptor.kind}-${slot}.${safeExtension(metadata.mimeType)}`,
      byteLength: bytes.byteLength,
      bytes,
      ...metadata,
      ...(descriptor.value.id === undefined ? {} : { id: descriptor.value.id }),
      ...(descriptor.value.label === undefined ? {} : { label: descriptor.value.label })
    });
  }

  return {
    images,
    totalBytes
  };
}
