import { describe, expect, it } from "vitest";

import {
  copiedGenerationInformation,
  createCopyGenerationInfoRequest,
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
      copiedGenerationInformation({
        status: "succeeded",
        clipboardText: "prompt: synthetic",
        providerRequestCount: 1
      })
    ).toThrow(/无法复制生成信息/u);
  });
});
