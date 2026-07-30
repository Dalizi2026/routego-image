import { createHash } from "node:crypto";

import {
  identifierSchema,
  libraryAssetRenditionPhaseSchema,
  MAX_LIBRARY_ASSET_RENDITIONS,
  libraryAssetRelationshipSchema,
  libraryAssetStatusSchema,
  libraryFolderStateSchema,
  libraryOperationParametersSchema,
  operationExecutionMetadataSchema,
  routegoServiceErrorSchema,
  timestampSchema,
  type LibraryAssetDetail,
  type LibraryOperationParameters,
  type OperationExecutionMetadata,
  type RoutegoServiceError
} from "@routego-image/contracts";

import { LibraryError } from "../errors";

export const IMAGE_LIBRARY_SCHEMA_VERSION = 2 as const;

export type LibraryAssetStatus = LibraryAssetDetail["status"];
export type LibraryImageMimeType = LibraryAssetDetail["mimeType"];
export type LibraryRelationship = LibraryAssetDetail["relationships"][number];

export interface StoredImageBlob {
  readonly sha256: string;
  readonly relativePath: string;
  readonly mimeType: LibraryImageMimeType;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly createdAt: string;
}

export interface StoredAssetRendition {
  readonly artifactId: string;
  readonly phase: "source" | "partial" | "final";
  readonly blobSha256: string;
  readonly createdAt: string;
}

export interface StoredLibraryFolder {
  readonly id: string;
  readonly name: string;
  readonly normalizedName: string;
  readonly order: number;
  readonly state: "active" | "deleted";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt?: string;
}

export interface StoredLibraryAsset {
  readonly id: string;
  /** A user-controlled label. It never changes the original operation metadata. */
  readonly displayName?: string;
  readonly prompt: string;
  readonly model: string;
  /** The saved provider profile that produced this asset, when available. */
  readonly providerId?: string;
  readonly kind: "generate" | "edit";
  readonly status: LibraryAssetStatus;
  readonly primaryArtifactId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly requestedParams: LibraryOperationParameters;
  readonly effectiveParams: LibraryOperationParameters;
  readonly execution: OperationExecutionMetadata;
  readonly error?: RoutegoServiceError;
  readonly renditions: readonly StoredAssetRendition[];
  readonly relationships: readonly LibraryRelationship[];
  readonly folderIds: readonly string[];
}

export interface ImageLibraryIndex {
  readonly schemaVersion: 2;
  readonly revision: number;
  readonly blobs: readonly StoredImageBlob[];
  readonly assets: readonly StoredLibraryAsset[];
  readonly folders: readonly StoredLibraryFolder[];
  /** The sole selected active generation record, when one has been marked. */
  readonly currentMarkRecordId?: string;
}

/**
 * The last on-disk Library format that can contain Trash and edit records.
 * It is deliberately separate from `ImageLibraryIndex`: normal Library reads
 * continue to reject it until a later, confirmation-bound migration promotes
 * a verified replacement index.
 */
export interface LegacyImageLibraryIndex {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly blobs: readonly StoredImageBlob[];
  readonly assets: readonly LegacyStoredLibraryAsset[];
  readonly folders: readonly StoredLibraryFolder[];
}

/**
 * The small, safe projection needed to plan removal of a v1 record. Legacy
 * operation parameters are intentionally opaque: current generation-only
 * contracts must not validate or revive removed edit inputs during preflight.
 */
export interface LegacyStoredLibraryAsset {
  readonly id: string;
  readonly kind: "generate" | "edit";
  readonly status: LibraryAssetStatus;
  readonly renditions: readonly StoredAssetRendition[];
  readonly relationships: readonly LegacyLibraryRelationship[];
}

export interface LegacyLibraryRelationship {
  readonly id: string;
  readonly role: string;
  readonly relatedAssetId: string;
  readonly artifactId?: string;
  readonly order: number;
}

export interface LegacyLibraryUpgradePlan {
  readonly fingerprint: string;
  readonly assetCount: number;
  readonly index: ImageLibraryIndex;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LibraryError("config_corrupt", `${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function exact(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
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

function parseId(value: unknown, label: string): string {
  try {
    return identifierSchema.parse(value);
  } catch {
    throw new LibraryError("config_corrupt", `${label} is invalid.`);
  }
}

function parseSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new LibraryError("config_corrupt", `${label} is invalid.`);
  }
  return value;
}

function parsePositiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new LibraryError("config_corrupt", `${label} is invalid.`);
  }
  return value as number;
}

function parseNonNegativeInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new LibraryError("config_corrupt", `${label} is invalid.`);
  }
  return value as number;
}

function mimeExtension(mimeType: LibraryImageMimeType): string {
  return mimeType === "image/png" ? ".png" : mimeType === "image/jpeg" ? ".jpg" : ".webp";
}

function parseBlob(value: unknown): StoredImageBlob {
  const record = asRecord(value, "Library blob");
  exact(
    record,
    ["sha256", "relativePath", "mimeType", "byteLength", "width", "height", "createdAt"],
    "Library blob"
  );
  const sha256 = parseSha(record["sha256"], "Library blob checksum");
  const mimeType = record["mimeType"];
  if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp") {
    throw new LibraryError("config_corrupt", "Library blob MIME type is invalid.");
  }
  if (
    typeof record["relativePath"] !== "string" ||
    record["relativePath"].includes("\0") ||
    record["relativePath"].includes("\\") ||
    record["relativePath"].split("/").includes("..") ||
    !/^blobs\/\d{4}\/(?:0[1-9]|1[0-2])\/[^/]+$/u.test(record["relativePath"]) ||
    !record["relativePath"].toLowerCase().endsWith(mimeExtension(mimeType))
  ) {
    throw new LibraryError("config_corrupt", "Library blob path is invalid.");
  }
  return {
    sha256,
    relativePath: record["relativePath"],
    mimeType,
    byteLength: parsePositiveInteger(record["byteLength"], "Library blob length"),
    width: parsePositiveInteger(record["width"], "Library blob width", 65_535),
    height: parsePositiveInteger(record["height"], "Library blob height", 65_535),
    createdAt: parseTimestamp(record["createdAt"], "Library blob creation time")
  };
}

function parseRendition(value: unknown): StoredAssetRendition {
  const record = asRecord(value, "Asset rendition");
  exact(record, ["artifactId", "phase", "blobSha256", "createdAt"], "Asset rendition");
  let phase: StoredAssetRendition["phase"];
  try {
    phase = libraryAssetRenditionPhaseSchema.parse(record["phase"]);
  } catch {
    throw new LibraryError("config_corrupt", "Asset rendition phase is invalid.");
  }
  return {
    artifactId: parseId(record["artifactId"], "Artifact identity"),
    phase,
    blobSha256: parseSha(record["blobSha256"], "Rendition blob checksum"),
    createdAt: parseTimestamp(record["createdAt"], "Rendition creation time")
  };
}

export function normalizeFolderName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
}

function parseFolder(value: unknown): StoredLibraryFolder {
  const record = asRecord(value, "Library folder");
  exact(
    record,
    ["id", "name", "normalizedName", "order", "state", "createdAt", "updatedAt", "deletedAt"],
    "Library folder"
  );
  if (typeof record["name"] !== "string" || record["name"].trim() === "" || record["name"].length > 200) {
    throw new LibraryError("config_corrupt", "Library folder name is invalid.");
  }
  const name = record["name"].trim();
  if (record["normalizedName"] !== normalizeFolderName(name)) {
    throw new LibraryError("config_corrupt", "Library folder normalized name is invalid.");
  }
  let state: "active" | "deleted";
  try {
    state = libraryFolderStateSchema.parse(record["state"]);
  } catch {
    throw new LibraryError("config_corrupt", "Library folder state is invalid.");
  }
  const deletedAt =
    record["deletedAt"] === undefined
      ? undefined
      : parseTimestamp(record["deletedAt"], "Folder deletion time");
  if ((state === "deleted") !== (deletedAt !== undefined)) {
    throw new LibraryError("config_corrupt", "Library folder deletion metadata is invalid.");
  }
  const createdAt = parseTimestamp(record["createdAt"], "Folder creation time");
  const updatedAt = parseTimestamp(record["updatedAt"], "Folder update time");
  if (Date.parse(createdAt) > Date.parse(updatedAt)) {
    throw new LibraryError("config_corrupt", "Library folder timestamps are inconsistent.");
  }
  return {
    id: parseId(record["id"], "Folder identity"),
    name,
    normalizedName: record["normalizedName"],
    order: parseNonNegativeInteger(record["order"], "Folder order", 100_000),
    state,
    createdAt,
    updatedAt,
    ...(deletedAt === undefined ? {} : { deletedAt })
  };
}

function parseAsset(value: unknown): StoredLibraryAsset {
  const record = asRecord(value, "Library asset");
  exact(
    record,
    [
      "id",
      "displayName",
      "prompt",
      "model",
      "providerId",
      "kind",
      "status",
      "primaryArtifactId",
      "createdAt",
      "updatedAt",
      "requestedParams",
      "effectiveParams",
      "execution",
      "error",
      "renditions",
      "relationships",
      "folderIds"
    ],
    "Library asset"
  );
  if (typeof record["prompt"] !== "string" || record["prompt"].length > 32_000) {
    throw new LibraryError("config_corrupt", "Library asset prompt is invalid.");
  }
  const displayName = record["displayName"];
  if (
    displayName !== undefined &&
    (typeof displayName !== "string" || displayName.trim().length < 1 || displayName.trim().length > 200)
  ) {
    throw new LibraryError("config_corrupt", "Library asset display name is invalid.");
  }
  if (typeof record["model"] !== "string" || record["model"].trim() === "" || record["model"].length > 200) {
    throw new LibraryError("config_corrupt", "Library asset model is invalid.");
  }
  const providerId = record["providerId"] === undefined
    ? undefined
    : parseId(record["providerId"], "Library asset provider identity");
  let status: LibraryAssetStatus;
  let requestedParams: LibraryOperationParameters;
  let effectiveParams: LibraryOperationParameters;
  let execution: OperationExecutionMetadata;
  try {
    status = libraryAssetStatusSchema.parse(record["status"]);
    requestedParams = libraryOperationParametersSchema.parse(record["requestedParams"]);
    effectiveParams = libraryOperationParametersSchema.parse(record["effectiveParams"]);
    execution = operationExecutionMetadataSchema.parse(record["execution"]);
  } catch {
    throw new LibraryError("config_corrupt", "Library asset operation metadata is invalid.");
  }
  if (
    record["kind"] !== requestedParams.kind ||
    record["kind"] !== effectiveParams.kind
  ) {
    throw new LibraryError(
      "config_corrupt",
      "Library asset operation kinds must match their requested and effective parameters."
    );
  }
  if (status === "deleted") {
    throw new LibraryError("config_corrupt", "Current Library indexes cannot contain Trash records.");
  }
  if (
    !Array.isArray(record["renditions"]) ||
    record["renditions"].length < 1 ||
    record["renditions"].length > MAX_LIBRARY_ASSET_RENDITIONS
  ) {
    throw new LibraryError("config_corrupt", "Library asset renditions are invalid.");
  }
  const renditions = record["renditions"].map(parseRendition);
  const primaryArtifactId = parseId(record["primaryArtifactId"], "Primary artifact identity");
  const primaryRendition = renditions.find((item) => item.artifactId === primaryArtifactId);
  if (!primaryRendition) {
    throw new LibraryError("config_corrupt", "Primary artifact is missing from the asset renditions.");
  }
  if (primaryRendition.phase === "source") {
    throw new LibraryError("config_corrupt", "Primary Library artifacts must be output renditions.");
  }
  if (
    status === "succeeded" &&
    (primaryRendition.phase !== "final" || !renditions.some((item) => item.phase === "final"))
  ) {
    throw new LibraryError("config_corrupt", "Succeeded Library assets require a final primary rendition.");
  }
  if (!Array.isArray(record["relationships"]) || record["relationships"].length > 128) {
    throw new LibraryError("config_corrupt", "Library asset relationships are invalid.");
  }
  let relationships: LibraryRelationship[];
  try {
    relationships = record["relationships"].map((item) => libraryAssetRelationshipSchema.parse(item));
  } catch {
    throw new LibraryError("config_corrupt", "Library asset relationships are invalid.");
  }
  const assetId = parseId(record["id"], "Asset identity");
  for (const relationship of relationships) {
    if (relationship.role !== "output") continue;
    if (relationship.relatedAssetId !== assetId || relationship.artifactId === undefined) {
      throw new LibraryError("config_corrupt", "Library output relationships must identify exact local artifacts.");
    }
    const outputRendition = renditions.find(
      (rendition) => rendition.artifactId === relationship.artifactId
    );
    if (!outputRendition || outputRendition.phase === "source") {
      throw new LibraryError("config_corrupt", "Library output relationships must reference output renditions.");
    }
  }
  if (!Array.isArray(record["folderIds"]) || record["folderIds"].length > 100) {
    throw new LibraryError("config_corrupt", "Library folder memberships are invalid.");
  }
  const folderIds = record["folderIds"].map((item) => parseId(item, "Folder membership"));
  let error: RoutegoServiceError | undefined;
  if (record["error"] !== undefined) {
    try {
      error = routegoServiceErrorSchema.parse(record["error"]);
    } catch {
      throw new LibraryError("config_corrupt", "Library asset error metadata is invalid.");
    }
  }
  if (status === "failed" && error === undefined) {
    throw new LibraryError("config_corrupt", "Failed Library assets require an error.");
  }
  const createdAt = parseTimestamp(record["createdAt"], "Asset creation time");
  const updatedAt = parseTimestamp(record["updatedAt"], "Asset update time");
  if (Date.parse(createdAt) > Date.parse(updatedAt)) {
    throw new LibraryError("config_corrupt", "Library asset timestamps are inconsistent.");
  }
  if (
    renditions.some(
      (rendition) =>
        Date.parse(rendition.createdAt) < Date.parse(createdAt) ||
        Date.parse(rendition.createdAt) > Date.parse(updatedAt)
    )
  ) {
    throw new LibraryError("config_corrupt", "Library rendition timestamps are inconsistent.");
  }
  return {
    id: assetId,
    ...(displayName === undefined ? {} : { displayName: displayName.trim() }),
    prompt: record["prompt"],
    model: record["model"].trim(),
    ...(providerId === undefined ? {} : { providerId }),
    kind: requestedParams.kind,
    status,
    primaryArtifactId,
    createdAt,
    updatedAt,
    requestedParams,
    effectiveParams,
    execution,
    ...(error === undefined ? {} : { error }),
    renditions,
    relationships,
    folderIds
  };
}

interface ParsedLibraryIndex {
  readonly revision: number;
  readonly blobs: readonly StoredImageBlob[];
  readonly assets: readonly StoredLibraryAsset[];
  readonly folders: readonly StoredLibraryFolder[];
  readonly currentMarkRecordId?: string;
}

function parseVersionedImageLibraryIndex(
  value: unknown,
  schemaVersion: 1 | 2
): ParsedLibraryIndex {
  const record = asRecord(value, "Image Library index");
  if (typeof record["schemaVersion"] === "number" && record["schemaVersion"] !== schemaVersion) {
    throw new LibraryError("unsupported_version", "Image Library index uses an unsupported version.");
  }
  exact(
    record,
    schemaVersion === IMAGE_LIBRARY_SCHEMA_VERSION
      ? ["schemaVersion", "revision", "blobs", "assets", "folders", "currentMarkRecordId"]
      : ["schemaVersion", "revision", "blobs", "assets", "folders"],
    "Image Library index"
  );
  if (
    record["schemaVersion"] !== schemaVersion ||
    !Number.isSafeInteger(record["revision"]) ||
    (record["revision"] as number) < 0 ||
    !Array.isArray(record["blobs"]) ||
    !Array.isArray(record["assets"]) ||
    !Array.isArray(record["folders"]) ||
    record["blobs"].length > 100_000 ||
    record["assets"].length > 100_000 ||
    record["folders"].length > 1_000
  ) {
    throw new LibraryError("config_corrupt", "Image Library index fields are invalid.");
  }
  const blobs = record["blobs"].map(parseBlob);
  const assets = record["assets"].map(parseAsset);
  const folders = record["folders"].map(parseFolder);
  const unique = (values: readonly string[], label: string): void => {
    if (new Set(values).size !== values.length) {
      throw new LibraryError("config_corrupt", `${label} contains duplicates.`);
    }
  };
  unique(blobs.map((item) => item.sha256), "Library blob checksums");
  unique(blobs.map((item) => item.relativePath.toLocaleLowerCase("und")), "Library blob paths");
  unique(assets.map((item) => item.id), "Library asset identities");
  unique(folders.map((item) => item.id), "Library folder identities");
  unique(
    folders.filter((item) => item.state === "active").map((item) => item.normalizedName),
    "Active Library folder names"
  );
  const blobIds = new Set(blobs.map((item) => item.sha256));
  const assetIds = new Set(assets.map((item) => item.id));
  const folderIds = new Set(folders.map((item) => item.id));
  const artifacts = new Map<string, string>();
  for (const asset of assets) {
    unique(asset.renditions.map((item) => item.artifactId), `Asset ${asset.id} artifacts`);
    unique(asset.relationships.map((item) => item.id), `Asset ${asset.id} relationships`);
    unique(asset.folderIds, `Asset ${asset.id} folders`);
    for (const rendition of asset.renditions) {
      if (!blobIds.has(rendition.blobSha256) || artifacts.has(rendition.artifactId)) {
        throw new LibraryError("config_corrupt", "Library rendition ownership is invalid.");
      }
      artifacts.set(rendition.artifactId, asset.id);
    }
    if (asset.folderIds.some((id) => !folderIds.has(id))) {
      throw new LibraryError("config_corrupt", "Library asset references a missing folder.");
    }
  }
  const referencedBlobIds = new Set(
    assets.flatMap((asset) => asset.renditions.map((rendition) => rendition.blobSha256))
  );
  if (blobs.some((blob) => !referencedBlobIds.has(blob.sha256))) {
    throw new LibraryError("config_corrupt", "Library index contains an unreferenced blob record.");
  }
  for (const asset of assets) {
    for (const relationship of asset.relationships) {
      if (!assetIds.has(relationship.relatedAssetId)) {
        throw new LibraryError("config_corrupt", "Library relationship references a missing asset.");
      }
      if (
        relationship.artifactId !== undefined &&
        artifacts.get(relationship.artifactId) !== relationship.relatedAssetId
      ) {
        throw new LibraryError("config_corrupt", "Library relationship artifact ownership is invalid.");
      }
    }
  }
  if (schemaVersion === IMAGE_LIBRARY_SCHEMA_VERSION) {
    const currentMarkRecordId =
      record["currentMarkRecordId"] === undefined
        ? undefined
        : parseId(record["currentMarkRecordId"], "Current mark record identity");
    if (currentMarkRecordId !== undefined) {
      const marked = assets.find((asset) => asset.id === currentMarkRecordId);
      if (!marked || marked.kind !== "generate") {
        throw new LibraryError("config_corrupt", "The current mark must reference an active generation record.");
      }
    }
    return {
      revision: record["revision"] as number,
      blobs,
      assets,
      folders,
      ...(currentMarkRecordId === undefined ? {} : { currentMarkRecordId })
    };
  }

  return {
    revision: record["revision"] as number,
    blobs,
    assets,
    folders
  };
}

export function parseImageLibraryIndex(value: unknown): ImageLibraryIndex {
  const parsed = parseVersionedImageLibraryIndex(value, IMAGE_LIBRARY_SCHEMA_VERSION);
  return {
    schemaVersion: IMAGE_LIBRARY_SCHEMA_VERSION,
    revision: parsed.revision,
    blobs: parsed.blobs,
    assets: parsed.assets,
    folders: parsed.folders,
    ...(parsed.currentMarkRecordId === undefined
      ? {}
      : { currentMarkRecordId: parsed.currentMarkRecordId })
  };
}

function parseLegacyRelationship(value: unknown): LegacyLibraryRelationship {
  const record = asRecord(value, "Legacy asset relationship");
  if (
    typeof record["role"] !== "string" ||
    record["role"].trim() === "" ||
    record["role"].length > 100 ||
    !Number.isSafeInteger(record["order"]) ||
    (record["order"] as number) < 0 ||
    (record["order"] as number) > 255
  ) {
    throw new LibraryError("config_corrupt", "Legacy asset relationship is invalid.");
  }
  const artifactId =
    record["artifactId"] === undefined
      ? undefined
      : parseId(record["artifactId"], "Legacy relationship artifact identity");
  return {
    id: parseId(record["id"], "Legacy relationship identity"),
    role: record["role"].trim(),
    relatedAssetId: parseId(record["relatedAssetId"], "Legacy relationship target identity"),
    ...(artifactId === undefined ? {} : { artifactId }),
    order: record["order"] as number
  };
}

function parseLegacyAsset(value: unknown): LegacyStoredLibraryAsset {
  const record = asRecord(value, "Legacy Library asset");
  if (record["kind"] !== "generate" && record["kind"] !== "edit") {
    throw new LibraryError("config_corrupt", "Legacy Library asset kind is invalid.");
  }
  let status: LibraryAssetStatus;
  try {
    status = libraryAssetStatusSchema.parse(record["status"]);
  } catch {
    throw new LibraryError("config_corrupt", "Legacy Library asset status is invalid.");
  }
  if (
    !Array.isArray(record["renditions"]) ||
    record["renditions"].length < 1 ||
    record["renditions"].length > MAX_LIBRARY_ASSET_RENDITIONS ||
    !Array.isArray(record["relationships"]) ||
    record["relationships"].length > 128
  ) {
    throw new LibraryError("config_corrupt", "Legacy Library asset graph is invalid.");
  }
  return {
    id: parseId(record["id"], "Legacy Library asset identity"),
    kind: record["kind"],
    status,
    renditions: record["renditions"].map(parseRendition),
    relationships: record["relationships"].map(parseLegacyRelationship)
  };
}

/** Parses a legacy index for a read-only migration preflight only. */
export function parseLegacyImageLibraryIndex(value: unknown): LegacyImageLibraryIndex {
  const record = asRecord(value, "Legacy Image Library index");
  exact(record, ["schemaVersion", "revision", "blobs", "assets", "folders"], "Legacy Image Library index");
  if (
    record["schemaVersion"] !== 1 ||
    !Number.isSafeInteger(record["revision"]) ||
    (record["revision"] as number) < 0 ||
    !Array.isArray(record["blobs"]) ||
    !Array.isArray(record["assets"]) ||
    !Array.isArray(record["folders"]) ||
    record["blobs"].length > 100_000 ||
    record["assets"].length > 100_000 ||
    record["folders"].length > 1_000
  ) {
    throw new LibraryError("unsupported_version", "Legacy Image Library index is invalid.");
  }
  const blobs = record["blobs"].map(parseBlob);
  const assets = record["assets"].map(parseLegacyAsset);
  const folders = record["folders"].map(parseFolder);
  if (new Set(blobs.map((blob) => blob.sha256)).size !== blobs.length) {
    throw new LibraryError("config_corrupt", "Legacy Library blob checksums contain duplicates.");
  }
  if (new Set(assets.map((asset) => asset.id)).size !== assets.length) {
    throw new LibraryError("config_corrupt", "Legacy Library asset identities contain duplicates.");
  }
  if (new Set(folders.map((folder) => folder.id)).size !== folders.length) {
    throw new LibraryError("config_corrupt", "Legacy Library folder identities contain duplicates.");
  }
  return {
    schemaVersion: 1,
    revision: record["revision"] as number,
    blobs,
    assets,
    folders
  };
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`).join(",")}}`;
}

/**
 * Converts the one supported v1 shape without changing the source value. Any
 * historical edit/trash/unknown-field record remains deliberately blocked.
 */
export function planLegacyImageLibraryUpgrade(value: unknown): LegacyLibraryUpgradePlan {
  const legacy = parseLegacyImageLibraryIndex(value);
  const source = asRecord(value, "Legacy Image Library index");
  const rawAssets = source["assets"];
  if (!Array.isArray(rawAssets) || rawAssets.length !== legacy.assets.length) {
    throw new LibraryError("config_corrupt", "Legacy Library assets are invalid.");
  }
  if (legacy.assets.some((asset) => asset.kind !== "generate" || asset.status === "deleted")) {
    throw new LibraryError("unsupported_version", "This legacy Library contains records that cannot be upgraded safely.");
  }
  const assets = rawAssets.map((rawAsset) => {
    const asset = asRecord(rawAsset, "Legacy Library asset");
    const projectParameters = (raw: unknown, label: string): Record<string, unknown> => {
      const parameters = asRecord(raw, label);
      if (parameters["kind"] !== "generate") {
        throw new LibraryError("unsupported_version", "This legacy Library contains records that cannot be upgraded safely.");
      }
      const projected = { ...parameters };
      delete projected["supportingImages"];
      delete projected["action"];
      delete projected["imageIds"];
      delete projected["fileIds"];
      return projected;
    };
    return {
      ...asset,
      requestedParams: projectParameters(asset["requestedParams"], "Legacy requested parameters"),
      effectiveParams: projectParameters(asset["effectiveParams"], "Legacy effective parameters")
    };
  });
  const projected = parseImageLibraryIndex({
    ...source,
    schemaVersion: IMAGE_LIBRARY_SCHEMA_VERSION,
    assets
  });
  return {
    fingerprint: createHash("sha256").update(canonicalValue(source), "utf8").digest("hex"),
    assetCount: projected.assets.length,
    index: projected
  };
}

export function createEmptyImageLibraryIndex(): ImageLibraryIndex {
  return { schemaVersion: IMAGE_LIBRARY_SCHEMA_VERSION, revision: 0, blobs: [], assets: [], folders: [] };
}

export function referencedBlobPaths(index: ImageLibraryIndex): ReadonlySet<string> {
  const referencedShas = new Set(
    index.assets.flatMap((asset) => asset.renditions.map((rendition) => rendition.blobSha256))
  );
  return new Set(
    index.blobs.filter((blob) => referencedShas.has(blob.sha256)).map((blob) => blob.relativePath)
  );
}
