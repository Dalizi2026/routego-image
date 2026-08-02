import { randomUUID } from "node:crypto";
import { lstat, readdir, unlink } from "node:fs/promises";
import path from "node:path";

import { identifierSchema, type RoutegoManageLibraryResult } from "@routego-image/contracts";

import { LibraryError, isNodeError } from "../errors";
import { readJsonIfPresent, writeJsonAtomic } from "../fs/atomic-json";
import {
  canonicalizePathIdentity,
  isPathIdentityContained,
  pathIdentitiesOverlap,
  resolveApprovedPath,
  sanitizeBaseName
} from "../fs/paths";
import type { LibraryAssetStore } from "./assets";
import { LibraryFolderStore } from "./folders";
import type { ImageLibraryIndexStore } from "./index-store";

type LocationDescriptor = NonNullable<RoutegoManageLibraryResult["locations"]>[number];

interface StoredLocation {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly folderId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface StoredLocationSource {
  readonly assetId: string;
  readonly locationId: string;
  readonly relativePath: string;
}

interface StoredLocationsDocument {
  readonly schemaVersion: 1;
  readonly locations: readonly StoredLocation[];
  readonly sources: readonly StoredLocationSource[];
}

const emptyDocument = (): StoredLocationsDocument => ({ schemaVersion: 1, locations: [], sources: [] });
const supportedExtension = /\.(?:png|jpe?g|webp)$/iu;

function nowIso(now: () => Date): string {
  const value = now();
  if (!Number.isFinite(value.getTime())) throw new LibraryError("invalid_input", "The Library clock is invalid.");
  return value.toISOString();
}

function parseDocument(value: unknown): StoredLocationsDocument {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LibraryError("config_corrupt", "Library locations are invalid.");
  }
  const record = value as Record<string, unknown>;
  if (record["schemaVersion"] !== 1 || !Array.isArray(record["locations"]) || !Array.isArray(record["sources"])) {
    throw new LibraryError("config_corrupt", "Library locations are invalid.");
  }
  const locations = record["locations"].map((value): StoredLocation => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new LibraryError("config_corrupt", "A Library location is invalid.");
    }
    const item = value as Record<string, unknown>;
    if (
      typeof item["id"] !== "string" || !identifierSchema.safeParse(item["id"]).success ||
      typeof item["name"] !== "string" || item["name"].trim().length < 1 || item["name"].trim().length > 200 ||
      typeof item["path"] !== "string" || item["path"].length < 1 || item["path"].length > 4_096 ||
      typeof item["folderId"] !== "string" || !identifierSchema.safeParse(item["folderId"]).success ||
      typeof item["createdAt"] !== "string" || !Number.isFinite(Date.parse(item["createdAt"])) ||
      typeof item["updatedAt"] !== "string" || !Number.isFinite(Date.parse(item["updatedAt"]))
    ) throw new LibraryError("config_corrupt", "A Library location is invalid.");
    return { id: item["id"], name: item["name"].trim(), path: item["path"], folderId: item["folderId"], createdAt: item["createdAt"], updatedAt: item["updatedAt"] };
  });
  const sources = record["sources"].map((value): StoredLocationSource => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new LibraryError("config_corrupt", "A Library source is invalid.");
    const item = value as Record<string, unknown>;
    if (
      typeof item["assetId"] !== "string" || !identifierSchema.safeParse(item["assetId"]).success ||
      typeof item["locationId"] !== "string" || !identifierSchema.safeParse(item["locationId"]).success ||
      typeof item["relativePath"] !== "string" || item["relativePath"].length < 1 || item["relativePath"].includes("\0") || path.isAbsolute(item["relativePath"]) || item["relativePath"].split(/[\\/]/u).includes("..")
    ) throw new LibraryError("config_corrupt", "A Library source is invalid.");
    return { assetId: item["assetId"], locationId: item["locationId"], relativePath: item["relativePath"] };
  });
  if (new Set(locations.map((item) => item.id)).size !== locations.length || new Set(sources.map((item) => item.assetId)).size !== sources.length) {
    throw new LibraryError("config_corrupt", "Library locations contain duplicate identities.");
  }
  return { schemaVersion: 1, locations, sources };
}

function formatForMime(fileName: string): "png" | "jpeg" | "webp" {
  if (/\.webp$/iu.test(fileName)) return "webp";
  if (/\.jpe?g$/iu.test(fileName)) return "jpeg";
  return "png";
}

function importedParameters(prompt: string, format: "png" | "jpeg" | "webp") {
  return {
    kind: "generate" as const,
    prompt,
    references: [],
    size: "auto" as const,
    aspectRatio: "auto" as const,
    quality: "auto" as const,
    format,
    count: 1,
    partialImages: 0,
    transparentMode: "off" as const,
    moderation: "auto" as const,
    outputDirectoryMode: "default" as const,
    saveToLibrary: true
  };
}

export class LibraryLocationStore {
  readonly #indexStore: ImageLibraryIndexStore;
  readonly #assets: LibraryAssetStore;
  readonly #folders: LibraryFolderStore;
  readonly #now: () => Date;
  readonly #documentPath: string;

  constructor(options: { readonly indexStore: ImageLibraryIndexStore; readonly assets: LibraryAssetStore; readonly now?: () => Date }) {
    this.#indexStore = options.indexStore;
    this.#assets = options.assets;
    this.#folders = new LibraryFolderStore({
      indexStore: options.indexStore,
      ...(options.now === undefined ? {} : { now: options.now })
    });
    this.#now = options.now ?? (() => new Date());
    this.#documentPath = resolveApprovedPath({ root: options.indexStore.paths.root, candidate: "locations.json", operation: "create" });
  }

  async #read(): Promise<StoredLocationsDocument> {
    return (await readJsonIfPresent(this.#documentPath, parseDocument)) ?? emptyDocument();
  }

  async #write(document: StoredLocationsDocument): Promise<void> {
    await writeJsonAtomic(this.#documentPath, document);
  }

  async #safeLocationPath(value: string): Promise<string> {
    const metadata = await lstat(value).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) throw new LibraryError("not_found", "The selected Library directory does not exist.");
      throw error;
    });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new LibraryError("path_unsafe", "The selected Library directory is unsafe.");
    const resolved = await canonicalizePathIdentity(value);
    if (pathIdentitiesOverlap(this.#indexStore.paths.root, resolved, process.platform === "win32" ? "win32" : "posix")) {
      throw new LibraryError("path_unsafe", "A custom Library directory cannot overlap Routego's managed Library.");
    }
    return resolved;
  }

  async #files(root: string): Promise<readonly string[]> {
    const found: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { await visit(absolute); continue; }
        if (entry.isFile() && supportedExtension.test(entry.name)) found.push(absolute);
      }
    };
    await visit(root);
    return found.sort((left, right) => left.localeCompare(right));
  }

  async descriptors(): Promise<readonly LocationDescriptor[]> {
    const [document, index] = await Promise.all([this.#read(), this.#indexStore.read()]);
    return [
      { id: "default-library", name: "默认图库", assetCount: index.assets.length, isDefault: true },
      ...document.locations.map((location) => ({
        id: location.id,
        name: location.name,
        folderId: location.folderId,
        assetCount: index.assets.filter((asset) => asset.folderIds.includes(location.folderId)).length,
        isDefault: false
      }))
    ];
  }

  async add(locationPath: string, requestedName?: string): Promise<readonly LocationDescriptor[]> {
    const root = await this.#safeLocationPath(locationPath);
    const document = await this.#read();
    if (document.locations.some((location) => location.path === root)) {
      throw new LibraryError("conflict", "This Library directory has already been added.");
    }
    const name = (requestedName?.trim() || path.basename(root)).slice(0, 200);
    const folder = await this.#folders.createFolder(name);
    const timestamp = nowIso(this.#now);
    const location: StoredLocation = { id: `location-${randomUUID()}`, name, path: root, folderId: folder.id, createdAt: timestamp, updatedAt: timestamp };
    const existing = new Set(document.sources.map((source) => `${source.locationId}:${source.relativePath}`));
    const sources: StoredLocationSource[] = [...document.sources];
    for (const absolute of await this.#files(root)) {
      const relativePath = path.relative(root, absolute);
      if (existing.has(`${location.id}:${relativePath}`)) continue;
      const displayName = path.basename(absolute, path.extname(absolute));
      const prompt = `已从本地图库导入：${displayName}`;
      try {
        const result = await this.#assets.ingestAsset({
          prompt,
          model: "local-library",
          requestedParams: importedParameters(prompt, formatForMime(absolute)),
          effectiveParams: importedParameters(prompt, formatForMime(absolute)),
          execution: { attemptCount: 0, providerRequestCount: 0, receivedAnyOutput: true, mayHaveBilled: false, degradedContinuation: false, providerImageIds: [] },
          renditions: [{ phase: "final", sourceRoot: root, sourceRelativePath: relativePath, requestedBaseName: sanitizeBaseName(displayName) }],
          folderIds: [folder.id]
        });
        sources.push({ assetId: result.asset.id, locationId: location.id, relativePath });
      } catch {
        // A malformed or unsupported image is deliberately skipped; valid files continue to import.
      }
    }
    await this.#write({ schemaVersion: 1, locations: [...document.locations, location], sources });
    return await this.descriptors();
  }

  async move(assetIds: readonly string[], destinationLocationId: string): Promise<readonly string[]> {
    const document = await this.#read();
    const target = document.locations.find((location) => location.id === destinationLocationId);
    if (!target) throw new LibraryError("not_found", "The destination Library directory does not exist.");
    const targetRoot = await this.#safeLocationPath(target.path);
    const index = await this.#indexStore.read();
    const moved: string[] = [];
    const nextSources = [...document.sources];
    for (const assetId of [...new Set(assetIds)]) {
      const asset = index.assets.find((item) => item.id === assetId);
      if (!asset) continue;
      const copied = await this.#assets.copyArtifactToProject({ assetId, projectRoot: targetRoot, requestedBaseName: asset.displayName ?? asset.model });
      const relativePath = path.basename(copied.fileName);
      const existingSource = nextSources.find((source) => source.assetId === assetId);
      if (existingSource) {
        const previous = document.locations.find((location) => location.id === existingSource.locationId);
        if (previous) {
          const previousPath = path.resolve(previous.path, existingSource.relativePath);
          if (isPathIdentityContained(previous.path, previousPath, process.platform === "win32" ? "win32" : "posix")) {
            const metadata = await lstat(previousPath).catch(() => undefined);
            if (metadata?.isFile() && !metadata.isSymbolicLink()) await unlink(previousPath);
          }
        }
        nextSources.splice(nextSources.indexOf(existingSource), 1);
      }
      nextSources.push({ assetId, locationId: target.id, relativePath });
      moved.push(assetId);
    }
    if (moved.length > 0) {
      await this.#indexStore.runExclusive(async ({ index, commit }) => {
        const locationFolderIds = new Set(document.locations.map((location) => location.folderId));
        await commit({
          blobs: index.blobs,
          folders: index.folders,
          assets: index.assets.map((asset) => moved.includes(asset.id)
            ? { ...asset, folderIds: [...asset.folderIds.filter((folderId) => !locationFolderIds.has(folderId)), target.folderId], updatedAt: nowIso(this.#now) }
            : asset)
        });
      });
      await this.#write({ schemaVersion: 1, locations: document.locations, sources: nextSources });
    }
    return moved;
  }

  async rename(assetId: string, name: string): Promise<void> {
    await this.#indexStore.runExclusive(async ({ index, commit }) => {
      if (!index.assets.some((asset) => asset.id === assetId)) throw new LibraryError("not_found", "The Library asset does not exist.");
      await commit({ blobs: index.blobs, folders: index.folders, assets: index.assets.map((asset) => asset.id === assetId ? { ...asset, displayName: name.trim(), updatedAt: nowIso(this.#now) } : asset) });
    });
  }

  async delete(assetIds: readonly string[]): Promise<readonly string[]> {
    const document = await this.#read();
    const ids = [...new Set(assetIds)];
    const index = await this.#indexStore.read();
    const blocked = new Set(index.assets.filter((asset) => asset.relationships.some((relationship) => ids.includes(relationship.relatedAssetId) && !ids.includes(asset.id))).flatMap((asset) => asset.relationships.map((relationship) => relationship.relatedAssetId)));
    const deletable = ids.filter((id) => index.assets.some((asset) => asset.id === id) && !blocked.has(id));
    for (const source of document.sources.filter((source) => deletable.includes(source.assetId))) {
      const location = document.locations.find((item) => item.id === source.locationId);
      if (!location) continue;
      const candidate = path.resolve(location.path, source.relativePath);
      if (!isPathIdentityContained(location.path, candidate, process.platform === "win32" ? "win32" : "posix")) continue;
      const metadata = await lstat(candidate).catch(() => undefined);
      if (metadata?.isFile() && !metadata.isSymbolicLink()) await unlink(candidate);
    }
    let orphanPaths: string[] = [];
    await this.#indexStore.runExclusive(async ({ index: current, commit }) => {
      const remaining = current.assets.filter((asset) => !deletable.includes(asset.id));
      const referenced = new Set(remaining.flatMap((asset) => asset.renditions.map((rendition) => rendition.blobSha256)));
      const blobs = current.blobs.filter((blob) => referenced.has(blob.sha256));
      orphanPaths = current.blobs.filter((blob) => !referenced.has(blob.sha256)).map((blob) => blob.relativePath);
      await commit({ blobs, assets: remaining, folders: current.folders });
    });
    for (const relativePath of orphanPaths) {
      const candidate = resolveApprovedPath({ root: this.#indexStore.paths.root, candidate: relativePath, operation: "delete" });
      await unlink(candidate).catch((error: unknown) => { if (!isNodeError(error, "ENOENT")) throw error; });
    }
    await this.#write({ schemaVersion: 1, locations: document.locations, sources: document.sources.filter((source) => !deletable.includes(source.assetId)) });
    return deletable;
  }
}
