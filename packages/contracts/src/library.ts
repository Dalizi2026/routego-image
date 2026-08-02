import { z } from "zod";

import {
  identifierSchema,
  nonEmptyTextSchema,
  routegoSchemaVersionSchema,
  timestampSchema
} from "./common";
import { routegoServiceErrorSchema } from "./errors";
import {
  aspectRatioSchema,
  editInvariantsSchema,
  imageFormatSchema,
  imageOperationKindSchema,
  imageQualitySchema,
  imageSizeSchema,
  moderationSchema,
  operationExecutionMetadataSchema,
  referenceRoleSchema,
  transparentModeSchema
} from "./image";
import { libraryAssetStatusSchema, routegoSearchLibraryInputSchema } from "./tools";

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

const libraryOperationParameterBaseSchema = z
  .object({
    prompt: z.string().trim().min(1).max(32_000),
    references: z.array(libraryParameterImageSchema).max(5).default([]),
    size: imageSizeSchema,
    aspectRatio: aspectRatioSchema,
    quality: imageQualitySchema,
    format: imageFormatSchema,
    compression: z.number().int().min(0).max(100).optional(),
    count: z.number().int().min(1).max(4),
    partialImages: z.number().int().min(0).max(3),
    transparentMode: transparentModeSchema,
    moderation: moderationSchema,
    outputDirectoryMode: libraryOutputDirectoryModeSchema,
    saveToLibrary: z.boolean()
  })
  .strict();

export const libraryGenerateOperationParametersSchema = libraryOperationParameterBaseSchema
  .extend({ kind: z.literal("generate") })
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
        message: "Transparent output requires PNG"
      });
    }
  });

export const libraryEditOperationParametersSchema = libraryOperationParameterBaseSchema
  .extend({
    kind: z.literal("edit"),
    target: libraryTargetParameterSchema,
    invariants: editInvariantsSchema
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
        message: "Transparent output requires PNG"
      });
    }
  });

export const libraryOperationParametersSchema = z.discriminatedUnion("kind", [
  libraryGenerateOperationParametersSchema,
  libraryEditOperationParametersSchema
]);

export const libraryAssetRelationshipRoleSchema = z.enum([
  "source",
  "target",
  "reference",
  "output",
  "transparent-original"
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

export const libraryAssetRenditionPhaseSchema = z.enum(["source", "partial", "final"]);

export const MAX_LIBRARY_ASSET_RENDITIONS = 33;

export const libraryAssetRenditionSchema = z
  .object({
    artifactId: identifierSchema,
    phase: libraryAssetRenditionPhaseSchema,
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    byteLength: z.number().int().min(1),
    width: z.number().int().min(1).max(65_535),
    height: z.number().int().min(1).max(65_535),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    createdAt: timestampSchema
  })
  .strict();

export const libraryAssetAllowedActionSchema = z.enum([
  "assign-folders",
  "remove-folders",
  "export-zip",
  "download",
  "copy-generation-info"
]);

export const libraryLocationDescriptorSchema = z
  .object({
    id: identifierSchema,
    name: z.string().trim().min(1).max(200),
    folderId: identifierSchema.optional(),
    assetCount: z.number().int().min(0),
    isDefault: z.boolean()
  })
  .strict();

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
    displayName: z.string().trim().min(1).max(200).optional(),
    prompt: z.string().max(32_000),
    model: z.string().trim().min(1).max(200),
    kind: z.enum(["generate", "edit"]),
    status: libraryAssetStatusSchema,
    primaryArtifactId: identifierSchema,
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
    renditions: z.array(libraryAssetRenditionSchema).min(1).max(MAX_LIBRARY_ASSET_RENDITIONS),
    relationships: z.array(libraryAssetRelationshipSchema).max(128),
    folders: z.array(libraryAssetFolderMembershipSchema).max(100),
    allowedActions: z.array(libraryAssetAllowedActionSchema).max(16)
  })
  .strict()
  .superRefine((value, context) => {
    const renditionByArtifactId = new Map(
      value.renditions.map((rendition) => [rendition.artifactId, rendition])
    );
    if (renditionByArtifactId.size !== value.renditions.length) {
      context.addIssue({
        code: "custom",
        path: ["renditions"],
        message: "Asset rendition artifact identifiers must be unique"
      });
    }
    const primaryRendition = renditionByArtifactId.get(value.primaryArtifactId);
    if (!primaryRendition) {
      context.addIssue({
        code: "custom",
        path: ["primaryArtifactId"],
        message: "Primary artifact must identify an asset rendition"
      });
    } else if (primaryRendition.phase === "source") {
      context.addIssue({
        code: "custom",
        path: ["primaryArtifactId"],
        message: "Primary artifact must identify a partial or final output"
      });
    }
    if (value.status === "succeeded") {
      if (!value.renditions.some((rendition) => rendition.phase === "final")) {
        context.addIssue({
          code: "custom",
          path: ["renditions"],
          message: "Succeeded assets require at least one final rendition"
        });
      }
      if (primaryRendition?.phase !== "final") {
        context.addIssue({
          code: "custom",
          path: ["primaryArtifactId"],
          message: "Succeeded assets require a final primary artifact"
        });
      }
    }
    for (const relationship of value.relationships) {
      if (relationship.role === "output" && relationship.relatedAssetId !== value.id) {
        context.addIssue({
          code: "custom",
          path: ["relationships"],
          message: "Output relationships must belong to the described asset"
        });
      }
      if (relationship.role === "output" && relationship.artifactId === undefined) {
        context.addIssue({
          code: "custom",
          path: ["relationships"],
          message: "Output relationships require an exact artifact identifier"
        });
      }
      if (relationship.artifactId === undefined) {
        continue;
      }
      const localRendition = renditionByArtifactId.get(relationship.artifactId);
      if (relationship.relatedAssetId === value.id && !localRendition) {
        context.addIssue({
          code: "custom",
          path: ["relationships"],
          message: "Relationship artifact must belong to its related asset"
        });
      } else if (relationship.relatedAssetId !== value.id && localRendition) {
        context.addIssue({
          code: "custom",
          path: ["relationships"],
          message: "Relationship artifact cannot be assigned to another asset"
        });
      }
      if (relationship.role === "output" && localRendition?.phase === "source") {
        context.addIssue({
          code: "custom",
          path: ["relationships"],
          message: "Output relationships cannot reference source renditions"
        });
      }
    }
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

export const studioLibrarySearchInputSchema = routegoSearchLibraryInputSchema;

export const studioLibrarySearchItemSchema = z
  .object({
    assetId: identifierSchema,
    displayName: z.string().trim().min(1).max(200).optional(),
    artifactId: identifierSchema,
    prompt: z.string().max(32_000),
    model: z.string().trim().min(1).max(200),
    kind: imageOperationKindSchema,
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    width: z.number().int().min(1).max(65_535),
    height: z.number().int().min(1).max(65_535),
    status: z.enum(["queued", "running", "succeeded", "partial", "failed"]),
    folderIds: z.array(identifierSchema).max(100),
    createdAt: timestampSchema,
    thumbnail: browserResourceDescriptorSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.thumbnail && !value.thumbnail.mimeType.startsWith("image/")) {
      context.addIssue({
        code: "custom",
        path: ["thumbnail", "mimeType"],
        message: "Studio Library thumbnails require image resources"
      });
    }
  });

export const studioLibrarySearchResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    items: z.array(studioLibrarySearchItemSchema).max(200),
    nextCursor: z.string().trim().min(1).max(2_000).optional(),
    total: z.number().int().min(0).optional()
  })
  .strict()
  .superRefine((value, context) => {
    const assetIds = value.items.map((item) => item.assetId);
    const artifactIds = value.items.map((item) => item.artifactId);
    if (new Set(assetIds).size !== assetIds.length) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Studio Library search asset identifiers must be unique"
      });
    }
    if (new Set(artifactIds).size !== artifactIds.length) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Studio Library search artifact identifiers must be unique"
      });
    }
  });

export const libraryMutationActionSchema = z.enum([
  "assign-folders",
  "remove-folders",
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

const assetMutationSchema = (action: "export-zip") =>
  z
    .object({
      action: z.literal(action),
      assetIds: uniqueIdentifiersSchema(1, 200)
    })
    .strict();

export const libraryMutationRequestSchema = z.discriminatedUnion("action", [
  assetFolderMutationSchema("assign-folders"),
  assetFolderMutationSchema("remove-folders"),
  assetMutationSchema("export-zip"),
  z
    .object({
      action: z.literal("import-zip"),
      uploadResourceId: identifierSchema
    })
    .strict(),
]);

export const libraryMutationConfirmationSchema = z.enum([
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
      value.action === "export-zip"
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
      value.action === "export-zip"
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


const sha256FingerprintSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, "Migration fingerprint must be a lowercase SHA-256 hex digest");

export const copyGenerationInfoInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    recordId: identifierSchema
  })
  .strict();

export const generationInfoProjectionSchema = z
  .object({
    recordId: identifierSchema,
    prompt: nonEmptyTextSchema,
    referenceIds: z.array(identifierSchema).max(5).default([]),
    parameters: z
      .object({
        size: imageSizeSchema,
        aspectRatio: aspectRatioSchema,
        quality: imageQualitySchema,
        format: imageFormatSchema,
        compression: z.number().int().min(0).max(100).optional(),
        count: z.number().int().min(1).max(4),
        transparentMode: transparentModeSchema,
        moderation: moderationSchema
      })
      .strict()
  })
  .strict();

export const copyGenerationInfoResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    status: z.enum(["succeeded", "failed"]),
    projection: generationInfoProjectionSchema.optional(),
    clipboardText: z.string().trim().min(1).max(64_000).optional(),
    providerRequestCount: z.literal(0),
    error: routegoServiceErrorSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "succeeded") {
      if (!value.projection || !value.clipboardText || value.error) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "Successful copy results require projection, clipboard text, and no error"
        });
      } else {
        const forbidden = /(?:[A-Za-z]:[\\/]|\\\\[A-Za-z]|\/(?:Users|home|tmp|var|private|opt)\/|file:|https?:\/\/|\/\/[A-Za-z0-9]|Authorization\s*:|Bearer\s|api[_-]?key|sk-[A-Za-z0-9]{10,}|data:image\/|base64,)/iu;
        if (forbidden.test(value.clipboardText)) {
          context.addIssue({
            code: "custom",
            path: ["clipboardText"],
            message: "Clipboard text must not contain paths, credentials, or image bytes"
          });
        }
      }
    }
    if (value.status === "failed") {
      if (!value.error || value.projection || value.clipboardText) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "Failed copy results require a structured error and no partial clipboard payload"
        });
      }
    }
  });

export const libraryMigrationPreflightInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1)
  })
  .strict();

export const libraryMigrationConflictSchema = z
  .object({
    dependentRecordId: identifierSchema,
    dependencyRecordId: identifierSchema,
    reason: z.enum([
      "generation-references-edit",
      "shared-file-survives",
      "unresolved-locator"
    ])
  })
  .strict();

export const libraryMigrationProjectedCountsSchema = z
  .object({
    trashGenerationRecords: z.number().int().min(0),
    editRecords: z.number().int().min(0),
    ownedFiles: z.number().int().min(0),
    sharedReferences: z.number().int().min(0),
    conflicts: z.number().int().min(0)
  })
  .strict();

export const libraryMigrationPreflightResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    fingerprint: sha256FingerprintSchema,
    eligible: z.boolean(),
    projectedCounts: libraryMigrationProjectedCountsSchema,
    conflicts: z.array(libraryMigrationConflictSchema).max(1_000).default([]),
    removableRecordIds: z.array(identifierSchema).max(10_000).default([]),
    providerRequestCount: z.literal(0),
    mutatesData: z.literal(false),
    error: routegoServiceErrorSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.projectedCounts.conflicts !== value.conflicts.length) {
      context.addIssue({
        code: "custom",
        path: ["projectedCounts", "conflicts"],
        message: "Projected conflict count must match the conflict list length"
      });
    }
    if (value.eligible && value.conflicts.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["eligible"],
        message: "Eligible migration preflight cannot include conflicts"
      });
    }
    if (!value.eligible && value.conflicts.length === 0 && !value.error) {
      context.addIssue({
        code: "custom",
        path: ["eligible"],
        message: "Blocked migration preflight requires conflicts or a structured error"
      });
    }
  });

export const libraryMigrationConfirmationInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    fingerprint: sha256FingerprintSchema,
    confirmDestructiveMigration: z.literal(true)
  })
  .strict();

export const libraryMigrationConfirmationResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    status: z.enum(["succeeded", "failed", "blocked"]),
    fingerprint: sha256FingerprintSchema,
    removedRecordCount: z.number().int().min(0).default(0),
    removedFileCount: z.number().int().min(0).default(0),
    recovered: z.boolean().default(false),
    providerRequestCount: z.literal(0),
    error: routegoServiceErrorSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "succeeded") {
      if (value.error || value.recovered) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "Successful migration cannot report recovery or an error"
        });
      }
    }
    if (value.status === "failed" && !value.error) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Failed migration requires a structured error"
      });
    }
    if (value.status === "blocked" && !value.error) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Blocked migration requires a structured error"
      });
    }
    if (value.status !== "succeeded" && value.removedRecordCount + value.removedFileCount > 0 && !value.recovered) {
      context.addIssue({
        code: "custom",
        path: ["recovered"],
        message: "Non-success migration that removed data must report recovery"
      });
    }
  });

export const legacyLibraryMigrationStateSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    status: z.enum(["not-required", "ready", "blocked"]),
    fingerprint: sha256FingerprintSchema.optional(),
    assetCount: z.number().int().min(0).max(100_000).default(0),
    providerRequestCount: z.literal(0),
    mutatesData: z.literal(false),
    error: routegoServiceErrorSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "ready" && value.fingerprint === undefined) {
      context.addIssue({ code: "custom", path: ["fingerprint"], message: "Ready migration requires a fingerprint" });
    }
    if (value.status === "blocked" && value.error === undefined) {
      context.addIssue({ code: "custom", path: ["error"], message: "Blocked migration requires an error" });
    }
  });

export const readLegacyLibraryMigrationInputSchema = z
  .object({ schemaVersion: routegoSchemaVersionSchema.default(1) })
  .strict();

export const confirmLegacyLibraryMigrationInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    fingerprint: sha256FingerprintSchema,
    confirmMigration: z.literal(true)
  })
  .strict();

export const confirmLegacyLibraryMigrationResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    status: z.enum(["succeeded", "failed", "blocked"]),
    fingerprint: sha256FingerprintSchema,
    providerRequestCount: z.literal(0),
    error: routegoServiceErrorSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "succeeded" && value.error !== undefined) {
      context.addIssue({ code: "custom", path: ["error"], message: "Successful migration cannot include an error" });
    }
    if (value.status !== "succeeded" && value.error === undefined) {
      context.addIssue({ code: "custom", path: ["error"], message: "Unsuccessful migration requires an error" });
    }
  });

export type LibraryFolderDescriptor = z.infer<typeof libraryFolderDescriptorSchema>;
export type ListFoldersInput = z.input<typeof listFoldersInputSchema>;
export type ListFoldersResult = z.output<typeof listFoldersResultSchema>;
export type ReorderFoldersInput = z.input<typeof reorderFoldersInputSchema>;
export type ReorderFoldersResult = z.output<typeof reorderFoldersResultSchema>;
export type LibraryOperationParameters = z.infer<typeof libraryOperationParametersSchema>;
export type LibraryAssetRenditionPhase = z.infer<typeof libraryAssetRenditionPhaseSchema>;
export type LibraryAssetRendition = z.infer<typeof libraryAssetRenditionSchema>;
export type LibraryAssetDetail = z.infer<typeof libraryAssetDetailSchema>;
export type GetAssetDetailInput = z.input<typeof getAssetDetailInputSchema>;
export type GetAssetDetailResult = z.output<typeof getAssetDetailResultSchema>;
export type BrowserResourceDescriptor = z.infer<typeof browserResourceDescriptorSchema>;
export type GetBrowserResourceInput = z.input<typeof getBrowserResourceInputSchema>;
export type GetBrowserResourceResult = z.output<typeof getBrowserResourceResultSchema>;
export type StudioLibrarySearchInput = z.input<typeof studioLibrarySearchInputSchema>;
export type StudioLibrarySearchItem = z.infer<typeof studioLibrarySearchItemSchema>;
export type StudioLibrarySearchResult = z.output<typeof studioLibrarySearchResultSchema>;
export type LibraryMutationRequest = z.infer<typeof libraryMutationRequestSchema>;
export type PreflightLibraryMutationInput = z.input<typeof preflightLibraryMutationInputSchema>;
export type PreflightLibraryMutationResult = z.output<
  typeof preflightLibraryMutationResultSchema
>;
export type ExecuteLibraryMutationInput = z.input<typeof executeLibraryMutationInputSchema>;
export type ExecuteLibraryMutationResult = z.output<typeof executeLibraryMutationResultSchema>;
export type LegacyLibraryMigrationState = z.output<typeof legacyLibraryMigrationStateSchema>;
export type ReadLegacyLibraryMigrationInput = z.input<typeof readLegacyLibraryMigrationInputSchema>;
export type ConfirmLegacyLibraryMigrationInput = z.input<typeof confirmLegacyLibraryMigrationInputSchema>;
export type ConfirmLegacyLibraryMigrationResult = z.output<typeof confirmLegacyLibraryMigrationResultSchema>;

export type CopyGenerationInfoInput = z.input<typeof copyGenerationInfoInputSchema>;
export type CopyGenerationInfoResult = z.output<typeof copyGenerationInfoResultSchema>;
export type GenerationInfoProjection = z.infer<typeof generationInfoProjectionSchema>;
export type LibraryMigrationPreflightInput = z.input<typeof libraryMigrationPreflightInputSchema>;
export type LibraryMigrationPreflightResult = z.output<typeof libraryMigrationPreflightResultSchema>;
export type LibraryMigrationConfirmationInput = z.input<typeof libraryMigrationConfirmationInputSchema>;
export type LibraryMigrationConfirmationResult = z.output<
  typeof libraryMigrationConfirmationResultSchema
>;
