import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  ExecuteLibraryMutationResult,
  LibraryFolderDescriptor,
  PreflightLibraryMutationResult
} from "@routego-image/contracts";

import type { StudioGateway } from "../src/api";
import { I18nProvider } from "../src/i18n";
import {
  LibraryMutationPanel,
  buildAssetLibraryMutation,
  buildZipImportMutation,
  executionConfirmations,
  moveFolderIds,
  mutationResultCounts,
  remainingSelectedAssetIds
} from "../src/features/library";

const folders: readonly LibraryFolderDescriptor[] = [
  {
    id: "folder-a",
    name: "A",
    order: 0,
    assetCount: 2,
    state: "active",
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z"
  },
  {
    id: "folder-b",
    name: "B",
    order: 1,
    assetCount: 1,
    state: "active",
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z"
  }
];

const preflight: PreflightLibraryMutationResult = {
  schemaVersion: 1,
  preflightId: "preflight-assign-folders",
  action: "assign-folders",
  status: "partial",
  expiresAt: "2026-07-18T01:00:00.000Z",
  requiredConfirmations: [],
  items: [
    {
      targetId: "asset-a",
      targetKind: "asset",
      eligible: true,
      currentStatus: "succeeded",
      allowedActions: ["assign-folders"],
      requiredConfirmations: [],
      warnings: []
    },
    {
      targetId: "asset-b",
      targetKind: "asset",
      eligible: false,
      currentStatus: "succeeded",
      allowedActions: ["assign-folders"],
      requiredConfirmations: [],
      warnings: [],
      error: {
        code: "conflict",
        category: "persistence",
        stage: "persist",
        safeMessage: "The asset changed after selection.",
        retryDisposition: "user-confirmation",
        partialArtifacts: [],
        receivedAnyOutput: false,
        mayHaveBilled: false,
        httpStatus: 409
      }
    }
  ],
  warnings: []
};

const partialResult: ExecuteLibraryMutationResult = {
  schemaVersion: 1,
  preflightId: "preflight-assign-folders",
  action: "assign-folders",
  status: "partial",
  items: [
    {
      targetId: "asset-a",
      status: "succeeded",
      affectedAssetId: "asset-a",
      affectedFolderIds: [],
      warnings: []
    },
    {
      targetId: "asset-b",
      status: "failed",
      affectedFolderIds: [],
      warnings: [],
      error: {
        code: "conflict",
        category: "persistence",
        stage: "persist",
        safeMessage: "The asset changed after preflight.",
        retryDisposition: "user-confirmation",
        partialArtifacts: [],
        receivedAnyOutput: false,
        mayHaveBilled: false,
        httpStatus: 409
      }
    }
  ],
  warnings: []
};

describe("Library folder ordering and safe mutation workflow", () => {
  it("builds complete ordered, deduplicated, path-free folder mutations", () => {
    expect(moveFolderIds(["folder-a", "folder-b", "folder-c"], "folder-b", -1)).toEqual([
      "folder-b",
      "folder-a",
      "folder-c"
    ]);
    expect(moveFolderIds(["folder-a", "folder-b"], "folder-a", -1)).toEqual([
      "folder-a",
      "folder-b"
    ]);
    expect(() => moveFolderIds(["folder-a", "folder-a"], "folder-a", 1)).toThrow(
      /重复项/u
    );

    const mutation = buildAssetLibraryMutation(
      "assign-folders",
      ["asset-a", "asset-a", "asset-b"],
      ["folder-a", "folder-b", "folder-a"]
    );
    expect(mutation).toEqual({
      action: "assign-folders",
      assetIds: ["asset-a", "asset-b"],
      folderIds: ["folder-a", "folder-b"]
    });
    expect(JSON.stringify(mutation)).not.toMatch(
      /(?:path|file:\/\/|[A-Za-z]:\\|\/Users\/|data:image|base64)/iu
    );
  });

  it("preserves failed items after partial safe folder assignment", () => {
    expect(executionConfirmations(preflight, "", Date.parse("2026-07-18T00:30:00.000Z"))).toEqual([]);

    expect(mutationResultCounts(partialResult)).toEqual({
      succeeded: 1,
      failed: 1,
      skipped: 0
    });
    expect(remainingSelectedAssetIds(["asset-a", "asset-b"], partialResult)).toEqual([
      "asset-b"
    ]);
  });

  it("prevents false ZIP resource reuse and renders only non-destructive Library controls", () => {
    expect(buildZipImportMutation("upload-zip-01", false)).toEqual({
      action: "import-zip",
      uploadResourceId: "upload-zip-01"
    });
    expect(() => buildZipImportMutation("upload-zip-01", true)).toThrow(/重新选择/u);

    const common = {
      gateway: {} as StudioGateway,
      folders,
      selectedAssetIds: ["asset-a"],
      onFoldersChange: () => undefined,
      onMutationResult: () => undefined,
      onRefresh: () => undefined
    };
    const libraryMarkup = renderToStaticMarkup(
      createElement(
        I18nProvider,
        {
          initialLanguage: "en",
          children: createElement(LibraryMutationPanel, { ...common, view: "library" })
        }
      )
    );
    expect(libraryMarkup).toContain("Create folder");
    expect(libraryMarkup).toContain("Rename folder");
    expect(libraryMarkup).toContain("Save complete order");
    expect(libraryMarkup).toContain("Assign folders");
    expect(libraryMarkup).toContain('type="file"');
    expect(libraryMarkup).toContain('accept="application/zip,.zip"');

    expect(libraryMarkup).not.toMatch(/Trash|Restore selected|Permanent delete|Soft delete/u);
    expect(libraryMarkup).not.toMatch(
      /(?:C:\\|\/Users\/|data:image|base64|Authorization)/u
    );
  });
});
