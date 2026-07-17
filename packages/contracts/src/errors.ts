import { z } from "zod";

import { identifierSchema, safeDetailsSchema } from "./common";
import { imageArtifactSchema } from "./image";
import { providerCapabilitySchema } from "./provider";

export const routegoErrorCodeSchema = z.enum([
  "config_missing",
  "config_corrupt",
  "invalid_request",
  "invalid_input",
  "invalid_response",
  "internal_contract",
  "capability_unavailable",
  "auth_failed",
  "rate_limited",
  "timeout",
  "provider_5xx",
  "moderation_blocked",
  "download_failed",
  "postprocess_failed",
  "file_write_failed",
  "access_denied",
  "origin_rejected",
  "session_invalid",
  "path_unsafe",
  "not_found",
  "conflict",
  "cancelled"
]);

export const routegoErrorCategorySchema = z.enum([
  "configuration",
  "validation",
  "capability",
  "authentication",
  "rate_limit",
  "timeout",
  "moderation",
  "provider",
  "protocol",
  "download",
  "postprocess",
  "persistence",
  "security",
  "cancelled",
  "internal"
]);

export const routegoErrorStageSchema = z.enum([
  "configure",
  "validate",
  "route",
  "submit",
  "stream",
  "parse",
  "download",
  "postprocess",
  "persist",
  "transport",
  "complete"
]);

export const retryDispositionSchema = z.enum([
  "never",
  "user-confirmation",
  "safe-pre-generation",
  "respect-retry-after"
]);

export const routegoServiceErrorSchema = z
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
    partialArtifacts: z.array(imageArtifactSchema).max(4).default([]),
    receivedAnyOutput: z.boolean(),
    mayHaveBilled: z.boolean(),
    details: safeDetailsSchema.optional()
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

export const failedOutputSlotSchema = z
  .object({
    slot: z.number().int().min(0).max(255),
    error: routegoServiceErrorSchema
  })
  .strict();

export type RoutegoServiceError = z.infer<typeof routegoServiceErrorSchema>;
export type FailedOutputSlot = z.infer<typeof failedOutputSlotSchema>;
