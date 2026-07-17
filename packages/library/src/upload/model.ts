import {
  identifierSchema,
  finalizedUploadMetadataSchema,
  timestampSchema,
  uploadMimeTypeSchema,
  uploadResourcePurposeSchema,
  uploadResourceStatusSchema,
  uploadReusePolicySchema,
  uploadServiceErrorSchema,
  type UploadMimeType,
  type UploadResourceDescriptor,
  type UploadResourcePurpose,
  type UploadResourceStatus,
  type UploadReusePolicy,
  type UploadServiceError
} from "@routego-image/contracts";

import { LibraryError } from "../errors";

export const UPLOAD_REGISTRY_SCHEMA_VERSION = 1 as const;

export type FinalizedUploadMetadata = NonNullable<UploadResourceDescriptor["finalized"]>;

export interface StagedUploadMetadata {
  readonly byteLength: number;
  readonly sha256: string;
  readonly uploadedAt: string;
}

export interface StoredUploadRecord {
  readonly uploadResourceId: string;
  readonly purpose: UploadResourcePurpose;
  readonly status: UploadResourceStatus;
  readonly reusePolicy: UploadReusePolicy;
  readonly relativePath: string;
  readonly declaredMimeType: UploadMimeType;
  readonly declaredByteLength: number;
  readonly expectedSha256?: string;
  readonly maxBytes: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly staged?: StagedUploadMetadata;
  readonly finalized?: FinalizedUploadMetadata;
  readonly consumedAt?: string;
  readonly discardedAt?: string;
  readonly error?: UploadServiceError;
}

export interface UploadRegistryDocument {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly uploads: readonly StoredUploadRecord[];
}

function allowedMimeTypes(purpose: UploadResourcePurpose): readonly UploadMimeType[] {
  if (purpose === "zip-import") return ["application/zip"];
  if (purpose === "mask") return ["image/png"];
  return ["image/png", "image/jpeg", "image/webp"];
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
  const set = new Set(allowed);
  if (Object.keys(record).some((key) => !set.has(key))) {
    throw new LibraryError("config_corrupt", `${label} contains unsupported fields.`);
  }
}

function parseTimestamp(value: unknown, label: string): string {
  try {
    return timestampSchema.parse(value);
  } catch {
    throw new LibraryError("config_corrupt", `${label} is invalid.`);
  }
}

function parsePositiveSize(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new LibraryError("config_corrupt", `${label} is invalid.`);
  }
  return value as number;
}

function parseSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new LibraryError("config_corrupt", `${label} is invalid.`);
  }
  return value;
}

function parseStaged(value: unknown): StagedUploadMetadata {
  const record = asRecord(value, "Staged upload metadata");
  assertExactKeys(record, ["byteLength", "sha256", "uploadedAt"], "Staged upload metadata");
  return {
    byteLength: parsePositiveSize(record["byteLength"], "Staged byte length"),
    sha256: parseSha256(record["sha256"], "Staged checksum"),
    uploadedAt: parseTimestamp(record["uploadedAt"], "Upload completion time")
  };
}

function parseFinalized(value: unknown): FinalizedUploadMetadata {
  try {
    return finalizedUploadMetadataSchema.parse(value);
  } catch {
    throw new LibraryError("config_corrupt", "Finalized upload metadata is invalid.");
  }
}

function parseUploadRecord(value: unknown): StoredUploadRecord {
  const record = asRecord(value, "Upload registry record");
  assertExactKeys(
    record,
    [
      "uploadResourceId",
      "purpose",
      "status",
      "reusePolicy",
      "relativePath",
      "declaredMimeType",
      "declaredByteLength",
      "expectedSha256",
      "maxBytes",
      "createdAt",
      "expiresAt",
      "staged",
      "finalized",
      "consumedAt",
      "discardedAt",
      "error"
    ],
    "Upload registry record"
  );
  let uploadResourceId: string;
  let purpose: UploadResourcePurpose;
  let status: UploadResourceStatus;
  let reusePolicy: UploadReusePolicy;
  let declaredMimeType: UploadMimeType;
  try {
    uploadResourceId = identifierSchema.parse(record["uploadResourceId"]);
    purpose = uploadResourcePurposeSchema.parse(record["purpose"]);
    status = uploadResourceStatusSchema.parse(record["status"]);
    reusePolicy = uploadReusePolicySchema.parse(record["reusePolicy"]);
    declaredMimeType = uploadMimeTypeSchema.parse(record["declaredMimeType"]);
  } catch {
    throw new LibraryError("config_corrupt", "Upload registry identity or policy is invalid.");
  }
  const expectedReusePolicy = purpose === "zip-import" ? "single-consume" : "reusable-until-expiry";
  if (reusePolicy !== expectedReusePolicy) {
    throw new LibraryError("config_corrupt", "Upload reuse policy is invalid.");
  }
  if (
    typeof record["relativePath"] !== "string" ||
    record["relativePath"] !== `objects/${uploadResourceId}.bin`
  ) {
    throw new LibraryError("config_corrupt", "Upload staging path is invalid.");
  }
  const declaredByteLength = parsePositiveSize(
    record["declaredByteLength"],
    "Declared upload length"
  );
  const maxBytes = parsePositiveSize(record["maxBytes"], "Upload maximum length");
  if (declaredByteLength > maxBytes) {
    throw new LibraryError("config_corrupt", "Upload declaration exceeds its stored policy.");
  }
  const staged = record["staged"] === undefined ? undefined : parseStaged(record["staged"]);
  const finalized =
    record["finalized"] === undefined ? undefined : parseFinalized(record["finalized"]);
  let error: UploadServiceError | undefined;
  if (record["error"] !== undefined) {
    try {
      error = uploadServiceErrorSchema.parse(record["error"]);
    } catch {
      throw new LibraryError("config_corrupt", "Upload failure metadata is invalid.");
    }
  }
  if ((status === "uploaded" || status === "finalized" || status === "consumed") !== (staged !== undefined)) {
    throw new LibraryError("config_corrupt", "Upload staged metadata does not match its state.");
  }
  if ((status === "finalized" || status === "consumed") !== (finalized !== undefined)) {
    throw new LibraryError("config_corrupt", "Upload finalized metadata does not match its state.");
  }
  if ((status === "failed") !== (error !== undefined)) {
    throw new LibraryError("config_corrupt", "Upload error metadata does not match its state.");
  }
  if ((status === "consumed") !== (record["consumedAt"] !== undefined)) {
    throw new LibraryError("config_corrupt", "Upload consumption metadata does not match its state.");
  }
  if ((status === "discarded") !== (record["discardedAt"] !== undefined)) {
    throw new LibraryError("config_corrupt", "Upload discard metadata does not match its state.");
  }
  const createdAt = parseTimestamp(record["createdAt"], "Upload creation time");
  const expiresAt = parseTimestamp(record["expiresAt"], "Upload expiry time");
  if (Date.parse(createdAt) >= Date.parse(expiresAt)) {
    throw new LibraryError("config_corrupt", "Upload expiry is invalid.");
  }
  if (!allowedMimeTypes(purpose).includes(declaredMimeType)) {
    throw new LibraryError("config_corrupt", "Declared upload MIME is invalid for its purpose.");
  }
  if (
    staged &&
    (staged.byteLength > maxBytes ||
      Date.parse(staged.uploadedAt) < Date.parse(createdAt) ||
      Date.parse(staged.uploadedAt) > Date.parse(expiresAt))
  ) {
    throw new LibraryError("config_corrupt", "Upload staged metadata violates its policy.");
  }
  if (
    finalized &&
    (!staged ||
      finalized.byteLength !== declaredByteLength ||
      finalized.byteLength !== staged.byteLength ||
      finalized.sha256 !== staged.sha256 ||
      (record["expectedSha256"] !== undefined &&
        finalized.sha256 !== record["expectedSha256"]) ||
      finalized.detectedMimeType !== declaredMimeType ||
      !allowedMimeTypes(purpose).includes(finalized.detectedMimeType) ||
      Date.parse(finalized.finalizedAt) < Date.parse(staged.uploadedAt) ||
      Date.parse(finalized.finalizedAt) > Date.parse(expiresAt))
  ) {
    throw new LibraryError("config_corrupt", "Upload finalization metadata violates its policy.");
  }
  if (
    finalized &&
    ((finalized.detectedMimeType.startsWith("image/") &&
      (finalized.width === undefined || finalized.height === undefined)) ||
      (finalized.detectedMimeType === "application/zip" &&
        (finalized.width !== undefined || finalized.height !== undefined)))
  ) {
    throw new LibraryError("config_corrupt", "Upload dimensions do not match the detected type.");
  }
  if (status === "consumed" && purpose !== "zip-import") {
    throw new LibraryError("config_corrupt", "Only ZIP uploads can be consumed.");
  }
  const consumedAt =
    record["consumedAt"] === undefined
      ? undefined
      : parseTimestamp(record["consumedAt"], "Upload consumption time");
  const discardedAt =
    record["discardedAt"] === undefined
      ? undefined
      : parseTimestamp(record["discardedAt"], "Upload discard time");
  if (
    [consumedAt, discardedAt].some(
      (value) =>
        value !== undefined &&
        (Date.parse(value) < Date.parse(createdAt) || Date.parse(value) > Date.parse(expiresAt))
    )
  ) {
    throw new LibraryError("config_corrupt", "Upload lifecycle timestamp is invalid.");
  }
  return {
    uploadResourceId,
    purpose,
    status,
    reusePolicy,
    relativePath: record["relativePath"],
    declaredMimeType,
    declaredByteLength,
    ...(record["expectedSha256"] === undefined
      ? {}
      : { expectedSha256: parseSha256(record["expectedSha256"], "Expected upload checksum") }),
    maxBytes,
    createdAt,
    expiresAt,
    ...(staged === undefined ? {} : { staged }),
    ...(finalized === undefined ? {} : { finalized }),
    ...(consumedAt === undefined ? {} : { consumedAt }),
    ...(discardedAt === undefined ? {} : { discardedAt }),
    ...(error === undefined ? {} : { error })
  };
}

export function parseUploadRegistryDocument(value: unknown): UploadRegistryDocument {
  const record = asRecord(value, "Upload registry");
  if (typeof record["schemaVersion"] === "number" && record["schemaVersion"] !== 1) {
    throw new LibraryError("unsupported_version", "Upload registry uses an unsupported version.");
  }
  assertExactKeys(record, ["schemaVersion", "revision", "uploads"], "Upload registry");
  if (
    record["schemaVersion"] !== 1 ||
    !Number.isSafeInteger(record["revision"]) ||
    (record["revision"] as number) < 0 ||
    !Array.isArray(record["uploads"]) ||
    record["uploads"].length > 10_000
  ) {
    throw new LibraryError("config_corrupt", "Upload registry fields are invalid.");
  }
  const uploads = record["uploads"].map(parseUploadRecord);
  if (new Set(uploads.map((item) => item.uploadResourceId)).size !== uploads.length) {
    throw new LibraryError("config_corrupt", "Upload registry contains duplicate resources.");
  }
  return { schemaVersion: 1, revision: record["revision"] as number, uploads };
}

export function createEmptyUploadRegistry(): UploadRegistryDocument {
  return { schemaVersion: 1, revision: 0, uploads: [] };
}
