import {
  studioMaskInputSchema,
  uploadResourceDescriptorSchema,
  type UploadResourceDescriptor
} from "@routego-image/contracts";

export interface MaskUploadLocator {
  readonly image: {
    readonly source: "upload";
    readonly uploadResourceId: string;
  };
  readonly targetSlot: 0;
}

export interface MaskPngUploadRequest {
  readonly blob: Blob;
  readonly purpose: "mask";
  readonly width: number;
  readonly height: number;
  readonly targetSlot: 0;
}

export function bindFinalizedMaskUpload(
  resource: UploadResourceDescriptor,
  dimensions: { readonly width: number; readonly height: number }
): MaskUploadLocator {
  const parsed = uploadResourceDescriptorSchema.parse(resource);
  if (
    parsed.purpose !== "mask" ||
    parsed.status !== "finalized" ||
    parsed.declaredMimeType !== "image/png" ||
    parsed.finalized?.detectedMimeType !== "image/png" ||
    parsed.finalized.width !== dimensions.width ||
    parsed.finalized.height !== dimensions.height
  ) {
    throw new Error("The mask upload did not finalize with the target dimensions.");
  }
  return studioMaskInputSchema.parse({
    image: { source: "upload", uploadResourceId: parsed.uploadResourceId },
    targetSlot: 0
  }) as MaskUploadLocator;
}
