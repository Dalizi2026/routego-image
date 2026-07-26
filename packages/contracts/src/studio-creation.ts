import { z } from "zod";

import {
  identifierSchema,
  nonEmptyTextSchema,
  routegoSchemaVersionSchema,
  timestampSchema
} from "./common";
import {
  retryDispositionSchema,
  routegoErrorCategorySchema,
  routegoErrorCodeSchema,
  routegoErrorStageSchema
} from "./errors";
import {
  aspectRatioSchema,
  imageArtifactPhaseSchema,
  imageFormatSchema,
  imageSizeSchema,
  operationExecutionMetadataSchema,
  transparentModeSchema
} from "./image";
import { browserResourceDescriptorSchema } from "./library";
import { providerCapabilitySchema } from "./provider";

function addStudioOutputControlIssues(
  value: {
    format: "png" | "jpeg" | "webp";
    transparentMode: string;
  },
  context: z.core.$RefinementCtx
): void {
  if (value.transparentMode !== "off" && value.format !== "png") {
    context.addIssue({
      code: "custom",
      path: ["format"],
      message: "Transparent output requires PNG format",
      input: value
    });
  }
}

/**
 * Text-only Studio generation request.
 * Approved workbench controls: size, aspect ratio, format, count, transparency.
 * Hidden Settings defaults (quality, compression, partial-images, moderation) are
 * resolved by the service after validation and MUST NOT appear on the workbench contract.
 */
export const studioGenerateInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    kind: z.literal("generate"),
    prompt: nonEmptyTextSchema,
    size: imageSizeSchema.default("auto"),
    aspectRatio: aspectRatioSchema.default("auto"),
    format: imageFormatSchema.default("png"),
    count: z.number().int().min(1).max(4).default(1),
    transparentMode: transparentModeSchema.default("off"),
    saveToLibrary: z.boolean().default(true)
  })
  .strict()
  .superRefine((value, context) => {
    addStudioOutputControlIssues(value, context);
  });

export const studioImageOperationRequestSchema = studioGenerateInputSchema;

export const studioImageArtifactSchema = z
  .object({
    artifactId: identifierSchema,
    assetId: identifierSchema.optional(),
    slot: z.number().int().min(0).max(255),
    phase: imageArtifactPhaseSchema,
    resource: browserResourceDescriptorSchema,
    providerImageId: identifierSchema.optional(),
    createdAt: timestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.resource.mimeType.startsWith("image/")) {
      context.addIssue({
        code: "custom",
        path: ["resource", "mimeType"],
        message: "Studio image artifacts require an image browser resource"
      });
    }
  });

export const studioImageRelationshipRoleSchema = z.enum([
  "output",
  "stream-partial",
  "transparent-original"
]);

export const studioImageRelationshipSchema = z
  .object({
    role: studioImageRelationshipRoleSchema,
    outputArtifactId: identifierSchema,
    order: z.number().int().min(0).max(255)
  })
  .strict();

export const studioServiceErrorSchema = z
  .object({
    id: identifierSchema.optional(),
    code: routegoErrorCodeSchema,
    category: routegoErrorCategorySchema,
    stage: routegoErrorStageSchema,
    safeMessage: z.string().trim().min(1).max(1_000),
    retryDisposition: retryDispositionSchema,
    httpStatus: z.number().int().min(100).max(599).optional(),
    providerCode: z.string().trim().min(1).max(200).optional(),
    capability: providerCapabilitySchema.optional(),
    partialArtifacts: z.array(studioImageArtifactSchema).max(4).default([]),
    receivedAnyOutput: z.boolean(),
    mayHaveBilled: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.partialArtifacts.length > 0 && !value.receivedAnyOutput) {
      context.addIssue({
        code: "custom",
        path: ["receivedAnyOutput"],
        message: "Partial artifacts require receivedAnyOutput=true"
      });
    }
    if (value.receivedAnyOutput && !value.mayHaveBilled) {
      context.addIssue({
        code: "custom",
        path: ["mayHaveBilled"],
        message: "Received provider output must be treated as potentially billable"
      });
    }
    if (
      (value.retryDisposition === "safe-pre-generation" ||
        value.retryDisposition === "respect-retry-after") &&
      (value.receivedAnyOutput || value.mayHaveBilled)
    ) {
      context.addIssue({
        code: "custom",
        path: ["retryDisposition"],
        message: "Automatic retry dispositions require no output and no billing risk"
      });
    }
  });

export const studioFailedOutputSlotSchema = z
  .object({
    slot: z.number().int().min(0).max(255),
    error: studioServiceErrorSchema
  })
  .strict();

export const studioImageOperationResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    requestId: identifierSchema,
    status: z.enum(["succeeded", "partial", "failed"]),
    requestedParams: studioImageOperationRequestSchema,
    effectiveParams: studioImageOperationRequestSchema,
    execution: operationExecutionMetadataSchema,
    finalArtifacts: z.array(studioImageArtifactSchema).max(4).default([]),
    partialArtifacts: z.array(studioImageArtifactSchema).max(12).default([]),
    failedSlots: z.array(studioFailedOutputSlotSchema).max(4).default([]),
    relationships: z.array(studioImageRelationshipSchema).max(128).default([]),
    error: studioServiceErrorSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.requestedParams.kind !== value.effectiveParams.kind) {
      context.addIssue({
        code: "custom",
        path: ["effectiveParams", "kind"],
        message: "Requested and effective Studio operation kinds must match"
      });
    }

    const artifacts = [...value.finalArtifacts, ...value.partialArtifacts];
    const artifactIds = artifacts.map((artifact) => artifact.artifactId);
    const uniqueArtifactIds = new Set(artifactIds);
    if (uniqueArtifactIds.size !== artifactIds.length) {
      context.addIssue({
        code: "custom",
        path: ["finalArtifacts"],
        message: "Studio artifact identifiers must be unique"
      });
    }
    if (value.finalArtifacts.some((artifact) => artifact.phase !== "final")) {
      context.addIssue({
        code: "custom",
        path: ["finalArtifacts"],
        message: "Final artifact collections require phase=final"
      });
    }
    if (value.partialArtifacts.some((artifact) => artifact.phase !== "partial")) {
      context.addIssue({
        code: "custom",
        path: ["partialArtifacts"],
        message: "Partial artifact collections require phase=partial"
      });
    }
    for (const relationship of value.relationships) {
      if (!uniqueArtifactIds.has(relationship.outputArtifactId)) {
        context.addIssue({
          code: "custom",
          path: ["relationships"],
          message: "Studio relationships must reference a returned artifact"
        });
      }
    }

    const hasArtifacts = artifacts.length > 0;
    if (hasArtifacts && !value.execution.receivedAnyOutput) {
      context.addIssue({
        code: "custom",
        path: ["execution", "receivedAnyOutput"],
        message: "Studio artifacts require receivedAnyOutput=true"
      });
    }
    if (value.status === "succeeded" && (value.finalArtifacts.length === 0 || value.error)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Succeeded Studio operations require final artifacts and no error"
      });
    }
    if (value.status === "failed" && !value.error) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Failed Studio operations require a structured error"
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
        message: "Partial Studio operations require artifacts, failed slots, or an error"
      });
    }
    if (
      value.error &&
      (value.error.receivedAnyOutput !== value.execution.receivedAnyOutput ||
        value.error.mayHaveBilled !== value.execution.mayHaveBilled)
    ) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Studio error billing/output flags must match execution metadata"
      });
    }
  });

const studioEventBaseSchema = z.object({
  requestId: identifierSchema,
  sequence: z.number().int().min(0),
  occurredAt: timestampSchema
});

export const studioImageOperationEventSchema = z.discriminatedUnion("type", [
  studioEventBaseSchema
    .extend({
      type: z.literal("started"),
      requestedParams: studioImageOperationRequestSchema
    })
    .strict(),
  studioEventBaseSchema
    .extend({
      type: z.literal("partial"),
      artifact: studioImageArtifactSchema.refine((value) => value.phase === "partial", {
        message: "Partial events require phase=partial"
      }),
      receivedAnyOutput: z.literal(true),
      mayHaveBilled: z.literal(true)
    })
    .strict(),
  studioEventBaseSchema
    .extend({
      type: z.literal("completed"),
      result: studioImageOperationResultSchema.refine((value) => value.status !== "failed", {
        message: "Completed events cannot contain a failed result"
      })
    })
    .strict(),
  studioEventBaseSchema
    .extend({
      type: z.literal("failed"),
      error: studioServiceErrorSchema,
      receivedAnyOutput: z.boolean(),
      mayHaveBilled: z.boolean()
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.receivedAnyOutput !== value.error.receivedAnyOutput ||
        value.mayHaveBilled !== value.error.mayHaveBilled
      ) {
        context.addIssue({
          code: "custom",
          path: ["error"],
          message: "Failed event flags must match the structured error"
        });
      }
    })
]);

export const studioBatchItemSchema = z
  .object({
    id: identifierSchema,
    operation: studioGenerateInputSchema
  })
  .strict();

export const studioBatchInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    tasks: z.array(studioBatchItemSchema).min(1).max(20)
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.tasks.map((task) => task.id)).size !== value.tasks.length) {
      context.addIssue({
        code: "custom",
        path: ["tasks"],
        message: "Studio batch task identifiers must be unique"
      });
    }
  })
  .transform((value) => ({
    ...value,
    concurrency: 2 as const
  }));

export const studioBatchResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    requestId: identifierSchema,
    status: z.enum(["succeeded", "partial", "failed"]),
    concurrency: z.literal(2),
    taskIds: z.array(identifierSchema).min(1).max(20),
    items: z
      .array(
        z
          .object({
            id: identifierSchema,
            result: studioImageOperationResultSchema
          })
          .strict()
      )
      .min(1)
      .max(20)
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.taskIds).size !== value.taskIds.length) {
      context.addIssue({
        code: "custom",
        path: ["taskIds"],
        message: "Studio batch task order identifiers must be unique"
      });
    }
    const itemIds = value.items.map((item) => item.id);
    if (new Set(itemIds).size !== itemIds.length) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Studio batch result identifiers must be unique"
      });
    }
    if (
      value.taskIds.length !== itemIds.length ||
      value.taskIds.some((taskId, index) => taskId !== itemIds[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Studio batch results must preserve the requested task order"
      });
    }
    const allSucceeded = value.items.every((item) => item.result.status === "succeeded");
    const allFailed = value.items.every((item) => item.result.status === "failed");
    const expectedStatus = allSucceeded ? "succeeded" : allFailed ? "failed" : "partial";
    if (value.status !== expectedStatus) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: `Studio batch status must be ${expectedStatus} for its item outcomes`
      });
    }
  });

export type StudioGenerateInput = z.input<typeof studioGenerateInputSchema>;
export type StudioImageOperationRequest = z.output<typeof studioImageOperationRequestSchema>;
export type StudioImageArtifact = z.infer<typeof studioImageArtifactSchema>;
export type StudioImageRelationship = z.infer<typeof studioImageRelationshipSchema>;
export type StudioServiceError = z.infer<typeof studioServiceErrorSchema>;
export type StudioImageOperationResult = z.infer<typeof studioImageOperationResultSchema>;
export type StudioImageOperationEvent = z.infer<typeof studioImageOperationEventSchema>;
export type StudioBatchInput = z.input<typeof studioBatchInputSchema>;
export type StudioBatchResult = z.output<typeof studioBatchResultSchema>;
