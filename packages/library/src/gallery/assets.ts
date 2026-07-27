import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  unlink
} from "node:fs/promises";
import { inflateSync } from "node:zlib";

import {
  identifierSchema,
  libraryAssetRenditionPhaseSchema,
  libraryAssetRelationshipSchema,
  libraryAssetStatusSchema,
  libraryOperationParametersSchema,
  MAX_LIBRARY_ASSET_RENDITIONS,
  operationExecutionMetadataSchema,
  routegoServiceErrorSchema,
  type LibraryOperationParameters,
  type OperationExecutionMetadata,
  type RoutegoServiceError
} from "@routego-image/contracts";
import { createProtectedLegacyRoots } from "@routego-image/foundation";

import { LibraryError, isNodeError } from "../errors";
import {
  markTransactionJournalCommitted,
  removeTransactionJournal,
  writeTransactionJournal,
  type FileTransactionJournal
} from "../fs/journal";
import {
  canonicalizePathIdentities,
  canonicalizePathIdentity,
  createExclusiveFile,
  isPathIdentityContained,
  pathIdentitiesOverlap,
  resolveApprovedPath,
  sanitizeBaseName
} from "../fs/paths";
import {
  IMAGE_LIBRARY_BLOB_TRANSACTION_KIND,
  ImageLibraryIndexStore,
  type ImageLibraryIndexStoreOptions
} from "./index-store";
import type {
  ImageLibraryIndex,
  LibraryAssetStatus,
  LibraryImageMimeType,
  LibraryRelationship,
  StoredImageBlob,
  StoredLibraryAsset
} from "./model";

export const DEFAULT_LIBRARY_IMAGE_MAX_BYTES = 52_428_800;
const MAX_PNG_DECODED_BYTES = 268_435_456;

export interface LibraryImageClaim {
  readonly mimeType?: LibraryImageMimeType;
  readonly byteLength?: number;
  readonly sha256?: string;
  readonly width?: number;
  readonly height?: number;
}

export interface ValidatedLibraryImage {
  readonly bytes: Buffer;
  readonly mimeType: LibraryImageMimeType;
  readonly byteLength: number;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
}

export interface LibraryAssetRenditionInput {
  readonly artifactId?: string;
  readonly phase: "source" | "partial" | "final";
  readonly sourceRoot: string;
  readonly sourceRelativePath: string;
  readonly requestedBaseName?: string;
  readonly expected?: LibraryImageClaim;
}

export interface IngestLibraryAssetInput {
  readonly assetId?: string;
  readonly primaryArtifactId?: string;
  readonly prompt: string;
  readonly model: string;
  readonly status?: Exclude<LibraryAssetStatus, "deleted">;
  readonly requestedParams: LibraryOperationParameters;
  readonly effectiveParams: LibraryOperationParameters;
  readonly execution: OperationExecutionMetadata;
  readonly error?: RoutegoServiceError;
  readonly renditions: readonly LibraryAssetRenditionInput[];
  readonly relationships?: readonly LibraryRelationship[];
  readonly folderIds?: readonly string[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface IngestLibraryAssetResult {
  readonly asset: StoredLibraryAsset;
  readonly blobs: readonly StoredImageBlob[];
  readonly deduplicatedBlobCount: number;
}

export interface ResolvedLibraryResource {
  readonly assetId: string;
  readonly artifactId: string;
  readonly path: string;
  readonly mimeType: LibraryImageMimeType;
  readonly byteLength: number;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
}

export interface CopyLibraryArtifactInput {
  readonly assetId?: string;
  readonly artifactId?: string;
  readonly projectRoot: string;
  readonly relativeDirectory?: string;
  readonly requestedBaseName?: string;
}

export interface CopiedLibraryArtifact {
  readonly path: string;
  readonly fileName: string;
  readonly mimeType: LibraryImageMimeType;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface LibraryAssetStoreOptions extends ImageLibraryIndexStoreOptions {
  readonly indexStore?: ImageLibraryIndexStore;
  readonly now?: () => Date;
  readonly idFactory?: (kind: "asset" | "artifact" | "transaction") => string;
  readonly maxImageBytes?: number;
  readonly protectedRoots?: readonly string[];
}

interface PreparedAssetIngestion {
  readonly assetId: string;
  readonly primaryArtifactId: string;
  readonly prompt: string;
  readonly model: string;
  readonly status: Exclude<LibraryAssetStatus, "deleted">;
  readonly requestedParams: LibraryOperationParameters;
  readonly effectiveParams: LibraryOperationParameters;
  readonly execution: OperationExecutionMetadata;
  readonly error?: RoutegoServiceError;
  readonly relationships: readonly LibraryRelationship[];
  readonly folderIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly renditions: readonly {
    readonly artifactId: string;
    readonly phase: "source" | "partial" | "final";
    readonly requestedBaseName: string;
    readonly image: ValidatedLibraryImage;
    readonly verifiedProviderMime: boolean;
  }[];
}

function platformKind(platform: NodeJS.Platform): "win32" | "posix" {
  return platform === "win32" ? "win32" : "posix";
}

function pathApi(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function isContained(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  return isPathIdentityContained(root, candidate, platformKind(platform));
}

function overlaps(left: string, right: string, platform: NodeJS.Platform): boolean {
  return pathIdentitiesOverlap(left, right, platformKind(platform));
}

function timestamp(value: Date, label: string): string {
  if (!Number.isFinite(value.getTime())) {
    throw new LibraryError("invalid_input", `${label} is invalid.`);
  }
  return value.toISOString();
}

function extensionForMime(mimeType: LibraryImageMimeType): string {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg") return ".jpg";
  return ".webp";
}

function parseGenerationParameters(value: LibraryOperationParameters): LibraryOperationParameters {
  const { action: _action, imageIds: _imageIds, fileIds: _fileIds, ...parameters } = value as
    LibraryOperationParameters & {
      readonly action?: unknown;
      readonly imageIds?: unknown;
      readonly fileIds?: unknown;
    };
  void _action;
  void _imageIds;
  void _fileIds;
  return libraryOperationParametersSchema.parse(parameters);
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

function pngPassDimensions(
  width: number,
  height: number,
  interlace: number
): readonly { readonly width: number; readonly height: number }[] {
  if (interlace === 0) return [{ width, height }];
  const xStarts = [0, 4, 0, 2, 0, 1, 0] as const;
  const yStarts = [0, 0, 4, 0, 2, 0, 1] as const;
  const xSteps = [8, 8, 4, 4, 2, 2, 1] as const;
  const ySteps = [8, 8, 8, 4, 4, 2, 2] as const;
  return xStarts.map((xStart, index) => {
    const yStart = yStarts[index]!;
    const xStep = xSteps[index]!;
    const yStep = ySteps[index]!;
    return {
      width: width <= xStart ? 0 : Math.ceil((width - xStart) / xStep),
      height: height <= yStart ? 0 : Math.ceil((height - yStart) / yStep)
    };
  });
}

function parsePng(bytes: Buffer): { readonly width: number; readonly height: number } | undefined {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(signature)) return undefined;
  let position = 8;
  let width: number | undefined;
  let height: number | undefined;
  let bitDepth: number | undefined;
  let colorType: number | undefined;
  let interlace: number | undefined;
  let sawIdat = false;
  let idatEnded = false;
  let sawIend = false;
  const imageData: Buffer[] = [];
  while (position < bytes.length) {
    if (position + 12 > bytes.length) {
      throw new LibraryError("upload_invalid_type", "The PNG file is truncated.");
    }
    const length = bytes.readUInt32BE(position);
    const typeStart = position + 4;
    const dataStart = position + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    if (dataEnd < dataStart || crcEnd > bytes.length) {
      throw new LibraryError("upload_invalid_type", "The PNG chunk length is invalid.");
    }
    const chunkType = bytes.toString("ascii", typeStart, dataStart);
    if (!/^[A-Za-z]{4}$/u.test(chunkType)) {
      throw new LibraryError("upload_invalid_type", "The PNG chunk type is invalid.");
    }
    if (crc32(bytes.subarray(typeStart, dataEnd)) !== bytes.readUInt32BE(dataEnd)) {
      throw new LibraryError("upload_invalid_type", "The PNG chunk checksum is invalid.");
    }
    if (position === 8 && chunkType !== "IHDR") {
      throw new LibraryError("upload_invalid_type", "The PNG header chunk is missing.");
    }
    if (chunkType === "IHDR") {
      if (position !== 8 || length !== 13 || width !== undefined) {
        throw new LibraryError("upload_invalid_type", "The PNG header is invalid.");
      }
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      interlace = bytes[dataStart + 12];
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
        bytes[dataStart + 10] !== 0 ||
        bytes[dataStart + 11] !== 0 ||
        (interlace !== 0 && interlace !== 1)
      ) {
        throw new LibraryError("upload_invalid_type", "The PNG header fields are invalid.");
      }
    } else if (chunkType === "IDAT") {
      if (idatEnded || length < 1) {
        throw new LibraryError("upload_invalid_type", "The PNG image data is invalid.");
      }
      sawIdat = true;
      imageData.push(bytes.subarray(dataStart, dataEnd));
    } else {
      if (sawIdat) idatEnded = true;
      if (chunkType === "IEND") {
        if (length !== 0 || !sawIdat || crcEnd !== bytes.length) {
          throw new LibraryError("upload_invalid_type", "The PNG end chunk is invalid.");
        }
        sawIend = true;
      } else if (chunkType[0] === chunkType[0]?.toUpperCase() && !["PLTE"].includes(chunkType)) {
        throw new LibraryError("upload_invalid_type", "The PNG contains an unsupported critical chunk.");
      }
    }
    position = crcEnd;
    if (sawIend) break;
  }
  if (
    !sawIend ||
    width === undefined ||
    height === undefined ||
    bitDepth === undefined ||
    colorType === undefined ||
    interlace === undefined ||
    position !== bytes.length
  ) {
    throw new LibraryError("upload_invalid_type", "The PNG file is incomplete.");
  }
  const channelCount = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
  const bitsPerPixel = channelCount * bitDepth;
  const passes = pngPassDimensions(width, height, interlace);
  const expectedLength = passes.reduce((total, pass) => {
    if (pass.width === 0 || pass.height === 0) return total;
    return total + pass.height * (1 + Math.ceil((pass.width * bitsPerPixel) / 8));
  }, 0);
  if (!Number.isSafeInteger(expectedLength) || expectedLength > MAX_PNG_DECODED_BYTES) {
    throw new LibraryError("upload_oversize", "The PNG decoded image exceeds the Library limit.");
  }
  let decoded: Buffer;
  try {
    decoded = inflateSync(Buffer.concat(imageData), { maxOutputLength: expectedLength + 1 });
  } catch (error) {
    throw new LibraryError("upload_invalid_type", "The PNG compressed image data is invalid.", {
      cause: error
    });
  }
  if (decoded.byteLength !== expectedLength) {
    throw new LibraryError("upload_invalid_type", "The PNG decoded image length is invalid.");
  }
  let decodedOffset = 0;
  for (const pass of passes) {
    if (pass.width === 0 || pass.height === 0) continue;
    const rowLength = Math.ceil((pass.width * bitsPerPixel) / 8);
    for (let row = 0; row < pass.height; row += 1) {
      if (decoded[decodedOffset] === undefined || decoded[decodedOffset]! > 4) {
        throw new LibraryError("upload_invalid_type", "The PNG row filter is invalid.");
      }
      decodedOffset += 1 + rowLength;
    }
  }
  return { width, height };
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
]);

function parseJpeg(bytes: Buffer): { readonly width: number; readonly height: number } | undefined {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let position = 2;
  let width: number | undefined;
  let height: number | undefined;
  let sawScan = false;
  while (position < bytes.length) {
    if (bytes[position] !== 0xff) {
      throw new LibraryError("upload_invalid_type", "The JPEG marker stream is invalid.");
    }
    while (position < bytes.length && bytes[position] === 0xff) position += 1;
    if (position >= bytes.length) {
      throw new LibraryError("upload_invalid_type", "The JPEG file is truncated.");
    }
    const marker = bytes[position]!;
    position += 1;
    if (marker === 0xd9) {
      if (!sawScan || width === undefined || height === undefined || position !== bytes.length) {
        throw new LibraryError("upload_invalid_type", "The JPEG end marker is invalid.");
      }
      return { width, height };
    }
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      throw new LibraryError("upload_invalid_type", "The JPEG marker is invalid outside scan data.");
    }
    if (position + 2 > bytes.length) {
      throw new LibraryError("upload_invalid_type", "The JPEG segment is truncated.");
    }
    const segmentLength = bytes.readUInt16BE(position);
    if (segmentLength < 2 || position + segmentLength > bytes.length) {
      throw new LibraryError("upload_invalid_type", "The JPEG segment length is invalid.");
    }
    const dataStart = position + 2;
    const segmentEnd = position + segmentLength;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 8) {
        throw new LibraryError("upload_invalid_type", "The JPEG frame header is invalid.");
      }
      height = bytes.readUInt16BE(dataStart + 1);
      width = bytes.readUInt16BE(dataStart + 3);
      if (!validDimension(width) || !validDimension(height)) {
        throw new LibraryError("upload_invalid_type", "The JPEG dimensions are invalid.");
      }
    }
    position = segmentEnd;
    if (marker !== 0xda) continue;
    if (width === undefined || height === undefined) {
      throw new LibraryError("upload_invalid_type", "The JPEG scan precedes its frame header.");
    }
    sawScan = true;
    while (position < bytes.length) {
      if (bytes[position] !== 0xff) {
        position += 1;
        continue;
      }
      let next = position + 1;
      while (next < bytes.length && bytes[next] === 0xff) next += 1;
      if (next >= bytes.length) {
        throw new LibraryError("upload_invalid_type", "The JPEG scan is truncated.");
      }
      const scanMarker = bytes[next]!;
      if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
        position = next + 1;
        continue;
      }
      break;
    }
  }
  throw new LibraryError("upload_invalid_type", "The JPEG end marker is missing.");
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function parseWebp(bytes: Buffer): { readonly width: number; readonly height: number } | undefined {
  if (
    bytes.length < 12 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return undefined;
  }
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) {
    throw new LibraryError("upload_invalid_type", "The WebP RIFF length is invalid.");
  }
  let position = 12;
  let canvas: { readonly width: number; readonly height: number } | undefined;
  let image: { readonly width: number; readonly height: number } | undefined;
  while (position < bytes.length) {
    if (position + 8 > bytes.length) {
      throw new LibraryError("upload_invalid_type", "The WebP chunk header is truncated.");
    }
    const chunkType = bytes.toString("ascii", position, position + 4);
    const chunkLength = bytes.readUInt32LE(position + 4);
    const dataStart = position + 8;
    const dataEnd = dataStart + chunkLength;
    const paddedEnd = dataEnd + (chunkLength % 2);
    if (dataEnd < dataStart || paddedEnd > bytes.length) {
      throw new LibraryError("upload_invalid_type", "The WebP chunk length is invalid.");
    }
    if (chunkType === "VP8X") {
      if (position !== 12 || chunkLength !== 10 || canvas !== undefined) {
        throw new LibraryError("upload_invalid_type", "The WebP extended header is invalid.");
      }
      if ((bytes[dataStart]! & 0x02) !== 0) {
        throw new LibraryError("upload_invalid_type", "Animated WebP is not supported.");
      }
      canvas = {
        width: readUInt24LE(bytes, dataStart + 4) + 1,
        height: readUInt24LE(bytes, dataStart + 7) + 1
      };
    } else if (chunkType === "VP8L") {
      if (image !== undefined || chunkLength < 6 || bytes[dataStart] !== 0x2f) {
        throw new LibraryError("upload_invalid_type", "The lossless WebP header is invalid.");
      }
      const b1 = bytes[dataStart + 1]!;
      const b2 = bytes[dataStart + 2]!;
      const b3 = bytes[dataStart + 3]!;
      const b4 = bytes[dataStart + 4]!;
      image = {
        width: 1 + (b1 | ((b2 & 0x3f) << 8)),
        height: 1 + ((b2 >>> 6) | (b3 << 2) | ((b4 & 0x0f) << 10))
      };
    } else if (chunkType === "VP8 ") {
      if (
        image !== undefined ||
        chunkLength < 11 ||
        bytes[dataStart + 3] !== 0x9d ||
        bytes[dataStart + 4] !== 0x01 ||
        bytes[dataStart + 5] !== 0x2a
      ) {
        throw new LibraryError("upload_invalid_type", "The lossy WebP frame header is invalid.");
      }
      image = {
        width: bytes.readUInt16LE(dataStart + 6) & 0x3fff,
        height: bytes.readUInt16LE(dataStart + 8) & 0x3fff
      };
    } else if (chunkType === "ANIM" || chunkType === "ANMF") {
      throw new LibraryError("upload_invalid_type", "Animated WebP is not supported.");
    }
    position = paddedEnd;
  }
  const dimensions = image ?? canvas;
  if (
    position !== bytes.length ||
    image === undefined ||
    dimensions === undefined ||
    !validDimension(dimensions.width) ||
    !validDimension(dimensions.height) ||
    (canvas !== undefined &&
      (canvas.width !== image.width || canvas.height !== image.height))
  ) {
    throw new LibraryError("upload_invalid_type", "The WebP image structure is invalid.");
  }
  return dimensions;
}

function validateClaim(actual: ValidatedLibraryImage, expected: LibraryImageClaim | undefined): void {
  if (!expected) return;
  const matches =
    (expected.mimeType === undefined || expected.mimeType === actual.mimeType) &&
    (expected.byteLength === undefined || expected.byteLength === actual.byteLength) &&
    (expected.sha256 === undefined || expected.sha256 === actual.sha256) &&
    (expected.width === undefined || expected.width === actual.width) &&
    (expected.height === undefined || expected.height === actual.height);
  if (!matches) {
    throw new LibraryError("invalid_input", "The image does not match its declared metadata.");
  }
}

async function validateAbsoluteImage(
  filePath: string,
  maxBytes: number,
  expected?: LibraryImageClaim
): Promise<ValidatedLibraryImage> {
  const fileStat = await lstat(filePath).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) {
      throw new LibraryError("not_found", "The image source does not exist.");
    }
    throw error;
  });
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new LibraryError("path_unsafe", "The image source must be a regular non-symlink file.");
  }
  if (fileStat.size < 1 || fileStat.size > maxBytes) {
    throw new LibraryError("upload_oversize", "The image source violates the Library size limit.");
  }
  const bytes = await readFile(filePath);
  if (bytes.byteLength !== fileStat.size) {
    throw new LibraryError("conflict", "The image source changed while it was being read.");
  }
  const png = parsePng(bytes);
  const jpeg = png ? undefined : parseJpeg(bytes);
  const webp = png || jpeg ? undefined : parseWebp(bytes);
  const detected = png
    ? { mimeType: "image/png" as const, ...png }
    : jpeg
      ? { mimeType: "image/jpeg" as const, ...jpeg }
      : webp
        ? { mimeType: "image/webp" as const, ...webp }
        : undefined;
  if (!detected) {
    throw new LibraryError("upload_invalid_type", "The image source type is unsupported.");
  }
  const actual: ValidatedLibraryImage = {
    bytes,
    mimeType: detected.mimeType,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width: detected.width,
    height: detected.height
  };
  validateClaim(actual, expected);
  return actual;
}

async function unlinkRegularFile(filePath: string): Promise<void> {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return;
    await unlink(filePath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

async function flushDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isNodeError(error, "EINVAL") && !isNodeError(error, "EPERM") && !isNodeError(error, "EISDIR")) {
      throw error;
    }
  }
}

export class LibraryAssetStore {
  readonly #platform: NodeJS.Platform;
  readonly #indexStore: ImageLibraryIndexStore;
  readonly #now: () => Date;
  readonly #idFactory: (kind: "asset" | "artifact" | "transaction") => string;
  readonly #maxImageBytes: number;
  readonly #protectedRoots: readonly string[];

  constructor(options: LibraryAssetStoreOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#indexStore =
      options.indexStore ??
      new ImageLibraryIndexStore({
        ...(options.root === undefined ? {} : { root: options.root }),
        ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
        platform: this.#platform,
        ...(options.lockOptions === undefined ? {} : { lockOptions: options.lockOptions }),
        ...(options.hooks === undefined ? {} : { hooks: options.hooks })
      });
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? ((kind) => `${kind}-${randomUUID()}`);
    this.#maxImageBytes = options.maxImageBytes ?? DEFAULT_LIBRARY_IMAGE_MAX_BYTES;
    if (!Number.isSafeInteger(this.#maxImageBytes) || this.#maxImageBytes < 1) {
      throw new LibraryError("invalid_input", "The Library image size limit is invalid.");
    }
    const homeDirectory = options.homeDirectory ?? os.homedir();
    this.#protectedRoots =
      options.protectedRoots ?? createProtectedLegacyRoots(homeDirectory, platformKind(this.#platform));
  }

  get indexStore(): ImageLibraryIndexStore {
    return this.#indexStore;
  }

  #newId(kind: "asset" | "artifact" | "transaction"): string {
    try {
      const value = identifierSchema.parse(this.#idFactory(kind));
      if (kind === "transaction" && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(value)) {
        throw new Error("The transaction identifier is not filesystem safe.");
      }
      return value;
    } catch {
      throw new LibraryError("internal_contract", `The ${kind} identifier factory returned an invalid value.`);
    }
  }

  async #isProtected(candidate: string): Promise<boolean> {
    const platform = platformKind(this.#platform);
    const [canonicalLibraryRoot, canonicalProtectedRoots] = await Promise.all([
      canonicalizePathIdentity(this.#indexStore.paths.root, { platform }),
      canonicalizePathIdentities(this.#protectedRoots, { platform })
    ]);
    if (isContained(canonicalLibraryRoot, candidate, this.#platform)) return false;
    return canonicalProtectedRoots.some((root) => overlaps(root, candidate, this.#platform));
  }

  async #resolveSource(root: string, candidate: string): Promise<string> {
    const lexical = resolveApprovedPath({
      root,
      candidate,
      operation: "read",
      platform: platformKind(this.#platform)
    });
    const platform = platformKind(this.#platform);
    const [canonicalRoot, canonicalCandidate] = await Promise.all([
      canonicalizePathIdentity(root, { platform }).catch(() => {
        throw new LibraryError("path_unsafe", "The approved image source root is unavailable.");
      }),
      canonicalizePathIdentity(lexical, { platform }).catch(() => {
        throw new LibraryError("not_found", "The image source does not exist.");
      })
    ]);
    if (
      !isContained(canonicalRoot, canonicalCandidate, this.#platform) ||
      (await this.#isProtected(canonicalCandidate))
    ) {
      throw new LibraryError("path_unsafe", "The image source is outside an approved new-data root.");
    }
    return canonicalCandidate;
  }

  async validateSource(
    root: string,
    candidate: string,
    expected?: LibraryImageClaim
  ): Promise<ValidatedLibraryImage> {
    return await validateAbsoluteImage(
      await this.#resolveSource(root, candidate),
      this.#maxImageBytes,
      expected
    );
  }

  async #publishBlob(options: {
    readonly image: ValidatedLibraryImage;
    readonly requestedBaseName: string;
    readonly createdAt: string;
    readonly expectedRevision: number;
  }): Promise<{ readonly blob: StoredImageBlob; readonly journal: FileTransactionJournal }> {
    const transactionId = this.#newId("transaction");
    const date = new Date(options.createdAt);
    const year = String(date.getUTCFullYear()).padStart(4, "0");
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const directoryRelative = `blobs/${year}/${month}`;
    const directory = resolveApprovedPath({
      root: this.#indexStore.paths.root,
      candidate: directoryRelative,
      operation: "create",
      platform: platformKind(this.#platform)
    });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const tempRelative = `.transactions/files/${transactionId}.tmp`;
    const tempPath = resolveApprovedPath({
      root: this.#indexStore.paths.root,
      candidate: tempRelative,
      operation: "create",
      platform: platformKind(this.#platform)
    });
    const baseName = sanitizeBaseName(options.requestedBaseName, "routego-image");
    const extension = extensionForMime(options.image.mimeType);
    let journal: FileTransactionJournal = {
      schemaVersion: 1,
      id: transactionId,
      kind: IMAGE_LIBRARY_BLOB_TRANSACTION_KIND,
      state: "prepared",
      createdAt: options.createdAt,
      createdPaths: [tempRelative],
      deleteAfterCommitPaths: [],
      metadata: {
        tempPath: tempRelative,
        sha256: options.image.sha256,
        expectedRevision: options.expectedRevision
      }
    };
    await writeTransactionJournal(this.#indexStore.paths.root, journal);
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(options.image.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    let finalRelative: string | undefined;
    for (let attempt = 1; attempt <= 10_000; attempt += 1) {
      const suffix = attempt === 1 ? "" : `-${attempt}`;
      const candidateRelative = `${directoryRelative}/${baseName}${suffix}${extension}`;
      const candidatePath = resolveApprovedPath({
        root: this.#indexStore.paths.root,
        candidate: candidateRelative,
        operation: "create",
        platform: platformKind(this.#platform)
      });
      journal = {
        ...journal,
        createdPaths: [tempRelative, candidateRelative],
        metadata: { ...journal.metadata, finalPath: candidateRelative }
      };
      await writeTransactionJournal(this.#indexStore.paths.root, journal);
      try {
        await link(tempPath, candidatePath);
        await flushDirectory(directory);
        finalRelative = candidateRelative;
        break;
      } catch (error) {
        if (isNodeError(error, "EEXIST")) continue;
        throw new LibraryError("file_write_failed", "The Library blob could not be published.", {
          cause: error
        });
      }
    }
    if (finalRelative === undefined) {
      throw new LibraryError("conflict", "No exclusive Library filename was available.");
    }
    return {
      blob: {
        sha256: options.image.sha256,
        relativePath: finalRelative,
        mimeType: options.image.mimeType,
        byteLength: options.image.byteLength,
        width: options.image.width,
        height: options.image.height,
        createdAt: options.createdAt
      },
      journal
    };
  }

  async #validateStoredBlob(blob: StoredImageBlob): Promise<ValidatedLibraryImage> {
    const filePath = resolveApprovedPath({
      root: this.#indexStore.paths.root,
      candidate: blob.relativePath,
      operation: "read",
      platform: platformKind(this.#platform)
    });
    return await validateAbsoluteImage(filePath, this.#maxImageBytes, {
      mimeType: blob.mimeType,
      byteLength: blob.byteLength,
      sha256: blob.sha256,
      width: blob.width,
      height: blob.height
    }).catch((error: unknown) => {
      throw new LibraryError("config_corrupt", "A referenced Library blob failed integrity validation.", {
        cause: error
      });
    });
  }

  async #prepareAsset(input: IngestLibraryAssetInput): Promise<PreparedAssetIngestion> {
    if (
      input.renditions.length < 1 ||
      input.renditions.length > MAX_LIBRARY_ASSET_RENDITIONS
    ) {
      throw new LibraryError(
        "invalid_input",
        `A Library asset requires one to ${MAX_LIBRARY_ASSET_RENDITIONS} renditions.`
      );
    }
    const assetId = input.assetId === undefined ? this.#newId("asset") : identifierSchema.parse(input.assetId);
    const requestedParams = parseGenerationParameters(input.requestedParams);
    const effectiveParams = parseGenerationParameters(input.effectiveParams);
    if (requestedParams.kind !== "generate" || effectiveParams.kind !== "generate") {
      throw new LibraryError(
        "invalid_input",
        "Library ingestion accepts generation records only; legacy edits require confirmed migration cleanup."
      );
    }
    const execution = operationExecutionMetadataSchema.parse(input.execution);
    const relationships = (input.relationships ?? []).map((item) =>
      libraryAssetRelationshipSchema.parse(item)
    );
    const folderIds = (input.folderIds ?? []).map((item) => identifierSchema.parse(item));
    if (new Set(folderIds).size !== folderIds.length) {
      throw new LibraryError("invalid_input", "The asset contains duplicate folder memberships.");
    }
    const error = input.error === undefined ? undefined : routegoServiceErrorSchema.parse(input.error);
    const status = libraryAssetStatusSchema.parse(input.status ?? "succeeded");
    if (status === "deleted") {
      throw new LibraryError("invalid_input", "Newly ingested assets cannot start deleted.");
    }
    const createdAt = input.createdAt ?? timestamp(this.#now(), "The Library clock");
    const updatedAt = input.updatedAt ?? createdAt;
    if (
      typeof input.prompt !== "string" ||
      input.prompt.length > 32_000 ||
      typeof input.model !== "string" ||
      input.model.trim() === "" ||
      input.model.length > 200 ||
      !Number.isFinite(Date.parse(createdAt)) ||
      !Number.isFinite(Date.parse(updatedAt)) ||
      Date.parse(createdAt) > Date.parse(updatedAt) ||
      requestedParams.kind !== effectiveParams.kind ||
      input.prompt !== requestedParams.prompt ||
      (status === "failed" && error === undefined)
    ) {
      throw new LibraryError("invalid_input", "The Library asset metadata is invalid.");
    }
    const renditions = [] as Array<{
      readonly artifactId: string;
    readonly phase: "source" | "partial" | "final";
    readonly requestedBaseName: string;
    readonly image: ValidatedLibraryImage;
    readonly verifiedProviderMime: boolean;
  }>;
    for (const rendition of input.renditions) {
      const phase = libraryAssetRenditionPhaseSchema.parse(rendition.phase);
      const artifactId =
        rendition.artifactId === undefined
          ? this.#newId("artifact")
          : identifierSchema.parse(rendition.artifactId);
      renditions.push({
        artifactId,
        phase,
        requestedBaseName: rendition.requestedBaseName ?? artifactId,
        image: await this.validateSource(
          rendition.sourceRoot,
          rendition.sourceRelativePath,
          rendition.expected
        ),
        verifiedProviderMime: rendition.expected?.mimeType !== undefined
      });
    }
    if (new Set(renditions.map((item) => item.artifactId)).size !== renditions.length) {
      throw new LibraryError("conflict", "The asset contains duplicate artifact identities.");
    }
    const primaryArtifactId =
      (input.primaryArtifactId === undefined
        ? undefined
        : identifierSchema.parse(input.primaryArtifactId)) ??
      renditions.findLast((item) => item.phase === "final")?.artifactId ??
      renditions.findLast((item) => item.phase === "partial")?.artifactId ??
      renditions.at(-1)!.artifactId;
    const primaryRendition = renditions.find((item) => item.artifactId === primaryArtifactId);
    if (!primaryRendition) {
      throw new LibraryError("invalid_input", "The primary artifact is not part of the asset.");
    }
    if (primaryRendition.phase === "source") {
      throw new LibraryError("invalid_input", "The primary artifact must be an output rendition.");
    }
    if (
      status === "succeeded" &&
      (primaryRendition.phase !== "final" || !renditions.some((item) => item.phase === "final"))
    ) {
      throw new LibraryError("invalid_input", "A succeeded asset requires a final primary rendition.");
    }
    const effectiveMimeType = effectiveParams.format === "png"
      ? "image/png"
      : effectiveParams.format === "jpeg"
        ? "image/jpeg"
        : "image/webp";
    if (renditions.some(
      (item) => item.phase !== "source" &&
        item.image.mimeType !== effectiveMimeType &&
        !item.verifiedProviderMime
    )) {
      throw new LibraryError("invalid_input", "The output image type is not verified against the provider result.");
    }
    for (const relationship of relationships) {
      if (relationship.role !== "output") continue;
      if (relationship.relatedAssetId !== assetId || relationship.artifactId === undefined) {
        throw new LibraryError(
          "invalid_input",
          "Output relationships must identify exact artifacts on the ingested asset."
        );
      }
      const outputRendition = renditions.find(
        (rendition) => rendition.artifactId === relationship.artifactId
      );
      if (!outputRendition || outputRendition.phase === "source") {
        throw new LibraryError(
          "invalid_input",
          "Output relationships must reference partial or final renditions."
        );
      }
    }

    return {
      assetId,
      primaryArtifactId,
      prompt: input.prompt,
      model: input.model.trim(),
      status,
      requestedParams,
      effectiveParams,
      execution,
      ...(error === undefined ? {} : { error }),
      relationships,
      folderIds,
      createdAt,
      updatedAt,
      renditions
    };
  }

  async ingestAssets(inputs: readonly IngestLibraryAssetInput[]): Promise<readonly IngestLibraryAssetResult[]> {
    if (inputs.length < 1 || inputs.length > 200) {
      throw new LibraryError("invalid_input", "A Library batch requires one to two hundred assets.");
    }
    const preparedAssets: PreparedAssetIngestion[] = [];
    let aggregateBytes = 0;
    for (const input of inputs) {
      const prepared = await this.#prepareAsset(input);
      aggregateBytes += prepared.renditions.reduce((total, item) => total + item.image.byteLength, 0);
      if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > 536_870_912) {
        throw new LibraryError("upload_oversize", "The Library ingestion batch exceeds its size limit.");
      }
      preparedAssets.push(prepared);
    }
    if (new Set(preparedAssets.map((item) => item.assetId)).size !== preparedAssets.length) {
      throw new LibraryError("conflict", "The ingestion batch contains duplicate asset identities.");
    }
    const batchArtifacts = preparedAssets.flatMap((asset) =>
      asset.renditions.map((rendition) => rendition.artifactId)
    );
    if (new Set(batchArtifacts).size !== batchArtifacts.length) {
      throw new LibraryError("conflict", "The ingestion batch contains duplicate artifact identities.");
    }

    return await this.#indexStore.runExclusive(async ({ index, commit }) => {
      const existingAssetIds = new Set(index.assets.map((asset) => asset.id));
      if (preparedAssets.some((asset) => existingAssetIds.has(asset.assetId))) {
        throw new LibraryError("conflict", "A Library asset identity already exists.");
      }
      const existingArtifacts = new Set(
        index.assets.flatMap((asset) => asset.renditions.map((rendition) => rendition.artifactId))
      );
      if (batchArtifacts.some((artifactId) => existingArtifacts.has(artifactId))) {
        throw new LibraryError("conflict", "A Library artifact identity already exists.");
      }
      const availableAssetIds = new Set([
        ...index.assets.map((item) => item.id),
        ...preparedAssets.map((item) => item.assetId)
      ]);
      if (
        preparedAssets.some((asset) =>
          asset.relationships.some(
            (relationship) => !availableAssetIds.has(relationship.relatedAssetId)
          )
        )
      ) {
        throw new LibraryError("invalid_input", "An asset relationship references a missing asset.");
      }
      const availableFolderIds = new Set(index.folders.map((folder) => folder.id));
      if (
        preparedAssets.some((asset) =>
          asset.folderIds.some((folderId) => !availableFolderIds.has(folderId))
        )
      ) {
        throw new LibraryError("invalid_input", "A folder membership references a missing folder.");
      }
      const artifactOwners = new Map<string, string>();
      for (const asset of index.assets) {
        for (const rendition of asset.renditions) artifactOwners.set(rendition.artifactId, asset.id);
      }
      for (const asset of preparedAssets) {
        for (const rendition of asset.renditions) artifactOwners.set(rendition.artifactId, asset.assetId);
      }
      if (
        preparedAssets.some((asset) =>
          asset.relationships.some(
            (relationship) =>
              relationship.artifactId !== undefined &&
              artifactOwners.get(relationship.artifactId) !== relationship.relatedAssetId
          )
        )
      ) {
        throw new LibraryError("invalid_input", "An asset relationship has inconsistent artifact ownership.");
      }

      const blobBySha = new Map(index.blobs.map((blob) => [blob.sha256, blob]));
      const newBlobs: StoredImageBlob[] = [];
      const journals: FileTransactionJournal[] = [];
      const validatedExisting = new Set<string>();
      const deduplicatedCounts = new Map<string, number>();
      for (const asset of preparedAssets) {
        let deduplicatedBlobCount = 0;
        for (const rendition of asset.renditions) {
          const existing = blobBySha.get(rendition.image.sha256);
          if (existing) {
            if (!validatedExisting.has(existing.sha256)) {
              await this.#validateStoredBlob(existing);
              validatedExisting.add(existing.sha256);
            }
            deduplicatedBlobCount += 1;
            continue;
          }
          const published = await this.#publishBlob({
            image: rendition.image,
            requestedBaseName: rendition.requestedBaseName,
            createdAt: asset.createdAt,
            expectedRevision: index.revision + 1
          });
          newBlobs.push(published.blob);
          journals.push(published.journal);
          blobBySha.set(published.blob.sha256, published.blob);
          validatedExisting.add(published.blob.sha256);
        }
        deduplicatedCounts.set(asset.assetId, deduplicatedBlobCount);
      }

      const assets: StoredLibraryAsset[] = preparedAssets.map((asset) => ({
        id: asset.assetId,
        prompt: asset.prompt,
        model: asset.model,
        kind: "generate",
        status: asset.status,
        primaryArtifactId: asset.primaryArtifactId,
        createdAt: asset.createdAt,
        updatedAt: asset.updatedAt,
        requestedParams: asset.requestedParams,
        effectiveParams: asset.effectiveParams,
        execution: asset.execution,
        ...(asset.error === undefined ? {} : { error: asset.error }),
        renditions: asset.renditions.map((rendition) => ({
          artifactId: rendition.artifactId,
          phase: rendition.phase,
          blobSha256: rendition.image.sha256,
          createdAt: asset.createdAt
        })),
        relationships: asset.relationships,
        folderIds: asset.folderIds
      }));
      const committed = await commit({
        blobs: [...index.blobs, ...newBlobs],
        assets: [...index.assets, ...assets],
        folders: index.folders
      });
      for (const journal of journals) {
        await markTransactionJournalCommitted(this.#indexStore.paths.root, journal);
        const tempRelative = journal.metadata?.["tempPath"];
        if (typeof tempRelative === "string") {
          await unlinkRegularFile(
            resolveApprovedPath({
              root: this.#indexStore.paths.root,
              candidate: tempRelative,
              operation: "delete",
              platform: platformKind(this.#platform)
            })
          );
        }
        await removeTransactionJournal(this.#indexStore.paths.root, journal.id);
      }
      const committedById = new Map(committed.assets.map((asset) => [asset.id, asset]));
      return preparedAssets.map((prepared) => {
        const committedAsset = committedById.get(prepared.assetId)!;
        return {
          asset: committedAsset,
          blobs: committedAsset.renditions.map(
            (rendition) => blobBySha.get(rendition.blobSha256)!
          ),
          deduplicatedBlobCount: deduplicatedCounts.get(prepared.assetId) ?? 0
        };
      });
    });
  }

  async ingestAsset(input: IngestLibraryAssetInput): Promise<IngestLibraryAssetResult> {
    return (await this.ingestAssets([input]))[0]!;
  }

  async #resolveUnderIndex(
    index: ImageLibraryIndex,
    options: { readonly assetId?: string; readonly artifactId?: string }
  ): Promise<{ readonly resource: ResolvedLibraryResource; readonly image: ValidatedLibraryImage }> {
    let asset: StoredLibraryAsset | undefined;
    let artifactId: string | undefined;
    if (options.artifactId !== undefined) {
      artifactId = identifierSchema.parse(options.artifactId);
      asset = index.assets.find((item) =>
        item.renditions.some((rendition) => rendition.artifactId === artifactId)
      );
    } else if (options.assetId !== undefined) {
      const assetId = identifierSchema.parse(options.assetId);
      asset = index.assets.find((item) => item.id === assetId);
      artifactId = asset?.primaryArtifactId;
    }
    if (!asset || !artifactId) {
      throw new LibraryError("not_found", "The Library resource does not exist.");
    }
    const rendition = asset.renditions.find((item) => item.artifactId === artifactId);
    const blob = index.blobs.find((item) => item.sha256 === rendition?.blobSha256);
    if (!rendition || !blob) {
      throw new LibraryError("config_corrupt", "The Library resource metadata is inconsistent.");
    }
    const image = await this.#validateStoredBlob(blob);
    return {
      resource: {
        assetId: asset.id,
        artifactId,
        path: resolveApprovedPath({
          root: this.#indexStore.paths.root,
          candidate: blob.relativePath,
          operation: "read",
          platform: platformKind(this.#platform)
        }),
        mimeType: blob.mimeType,
        byteLength: blob.byteLength,
        sha256: blob.sha256,
        width: blob.width,
        height: blob.height
      },
      image
    };
  }

  async resolveAsset(assetId: string): Promise<ResolvedLibraryResource> {
    return await this.#indexStore.runExclusive(async ({ index }) =>
      (await this.#resolveUnderIndex(index, { assetId })).resource
    );
  }

  async resolveArtifact(artifactId: string): Promise<ResolvedLibraryResource> {
    return await this.#indexStore.runExclusive(async ({ index }) =>
      (await this.#resolveUnderIndex(index, { artifactId })).resource
    );
  }

  async #prepareProjectDirectory(projectRootInput: string, relativeDirectory: string): Promise<string> {
    const selectedPath = pathApi(this.#platform);
    const projectRoot = selectedPath.resolve(projectRootInput);
    if (this.#protectedRoots.some((root) => overlaps(root, projectRoot, this.#platform))) {
      throw new LibraryError("path_unsafe", "The project destination overlaps protected legacy data.");
    }
    let rootMetadata;
    try {
      rootMetadata = await lstat(projectRoot);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new LibraryError("not_found", "The approved project destination does not exist.");
      }
      throw error;
    }
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new LibraryError("path_unsafe", "The project destination root is unsafe.");
    }
    const platform = platformKind(this.#platform);
    const [canonicalRoot, canonicalProtectedRoots] = await Promise.all([
      canonicalizePathIdentity(projectRoot, { platform }),
      canonicalizePathIdentities(this.#protectedRoots, { platform })
    ]);
    if (canonicalProtectedRoots.some((root) => overlaps(root, canonicalRoot, this.#platform))) {
      throw new LibraryError("path_unsafe", "The project destination resolves to protected legacy data.");
    }
    const directory = resolveApprovedPath({
      root: projectRoot,
      candidate: relativeDirectory,
      operation: "create",
      platform: platformKind(this.#platform)
    });
    const relative = selectedPath.relative(projectRoot, directory);
    let current = projectRoot;
    for (const segment of relative.split(selectedPath.sep).filter((item) => item !== "" && item !== ".")) {
      current = selectedPath.join(current, segment);
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new LibraryError("path_unsafe", "The project destination contains an unsafe component.");
      }
      const canonicalCurrent = await canonicalizePathIdentity(current, { platform });
      if (!isContained(canonicalRoot, canonicalCurrent, this.#platform)) {
        throw new LibraryError("path_unsafe", "The project destination escapes through a symlink.");
      }
    }
    return await canonicalizePathIdentity(current, { platform });
  }

  async copyArtifactToProject(input: CopyLibraryArtifactInput): Promise<CopiedLibraryArtifact> {
    if ((input.assetId === undefined) === (input.artifactId === undefined)) {
      throw new LibraryError("invalid_input", "Choose exactly one asset or artifact to copy.");
    }
    return await this.#indexStore.runExclusive(async ({ index }) => {
      const resolved = await this.#resolveUnderIndex(index, {
        ...(input.assetId === undefined ? {} : { assetId: input.assetId }),
        ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId })
      });
      const selectedPath = pathApi(this.#platform);
      const canonicalDirectory = await this.#prepareProjectDirectory(
        input.projectRoot,
        input.relativeDirectory ?? "."
      );
      const exclusive = await createExclusiveFile({
        directory: canonicalDirectory,
        requestedBaseName: input.requestedBaseName ?? resolved.resource.assetId,
        extension: extensionForMime(resolved.resource.mimeType)
      });
      try {
        await exclusive.handle.writeFile(resolved.image.bytes);
        await exclusive.handle.sync();
        await flushDirectory(canonicalDirectory);
      } catch (error) {
        await exclusive.handle.close().catch(() => undefined);
        await unlinkRegularFile(exclusive.path);
        throw new LibraryError("file_write_failed", "The project asset copy could not be written.", {
          cause: error
        });
      } finally {
        await exclusive.handle.close().catch(() => undefined);
      }
      return {
        path: exclusive.path,
        fileName: selectedPath.basename(exclusive.path),
        mimeType: resolved.resource.mimeType,
        byteLength: resolved.resource.byteLength,
        sha256: resolved.resource.sha256
      };
    });
  }
}
