import { describe, expect, it } from "vitest";

import { decodeZipArchive, encodeZipArchive } from "../../src/zip/codec";

const CENTRAL_SIGNATURE = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

interface EntryHeaders {
  readonly central: number;
  readonly local: number;
  readonly centralName: number;
  readonly localName: number;
  readonly nameLength: number;
  readonly dataStart: number;
}

function endOfCentralDirectory(archive: Buffer): number {
  const offset = archive.lastIndexOf(EOCD_SIGNATURE);
  if (offset < 0) throw new Error("Synthetic ZIP has no EOCD.");
  return offset;
}

function entryHeaders(archive: Buffer, selectedIndex = 0): EntryHeaders {
  const eocd = endOfCentralDirectory(archive);
  let central = archive.readUInt32LE(eocd + 16);
  for (let index = 0; index < selectedIndex; index += 1) {
    const nameLength = archive.readUInt16LE(central + 28);
    const extraLength = archive.readUInt16LE(central + 30);
    const commentLength = archive.readUInt16LE(central + 32);
    central += 46 + nameLength + extraLength + commentLength;
  }
  const local = archive.readUInt32LE(central + 42);
  const nameLength = archive.readUInt16LE(central + 28);
  const localNameLength = archive.readUInt16LE(local + 26);
  const localExtraLength = archive.readUInt16LE(local + 28);
  if (localNameLength !== nameLength) throw new Error("Synthetic ZIP name lengths disagree.");
  return {
    central,
    local,
    centralName: central + 46,
    localName: local + 30,
    nameLength,
    dataStart: local + 30 + localNameLength + localExtraLength
  };
}

function rewriteName(archive: Buffer, index: number, value: Buffer): Buffer {
  const output = Buffer.from(archive);
  const headers = entryHeaders(output, index);
  if (value.byteLength !== headers.nameLength) throw new Error("Replacement name length differs.");
  value.copy(output, headers.centralName);
  value.copy(output, headers.localName);
  return output;
}

describe("defensive ZIP structure validation", () => {
  it("accepts standards-compatible ASCII names without the UTF-8 flag", () => {
    const archive = encodeZipArchive([{ name: "ascii.txt", data: Buffer.from("portable") }]);
    const headers = entryHeaders(archive);
    archive.writeUInt16LE(archive.readUInt16LE(headers.central + 8) & ~0x0800, headers.central + 8);
    archive.writeUInt16LE(archive.readUInt16LE(headers.local + 6) & ~0x0800, headers.local + 6);
    expect(decodeZipArchive(archive).entries[0]?.name).toBe("ascii.txt");
  });

  it.each([
    ["traversal", "a_/x", Buffer.from("../x")],
    ["drive", "c_/x", Buffer.from("C:/x")],
    ["absolute", "a/b", Buffer.from("/ab")],
    ["UNC", "a/b", Buffer.from("//x")],
    ["backslash", "a/b", Buffer.from("a\\b")],
    ["NUL", "a/b", Buffer.from([0x61, 0x00, 0x62])]
  ])("rejects imported %s entry names", (_label, safeName, unsafeName) => {
    const archive = encodeZipArchive([{ name: safeName, data: Buffer.from("payload") }]);
    expect(() => decodeZipArchive(rewriteName(archive, 0, unsafeName))).toThrowError(
      expect.objectContaining({ code: "path_unsafe" })
    );
  });

  it("rejects invalid UTF-8 and duplicate canonical names", () => {
    const invalidUtf8 = rewriteName(
      encodeZipArchive([{ name: "abc", data: Buffer.from("payload") }]),
      0,
      Buffer.from([0xc3, 0x28, 0x78])
    );
    expect(() => decodeZipArchive(invalidUtf8)).toThrowError(
      expect.objectContaining({ code: "upload_invalid_type" })
    );

    const duplicates = rewriteName(
      encodeZipArchive([
        { name: "a.txt", data: Buffer.from("one") },
        { name: "b.txt", data: Buffer.from("two") }
      ]),
      1,
      Buffer.from("A.txt")
    );
    expect(() => decodeZipArchive(duplicates)).toThrowError(
      expect.objectContaining({ code: "upload_invalid_type" })
    );
  });

  it("rejects symbolic links, directories, encryption, unsupported methods, and flags", () => {
    const source = encodeZipArchive([{ name: "entry.bin", data: Buffer.from("payload") }]);
    const symlink = Buffer.from(source);
    const symlinkHeaders = entryHeaders(symlink);
    symlink.writeUInt32LE((0o120777 << 16) >>> 0, symlinkHeaders.central + 38);
    expect(() => decodeZipArchive(symlink)).toThrowError(
      expect.objectContaining({ code: "upload_invalid_type" })
    );

    const directory = Buffer.from(source);
    const directoryHeaders = entryHeaders(directory);
    directory.writeUInt32LE(
      (directory.readUInt32LE(directoryHeaders.central + 38) | 0x10) >>> 0,
      directoryHeaders.central + 38
    );
    expect(() => decodeZipArchive(directory)).toThrowError(
      expect.objectContaining({ code: "upload_invalid_type" })
    );

    const encrypted = Buffer.from(source);
    const encryptedHeaders = entryHeaders(encrypted);
    encrypted.writeUInt16LE(
      encrypted.readUInt16LE(encryptedHeaders.central + 8) | 1,
      encryptedHeaders.central + 8
    );
    encrypted.writeUInt16LE(
      encrypted.readUInt16LE(encryptedHeaders.local + 6) | 1,
      encryptedHeaders.local + 6
    );
    expect(() => decodeZipArchive(encrypted)).toThrowError(
      expect.objectContaining({ code: "upload_invalid_type" })
    );

    const method = Buffer.from(source);
    const methodHeaders = entryHeaders(method);
    method.writeUInt16LE(99, methodHeaders.central + 10);
    method.writeUInt16LE(99, methodHeaders.local + 8);
    expect(() => decodeZipArchive(method)).toThrowError(
      expect.objectContaining({ code: "upload_invalid_type" })
    );

    const descriptor = Buffer.from(source);
    const descriptorHeaders = entryHeaders(descriptor);
    descriptor.writeUInt16LE(
      descriptor.readUInt16LE(descriptorHeaders.central + 8) | 0x0008,
      descriptorHeaders.central + 8
    );
    descriptor.writeUInt16LE(
      descriptor.readUInt16LE(descriptorHeaders.local + 6) | 0x0008,
      descriptorHeaders.local + 6
    );
    expect(() => decodeZipArchive(descriptor)).toThrowError(
      expect.objectContaining({ code: "upload_invalid_type" })
    );
  });

  it("rejects multi-disk, ZIP64, corrupt central, and corrupt local records", () => {
    const source = encodeZipArchive([{ name: "entry.bin", data: Buffer.from("payload") }]);
    const multiDisk = Buffer.from(source);
    multiDisk.writeUInt16LE(1, endOfCentralDirectory(multiDisk) + 4);
    expect(() => decodeZipArchive(multiDisk)).toThrowError(
      expect.objectContaining({ code: "upload_invalid_type" })
    );

    const zip64 = Buffer.from(source);
    zip64.writeUInt16LE(0xffff, endOfCentralDirectory(zip64) + 10);
    expect(() => decodeZipArchive(zip64)).toThrowError(
      expect.objectContaining({ code: "upload_invalid_type" })
    );

    const badCentral = Buffer.from(source);
    CENTRAL_SIGNATURE.copy(badCentral, entryHeaders(badCentral).central);
    badCentral[entryHeaders(badCentral).central] ^= 0xff;
    expect(() => decodeZipArchive(badCentral)).toThrowError(
      expect.objectContaining({ code: "upload_invalid_type" })
    );

    const badLocal = Buffer.from(source);
    badLocal[entryHeaders(badLocal).local] ^= 0xff;
    expect(() => decodeZipArchive(badLocal)).toThrowError(
      expect.objectContaining({ code: "upload_invalid_type" })
    );
  });

  it("rejects local/central disagreement, overlapping offsets, and CRC corruption", () => {
    const source = encodeZipArchive(
      [{ name: "entry.bin", data: Buffer.from("payload"), compression: "store" }],
      { defaultCompression: "store" }
    );
    const disagreement = Buffer.from(source);
    const disagreementHeaders = entryHeaders(disagreement);
    disagreement.writeUInt32LE(
      (disagreement.readUInt32LE(disagreementHeaders.local + 14) ^ 1) >>> 0,
      disagreementHeaders.local + 14
    );
    expect(() => decodeZipArchive(disagreement)).toThrowError(
      expect.objectContaining({ code: "upload_invalid_type" })
    );

    const overlapping = encodeZipArchive([
      { name: "a.bin", data: Buffer.from("one") },
      { name: "b.bin", data: Buffer.from("two") }
    ]);
    const first = entryHeaders(overlapping, 0);
    const second = entryHeaders(overlapping, 1);
    overlapping.writeUInt32LE(first.local, second.central + 42);
    expect(() => decodeZipArchive(overlapping)).toThrowError(
      expect.objectContaining({ code: "upload_invalid_type" })
    );

    const badCrc = Buffer.from(source);
    badCrc[entryHeaders(badCrc).dataStart] ^= 0xff;
    expect(() => decodeZipArchive(badCrc)).toThrowError(
      expect.objectContaining({ code: "upload_checksum_failed" })
    );
  });
});
