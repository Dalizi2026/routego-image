import type { z } from "zod";

import {
  capabilityProbeInputSchema,
  capabilityProbeResultSchema,
  readSettingsInputSchema,
  readSettingsResultSchema,
  refreshModelsInputSchema,
  refreshModelsResultSchema,
  removeProviderProfileInputSchema,
  removeProviderProfileResultSchema,
  setActiveProviderProfileInputSchema,
  setActiveProviderProfileResultSchema,
  upsertProviderProfileInputSchema,
  upsertProviderProfileResultSchema,
  type CapabilityProbeInput,
  type CapabilityProbeResult,
  type ReadSettingsInput,
  type ReadSettingsResult,
  type RefreshModelsInput,
  type RefreshModelsResult,
  type RemoveProviderProfileInput,
  type RemoveProviderProfileResult,
  type SetActiveProviderProfileInput,
  type SetActiveProviderProfileResult,
  type UpsertProviderProfileInput,
  type UpsertProviderProfileResult
} from "./settings";
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
  type RoutegoSearchLibraryInput,
  type RoutegoSearchLibraryResult,
  type RoutegoStatusInput,
  type RoutegoStatusResult
} from "./tools";

export const routegoOperationNames = [
  "status",
  "generate",
  "edit",
  "batch",
  "searchLibrary",
  "manageLibrary",
  "openStudio"
] as const;

export type RoutegoOperation = (typeof routegoOperationNames)[number];

export const studioOperationNames = [
  "readSettings",
  "upsertProviderProfile",
  "removeProviderProfile",
  "setActiveProviderProfile",
  "refreshModels",
  "probeCapabilities"
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
  refreshModels: {
    http: { method: "POST", path: "/api/v1/settings/providers/refresh-models" },
    inputSchema: refreshModelsInputSchema,
    outputSchema: refreshModelsResultSchema
  },
  probeCapabilities: {
    http: { method: "POST", path: "/api/v1/settings/providers/capability-probe" },
    inputSchema: capabilityProbeInputSchema,
    outputSchema: capabilityProbeResultSchema
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
  refreshModels(input: RefreshModelsInput): Promise<RefreshModelsResult>;
  probeCapabilities(input: CapabilityProbeInput): Promise<CapabilityProbeResult>;
}

export interface LocalRoutegoService extends RoutegoService, StudioSettingsService {}

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
