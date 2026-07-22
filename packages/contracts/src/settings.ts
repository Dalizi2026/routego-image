import { z } from "zod";

import {
  filePathSchema,
  identifierSchema,
  routegoSchemaVersionSchema,
  timestampSchema
} from "./common";
import { routegoServiceErrorSchema } from "./errors";
import {
  providerCapabilityRecordSchema,
  providerCapabilitySchema,
  providerEndpointSetSchema,
  providerTransportSchema,
  redactedEndpointDescriptorSchema
} from "./provider";
import { routegoDefaultsSchema } from "./tools";

const apiKeyReplacementSchema = z
  .string()
  .min(1)
  .max(8_192)
  .refine((value) => value.trim().length > 0, "API key replacement cannot be blank")
  .refine((value) => !value.includes("\0"), "API key replacement cannot contain NUL characters");

export const apiKeyMutationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("unchanged") }).strict(),
  z.object({ operation: z.literal("replace"), value: apiKeyReplacementSchema }).strict(),
  z.object({ operation: z.literal("clear") }).strict()
]);

export const redactedProviderEndpointSetSchema = z
  .object({
    generation: redactedEndpointDescriptorSchema,
    models: redactedEndpointDescriptorSchema.optional(),
    edits: redactedEndpointDescriptorSchema.optional(),
    responses: redactedEndpointDescriptorSchema.optional()
  })
  .strict();

export const providerProfileDescriptorSchema = z
  .object({
    id: identifierSchema,
    name: z.string().trim().min(1).max(200),
    endpoints: redactedProviderEndpointSetSchema,
    defaultModel: z.string().trim().min(1).max(200).optional(),
    models: z.array(z.string().trim().min(1).max(200)).max(500).default([]),
    hasApiKey: z.boolean(),
    apiKeyPreview: z.string().trim().min(1).max(32).optional(),
    isActive: z.boolean(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.hasApiKey && value.apiKeyPreview !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["apiKeyPreview"],
        message: "API key preview requires hasApiKey=true"
      });
    }
  });

export const settingsOutputDirectorySchema = z
  .object({
    configured: z.boolean(),
    display: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .refine(
        (value) =>
          !/^(?:[A-Za-z]:[\\/]|\\\\|\/|file:)/u.test(value) &&
          !value.includes("\0") &&
          !value.split(/[\\/]/u).includes(".."),
        "Output directory display must be redacted rather than an absolute local path"
      )
      .optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.configured && value.display !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["display"],
        message: "Output directory display requires configured=true"
      });
    }
  });

const confirmedLocalOutputDirectorySchema = filePathSchema
  .refine(
    (value) => /^(?:[A-Za-z]:[\\/]|\/)/u.test(value),
    "Replacement output directory must be an absolute local path"
  )
  .refine(
    (value) => !/^(?:file:|[A-Za-z][A-Za-z0-9+.-]*:\/\/)/u.test(value),
    "Replacement output directory cannot be a URL"
  );

export const outputDirectoryMutationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("unchanged") }).strict(),
  z.object({ operation: z.literal("default") }).strict(),
  z.object({ operation: z.literal("clear") }).strict(),
  z
    .object({
      operation: z.literal("replace"),
      path: confirmedLocalOutputDirectorySchema,
      confirmLocalPath: z.literal(true)
    })
    .strict()
]);

export const readSettingsInputSchema = z
  .object({ schemaVersion: routegoSchemaVersionSchema.default(1) })
  .strict();

export const readSettingsResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    activeProviderId: identifierSchema.optional(),
    profiles: z.array(providerProfileDescriptorSchema).max(100),
    defaults: routegoDefaultsSchema,
    outputDirectory: settingsOutputDirectorySchema
  })
  .strict()
  .superRefine((value, context) => {
    const activeProfiles = value.profiles.filter((profile) => profile.isActive);
    if (activeProfiles.length > 1) {
      context.addIssue({
        code: "custom",
        path: ["profiles"],
        message: "Settings can contain at most one active provider profile"
      });
    }
    if (value.activeProviderId === undefined && activeProfiles.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["activeProviderId"],
        message: "Active profile metadata requires activeProviderId"
      });
    }
    if (
      value.activeProviderId !== undefined &&
      !value.profiles.some(
        (profile) => profile.id === value.activeProviderId && profile.isActive
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["activeProviderId"],
        message: "activeProviderId must reference the active profile"
      });
    }
  });

export const upsertProviderProfileInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    profileId: identifierSchema.optional(),
    name: z.string().trim().min(1).max(200),
    endpoints: providerEndpointSetSchema,
    defaultModel: z.string().trim().min(1).max(200).optional(),
    apiKey: apiKeyMutationSchema,
    setActive: z.boolean().default(false)
  })
  .strict();

export const upsertProviderProfileResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    profile: providerProfileDescriptorSchema,
    activeProviderId: identifierSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.profile.isActive && value.activeProviderId !== value.profile.id) {
      context.addIssue({
        code: "custom",
        path: ["activeProviderId"],
        message: "An active upserted profile must match activeProviderId"
      });
    }
  });

export const removeProviderProfileInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    profileId: identifierSchema
  })
  .strict();

export const removeProviderProfileResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    removedProfileId: identifierSchema,
    activeProviderId: identifierSchema.optional()
  })
  .strict();

export const setActiveProviderProfileInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    profileId: identifierSchema
  })
  .strict();

export const setActiveProviderProfileResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    activeProviderId: identifierSchema,
    profile: providerProfileDescriptorSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.profile.isActive || value.profile.id !== value.activeProviderId) {
      context.addIssue({
        code: "custom",
        path: ["profile"],
        message: "The selected active profile must match activeProviderId"
      });
    }
  });

export const refreshModelsInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    providerId: identifierSchema
  })
  .strict();

export const refreshModelsResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    providerId: identifierSchema,
    status: z.enum(["succeeded", "failed"]),
    billable: z.literal(false),
    models: z.array(z.string().trim().min(1).max(200)).max(500),
    refreshedAt: timestampSchema.optional(),
    error: routegoServiceErrorSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "succeeded" && (value.refreshedAt === undefined || value.error)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Successful model refresh requires refreshedAt and no error"
      });
    }
    if (value.status === "failed" && !value.error) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Failed model refresh requires a structured error"
      });
    }
  });

export const capabilityProbeInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    providerId: identifierSchema,
    model: z.string().trim().min(1).max(200),
    capability: providerCapabilitySchema,
    transport: providerTransportSchema,
    requestShape: z.string().trim().min(1).max(160),
    confirmBillableProbe: z.literal(true)
  })
  .strict();

export const capabilityProbeResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    providerId: identifierSchema,
    model: z.string().trim().min(1).max(200),
    status: z.enum(["completed", "failed"]),
    record: providerCapabilityRecordSchema,
    mayHaveBilled: z.boolean(),
    error: routegoServiceErrorSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.record.scope.providerId !== value.providerId) {
      context.addIssue({
        code: "custom",
        path: ["record", "scope", "providerId"],
        message: "Probe record provider must match the requested provider"
      });
    }
    if (value.record.scope.model !== value.model) {
      context.addIssue({
        code: "custom",
        path: ["record", "scope", "model"],
        message: "Probe record model must match the requested model"
      });
    }
    if (value.status === "completed" && value.error) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Completed capability probes cannot include an error"
      });
    }
    if (value.status === "failed" && !value.error) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Failed capability probes require a structured error"
      });
    }
  });

export const updateSettingsInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    defaults: routegoDefaultsSchema.optional(),
    outputDirectory: outputDirectoryMutationSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.defaults === undefined && value.outputDirectory === undefined) {
      context.addIssue({
        code: "custom",
        message: "Settings update requires defaults or an output-directory mutation"
      });
    }
  });

export const updateSettingsResultSchema = readSettingsResultSchema;


/**
 * Browser-safe Header provider switch.
 * Changes apply only to future submissions; in-flight work keeps its snapshot.
 * When preferredModel exists in the target catalog it is preserved; otherwise the
 * target profile default/valid model is selected and reported honestly.
 */
export const studioProviderSwitchInputSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema.default(1),
    profileId: identifierSchema,
    preferredModel: z.string().trim().min(1).max(200).optional()
  })
  .strict();

export const studioProviderSwitchResultSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    status: z.enum(["succeeded", "failed"]),
    activeProviderId: identifierSchema.optional(),
    selectedModel: z.string().trim().min(1).max(200).optional(),
    modelPreserved: z.boolean().optional(),
    profile: providerProfileDescriptorSchema.optional(),
    appliesToFutureSubmissionsOnly: z.literal(true).optional(),
    error: routegoServiceErrorSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "succeeded") {
      if (
        value.error ||
        value.activeProviderId === undefined ||
        value.selectedModel === undefined ||
        value.modelPreserved === undefined ||
        value.profile === undefined ||
        value.appliesToFutureSubmissionsOnly !== true
      ) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message:
            "Successful provider switch requires active profile, selected model, preservation flag, and future-only marker"
        });
      } else if (!value.profile.isActive || value.profile.id !== value.activeProviderId) {
        context.addIssue({
          code: "custom",
          path: ["profile"],
          message: "Switched profile must be active and match activeProviderId"
        });
      }
    }
    if (value.status === "failed") {
      if (!value.error) {
        context.addIssue({
          code: "custom",
          path: ["error"],
          message: "Failed provider switch requires a structured error"
        });
      }
      if (
        value.activeProviderId !== undefined ||
        value.selectedModel !== undefined ||
        value.modelPreserved !== undefined ||
        value.profile !== undefined ||
        value.appliesToFutureSubmissionsOnly !== undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "Failed provider switch must not claim a new active selection"
        });
      }
    }
  });

export type ApiKeyMutation = z.infer<typeof apiKeyMutationSchema>;
export type ProviderProfileDescriptor = z.infer<typeof providerProfileDescriptorSchema>;
export type ReadSettingsInput = z.input<typeof readSettingsInputSchema>;
export type ReadSettingsResult = z.output<typeof readSettingsResultSchema>;
export type UpsertProviderProfileInput = z.input<typeof upsertProviderProfileInputSchema>;
export type UpsertProviderProfileResult = z.output<typeof upsertProviderProfileResultSchema>;
export type RemoveProviderProfileInput = z.input<typeof removeProviderProfileInputSchema>;
export type RemoveProviderProfileResult = z.output<typeof removeProviderProfileResultSchema>;
export type SetActiveProviderProfileInput = z.input<typeof setActiveProviderProfileInputSchema>;
export type SetActiveProviderProfileResult = z.output<typeof setActiveProviderProfileResultSchema>;
export type RefreshModelsInput = z.input<typeof refreshModelsInputSchema>;
export type RefreshModelsResult = z.output<typeof refreshModelsResultSchema>;
export type CapabilityProbeInput = z.input<typeof capabilityProbeInputSchema>;
export type CapabilityProbeResult = z.output<typeof capabilityProbeResultSchema>;
export type OutputDirectoryMutation = z.infer<typeof outputDirectoryMutationSchema>;
export type UpdateSettingsInput = z.input<typeof updateSettingsInputSchema>;
export type UpdateSettingsResult = z.output<typeof updateSettingsResultSchema>;

export type StudioProviderSwitchInput = z.input<typeof studioProviderSwitchInputSchema>;
export type StudioProviderSwitchResult = z.output<typeof studioProviderSwitchResultSchema>;
