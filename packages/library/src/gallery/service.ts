import {
  routegoManageLibraryInputSchema,
  routegoManageLibraryResultSchema,
  type ExecuteLibraryMutationInput,
  type ExecuteLibraryMutationResult,
  type CopyGenerationInfoInput,
  type CopyGenerationInfoResult,
  type GetAssetDetailInput,
  type GetAssetDetailResult,
  type GetBrowserResourceInput,
  type GetBrowserResourceResult,
  type ListFoldersInput,
  type ListFoldersResult,
  type PreflightLibraryMutationInput,
  type PreflightLibraryMutationResult,
  type ReorderFoldersInput,
  type ReorderFoldersResult,
  type RoutegoManageLibraryInput,
  type RoutegoManageLibraryResult,
  type RoutegoSearchLibraryInput,
  type RoutegoSearchLibraryResult,
  type RoutegoPrepareRegenerationInput,
  type RoutegoPrepareRegenerationResult,
  type RoutegoService,
  type StudioLibrarySearchInput,
  type StudioLibrarySearchResult,
  type StudioLibraryService
} from "@routego-image/contracts";

import { LibraryError } from "../errors";
import { ImageLibraryIndexStore } from "./index-store";
import {
  LibraryMutationStore,
  type LibraryMutationStoreOptions
} from "./mutations";
import { LibraryReadService, type LibraryReadServiceOptions } from "./read-service";

export interface GalleryServiceOptions {
  readonly indexStore: ImageLibraryIndexStore;
  readonly readService?: LibraryReadService;
  readonly mutationStore?: LibraryMutationStore;
  readonly readOptions?: Omit<LibraryReadServiceOptions, "indexStore">;
  readonly mutationOptions?: Omit<LibraryMutationStoreOptions, "indexStore">;
}

export class GalleryService
  implements Pick<RoutegoService, "searchLibrary" | "manageLibrary">, StudioLibraryService
{
  readonly #read: LibraryReadService;
  readonly #mutations: LibraryMutationStore;

  constructor(options: GalleryServiceOptions) {
    this.#read =
      options.readService ??
      new LibraryReadService({ indexStore: options.indexStore, ...options.readOptions });
    this.#mutations =
      options.mutationStore ??
      new LibraryMutationStore({ indexStore: options.indexStore, ...options.mutationOptions });
  }

  get readService(): LibraryReadService {
    return this.#read;
  }

  get mutationStore(): LibraryMutationStore {
    return this.#mutations;
  }

  async searchLibrary(input: RoutegoSearchLibraryInput): Promise<RoutegoSearchLibraryResult> {
    return await this.#read.searchLibrary(input);
  }

  async searchStudioLibrary(
    input: StudioLibrarySearchInput
  ): Promise<StudioLibrarySearchResult> {
    return await this.#read.searchStudioLibrary(input);
  }

  async copyGenerationInfo(input: CopyGenerationInfoInput): Promise<CopyGenerationInfoResult> {
    return await this.#read.copyGenerationInfo(input);
  }

  async prepareRegeneration(
    input: RoutegoPrepareRegenerationInput
  ): Promise<RoutegoPrepareRegenerationResult> {
    return await this.#read.prepareRegeneration(input);
  }

  async listFolders(input: ListFoldersInput): Promise<ListFoldersResult> {
    return await this.#read.listFolders(input);
  }

  async reorderFolders(input: ReorderFoldersInput): Promise<ReorderFoldersResult> {
    return await this.#read.reorderFolders(input);
  }

  async getAssetDetail(input: GetAssetDetailInput): Promise<GetAssetDetailResult> {
    return await this.#read.getAssetDetail(input);
  }

  async getBrowserResource(input: GetBrowserResourceInput): Promise<GetBrowserResourceResult> {
    return await this.#read.getBrowserResource(input);
  }

  async preflightLibraryMutation(
    input: PreflightLibraryMutationInput
  ): Promise<PreflightLibraryMutationResult> {
    return await this.#mutations.preflight(input);
  }

  async executeLibraryMutation(
    input: ExecuteLibraryMutationInput
  ): Promise<ExecuteLibraryMutationResult> {
    return await this.#mutations.execute(input);
  }

  async manageLibrary(input: RoutegoManageLibraryInput): Promise<RoutegoManageLibraryResult> {
    const parsed = routegoManageLibraryInputSchema.parse(input);
    if (parsed.action === "create-folder") {
      const folder = await this.#read.createFolder(parsed.name);
      return routegoManageLibraryResultSchema.parse({
        schemaVersion: 1,
        action: parsed.action,
        affectedAssetIds: [],
        affectedFolderIds: [folder.id],
        warnings: []
      });
    }
    if (parsed.action === "rename-folder") {
      const folder = await this.#read.renameFolder(parsed.folderId, parsed.name);
      return routegoManageLibraryResultSchema.parse({
        schemaVersion: 1,
        action: parsed.action,
        affectedAssetIds: [],
        affectedFolderIds: [folder.id],
        warnings: []
      });
    }
    if (parsed.action === "export-zip" || parsed.action === "import-zip") {
      throw new LibraryError(
        "capability_unavailable",
        "ZIP portability is not available in the current Library implementation."
      );
    }

    const assetIds = [...new Set(parsed.assetIds)];
    const mutation =
      parsed.action === "assign-folders" || parsed.action === "remove-folders"
        ? { action: parsed.action, assetIds, folderIds: [...new Set(parsed.folderIds)] }
        : { action: parsed.action, assetIds };
    const preflight = await this.#mutations.preflight({ mutation });
    const execution = await this.#mutations.execute({
      preflightId: preflight.preflightId,
      action: parsed.action,
      confirmations: parsed.action === "permanent-delete" ? ["permanent-delete"] : []
    });
    const affectedAssetIds = execution.items.flatMap((item) =>
      item.status === "succeeded" && item.affectedAssetId ? [item.affectedAssetId] : []
    );
    const affectedFolderIds = [
      ...new Set(
        execution.items.flatMap((item) =>
          item.status === "succeeded" ? item.affectedFolderIds : []
        )
      )
    ];
    const warnings = [
      ...execution.warnings,
      ...execution.items.flatMap((item) =>
        item.status === "failed"
          ? [
              `${item.targetId}: ${item.error?.safeMessage ?? "The mutation failed."}`.slice(
                0,
                1_000
              )
            ]
          : item.warnings
      )
    ].slice(0, 100);
    return routegoManageLibraryResultSchema.parse({
      schemaVersion: 1,
      action: parsed.action,
      affectedAssetIds,
      affectedFolderIds,
      warnings
    });
  }

  async recover(): Promise<void> {
    await this.#mutations.recover();
  }
}
