import { describe, expect, it } from "vitest";

import {
  copiedGenerationInformation,
  createCopyGenerationInfoRequest,
  createMarkImageRequest,
  nextCurrentMarkRecordId,
  studioLibraryActionSchemaVersion
} from "../src/features/library";

describe("Studio Library browser-safe action requests", () => {
  it("uses only a stable record ID for generation-information copying", () => {
    expect(createCopyGenerationInfoRequest("record-output-01")).toEqual({
      schemaVersion: studioLibraryActionSchemaVersion,
      recordId: "record-output-01"
    });
    expect(JSON.stringify(createCopyGenerationInfoRequest("record-output-01"))).not.toMatch(
      /(?:path|file:\/\/|[A-Za-z]:\\|\/Users\/|data:image|base64|Authorization)/u
    );
  });

  it("uses the same identifier-only request for replaceable and cancellable marks", () => {
    expect(createMarkImageRequest("record-output-01")).toEqual({
      schemaVersion: 1,
      recordId: "record-output-01"
    });
    expect(() => createMarkImageRequest("  ")).toThrow(/有效的图库记录/u);
  });

  it("accepts only zero-provider browser-safe results and preserves failure as an error", () => {
    expect(
      copiedGenerationInformation({
        status: "succeeded",
        clipboardText: "prompt: synthetic",
        providerRequestCount: 0
      })
    ).toBe("prompt: synthetic");
    expect(() =>
      copiedGenerationInformation({
        status: "failed",
        providerRequestCount: 0,
        error: { safeMessage: "Copy unavailable." }
      })
    ).toThrow("Copy unavailable.");
    expect(() =>
      nextCurrentMarkRecordId({
        status: "succeeded",
        currentMarkRecordId: "record-output-02",
        markCleared: false,
        providerRequestCount: 1
      })
    ).toThrow(/无法更新图片标记/u);
  });

  it("uses the server result for both replacement and cancellation", () => {
    expect(
      nextCurrentMarkRecordId({
        status: "succeeded",
        currentMarkRecordId: "record-output-02",
        markCleared: false,
        providerRequestCount: 0
      })
    ).toBe("record-output-02");
    expect(
      nextCurrentMarkRecordId({
        status: "succeeded",
        markCleared: true,
        providerRequestCount: 0
      })
    ).toBeUndefined();
  });
});
