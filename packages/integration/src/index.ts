export const ROUTEGO_INTEGRATION_PACKAGE_VERSION = 1 as const;

export * from "./cli";
export * from "./composition/service";
export * from "./runtime/mcp-process";
export * from "./runtime/stream-route";
export * from "./runtime/background-removal-resources";
export { processBackgroundRemovalRequest } from "./runtime/background-removal-worker";

export type {
  StudioImageOperationEvent,
  StudioImageOperationRequest
} from "@routego-image/contracts";
