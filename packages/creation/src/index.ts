export const ROUTEGO_CREATION_PACKAGE_VERSION = 1 as const;

export * from "./execution";
export * from "./provider";
export * from "./runtime/http";
export * from "./runtime/mcp";

export type {
  ImageOperationRequest,
  ImageOperationResult,
  LocalRoutegoService,
  ProviderCapabilityRecord
} from "@routego-image/contracts";
export type { ProviderRouteDecision } from "@routego-image/foundation";
