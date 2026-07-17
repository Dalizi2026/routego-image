import { z } from "zod";

import { identifierSchema, routegoSchemaVersionSchema, timestampSchema } from "./common";
import { routegoServiceErrorSchema } from "./errors";
import {
  aspectRatioSchema,
  continuationActionSchema,
  editInvariantsSchema,
  imageArtifactPhaseSchema,
  imageFormatSchema,
  imageOperationKindSchema,
  imageQualitySchema,
  imageSizeSchema,
  moderationSchema,
  operationExecutionMetadataSchema,
  referenceRoleSchema,
  transparentModeSchema
} from "./image";
import { libraryAssetStatusSchema } from "./tools";

const uniqueIdentifiersSchema = (minimum: number, maximum: number) =>
  z
    .array(identifierSchema)
    .min(minimum)
    .max(maximum)
    .superRefine((values, context) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          message: "Identifiers must be unique and ordered"
        });
      }
    });

export const libraryFolderStateSchema = z.enum(["active", "deleted"]);

export const libraryFolderDescriptorSchema = z
  .object({
    id: identifierSchema,
    name: z.string().trim().min(1).max(200),
    order: z.number().int().min(0).max(100_000),
    assetCount: z.number().int().min(0),
    state: libraryFolderStateSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema
  })
  .strict();

export const listFoldersInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    includeDeleted: z.boolean().default(false)
  })
  .strict();

export const listFoldersResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    folders: z.array(libraryFolderDescriptorSchema).max(1_000)
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.folders.map((folder) => folder.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["folders"],
        message: "Folder identifiers must be unique"
      });
    }
    for (let index = 1; index < value.folders.length; index += 1) {
      if ((value.folders[index - 1]?.order ?? 0) > (value.folders[index]?.order ?? 0)) {
        context.addIssue({
          code: "custom",
          path: ["folders", index, "order"],
          message: "Folder results must be ordered by display order"
        });
      }
    }
  });

export const reorderFoldersInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    folderIds: uniqueIdentifiersSchema(1, 1_000)
  })
  .strict();

export const reorderFoldersResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    status: z.enum(["succeeded", "failed"]),
    folders: z.array(libraryFolderDescriptorSchema).max(1_000),
    error: routegoServiceErrorSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "succeeded" && value.error) {
      context.addIssue({ code: "custom", path: ["error"], message: "Success cannot include an error" });
    }
    if (value.status === "failed" && !value.error) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Failed folder reorder requires a structured error"
      });
    }
  });

export const libraryParameterImageSchema = z
  .object({
    assetId: identifierSchema,
    role: referenceRoleSchema,
    label: z.string().trim().min(1).max(200).optional()
  })
  .strict();

export const libraryTargetParameterSchema = z
  .object({
    assetId: identifierSchema,
    label: z.string().trim().min(1).max(200).optional()
  })
  .strict();

export const libraryOutputDirectoryModeSchema = z.enum(["default", "custom"]);

export const libraryOperationParametersSchema = z
  .object({
    kind: imageOperationKindSchema,
    prompt: z.string().trim().min(1).max(32_000),
    references: z.array(libraryParameterImageSchema).max(16).default([]),
    target: libraryTargetParameterSchema.optional(),
    supportingImages: z.array(libraryParameterImageSchema).max(15).default([]),
    maskAssetId: identifierSchema.optional(),
    invariants: editInvariantsSchema.optional(),
    size: imageSizeSchema,
    aspectRatio: aspectRatioSchema,
    quality: imageQualitySchema,
    format: imageFormatSchema,
    compression: z.number().int().min(0).max(100).optional(),
    count: z.number().int().min(1).max(4),
    partialImages: z.number().int().min(0).max(3),
    transparentMode: transparentModeSchema,
    moderation: moderationSchema,
    action: continuationActionSchema,
    previousResponseId: identifierSchema.optional(),
    imageIds: z.array(identifierSchema).max(16).default([]),
    fileIds: z.array(identifierSchema).max(16).default([]),
    outputDirectoryMode: libraryOutputDirectoryModeSchema,
    saveToLibrary: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    const physicalInputs =
      value.references.length + value.supportingImages.length + (value.target ? 1 : 0);
    if (physicalInputs > 16) {
      context.addIssue({
        code: "custom",
        path: ["references"],
        message: "Library parameters can describe at most sixteen image inputs"
      });
    }

    if (value.kind === "edit") {
      if (!value.target) {
        context.addIssue({
          code: "custom",
          path: ["target"],
          message: "Edit parameters require a target asset"
        });
      }
      if (!value.invariants) {
        context.addIssue({
          code: "custom",
          path: ["invariants"],
          message: "Edit parameters require edit invariants"
        });
      }
    } else if (value.target || value.supportingImages.length > 0 || value.maskAssetId || value.invariants) {
      context.addIssue({
        code: "custom",
        message: "Generate parameters cannot include edit-only assets or invariants"
      });
    }

    if (value.maskAssetId && !value.target) {
      context.addIssue({
        code: "custom",
        path: ["maskAssetId"],
        message: "A mask asset requires an edit target"
      });
    }
    if (value.action === "edit" && value.kind !== "edit") {
      context.addIssue({
        code: "custom",
        path: ["action"],
        message: "Continuation action edit requires edit parameters"
      });
    }
    if (value.compression !== undefined && value.format === "png") {
      context.addIssue({
        code: "custom",
        path: ["compression"],
        message: "Compression percentage applies only to JPEG or WebP"
      });
    }
    if (value.transparentMode !== "off" && value.format !== "png") {
      context.addIssue({
        code: "custom",
        path: ["format"],
        message: "Transparent output requires PNG"
      });
    }
  });

export const libraryAssetRelationshipRoleSchema = z.enum([
  "source",
  "target",
  "reference",
  "supporting",
  "mask",
  "output"
]);

export const libraryAssetRelationshipSchema = z
  .object({
    id: identifierSchema,
    role: libraryAssetRelationshipRoleSchema,
    relatedAssetId: identifierSchema,
    artifactId: identifierSchema.optional(),
    order: z.number().int().min(0).max(255),
    label: z.string().trim().min(1).max(200).optional()
  })
  .strict();

export const libraryAssetRenditionSchema = z
  .object({
    artifactId: identifierSchema,
    phase: imageArtifactPhaseSchema,
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    byteLength: z.number().int().min(1),
    width: z.number().int().min(1).max(65_535),
    height: z.number().int().min(1).max(65_535),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    createdAt: timestampSchema
  })
  .strict();

export const libraryAssetAllowedActionSchema = z.enum([
  "edit",
  "retry",
  "assign-folders",
  "remove-folders",
  "soft-delete",
  "restore",
  "permanent-delete",
  "export-zip",
  "download"
]);

export const libraryAssetFolderMembershipSchema = z
  .object({
    folderId: identifierSchema,
    name: z.string().trim().min(1).max(200),
    state: libraryFolderStateSchema,
    order: z.number().int().min(0).max(100_000)
  })
  .strict();

export const libraryAssetDetailSchema = z
  .object({
    id: identifierSchema,
    prompt: z.string().max(32_000),
    model: z.string().trim().min(1).max(200),
    kind: imageOperationKindSchema,
    status: libraryAssetStatusSchema,
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    width: z.number().int().min(1).max(65_535),
    height: z.number().int().min(1).max(65_535),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: timestampSchema.optional(),
    requestedParams: libraryOperationParametersSchema,
    effectiveParams: libraryOperationParametersSchema,
    execution: operationExecutionMetadataSchema,
    error: routegoServiceErrorSchema.optional(),
    renditions: z.array(libraryAssetRenditionSchema).max(16),
    relationships: z.array(libraryAssetRelationshipSchema).max(128),
    folders: z.array(libraryAssetFolderMembershipSchema).max(100),
    allowedActions: z.array(libraryAssetAllowedActionSchema).max(16)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind !== value.requestedParams.kind || value.kind !== value.effectiveParams.kind) {
      context.addIssue({
        code: "custom",
        path: ["kind"],
        message: "Asset detail kind must match requested and effective parameters"
      });
    }
    if (value.status === "deleted" && value.deletedAt === undefined) {
      context.addIssue({
        code: "custom",
        path: ["deletedAt"],
        message: "Deleted assets require deletedAt"
      });
    }
    if (value.status !== "deleted" && value.deletedAt !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["deletedAt"],
        message: "Only deleted assets can include deletedAt"
      });
    }
  });

export const getAssetDetailInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    assetId: identifierSchema
  })
  .strict();

export const getAssetDetailResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    status: z.enum(["succeeded", "failed"]),
    asset: libraryAssetDetailSchema.optional(),
    error: routegoServiceErrorSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "succeeded" && (!value.asset || value.error)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Successful asset detail requires an asset and no top-level error"
      });
    }
    if (value.status === "failed" && (!value.error || value.asset)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Failed asset detail requires only a structured error"
      });
    }
  });

export const browserResourceRenditionSchema = z.enum(["original", "preview", "thumbnail"]);

export const relativeBrowserResourceUrlSchema = z
  .string()
  .min(1)
  .max(2_048)
  .superRefine((value, context) => {
    if (
      (!value.startsWith("/api/v1/library/resources/") &&
        !value.startsWith("/api/v1/resources/")) ||
      value.startsWith("//") ||
      value.includes("\\") ||
      value.includes("..") ||
      value.includes("?") ||
      value.includes("#") ||
      value.includes("\0")
    ) {
      context.addIssue({
        code: "custom",
        message: "Browser resources require a protected relative resource URL"
      });
    }
  });

export const browserResourceDescriptorSchema = z
  .object({
    resourceId: identifierSchema,
    relativeUrl: relativeBrowserResourceUrlSchema,
    requiresSession: z.literal(true),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "application/zip"]),
    byteLength: z.number().int().min(1),
    width: z.number().int().min(1).max(65_535).optional(),
    height: z.number().int().min(1).max(65_535).optional(),
    etag: z.string().trim().min(1).max(200),
    expiresAt: timestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    const isImage = value.mimeType.startsWith("image/");
    if (isImage && (value.width === undefined || value.height === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["width"],
        message: "Image browser resources require width and height"
      });
    }
    if (!isImage && (value.width !== undefined || value.height !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["width"],
        message: "Non-image browser resources cannot include dimensions"
      });
    }
  });

export const getBrowserResourceInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    assetId: identifierSchema,
    artifactId: identifierSchema.optional(),
    rendition: browserResourceRenditionSchema.default("preview")
  })
  .strict();

export const getBrowserResourceResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    status: z.enum(["succeeded", "failed"]),
    resource: browserResourceDescriptorSchema.optional(),
    error: routegoServiceErrorSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "succeeded" && (!value.resource || value.error)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Successful resource lookup requires a resource and no error"
      });
    }
    if (value.status === "failed" && (!value.error || value.resource)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Failed resource lookup requires only a structured error"
      });
    }
  });

export const libraryMutationActionSchema = z.enum([
  "assign-folders",
  "remove-folders",
  "soft-delete",
  "restore",
  "permanent-delete",
  "export-zip",
  "import-zip"
]);

const assetFolderMutationSchema = (action: "assign-folders" | "remove-folders") =>
  z
    .object({
      action: z.literal(action),
      assetIds: uniqueIdentifiersSchema(1, 200),
      folderIds: uniqueIdentifiersSchema(1, 100)
    })
    .strict();

const assetMutationSchema = (
  action: "soft-delete" | "restore" | "permanent-delete" | "export-zip"
) =>
  z
    .object({
      action: z.literal(action),
      assetIds: uniqueIdentifiersSchema(1, 200)
    })
    .strict();

export const libraryMutationRequestSchema = z.discriminatedUnion("action", [
  assetFolderMutationSchema("assign-folders"),
  assetFolderMutationSchema("remove-folders"),
  assetMutationSchema("soft-delete"),
  assetMutationSchema("restore"),
  assetMutationSchema("permanent-delete"),
  assetMutationSchema("export-zip"),
  z
    .object({
      action: z.literal("import-zip"),
      uploadResourceId: identifierSchema
    })
    .strict()
]);

export const libraryMutationConfirmationSchema = z.enum([
  "permanent-delete",
  "zip-export",
  "zip-import"
]);

export const preflightLibraryMutationInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    mutation: libraryMutationRequestSchema
  })
  .strict();

export const libraryMutationPreflightItemSchema = z
  .object({
    targetId: identifierSchema,
    targetKind: z.enum(["asset", "upload-resource"]),
    eligible: z.boolean(),
    currentStatus: libraryAssetStatusSchema.optional(),
    allowedActions: z.array(libraryAssetAllowedActionSchema).max(16).default([]),
    requiredConfirmations: z.array(libraryMutationConfirmationSchema).max(3).default([]),
    warnings: z.array(z.string().trim().min(1).max(1_000)).max(20).default([]),
    error: routegoServiceErrorSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.eligible && value.error) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Eligible preflight items cannot include an error"
      });
    }
    if (!value.eligible && !value.error) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Blocked preflight items require a structured error"
      });
    }
  });

export const preflightLibraryMutationResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    preflightId: identifierSchema,
    action: libraryMutationActionSchema,
    status: z.enum(["ready", "partial", "blocked"]),
    expiresAt: timestampSchema,
    requiredConfirmations: z.array(libraryMutationConfirmationSchema).max(3).default([]),
    items: z.array(libraryMutationPreflightItemSchema).min(1).max(200),
    warnings: z.array(z.string().trim().min(1).max(1_000)).max(100).default([]),
    error: routegoServiceErrorSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    const eligibleCount = value.items.filter((item) => item.eligible).length;
    const expectedStatus =
      eligibleCount === value.items.length
        ? "ready"
        : eligibleCount === 0
          ? "blocked"
          : "partial";
    if (value.status !== expectedStatus) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: `Preflight status must be ${expectedStatus} for the item outcomes`
      });
    }
    if (value.status === "blocked" && !value.error && !value.items.some((item) => item.error)) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Blocked preflight requires a structured error"
      });
    }
    const requiredForAction =
      value.action === "permanent-delete"
        ? "permanent-delete"
        : value.action === "export-zip"
          ? "zip-export"
          : value.action === "import-zip"
            ? "zip-import"
            : undefined;
    if (
      requiredForAction !== undefined &&
      !value.requiredConfirmations.includes(requiredForAction)
    ) {
      context.addIssue({
        code: "custom",
        path: ["requiredConfirmations"],
        message: `${value.action} preflight requires ${requiredForAction} confirmation`
      });
    }
    if (
      (requiredForAction === undefined && value.requiredConfirmations.length > 0) ||
      (requiredForAction !== undefined &&
        (value.requiredConfirmations.length !== 1 ||
          value.requiredConfirmations[0] !== requiredForAction))
    ) {
      context.addIssue({
        code: "custom",
        path: ["requiredConfirmations"],
        message: "Preflight confirmations must match the selected mutation action"
      });
    }
  });

export const executeLibraryMutationInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    preflightId: identifierSchema,
    action: libraryMutationActionSchema,
    confirmations: z
      .array(libraryMutationConfirmationSchema)
      .max(3)
      .default([])
      .superRefine((values, context) => {
        if (new Set(values).size !== values.length) {
          context.addIssue({ code: "custom", message: "Confirmations must be unique" });
        }
      })
  })
  .strict()
  .superRefine((value, context) => {
    const requiredForAction =
      value.action === "permanent-delete"
        ? "permanent-delete"
        : value.action === "export-zip"
          ? "zip-export"
          : value.action === "import-zip"
            ? "zip-import"
            : undefined;
    if (requiredForAction !== undefined && !value.confirmations.includes(requiredForAction)) {
      context.addIssue({
        code: "custom",
        path: ["confirmations"],
        message: `${value.action} requires ${requiredForAction} confirmation`
      });
    }
    if (
      (requiredForAction === undefined && value.confirmations.length > 0) ||
      (requiredForAction !== undefined &&
        (value.confirmations.length !== 1 || value.confirmations[0] !== requiredForAction))
    ) {
      context.addIssue({
        code: "custom",
        path: ["confirmations"],
        message: "Execution confirmations must match the selected mutation action"
      });
    }
  });

export const libraryMutationItemResultSchema = z
  .object({
    targetId: identifierSchema,
    status: z.enum(["succeeded", "failed", "skipped"]),
    affectedAssetId: identifierSchema.optional(),
    affectedFolderIds: z.array(identifierSchema).max(100).default([]),
    warnings: z.array(z.string().trim().min(1).max(1_000)).max(20).default([]),
    error: routegoServiceErrorSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "succeeded" && value.error) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Successful mutation items cannot include an error"
      });
    }
    if (value.status === "failed" && !value.error) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Failed mutation items require a structured error"
      });
    }
  });

export const executeLibraryMutationResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    preflightId: identifierSchema,
    action: libraryMutationActionSchema,
    status: z.enum(["succeeded", "partial", "failed"]),
    items: z.array(libraryMutationItemResultSchema).min(1).max(200),
    outputResource: browserResourceDescriptorSchema.optional(),
    importedCount: z.number().int().min(0).optional(),
    skippedCount: z.number().int().min(0).optional(),
    warnings: z.array(z.string().trim().min(1).max(1_000)).max(100).default([]),
    error: routegoServiceErrorSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    const succeededCount = value.items.filter((item) => item.status === "succeeded").length;
    const expectedStatus =
      succeededCount === value.items.length
        ? "succeeded"
        : succeededCount === 0
          ? "failed"
          : "partial";
    if (value.status !== expectedStatus) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: `Mutation status must be ${expectedStatus} for the item outcomes`
      });
    }
    if (value.action !== "export-zip" && value.outputResource !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["outputResource"],
        message: "Only ZIP export can return an output resource"
      });
    }
    if (
      value.action !== "import-zip" &&
      (value.importedCount !== undefined || value.skippedCount !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["importedCount"],
        message: "Only ZIP import can return import counts"
      });
    }
  });

export type LibraryFolderDescriptor = z.infer<typeof libraryFolderDescriptorSchema>;
export type ListFoldersInput = z.input<typeof listFoldersInputSchema>;
export type ListFoldersResult = z.output<typeof listFoldersResultSchema>;
export type ReorderFoldersInput = z.input<typeof reorderFoldersInputSchema>;
export type ReorderFoldersResult = z.output<typeof reorderFoldersResultSchema>;
export type LibraryOperationParameters = z.infer<typeof libraryOperationParametersSchema>;
export type LibraryAssetDetail = z.infer<typeof libraryAssetDetailSchema>;
export type GetAssetDetailInput = z.input<typeof getAssetDetailInputSchema>;
export type GetAssetDetailResult = z.output<typeof getAssetDetailResultSchema>;
export type BrowserResourceDescriptor = z.infer<typeof browserResourceDescriptorSchema>;
export type GetBrowserResourceInput = z.input<typeof getBrowserResourceInputSchema>;
export type GetBrowserResourceResult = z.output<typeof getBrowserResourceResultSchema>;
export type LibraryMutationRequest = z.infer<typeof libraryMutationRequestSchema>;
export type PreflightLibraryMutationInput = z.input<typeof preflightLibraryMutationInputSchema>;
export type PreflightLibraryMutationResult = z.output<
  typeof preflightLibraryMutationResultSchema
>;
export type ExecuteLibraryMutationInput = z.input<typeof executeLibraryMutationInputSchema>;
export type ExecuteLibraryMutationResult = z.output<typeof executeLibraryMutationResultSchema>;
