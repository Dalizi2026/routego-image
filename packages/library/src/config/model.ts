import {
  identifierSchema,
  providerCapabilityRecordSchema,
  providerEndpointSetSchema,
  routegoDefaultsSchema,
  timestampSchema,
  type ProviderCapabilityRecord,
  type ProviderEndpointSet,
  type ReadSettingsResult
} from "@routego-image/contracts";

import { LibraryError } from "../errors";

export const CONFIG_SCHEMA_VERSION = 1 as const;
export const CREDENTIALS_SCHEMA_VERSION = 1 as const;

export type RoutegoDefaults = ReadSettingsResult["defaults"];

export const DEFAULT_ROUTEGO_DEFAULTS: RoutegoDefaults = routegoDefaultsSchema.parse({
  size: "auto",
  aspectRatio: "auto",
  quality: "auto",
  format: "png",
  count: 1,
  partialImages: 0,
  transparentMode: "off",
  moderation: "auto",
  saveToLibrary: true
});

export type StoredOutputDirectory =
  | { readonly mode: "default" }
  | { readonly mode: "clear" }
  | { readonly mode: "custom"; readonly path: string };

export interface StoredProviderProfile {
  readonly id: string;
  readonly name: string;
  readonly endpoints: ProviderEndpointSet;
  readonly defaultModel?: string;
  readonly models: readonly string[];
  readonly modelsRefreshedAt?: string;
  readonly capabilities: readonly ProviderCapabilityRecord[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConfigDocument {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly activeProviderId?: string;
  readonly profiles: readonly StoredProviderProfile[];
  readonly defaults: RoutegoDefaults;
  readonly outputDirectory: StoredOutputDirectory;
}

export interface CredentialsDocument {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly apiKeys: Readonly<Record<string, string>>;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LibraryError("config_corrupt", `${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedSet.has(key))) {
    throw new LibraryError("config_corrupt", `${label} contains unsupported fields.`);
  }
}

function parseRevision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new LibraryError("config_corrupt", `${label} revision is invalid.`);
  }
  return value as number;
}

function parseOptionalModel(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "" || value.length > 200) {
    throw new LibraryError("config_corrupt", `${label} is invalid.`);
  }
  return value.trim();
}

function parseModels(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 500) {
    throw new LibraryError("config_corrupt", "Provider model cache is invalid.");
  }
  const models = value.map((item) => {
    if (typeof item !== "string" || item.trim() === "" || item.length > 200) {
      throw new LibraryError("config_corrupt", "Provider model cache is invalid.");
    }
    return item.trim();
  });
  if (new Set(models).size !== models.length) {
    throw new LibraryError("config_corrupt", "Provider model cache contains duplicates.");
  }
  return models;
}

function parseTimestamp(value: unknown, label: string): string {
  try {
    return timestampSchema.parse(value);
  } catch {
    throw new LibraryError("config_corrupt", `${label} is invalid.`);
  }
}

function parseProviderProfile(value: unknown): StoredProviderProfile {
  const record = asRecord(value, "Provider profile");
  assertExactKeys(
    record,
    [
      "id",
      "name",
      "endpoints",
      "defaultModel",
      "models",
      "modelsRefreshedAt",
      "capabilities",
      "createdAt",
      "updatedAt"
    ],
    "Provider profile"
  );
  let id: string;
  let endpoints: ProviderEndpointSet;
  try {
    id = identifierSchema.parse(record["id"]);
    endpoints = providerEndpointSetSchema.parse(record["endpoints"]);
  } catch {
    throw new LibraryError("config_corrupt", "Provider profile identity or endpoints are invalid.");
  }
  if (
    typeof record["name"] !== "string" ||
    record["name"].trim() === "" ||
    record["name"].length > 200
  ) {
    throw new LibraryError("config_corrupt", "Provider profile name is invalid.");
  }
  const models = parseModels(record["models"]);
  if (!Array.isArray(record["capabilities"]) || record["capabilities"].length > 128) {
    throw new LibraryError("config_corrupt", "Provider capability cache is invalid.");
  }
  let capabilities: ProviderCapabilityRecord[];
  try {
    capabilities = record["capabilities"].map((item) =>
      providerCapabilityRecordSchema.parse(item)
    );
  } catch {
    throw new LibraryError("config_corrupt", "Provider capability cache is invalid.");
  }
  if (capabilities.some((item) => item.scope.providerId !== id)) {
    throw new LibraryError("config_corrupt", "Provider capability cache has a mismatched owner.");
  }
  const capabilityKeys = capabilities.map(capabilityRecordKey);
  if (new Set(capabilityKeys).size !== capabilityKeys.length) {
    throw new LibraryError("config_corrupt", "Provider capability cache contains duplicates.");
  }
  const defaultModel = parseOptionalModel(record["defaultModel"], "Provider default model");
  const modelsRefreshedAt =
    record["modelsRefreshedAt"] === undefined
      ? undefined
      : parseTimestamp(record["modelsRefreshedAt"], "Model refresh time");
  const createdAt = parseTimestamp(record["createdAt"], "Provider creation time");
  const updatedAt = parseTimestamp(record["updatedAt"], "Provider update time");
  if (Date.parse(createdAt) > Date.parse(updatedAt)) {
    throw new LibraryError("config_corrupt", "Provider timestamps are inconsistent.");
  }
  return {
    id,
    name: record["name"].trim(),
    endpoints,
    ...(defaultModel === undefined ? {} : { defaultModel }),
    models,
    ...(modelsRefreshedAt === undefined ? {} : { modelsRefreshedAt }),
    capabilities,
    createdAt,
    updatedAt
  };
}

function parseOutputDirectory(value: unknown): StoredOutputDirectory {
  const record = asRecord(value, "Output-directory state");
  assertExactKeys(record, ["mode", "path"], "Output-directory state");
  if (record["mode"] === "default" || record["mode"] === "clear") {
    if (record["path"] !== undefined) {
      throw new LibraryError("config_corrupt", "Output-directory state is invalid.");
    }
    return { mode: record["mode"] };
  }
  if (
    record["mode"] !== "custom" ||
    typeof record["path"] !== "string" ||
    record["path"] === "" ||
    record["path"].includes("\0")
  ) {
    throw new LibraryError("config_corrupt", "Output-directory state is invalid.");
  }
  return { mode: "custom", path: record["path"] };
}

function detectUnsupportedVersion(record: Record<string, unknown>, label: string): void {
  if (
    typeof record["schemaVersion"] === "number" &&
    record["schemaVersion"] !== CONFIG_SCHEMA_VERSION
  ) {
    throw new LibraryError("unsupported_version", `${label} uses an unsupported version.`);
  }
}

export function parseConfigDocument(value: unknown): ConfigDocument {
  const record = asRecord(value, "Configuration document");
  detectUnsupportedVersion(record, "Configuration document");
  assertExactKeys(
    record,
    ["schemaVersion", "revision", "activeProviderId", "profiles", "defaults", "outputDirectory"],
    "Configuration document"
  );
  if (record["schemaVersion"] !== CONFIG_SCHEMA_VERSION || !Array.isArray(record["profiles"])) {
    throw new LibraryError("config_corrupt", "Configuration document fields are invalid.");
  }
  if (record["profiles"].length > 100) {
    throw new LibraryError("config_corrupt", "Configuration profiles are invalid.");
  }
  const profiles = record["profiles"].map(parseProviderProfile);
  if (new Set(profiles.map((item) => item.id)).size !== profiles.length) {
    throw new LibraryError("config_corrupt", "Configuration profiles are invalid.");
  }
  let activeProviderId: string | undefined;
  if (record["activeProviderId"] !== undefined) {
    try {
      activeProviderId = identifierSchema.parse(record["activeProviderId"]);
    } catch {
      throw new LibraryError("config_corrupt", "Active provider identity is invalid.");
    }
    if (!profiles.some((profile) => profile.id === activeProviderId)) {
      throw new LibraryError("config_corrupt", "Active provider does not exist.");
    }
  }
  let defaults: RoutegoDefaults;
  try {
    defaults = routegoDefaultsSchema.parse(record["defaults"]);
  } catch {
    throw new LibraryError("config_corrupt", "Generation defaults are invalid.");
  }
  return {
    schemaVersion: 1,
    revision: parseRevision(record["revision"], "Configuration"),
    ...(activeProviderId === undefined ? {} : { activeProviderId }),
    profiles,
    defaults,
    outputDirectory: parseOutputDirectory(record["outputDirectory"])
  };
}

export function parseCredentialsDocument(value: unknown): CredentialsDocument {
  const record = asRecord(value, "Credential document");
  if (
    typeof record["schemaVersion"] === "number" &&
    record["schemaVersion"] !== CREDENTIALS_SCHEMA_VERSION
  ) {
    throw new LibraryError("unsupported_version", "Credential document uses an unsupported version.");
  }
  assertExactKeys(record, ["schemaVersion", "revision", "apiKeys"], "Credential document");
  const keys = asRecord(record["apiKeys"], "Credential key map");
  if (Object.keys(keys).length > 100) {
    throw new LibraryError("config_corrupt", "Credential key map is invalid.");
  }
  const apiKeys: Record<string, string> = {};
  for (const [profileId, apiKey] of Object.entries(keys)) {
    try {
      identifierSchema.parse(profileId);
    } catch {
      throw new LibraryError("config_corrupt", "Credential profile identity is invalid.");
    }
    if (
      typeof apiKey !== "string" ||
      apiKey.length < 1 ||
      apiKey.length > 8_192 ||
      apiKey.trim() === "" ||
      apiKey.includes("\0")
    ) {
      throw new LibraryError("config_corrupt", "Stored credential value is invalid.");
    }
    apiKeys[profileId] = apiKey;
  }
  if (record["schemaVersion"] !== CREDENTIALS_SCHEMA_VERSION) {
    throw new LibraryError("config_corrupt", "Credential document fields are invalid.");
  }
  return {
    schemaVersion: 1,
    revision: parseRevision(record["revision"], "Credential document"),
    apiKeys
  };
}

export function createEmptyConfigDocument(): ConfigDocument {
  return {
    schemaVersion: 1,
    revision: 0,
    profiles: [],
    defaults: DEFAULT_ROUTEGO_DEFAULTS,
    outputDirectory: { mode: "default" }
  };
}

export function createEmptyCredentialsDocument(): CredentialsDocument {
  return { schemaVersion: 1, revision: 0, apiKeys: {} };
}

export function validateConfigurationPair(
  config: ConfigDocument,
  credentials: CredentialsDocument
): void {
  const profileIds = new Set(config.profiles.map((profile) => profile.id));
  if (Object.keys(credentials.apiKeys).some((profileId) => !profileIds.has(profileId))) {
    throw new LibraryError("config_corrupt", "Credential document contains an orphaned profile.");
  }
}

export function capabilityRecordKey(record: ProviderCapabilityRecord): string {
  return [
    record.capability,
    record.scope.providerId,
    record.scope.model,
    record.scope.endpointFingerprint,
    record.scope.transport,
    record.scope.requestShape
  ].join("\0");
}
