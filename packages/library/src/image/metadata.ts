import { open } from "node:fs/promises";

import type { UploadMimeType } from "@routego-image/contracts";

import { LibraryError } from "../errors";

export interface DetectedUploadContent {
  readonly mimeType: UploadMimeType;
  readonly width?: number;
  readonly height?: number;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function validDimension(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function parsePng(bytes: Buffer): DetectedUploadContent | undefined {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)) return undefined;
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new LibraryError("upload_invalid_type", "The uploaded PNG header is invalid.");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const compression = bytes[26];
  const filter = bytes[27];
  const interlace = bytes[28];
  const allowedDepths: Readonly<Record<number, readonly number[]>> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16]
  };
  if (
    !validDimension(width) ||
    !validDimension(height) ||
    colorType === undefined ||
    bitDepth === undefined ||
    !allowedDepths[colorType]?.includes(bitDepth) ||
    compression !== 0 ||
    filter !== 0 ||
    (interlace !== 0 && interlace !== 1)
  ) {
    throw new LibraryError("upload_invalid_type", "The uploaded PNG header is invalid.");
  }
  const expectedCrc = bytes.readUInt32BE(29);
  if (crc32(bytes.subarray(12, 29)) !== expectedCrc) {
    throw new LibraryError("upload_invalid_type", "The uploaded PNG header checksum is invalid.");
  }
  return { mimeType: "image/png", width, height };
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

async function parseJpeg(filePath: string, byteLength: number): Promise<DetectedUploadContent | undefined> {
  if (byteLength < 4) return undefined;
  const handle = await open(filePath, "r");
  try {
    const first = Buffer.allocUnsafe(2);
    if ((await handle.read(first, 0, 2, 0)).bytesRead !== 2 || first[0] !== 0xff || first[1] !== 0xd8) {
      return undefined;
    }
    let position = 2;
    const markerBuffer = Buffer.allocUnsafe(2);
    while (position + 2 <= byteLength) {
      if ((await handle.read(markerBuffer, 0, 2, position)).bytesRead !== 2) break;
      if (markerBuffer[0] !== 0xff) {
        throw new LibraryError("upload_invalid_type", "The uploaded JPEG marker stream is invalid.");
      }
      let marker = markerBuffer[1]!;
      position += 2;
      while (marker === 0xff && position < byteLength) {
        const next = Buffer.allocUnsafe(1);
        if ((await handle.read(next, 0, 1, position)).bytesRead !== 1) break;
        marker = next[0]!;
        position += 1;
      }
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
      const lengthBytes = Buffer.allocUnsafe(2);
      if ((await handle.read(lengthBytes, 0, 2, position)).bytesRead !== 2) {
        throw new LibraryError("upload_invalid_type", "The uploaded JPEG is truncated.");
      }
      const segmentLength = lengthBytes.readUInt16BE(0);
      if (segmentLength < 2 || position + segmentLength > byteLength) {
        throw new LibraryError("upload_invalid_type", "The uploaded JPEG segment is invalid.");
      }
      if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
        if (segmentLength < 8) {
          throw new LibraryError("upload_invalid_type", "The uploaded JPEG frame is invalid.");
        }
        const frame = Buffer.allocUnsafe(5);
        if ((await handle.read(frame, 0, 5, position + 2)).bytesRead !== 5) {
          throw new LibraryError("upload_invalid_type", "The uploaded JPEG frame is truncated.");
        }
        const height = frame.readUInt16BE(1);
        const width = frame.readUInt16BE(3);
        if (!validDimension(width) || !validDimension(height)) {
          throw new LibraryError("upload_invalid_type", "The uploaded JPEG dimensions are invalid.");
        }
        return { mimeType: "image/jpeg", width, height };
      }
      position += segmentLength;
    }
    throw new LibraryError("upload_invalid_type", "The uploaded JPEG has no supported frame header.");
  } finally {
    await handle.close();
  }
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function parseWebp(bytes: Buffer, byteLength: number): DetectedUploadContent | undefined {
  if (
    bytes.length < 20 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return undefined;
  }
  if (bytes.readUInt32LE(4) + 8 !== byteLength) {
    throw new LibraryError("upload_invalid_type", "The uploaded WebP length is invalid.");
  }
  const chunk = bytes.toString("ascii", 12, 16);
  let width: number;
  let height: number;
  if (chunk === "VP8X") {
    if (bytes.length < 30 || bytes.readUInt32LE(16) < 10) {
      throw new LibraryError("upload_invalid_type", "The uploaded WebP extended header is invalid.");
    }
    width = readUInt24LE(bytes, 24) + 1;
    height = readUInt24LE(bytes, 27) + 1;
  } else if (chunk === "VP8L") {
    if (bytes.length < 25 || bytes.readUInt32LE(16) < 5 || bytes[20] !== 0x2f) {
      throw new LibraryError("upload_invalid_type", "The uploaded lossless WebP header is invalid.");
    }
    const b1 = bytes[21]!;
    const b2 = bytes[22]!;
    const b3 = bytes[23]!;
    const b4 = bytes[24]!;
    width = 1 + (b1 | ((b2 & 0x3f) << 8));
    height = 1 + ((b2 >>> 6) | (b3 << 2) | ((b4 & 0x0f) << 10));
  } else if (chunk === "VP8 ") {
    if (
      bytes.length < 30 ||
      bytes.readUInt32LE(16) < 10 ||
      bytes[23] !== 0x9d ||
      bytes[24] !== 0x01 ||
      bytes[25] !== 0x2a
    ) {
      throw new LibraryError("upload_invalid_type", "The uploaded WebP frame header is invalid.");
    }
    width = bytes.readUInt16LE(26) & 0x3fff;
    height = bytes.readUInt16LE(28) & 0x3fff;
  } else {
    throw new LibraryError("upload_invalid_type", "The uploaded WebP chunk type is unsupported.");
  }
  if (!validDimension(width) || !validDimension(height)) {
    throw new LibraryError("upload_invalid_type", "The uploaded WebP dimensions are invalid.");
  }
  return { mimeType: "image/webp", width, height };
}

function parseZip(bytes: Buffer): DetectedUploadContent | undefined {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return undefined;
  const signature = bytes.readUInt16LE(2);
  if (signature !== 0x0403 && signature !== 0x0605 && signature !== 0x0807) {
    throw new LibraryError("upload_invalid_type", "The uploaded ZIP signature is invalid.");
  }
  return { mimeType: "application/zip" };
}

export async function inspectUploadContent(
  filePath: string,
  byteLength: number
): Promise<DetectedUploadContent> {
  const handle = await open(filePath, "r");
  let prefix: Buffer;
  try {
    prefix = Buffer.alloc(Math.min(byteLength, 64));
    const result = await handle.read(prefix, 0, prefix.length, 0);
    prefix = prefix.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
  const png = parsePng(prefix);
  if (png) return png;
  const jpeg = await parseJpeg(filePath, byteLength);
  if (jpeg) return jpeg;
  const webp = parseWebp(prefix, byteLength);
  if (webp) return webp;
  const zip = parseZip(prefix);
  if (zip) return zip;
  throw new LibraryError("upload_invalid_type", "The uploaded content type is unsupported.");
}
