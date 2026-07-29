export const ROUTEGO_LIBRARY_PACKAGE_VERSION = 1 as const;

export type {
  BrowserResourceDescriptor,
  LibraryAssetDetail,
  LibraryMutationRequest,
  LocalRoutegoService
} from "@routego-image/contracts";
export type { ResolveContainedPathOptions } from "@routego-image/foundation";

export * from "./errors";
export * from "./config/model";
export * from "./config/output-directory";
export * from "./config/store";
export * from "./image/metadata";
export * from "./upload/model";
export * from "./upload/store";
export * from "./gallery/model";
export * from "./gallery/migration";
export * from "./gallery/index-store";
export * from "./gallery/assets";
export * from "./gallery/query";
export * from "./gallery/folders";
export * from "./gallery/resources";
export * from "./gallery/read-service";
export * from "./gallery/mutations";
export * from "./gallery/service";
export * from "./gallery/locations";
export * from "./gallery/resolver";
export * from "./zip/crc32";
export * from "./zip/codec";
export * from "./zip/manifest";
export * from "./zip/portability";
export * from "./service";
