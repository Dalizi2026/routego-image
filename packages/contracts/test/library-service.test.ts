import { describe, expect, it } from "vitest";

import {
  browserResourceDescriptorSchema,
  copyGenerationInfoInputSchema,
  copyGenerationInfoResultSchema,
  executeLibraryMutationInputSchema,
  executeLibraryMutationResultSchema,
  getAssetDetailInputSchema,
  getAssetDetailResultSchema,
  getBrowserResourceInputSchema,
  getBrowserResourceResultSchema,
  libraryAssetDetailSchema,
  libraryMigrationConfirmationInputSchema,
  libraryMigrationConfirmationResultSchema,
  libraryMigrationPreflightInputSchema,
  libraryMigrationPreflightResultSchema,
  libraryMutationRequestSchema,
  listFoldersResultSchema,
  markLibraryAssetInputSchema,
  markLibraryAssetResultSchema,
  MAX_LIBRARY_ASSET_RENDITIONS,
  parseStudioOperationInput,
  parseStudioOperationOutput,
  preflightLibraryMutationInputSchema,
  preflightLibraryMutationResultSchema,
  relativeBrowserResourceUrlSchema,
  reorderFoldersInputSchema,
  routegoOperationDefinitions,
  routegoOperationNames,
  routegoSearchLibraryInputSchema,
  studioLibrarySearchInputSchema,
  studioLibrarySearchResultSchema,
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
  name: "Secondary folder",
  order: 1,
  assetCount: 1,
  state: "active" as const,
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
  kind: "generate" as const,
  prompt: "Generate a path-safe skyline at dusk.",
  references: [{ assetId: "asset-reference", role: "style" as const, label: "Color" }],
  size: "1024x1024",
  aspectRatio: "1:1",
  quality: "high" as const,
  format: "png" as const,
  count: 1,
  partialImages: 0,
  transparentMode: "off" as const,
  moderation: "auto" as const,
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

const rendition = (
  artifactId: string,
  phase: "source" | "partial" | "final",
  mimeType: "image/png" | "image/jpeg" | "image/webp" = "image/png"
) => ({
  artifactId,
  phase,
  mimeType,
  byteLength: 68,
  width: 1,
  height: 1,
  sha256: "a".repeat(64),
  createdAt: TEST_TIMESTAMP
});

const assetDetail = (overrides: Record<string, unknown> = {}) => ({
  id: "asset-output",
  prompt: requestedParams.prompt,
  model: "gpt-image-2",
  kind: "generate",
  status: "succeeded",
  currentMark: false,
  primaryArtifactId: "artifact-final-0",
  mimeType: "image/png",
  width: 1024,
  height: 1024,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_TIMESTAMP,
  requestedParams,
  effectiveParams: requestedParams,
  execution,
  renditions: [rendition("artifact-final-0", "final")],
  relationships: [
    {
      id: "relationship-output-0",
      role: "output",
      relatedAssetId: "asset-output",
      artifactId: "artifact-final-0",
      order: 0
    }
  ],
  folders: [],
  allowedActions: ["mark", "copy-generation-info", "download"],
  ...overrides
});

describe("folder and complete asset detail contracts", () => {
  it("preserves ordered folders and rejects duplicate reorder identifiers", () => {
    expect(
      listFoldersResultSchema.parse({ schemaVersion: 1, folders: [folderA, folderB] }).folders.map(
        (folder) => folder.id
      )
    ).toEqual(["folder-a", "folder-b"]);
    expect(
      reorderFoldersInputSchema.safeParse({
        folderIds: ["folder-a", "folder-a"]
      }).success
    ).toBe(false);
  });

  it("represents generation parameters, folder state, mark actions, and generation relationships", () => {
    const detail = libraryAssetDetailSchema.parse(
      assetDetail({
        currentMark: true,
        relationships: [
          {
            id: "relationship-reference-0",
            role: "reference",
            relatedAssetId: "asset-reference",
            order: 0,
            label: "Color"
          },
          {
            id: "relationship-output-0",
            role: "output",
            relatedAssetId: "asset-output",
            artifactId: "artifact-final-0",
            order: 0
          }
        ],
        folders: [
          {
            folderId: "folder-a",
            name: "Primary folder",
            state: "active",
            order: 0
          }
        ],
        allowedActions: [
          "assign-folders",
          "remove-folders",
          "export-zip",
          "download",
          "mark",
          "copy-generation-info"
        ]
      })
    );
    expect(detail.kind).toBe("generate");
    expect(detail.currentMark).toBe(true);
    expect(detail.allowedActions).toContain("mark");
    expect(detail.allowedActions).not.toContain("edit");
    expect(detail.allowedActions).not.toContain("soft-delete");
    expect(detail.requestedParams).not.toHaveProperty("target");
    expect(detail.requestedParams.references).toHaveLength(1);
  });

  it("rejects edit parameters, removed actions, and edit relationship roles", () => {
    expect(
      libraryAssetDetailSchema.safeParse(
        assetDetail({
          kind: "edit",
          requestedParams: {
            ...requestedParams,
            kind: "edit",
            target: { assetId: "asset-target" }
          }
        })
      ).success
    ).toBe(false);
    expect(
      libraryAssetDetailSchema.safeParse(
        assetDetail({
          allowedActions: ["edit", "soft-delete", "restore", "permanent-delete"]
        })
      ).success
    ).toBe(false);
    expect(
      libraryAssetDetailSchema.safeParse(
        assetDetail({
          relationships: [
            {
              id: "relationship-mask",
              role: "mask",
              relatedAssetId: "asset-mask",
              order: 0
            }
          ]
        })
      ).success
    ).toBe(false);
  });

  it("returns structured failure instead of fabricated detail", () => {
    expect(
      getAssetDetailResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        error: persistenceError
      })
    ).toMatchObject({ status: "failed" });
    expect(
      getAssetDetailResultSchema.safeParse({
        schemaVersion: 1,
        status: "succeeded"
      }).success
    ).toBe(false);
  });

  it("accepts exactly 17 source plus 12 partial plus 4 final renditions and rejects 34", () => {
    const renditions = [
      ...Array.from({ length: 17 }, (_, index) => rendition(`artifact-source-${index}`, "source")),
      ...Array.from({ length: 12 }, (_, index) => rendition(`artifact-partial-${index}`, "partial")),
      ...Array.from({ length: 4 }, (_, index) => rendition(`artifact-final-${index}`, "final"))
    ];
    expect(renditions).toHaveLength(MAX_LIBRARY_ASSET_RENDITIONS);
    expect(
      libraryAssetDetailSchema.parse(
        assetDetail({
          primaryArtifactId: "artifact-final-0",
          renditions
        })
      ).renditions
    ).toHaveLength(MAX_LIBRARY_ASSET_RENDITIONS);
    expect(
      libraryAssetDetailSchema.safeParse(
        assetDetail({
          renditions: [...renditions, rendition("artifact-extra", "final")]
        })
      ).success
    ).toBe(false);
  });

  it("requires an output primary, a final succeeded output, and exact local ownership", () => {
    expect(
      libraryAssetDetailSchema.safeParse(
        assetDetail({
          primaryArtifactId: "missing-artifact"
        })
      ).success
    ).toBe(false);
    expect(
      libraryAssetDetailSchema.safeParse(
        assetDetail({
          status: "succeeded",
          primaryArtifactId: "artifact-partial-0",
          renditions: [rendition("artifact-partial-0", "partial")]
        })
      ).success
    ).toBe(false);
    expect(
      libraryAssetDetailSchema.safeParse(
        assetDetail({
          relationships: [
            {
              id: "relationship-output-foreign",
              role: "output",
              relatedAssetId: "asset-other",
              artifactId: "artifact-final-0",
              order: 0
            }
          ]
        })
      ).success
    ).toBe(false);
  });

  it("keeps the public MCP surface at exactly seven tool names", () => {
    expect(routegoOperationNames).toEqual([
      "status",
      "generate",
      "prepareRegeneration",
      "batch",
      "searchLibrary",
      "manageLibrary",
      "openStudio"
    ]);
    expect(
      Object.values(routegoOperationDefinitions).map((definition) => definition.toolName)
    ).toEqual([
      "routego_status",
      "routego_generate",
      "routego_prepare_regeneration",
      "routego_batch",
      "routego_search_library",
      "routego_manage_library",
      "routego_open_studio"
    ]);
  });
});

describe("session-protected browser resources", () => {
  it("accepts only relative protected Library URLs with MIME and dimensions", () => {
    expect(browserResourceDescriptorSchema.parse(resource)).toEqual(resource);
    for (const value of [
      "C:\\\\Users\\\\person\\\\Pictures\\\\image.png",
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
        resource: { ...resource, relativeUrl: "C:\\\\synthetic\\\\image.png" }
      }).success
    ).toBe(false);
  });
});

describe("path-free Studio Library search", () => {
  it("reuses the complete public filter and cursor input semantics", () => {
    const input = {
      query: "synthetic sky",
      models: ["gpt-image-2"],
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-31T23:59:59.000Z",
      kinds: ["generate" as const],
      sizes: ["1024x1024"],
      statuses: ["partial" as const],
      folderIds: ["folder-a"],
      includeDeleted: false,
      sort: "created-desc" as const,
      limit: 20,
      cursor: "cursor-page-2"
    };
    expect(studioLibrarySearchInputSchema).toBe(routegoSearchLibraryInputSchema);
    expect(studioLibrarySearchInputSchema.parse(input)).toEqual(
      routegoSearchLibraryInputSchema.parse(input)
    );
  });

  it("returns stable generation asset/artifact IDs and optional protected thumbnails without paths", () => {
    const result = studioLibrarySearchResultSchema.parse({
      schemaVersion: 1,
      items: [
        {
          assetId: "asset-output",
          artifactId: "artifact-output",
          prompt: requestedParams.prompt,
          model: "gpt-image-2",
          kind: "generate",
          mimeType: "image/png",
          width: 1024,
          height: 1024,
          status: "partial",
          folderIds: ["folder-a"],
          createdAt: TEST_TIMESTAMP,
          currentMark: true,
          thumbnail: resource
        }
      ],
      nextCursor: "cursor-next",
      total: 1
    });
    const item = result.items[0]!;
    expect(item.kind).toBe("generate");
    expect(item.currentMark).toBe(true);
    expect(getAssetDetailInputSchema.parse({ assetId: item.assetId }).assetId).toBe(
      "asset-output"
    );
    expect(
      getBrowserResourceInputSchema.parse({
        assetId: item.assetId,
        artifactId: item.artifactId,
        rendition: "thumbnail"
      })
    ).toMatchObject({ assetId: "asset-output", artifactId: "artifact-output" });
    expect(JSON.stringify(result)).not.toMatch(/(?:filePath|"path"|C:\\|\/Users\/)/u);
  });

  it("rejects path leakage, unsafe thumbnails, deleted trash rows, and edit kinds", () => {
    const base = {
      assetId: "asset-output",
      artifactId: "artifact-output",
      prompt: "Synthetic",
      model: "gpt-image-2",
      kind: "generate" as const,
      mimeType: "image/png" as const,
      width: 1024,
      height: 1024,
      status: "succeeded" as const,
      folderIds: ["folder-a"],
      createdAt: TEST_TIMESTAMP
    };
    expect(
      studioLibrarySearchResultSchema.safeParse({
        schemaVersion: 1,
        items: [{ ...base, filePath: "C:\\\\Users\\\\person\\\\image.png" }]
      }).success
    ).toBe(false);
    expect(
      studioLibrarySearchResultSchema.safeParse({
        schemaVersion: 1,
        items: [
          {
            ...base,
            thumbnail: { ...resource, relativeUrl: "https://example.invalid/image.png" }
          }
        ]
      }).success
    ).toBe(false);
    expect(
      studioLibrarySearchResultSchema.safeParse({
        schemaVersion: 1,
        items: [{ ...base, status: "deleted" }]
      }).success
    ).toBe(false);
    expect(
      studioLibrarySearchResultSchema.safeParse({
        schemaVersion: 1,
        items: [{ ...base, kind: "edit" }]
      }).success
    ).toBe(false);
  });
});

describe("preflighted Library mutation and per-item partial results", () => {
  it("uses asset/upload resource identifiers and rejects browser filesystem paths and removed mutations", () => {
    expect(
      libraryMutationRequestSchema.parse({
        action: "assign-folders",
        assetIds: ["asset-a", "asset-b"],
        folderIds: ["folder-a"]
      }).action
    ).toBe("assign-folders");
    expect(
      libraryMutationRequestSchema.parse({
        action: "mark",
        assetIds: ["asset-a"]
      }).action
    ).toBe("mark");
    expect(
      libraryMutationRequestSchema.safeParse({
        action: "soft-delete",
        assetIds: ["asset-a"]
      }).success
    ).toBe(false);
    expect(
      libraryMutationRequestSchema.safeParse({
        action: "permanent-delete",
        assetIds: ["asset-a"]
      }).success
    ).toBe(false);
    expect(
      libraryMutationRequestSchema.safeParse({
        action: "export-zip",
        assetIds: ["C:\\\\Users\\\\person\\\\image.png"]
      }).success
    ).toBe(false);
  });

  it("reports partial preflight eligibility for folder mutations without trash confirmations", () => {
    const preflight = preflightLibraryMutationResultSchema.parse({
      schemaVersion: 1,
      preflightId: "preflight-assign",
      action: "assign-folders",
      status: "partial",
      expiresAt: TEST_TIMESTAMP,
      requiredConfirmations: [],
      items: [
        {
          targetId: "asset-a",
          targetKind: "asset",
          eligible: true,
          currentStatus: "succeeded",
          allowedActions: ["assign-folders", "export-zip", "mark"],
          requiredConfirmations: []
        },
        {
          targetId: "asset-b",
          targetKind: "asset",
          eligible: false,
          currentStatus: "failed",
          allowedActions: ["download"],
          requiredConfirmations: [],
          error: persistenceError
        }
      ]
    });
    expect(preflight.status).toBe("partial");
    expect(preflight.requiredConfirmations).toEqual([]);
  });

  it("requires the preflight identifier and preserves ordered partial execution outcomes", () => {
    expect(
      executeLibraryMutationInputSchema.parse({
        preflightId: "preflight-assign",
        action: "assign-folders",
        confirmations: []
      }).preflightId
    ).toBe("preflight-assign");
    const result = executeLibraryMutationResultSchema.parse({
      schemaVersion: 1,
      preflightId: "preflight-assign",
      action: "assign-folders",
      status: "partial",
      items: [
        {
          targetId: "asset-a",
          status: "succeeded",
          affectedAssetId: "asset-a",
          affectedFolderIds: ["folder-a"]
        },
        {
          targetId: "asset-b",
          status: "failed",
          error: persistenceError
        }
      ]
    });
    expect(result.items.map((item) => item.targetId)).toEqual(["asset-a", "asset-b"]);
  });

  it("returns ZIP export only as a protected browser resource", () => {
    const exportResource = {
      resourceId: "resource-export-zip",
      relativeUrl: "/api/v1/library/resources/resource-export-zip",
      requiresSession: true as const,
      mimeType: "application/zip" as const,
      byteLength: 128,
      etag: "zip-etag",
      expiresAt: TEST_TIMESTAMP
    };
    expect(
      executeLibraryMutationResultSchema.parse({
        schemaVersion: 1,
        preflightId: "preflight-export",
        action: "export-zip",
        status: "succeeded",
        items: [{ targetId: "asset-a", status: "succeeded", affectedAssetId: "asset-a" }],
        outputResource: exportResource
      }).outputResource?.requiresSession
    ).toBe(true);
  });
});

describe("browser-safe mark, regeneration-copy, and migration contracts", () => {
  it("toggles a single current mark without provider work", () => {
    expect(markLibraryAssetInputSchema.parse({ recordId: "asset-output" }).recordId).toBe(
      "asset-output"
    );
    expect(
      markLibraryAssetResultSchema.parse({
        schemaVersion: 1,
        status: "succeeded",
        recordId: "asset-output",
        currentMarkRecordId: "asset-output",
        markCleared: false,
        providerRequestCount: 0
      }).currentMarkRecordId
    ).toBe("asset-output");
    expect(
      markLibraryAssetResultSchema.parse({
        schemaVersion: 1,
        status: "succeeded",
        recordId: "asset-output",
        markCleared: true,
        providerRequestCount: 0
      }).markCleared
    ).toBe(true);
    expect(
      markLibraryAssetResultSchema.safeParse({
        schemaVersion: 1,
        status: "succeeded",
        recordId: "asset-output",
        currentMarkRecordId: "asset-other",
        markCleared: false,
        providerRequestCount: 0
      }).success
    ).toBe(false);
    expect(
      markLibraryAssetResultSchema.safeParse({
        schemaVersion: 1,
        status: "failed",
        recordId: "asset-missing",
        markCleared: false,
        providerRequestCount: 0
      }).success
    ).toBe(false);
  });

  it("projects safe generation information without paths or credentials", () => {
    expect(copyGenerationInfoInputSchema.parse({ recordId: "asset-output" }).recordId).toBe(
      "asset-output"
    );
    const copied = copyGenerationInfoResultSchema.parse({
      schemaVersion: 1,
      status: "succeeded",
      providerRequestCount: 0,
      projection: {
        recordId: "asset-output",
        prompt: requestedParams.prompt,
        referenceIds: ["asset-reference"],
        parameters: {
          size: "1024x1024",
          aspectRatio: "1:1",
          quality: "high",
          format: "png",
          count: 1,
          transparentMode: "off",
          moderation: "auto"
        }
      },
      clipboardText:
        "recordId=asset-output\\nprompt=Generate a path-safe skyline at dusk.\\nreferenceIds=asset-reference\\nsize=1024x1024"
    });
    expect(copied.projection?.referenceIds).toEqual(["asset-reference"]);
    expect(
      copyGenerationInfoResultSchema.safeParse({
        ...copied,
        clipboardText: "path=C:\\\\Users\\\\person\\\\Pictures\\\\image.png"
      }).success
    ).toBe(false);
    expect(
      copyGenerationInfoResultSchema.safeParse({
        schemaVersion: 1,
        status: "failed",
        providerRequestCount: 0,
        clipboardText: "partial"
      }).success
    ).toBe(false);
  });

  it("requires fingerprinted migration confirmation and never mutates during preflight", () => {
    const fingerprint = "b".repeat(64);
    expect(libraryMigrationPreflightInputSchema.parse({}).schemaVersion).toBe(1);
    const preflight = libraryMigrationPreflightResultSchema.parse({
      schemaVersion: 1,
      fingerprint,
      eligible: true,
      projectedCounts: {
        trashGenerationRecords: 2,
        editRecords: 1,
        ownedFiles: 3,
        sharedReferences: 0,
        conflicts: 0
      },
      conflicts: [],
      removableRecordIds: ["asset-trash-1", "asset-edit-1"],
      providerRequestCount: 0,
      mutatesData: false
    });
    expect(preflight.mutatesData).toBe(false);
    expect(preflight.eligible).toBe(true);

    expect(
      libraryMigrationPreflightResultSchema.safeParse({
        ...preflight,
        eligible: true,
        conflicts: [
          {
            dependentRecordId: "asset-generate",
            dependencyRecordId: "asset-edit",
            reason: "generation-references-edit"
          }
        ],
        projectedCounts: { ...preflight.projectedCounts, conflicts: 1 }
      }).success
    ).toBe(false);

    expect(
      libraryMigrationConfirmationInputSchema.parse({
        fingerprint,
        confirmDestructiveMigration: true
      }).confirmDestructiveMigration
    ).toBe(true);
    expect(
      libraryMigrationConfirmationInputSchema.safeParse({
        fingerprint,
        confirmDestructiveMigration: false
      }).success
    ).toBe(false);

    expect(
      libraryMigrationConfirmationResultSchema.parse({
        schemaVersion: 1,
        status: "succeeded",
        fingerprint,
        removedRecordCount: 3,
        removedFileCount: 2,
        recovered: false,
        providerRequestCount: 0
      }).status
    ).toBe("succeeded");
    expect(
      libraryMigrationConfirmationResultSchema.parse({
        schemaVersion: 1,
        status: "blocked",
        fingerprint,
        removedRecordCount: 0,
        removedFileCount: 0,
        recovered: false,
        providerRequestCount: 0,
        error: persistenceError
      }).status
    ).toBe("blocked");
  });
});

describe("Library Studio operation definitions", () => {
  it("registers internal HTTP operations without MCP tool names", () => {
    expect(studioOperationNames).toEqual(expect.arrayContaining([
      "listFolders",
      "reorderFolders",
      "getAssetDetail",
      "getBrowserResource",
      "preflightLibraryMutation",
      "executeLibraryMutation",
      "searchStudioLibrary"
    ]));
    for (const operation of [
      "listFolders",
      "reorderFolders",
      "getAssetDetail",
      "getBrowserResource",
      "preflightLibraryMutation",
      "executeLibraryMutation",
      "searchStudioLibrary"
    ] as const) {
      expect(studioOperationDefinitions[operation].http.path).toMatch(/^\/api\/v1\//u);
      expect("toolName" in studioOperationDefinitions[operation]).toBe(false);
    }
  });

  it("dispatches Library operation inputs and outputs through shared schemas", () => {
    expect(
      parseStudioOperationInput("getAssetDetail", { assetId: "asset-output" })
    ).toMatchObject({ assetId: "asset-output" });
    expect(
      parseStudioOperationOutput(
        "getAssetDetail",
        getAssetDetailResultSchema.parse({
          schemaVersion: 1,
          status: "succeeded",
          asset: assetDetail()
        })
      )
    ).toMatchObject({ status: "succeeded" });
    expect(() =>
      parseStudioOperationInput("preflightLibraryMutation", {
        mutation: { action: "soft-delete", assetIds: ["asset-a"] }
      })
    ).toThrow();
  });
});
