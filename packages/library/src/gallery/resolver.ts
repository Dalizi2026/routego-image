import { identifierSchema, type UploadResourcePurpose } from "@routego-image/contracts";

import { LibraryError } from "../errors";
import { UploadStore, type ResolvedUploadResource } from "../upload/store";
import { LibraryAssetStore, type ResolvedLibraryResource } from "./assets";

export type StableImageLocator =
  | { readonly source: "asset"; readonly assetId: string }
  | { readonly source: "artifact"; readonly artifactId: string }
  | { readonly source: "upload"; readonly uploadResourceId: string };

export type ResolvedStableImageResource =
  | ({ readonly source: "asset" | "artifact" } & ResolvedLibraryResource)
  | ({ readonly source: "upload" } & ResolvedUploadResource);

export interface LibraryResourceResolverOptions {
  readonly assets: LibraryAssetStore;
  readonly uploads: UploadStore;
}

export class LibraryResourceResolver {
  readonly #assets: LibraryAssetStore;
  readonly #uploads: UploadStore;

  constructor(options: LibraryResourceResolverOptions) {
    this.#assets = options.assets;
    this.#uploads = options.uploads;
  }

  async resolve(
    locator: StableImageLocator,
    expectedUploadPurposes?: readonly UploadResourcePurpose[]
  ): Promise<ResolvedStableImageResource> {
    if (locator === null || typeof locator !== "object") {
      throw new LibraryError("invalid_input", "The stable image locator is invalid.");
    }
    if (locator.source === "asset") {
      const assetId = identifierSchema.parse(locator.assetId);
      return { source: "asset", ...(await this.#assets.resolveAsset(assetId)) };
    }
    if (locator.source === "artifact") {
      const artifactId = identifierSchema.parse(locator.artifactId);
      return { source: "artifact", ...(await this.#assets.resolveArtifact(artifactId)) };
    }
    if (locator.source === "upload") {
      const uploadResourceId = identifierSchema.parse(locator.uploadResourceId);
      return {
        source: "upload",
        ...(await this.#uploads.resolveUploadResource(uploadResourceId, expectedUploadPurposes))
      };
    }
    throw new LibraryError("invalid_input", "The stable image locator source is unsupported.");
  }
}
