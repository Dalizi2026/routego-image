import { describe, expect, it } from "vitest";

import { decodeZipArchive, encodeZipArchive } from "../../src/zip/codec";

const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

function eocdOffset(archive: Buffer): number {
  const offset = archive.lastIndexOf(EOCD_SIGNATURE);
  if (offset < 0) throw new Error("Synthetic ZIP has no EOCD.");
  return offset;
}

function firstLocalOffset(archive: Buffer): number {
  return archive.readUInt32LE(archive.readUInt32LE(eocdOffset(archive) + 16) + 42);
}

describe("ZIP safety limits", () => {
  it("enforces archive bytes, entry count, name length, entry size, and total size", () => {
    const one = encodeZipArchive([{ name: "entry.bin", data: Buffer.alloc(4) }]);
    expect(() =>
      decodeZipArchive(one, { limits: { maxArchiveBytes: one.byteLength - 1 } })
    ).toThrowError(expect.objectContaining({ code: "upload_oversize" }));
    expect(() =>
      decodeZipArchive(one, { limits: { maxNameBytes: 4 } })
    ).toThrowError(expect.objectContaining({ code: "upload_oversize" }));
    expect(() =>
      decodeZipArchive(one, {
        limits: { maxEntryUncompressedBytes: 3, maxTotalUncompressedBytes: 3 }
      })
    ).toThrowError(expect.objectContaining({ code: "upload_oversize" }));

    const two = encodeZipArchive([
      { name: "one.bin", data: Buffer.alloc(3) },
      { name: "two.bin", data: Buffer.alloc(3) }
    ]);
    expect(() =>
      decodeZipArchive(two, { limits: { maxEntries: 1 } })
    ).toThrowError(expect.objectContaining({ code: "upload_oversize" }));
    expect(() =>
      decodeZipArchive(two, {
        limits: { maxEntryUncompressedBytes: 3, maxTotalUncompressedBytes: 5 }
      })
    ).toThrowError(expect.objectContaining({ code: "upload_oversize" }));
  });

  it("rejects declared expansion ratios before reading corrupt local data", () => {
    const data = Buffer.from(
      Array.from({ length: 100 }, (_, index) => `portable-${index % 9}-metadata\n`).join(""),
      "utf8"
    );
    const archive = encodeZipArchive([{ name: "compressed.txt", data, compression: "deflate" }]);
    expect(decodeZipArchive(archive).entries[0]?.compression).toBe("deflate");
    const corruptLocal = Buffer.from(archive);
    corruptLocal[firstLocalOffset(corruptLocal)] ^= 0xff;
    expect(() =>
      decodeZipArchive(corruptLocal, { limits: { maxExpansionRatio: 2 } })
    ).toThrowError(expect.objectContaining({ code: "upload_oversize" }));
  });

  it("rejects deflate output whose observed length disagrees with both headers", () => {
    const data = Buffer.from("Routego image archive metadata ".repeat(20), "utf8");
    const archive = encodeZipArchive([{ name: "entry.txt", data, compression: "deflate" }]);
    const output = Buffer.from(archive);
    const central = output.readUInt32LE(eocdOffset(output) + 16);
    const local = output.readUInt32LE(central + 42);
    output.writeUInt32LE(data.byteLength - 1, central + 24);
    output.writeUInt32LE(data.byteLength - 1, local + 22);
    expect(() => decodeZipArchive(output)).toThrowError(
      expect.objectContaining({ code: "upload_invalid_type" })
    );
  });
});
