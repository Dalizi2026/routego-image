import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { Crc32, crc32 } from "../../src/zip/crc32";
import {
  decodeZipArchive,
  encodeZipArchive,
  publishZipArchive
} from "../../src/zip/codec";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CRC-32", () => {
  it("matches the standard vector and supports incremental updates", () => {
    const bytes = Buffer.from("123456789", "ascii");
    expect(crc32(bytes)).toBe(0xcbf4_3926);
    expect(
      new Crc32().update(bytes.subarray(0, 4)).update(bytes.subarray(4)).digest()
    ).toBe(0xcbf4_3926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe("bounded ZIP encoding and publication", () => {
  it("round-trips stored and deflated UTF-8 regular files", () => {
    const manifest = Buffer.from('{"schemaVersion":1,"title":"图库 🙂"}', "utf8");
    const repeated = Buffer.from(
      Array.from(
        { length: 80 },
        (_, index) => `Routego portable line ${index % 17}: 中文 image metadata.\n`
      ).join(""),
      "utf8"
    );
    const archive = encodeZipArchive([
      { name: "manifest.json", data: manifest, compression: "store" },
      { name: "图片/🙂 sample.txt", data: repeated, compression: "deflate" }
    ]);
    expect(archive.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const decoded = decodeZipArchive(archive);
    expect(decoded.byteLength).toBe(archive.byteLength);
    expect(decoded.entries.map((entry) => [entry.name, entry.compression])).toEqual([
      ["manifest.json", "store"],
      ["图片/🙂 sample.txt", "deflate"]
    ]);
    expect(decoded.entries[0]?.data).toEqual(manifest);
    expect(decoded.entries[1]?.data).toEqual(repeated);
    expect(decodeZipArchive(encodeZipArchive([])).entries).toEqual([]);
  });

  it.each([
    "../escape.txt",
    "/absolute.txt",
    "C:/drive.txt",
    "//server/share.txt",
    "folder\\backslash.txt",
    "folder/./dot.txt",
    "folder//empty.txt",
    "folder/trailing. ",
    "Ｃ：/compat-drive.txt",
    "folder／..／compat-escape.txt",
    "NUL.txt",
    "bad\0name.txt"
  ])("rejects unsafe output entry name %j", (name) => {
    expect(() => encodeZipArchive([{ name, data: Buffer.from("unsafe") }])).toThrowError(
      expect.objectContaining({ code: "path_unsafe" })
    );
  });

  it("rejects writer-side entry and total limits before publication", () => {
    expect(() =>
      encodeZipArchive([{ name: "large.bin", data: Buffer.alloc(4) }], {
        limits: { maxEntryUncompressedBytes: 3, maxTotalUncompressedBytes: 3 }
      })
    ).toThrowError(expect.objectContaining({ code: "upload_oversize" }));
    expect(() =>
      encodeZipArchive(
        [
          { name: "one.bin", data: Buffer.alloc(3) },
          { name: "two.bin", data: Buffer.alloc(3) }
        ],
        { limits: { maxEntryUncompressedBytes: 3, maxTotalUncompressedBytes: 5 } }
      )
    ).toThrowError(expect.objectContaining({ code: "upload_oversize" }));
  });

  it("publishes complete archives with exclusive versioned names and no overwrite", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "routego-zip-publish-"));
    roots.push(root);
    const originalPath = path.join(root, "gallery.zip");
    await writeFile(originalPath, Buffer.from("preserve-existing", "utf8"));
    const entries = [{ name: "manifest.json", data: Buffer.from("{}", "utf8") }];
    const first = await publishZipArchive(entries, {
      directory: root,
      requestedBaseName: "gallery.zip"
    });
    const second = await publishZipArchive(entries, {
      directory: root,
      requestedBaseName: "gallery"
    });
    expect(first.fileName).toBe("gallery-2.zip");
    expect(second.fileName).toBe("gallery-3.zip");
    expect(await readFile(originalPath, "utf8")).toBe("preserve-existing");
    expect(decodeZipArchive(await readFile(first.path)).entries[0]?.data.toString("utf8")).toBe(
      "{}"
    );
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("removes its temporary file when publication is interrupted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "routego-zip-interrupt-"));
    roots.push(root);
    await expect(
      publishZipArchive([{ name: "manifest.json", data: Buffer.from("{}") }], {
        directory: root,
        requestedBaseName: "interrupted",
        hooks: {
          afterTemporaryFileSynced: async () => {
            throw new Error("synthetic interruption");
          }
        }
      })
    ).rejects.toMatchObject({ code: "file_write_failed" });
    expect(await readdir(root)).toEqual([]);
  });
});
