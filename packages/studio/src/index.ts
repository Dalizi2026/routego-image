export const ROUTEGO_STUDIO_PACKAGE_VERSION = 1 as const;

export * from "./api";

export type {
  BrowserResourceDescriptor,
  LibraryAssetDetail,
  LocalRoutegoService,
  ProviderProfileDescriptor
} from "@routego-image/contracts";
export type { ReactElement, ReactNode } from "react";
