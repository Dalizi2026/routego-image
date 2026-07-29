import { z } from "zod";

import {
  filePathSchema,
  identifierSchema,
  nonEmptyTextSchema,
  routegoSchemaVersionSchema,
  timestampSchema
} from "./common";
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

/**
 * Routego's own bounded wait for an image-provider response. An upstream
 * provider or relay may still return its own timeout sooner.
 */
export const responseTimeoutMsSchema = z
  .number()
  .int()
  .min(30_000)
  .max(600_000)
  .refine((value) => value % 30_000 === 0, "Response timeout must use 30-second increments");

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
    saveToLibrary: z.boolean(),
    responseTimeoutMs: responseTimeoutMsSchema.optional()
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

export const routegoPrepareRegenerationInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    recordId: identifierSchema.optional()
  })
  .strict();

export const generationRecipeSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    kind: z.literal("generate"),
    sourceRecordId: identifierSchema,
    prompt: nonEmptyTextSchema,
    referenceIds: z.array(identifierSchema).max(5).default([]),
    size: imageSizeSchema.default("auto"),
    aspectRatio: aspectRatioSchema.default("auto"),
    quality: imageQualitySchema.default("auto"),
    format: imageFormatSchema.default("png"),
    compression: z.number().int().min(0).max(100).optional(),
    count: z.number().int().min(1).max(4).default(1),
    partialImages: z.number().int().min(0).max(3).default(0),
    transparentMode: transparentModeSchema.default("off"),
    moderation: moderationSchema.default("auto"),
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

export const routegoPrepareRegenerationResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    recipe: generationRecipeSchema,
    providerRequestCount: z.literal(0),
    markUnchanged: z.literal(true)
  })
  .strict();

export const routegoBatchItemSchema = z
  .object({
    id: identifierSchema,
    operation: imageOperationRequestSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.operation.kind !== "generate") {
      context.addIssue({
        code: "custom",
        path: ["operation", "kind"],
        message: "Batch items must be generation operations"
      });
    }
  });

export const routegoBatchInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    tasks: z.array(routegoBatchItemSchema).min(1).max(20)
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
  })
  .transform((value) => ({
    ...value,
    concurrency: 2 as const
  }));

export const routegoBatchResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    requestId: identifierSchema,
    status: z.enum(["succeeded", "partial", "failed", "cancelled"]),
    concurrency: z.literal(2),
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
const libraryLocationDescriptorSchema = z
  .object({
    id: identifierSchema,
    name: z.string().trim().min(1).max(200),
    folderId: identifierSchema.optional(),
    assetCount: z.number().int().min(0),
    isDefault: z.boolean()
  })
  .strict();

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
  z.object({ action: z.literal("list-locations") }).strict(),
  z.object({
    action: z.literal("add-location"),
    locationPath: filePathSchema,
    name: z.string().trim().min(1).max(200).optional()
  }).strict(),
  z.object({
    action: z.literal("move-assets"),
    assetIds: assetIdsSchema,
    destinationLocationId: identifierSchema
  }).strict(),
  z.object({
    action: z.literal("delete-assets"),
    assetIds: assetIdsSchema,
    confirmDelete: z.literal(true)
  }).strict(),
  z.object({
    action: z.literal("rename-asset"),
    assetId: identifierSchema,
    name: z.string().trim().min(1).max(200)
  }).strict(),
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
      "list-locations",
      "add-location",
      "move-assets",
      "delete-assets",
      "rename-asset",
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
    locations: z.array(libraryLocationDescriptorSchema).max(1_000).optional(),
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
export type RoutegoPrepareRegenerationInput = z.input<typeof routegoPrepareRegenerationInputSchema>;
export type GenerationRecipe = z.output<typeof generationRecipeSchema>;
export type RoutegoPrepareRegenerationResult = z.output<typeof routegoPrepareRegenerationResultSchema>;
export type RoutegoBatchInput = z.input<typeof routegoBatchInputSchema>;
export type RoutegoBatchParsedInput = z.output<typeof routegoBatchInputSchema>;
export type RoutegoBatchResult = z.output<typeof routegoBatchResultSchema>;
export type RoutegoSearchLibraryInput = z.input<typeof routegoSearchLibraryInputSchema>;
export type RoutegoSearchLibraryResult = z.output<typeof routegoSearchLibraryResultSchema>;
export type RoutegoManageLibraryInput = z.input<typeof routegoManageLibraryInputSchema>;
export type RoutegoManageLibraryResult = z.output<typeof routegoManageLibraryResultSchema>;
export type RoutegoOpenStudioInput = z.input<typeof routegoOpenStudioInputSchema>;
export type RoutegoOpenStudioResult = z.output<typeof routegoOpenStudioResultSchema>;

export const routegoOperationNames = [
  "status",
  "generate",
  "edit",
  "prepareRegeneration",
  "batch",
  "searchLibrary",
  "manageLibrary",
  "openStudio"
] as const;

export type RoutegoOperation = (typeof routegoOperationNames)[number];

export const routegoOperationDefinitions = {
  status: {
    toolName: "routego_status",
    http: { method: "GET" as const, path: "/api/v1/status" },
    inputSchema: routegoStatusInputSchema,
    outputSchema: routegoStatusResultSchema
  },
  generate: {
    toolName: "routego_generate",
    http: { method: "POST" as const, path: "/api/v1/generate" },
    inputSchema: routegoGenerateInputSchema,
    outputSchema: imageOperationResultSchema
  },
  edit: {
    toolName: "routego_edit",
    http: { method: "POST" as const, path: "/api/v1/edit" },
    inputSchema: routegoEditInputSchema,
    outputSchema: imageOperationResultSchema
  },
  prepareRegeneration: {
    toolName: "routego_prepare_regeneration",
    http: { method: "POST" as const, path: "/api/v1/prepare-regeneration" },
    inputSchema: routegoPrepareRegenerationInputSchema,
    outputSchema: routegoPrepareRegenerationResultSchema
  },
  batch: {
    toolName: "routego_batch",
    http: { method: "POST" as const, path: "/api/v1/batch" },
    inputSchema: routegoBatchInputSchema,
    outputSchema: routegoBatchResultSchema
  },
  searchLibrary: {
    toolName: "routego_search_library",
    http: { method: "POST" as const, path: "/api/v1/library/search" },
    inputSchema: routegoSearchLibraryInputSchema,
    outputSchema: routegoSearchLibraryResultSchema
  },
  manageLibrary: {
    toolName: "routego_manage_library",
    http: { method: "POST" as const, path: "/api/v1/library/manage" },
    inputSchema: routegoManageLibraryInputSchema,
    outputSchema: routegoManageLibraryResultSchema
  },
  openStudio: {
    toolName: "routego_open_studio",
    http: { method: "POST" as const, path: "/api/v1/studio/open" },
    inputSchema: routegoOpenStudioInputSchema,
    outputSchema: routegoOpenStudioResultSchema
  }
} as const satisfies Record<
  RoutegoOperation,
  {
    toolName: string;
    http: { method: "GET" | "POST"; path: string };
    inputSchema: z.ZodType;
    outputSchema: z.ZodType;
  }
>;

export interface RoutegoService {
  status(input: RoutegoStatusInput): Promise<RoutegoStatusResult>;
  generate(input: RoutegoGenerateInput): Promise<ImageOperationResult>;
  edit(input: RoutegoEditInput): Promise<ImageOperationResult>;
  prepareRegeneration(
    input: RoutegoPrepareRegenerationInput
  ): Promise<RoutegoPrepareRegenerationResult>;
  batch(input: RoutegoBatchInput): Promise<RoutegoBatchResult>;
  searchLibrary(input: RoutegoSearchLibraryInput): Promise<RoutegoSearchLibraryResult>;
  manageLibrary(input: RoutegoManageLibraryInput): Promise<RoutegoManageLibraryResult>;
  openStudio(input: RoutegoOpenStudioInput): Promise<RoutegoOpenStudioResult>;
}

export function parseRoutegoOperationInput(operation: RoutegoOperation, input: unknown): unknown {
  return routegoOperationDefinitions[operation].inputSchema.parse(input);
}

export function parseRoutegoOperationOutput(operation: RoutegoOperation, output: unknown): unknown {
  return routegoOperationDefinitions[operation].outputSchema.parse(output);
}
