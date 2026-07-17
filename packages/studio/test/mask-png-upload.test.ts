import type { UploadResourceDescriptor } from "@routego-image/contracts";
import { describe, expect, it } from "vitest";

import { createEmptyMaskBitmap } from "../src/features/mask/bitmap";
import { encodeMaskPng, type MaskCanvas } from "../src/features/mask/png";
import { bindFinalizedMaskUpload } from "../src/features/mask/upload";

describe("mask PNG and target binding", () => {
  it("encodes alpha as a PNG blob without adding source-image bytes", async () => {
    const mask = createEmptyMaskBitmap(2, 1);
    mask.alpha[0] = 255;
    let written: Uint8ClampedArray | undefined;
    const canvas: MaskCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        createImageData: (width, height) => ({
          data: new Uint8ClampedArray(width * height * 4),
          width,
          height,
          colorSpace: "srgb"
        }) as ImageData,
        putImageData: (imageData) => {
          written = imageData.data.slice();
        }
      }),
      toBlob: (callback, type) => callback(new Blob(["synthetic-png"], { type: type ?? "" }))
    };
    const blob = await encodeMaskPng(mask, () => canvas);
    expect(blob.type).toBe("image/png");
    expect(written).toEqual(
      new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 0])
    );
  });

  it("accepts only a finalized PNG mask with matching dimensions and target slot zero", () => {
    const resource: UploadResourceDescriptor = {
      uploadResourceId: "upload-mask-01",
      purpose: "mask",
      status: "finalized",
      reusePolicy: "reusable-until-expiry",
      binaryUpload: {
        method: "PUT",
        relativeUrl: "/api/v1/uploads/upload-mask-01/content",
        requiresSession: true,
        requiresOrigin: true,
        allowedMimeTypes: ["image/png"],
        maxBytes: 1_024,
        expiresAt: "2026-07-18T12:10:00.000Z"
      },
      declaredMimeType: "image/png",
      declaredByteLength: 13,
      finalized: {
        detectedMimeType: "image/png",
        byteLength: 13,
        sha256: "a".repeat(64),
        width: 64,
        height: 32,
        finalizedAt: "2026-07-18T12:05:00.000Z"
      },
      createdAt: "2026-07-18T12:00:00.000Z"
    };
    expect(bindFinalizedMaskUpload(resource, { width: 64, height: 32 })).toEqual({
      image: { source: "upload", uploadResourceId: "upload-mask-01" },
      targetSlot: 0
    });
    expect(() => bindFinalizedMaskUpload(resource, { width: 32, height: 64 })).toThrow();
  });
});
