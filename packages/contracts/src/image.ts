import { z } from "zod";

import {
  filePathSchema,
  identifierSchema,
  nonEmptyTextSchema,
  routegoSchemaVersionSchema,
  timestampSchema
} from "./common";
import { providerTransportSchema } from "./provider";

export const imageOperationKindSchema = z.literal("generate");

export const referenceRoleSchema = z.enum([
  "reference",
  "style",
  "composition",
  "subject",
  "character",
  "product",
  "background",
  "layout",
  "color-palette",
  "supporting",
  "previous-output"
]);

export const referenceImageSchema = z
  .object({
    id: identifierSchema.optional(),
    path: filePathSchema,
    role: referenceRoleSchema,
    label: z.string().trim().min(1).max(200).optional()
  })
  .strict();

// Legacy-only shapes remain temporarily available to the Library migration parser.
// They are not accepted by the generation operation contract.
export const targetImageSchema = z
  .object({
    id: identifierSchema.optional(),
    path: filePathSchema,
    label: z.string().trim().min(1).max(200).optional()
  })
  .strict();

export const supportingImageSchema = z
  .object({
    id: identifierSchema.optional(),
    path: filePathSchema,
    role: referenceRoleSchema.default("supporting"),
    label: z.string().trim().min(1).max(200).optional()
  })
  .strict();

export const editInvariantsSchema = z
  .object({
    allowedChanges: z.array(z.string().trim().min(1).max(500)).max(32).default([]),
    preserve: z.array(z.string().trim().min(1).max(500)).max(32).default([]),
    forbiddenChanges: z.array(z.string().trim().min(1).max(500)).max(32).default([])
  })
  .strict()
  .refine(
    (value) =>
      value.allowedChanges.length > 0 || value.preserve.length > 0 || value.forbiddenChanges.length > 0,
    "Edit invariants must record at least one legacy condition"
  );

export const imageSizeSchema = z.union([
  z.literal("auto"),
  z.string().regex(/^[1-9]\d{1,4}x[1-9]\d{1,4}$/u, "Size must be auto or WIDTHxHEIGHT")
]);

export const aspectRatioSchema = z.union([
  z.enum(["auto", "square", "portrait", "landscape"]),
  z.string().regex(/^[1-9]\d{0,2}:[1-9]\d{0,2}$/u, "Aspect ratio must be a positive W:H ratio")
]);

export const imageQualitySchema = z.enum(["auto", "low", "medium", "high"]);
export const imageFormatSchema = z.enum(["png", "jpeg", "webp"]);
export const transparentModeSchema = z.enum(["off", "auto", "chromakey", "native"]);
export const moderationSchema = z.enum(["auto", "low"]);
export const continuationActionSchema = z.enum(["auto", "generate", "edit"]);

export const imageOperationRequestSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    kind: imageOperationKindSchema.default("generate"),
    prompt: nonEmptyTextSchema,
    references: z.array(referenceImageSchema).max(5).default([]),
    size: imageSizeSchema.default("auto"),
    aspectRatio: aspectRatioSchema.default("auto"),
    quality: imageQualitySchema.default("auto"),
    format: imageFormatSchema.default("png"),
    compression: z.number().int().min(0).max(100).optional(),
    count: z.number().int().min(1).max(4).default(1),
    partialImages: z.number().int().min(0).max(3).default(0),
    transparentMode: transparentModeSchema.default("off"),
    moderation: moderationSchema.default("auto"),
    outputDir: filePathSchema.optional(),
    saveToLibrary: z.boolean().default(true)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.compression !== undefined && value.format === "png") {
      context.addIssue({
        code: "custom",
        path: ["compression"],
        message: "Compression percentage applies only to JPEG or WebP output"
      });
    }

    if (value.transparentMode !== "off" && value.format !== "png") {
      context.addIssue({
        code: "custom",
        path: ["format"],
        message: "Transparent output requires PNG format"
      });
    }
  });

export const imageArtifactPhaseSchema = z.enum(["partial", "final"]);

export const imageDisplayContentSchema = z
  .object({
    type: z.literal("image"),
    dataUrl: z
      .string()
      .max(70_000_000)
      .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/u)
      .optional()
  })
  .strict();

export const imageArtifactSchema = z
  .object({
    id: identifierSchema,
    slot: z.number().int().min(0).max(255),
    phase: imageArtifactPhaseSchema,
    path: filePathSchema.optional(),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    byteLength: z.number().int().min(1).optional(),
    width: z.number().int().min(1).max(65_535).optional(),
    height: z.number().int().min(1).max(65_535).optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    providerImageId: identifierSchema.optional(),
    display: imageDisplayContentSchema.optional(),
    createdAt: timestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.path && !value.display?.dataUrl) {
      context.addIssue({
        code: "custom",
        message: "An image artifact requires a file path or displayable image data"
      });
    }
  });

export const imageRelationshipRoleSchema = z.enum([
  "target",
  "reference",
  "supporting",
  "mask",
  "output",
  "transparent-original",
  "stream-partial"
]);

export const imageRelationshipSchema = z
  .object({
    inputId: identifierSchema.optional(),
    inputRole: imageRelationshipRoleSchema,
    outputArtifactId: identifierSchema,
    order: z.number().int().min(0).max(255)
  })
  .strict();

const operationEventBaseSchema = z.object({
  requestId: identifierSchema,
  sequence: z.number().int().min(0),
  occurredAt: timestampSchema
});

export const imageOperationEventSchema = z.discriminatedUnion("type", [
  operationEventBaseSchema.extend({ type: z.literal("started") }).strict(),
  operationEventBaseSchema
    .extend({ type: z.literal("partial"), artifact: imageArtifactSchema })
    .strict(),
  operationEventBaseSchema
    .extend({ type: z.literal("completed"), artifactIds: z.array(identifierSchema).min(1).max(4) })
    .strict(),
  operationEventBaseSchema
    .extend({
      type: z.literal("failed"),
      code: identifierSchema,
      safeMessage: z.string().trim().min(1).max(1_000),
      receivedAnyOutput: z.boolean(),
      mayHaveBilled: z.boolean()
    })
    .strict()
]);

export const operationExecutionMetadataSchema = z
  .object({
    transport: providerTransportSchema.optional(),
    attemptCount: z.number().int().min(0).max(16),
    providerRequestCount: z.number().int().min(0).max(100),
    receivedAnyOutput: z.boolean(),
    mayHaveBilled: z.boolean(),
    degradedContinuation: z.boolean().default(false),
    providerResponseId: identifierSchema.optional(),
    providerImageIds: z.array(identifierSchema).max(16).default([])
  })
  .strict();

export type ImageOperationRequest = z.infer<typeof imageOperationRequestSchema>;
export type ImageArtifact = z.infer<typeof imageArtifactSchema>;
export type ImageRelationship = z.infer<typeof imageRelationshipSchema>;
export type ImageOperationEvent = z.infer<typeof imageOperationEventSchema>;
export type OperationExecutionMetadata = z.infer<typeof operationExecutionMetadataSchema>;
