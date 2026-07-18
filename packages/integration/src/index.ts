export const ROUTEGO_INTEGRATION_PACKAGE_VERSION = 1 as const;

export * from "./runtime/stream-route";

export type {
  StudioImageOperationEvent,
  StudioImageOperationRequest
} from "@routego-image/contracts";
