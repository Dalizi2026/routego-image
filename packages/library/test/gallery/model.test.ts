import { describe, expect, it } from "vitest";

import {
  IMAGE_LIBRARY_SCHEMA_VERSION,
  createEmptyImageLibraryIndex,
  parseImageLibraryIndex
} from "../../src/gallery/model";

describe("Image Library index v2", () => {
  it("creates an empty v2 index without a current generation mark", () => {
    expect(createEmptyImageLibraryIndex()).toEqual({
      schemaVersion: IMAGE_LIBRARY_SCHEMA_VERSION,
      revision: 0,
      blobs: [],
      assets: [],
      folders: []
    });
  });

  it("rejects legacy index versions instead of silently migrating them", () => {
    expect(() =>
      parseImageLibraryIndex({ schemaVersion: 1, revision: 0, blobs: [], assets: [], folders: [] })
    ).toThrowError("Image Library index uses an unsupported version.");
  });

  it("accepts an old index with a mark and drops it from the in-memory model", () => {
    expect(
      parseImageLibraryIndex({
        schemaVersion: IMAGE_LIBRARY_SCHEMA_VERSION,
        revision: 1,
        blobs: [],
        assets: [],
        folders: [],
        currentMarkRecordId: "asset-missing"
      })
    ).not.toHaveProperty("currentMarkRecordId");
  });
});
