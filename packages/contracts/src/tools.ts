import { z } from "zod";

import { filePathSchema, identifierSchema, routegoSchemaVersionSchema, timestampSchema } from "./common";
import { failedOutputSlotSchema, routegoServiceErrorSchema } from "./errors";
import {
  aspectRatioSchema,
  imageArtifactSchema,
  imageFormatSchema,
  imageOperationKindSchema,
  imageOperationRequestSchema,
  imageQualitySchema,
  imageRelationshipSchema,
  imageSizeSchema,
  moderationSchema,
  operationExecutionMetadataSchema,
  transparentModeSchema
} from "./image";
import { providerCapabilitySnapshotSchema, redactedEndpointDescriptorSchema } from "./provider";

export const operationStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled"
]);

export const imageOperationResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    requestId: identifierSchema,
    status: operationStatusSchema,
    requestedParams: imageOperationRequestSchema,
    effectiveParams: imageOperationRequestSchema,
    execution: operationExecutionMetadataSchema,
    finalArtifacts: z.array(imageArtifactSchema).max(4).default([]),
    partialArtifacts: z.array(imageArtifactSchema).max(12).default([]),
    failedSlots: z.array(failedOutputSlotSchema).max(4).default([]),
    relationships: z.array(imageRelationshipSchema).max(128).default([]),
    error: routegoServiceErrorSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    const hasArtifacts = value.finalArtifacts.length > 0 || value.partialArtifacts.length > 0;

    if (hasArtifacts && !value.execution.receivedAnyOutput) {
      context.addIssue({
        code: "custom",
        path: ["execution", "receivedAnyOutput"],
        message: "Artifact results require receivedAnyOutput=true"
      });
    }

    if (value.status === "succeeded" && (value.finalArtifacts.length === 0 || value.error)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Succeeded operations require final artifacts and no top-level error"
      });
    }

    if (value.status === "failed" && !value.error) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Failed operations require a structured error"
      });
    }

    if (
      value.status === "partial" &&
      !hasArtifacts &&
      value.failedSlots.length === 0 &&
      !value.error
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Partial operations require artifacts, failed slots, or an error"
      });
    }
  });

export const routegoStatusInputSchema = z
  .object({
    refreshCapabilities: z.boolean().default(false),
    confirmBillableProbe: z.boolean().default(false)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.confirmBillableProbe && !value.refreshCapabilities) {
      context.addIssue({
        code: "custom",
        path: ["confirmBillableProbe"],
        message: "Billable probe confirmation is only valid during capability refresh"
      });
    }
  });

export const routegoDefaultsSchema = z
  .object({
    model: z.string().trim().min(1).max(200).optional(),
    size: imageSizeSchema,
    aspectRatio: aspectRatioSchema,
    quality: imageQualitySchema,
    format: imageFormatSchema,
    count: z.number().int().min(1).max(4),
    partialImages: z.number().int().min(0).max(3),
    transparentMode: transparentModeSchema,
    moderation: moderationSchema,
    saveToLibrary: z.boolean()
  })
  .strict();

export const routegoServiceHealthSchema = z
  .object({
    status: z.enum(["starting", "ready", "degraded", "stopping"]),
    version: z.string().trim().min(1).max(100),
    nodeVersion: z.string().trim().min(1).max(100),
    uptimeSeconds: z.number().min(0),
    mcpAvailable: z.boolean(),
    httpAvailable: z.boolean(),
    studioAvailable: z.boolean()
  })
  .strict();

export const routegoStatusResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    configured: z.boolean(),
    hasApiKey: z.boolean(),
    apiKeyPreview: z.string().trim().min(1).max(32).optional(),
    providerId: identifierSchema.optional(),
    endpoint: redactedEndpointDescriptorSchema.optional(),
    models: z.array(z.string().trim().min(1).max(200)).max(500),
    capabilities: z.array(providerCapabilitySnapshotSchema).max(100),
    defaults: routegoDefaultsSchema,
    service: routegoServiceHealthSchema
  })
  .strict();

export const routegoGenerateInputSchema = imageOperationRequestSchema.refine(
  (value) => value.kind === "generate",
  { message: "routego_generate requires kind=generate", path: ["kind"] }
);

export const routegoEditInputSchema = imageOperationRequestSchema.refine(
  (value) => value.kind === "edit",
  { message: "routego_edit requires kind=edit", path: ["kind"] }
);

export const routegoBatchItemSchema = z
  .object({
    id: identifierSchema,
    operation: imageOperationRequestSchema
  })
  .strict();

export const routegoBatchInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    tasks: z.array(routegoBatchItemSchema).min(1).max(20),
    concurrency: z.number().int().min(1).max(10).default(3)
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set(value.tasks.map((item) => item.id));
    if (ids.size !== value.tasks.length) {
      context.addIssue({
        code: "custom",
        path: ["tasks"],
        message: "Batch task identifiers must be unique"
      });
    }
  });

export const routegoBatchResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    requestId: identifierSchema,
    status: z.enum(["succeeded", "partial", "failed", "cancelled"]),
    concurrency: z.number().int().min(1).max(10),
    items: z
      .array(
        z
          .object({
            id: identifierSchema,
            result: imageOperationResultSchema
          })
          .strict()
      )
      .min(1)
      .max(20),
    error: routegoServiceErrorSchema.optional()
  })
  .strict();

export const libraryAssetStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "deleted"
]);

export const routegoSearchLibraryInputSchema = z
  .object({
    query: z.string().trim().max(2_000).optional(),
    models: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
    from: timestampSchema.optional(),
    to: timestampSchema.optional(),
    kinds: z.array(imageOperationKindSchema).max(2).default([]),
    sizes: z.array(imageSizeSchema).max(100).default([]),
    statuses: z.array(libraryAssetStatusSchema).max(6).default([]),
    folderIds: z.array(identifierSchema).max(100).default([]),
    includeDeleted: z.boolean().default(false),
    sort: z.enum(["created-desc", "created-asc", "prompt-asc", "prompt-desc"]).default("created-desc"),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().trim().min(1).max(2_000).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.from && value.to && Date.parse(value.from) > Date.parse(value.to)) {
      context.addIssue({
        code: "custom",
        path: ["from"],
        message: "Library search from timestamp cannot be later than to timestamp"
      });
    }
  });

export const libraryAssetSummarySchema = z
  .object({
    id: identifierSchema,
    path: filePathSchema,
    prompt: z.string().max(32_000),
    model: z.string().trim().min(1).max(200),
    kind: imageOperationKindSchema,
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    width: z.number().int().min(1).max(65_535),
    height: z.number().int().min(1).max(65_535),
    status: libraryAssetStatusSchema,
    folderIds: z.array(identifierSchema).max(100),
    createdAt: timestampSchema,
    deletedAt: timestampSchema.optional()
  })
  .strict();

export const routegoSearchLibraryResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    items: z.array(libraryAssetSummarySchema).max(200),
    nextCursor: z.string().trim().min(1).max(2_000).optional(),
    total: z.number().int().min(0).optional()
  })
  .strict();

const assetIdsSchema = z.array(identifierSchema).min(1).max(200);
const folderIdsSchema = z.array(identifierSchema).min(1).max(100);

export const routegoManageLibraryInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create-folder"), name: z.string().trim().min(1).max(200) }).strict(),
  z
    .object({
      action: z.literal("rename-folder"),
      folderId: identifierSchema,
      name: z.string().trim().min(1).max(200)
    })
    .strict(),
  z.object({ action: z.literal("assign-folders"), assetIds: assetIdsSchema, folderIds: folderIdsSchema }).strict(),
  z.object({ action: z.literal("remove-folders"), assetIds: assetIdsSchema, folderIds: folderIdsSchema }).strict(),
  z.object({ action: z.literal("soft-delete"), assetIds: assetIdsSchema }).strict(),
  z.object({ action: z.literal("restore"), assetIds: assetIdsSchema }).strict(),
  z
    .object({
      action: z.literal("permanent-delete"),
      assetIds: assetIdsSchema,
      confirmPermanentDelete: z.literal(true)
    })
    .strict(),
  z
    .object({
      action: z.literal("export-zip"),
      assetIds: assetIdsSchema,
      outputPath: filePathSchema
    })
    .strict(),
  z.object({ action: z.literal("import-zip"), zipPath: filePathSchema }).strict()
]);

export const routegoManageLibraryResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    action: z.enum([
      "create-folder",
      "rename-folder",
      "assign-folders",
      "remove-folders",
      "soft-delete",
      "restore",
      "permanent-delete",
      "export-zip",
      "import-zip"
    ]),
    affectedAssetIds: z.array(identifierSchema).max(200).default([]),
    affectedFolderIds: z.array(identifierSchema).max(100).default([]),
    outputPath: filePathSchema.optional(),
    importedCount: z.number().int().min(0).optional(),
    skippedCount: z.number().int().min(0).optional(),
    warnings: z.array(z.string().trim().min(1).max(1_000)).max(100).default([])
  })
  .strict();

export const routegoOpenStudioInputSchema = z
  .object({
    reuseExisting: z.boolean().default(true),
    address: z.enum(["127.0.0.1", "::1"]).default("127.0.0.1")
  })
  .strict();

export const routegoOpenStudioResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    url: z
      .string()
      .url()
      .superRefine((value, context) => {
        const parsed = new URL(value);
        if (!parsed.searchParams.has("token")) {
          context.addIssue({ code: "custom", message: "Studio URL requires a session token" });
        }
      }),
    expiresAt: timestampSchema,
    reused: z.boolean(),
    address: z.enum(["127.0.0.1", "::1"])
  })
  .strict();

export type ImageOperationResult = z.infer<typeof imageOperationResultSchema>;
export type RoutegoStatusInput = z.input<typeof routegoStatusInputSchema>;
export type RoutegoStatusResult = z.output<typeof routegoStatusResultSchema>;
export type RoutegoGenerateInput = z.input<typeof routegoGenerateInputSchema>;
export type RoutegoEditInput = z.input<typeof routegoEditInputSchema>;
export type RoutegoBatchInput = z.input<typeof routegoBatchInputSchema>;
export type RoutegoBatchResult = z.output<typeof routegoBatchResultSchema>;
export type RoutegoSearchLibraryInput = z.input<typeof routegoSearchLibraryInputSchema>;
export type RoutegoSearchLibraryResult = z.output<typeof routegoSearchLibraryResultSchema>;
export type RoutegoManageLibraryInput = z.input<typeof routegoManageLibraryInputSchema>;
export type RoutegoManageLibraryResult = z.output<typeof routegoManageLibraryResultSchema>;
export type RoutegoOpenStudioInput = z.input<typeof routegoOpenStudioInputSchema>;
export type RoutegoOpenStudioResult = z.output<typeof routegoOpenStudioResultSchema>;
