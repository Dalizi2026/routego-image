import { describe, expect, it } from "vitest";

import {
  discardUploadResourceResultSchema,
  finalizeUploadResourceResultSchema,
  getUploadResourceStatusResultSchema,
  parseStudioOperationInput,
  parseStudioOperationOutput,
  reserveUploadResourceInputSchema,
  reserveUploadResourceResultSchema,
  routegoErrorCodeSchema,
  routegoOperationDefinitions,
  routegoOperationNames,
  studioOperationDefinitions,
  uploadServiceErrorCodeSchema,
  uploadResourceDescriptorSchema,
  type UploadResourceDescriptor
} from "../src/index";
import { TEST_TIMESTAMP } from "./fixtures";

const EXPIRES_AT = "2026-07-17T12:39:56.000Z";
const FINALIZED_AT = "2026-07-17T12:35:56.000Z";

function imageResource(
  overrides: Partial<UploadResourceDescriptor> = {}
): UploadResourceDescriptor {
  return {
    uploadResourceId: "upload-image-a",
    purpose: "reference",
    status: "reserved",
    reusePolicy: "reusable-until-expiry",
    binaryUpload: {
      method: "PUT",
      relativeUrl: "/api/v1/uploads/upload-image-a/content",
      requiresSession: true,
      requiresOrigin: true,
      allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
      maxBytes: 52_428_800,
      expiresAt: EXPIRES_AT
    },
    declaredMimeType: "image/png",
    declaredByteLength: 68,
    createdAt: TEST_TIMESTAMP,
    ...overrides
  };
}

function uploadError(code: "upload_expired" | "upload_invalid_type" | "upload_oversize" | "upload_checksum_failed" | "upload_consumed" | "upload_discarded" | "not_found") {
  return {
    code,
    category: code === "not_found" ? "persistence" as const : "validation" as const,
    stage: "validate" as const,
    safeMessage: `Synthetic ${code} upload error.`,
    retryDisposition: "user-confirmation" as const,
    partialArtifacts: [],
    receivedAnyOutput: false,
    mayHaveBilled: false
  };
}

describe("session upload reservation contracts", () => {
  it.each([
    ["image", "image/webp"],
    ["reference", "image/png"],
    ["target", "image/jpeg"],
    ["supporting", "image/webp"],
    ["mask", "image/png"],
    ["zip-import", "application/zip"]
  ] as const)("accepts purpose %s with its allowed MIME", (purpose, declaredMimeType) => {
    expect(
      reserveUploadResourceInputSchema.parse({
        purpose,
        declaredMimeType,
        declaredByteLength: 68,
        expectedSha256: "a".repeat(64)
      })
    ).toMatchObject({ schemaVersion: 1, purpose, declaredMimeType });
  });

  it("rejects purpose/MIME mismatches, unsafe fields, and invalid declared sizes", () => {
    for (const input of [
      { purpose: "mask", declaredMimeType: "image/jpeg", declaredByteLength: 68 },
      { purpose: "zip-import", declaredMimeType: "image/png", declaredByteLength: 68 },
      {
        purpose: "reference",
        declaredMimeType: "image/png",
        declaredByteLength: 68,
        path: "C:\\Users\\person\\image.png"
      },
      {
        purpose: "reference",
        declaredMimeType: "image/png",
        declaredByteLength: 68,
        dataUrl: "data:image/png;base64,c3ludGhldGlj"
      },
      { purpose: "reference", declaredMimeType: "image/png", declaredByteLength: 0 }
    ]) {
      expect(reserveUploadResourceInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it("returns protected relative reservation metadata with explicit reuse policy", () => {
    const image = reserveUploadResourceResultSchema.parse({
      schemaVersion: 1,
      status: "succeeded",
      resource: imageResource()
    });
    expect(image.resource).toMatchObject({
      reusePolicy: "reusable-until-expiry",
      binaryUpload: { requiresSession: true, requiresOrigin: true, method: "PUT" }
    });

    const zip = reserveUploadResourceResultSchema.parse({
      schemaVersion: 1,
      status: "succeeded",
      resource: {
        ...imageResource({
          uploadResourceId: "upload-zip-a",
          purpose: "zip-import",
          reusePolicy: "single-consume",
          declaredMimeType: "application/zip",
          binaryUpload: {
            method: "PUT",
            relativeUrl: "/api/v1/uploads/upload-zip-a/content",
            requiresSession: true,
            requiresOrigin: true,
            allowedMimeTypes: ["application/zip"],
            maxBytes: 536_870_912,
            expiresAt: EXPIRES_AT
          }
        })
      }
    });
    expect(zip.resource?.reusePolicy).toBe("single-consume");
    expect(JSON.stringify({ image, zip })).not.toMatch(/(?:data:image|base64|C:\\|Authorization)/u);
  });
});

describe("upload lifecycle metadata and structured failures", () => {
  it("keeps upload-specific errors outside the frozen public error enum", () => {
    expect(routegoErrorCodeSchema.safeParse("upload_expired").success).toBe(false);
    expect(uploadServiceErrorCodeSchema.parse("upload_expired")).toBe("upload_expired");
    expect(uploadServiceErrorCodeSchema.parse("not_found")).toBe("not_found");
  });

  it("requires finalized integrity metadata and supports reusable images", () => {
    const finalized = uploadResourceDescriptorSchema.parse(
      imageResource({
        status: "finalized",
        finalized: {
          detectedMimeType: "image/png",
          byteLength: 68,
          sha256: "b".repeat(64),
          width: 1,
          height: 1,
          finalizedAt: FINALIZED_AT
        }
      })
    );
    expect(finalized).toMatchObject({
      status: "finalized",
      reusePolicy: "reusable-until-expiry",
      finalized: { detectedMimeType: "image/png", byteLength: 68, width: 1, height: 1 }
    });
    expect(
      uploadResourceDescriptorSchema.safeParse(imageResource({ status: "finalized" })).success
    ).toBe(false);
  });

  it("allows only finalized ZIP uploads to become consumed", () => {
    const consumed = uploadResourceDescriptorSchema.parse({
      ...imageResource({
        uploadResourceId: "upload-zip-a",
        purpose: "zip-import",
        status: "consumed",
        reusePolicy: "single-consume",
        declaredMimeType: "application/zip",
        binaryUpload: {
          method: "PUT",
          relativeUrl: "/api/v1/uploads/upload-zip-a/content",
          requiresSession: true,
          requiresOrigin: true,
          allowedMimeTypes: ["application/zip"],
          maxBytes: 536_870_912,
          expiresAt: EXPIRES_AT
        },
        finalized: {
          detectedMimeType: "application/zip",
          byteLength: 256,
          sha256: "c".repeat(64),
          finalizedAt: FINALIZED_AT
        },
        consumedAt: FINALIZED_AT
      })
    });
    expect(consumed.status).toBe("consumed");
    expect(
      uploadResourceDescriptorSchema.safeParse(
        imageResource({
          status: "consumed",
          finalized: {
            detectedMimeType: "image/png",
            byteLength: 68,
            sha256: "d".repeat(64),
            finalizedAt: FINALIZED_AT
          },
          consumedAt: FINALIZED_AT
        })
      ).success
    ).toBe(false);
  });

  it.each([
    "upload_expired",
    "not_found",
    "upload_invalid_type",
    "upload_oversize",
    "upload_checksum_failed",
    "upload_consumed",
    "upload_discarded"
  ] as const)("accepts structured %s failure without a resource", (code) => {
    const result = finalizeUploadResourceResultSchema.parse({
      schemaVersion: 1,
      status: "failed",
      error: uploadError(code)
    });
    expect(result).toMatchObject({ status: "failed", error: { code } });
  });

  it("rejects arbitrary upload error details and partial image artifacts", () => {
    expect(
      finalizeUploadResourceResultSchema.safeParse({
        schemaVersion: 1,
        status: "failed",
        error: {
          ...uploadError("upload_invalid_type"),
          details: { dataUrl: "data:image/png;base64,c3ludGhldGlj" }
        }
      }).success
    ).toBe(false);
  });

  it("validates status and discard outputs through the shared operation result", () => {
    expect(
      getUploadResourceStatusResultSchema.parse({
        schemaVersion: 1,
        status: "succeeded",
        resource: imageResource({ status: "expired" })
      }).resource?.status
    ).toBe("expired");
    expect(
      discardUploadResourceResultSchema.parse({
        schemaVersion: 1,
        status: "succeeded",
        resource: imageResource({ status: "discarded", discardedAt: FINALIZED_AT })
      }).resource?.status
    ).toBe("discarded");
  });
});

describe("Studio upload operation registry", () => {
  it("registers upload control operations internally without changing public MCP operations", () => {
    expect(routegoOperationNames).toEqual([
      "status",
      "generate",
      "prepareRegeneration",
      "batch",
      "searchLibrary",
      "manageLibrary",
      "openStudio"
    ]);
    expect(Object.values(routegoOperationDefinitions).map((item) => item.toolName)).toEqual([
      "routego_status",
      "routego_generate",
      "routego_prepare_regeneration",
      "routego_batch",
      "routego_search_library",
      "routego_manage_library",
      "routego_open_studio"
    ]);
    for (const operation of [
      "reserveUploadResource",
      "finalizeUploadResource",
      "getUploadResourceStatus",
      "discardUploadResource"
    ] as const) {
      expect(studioOperationDefinitions[operation].http.path).toMatch(/^\/api\/v1\/uploads\//u);
      expect("toolName" in studioOperationDefinitions[operation]).toBe(false);
    }
  });

  it("dispatches upload metadata through exact Studio schemas", () => {
    expect(
      parseStudioOperationInput("reserveUploadResource", {
        purpose: "reference",
        declaredMimeType: "image/png",
        declaredByteLength: 68
      })
    ).toMatchObject({ schemaVersion: 1, purpose: "reference" });
    expect(
      parseStudioOperationOutput("reserveUploadResource", {
        schemaVersion: 1,
        status: "succeeded",
        resource: imageResource()
      })
    ).toMatchObject({ status: "succeeded", resource: { uploadResourceId: "upload-image-a" } });
  });
});
