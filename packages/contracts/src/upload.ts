import { z } from "zod";

import { identifierSchema, routegoSchemaVersionSchema, timestampSchema } from "./common";
import { routegoServiceErrorSchema } from "./errors";

export const uploadServiceErrorSchema = routegoServiceErrorSchema.superRefine(
  (value, context) => {
    if (value.partialArtifacts.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["partialArtifacts"],
        message: "Upload errors cannot include image artifacts"
      });
    }
    if (value.details !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["details"],
        message: "Upload errors cannot include arbitrary diagnostic details"
      });
    }
  }
);

export const uploadResourcePurposeSchema = z.enum([
  "image",
  "reference",
  "target",
  "supporting",
  "mask",
  "zip-import"
]);

export const uploadMimeTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/zip"
]);

export const uploadResourceStatusSchema = z.enum([
  "reserved",
  "uploaded",
  "finalized",
  "consumed",
  "discarded",
  "expired",
  "failed"
]);

export const uploadReusePolicySchema = z.enum(["reusable-until-expiry", "single-consume"]);

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

function allowedMimeTypesForPurpose(
  purpose: z.infer<typeof uploadResourcePurposeSchema>
): z.infer<typeof uploadMimeTypeSchema>[] {
  if (purpose === "zip-import") {
    return ["application/zip"];
  }
  if (purpose === "mask") {
    return ["image/png"];
  }
  return ["image/png", "image/jpeg", "image/webp"];
}

function reusePolicyForPurpose(
  purpose: z.infer<typeof uploadResourcePurposeSchema>
): z.infer<typeof uploadReusePolicySchema> {
  return purpose === "zip-import" ? "single-consume" : "reusable-until-expiry";
}

export const relativeUploadUrlSchema = z
  .string()
  .min(1)
  .max(2_048)
  .regex(
    /^\/api\/v1\/uploads\/[A-Za-z0-9][A-Za-z0-9._:-]*\/content$/u,
    "Uploads require a protected relative binary route"
  );

export const uploadBinaryRouteDescriptorSchema = z
  .object({
    method: z.literal("PUT"),
    relativeUrl: relativeUploadUrlSchema,
    requiresSession: z.literal(true),
    requiresOrigin: z.literal(true),
    allowedMimeTypes: z.array(uploadMimeTypeSchema).min(1).max(4),
    maxBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    expiresAt: timestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.allowedMimeTypes).size !== value.allowedMimeTypes.length) {
      context.addIssue({
        code: "custom",
        path: ["allowedMimeTypes"],
        message: "Allowed upload MIME types must be unique"
      });
    }
  });

export const reserveUploadResourceInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    purpose: uploadResourcePurposeSchema,
    declaredMimeType: uploadMimeTypeSchema,
    declaredByteLength: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    expectedSha256: sha256Schema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (!allowedMimeTypesForPurpose(value.purpose).includes(value.declaredMimeType)) {
      context.addIssue({
        code: "custom",
        path: ["declaredMimeType"],
        message: `Declared MIME type is not allowed for ${value.purpose}`
      });
    }
  });

export const finalizedUploadMetadataSchema = z
  .object({
    detectedMimeType: uploadMimeTypeSchema,
    byteLength: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    sha256: sha256Schema,
    width: z.number().int().min(1).max(65_535).optional(),
    height: z.number().int().min(1).max(65_535).optional(),
    finalizedAt: timestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    const isImage = value.detectedMimeType.startsWith("image/");
    if (isImage && ((value.width === undefined) !== (value.height === undefined))) {
      context.addIssue({
        code: "custom",
        path: ["width"],
        message: "Image upload dimensions must include both width and height when present"
      });
    }
    if (!isImage && (value.width !== undefined || value.height !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["width"],
        message: "ZIP uploads cannot include image dimensions"
      });
    }
  });

export const uploadResourceDescriptorSchema = z
  .object({
    uploadResourceId: identifierSchema,
    purpose: uploadResourcePurposeSchema,
    status: uploadResourceStatusSchema,
    reusePolicy: uploadReusePolicySchema,
    binaryUpload: uploadBinaryRouteDescriptorSchema,
    declaredMimeType: uploadMimeTypeSchema,
    declaredByteLength: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    expectedSha256: sha256Schema.optional(),
    finalized: finalizedUploadMetadataSchema.optional(),
    createdAt: timestampSchema,
    consumedAt: timestampSchema.optional(),
    discardedAt: timestampSchema.optional(),
    error: uploadServiceErrorSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    const allowedMimeTypes = allowedMimeTypesForPurpose(value.purpose);
    const expectedReusePolicy = reusePolicyForPurpose(value.purpose);

    if (value.reusePolicy !== expectedReusePolicy) {
      context.addIssue({
        code: "custom",
        path: ["reusePolicy"],
        message: `${value.purpose} requires ${expectedReusePolicy}`
      });
    }
    if (!allowedMimeTypes.includes(value.declaredMimeType)) {
      context.addIssue({
        code: "custom",
        path: ["declaredMimeType"],
        message: `Declared MIME type is not allowed for ${value.purpose}`
      });
    }
    if (
      value.binaryUpload.allowedMimeTypes.length !== allowedMimeTypes.length ||
      !allowedMimeTypes.every((mimeType) => value.binaryUpload.allowedMimeTypes.includes(mimeType))
    ) {
      context.addIssue({
        code: "custom",
        path: ["binaryUpload", "allowedMimeTypes"],
        message: "Binary upload MIME policy must match its purpose"
      });
    }
    if (
      value.binaryUpload.relativeUrl !==
      `/api/v1/uploads/${value.uploadResourceId}/content`
    ) {
      context.addIssue({
        code: "custom",
        path: ["binaryUpload", "relativeUrl"],
        message: "Binary upload route must match uploadResourceId"
      });
    }
    if (Date.parse(value.createdAt) >= Date.parse(value.binaryUpload.expiresAt)) {
      context.addIssue({
        code: "custom",
        path: ["binaryUpload", "expiresAt"],
        message: "Upload expiry must be later than creation"
      });
    }
    if (value.declaredByteLength > value.binaryUpload.maxBytes) {
      context.addIssue({
        code: "custom",
        path: ["declaredByteLength"],
        message: "Declared byte length exceeds the reserved upload maximum"
      });
    }
    if (
      value.finalized !== undefined &&
      !allowedMimeTypes.includes(value.finalized.detectedMimeType)
    ) {
      context.addIssue({
        code: "custom",
        path: ["finalized", "detectedMimeType"],
        message: "Detected MIME type is not allowed for the upload purpose"
      });
    }
    if (value.finalized !== undefined && value.finalized.byteLength > value.binaryUpload.maxBytes) {
      context.addIssue({
        code: "custom",
        path: ["finalized", "byteLength"],
        message: "Finalized byte length exceeds the reserved upload maximum"
      });
    }
    if (
      value.finalized !== undefined &&
      value.expectedSha256 !== undefined &&
      value.finalized.sha256 !== value.expectedSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["finalized", "sha256"],
        message: "Finalized checksum must match the reserved expected checksum"
      });
    }
    if (
      value.finalized !== undefined &&
      Date.parse(value.finalized.finalizedAt) > Date.parse(value.binaryUpload.expiresAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["finalized", "finalizedAt"],
        message: "Upload must finalize before expiry"
      });
    }
    if (
      (value.status === "finalized" || value.status === "consumed") &&
      value.finalized === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["finalized"],
        message: `${value.status} uploads require finalized metadata`
      });
    }
    if (
      value.status !== "finalized" &&
      value.status !== "consumed" &&
      value.finalized !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["finalized"],
        message: "Only finalized or consumed uploads can include finalized metadata"
      });
    }
    if (value.status === "consumed" && value.purpose !== "zip-import") {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Only ZIP imports can be consumed"
      });
    }
    if ((value.status === "consumed") !== (value.consumedAt !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["consumedAt"],
        message: "Consumed status and consumedAt must appear together"
      });
    }
    if ((value.status === "discarded") !== (value.discardedAt !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["discardedAt"],
        message: "Discarded status and discardedAt must appear together"
      });
    }
    if ((value.status === "failed") !== (value.error !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Failed upload status and structured error must appear together"
      });
    }
  });

export const reserveUploadResourceResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    status: z.enum(["succeeded", "failed"]),
    resource: uploadResourceDescriptorSchema.optional(),
    error: uploadServiceErrorSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.status === "succeeded" &&
      (!value.resource || value.resource.status !== "reserved" || value.error)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Successful upload reservation requires one reserved resource and no error"
      });
    }
    if (value.status === "failed" && (!value.error || value.resource)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Failed upload reservation requires only a structured error"
      });
    }
  });

const uploadResourceIdInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    uploadResourceId: identifierSchema
  })
  .strict();

export const finalizeUploadResourceInputSchema = uploadResourceIdInputSchema;
export const getUploadResourceStatusInputSchema = uploadResourceIdInputSchema;
export const discardUploadResourceInputSchema = uploadResourceIdInputSchema;

export const uploadResourceOperationResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    status: z.enum(["succeeded", "failed"]),
    resource: uploadResourceDescriptorSchema.optional(),
    error: uploadServiceErrorSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "succeeded" && (!value.resource || value.error)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Successful upload operations require one resource and no error"
      });
    }
    if (value.status === "failed" && (!value.error || value.resource)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Failed upload operations require only a structured error"
      });
    }
  });

export const finalizeUploadResourceResultSchema = uploadResourceOperationResultSchema;
export const getUploadResourceStatusResultSchema = uploadResourceOperationResultSchema;
export const discardUploadResourceResultSchema = uploadResourceOperationResultSchema;

export type UploadResourcePurpose = z.infer<typeof uploadResourcePurposeSchema>;
export type UploadMimeType = z.infer<typeof uploadMimeTypeSchema>;
export type UploadResourceStatus = z.infer<typeof uploadResourceStatusSchema>;
export type UploadReusePolicy = z.infer<typeof uploadReusePolicySchema>;
export type UploadResourceDescriptor = z.infer<typeof uploadResourceDescriptorSchema>;
export type ReserveUploadResourceInput = z.input<typeof reserveUploadResourceInputSchema>;
export type ReserveUploadResourceResult = z.output<typeof reserveUploadResourceResultSchema>;
export type FinalizeUploadResourceInput = z.input<typeof finalizeUploadResourceInputSchema>;
export type FinalizeUploadResourceResult = z.output<typeof finalizeUploadResourceResultSchema>;
export type GetUploadResourceStatusInput = z.input<typeof getUploadResourceStatusInputSchema>;
export type GetUploadResourceStatusResult = z.output<typeof getUploadResourceStatusResultSchema>;
export type DiscardUploadResourceInput = z.input<typeof discardUploadResourceInputSchema>;
export type DiscardUploadResourceResult = z.output<typeof discardUploadResourceResultSchema>;
