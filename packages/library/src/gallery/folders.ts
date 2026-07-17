import { randomUUID } from "node:crypto";

import {
  identifierSchema,
  libraryFolderDescriptorSchema,
  listFoldersInputSchema,
  listFoldersResultSchema,
  reorderFoldersInputSchema,
  type LibraryFolderDescriptor,
  type ListFoldersInput,
  type ListFoldersResult,
  type ReorderFoldersInput
} from "@routego-image/contracts";

import { LibraryError } from "../errors";
import { ImageLibraryIndexStore } from "./index-store";
import {
  normalizeFolderName,
  type ImageLibraryIndex,
  type StoredLibraryFolder
} from "./model";

export interface LibraryFolderStoreOptions {
  readonly indexStore: ImageLibraryIndexStore;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export interface FolderMembershipMutationResult {
  readonly affectedAssetIds: readonly string[];
  readonly affectedFolderIds: readonly string[];
}

function timestamp(now: () => Date): string {
  const value = now();
  if (!Number.isFinite(value.getTime())) {
    throw new LibraryError("internal_contract", "The Library clock returned an invalid time.");
  }
  return value.toISOString();
}

function displayName(value: string): string {
  if (typeof value !== "string") {
    throw new LibraryError("invalid_input", "The Library folder name is invalid.");
  }
  const name = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (name.length < 1 || name.length > 200) {
    throw new LibraryError("invalid_input", "The Library folder name is invalid.");
  }
  return name;
}

function uniqueIds(values: readonly string[], label: string, maximum: number): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > maximum) {
    throw new LibraryError("invalid_input", `${label} are invalid.`);
  }
  const parsed = values.map((value) => {
    try {
      return identifierSchema.parse(value);
    } catch {
      throw new LibraryError("invalid_input", `${label} are invalid.`);
    }
  });
  return [...new Set(parsed)];
}

function folderSort(left: StoredLibraryFolder, right: StoredLibraryFolder): number {
  return left.order - right.order || left.id.localeCompare(right.id);
}

export function projectFolderDescriptors(
  index: ImageLibraryIndex,
  includeDeleted: boolean
): LibraryFolderDescriptor[] {
  const counts = new Map<string, number>();
  for (const asset of index.assets) {
    for (const folderId of asset.folderIds) {
      counts.set(folderId, (counts.get(folderId) ?? 0) + 1);
    }
  }
  return index.folders
    .filter((folder) => includeDeleted || folder.state === "active")
    .sort(folderSort)
    .map((folder) =>
      libraryFolderDescriptorSchema.parse({
        id: folder.id,
        name: folder.name,
        order: folder.order,
        assetCount: counts.get(folder.id) ?? 0,
        state: folder.state,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt
      })
    );
}

export class LibraryFolderStore {
  readonly #indexStore: ImageLibraryIndexStore;
  readonly #now: () => Date;
  readonly #idFactory: () => string;

  constructor(options: LibraryFolderStoreOptions) {
    this.#indexStore = options.indexStore;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => `folder-${randomUUID()}`);
  }

  async listFolders(input: ListFoldersInput = {}): Promise<ListFoldersResult> {
    const parsed = listFoldersInputSchema.parse(input);
    const index = await this.#indexStore.read();
    return listFoldersResultSchema.parse({
      schemaVersion: 1,
      folders: projectFolderDescriptors(index, parsed.includeDeleted)
    });
  }

  async createFolder(nameInput: string): Promise<LibraryFolderDescriptor> {
    const name = displayName(nameInput);
    const normalizedName = normalizeFolderName(name);
    let id: string;
    try {
      id = identifierSchema.parse(this.#idFactory());
    } catch {
      throw new LibraryError("internal_contract", "The folder identifier factory returned an invalid value.");
    }
    return await this.#indexStore.runExclusive(async ({ index, commit }) => {
      if (index.folders.some((folder) => folder.id === id)) {
        throw new LibraryError("conflict", "The Library folder identity already exists.");
      }
      if (
        index.folders.some(
          (folder) => folder.state === "active" && folder.normalizedName === normalizedName
        )
      ) {
        throw new LibraryError("conflict", "An active Library folder already uses that name.");
      }
      const now = timestamp(this.#now);
      const folder: StoredLibraryFolder = {
        id,
        name,
        normalizedName,
        order:
          index.folders
            .filter((candidate) => candidate.state === "active")
            .reduce((maximum, candidate) => Math.max(maximum, candidate.order), -1) + 1,
        state: "active",
        createdAt: now,
        updatedAt: now
      };
      const committed = await commit({
        blobs: index.blobs,
        assets: index.assets,
        folders: [...index.folders, folder]
      });
      return projectFolderDescriptors(committed, false).find((item) => item.id === id)!;
    });
  }

  async renameFolder(folderIdInput: string, nameInput: string): Promise<LibraryFolderDescriptor> {
    let folderId: string;
    try {
      folderId = identifierSchema.parse(folderIdInput);
    } catch {
      throw new LibraryError("invalid_input", "The Library folder identity is invalid.");
    }
    const name = displayName(nameInput);
    const normalizedName = normalizeFolderName(name);
    return await this.#indexStore.runExclusive(async ({ index, commit }) => {
      const folder = index.folders.find((candidate) => candidate.id === folderId);
      if (!folder || folder.state !== "active") {
        throw new LibraryError("not_found", "The active Library folder does not exist.");
      }
      if (
        index.folders.some(
          (candidate) =>
            candidate.id !== folderId &&
            candidate.state === "active" &&
            candidate.normalizedName === normalizedName
        )
      ) {
        throw new LibraryError("conflict", "An active Library folder already uses that name.");
      }
      if (folder.name === name) {
        return projectFolderDescriptors(index, false).find((item) => item.id === folderId)!;
      }
      const updatedAt = timestamp(this.#now);
      const committed = await commit({
        blobs: index.blobs,
        assets: index.assets,
        folders: index.folders.map((candidate) =>
          candidate.id === folderId
            ? { ...candidate, name, normalizedName, updatedAt }
            : candidate
        )
      });
      return projectFolderDescriptors(committed, false).find((item) => item.id === folderId)!;
    });
  }

  async reorderFolders(input: ReorderFoldersInput): Promise<readonly LibraryFolderDescriptor[]> {
    const parsed = reorderFoldersInputSchema.parse(input);
    return await this.#indexStore.runExclusive(async ({ index, commit }) => {
      const activeFolders = index.folders.filter((folder) => folder.state === "active");
      const activeIds = new Set(activeFolders.map((folder) => folder.id));
      if (
        parsed.folderIds.length !== activeFolders.length ||
        parsed.folderIds.some((folderId) => !activeIds.has(folderId))
      ) {
        throw new LibraryError(
          "conflict",
          "Folder reordering requires every active Library folder exactly once."
        );
      }
      const orderById = new Map(parsed.folderIds.map((folderId, order) => [folderId, order]));
      const updatedAt = timestamp(this.#now);
      const committed = await commit({
        blobs: index.blobs,
        assets: index.assets,
        folders: index.folders.map((folder) => {
          const order = orderById.get(folder.id);
          return order === undefined || order === folder.order
            ? folder
            : { ...folder, order, updatedAt };
        })
      });
      return projectFolderDescriptors(committed, false);
    });
  }

  async assignFolders(
    assetIdsInput: readonly string[],
    folderIdsInput: readonly string[]
  ): Promise<FolderMembershipMutationResult> {
    return await this.#mutateMemberships(assetIdsInput, folderIdsInput, "assign");
  }

  async removeFolders(
    assetIdsInput: readonly string[],
    folderIdsInput: readonly string[]
  ): Promise<FolderMembershipMutationResult> {
    return await this.#mutateMemberships(assetIdsInput, folderIdsInput, "remove");
  }

  async #mutateMemberships(
    assetIdsInput: readonly string[],
    folderIdsInput: readonly string[],
    operation: "assign" | "remove"
  ): Promise<FolderMembershipMutationResult> {
    const assetIds = uniqueIds(assetIdsInput, "Library asset identities", 200);
    const folderIds = uniqueIds(folderIdsInput, "Library folder identities", 100);
    return await this.#indexStore.runExclusive(async ({ index, commit }) => {
      const assetsById = new Map(index.assets.map((asset) => [asset.id, asset]));
      const foldersById = new Map(index.folders.map((folder) => [folder.id, folder]));
      if (assetIds.some((assetId) => !assetsById.has(assetId))) {
        throw new LibraryError("not_found", "A selected Library asset does not exist.");
      }
      if (assetIds.some((assetId) => assetsById.get(assetId)!.status === "deleted")) {
        throw new LibraryError("conflict", "Recycle-bin assets cannot change folder membership.");
      }
      if (folderIds.some((folderId) => foldersById.get(folderId)?.state !== "active")) {
        throw new LibraryError("not_found", "A selected active Library folder does not exist.");
      }
      const selectedAssets = new Set(assetIds);
      const selectedFolders = new Set(folderIds);
      const folderOrder = new Map(
        [...index.folders].sort(folderSort).map((folder, order) => [folder.id, order])
      );
      const changed = new Set<string>();
      const now = timestamp(this.#now);
      const assets = index.assets.map((asset) => {
        if (!selectedAssets.has(asset.id)) return asset;
        const current = new Set(asset.folderIds);
        if (operation === "assign") {
          for (const folderId of selectedFolders) current.add(folderId);
        } else {
          for (const folderId of selectedFolders) current.delete(folderId);
        }
        const folderIdsNext = [...current].sort(
          (left, right) =>
            (folderOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
              (folderOrder.get(right) ?? Number.MAX_SAFE_INTEGER) ||
            left.localeCompare(right)
        );
        if (
          folderIdsNext.length === asset.folderIds.length &&
          folderIdsNext.every((folderId, index) => folderId === asset.folderIds[index])
        ) {
          return asset;
        }
        changed.add(asset.id);
        return { ...asset, folderIds: folderIdsNext, updatedAt: now };
      });
      if (changed.size > 0) {
        await commit({ blobs: index.blobs, assets, folders: index.folders });
      }
      return {
        affectedAssetIds: assetIds.filter((assetId) => changed.has(assetId)),
        affectedFolderIds: changed.size === 0 ? [] : folderIds
      };
    });
  }
}
