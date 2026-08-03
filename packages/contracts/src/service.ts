import type { z } from "zod";

import {
  executeLibraryMutationInputSchema,
  executeLibraryMutationResultSchema,
  confirmLegacyLibraryMigrationInputSchema,
  confirmLegacyLibraryMigrationResultSchema,
  getAssetDetailInputSchema,
  getAssetDetailResultSchema,
  getBrowserResourceInputSchema,
  getBrowserResourceResultSchema,
  listFoldersInputSchema,
  listFoldersResultSchema,
  legacyLibraryMigrationStateSchema,
  preflightLibraryMutationInputSchema,
  preflightLibraryMutationResultSchema,
  readLegacyLibraryMigrationInputSchema,
  reorderFoldersInputSchema,
  reorderFoldersResultSchema,
  studioLibrarySearchInputSchema,
  studioLibrarySearchResultSchema,
  type ExecuteLibraryMutationInput,
  type ExecuteLibraryMutationResult,
  type ConfirmLegacyLibraryMigrationInput,
  type ConfirmLegacyLibraryMigrationResult,
  type GetAssetDetailInput,
  type GetAssetDetailResult,
  type GetBrowserResourceInput,
  type GetBrowserResourceResult,
  type ListFoldersInput,
  type ListFoldersResult,
  type LegacyLibraryMigrationState,
  type PreflightLibraryMutationInput,
  type PreflightLibraryMutationResult,
  type ReadLegacyLibraryMigrationInput,
  type ReorderFoldersInput,
  type ReorderFoldersResult,
  type StudioLibrarySearchInput,
  type StudioLibrarySearchResult
} from "./library";
import {
  readSettingsInputSchema,
  readSettingsResultSchema,
  refreshModelsInputSchema,
  refreshModelsResultSchema,
  removeProviderProfileInputSchema,
  removeProviderProfileResultSchema,
  setActiveProviderProfileInputSchema,
  setActiveProviderProfileResultSchema,
  studioProviderSwitchInputSchema,
  studioProviderSwitchResultSchema,
  upsertProviderProfileInputSchema,
  upsertProviderProfileResultSchema,
  updateSettingsInputSchema,
  updateSettingsResultSchema,
  type ReadSettingsInput,
  type ReadSettingsResult,
  type RefreshModelsInput,
  type RefreshModelsResult,
  type RemoveProviderProfileInput,
  type RemoveProviderProfileResult,
  type SetActiveProviderProfileInput,
  type SetActiveProviderProfileResult,
  type StudioProviderSwitchInput,
  type StudioProviderSwitchResult,
  type UpsertProviderProfileInput,
  type UpsertProviderProfileResult,
  type UpdateSettingsInput,
  type UpdateSettingsResult
} from "./settings";
import {
  studioBatchInputSchema,
  studioBatchResultSchema,
  studioGenerateInputSchema,
  studioImageOperationResultSchema,
  type StudioBatchInput,
  type StudioBatchResult,
  type StudioGenerateInput,
  type StudioImageOperationResult
} from "./studio-creation";
import {
  imageOperationResultSchema,
  routegoBatchInputSchema,
  routegoBatchResultSchema,
  routegoEditInputSchema,
  routegoGenerateInputSchema,
  routegoManageLibraryInputSchema,
  routegoManageLibraryResultSchema,
  routegoOpenStudioInputSchema,
  routegoOpenStudioResultSchema,
  routegoPrepareRegenerationInputSchema,
  routegoPrepareRegenerationResultSchema,
  routegoSearchLibraryInputSchema,
  routegoSearchLibraryResultSchema,
  routegoStatusInputSchema,
  routegoStatusResultSchema,
  type ImageOperationResult,
  type RoutegoBatchInput,
  type RoutegoBatchResult,
  type RoutegoEditInput,
  type RoutegoGenerateInput,
  type RoutegoManageLibraryInput,
  type RoutegoManageLibraryResult,
  type RoutegoOpenStudioInput,
  type RoutegoOpenStudioResult,
  type RoutegoPrepareRegenerationInput,
  type RoutegoPrepareRegenerationResult,
  type RoutegoSearchLibraryInput,
  type RoutegoSearchLibraryResult,
  type RoutegoStatusInput,
  type RoutegoStatusResult
} from "./tools";
import {
  discardUploadResourceInputSchema,
  discardUploadResourceResultSchema,
  finalizeUploadResourceInputSchema,
  finalizeUploadResourceResultSchema,
  getUploadResourceStatusInputSchema,
  getUploadResourceStatusResultSchema,
  reserveUploadResourceInputSchema,
  reserveUploadResourceResultSchema,
  type DiscardUploadResourceInput,
  type DiscardUploadResourceResult,
  type FinalizeUploadResourceInput,
  type FinalizeUploadResourceResult,
  type GetUploadResourceStatusInput,
  type GetUploadResourceStatusResult,
  type ReserveUploadResourceInput,
  type ReserveUploadResourceResult
} from "./upload";

export const routegoOperationNames = [
  "status",
  "generate",
  "edit",
  "prepareRegeneration",
  "batch",
  "searchLibrary",
  "manageLibrary",
  "openStudio"
] as const;

export type RoutegoOperation = (typeof routegoOperationNames)[number];

export const studioOperationNames = [
  "readLegacyLibraryMigration",
  "confirmLegacyLibraryMigration",
  "readSettings",
  "upsertProviderProfile",
  "removeProviderProfile",
  "setActiveProviderProfile",
  "studioProviderSwitch",
  "refreshModels",
  "listFolders",
  "reorderFolders",
  "getAssetDetail",
  "getBrowserResource",
  "preflightLibraryMutation",
  "executeLibraryMutation",
  "reserveUploadResource",
  "finalizeUploadResource",
  "getUploadResourceStatus",
  "discardUploadResource",
  "studioGenerate",
  "studioBatch",
  "searchStudioLibrary",
  "updateSettings"
] as const;

export type StudioOperation = (typeof studioOperationNames)[number];

export const routegoOperationDefinitions = {
  status: {
    toolName: "routego_status",
    http: { method: "GET", path: "/api/v1/status" },
    inputSchema: routegoStatusInputSchema,
    outputSchema: routegoStatusResultSchema
  },
  generate: {
    toolName: "routego_generate",
    http: { method: "POST", path: "/api/v1/generate" },
    inputSchema: routegoGenerateInputSchema,
    outputSchema: imageOperationResultSchema
  },
  edit: {
    toolName: "routego_edit",
    http: { method: "POST", path: "/api/v1/edit" },
    inputSchema: routegoEditInputSchema,
    outputSchema: imageOperationResultSchema
  },
  prepareRegeneration: {
    toolName: "routego_prepare_regeneration",
    http: { method: "POST", path: "/api/v1/prepare-regeneration" },
    inputSchema: routegoPrepareRegenerationInputSchema,
    outputSchema: routegoPrepareRegenerationResultSchema
  },
  batch: {
    toolName: "routego_batch",
    http: { method: "POST", path: "/api/v1/batch" },
    inputSchema: routegoBatchInputSchema,
    outputSchema: routegoBatchResultSchema
  },
  searchLibrary: {
    toolName: "routego_search_library",
    http: { method: "POST", path: "/api/v1/library/search" },
    inputSchema: routegoSearchLibraryInputSchema,
    outputSchema: routegoSearchLibraryResultSchema
  },
  manageLibrary: {
    toolName: "routego_manage_library",
    http: { method: "POST", path: "/api/v1/library/manage" },
    inputSchema: routegoManageLibraryInputSchema,
    outputSchema: routegoManageLibraryResultSchema
  },
  openStudio: {
    toolName: "routego_open_studio",
    http: { method: "POST", path: "/api/v1/studio/open" },
    inputSchema: routegoOpenStudioInputSchema,
    outputSchema: routegoOpenStudioResultSchema
  }
} as const satisfies Record<
  RoutegoOperation,
  {
    toolName: string;
    http: { method: "GET" | "POST"; path: string };
    inputSchema: z.ZodType;
    outputSchema: z.ZodType;
  }
>;

export const studioOperationDefinitions = {
  readLegacyLibraryMigration: {
    http: { method: "GET", path: "/api/v1/library/legacy-migration" },
    inputSchema: readLegacyLibraryMigrationInputSchema,
    outputSchema: legacyLibraryMigrationStateSchema
  },
  confirmLegacyLibraryMigration: {
    http: { method: "POST", path: "/api/v1/library/legacy-migration/confirm" },
    inputSchema: confirmLegacyLibraryMigrationInputSchema,
    outputSchema: confirmLegacyLibraryMigrationResultSchema
  },
  readSettings: {
    http: { method: "GET", path: "/api/v1/settings" },
    inputSchema: readSettingsInputSchema,
    outputSchema: readSettingsResultSchema
  },
  upsertProviderProfile: {
    http: { method: "POST", path: "/api/v1/settings/providers/upsert" },
    inputSchema: upsertProviderProfileInputSchema,
    outputSchema: upsertProviderProfileResultSchema
  },
  removeProviderProfile: {
    http: { method: "POST", path: "/api/v1/settings/providers/remove" },
    inputSchema: removeProviderProfileInputSchema,
    outputSchema: removeProviderProfileResultSchema
  },
  setActiveProviderProfile: {
    http: { method: "POST", path: "/api/v1/settings/providers/set-active" },
    inputSchema: setActiveProviderProfileInputSchema,
    outputSchema: setActiveProviderProfileResultSchema
  },
  studioProviderSwitch: {
    http: { method: "POST", path: "/api/v1/studio/provider-switch" },
    inputSchema: studioProviderSwitchInputSchema,
    outputSchema: studioProviderSwitchResultSchema
  },
  refreshModels: {
    http: { method: "POST", path: "/api/v1/settings/providers/refresh-models" },
    inputSchema: refreshModelsInputSchema,
    outputSchema: refreshModelsResultSchema
  },
  listFolders: {
    http: { method: "GET", path: "/api/v1/library/folders" },
    inputSchema: listFoldersInputSchema,
    outputSchema: listFoldersResultSchema
  },
  reorderFolders: {
    http: { method: "POST", path: "/api/v1/library/folders/reorder" },
    inputSchema: reorderFoldersInputSchema,
    outputSchema: reorderFoldersResultSchema
  },
  getAssetDetail: {
    http: { method: "POST", path: "/api/v1/library/assets/detail" },
    inputSchema: getAssetDetailInputSchema,
    outputSchema: getAssetDetailResultSchema
  },
  getBrowserResource: {
    http: { method: "POST", path: "/api/v1/library/resources/resolve" },
    inputSchema: getBrowserResourceInputSchema,
    outputSchema: getBrowserResourceResultSchema
  },
  preflightLibraryMutation: {
    http: { method: "POST", path: "/api/v1/library/mutations/preflight" },
    inputSchema: preflightLibraryMutationInputSchema,
    outputSchema: preflightLibraryMutationResultSchema
  },
  executeLibraryMutation: {
    http: { method: "POST", path: "/api/v1/library/mutations/execute" },
    inputSchema: executeLibraryMutationInputSchema,
    outputSchema: executeLibraryMutationResultSchema
  },
  reserveUploadResource: {
    http: { method: "POST", path: "/api/v1/uploads/reserve" },
    inputSchema: reserveUploadResourceInputSchema,
    outputSchema: reserveUploadResourceResultSchema
  },
  finalizeUploadResource: {
    http: { method: "POST", path: "/api/v1/uploads/finalize" },
    inputSchema: finalizeUploadResourceInputSchema,
    outputSchema: finalizeUploadResourceResultSchema
  },
  getUploadResourceStatus: {
    http: { method: "POST", path: "/api/v1/uploads/status" },
    inputSchema: getUploadResourceStatusInputSchema,
    outputSchema: getUploadResourceStatusResultSchema
  },
  discardUploadResource: {
    http: { method: "POST", path: "/api/v1/uploads/discard" },
    inputSchema: discardUploadResourceInputSchema,
    outputSchema: discardUploadResourceResultSchema
  },
  studioGenerate: {
    http: { method: "POST", path: "/api/v1/studio/creation/generate" },
    inputSchema: studioGenerateInputSchema,
    outputSchema: studioImageOperationResultSchema
  },
  studioBatch: {
    http: { method: "POST", path: "/api/v1/studio/creation/batch" },
    inputSchema: studioBatchInputSchema,
    outputSchema: studioBatchResultSchema
  },
  searchStudioLibrary: {
    http: { method: "POST", path: "/api/v1/studio/library/search" },
    inputSchema: studioLibrarySearchInputSchema,
    outputSchema: studioLibrarySearchResultSchema
  },
  updateSettings: {
    http: { method: "POST", path: "/api/v1/settings/update" },
    inputSchema: updateSettingsInputSchema,
    outputSchema: updateSettingsResultSchema
  }
} as const satisfies Record<
  StudioOperation,
  {
    http: { method: "GET" | "POST"; path: string };
    inputSchema: z.ZodType;
    outputSchema: z.ZodType;
  }
>;

export interface RoutegoService {
  status(input: RoutegoStatusInput): Promise<RoutegoStatusResult>;
  generate(input: RoutegoGenerateInput): Promise<ImageOperationResult>;
  edit(input: RoutegoEditInput): Promise<ImageOperationResult>;
  prepareRegeneration(
    input: RoutegoPrepareRegenerationInput
  ): Promise<RoutegoPrepareRegenerationResult>;
  batch(input: RoutegoBatchInput): Promise<RoutegoBatchResult>;
  searchLibrary(input: RoutegoSearchLibraryInput): Promise<RoutegoSearchLibraryResult>;
  manageLibrary(input: RoutegoManageLibraryInput): Promise<RoutegoManageLibraryResult>;
  openStudio(input: RoutegoOpenStudioInput): Promise<RoutegoOpenStudioResult>;
}

export interface StudioSettingsService {
  readSettings(input: ReadSettingsInput): Promise<ReadSettingsResult>;
  upsertProviderProfile(input: UpsertProviderProfileInput): Promise<UpsertProviderProfileResult>;
  removeProviderProfile(input: RemoveProviderProfileInput): Promise<RemoveProviderProfileResult>;
  setActiveProviderProfile(
    input: SetActiveProviderProfileInput
  ): Promise<SetActiveProviderProfileResult>;
  studioProviderSwitch(input: StudioProviderSwitchInput): Promise<StudioProviderSwitchResult>;
  refreshModels(input: RefreshModelsInput): Promise<RefreshModelsResult>;
  updateSettings(input: UpdateSettingsInput): Promise<UpdateSettingsResult>;
}

export interface StudioLibraryService {
  readLegacyLibraryMigration(input: ReadLegacyLibraryMigrationInput): Promise<LegacyLibraryMigrationState>;
  confirmLegacyLibraryMigration(
    input: ConfirmLegacyLibraryMigrationInput
  ): Promise<ConfirmLegacyLibraryMigrationResult>;
  searchStudioLibrary(input: StudioLibrarySearchInput): Promise<StudioLibrarySearchResult>;
  listFolders(input: ListFoldersInput): Promise<ListFoldersResult>;
  reorderFolders(input: ReorderFoldersInput): Promise<ReorderFoldersResult>;
  getAssetDetail(input: GetAssetDetailInput): Promise<GetAssetDetailResult>;
  getBrowserResource(input: GetBrowserResourceInput): Promise<GetBrowserResourceResult>;
  preflightLibraryMutation(
    input: PreflightLibraryMutationInput
  ): Promise<PreflightLibraryMutationResult>;
  executeLibraryMutation(
    input: ExecuteLibraryMutationInput
  ): Promise<ExecuteLibraryMutationResult>;
}

export interface StudioUploadService {
  reserveUploadResource(input: ReserveUploadResourceInput): Promise<ReserveUploadResourceResult>;
  finalizeUploadResource(
    input: FinalizeUploadResourceInput
  ): Promise<FinalizeUploadResourceResult>;
  getUploadResourceStatus(
    input: GetUploadResourceStatusInput
  ): Promise<GetUploadResourceStatusResult>;
  discardUploadResource(
    input: DiscardUploadResourceInput
  ): Promise<DiscardUploadResourceResult>;
}

export interface StudioCreationService {
  studioGenerate(input: StudioGenerateInput): Promise<StudioImageOperationResult>;
  studioBatch(input: StudioBatchInput): Promise<StudioBatchResult>;
}

export interface LocalRoutegoService
  extends RoutegoService,
    StudioSettingsService,
    StudioLibraryService,
    StudioUploadService,
    StudioCreationService {}

export function parseRoutegoOperationInput(operation: RoutegoOperation, input: unknown): unknown {
  return routegoOperationDefinitions[operation].inputSchema.parse(input);
}

export function parseRoutegoOperationOutput(operation: RoutegoOperation, output: unknown): unknown {
  return routegoOperationDefinitions[operation].outputSchema.parse(output);
}

export function parseStudioOperationInput(operation: StudioOperation, input: unknown): unknown {
  return studioOperationDefinitions[operation].inputSchema.parse(input);
}

export function parseStudioOperationOutput(operation: StudioOperation, output: unknown): unknown {
  return studioOperationDefinitions[operation].outputSchema.parse(output);
}
