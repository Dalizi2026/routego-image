import { describe, expect, it } from "vitest";

import {
  browserResourceDescriptorSchema,
  executeLibraryMutationInputSchema,
  executeLibraryMutationResultSchema,
  getAssetDetailInputSchema,
  getAssetDetailResultSchema,
  getBrowserResourceInputSchema,
  getBrowserResourceResultSchema,
  imageArtifactPhaseSchema,
  libraryAssetDetailSchema,
  libraryAssetRenditionPhaseSchema,
  libraryMutationRequestSchema,
  listFoldersResultSchema,
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
  kind: "edit",
  status: "succeeded",
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
  allowedActions: ["edit", "retry", "download"],
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
      primaryArtifactId: "artifact-output",
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

  it("keeps source renditions Library-only while accepting mixed source MIME", () => {
    expect(libraryAssetRenditionPhaseSchema.options).toEqual(["source", "partial", "final"]);
    expect(imageArtifactPhaseSchema.options).toEqual(["partial", "final"]);
    expect(imageArtifactPhaseSchema.safeParse("source").success).toBe(false);

    const parsed = libraryAssetDetailSchema.parse(
      assetDetail({
        renditions: [
          rendition("artifact-source-target", "source", "image/jpeg"),
          rendition("artifact-source-mask", "source", "image/png"),
          rendition("artifact-source-supporting", "source", "image/webp"),
          rendition("artifact-final-0", "final", "image/png")
        ],
        relationships: [
          {
            id: "relationship-target",
            role: "target",
            relatedAssetId: "asset-output",
            artifactId: "artifact-source-target",
            order: 0
          },
          {
            id: "relationship-mask",
            role: "mask",
            relatedAssetId: "asset-output",
            artifactId: "artifact-source-mask",
            order: 1
          },
          {
            id: "relationship-supporting",
            role: "supporting",
            relatedAssetId: "asset-output",
            artifactId: "artifact-source-supporting",
            order: 2
          },
          {
            id: "relationship-output",
            role: "output",
            relatedAssetId: "asset-output",
            artifactId: "artifact-final-0",
            order: 3
          }
        ]
      })
    );

    expect(parsed.renditions.map((item) => item.phase)).toEqual([
      "source",
      "source",
      "source",
      "final"
    ]);
    expect(JSON.stringify(parsed)).not.toMatch(/(?:filePath|C:\\|\/Users\/|data:image)/u);
  });

  it("accepts exactly 17 source plus 12 partial plus 4 final renditions and rejects 34", () => {
    const sources = Array.from({ length: 17 }, (_, index) =>
      rendition(
        `artifact-source-${index}`,
        "source",
        (["image/png", "image/jpeg", "image/webp"] as const)[index % 3]
      )
    );
    const partials = Array.from({ length: 12 }, (_, index) =>
      rendition(`artifact-partial-${index}`, "partial")
    );
    const finals = Array.from({ length: 4 }, (_, index) =>
      rendition(`artifact-final-${index}`, "final")
    );
    const renditions = [...sources, ...partials, ...finals];
    const relationships = renditions.map((item, index) => ({
      id: `relationship-${index}`,
      role: item.phase === "source" ? ("source" as const) : ("output" as const),
      relatedAssetId: "asset-output",
      artifactId: item.artifactId,
      order: index
    }));

    const parsed = libraryAssetDetailSchema.parse(assetDetail({ renditions, relationships }));
    expect(parsed.renditions).toHaveLength(MAX_LIBRARY_ASSET_RENDITIONS);
    expect(
      libraryAssetDetailSchema.safeParse({
        ...assetDetail({ renditions, relationships }),
        renditions: [...renditions, rendition("artifact-final-overflow", "final")]
      }).success
    ).toBe(false);
  });

  it("requires an output primary, a final succeeded output, and exact local ownership", () => {
    const sourceAndFinal = [
      rendition("artifact-source-0", "source"),
      rendition("artifact-final-0", "final")
    ];
    expect(
      libraryAssetDetailSchema.safeParse(
        assetDetail({ primaryArtifactId: "artifact-source-0", renditions: sourceAndFinal })
      ).success
    ).toBe(false);
    expect(
      libraryAssetDetailSchema.safeParse(
        assetDetail({
          primaryArtifactId: "artifact-partial-0",
          renditions: [rendition("artifact-partial-0", "partial")],
          relationships: [
            {
              id: "relationship-output",
              role: "output",
              relatedAssetId: "asset-output",
              artifactId: "artifact-partial-0",
              order: 0
            }
          ]
        })
      ).success
    ).toBe(false);
    expect(
      libraryAssetDetailSchema.safeParse(
        assetDetail({
          relationships: [
            {
              id: "relationship-without-artifact",
              role: "output",
              relatedAssetId: "asset-output",
              order: 0
            }
          ]
        })
      ).success
    ).toBe(false);
    expect(
      libraryAssetDetailSchema.safeParse(
        assetDetail({
          relationships: [
            {
              id: "relationship-wrong-owner",
              role: "target",
              relatedAssetId: "asset-other",
              artifactId: "artifact-final-0",
              order: 0
            }
          ]
        })
      ).success
    ).toBe(false);
    expect(
      libraryAssetDetailSchema.safeParse(
        assetDetail({
          relationships: [
            {
              id: "relationship-missing-artifact",
              role: "output",
              relatedAssetId: "asset-output",
              artifactId: "artifact-not-owned",
              order: 0
            }
          ]
        })
      ).success
    ).toBe(false);
    expect(
      libraryAssetDetailSchema.safeParse(
        assetDetail({
          status: "partial",
          primaryArtifactId: "artifact-partial-0",
          renditions: [
            rendition("artifact-source-0", "source"),
            rendition("artifact-partial-0", "partial")
          ],
          relationships: [
            {
              id: "relationship-output",
              role: "output",
              relatedAssetId: "asset-output",
              artifactId: "artifact-partial-0",
              order: 0
            }
          ]
        })
      ).success
    ).toBe(true);
  });

  it("keeps the public MCP surface at exactly seven tool names", () => {
    expect(routegoOperationNames).toEqual([
      "status",
      "generate",
      "edit",
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
      "routego_edit",
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

describe("path-free Studio Library search", () => {
  it("reuses the complete public filter and cursor input semantics", () => {
    const input = {
      query: "synthetic sky",
      models: ["gpt-image-2"],
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-31T23:59:59.000Z",
      kinds: ["edit" as const],
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

  it("returns stable asset/artifact IDs and an optional protected thumbnail without paths", () => {
    const result = studioLibrarySearchResultSchema.parse({
      schemaVersion: 1,
      items: [
        {
          assetId: "asset-output",
          artifactId: "artifact-output",
          prompt: requestedParams.prompt,
          model: "gpt-image-2",
          kind: "edit",
          mimeType: "image/png",
          width: 1024,
          height: 1024,
          status: "partial",
          folderIds: ["folder-a"],
          createdAt: TEST_TIMESTAMP,
          thumbnail: resource
        }
      ],
      nextCursor: "cursor-next",
      total: 1
    });
    const item = result.items[0]!;
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

  it("rejects path leakage, unsafe thumbnails, and invalid deletion state", () => {
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
        items: [{ ...base, filePath: "C:\\Users\\person\\image.png" }]
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
      "studioBatch",
      "searchStudioLibrary",
      "updateSettings"
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
    expect(
      parseStudioOperationOutput("searchStudioLibrary", {
        schemaVersion: 1,
        items: [],
        total: 0
      })
    ).toEqual({ schemaVersion: 1, items: [], total: 0 });
  });
});
