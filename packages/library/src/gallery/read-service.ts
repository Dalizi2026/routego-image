import {
  copyGenerationInfoInputSchema,
  copyGenerationInfoResultSchema,
  getAssetDetailInputSchema,
  getAssetDetailResultSchema,
  getBrowserResourceInputSchema,
  getBrowserResourceResultSchema,
  listFoldersInputSchema,
  reorderFoldersInputSchema,
  reorderFoldersResultSchema,
  routegoSearchLibraryInputSchema,
  routegoSearchLibraryResultSchema,
  routegoPrepareRegenerationInputSchema,
  routegoPrepareRegenerationResultSchema,
  routegoServiceErrorSchema,
  studioLibrarySearchInputSchema,
  studioLibrarySearchResultSchema,
  type CopyGenerationInfoInput,
  type CopyGenerationInfoResult,
  type GetAssetDetailInput,
  type GetAssetDetailResult,
  type GetBrowserResourceInput,
  type GetBrowserResourceResult,
  type LibraryAssetDetail,
  type LibraryFolderDescriptor,
  type ListFoldersInput,
  type ListFoldersResult,
  type ReorderFoldersInput,
  type ReorderFoldersResult,
  type RoutegoSearchLibraryInput,
  type RoutegoSearchLibraryResult,
  type RoutegoPrepareRegenerationInput,
  type RoutegoPrepareRegenerationResult,
  type RoutegoServiceError,
  type StudioLibrarySearchInput,
  type StudioLibrarySearchResult
} from "@routego-image/contracts";
import { redactFreeText } from "@routego-image/foundation";

import { LibraryError } from "../errors";
import {
  LibraryFolderStore,
  projectFolderDescriptors,
  type FolderMembershipMutationResult
} from "./folders";
import { ImageLibraryIndexStore } from "./index-store";
import type {
  ImageLibraryIndex,
  StoredImageBlob,
  StoredLibraryAsset
} from "./model";
import { prepareSafeGeneration, queryLibraryIndex } from "./query";
import {
  BrowserResourceRegistry,
  type BrowserResourceRegistryOptions
} from "./resources";

export interface LibraryReadServiceOptions {
  readonly indexStore: ImageLibraryIndexStore;
  readonly folders?: LibraryFolderStore;
  readonly resources?: BrowserResourceRegistry;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => Date;
  readonly folderIdFactory?: () => string;
  readonly resourceIdFactory?: BrowserResourceRegistryOptions["idFactory"];
}

const pathLikePattern = /(?:[A-Za-z]:[\\/]|file:\/\/|data:image|base64|\/(?:Users|home|tmp|var|private|mnt)\/)/iu;

function safeMessage(value: string, fallback: string): string {
  const redacted = redactFreeText(value).trim();
  return redacted.length < 1 || pathLikePattern.test(redacted) ? fallback : redacted.slice(0, 1_000);
}

function pathFreeStoredError(error: RoutegoServiceError): RoutegoServiceError {
  return routegoServiceErrorSchema.parse({
    ...(error.id === undefined ? {} : { id: error.id }),
    code: error.code,
    category: error.category,
    stage: error.stage,
    safeMessage: safeMessage(error.safeMessage, "The stored image operation did not complete successfully."),
    retryDisposition: error.retryDisposition,
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
    ...(error.capability === undefined ? {} : { capability: error.capability }),
    partialArtifacts: [],
    receivedAnyOutput: error.receivedAnyOutput,
    mayHaveBilled: error.mayHaveBilled
  });
}

function serviceError(error: unknown, fallback: string): RoutegoServiceError {
  const libraryError = error instanceof LibraryError ? error : undefined;
  const code = libraryError?.code;
  const mappedCode: RoutegoServiceError["code"] =
    code === "config_corrupt" || code === "config_missing"
      ? code
      : code === "invalid_input" || code === "invalid_request"
        ? code
        : code === "not_found" || code === "conflict" || code === "access_denied" || code === "path_unsafe"
          ? code
          : "internal_contract";
  const category: RoutegoServiceError["category"] =
    mappedCode === "config_corrupt" || mappedCode === "config_missing"
      ? "configuration"
      : mappedCode === "invalid_input" || mappedCode === "invalid_request"
        ? "validation"
        : mappedCode === "access_denied" || mappedCode === "path_unsafe"
          ? "security"
          : mappedCode === "not_found" || mappedCode === "conflict"
            ? "persistence"
            : "internal";
  return routegoServiceErrorSchema.parse({
    code: mappedCode,
    category,
    stage: category === "validation" ? "validate" : category === "internal" ? "complete" : "persist",
    safeMessage: safeMessage(libraryError?.message ?? fallback, fallback),
    retryDisposition: mappedCode === "conflict" ? "user-confirmation" : "never",
    partialArtifacts: [],
    receivedAnyOutput: false,
    mayHaveBilled: false
  });
}

function findBlob(index: ImageLibraryIndex, sha256: string): StoredImageBlob {
  const blob = index.blobs.find((candidate) => candidate.sha256 === sha256);
  if (!blob) {
    throw new LibraryError("config_corrupt", "The Library rendition references missing image data.");
  }
  return blob;
}

function primaryBlob(index: ImageLibraryIndex, asset: StoredLibraryAsset): StoredImageBlob {
  const rendition = asset.renditions.find(
    (candidate) => candidate.artifactId === asset.primaryArtifactId
  );
  if (!rendition) {
    throw new LibraryError("config_corrupt", "The Library primary rendition is missing.");
  }
  return findBlob(index, rendition.blobSha256);
}

function allowedActions(asset: StoredLibraryAsset): LibraryAssetDetail["allowedActions"] {
  const actions: LibraryAssetDetail["allowedActions"][number][] = [];
  actions.push("assign-folders");
  if (asset.folderIds.length > 0) actions.push("remove-folders");
  actions.push("mark", "copy-generation-info");
  actions.push("export-zip", "download");
  return actions;
}

function detailFromIndex(index: ImageLibraryIndex, asset: StoredLibraryAsset): LibraryAssetDetail {
  const blob = primaryBlob(index, asset);
  const foldersById = new Map(index.folders.map((folder) => [folder.id, folder]));
  const folders = asset.folderIds
    .map((folderId) => foldersById.get(folderId))
    .filter((folder): folder is NonNullable<typeof folder> => folder !== undefined)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((folder) => ({
      folderId: folder.id,
      name: folder.name,
      state: folder.state,
      order: folder.order
    }));
  return {
    id: asset.id,
    ...(asset.displayName === undefined ? {} : { displayName: asset.displayName }),
    prompt: asset.prompt,
    model: asset.model,
    kind: asset.kind,
    status: asset.status,
    primaryArtifactId: asset.primaryArtifactId,
    mimeType: blob.mimeType,
    width: blob.width,
    height: blob.height,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    requestedParams: asset.requestedParams,
    effectiveParams: asset.effectiveParams,
    execution: asset.execution,
    currentMark: index.currentMarkRecordId === asset.id,
    ...(asset.error === undefined ? {} : { error: pathFreeStoredError(asset.error) }),
    renditions: [...asset.renditions]
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.artifactId.localeCompare(right.artifactId)
      )
      .map((rendition) => {
        const renditionBlob = findBlob(index, rendition.blobSha256);
        return {
          artifactId: rendition.artifactId,
          phase: rendition.phase,
          mimeType: renditionBlob.mimeType,
          byteLength: renditionBlob.byteLength,
          width: renditionBlob.width,
          height: renditionBlob.height,
          sha256: renditionBlob.sha256,
          createdAt: rendition.createdAt
        };
      }),
    relationships: [...asset.relationships].sort(
      (left, right) => left.order - right.order || left.id.localeCompare(right.id)
    ),
    folders,
    allowedActions: allowedActions(asset)
  };
}

export class LibraryReadService {
  readonly #indexStore: ImageLibraryIndexStore;
  readonly #folders: LibraryFolderStore;
  readonly #resources: BrowserResourceRegistry;

  constructor(options: LibraryReadServiceOptions) {
    this.#indexStore = options.indexStore;
    this.#folders =
      options.folders ??
      new LibraryFolderStore({
        indexStore: options.indexStore,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.folderIdFactory === undefined ? {} : { idFactory: options.folderIdFactory })
      });
    this.#resources =
      options.resources ??
      new BrowserResourceRegistry({
        root: options.indexStore.paths.root,
        ...(options.platform === undefined ? {} : { platform: options.platform }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.resourceIdFactory === undefined
          ? {}
          : { idFactory: options.resourceIdFactory })
      });
  }

  get folders(): LibraryFolderStore {
    return this.#folders;
  }

  get resources(): BrowserResourceRegistry {
    return this.#resources;
  }

  async searchLibrary(input: RoutegoSearchLibraryInput): Promise<RoutegoSearchLibraryResult> {
    const parsed = routegoSearchLibraryInputSchema.parse(input);
    const index = await this.#indexStore.read();
    const page = queryLibraryIndex(index, parsed);
    const items = await Promise.all(
      page.items.map(async ({ asset, blob }) => {
        const backing = await this.#resources.inspectImage(blob);
        return {
          id: asset.id,
          path: backing.path,
          prompt: asset.prompt,
          model: asset.model,
          kind: asset.kind,
          mimeType: blob.mimeType,
          width: blob.width,
          height: blob.height,
          status: asset.status,
          folderIds: [...asset.folderIds],
          createdAt: asset.createdAt,
        };
      })
    );
    return routegoSearchLibraryResultSchema.parse({
      schemaVersion: 1,
      items,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      total: page.total
    });
  }

  async searchStudioLibrary(input: StudioLibrarySearchInput): Promise<StudioLibrarySearchResult> {
    const parsed = studioLibrarySearchInputSchema.parse(input);
    const index = await this.#indexStore.read();
    const page = queryLibraryIndex(index, parsed);
    const items = await Promise.all(
      page.items.map(async ({ asset, rendition, blob }) => ({
        assetId: asset.id,
        ...(asset.displayName === undefined ? {} : { displayName: asset.displayName }),
        artifactId: rendition.artifactId,
        prompt: asset.prompt,
        model: asset.model,
        kind: asset.kind,
        mimeType: blob.mimeType,
        width: blob.width,
        height: blob.height,
        status: asset.status,
        folderIds: [...asset.folderIds],
        createdAt: asset.createdAt,
        thumbnail: await this.#resources.registerImage(blob, "thumbnail")
      }))
    );
    return studioLibrarySearchResultSchema.parse({
      schemaVersion: 1,
      items,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      total: page.total
    });
  }

  async copyGenerationInfo(input: CopyGenerationInfoInput): Promise<CopyGenerationInfoResult> {
    const parsed = copyGenerationInfoInputSchema.parse(input);
    try {
      const prepared = prepareSafeGeneration(await this.#indexStore.read(), parsed.recordId);
      return copyGenerationInfoResultSchema.parse({
        schemaVersion: 1,
        status: "succeeded",
        projection: prepared.projection,
        clipboardText: JSON.stringify(prepared.projection),
        providerRequestCount: 0
      });
    } catch (error) {
      return copyGenerationInfoResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        providerRequestCount: 0,
        error: serviceError(error, "The generation information is unavailable.")
      });
    }
  }

  async prepareRegeneration(
    input: RoutegoPrepareRegenerationInput
  ): Promise<RoutegoPrepareRegenerationResult> {
    const parsed = routegoPrepareRegenerationInputSchema.parse(input);
    const index = await this.#indexStore.read();
    const recordId = parsed.recordId ?? index.currentMarkRecordId;
    if (recordId === undefined) {
      throw new LibraryError("not_found", "No generation record is currently marked.");
    }
    const prepared = prepareSafeGeneration(index, recordId);
    return routegoPrepareRegenerationResultSchema.parse({
      schemaVersion: 1,
      recipe: prepared.recipe,
      providerRequestCount: 0,
      markUnchanged: true
    });
  }

  async listFolders(input: ListFoldersInput): Promise<ListFoldersResult> {
    return await this.#folders.listFolders(listFoldersInputSchema.parse(input));
  }

  async reorderFolders(input: ReorderFoldersInput): Promise<ReorderFoldersResult> {
    const parsed = reorderFoldersInputSchema.parse(input);
    try {
      return reorderFoldersResultSchema.parse({
        schemaVersion: 1,
        status: "succeeded",
        folders: await this.#folders.reorderFolders(parsed)
      });
    } catch (error) {
      if (!(error instanceof LibraryError)) throw error;
      const index = await this.#indexStore.read();
      return reorderFoldersResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        folders: projectFolderDescriptors(index, false),
        error: serviceError(error, "The Library folder order could not be changed.")
      });
    }
  }

  async getAssetDetail(input: GetAssetDetailInput): Promise<GetAssetDetailResult> {
    const parsed = getAssetDetailInputSchema.parse(input);
    try {
      const index = await this.#indexStore.read();
      const asset = index.assets.find((candidate) => candidate.id === parsed.assetId);
      if (!asset) throw new LibraryError("not_found", "The Library asset does not exist.");
      return getAssetDetailResultSchema.parse({
        schemaVersion: 1,
        status: "succeeded",
        asset: detailFromIndex(index, asset)
      });
    } catch (error) {
      return getAssetDetailResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        error: serviceError(error, "The Library asset detail is unavailable.")
      });
    }
  }

  async getBrowserResource(input: GetBrowserResourceInput): Promise<GetBrowserResourceResult> {
    const parsed = getBrowserResourceInputSchema.parse(input);
    try {
      const index = await this.#indexStore.read();
      const asset = index.assets.find((candidate) => candidate.id === parsed.assetId);
      if (!asset) throw new LibraryError("not_found", "The Library asset does not exist.");
      const artifactId = parsed.artifactId ?? asset.primaryArtifactId;
      const rendition = asset.renditions.find((candidate) => candidate.artifactId === artifactId);
      if (!rendition) {
        throw new LibraryError("not_found", "The Library artifact does not belong to that asset.");
      }
      const blob = findBlob(index, rendition.blobSha256);
      return getBrowserResourceResultSchema.parse({
        schemaVersion: 1,
        status: "succeeded",
        resource: await this.#resources.registerImage(blob, parsed.rendition)
      });
    } catch (error) {
      return getBrowserResourceResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        error: serviceError(error, "The protected Library resource is unavailable.")
      });
    }
  }

  async createFolder(name: string): Promise<LibraryFolderDescriptor> {
    return await this.#folders.createFolder(name);
  }

  async renameFolder(folderId: string, name: string): Promise<LibraryFolderDescriptor> {
    return await this.#folders.renameFolder(folderId, name);
  }

  async assignFolders(
    assetIds: readonly string[],
    folderIds: readonly string[]
  ): Promise<FolderMembershipMutationResult> {
    return await this.#folders.assignFolders(assetIds, folderIds);
  }

  async removeFolders(
    assetIds: readonly string[],
    folderIds: readonly string[]
  ): Promise<FolderMembershipMutationResult> {
    return await this.#folders.removeFolders(assetIds, folderIds);
  }
}
