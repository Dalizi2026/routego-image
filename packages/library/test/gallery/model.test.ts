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

  it("rejects a mark that does not resolve to an active generation record", () => {
    expect(() =>
      parseImageLibraryIndex({
        schemaVersion: IMAGE_LIBRARY_SCHEMA_VERSION,
        revision: 1,
        blobs: [],
        assets: [],
        folders: [],
        currentMarkRecordId: "asset-missing"
      })
    ).toThrowError("The current mark must reference an active generation record.");
  });
});
