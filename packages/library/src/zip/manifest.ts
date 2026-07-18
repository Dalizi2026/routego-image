import { isDeepStrictEqual, TextDecoder } from "node:util";

import {
  MAX_LIBRARY_ASSET_RENDITIONS,
  timestampSchema,
  type LibraryOperationParameters,
  type RoutegoServiceError
} from "@routego-image/contracts";
import { redactFreeText } from "@routego-image/foundation";

import { LibraryError } from "../errors";
import {
  normalizeFolderName,
  parseImageLibraryIndex,
  type ImageLibraryIndex,
  type StoredImageBlob,
  type StoredLibraryAsset,
  type StoredLibraryFolder
} from "../gallery/model";

export const PORTABLE_LIBRARY_MANIFEST_SCHEMA_VERSION = 1 as const;
export const PORTABLE_LIBRARY_MANIFEST_KIND = "routego-image-library-portability" as const;
export const PORTABLE_LIBRARY_MANIFEST_ENTRY = "routego-image-library-manifest.json";
export const MAX_PORTABLE_MANIFEST_BYTES = 8 * 1024 * 1024;
export const MAX_PORTABLE_ASSETS = 200;
export const MAX_PORTABLE_BLOBS = MAX_PORTABLE_ASSETS * MAX_LIBRARY_ASSET_RENDITIONS;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const PORTABLE_REDACTED_PATH = "[REDACTED_PATH]";
const PORTABLE_REDACTED_SECRET = "[REDACTED_SECRET]";

export interface PortableImageBlob {
  readonly sha256: string;
  readonly entryName: string;
  readonly mimeType: StoredImageBlob["mimeType"];
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly createdAt: string;
}

export interface PortableLibraryManifest {
  readonly schemaVersion: 1;
  readonly kind: typeof PORTABLE_LIBRARY_MANIFEST_KIND;
  readonly exportedAt: string;
  readonly blobs: readonly PortableImageBlob[];
  readonly assets: readonly StoredLibraryAsset[];
  readonly folders: readonly StoredLibraryFolder[];
}

export interface PortableAssetClosure {
  readonly rootAssetId: string;
  readonly assetIds: ReadonlySet<string>;
  readonly folderIds: ReadonlySet<string>;
  readonly blobSha256s: ReadonlySet<string>;
}

function manifestError(message = "The portable Library manifest is malformed or unsupported."): never {
  throw new LibraryError("upload_invalid_type", message);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) manifestError();
  return value as Record<string, unknown>;
}

function exact(record: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key))) manifestError();
}

function extensionForMime(mimeType: StoredImageBlob["mimeType"]): "png" | "jpg" | "webp" {
  return mimeType === "image/png" ? "png" : mimeType === "image/jpeg" ? "jpg" : "webp";
}

function redactPortableText(value: string): string {
  return redactFreeText(value)
    .replace(
      /\b(?:x[-_ ]?routego[-_ ]?session|x[-_ ]?api[-_ ]?key|api[-_ ]?key|proxy[-_ ]?authorization|authorization|set[-_ ]?cookie|cookie|session[-_ ]?token|access[-_ ]?token|refresh[-_ ]?token|bearer[-_ ]?token|client[-_ ]?secret|token|password|secret)\s*[:=]\s*\[REDACTED\]/giu,
      PORTABLE_REDACTED_SECRET
    )
    .replace(/\bBearer\s+\[REDACTED\]/giu, PORTABLE_REDACTED_SECRET)
    .replace(
      /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\|~[\\/])[^\s<>"')}\],;]*/gu,
      PORTABLE_REDACTED_PATH
    )
    .replace(
      /(?<![A-Za-z0-9:/])\/(?!\/)[^\s<>"')}\],;]*/gu,
      PORTABLE_REDACTED_PATH
    );
}

function portableParameters(parameters: LibraryOperationParameters): LibraryOperationParameters {
  return {
    ...parameters,
    prompt: redactPortableText(parameters.prompt),
    references: parameters.references.map((reference) => ({
      ...reference,
      ...(reference.label === undefined
        ? {}
        : { label: redactPortableText(reference.label) })
    })),
    supportingImages: parameters.supportingImages.map((reference) => ({
      ...reference,
      ...(reference.label === undefined
        ? {}
        : { label: redactPortableText(reference.label) })
    })),
    ...(parameters.target === undefined
      ? {}
      : {
          target: {
            ...parameters.target,
            ...(parameters.target.label === undefined
              ? {}
              : { label: redactPortableText(parameters.target.label) })
          }
        }),
    ...(parameters.invariants === undefined
      ? {}
      : {
          invariants: {
            allowedChanges: parameters.invariants.allowedChanges.map(redactPortableText),
            preserve: parameters.invariants.preserve.map(redactPortableText),
            forbiddenChanges: parameters.invariants.forbiddenChanges.map(redactPortableText)
          }
        })
  };
}

function portableError(error: RoutegoServiceError): RoutegoServiceError {
  const { details, partialArtifacts, ...portable } = error;
  void details;
  void partialArtifacts;
  return {
    ...portable,
    safeMessage: redactPortableText(error.safeMessage),
    ...(error.providerCode === undefined
      ? {}
      : { providerCode: redactPortableText(error.providerCode) }),
    partialArtifacts: []
  };
}

function portableAsset(asset: StoredLibraryAsset): StoredLibraryAsset {
  return {
    ...asset,
    prompt: redactPortableText(asset.prompt),
    requestedParams: portableParameters(asset.requestedParams),
    effectiveParams: portableParameters(asset.effectiveParams),
    ...(asset.error === undefined ? {} : { error: portableError(asset.error) }),
    relationships: asset.relationships.map((relationship) => ({
      ...relationship,
      ...(relationship.label === undefined
        ? {}
        : { label: redactPortableText(relationship.label) })
    }))
  };
}

function portableFolder(folder: StoredLibraryFolder): StoredLibraryFolder {
  const name = redactPortableText(folder.name).trim();
  return { ...folder, name, normalizedName: normalizeFolderName(name) };
}

export function portableBlobEntryName(
  sha256: string,
  mimeType: StoredImageBlob["mimeType"]
): string {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) manifestError();
  return `blobs/${sha256}.${extensionForMime(mimeType)}`;
}

function parsePortableBlob(value: unknown): PortableImageBlob {
  const record = asRecord(value);
  exact(record, [
    "sha256",
    "entryName",
    "mimeType",
    "byteLength",
    "width",
    "height",
    "createdAt"
  ]);
  const sha256 = record["sha256"];
  const mimeType = record["mimeType"];
  if (
    typeof sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(sha256) ||
    (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp") ||
    record["entryName"] !== portableBlobEntryName(sha256, mimeType) ||
    !Number.isSafeInteger(record["byteLength"]) ||
    (record["byteLength"] as number) < 1 ||
    !Number.isSafeInteger(record["width"]) ||
    (record["width"] as number) < 1 ||
    (record["width"] as number) > 65_535 ||
    !Number.isSafeInteger(record["height"]) ||
    (record["height"] as number) < 1 ||
    (record["height"] as number) > 65_535
  ) {
    manifestError();
  }
  let createdAt: string;
  try {
    createdAt = timestampSchema.parse(record["createdAt"]);
  } catch {
    manifestError();
  }
  return {
    sha256,
    entryName: record["entryName"] as string,
    mimeType,
    byteLength: record["byteLength"] as number,
    width: record["width"] as number,
    height: record["height"] as number,
    createdAt
  };
}

function parameterAssetIds(parameters: LibraryOperationParameters): readonly string[] {
  return [
    ...parameters.references.map((item) => item.assetId),
    ...parameters.supportingImages.map((item) => item.assetId),
    ...(parameters.target === undefined ? [] : [parameters.target.assetId]),
    ...(parameters.maskAssetId === undefined ? [] : [parameters.maskAssetId])
  ];
}

export function portableAssetDependencyIds(asset: StoredLibraryAsset): ReadonlySet<string> {
  return new Set([
    ...asset.relationships.map((relationship) => relationship.relatedAssetId),
    ...parameterAssetIds(asset.requestedParams),
    ...parameterAssetIds(asset.effectiveParams)
  ]);
}

export function collectPortableAssetClosure(
  index: ImageLibraryIndex,
  rootAssetId: string,
  maximumAssets = MAX_PORTABLE_ASSETS
): PortableAssetClosure {
  if (
    !Number.isSafeInteger(maximumAssets) ||
    maximumAssets < 1 ||
    maximumAssets > MAX_PORTABLE_ASSETS
  ) {
    throw new LibraryError("invalid_input", "The portable asset closure limit is invalid.");
  }
  const assetById = new Map(index.assets.map((asset) => [asset.id, asset]));
  if (!assetById.has(rootAssetId)) {
    throw new LibraryError("not_found", "The selected Library asset does not exist.");
  }
  const assetIds = new Set<string>();
  const pending = [rootAssetId];
  while (pending.length > 0) {
    const assetId = pending.shift()!;
    if (assetIds.has(assetId)) continue;
    const asset = assetById.get(assetId);
    if (!asset) {
      throw new LibraryError(
        "config_corrupt",
        "The selected Library asset closure references missing metadata."
      );
    }
    assetIds.add(assetId);
    if (assetIds.size > maximumAssets) {
      throw new LibraryError("upload_oversize", "The selected Library asset closure is too large.");
    }
    for (const dependencyId of portableAssetDependencyIds(asset)) {
      if (!assetIds.has(dependencyId)) pending.push(dependencyId);
    }
  }
  const assets = index.assets.filter((asset) => assetIds.has(asset.id));
  return {
    rootAssetId,
    assetIds,
    folderIds: new Set(assets.flatMap((asset) => asset.folderIds)),
    blobSha256s: new Set(
      assets.flatMap((asset) => asset.renditions.map((rendition) => rendition.blobSha256))
    )
  };
}

function validateManifestClosure(manifest: PortableLibraryManifest): void {
  const assetIds = new Set(manifest.assets.map((asset) => asset.id));
  const referencedFolders = new Set(manifest.assets.flatMap((asset) => asset.folderIds));
  if (
    manifest.assets.some((asset) =>
      [...portableAssetDependencyIds(asset)].some((assetId) => !assetIds.has(assetId))
    ) ||
    manifest.folders.some((folder) => !referencedFolders.has(folder.id))
  ) {
    manifestError("The portable Library manifest does not contain a complete asset closure.");
  }
}

export function parsePortableLibraryManifest(value: unknown): PortableLibraryManifest {
  const record = asRecord(value);
  if (typeof record["schemaVersion"] === "number" && record["schemaVersion"] !== 1) {
    throw new LibraryError("unsupported_version", "The portable Library manifest version is unsupported.");
  }
  exact(record, ["schemaVersion", "kind", "exportedAt", "blobs", "assets", "folders"]);
  if (
    record["schemaVersion"] !== PORTABLE_LIBRARY_MANIFEST_SCHEMA_VERSION ||
    record["kind"] !== PORTABLE_LIBRARY_MANIFEST_KIND ||
    !Array.isArray(record["blobs"]) ||
    !Array.isArray(record["assets"]) ||
    !Array.isArray(record["folders"]) ||
    record["assets"].length < 1 ||
    record["assets"].length > MAX_PORTABLE_ASSETS ||
    record["blobs"].length < 1 ||
    record["blobs"].length > MAX_PORTABLE_BLOBS ||
    record["folders"].length > 1_000
  ) {
    manifestError();
  }
  let exportedAt: string;
  try {
    exportedAt = timestampSchema.parse(record["exportedAt"]);
  } catch {
    manifestError();
  }
  const blobs = record["blobs"].map(parsePortableBlob);
  if (
    new Set(blobs.map((blob) => blob.sha256)).size !== blobs.length ||
    new Set(blobs.map((blob) => blob.entryName.toLocaleLowerCase("und"))).size !== blobs.length
  ) {
    manifestError();
  }
  let parsedIndex: ImageLibraryIndex;
  try {
    parsedIndex = parseImageLibraryIndex({
      schemaVersion: 1,
      revision: 0,
      blobs: blobs.map((blob) => ({
        sha256: blob.sha256,
        relativePath: `blobs/2000/01/${blob.sha256}.${extensionForMime(blob.mimeType)}`,
        mimeType: blob.mimeType,
        byteLength: blob.byteLength,
        width: blob.width,
        height: blob.height,
        createdAt: blob.createdAt
      })),
      assets: record["assets"],
      folders: record["folders"]
    });
  } catch (error) {
    if (error instanceof LibraryError && error.code === "unsupported_version") throw error;
    manifestError();
  }
  const manifest: PortableLibraryManifest = {
    schemaVersion: 1,
    kind: PORTABLE_LIBRARY_MANIFEST_KIND,
    exportedAt,
    blobs,
    assets: parsedIndex.assets,
    folders: parsedIndex.folders
  };
  if (
    manifest.assets.some((asset) => !isPortableAsset(asset)) ||
    manifest.folders.some((folder) => !isPortableFolder(folder))
  ) {
    manifestError("The portable Library manifest contains non-portable metadata.");
  }
  validateManifestClosure(manifest);
  return manifest;
}

function isPortableAsset(asset: StoredLibraryAsset): boolean {
  return isDeepStrictEqual(asset, portableAsset(asset));
}

function isPortableFolder(folder: StoredLibraryFolder): boolean {
  return isDeepStrictEqual(folder, portableFolder(folder));
}

export function parsePortableLibraryManifestBytes(bytes: Uint8Array): PortableLibraryManifest {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) manifestError();
  if (bytes.byteLength > MAX_PORTABLE_MANIFEST_BYTES) {
    throw new LibraryError("upload_oversize", "The portable Library manifest is too large.");
  }
  let text: string;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    manifestError("The portable Library manifest is not valid UTF-8.");
  }
  try {
    return parsePortableLibraryManifest(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof LibraryError) throw error;
    manifestError();
  }
}

export function createPortableLibraryManifest(
  index: ImageLibraryIndex,
  selectedAssetIds: readonly string[],
  exportedAt: string
): PortableLibraryManifest {
  if (
    selectedAssetIds.length < 1 ||
    selectedAssetIds.length > MAX_PORTABLE_ASSETS ||
    new Set(selectedAssetIds).size !== selectedAssetIds.length
  ) {
    throw new LibraryError("invalid_input", "Portable export asset identities are invalid.");
  }
  try {
    timestampSchema.parse(exportedAt);
  } catch {
    throw new LibraryError("invalid_input", "The portable export timestamp is invalid.");
  }
  const assetIds = new Set<string>();
  const folderIds = new Set<string>();
  const blobSha256s = new Set<string>();
  for (const selectedAssetId of selectedAssetIds) {
    const closure = collectPortableAssetClosure(index, selectedAssetId, MAX_PORTABLE_ASSETS);
    for (const assetId of closure.assetIds) assetIds.add(assetId);
    for (const folderId of closure.folderIds) folderIds.add(folderId);
    for (const sha256 of closure.blobSha256s) blobSha256s.add(sha256);
    if (assetIds.size > MAX_PORTABLE_ASSETS) {
      throw new LibraryError("upload_oversize", "The portable export contains too many assets.");
    }
  }
  const blobs = index.blobs
    .filter((blob) => blobSha256s.has(blob.sha256))
    .map((blob): PortableImageBlob => ({
      sha256: blob.sha256,
      entryName: portableBlobEntryName(blob.sha256, blob.mimeType),
      mimeType: blob.mimeType,
      byteLength: blob.byteLength,
      width: blob.width,
      height: blob.height,
      createdAt: blob.createdAt
    }));
  const manifest: PortableLibraryManifest = {
    schemaVersion: 1,
    kind: PORTABLE_LIBRARY_MANIFEST_KIND,
    exportedAt,
    blobs,
    assets: index.assets.filter((asset) => assetIds.has(asset.id)).map(portableAsset),
    folders: index.folders
      .filter((folder) => folderIds.has(folder.id))
      .map(portableFolder)
  };
  return parsePortableLibraryManifest(manifest);
}

export function serializePortableLibraryManifest(manifest: PortableLibraryManifest): Buffer {
  return Buffer.from(JSON.stringify(parsePortableLibraryManifest(manifest)), "utf8");
}
