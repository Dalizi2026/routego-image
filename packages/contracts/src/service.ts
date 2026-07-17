import type { z } from "zod";

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

export interface RoutegoService {
  status(input: RoutegoStatusInput): Promise<RoutegoStatusResult>;
  generate(input: RoutegoGenerateInput): Promise<ImageOperationResult>;
  edit(input: RoutegoEditInput): Promise<ImageOperationResult>;
  batch(input: RoutegoBatchInput): Promise<RoutegoBatchResult>;
  searchLibrary(input: RoutegoSearchLibraryInput): Promise<RoutegoSearchLibraryResult>;
  manageLibrary(input: RoutegoManageLibraryInput): Promise<RoutegoManageLibraryResult>;
  openStudio(input: RoutegoOpenStudioInput): Promise<RoutegoOpenStudioResult>;
}

export function parseRoutegoOperationInput(operation: RoutegoOperation, input: unknown): unknown {
  return routegoOperationDefinitions[operation].inputSchema.parse(input);
}

export function parseRoutegoOperationOutput(operation: RoutegoOperation, output: unknown): unknown {
  return routegoOperationDefinitions[operation].outputSchema.parse(output);
}
