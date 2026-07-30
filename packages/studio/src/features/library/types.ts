import type {
  LibraryAssetDetail,
  LibraryFolderDescriptor,
  StudioLibrarySearchItem
} from "@routego-image/contracts";

import type { CreationDraft } from "../creation";

export type LibraryView = "library" | "trash";
export type LibraryAssetRelationship = LibraryAssetDetail["relationships"][number];

export interface LibraryFilters {
  readonly query: string;
  readonly providerId: string;
  readonly timeRange:
    | "all"
    | "today"
    | "last-24-hours"
    | "last-7-days"
    | "last-30-days"
    | "custom";
  readonly from: string;
  readonly to: string;
  readonly kinds: readonly ("generate" | "edit")[];
  readonly sizes: readonly string[];
  readonly statuses: readonly (
    | "queued"
    | "running"
    | "succeeded"
    | "partial"
    | "failed"
    | "deleted"
  )[];
  readonly folderId?: string | undefined;
  readonly sort: "created-desc" | "created-asc" | "prompt-asc" | "prompt-desc";
  readonly limit: number;
}

export interface LibraryPageState {
  readonly cursors: readonly (string | undefined)[];
  readonly index: number;
}

export type LibrarySearchState =
  | { readonly status: "loading" }
  | { readonly status: "empty"; readonly total?: number | undefined }
  | {
      readonly status: "ready";
      readonly items: readonly StudioLibrarySearchItem[];
      readonly nextCursor?: string | undefined;
      readonly total?: number | undefined;
    }
  | { readonly status: "failure"; readonly safeMessage: string };

export type FolderState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly folders: readonly LibraryFolderDescriptor[] }
  | { readonly status: "failure"; readonly safeMessage: string };

export type AssetDetailState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly assetId: string }
  | { readonly status: "ready"; readonly asset: LibraryAssetDetail }
  | { readonly status: "failure"; readonly assetId: string; readonly safeMessage: string };

export type RelationshipResourceState =
  | { readonly status: "loading"; readonly relationship: LibraryAssetRelationship }
  | {
      readonly status: "ready";
      readonly relationship: LibraryAssetRelationship;
      readonly resource: import("@routego-image/contracts").BrowserResourceDescriptor;
    }
  | {
      readonly status: "failure";
      readonly relationship: LibraryAssetRelationship;
      readonly safeMessage: string;
    };

export interface LibraryCreationHandoff {
  readonly action: "retry" | "edit";
  readonly assetId: string;
  readonly draft: CreationDraft;
}
