import { describe, expect, it } from "vitest";

import {
  browserResourceDescriptorSchema,
  executeLibraryMutationInputSchema,
  executeLibraryMutationResultSchema,
  getAssetDetailResultSchema,
  getBrowserResourceResultSchema,
  libraryAssetDetailSchema,
  libraryMutationRequestSchema,
  listFoldersResultSchema,
  parseStudioOperationInput,
  parseStudioOperationOutput,
  preflightLibraryMutationInputSchema,
  preflightLibraryMutationResultSchema,
  relativeBrowserResourceUrlSchema,
  reorderFoldersInputSchema,
  studioOperationDefinitions,
  studioOperationNames
} from "../src/index";
import { TEST_TIMESTAMP } from "./fixtures";

const folderA = {
  id: "folder-a",
  name: "Primary folder",
  order: 0,
  assetCount: 2,
  state: "active" as const,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_TIMESTAMP
};

const folderB = {
  id: "folder-b",
  name: "Archived folder",
  order: 1,
  assetCount: 1,
  state: "deleted" as const,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_TIMESTAMP
};

const execution = {
  transport: "single-endpoint-json" as const,
  attemptCount: 1,
  providerRequestCount: 1,
  receivedAnyOutput: true,
  mayHaveBilled: true,
  degradedContinuation: false,
  providerImageIds: []
};

const requestedParams = {
  kind: "edit" as const,
  prompt: "Replace the sky while preserving the subject.",
  references: [{ assetId: "asset-reference", role: "style" as const, label: "Color" }],
  target: { assetId: "asset-target", label: "Primary target" },
  supportingImages: [
    { assetId: "asset-supporting", role: "supporting" as const, label: "Wardrobe" }
  ],
  maskAssetId: "asset-mask",
  invariants: { allowedChanges: ["sky"], preserve: ["subject"], forbiddenChanges: [] },
  size: "1024x1024",
  aspectRatio: "1:1",
  quality: "high" as const,
  format: "png" as const,
  count: 1,
  partialImages: 0,
  transparentMode: "off" as const,
  moderation: "auto" as const,
  action: "edit" as const,
  imageIds: [],
  fileIds: [],
  outputDirectoryMode: "default" as const,
  saveToLibrary: true
};

const persistenceError = {
  code: "conflict" as const,
  category: "persistence" as const,
  stage: "persist" as const,
  safeMessage: "The synthetic asset changed after preflight.",
  retryDisposition: "user-confirmation" as const,
  partialArtifacts: [],
  receivedAnyOutput: false,
  mayHaveBilled: false
};

const resource = {
  resourceId: "resource-preview-a",
  relativeUrl: "/api/v1/library/resources/resource-preview-a",
  requiresSession: true as const,
  mimeType: "image/png" as const,
  byteLength: 68,
  width: 1,
  height: 1,
  etag: "mock-etag-a",
  expiresAt: TEST_TIMESTAMP
};

describe("folder and complete asset detail contracts", () => {
  it("preserves ordered folders and rejects duplicate reorder identifiers", () => {
    expect(
      listFoldersResultSchema.parse({ schemaVersion: 1, folders: [folderA, folderB] }).folders.map(
        (folder) => folder.id
      )
    ).toEqual(["folder-a", "folder-b"]);
    expect(
      listFoldersResultSchema.safeParse({ schemaVersion: 1, folders: [folderB, folderA] }).success
    ).toBe(false);
    expect(reorderFoldersInputSchema.parse({ folderIds: ["folder-b", "folder-a"] })).toEqual({
      schemaVersion: 1,
      folderIds: ["folder-b", "folder-a"]
    });
    expect(reorderFoldersInputSchema.safeParse({ folderIds: ["folder-a", "folder-a"] }).success).toBe(
      false
    );
  });

  it("represents full parameters, folder state, allowed actions, and every relationship role", () => {
    const asset = libraryAssetDetailSchema.parse({
      id: "asset-output",
      prompt: requestedParams.prompt,
      model: "gpt-image-2",
      kind: "edit",
      status: "succeeded",
      mimeType: "image/png",
      width: 1024,
      height: 1024,
      createdAt: TEST_TIMESTAMP,
      updatedAt: TEST_TIMESTAMP,
      requestedParams,
      effectiveParams: requestedParams,
      execution,
      renditions: [
        {
          artifactId: "artifact-output",
          phase: "final",
          mimeType: "image/png",
          byteLength: 68,
          width: 1024,
          height: 1024,
          sha256: "a".repeat(64),
          createdAt: TEST_TIMESTAMP
        }
      ],
      relationships: [
        { id: "rel-source", role: "source", relatedAssetId: "asset-source", order: 0 },
        { id: "rel-target", role: "target", relatedAssetId: "asset-target", order: 1 },
        { id: "rel-reference", role: "reference", relatedAssetId: "asset-reference", order: 2 },
        {
          id: "rel-supporting",
          role: "supporting",
          relatedAssetId: "asset-supporting",
          order: 3
        },
        { id: "rel-mask", role: "mask", relatedAssetId: "asset-mask", order: 4 },
        {
          id: "rel-output",
          role: "output",
          relatedAssetId: "asset-output",
          artifactId: "artifact-output",
          order: 5
        }
      ],
      folders: [
        { folderId: "folder-a", name: "Primary folder", state: "active", order: 0 },
        { folderId: "folder-b", name: "Archived folder", state: "deleted", order: 1 }
      ],
      allowedActions: ["edit", "retry", "assign-folders", "soft-delete", "export-zip", "download"]
    });

    expect(asset.relationships.map((relationship) => relationship.role)).toEqual([
      "source",
      "target",
      "reference",
      "supporting",
      "mask",
      "output"
    ]);
    expect(asset.requestedParams).toEqual(asset.effectiveParams);
    expect(JSON.stringify(asset)).not.toContain("C:\\");
    expect(JSON.stringify(asset)).not.toContain("/Users/");
  });

  it("returns structured failure instead of fabricated detail", () => {
    const result = getAssetDetailResultSchema.parse({
      schemaVersion: 1,
      status: "failed",
      error: { ...persistenceError, code: "not_found", safeMessage: "Synthetic asset not found." }
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "not_found" } });
    expect(
      getAssetDetailResultSchema.safeParse({
        schemaVersion: 1,
        status: "succeeded",
        error: persistenceError
      }).success
    ).toBe(false);
  });
});

describe("session-protected browser resources", () => {
  it("accepts only relative protected Library URLs with MIME and dimensions", () => {
    expect(browserResourceDescriptorSchema.parse(resource)).toEqual(resource);
    for (const value of [
      "C:\\Users\\person\\Pictures\\image.png",
      "file:///Users/person/Pictures/image.png",
      "https://relay.example/image.png",
      "//relay.example/image.png",
      "/api/v1/library/resources/../secret",
      "/api/v1/library/resources/resource?token=secret"
    ]) {
      expect(relativeBrowserResourceUrlSchema.safeParse(value).success).toBe(false);
    }
  });

  it("fails closed when a resource lookup returns a path-like or incomplete result", () => {
    expect(
      getBrowserResourceResultSchema.parse({
        schemaVersion: 1,
        status: "succeeded",
        resource
      })
    ).toMatchObject({ status: "succeeded", resource: { requiresSession: true } });
    expect(
      getBrowserResourceResultSchema.safeParse({
        schemaVersion: 1,
        status: "succeeded",
        resource: { ...resource, relativeUrl: "C:\\synthetic\\image.png" }
      }).success
    ).toBe(false);
  });
});

describe("preflighted Library mutation and per-item partial results", () => {
  it("uses asset/upload resource identifiers and rejects browser filesystem paths", () => {
    expect(
      preflightLibraryMutationInputSchema.parse({
        mutation: { action: "permanent-delete", assetIds: ["asset-a", "asset-b"] }
      })
    ).toMatchObject({ mutation: { action: "permanent-delete" } });
    expect(
      libraryMutationRequestSchema.parse({
        action: "import-zip",
        uploadResourceId: "upload-zip-a"
      })
    ).toEqual({ action: "import-zip", uploadResourceId: "upload-zip-a" });
    expect(
      libraryMutationRequestSchema.safeParse({
        action: "import-zip",
        zipPath: "C:\\Users\\person\\archive.zip"
      }).success
    ).toBe(false);
  });

  it("reports partial preflight eligibility and required permanent-delete confirmation", () => {
    const result = preflightLibraryMutationResultSchema.parse({
      schemaVersion: 1,
      preflightId: "preflight-delete-a",
      action: "permanent-delete",
      status: "partial",
      expiresAt: TEST_TIMESTAMP,
      requiredConfirmations: ["permanent-delete"],
      items: [
        {
          targetId: "asset-a",
          targetKind: "asset",
          eligible: true,
          currentStatus: "deleted",
          allowedActions: ["restore", "permanent-delete"]
        },
        {
          targetId: "asset-b",
          targetKind: "asset",
          eligible: false,
          currentStatus: "succeeded",
          allowedActions: ["soft-delete"],
          error: persistenceError
        }
      ]
    });
    expect(result.status).toBe("partial");
    expect(result.items.map((item) => item.eligible)).toEqual([true, false]);
  });

  it("requires the preflight identifier and preserves ordered partial execution outcomes", () => {
    expect(
      executeLibraryMutationInputSchema.safeParse({
        preflightId: "preflight-delete-a",
        action: "permanent-delete"
      }).success
    ).toBe(false);
    expect(
      executeLibraryMutationInputSchema.parse({
        preflightId: "preflight-delete-a",
        action: "permanent-delete",
        confirmations: ["permanent-delete"]
      })
    ).toEqual({
      schemaVersion: 1,
      preflightId: "preflight-delete-a",
      action: "permanent-delete",
      confirmations: ["permanent-delete"]
    });

    const result = executeLibraryMutationResultSchema.parse({
      schemaVersion: 1,
      preflightId: "preflight-delete-a",
      action: "permanent-delete",
      status: "partial",
      items: [
        { targetId: "asset-a", status: "succeeded", affectedAssetId: "asset-a" },
        { targetId: "asset-b", status: "failed", error: persistenceError }
      ]
    });
    expect(result.items.map((item) => item.status)).toEqual(["succeeded", "failed"]);
    expect(
      executeLibraryMutationResultSchema.safeParse({
        ...result,
        status: "succeeded"
      }).success
    ).toBe(false);
  });

  it("returns ZIP export only as a protected browser resource", () => {
    const zipResource = {
      ...resource,
      resourceId: "resource-export-zip",
      relativeUrl: "/api/v1/library/resources/resource-export-zip",
      mimeType: "application/zip" as const,
      width: undefined,
      height: undefined
    };
    const output = executeLibraryMutationResultSchema.parse({
      schemaVersion: 1,
      preflightId: "preflight-export-a",
      action: "export-zip",
      status: "succeeded",
      items: [{ targetId: "asset-a", status: "succeeded", affectedAssetId: "asset-a" }],
      outputResource: zipResource
    });
    expect(output.outputResource?.relativeUrl).toMatch(/^\/api\/v1\/library\/resources\//u);
    expect(JSON.stringify(output)).not.toContain("zipPath");
  });
});

describe("Library Studio operation definitions", () => {
  it("registers internal HTTP operations without MCP tool names", () => {
    expect(studioOperationNames).toEqual([
      "readSettings",
      "upsertProviderProfile",
      "removeProviderProfile",
      "setActiveProviderProfile",
      "refreshModels",
      "probeCapabilities",
      "listFolders",
      "reorderFolders",
      "getAssetDetail",
      "getBrowserResource",
      "preflightLibraryMutation",
      "executeLibraryMutation",
      "reserveUploadResource",
      "finalizeUploadResource",
      "getUploadResourceStatus",
      "discardUploadResource",
      "studioGenerate",
      "studioEdit",
      "studioBatch"
    ]);
    for (const operation of [
      "listFolders",
      "reorderFolders",
      "getAssetDetail",
      "getBrowserResource",
      "preflightLibraryMutation",
      "executeLibraryMutation"
    ] as const) {
      expect(studioOperationDefinitions[operation].http.path).toMatch(/^\/api\/v1\/library\//u);
      expect("toolName" in studioOperationDefinitions[operation]).toBe(false);
    }
  });

  it("dispatches Library operation inputs and outputs through shared schemas", () => {
    expect(parseStudioOperationInput("listFolders", {})).toEqual({
      schemaVersion: 1,
      includeDeleted: false
    });
    expect(
      parseStudioOperationOutput("listFolders", {
        schemaVersion: 1,
        folders: [folderA, folderB]
      })
    ).toMatchObject({ folders: [{ id: "folder-a" }, { id: "folder-b" }] });
  });
});
