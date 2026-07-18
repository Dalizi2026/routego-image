import { randomUUID } from "node:crypto";
import path from "node:path";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { deflateRawSync, inflateRawSync } from "node:zlib";

import { LibraryError, isNodeError } from "../errors";
import { createExclusiveFile, sanitizeBaseName } from "../fs/paths";
import { crc32 } from "./crc32";

const LOCAL_FILE_HEADER_SIGNATURE = 0x0403_4b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x0201_4b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x0605_4b50;
const LOCAL_FILE_HEADER_LENGTH = 30;
const CENTRAL_DIRECTORY_HEADER_LENGTH = 46;
const END_OF_CENTRAL_DIRECTORY_LENGTH = 22;
const MAX_ZIP_COMMENT_BYTES = 65_535;
const UTF8_FLAG = 0x0800;
const DEFLATE_OPTION_FLAGS = 0x0006;
const ENCRYPTION_FLAGS = 0x2041;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const ZIP64_UINT16 = 0xffff;
const ZIP64_UINT32 = 0xffff_ffff;
const UNIX_HOST_IDS = new Set([3, 19]);
const UNIX_FILE_TYPE_MASK = 0xf000;
const UNIX_REGULAR_FILE_TYPE = 0x8000;
const DOS_DIRECTORY_ATTRIBUTE = 0x10;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type ZipCompression = "store" | "deflate";

export interface ZipCodecLimits {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  readonly maxNameBytes: number;
  readonly maxEntryUncompressedBytes: number;
  readonly maxTotalUncompressedBytes: number;
  readonly maxExpansionRatio: number;
}

export const DEFAULT_ZIP_CODEC_LIMITS: ZipCodecLimits = Object.freeze({
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntries: 10_000,
  maxNameBytes: 4_096,
  maxEntryUncompressedBytes: 128 * 1024 * 1024,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxExpansionRatio: 100
});

export interface ZipSourceEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly compression?: ZipCompression;
  readonly modifiedAt?: Date;
}

export interface EncodeZipArchiveOptions {
  readonly limits?: Partial<ZipCodecLimits>;
  readonly defaultCompression?: ZipCompression;
  readonly modifiedAt?: Date;
}

export interface DecodeZipArchiveOptions {
  readonly limits?: Partial<ZipCodecLimits>;
}

export interface DecodedZipEntry {
  readonly name: string;
  readonly data: Buffer;
  readonly compression: ZipCompression;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

export interface DecodedZipArchive {
  readonly byteLength: number;
  readonly entries: readonly DecodedZipEntry[];
}

export interface ZipPublicationHooks {
  readonly afterTemporaryFileSynced?: (temporaryPath: string) => Promise<void>;
  readonly beforePublish?: (temporaryPath: string, finalPath: string) => Promise<void>;
}

export interface PublishZipArchiveOptions extends EncodeZipArchiveOptions {
  readonly directory: string;
  readonly requestedBaseName: string;
  readonly maxNameAttempts?: number;
  readonly hooks?: ZipPublicationHooks;
}

export interface PublishedZipArchive {
  readonly path: string;
  readonly fileName: string;
  readonly byteLength: number;
  readonly entryCount: number;
}

interface PortableName {
  readonly value: string;
  readonly bytes: Buffer;
  readonly canonical: string;
}

interface PreparedZipEntry {
  readonly name: PortableName;
  readonly compression: ZipCompression;
  readonly method: 0 | 8;
  readonly compressed: Buffer;
  readonly uncompressedSize: number;
  readonly checksum: number;
  readonly dosTime: number;
  readonly dosDate: number;
  readonly localOffset: number;
}

interface CentralDirectoryEntry {
  readonly versionMadeBy: number;
  readonly versionNeeded: number;
  readonly flags: number;
  readonly method: 0 | 8;
  readonly dosTime: number;
  readonly dosDate: number;
  readonly checksum: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly name: PortableName;
  readonly localOffset: number;
  readonly externalAttributes: number;
}

function invalidArchive(message = "The ZIP archive is malformed or unsupported.", cause?: unknown): never {
  throw new LibraryError("upload_invalid_type", message, {
    ...(cause === undefined ? {} : { cause })
  });
}

function archiveLimit(message = "The ZIP archive exceeds the configured safety limits."): never {
  throw new LibraryError("upload_oversize", message);
}

function invalidWriterInput(message: string): never {
  throw new LibraryError("invalid_input", message);
}

function resolveLimits(input: Partial<ZipCodecLimits> | undefined): ZipCodecLimits {
  const limits: ZipCodecLimits = { ...DEFAULT_ZIP_CODEC_LIMITS, ...input };
  const integerLimits: readonly [keyof ZipCodecLimits, number, number][] = [
    ["maxArchiveBytes", END_OF_CENTRAL_DIRECTORY_LENGTH, ZIP64_UINT32 - 1],
    ["maxEntries", 1, ZIP64_UINT16 - 1],
    ["maxNameBytes", 1, ZIP64_UINT16 - 1],
    ["maxEntryUncompressedBytes", 1, ZIP64_UINT32 - 1],
    ["maxTotalUncompressedBytes", 1, Number.MAX_SAFE_INTEGER]
  ];
  for (const [key, minimum, maximum] of integerLimits) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      invalidWriterInput("The ZIP codec limits are invalid.");
    }
  }
  if (
    limits.maxEntryUncompressedBytes > limits.maxTotalUncompressedBytes ||
    !Number.isFinite(limits.maxExpansionRatio) ||
    limits.maxExpansionRatio < 1 ||
    limits.maxExpansionRatio > 1_000_000
  ) {
    invalidWriterInput("The ZIP codec limits are invalid.");
  }
  return limits;
}

function checkRange(bytes: Buffer, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > bytes.byteLength - length
  ) {
    invalidArchive();
  }
}

function validateExtraFields(bytes: Buffer, offset: number, length: number): void {
  checkRange(bytes, offset, length);
  const end = offset + length;
  let cursor = offset;
  while (cursor < end) {
    if (cursor > end - 4) invalidArchive();
    const id = bytes.readUInt16LE(cursor);
    const fieldLength = bytes.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor > end - fieldLength) invalidArchive();
    if (id === ZIP64_EXTRA_FIELD_ID) {
      invalidArchive("ZIP64 archives are not supported.");
    }
    cursor += fieldLength;
  }
}

function hasUnsafePortableNameSyntax(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.startsWith("//") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return true;
  }
  const segments = value.split("/");
  return segments.some(
    (segment) =>
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      /[. ]$/u.test(segment) ||
      /[<>:"|?*]/u.test(segment) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment)
  );
}

function validatePortableName(value: string, maxNameBytes: number): PortableName {
  if (typeof value !== "string") {
    throw new LibraryError("path_unsafe", "The ZIP entry name is unsafe.");
  }
  const canonicalUnicode = value.normalize("NFKC");
  if (hasUnsafePortableNameSyntax(value) || hasUnsafePortableNameSyntax(canonicalUnicode)) {
    throw new LibraryError("path_unsafe", "The ZIP entry name is unsafe.");
  }
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength < 1 || bytes.byteLength > maxNameBytes) {
    archiveLimit("A ZIP entry name exceeds the configured safety limit.");
  }
  let roundTrip: string;
  try {
    roundTrip = UTF8_DECODER.decode(bytes);
  } catch (error) {
    invalidArchive("The ZIP entry name is not valid UTF-8.", error);
  }
  if (roundTrip !== value) {
    throw new LibraryError("path_unsafe", "The ZIP entry name is unsafe.");
  }
  return {
    value,
    bytes,
    canonical: canonicalUnicode.toLocaleLowerCase("und")
  };
}

function decodeEntryName(bytes: Buffer, flags: number, limits: ZipCodecLimits): PortableName {
  let value: string;
  if ((flags & UTF8_FLAG) !== 0) {
    try {
      value = UTF8_DECODER.decode(bytes);
    } catch (error) {
      invalidArchive("The ZIP entry name is not valid UTF-8.", error);
    }
  } else {
    if (bytes.some((byte) => byte > 0x7f)) {
      invalidArchive("Legacy ZIP filename encodings are not supported.");
    }
    value = bytes.toString("ascii");
  }
  return validatePortableName(value, limits.maxNameBytes);
}

function validateFlags(flags: number, method: number): void {
  if ((flags & ENCRYPTION_FLAGS) !== 0) {
    invalidArchive("Encrypted ZIP entries are not supported.");
  }
  if ((flags & ~(UTF8_FLAG | DEFLATE_OPTION_FLAGS)) !== 0) {
    invalidArchive("The ZIP entry uses unsupported flags.");
  }
  if (method === 0 && (flags & DEFLATE_OPTION_FLAGS) !== 0) {
    invalidArchive("The stored ZIP entry uses inconsistent flags.");
  }
}

function validateRegularFileAttributes(entry: CentralDirectoryEntry): void {
  if ((entry.externalAttributes & DOS_DIRECTORY_ATTRIBUTE) !== 0) {
    invalidArchive("ZIP directories and special entries are not supported.");
  }
  const hostId = entry.versionMadeBy >>> 8;
  if (UNIX_HOST_IDS.has(hostId)) {
    const mode = entry.externalAttributes >>> 16;
    const fileType = mode & UNIX_FILE_TYPE_MASK;
    if (fileType !== 0 && fileType !== UNIX_REGULAR_FILE_TYPE) {
      invalidArchive("ZIP symbolic links and special entries are not supported.");
    }
  }
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  if (bytes.byteLength < END_OF_CENTRAL_DIRECTORY_LENGTH) invalidArchive();
  const minimum = Math.max(
    0,
    bytes.byteLength - END_OF_CENTRAL_DIRECTORY_LENGTH - MAX_ZIP_COMMENT_BYTES
  );
  for (
    let offset = bytes.byteLength - END_OF_CENTRAL_DIRECTORY_LENGTH;
    offset >= minimum;
    offset -= 1
  ) {
    if (bytes.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + END_OF_CENTRAL_DIRECTORY_LENGTH + commentLength === bytes.byteLength) {
      return offset;
    }
  }
  invalidArchive("The ZIP end-of-central-directory record is missing.");
}

function parseCentralDirectory(bytes: Buffer, limits: ZipCodecLimits): {
  readonly entries: readonly CentralDirectoryEntry[];
  readonly centralOffset: number;
} {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  checkRange(bytes, eocdOffset, END_OF_CENTRAL_DIRECTORY_LENGTH);
  const diskNumber = bytes.readUInt16LE(eocdOffset + 4);
  const centralDisk = bytes.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocdOffset + 8);
  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  const centralSize = bytes.readUInt32LE(eocdOffset + 12);
  const centralOffset = bytes.readUInt32LE(eocdOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === ZIP64_UINT16 ||
    centralSize === ZIP64_UINT32 ||
    centralOffset === ZIP64_UINT32
  ) {
    invalidArchive("Multi-disk and ZIP64 archives are not supported.");
  }
  if (entryCount > limits.maxEntries) {
    archiveLimit("The ZIP archive contains too many entries.");
  }
  if (centralOffset > eocdOffset || centralSize !== eocdOffset - centralOffset) {
    invalidArchive("The ZIP central directory range is inconsistent.");
  }
  checkRange(bytes, centralOffset, centralSize);

  const entries: CentralDirectoryEntry[] = [];
  const canonicalNames = new Set<string>();
  let totalUncompressed = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor > eocdOffset - CENTRAL_DIRECTORY_HEADER_LENGTH) invalidArchive();
    if (bytes.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE) invalidArchive();
    const versionMadeBy = bytes.readUInt16LE(cursor + 4);
    const versionNeeded = bytes.readUInt16LE(cursor + 6);
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const dosTime = bytes.readUInt16LE(cursor + 12);
    const dosDate = bytes.readUInt16LE(cursor + 14);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const startDisk = bytes.readUInt16LE(cursor + 34);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    if (
      versionNeeded > 20 ||
      compressedSize === ZIP64_UINT32 ||
      uncompressedSize === ZIP64_UINT32 ||
      localOffset === ZIP64_UINT32 ||
      startDisk !== 0 ||
      (method !== 0 && method !== 8)
    ) {
      invalidArchive("The ZIP entry uses an unsupported format.");
    }
    validateFlags(flags, method);
    if (nameLength < 1) invalidArchive("The ZIP entry name is missing.");
    if (nameLength > limits.maxNameBytes) {
      archiveLimit("A ZIP entry name exceeds the configured safety limit.");
    }
    const variableLength = nameLength + extraLength + commentLength;
    const recordLength = CENTRAL_DIRECTORY_HEADER_LENGTH + variableLength;
    if (cursor > eocdOffset - recordLength) invalidArchive();
    const nameOffset = cursor + CENTRAL_DIRECTORY_HEADER_LENGTH;
    const nameBytes = bytes.subarray(nameOffset, nameOffset + nameLength);
    const name = decodeEntryName(nameBytes, flags, limits);
    if (canonicalNames.has(name.canonical)) {
      invalidArchive("The ZIP archive contains duplicate canonical entry names.");
    }
    canonicalNames.add(name.canonical);
    validateExtraFields(bytes, nameOffset + nameLength, extraLength);
    if (uncompressedSize > limits.maxEntryUncompressedBytes) {
      archiveLimit("A ZIP entry exceeds the configured uncompressed-size limit.");
    }
    if (totalUncompressed > limits.maxTotalUncompressedBytes - uncompressedSize) {
      archiveLimit("The ZIP archive exceeds the configured total expansion limit.");
    }
    totalUncompressed += uncompressedSize;
    if (method === 0 && compressedSize !== uncompressedSize) {
      invalidArchive("A stored ZIP entry has inconsistent lengths.");
    }
    if (uncompressedSize > 0 && compressedSize === 0) {
      invalidArchive("The ZIP entry has an invalid compressed length.");
    }
    if (
      uncompressedSize > 0 &&
      uncompressedSize / Math.max(1, compressedSize) > limits.maxExpansionRatio
    ) {
      archiveLimit("A ZIP entry exceeds the configured expansion-ratio limit.");
    }
    const entry: CentralDirectoryEntry = {
      versionMadeBy,
      versionNeeded,
      flags,
      method,
      dosTime,
      dosDate,
      checksum,
      compressedSize,
      uncompressedSize,
      name,
      localOffset,
      externalAttributes
    };
    validateRegularFileAttributes(entry);
    entries.push(entry);
    cursor += recordLength;
  }
  if (cursor !== eocdOffset) invalidArchive("The ZIP central directory is inconsistent.");
  return { entries, centralOffset };
}

function parseLocalEntries(
  bytes: Buffer,
  centralEntries: readonly CentralDirectoryEntry[],
  centralOffset: number
): readonly { readonly entry: CentralDirectoryEntry; readonly dataStart: number }[] {
  const localOffsets = new Set<number>();
  const intervals: { readonly start: number; readonly end: number }[] = [];
  const parsed: { readonly entry: CentralDirectoryEntry; readonly dataStart: number }[] = [];
  for (const entry of centralEntries) {
    if (localOffsets.has(entry.localOffset)) invalidArchive();
    localOffsets.add(entry.localOffset);
    if (entry.localOffset > centralOffset - LOCAL_FILE_HEADER_LENGTH) invalidArchive();
    checkRange(bytes, entry.localOffset, LOCAL_FILE_HEADER_LENGTH);
    if (bytes.readUInt32LE(entry.localOffset) !== LOCAL_FILE_HEADER_SIGNATURE) invalidArchive();
    const versionNeeded = bytes.readUInt16LE(entry.localOffset + 4);
    const flags = bytes.readUInt16LE(entry.localOffset + 6);
    const method = bytes.readUInt16LE(entry.localOffset + 8);
    const dosTime = bytes.readUInt16LE(entry.localOffset + 10);
    const dosDate = bytes.readUInt16LE(entry.localOffset + 12);
    const checksum = bytes.readUInt32LE(entry.localOffset + 14);
    const compressedSize = bytes.readUInt32LE(entry.localOffset + 18);
    const uncompressedSize = bytes.readUInt32LE(entry.localOffset + 22);
    const nameLength = bytes.readUInt16LE(entry.localOffset + 26);
    const extraLength = bytes.readUInt16LE(entry.localOffset + 28);
    if (
      versionNeeded !== entry.versionNeeded ||
      flags !== entry.flags ||
      method !== entry.method ||
      dosTime !== entry.dosTime ||
      dosDate !== entry.dosDate ||
      checksum !== entry.checksum ||
      compressedSize !== entry.compressedSize ||
      uncompressedSize !== entry.uncompressedSize ||
      nameLength !== entry.name.bytes.byteLength
    ) {
      invalidArchive("The ZIP local and central headers disagree.");
    }
    const nameOffset = entry.localOffset + LOCAL_FILE_HEADER_LENGTH;
    const dataStart = nameOffset + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataStart < nameOffset || dataEnd < dataStart || dataEnd > centralOffset) {
      invalidArchive("The ZIP entry data range is invalid.");
    }
    checkRange(bytes, nameOffset, nameLength + extraLength + entry.compressedSize);
    if (!bytes.subarray(nameOffset, nameOffset + nameLength).equals(entry.name.bytes)) {
      invalidArchive("The ZIP local and central names disagree.");
    }
    validateExtraFields(bytes, nameOffset + nameLength, extraLength);
    intervals.push({ start: entry.localOffset, end: dataEnd });
    parsed.push({ entry, dataStart });
  }
  intervals.sort((left, right) => left.start - right.start);
  let expectedOffset = 0;
  for (const interval of intervals) {
    if (interval.start !== expectedOffset || interval.end < interval.start) {
      invalidArchive("The ZIP local entry ranges overlap or contain unsupported gaps.");
    }
    expectedOffset = interval.end;
  }
  if (expectedOffset !== centralOffset) {
    invalidArchive("The ZIP local entry range is inconsistent with the central directory.");
  }
  return parsed;
}

function bufferView(input: Uint8Array): Buffer {
  if (!(input instanceof Uint8Array)) invalidArchive();
  return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

export function decodeZipArchive(
  input: Uint8Array,
  options: DecodeZipArchiveOptions = {}
): DecodedZipArchive {
  const limits = resolveLimits(options.limits);
  const bytes = bufferView(input);
  if (bytes.byteLength > limits.maxArchiveBytes) archiveLimit();
  const central = parseCentralDirectory(bytes, limits);
  const localEntries = parseLocalEntries(bytes, central.entries, central.centralOffset);
  let totalOutput = 0;
  const entries = localEntries.map(({ entry, dataStart }): DecodedZipEntry => {
    const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);
    let data: Buffer;
    if (entry.method === 0) {
      data = Buffer.from(compressed);
    } else {
      try {
        data = inflateRawSync(compressed, {
          maxOutputLength: Math.min(
            entry.uncompressedSize + 1,
            limits.maxEntryUncompressedBytes + 1
          )
        });
      } catch (error) {
        invalidArchive("The ZIP deflate stream is invalid or exceeds its declared size.", error);
      }
    }
    if (data.byteLength !== entry.uncompressedSize) {
      invalidArchive("The ZIP entry output length does not match its header.");
    }
    if (totalOutput > limits.maxTotalUncompressedBytes - data.byteLength) archiveLimit();
    totalOutput += data.byteLength;
    if (crc32(data) !== entry.checksum) {
      throw new LibraryError("upload_checksum_failed", "A ZIP entry failed its CRC-32 check.");
    }
    return {
      name: entry.name.value,
      data,
      compression: entry.method === 0 ? "store" : "deflate",
      crc32: entry.checksum,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize
    };
  });
  return { byteLength: bytes.byteLength, entries };
}

function dosTimestamp(value: Date): { readonly time: number; readonly date: number } {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    invalidWriterInput("The ZIP entry modification time is invalid.");
  }
  const year = value.getUTCFullYear();
  if (year < 1980 || year > 2107) {
    invalidWriterInput("The ZIP entry modification time is outside the supported range.");
  }
  return {
    time:
      (value.getUTCHours() << 11) |
      (value.getUTCMinutes() << 5) |
      Math.floor(value.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((value.getUTCMonth() + 1) << 5) | value.getUTCDate()
  };
}

function validateCompression(value: unknown): ZipCompression {
  if (value !== "store" && value !== "deflate") {
    invalidWriterInput("The ZIP compression method is invalid.");
  }
  return value;
}

export function encodeZipArchive(
  inputEntries: readonly ZipSourceEntry[],
  options: EncodeZipArchiveOptions = {}
): Buffer {
  const limits = resolveLimits(options.limits);
  if (!Array.isArray(inputEntries)) invalidWriterInput("ZIP entries must be an array.");
  if (inputEntries.length > limits.maxEntries) archiveLimit("The ZIP archive contains too many entries.");
  const defaultCompression = validateCompression(options.defaultCompression ?? "deflate");
  const defaultModifiedAt = options.modifiedAt ?? new Date(Date.UTC(1980, 0, 1));
  const canonicalNames = new Set<string>();
  const prepared: PreparedZipEntry[] = [];
  const localParts: Buffer[] = [];
  let localOffset = 0;
  let totalUncompressed = 0;

  for (const source of inputEntries) {
    if (source === null || typeof source !== "object" || !(source.data instanceof Uint8Array)) {
      invalidWriterInput("A ZIP entry is invalid.");
    }
    const name = validatePortableName(source.name, limits.maxNameBytes);
    if (canonicalNames.has(name.canonical)) {
      invalidWriterInput("ZIP entries must have unique canonical names.");
    }
    canonicalNames.add(name.canonical);
    const data = Buffer.from(source.data);
    if (data.byteLength > limits.maxEntryUncompressedBytes) {
      archiveLimit("A ZIP entry exceeds the configured uncompressed-size limit.");
    }
    if (totalUncompressed > limits.maxTotalUncompressedBytes - data.byteLength) {
      archiveLimit("The ZIP archive exceeds the configured total expansion limit.");
    }
    totalUncompressed += data.byteLength;
    const requestedCompression = validateCompression(source.compression ?? defaultCompression);
    let compression: ZipCompression = requestedCompression;
    let compressed = Buffer.from(data);
    if (requestedCompression === "deflate") {
      const candidate = deflateRawSync(data);
      const ratio = data.byteLength / Math.max(1, candidate.byteLength);
      if (candidate.byteLength < data.byteLength && ratio <= limits.maxExpansionRatio) {
        compressed = candidate;
      } else {
        compression = "store";
      }
    }
    const timestamp = dosTimestamp(source.modifiedAt ?? defaultModifiedAt);
    const method = compression === "store" ? 0 : 8;
    const checksum = crc32(data);
    const header = Buffer.alloc(LOCAL_FILE_HEADER_LENGTH + name.bytes.byteLength);
    header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(UTF8_FLAG, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(timestamp.time, 10);
    header.writeUInt16LE(timestamp.date, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.byteLength, 18);
    header.writeUInt32LE(data.byteLength, 22);
    header.writeUInt16LE(name.bytes.byteLength, 26);
    header.writeUInt16LE(0, 28);
    name.bytes.copy(header, LOCAL_FILE_HEADER_LENGTH);
    prepared.push({
      name,
      compression,
      method,
      compressed,
      uncompressedSize: data.byteLength,
      checksum,
      dosTime: timestamp.time,
      dosDate: timestamp.date,
      localOffset
    });
    localParts.push(header, compressed);
    localOffset += header.byteLength + compressed.byteLength;
    if (localOffset >= ZIP64_UINT32) archiveLimit();
  }

  const centralOffset = localOffset;
  const centralParts = prepared.map((entry) => {
    const header = Buffer.alloc(CENTRAL_DIRECTORY_HEADER_LENGTH + entry.name.bytes.byteLength);
    header.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
    header.writeUInt16LE(0x0314, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(UTF8_FLAG, 8);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(entry.dosTime, 12);
    header.writeUInt16LE(entry.dosDate, 14);
    header.writeUInt32LE(entry.checksum, 16);
    header.writeUInt32LE(entry.compressed.byteLength, 20);
    header.writeUInt32LE(entry.uncompressedSize, 24);
    header.writeUInt16LE(entry.name.bytes.byteLength, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    header.writeUInt32LE(entry.localOffset, 42);
    entry.name.bytes.copy(header, CENTRAL_DIRECTORY_HEADER_LENGTH);
    return header;
  });
  const centralSize = centralParts.reduce((total, part) => total + part.byteLength, 0);
  if (centralSize >= ZIP64_UINT32 || centralOffset + centralSize >= ZIP64_UINT32) archiveLimit();
  const archiveSize = centralOffset + centralSize + END_OF_CENTRAL_DIRECTORY_LENGTH;
  if (archiveSize > limits.maxArchiveBytes) archiveLimit();
  const eocd = Buffer.alloc(END_OF_CENTRAL_DIRECTORY_LENGTH);
  eocd.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(prepared.length, 8);
  eocd.writeUInt16LE(prepared.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, eocd], archiveSize);
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Directory fsync is not supported uniformly on Windows and some filesystems.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function publishedBaseName(value: string): string {
  const sanitized = sanitizeBaseName(value, "routego-image-export");
  const withoutExtension = sanitized.replace(/\.zip$/iu, "").replace(/[. ]+$/gu, "");
  return withoutExtension === "" ? "routego-image-export" : withoutExtension;
}

export async function publishZipArchive(
  entries: readonly ZipSourceEntry[],
  options: PublishZipArchiveOptions
): Promise<PublishedZipArchive> {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.directory !== "string" ||
    options.directory.trim() === "" ||
    options.directory.includes("\0") ||
    typeof options.requestedBaseName !== "string"
  ) {
    invalidWriterInput("The ZIP publication destination is invalid.");
  }
  const maxNameAttempts = options.maxNameAttempts ?? 10_000;
  if (!Number.isSafeInteger(maxNameAttempts) || maxNameAttempts < 1 || maxNameAttempts > 100_000) {
    invalidWriterInput("The ZIP publication attempt limit is invalid.");
  }
  const bytes = encodeZipArchive(entries, options);
  await mkdir(options.directory, { recursive: true });
  const temporary = await createExclusiveFile({
    directory: options.directory,
    requestedBaseName: `.routego-zip-${randomUUID()}`,
    extension: ".tmp",
    maxAttempts: 8
  });
  let handleOpen = true;
  try {
    await temporary.handle.writeFile(bytes);
    await temporary.handle.sync();
    await temporary.handle.close();
    handleOpen = false;
    if (options.hooks?.afterTemporaryFileSynced) {
      await options.hooks.afterTemporaryFileSynced(temporary.path);
    }
    const baseName = publishedBaseName(options.requestedBaseName);
    let finalPath: string | undefined;
    for (let attempt = 1; attempt <= maxNameAttempts; attempt += 1) {
      const suffix = attempt === 1 ? "" : `-${attempt}`;
      const candidate = path.join(options.directory, `${baseName}${suffix}.zip`);
      if (options.hooks?.beforePublish) await options.hooks.beforePublish(temporary.path, candidate);
      try {
        await link(temporary.path, candidate);
        finalPath = candidate;
        break;
      } catch (error) {
        if (isNodeError(error, "EEXIST")) continue;
        throw error;
      }
    }
    if (finalPath === undefined) {
      throw new LibraryError("conflict", "No exclusive ZIP filename was available.");
    }
    await unlink(temporary.path).catch(() => undefined);
    await syncDirectoryBestEffort(options.directory);
    return {
      path: finalPath,
      fileName: path.basename(finalPath),
      byteLength: bytes.byteLength,
      entryCount: entries.length
    };
  } catch (error) {
    if (handleOpen) await temporary.handle.close().catch(() => undefined);
    await unlink(temporary.path).catch(() => undefined);
    if (error instanceof LibraryError) throw error;
    throw new LibraryError("file_write_failed", "The ZIP archive could not be published.", {
      cause: error
    });
  }
}
