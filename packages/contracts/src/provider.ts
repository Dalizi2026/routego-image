import { z } from "zod";

import {
  identifierSchema,
  routegoSchemaVersionSchema,
  safeDetailsSchema,
  timestampSchema
} from "./common";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "::1", "localhost"]);

function validateProviderUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return "Provider endpoints must use HTTP or HTTPS";
    }

    if (parsed.username || parsed.password) {
      return "Provider endpoints cannot contain URL userinfo";
    }

    if (parsed.hash) {
      return "Provider endpoints cannot contain URL fragments";
    }

    if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
      return "Cleartext HTTP provider endpoints are limited to loopback hosts";
    }

    return undefined;
  } catch {
    return "Provider endpoint must be a valid absolute URL";
  }
}

export const providerUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .superRefine((value, context) => {
    const message = validateProviderUrl(value);
    if (message) {
      context.addIssue({ code: "custom", message });
    }
  });

export const endpointInputModeSchema = z.enum([
  "exact-generation-endpoint",
  "legacy-api-base"
]);

export const generationEndpointInputSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("exact-generation-endpoint"),
      value: providerUrlSchema
    })
    .strict(),
  z
    .object({
      mode: z.literal("legacy-api-base"),
      value: providerUrlSchema
    })
    .strict()
]);

export const providerEndpointSetSchema = z
  .object({
    generation: generationEndpointInputSchema,
    models: providerUrlSchema.optional(),
    edits: providerUrlSchema.optional(),
    responses: providerUrlSchema.optional()
  })
  .strict();

export const providerTransportSchema = z.enum([
  "single-endpoint-json",
  "openai-images",
  "openai-responses"
]);

export const capabilityStateSchema = z.enum([
  "unknown",
  "supported",
  "unsupported",
  "degraded"
]);

export const providerCapabilitySchema = z.enum([
  "text-generation",
  "single-image-input",
  "multi-image-input",
  "target-edit",
  "mask-edit",
  "canvas-expansion",
  "native-variants",
  "custom-size",
  "quality-control",
  "output-format",
  "compression",
  "streaming",
  "partial-images",
  "native-transparency",
  "moderation",
  "responses-state",
  "image-url-input",
  "base64-input",
  "data-url-input",
  "multipart-input",
  "file-id-input",
  "image-id-input"
]);

export const capabilityEvidenceSourceSchema = z.enum([
  "default-policy",
  "user-configuration",
  "provider-documentation",
  "successful-request",
  "protocol-rejection",
  "transient-failure",
  "degraded-fallback",
  "synthetic-fixture"
]);

export const capabilityEvidenceSchema = z
  .object({
    source: capabilityEvidenceSourceSchema,
    observedAt: timestampSchema,
    summary: z.string().trim().min(1).max(500),
    requestShape: z.string().trim().min(1).max(160).optional(),
    responseShape: z.string().trim().min(1).max(160).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    details: safeDetailsSchema.optional()
  })
  .strict();

export const providerCapabilityScopeSchema = z
  .object({
    providerId: identifierSchema,
    model: z.string().trim().min(1).max(200),
    endpointFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    transport: providerTransportSchema,
    requestShape: z.string().trim().min(1).max(160)
  })
  .strict();

export const capabilityLimitsSchema = z
  .object({
    maxImages: z.number().int().min(0).max(16).optional(),
    maxVariants: z.number().int().min(1).max(4).optional(),
    maxPartialImages: z.number().int().min(0).max(3).optional(),
    supportedImageFields: z.array(z.enum(["image", "images"])).max(2).optional(),
    supportedSizes: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
    supportedQualities: z
      .array(z.enum(["auto", "low", "medium", "high"]))
      .max(4)
      .optional(),
    supportedFormats: z.array(z.enum(["png", "jpeg", "webp"])).max(3).optional()
  })
  .strict();

const CONCLUSIVE_SUPPORTED_EVIDENCE = new Set([
  "user-configuration",
  "provider-documentation",
  "successful-request"
]);

const CONCLUSIVE_UNSUPPORTED_EVIDENCE = new Set([
  "user-configuration",
  "provider-documentation",
  "protocol-rejection"
]);

export const providerCapabilityRecordSchema = z
  .object({
    capability: providerCapabilitySchema,
    scope: providerCapabilityScopeSchema,
    state: capabilityStateSchema,
    evidence: z.array(capabilityEvidenceSchema).max(32).default([]),
    verifiedAt: timestampSchema.optional(),
    degradedReason: z.string().trim().min(1).max(500).optional(),
    limits: capabilityLimitsSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    const sources = value.evidence.map((item) => item.source);

    if (value.state === "supported" && !sources.some((source) => CONCLUSIVE_SUPPORTED_EVIDENCE.has(source))) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "Supported capabilities require explicit non-synthetic evidence"
      });
    }

    if (
      value.state === "unsupported" &&
      !sources.some((source) => CONCLUSIVE_UNSUPPORTED_EVIDENCE.has(source))
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "Unsupported capabilities require stable protocol or documentary evidence"
      });
    }

    if (value.state === "degraded" && !value.degradedReason) {
      context.addIssue({
        code: "custom",
        path: ["degradedReason"],
        message: "Degraded capabilities require a degradation reason"
      });
    }

    if (value.state !== "unknown" && !value.verifiedAt) {
      context.addIssue({
        code: "custom",
        path: ["verifiedAt"],
        message: "Conclusive or degraded capability states require a verification time"
      });
    }
  });

export const redactedEndpointDescriptorSchema = z
  .object({
    mode: endpointInputModeSchema,
    origin: z.string().trim().min(1).max(512),
    pathname: z.string().min(1).max(2_048),
    hasQuery: z.boolean(),
    display: z.string().trim().min(1).max(1_024)
  })
  .strict();

export const providerCapabilitySnapshotSchema = z
  .object({
    schemaVersion: routegoSchemaVersionSchema,
    providerId: identifierSchema,
    model: z.string().trim().min(1).max(200),
    endpoint: redactedEndpointDescriptorSchema,
    capabilities: z.array(providerCapabilityRecordSchema).max(128),
    refreshedAt: timestampSchema.optional()
  })
  .strict();

export type EndpointInputMode = z.infer<typeof endpointInputModeSchema>;
export type GenerationEndpointInput = z.infer<typeof generationEndpointInputSchema>;
export type ProviderEndpointSet = z.infer<typeof providerEndpointSetSchema>;
export type ProviderTransport = z.infer<typeof providerTransportSchema>;
export type CapabilityState = z.infer<typeof capabilityStateSchema>;
export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;
export type CapabilityEvidence = z.infer<typeof capabilityEvidenceSchema>;
export type ProviderCapabilityRecord = z.infer<typeof providerCapabilityRecordSchema>;
export type ProviderCapabilitySnapshot = z.infer<typeof providerCapabilitySnapshotSchema>;
