import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { LibraryAssetDetail, LibraryOperationParameters } from "@routego-image/contracts";

import { createStudioLibraryHandoffTransition } from "../src/app";
import {
  collectCreationDraftUploads,
  isIdentifierOnlyCreationExternalHandoff,
  shouldConsumeCreationExternalHandoff,
  type CreationDraft,
  type CreationExternalHandoff,
  type UploadLifecycleItem
} from "../src/features/creation";
import {
  createLibraryEditHandoff,
  createLibraryRetryHandoff,
  isIdentifierOnlyLibraryHandoff
} from "../src/features/library";

const parameters: LibraryOperationParameters = {
  kind: "edit",
  prompt: "Preserve the subject and refine the cool studio light.",
  references: [{ assetId: "asset-reference-01", role: "style", label: "Lighting" }],
  target: { assetId: "asset-target-01", label: "Target" },
  supportingImages: [
    { assetId: "asset-supporting-01", role: "supporting", label: "Supporting" }
  ],
  maskAssetId: "asset-mask-01",
  invariants: {
    allowedChanges: ["lighting"],
    preserve: ["subject"],
    forbiddenChanges: ["identity"]
  },
  size: "1024x1024",
  aspectRatio: "square",
  quality: "high",
  format: "png",
  count: 1,
  partialImages: 0,
  transparentMode: "off",
  moderation: "auto",
  action: "edit",
  previousResponseId: "response-01",
  imageIds: [],
  fileIds: [],
  outputDirectoryMode: "default",
  saveToLibrary: true
};

const asset: LibraryAssetDetail = {
  id: "asset-result-01",
  prompt: parameters.prompt,
  model: "synthetic-model",
  kind: "edit",
  status: "succeeded",
  primaryArtifactId: "artifact-output-01",
  mimeType: "image/png",
  width: 1024,
  height: 1024,
  createdAt: "2026-07-18T08:00:00.000Z",
  updatedAt: "2026-07-18T08:01:00.000Z",
  requestedParams: parameters,
  effectiveParams: parameters,
  execution: {
    attemptCount: 1,
    providerRequestCount: 1,
    receivedAnyOutput: true,
    mayHaveBilled: true,
    degradedContinuation: false,
    providerImageIds: []
  },
  renditions: [
    {
      artifactId: "artifact-output-01",
      phase: "final",
      mimeType: "image/png",
      byteLength: 128,
      width: 1024,
      height: 1024,
      sha256: "a".repeat(64),
      createdAt: "2026-07-18T08:01:00.000Z"
    }
  ],
  relationships: [
    {
      id: "relationship-target-01",
      role: "target",
      relatedAssetId: "asset-target-01",
      artifactId: "artifact-target-01",
      order: 0,
      label: "Target"
    },
    {
      id: "relationship-reference-01",
      role: "reference",
      relatedAssetId: "asset-reference-01",
      artifactId: "artifact-reference-01",
      order: 1,
      label: "Lighting"
    },
    {
      id: "relationship-supporting-01",
      role: "supporting",
      relatedAssetId: "asset-supporting-01",
      artifactId: "artifact-supporting-01",
      order: 2,
      label: "Supporting"
    },
    {
      id: "relationship-mask-01",
      role: "mask",
      relatedAssetId: "asset-mask-01",
      artifactId: "artifact-mask-01",
      order: 3
    },
    {
      id: "relationship-output-01",
      role: "output",
      relatedAssetId: "asset-result-01",
      artifactId: "artifact-output-01",
      order: 4
    }
  ],
  folders: [],
  allowedActions: ["edit", "retry"]
};

function upload(id: string): UploadLifecycleItem {
  return {
    id,
    purpose: "image",
    source: { name: `${id}.png`, blob: new Blob([id], { type: "image/png" }) },
    status: "ready",
    uploadResourceId: `resource-${id}`
  };
}

function cloneAsset(): LibraryAssetDetail {
  return structuredClone(asset);
}

function rendition(
  artifactId: string,
  phase: "source" | "partial" | "final"
): LibraryAssetDetail["renditions"][number] {
  return {
    artifactId,
    phase,
    mimeType: "image/png",
    byteLength: 128,
    width: 1024,
    height: 1024,
    sha256: "b".repeat(64),
    createdAt: "2026-07-18T08:01:00.000Z"
  };
}

describe("Library retry/edit handoff", () => {
  it("creates identifier-only retry and edit drafts and routes them to Workbench", () => {
    const retry = createLibraryRetryHandoff(asset);
    const edit = createLibraryEditHandoff(asset);

    expect(retry.draft).toMatchObject({
      mode: "edit",
      references: [
        {
          role: "style",
          label: "Lighting",
          locator: { source: "artifact", artifactId: "artifact-reference-01" }
        }
      ],
      target: {
        label: "Target",
        locator: { source: "artifact", artifactId: "artifact-target-01" }
      },
      supportingImages: [
        {
          role: "supporting",
          label: "Supporting",
          locator: { source: "artifact", artifactId: "artifact-supporting-01" }
        }
      ],
      mask: {
        image: { source: "artifact", artifactId: "artifact-mask-01" },
        targetSlot: 0
      }
    });
    expect(edit.draft).toMatchObject({
      mode: "edit",
      target: { locator: { source: "artifact", artifactId: "artifact-output-01" } }
    });
    expect(isIdentifierOnlyLibraryHandoff(retry)).toBe(true);

    const transition = createStudioLibraryHandoffTransition(retry, 3);
    expect(transition.route).toBe("workbench");
    expect(transition.handoff.id).toBe("library:3:retry");
    expect(isIdentifierOnlyCreationExternalHandoff(transition.handoff)).toBe(true);
    expect(JSON.stringify(transition)).not.toMatch(
      /(?:path|file:\/\/|[A-Za-z]:\\|\/Users\/|data:image|base64)/iu
    );
  });

  it("reconstructs upload-origin local source renditions by exact artifact identifier", () => {
    const local = cloneAsset();
    const localParameters: LibraryOperationParameters = {
      ...parameters,
      references: [{ assetId: local.id, role: "style", label: "Lighting" }],
      target: { assetId: local.id, label: "Target" },
      supportingImages: [
        { assetId: local.id, role: "supporting", label: "Supporting" }
      ],
      maskAssetId: local.id
    };
    local.requestedParams = localParameters;
    local.effectiveParams = localParameters;
    local.renditions = [
      rendition("artifact-target-01", "source"),
      rendition("artifact-reference-01", "source"),
      rendition("artifact-supporting-01", "source"),
      rendition("artifact-mask-01", "source"),
      rendition("artifact-output-01", "final")
    ];
    local.relationships = local.relationships.map((relationship) =>
      relationship.role === "output"
        ? relationship
        : { ...relationship, relatedAssetId: local.id }
    );

    const retry = createLibraryRetryHandoff(local);
    expect(retry.draft.target?.locator).toEqual({
      source: "artifact",
      artifactId: "artifact-target-01"
    });
    expect(retry.draft.references[0]?.locator).toEqual({
      source: "artifact",
      artifactId: "artifact-reference-01"
    });
    expect(retry.draft.supportingImages[0]?.locator).toEqual({
      source: "artifact",
      artifactId: "artifact-supporting-01"
    });
    expect(retry.draft.mask).toEqual({
      image: { source: "artifact", artifactId: "artifact-mask-01" },
      targetSlot: 0
    });
  });

  it("orders references and supporting inputs by relationship order while preserving roles and labels", () => {
    const ordered = cloneAsset();
    const orderedParameters: LibraryOperationParameters = {
      ...parameters,
      references: [
        { assetId: "asset-reference-a", role: "style", label: "Style A" },
        { assetId: "asset-reference-b", role: "composition", label: "Composition B" }
      ],
      supportingImages: [
        { assetId: "asset-supporting-a", role: "subject", label: "Subject A" },
        { assetId: "asset-supporting-b", role: "background", label: "Background B" }
      ]
    };
    ordered.requestedParams = orderedParameters;
    ordered.effectiveParams = orderedParameters;
    ordered.relationships = [
      asset.relationships.find((relationship) => relationship.role === "output")!,
      {
        id: "relationship-supporting-b",
        role: "supporting",
        relatedAssetId: "asset-supporting-b",
        artifactId: "artifact-supporting-b",
        order: 40,
        label: "Background B"
      },
      {
        id: "relationship-reference-b",
        role: "reference",
        relatedAssetId: "asset-reference-b",
        artifactId: "artifact-reference-b",
        order: 20,
        label: "Composition B"
      },
      asset.relationships.find((relationship) => relationship.role === "target")!,
      {
        id: "relationship-reference-a",
        role: "reference",
        relatedAssetId: "asset-reference-a",
        artifactId: "artifact-reference-a",
        order: 10,
        label: "Style A"
      },
      {
        id: "relationship-supporting-a",
        role: "supporting",
        relatedAssetId: "asset-supporting-a",
        artifactId: "artifact-supporting-a",
        order: 30,
        label: "Subject A"
      },
      { ...asset.relationships.find((relationship) => relationship.role === "mask")!, order: 50 }
    ];

    const retry = createLibraryRetryHandoff(ordered);
    expect(retry.draft.references.map(({ role, label, locator }) => ({ role, label, locator }))).toEqual([
      {
        role: "style",
        label: "Style A",
        locator: { source: "artifact", artifactId: "artifact-reference-a" }
      },
      {
        role: "composition",
        label: "Composition B",
        locator: { source: "artifact", artifactId: "artifact-reference-b" }
      }
    ]);
    expect(retry.draft.supportingImages.map(({ role, label, locator }) => ({ role, label, locator }))).toEqual([
      {
        role: "subject",
        label: "Subject A",
        locator: { source: "artifact", artifactId: "artifact-supporting-a" }
      },
      {
        role: "background",
        label: "Background B",
        locator: { source: "artifact", artifactId: "artifact-supporting-b" }
      }
    ]);
  });

  it.each([
    [
      "missing edit target",
      (invalid: LibraryAssetDetail) => {
        invalid.relationships = invalid.relationships.filter(
          (relationship) => relationship.role !== "target"
        );
      }
    ],
    [
      "duplicated edit target",
      (invalid: LibraryAssetDetail) => {
        invalid.relationships = [
          ...invalid.relationships,
          {
            id: "relationship-target-duplicate",
            role: "target",
            relatedAssetId: "asset-target-01",
            artifactId: "artifact-target-duplicate",
            order: 10,
            label: "Target"
          }
        ];
      }
    ],
    [
      "missing artifact identifier",
      (invalid: LibraryAssetDetail) => {
        invalid.relationships = invalid.relationships.map((relationship) =>
          relationship.role === "reference"
            ? { ...relationship, artifactId: undefined }
            : relationship
        );
      }
    ],
    [
      "inconsistent related asset ownership",
      (invalid: LibraryAssetDetail) => {
        invalid.relationships = invalid.relationships.map((relationship) =>
          relationship.role === "reference"
            ? { ...relationship, relatedAssetId: "asset-wrong-owner" }
            : relationship
        );
      }
    ],
    [
      "local artifact assigned to another asset",
      (invalid: LibraryAssetDetail) => {
        invalid.relationships = invalid.relationships.map((relationship) =>
          relationship.role === "reference"
            ? { ...relationship, artifactId: invalid.primaryArtifactId }
            : relationship
        );
      }
    ],
    [
      "local non-source target",
      (invalid: LibraryAssetDetail) => {
        invalid.requestedParams = {
          ...invalid.requestedParams,
          target: { assetId: invalid.id, label: "Target" }
        };
        invalid.effectiveParams = {
          ...invalid.effectiveParams,
          target: { assetId: invalid.id, label: "Target" }
        };
        invalid.relationships = invalid.relationships.map((relationship) =>
          relationship.role === "target"
            ? {
                ...relationship,
                relatedAssetId: invalid.id,
                artifactId: invalid.primaryArtifactId
              }
            : relationship
        );
      }
    ],
    [
      "duplicated mask",
      (invalid: LibraryAssetDetail) => {
        invalid.relationships = [
          ...invalid.relationships,
          {
            id: "relationship-mask-duplicate",
            role: "mask",
            relatedAssetId: "asset-mask-01",
            artifactId: "artifact-mask-duplicate",
            order: 10
          }
        ];
      }
    ],
    [
      "generic source relationship replacing the target",
      (invalid: LibraryAssetDetail) => {
        invalid.relationships = [
          ...invalid.relationships.filter((relationship) => relationship.role !== "target"),
          {
            id: "relationship-generic-source",
            role: "source",
            relatedAssetId: "asset-target-01",
            artifactId: "artifact-target-01",
            order: 10
          }
        ];
      }
    ],
    [
      "ambiguous physical-input order",
      (invalid: LibraryAssetDetail) => {
        invalid.relationships = invalid.relationships.map((relationship) =>
          relationship.role === "reference" ? { ...relationship, order: 0 } : relationship
        );
      }
    ],
    [
      "duplicated physical artifact",
      (invalid: LibraryAssetDetail) => {
        invalid.relationships = invalid.relationships.map((relationship) =>
          relationship.role === "supporting"
            ? { ...relationship, artifactId: "artifact-reference-01" }
            : relationship
        );
      }
    ],
    [
      "inconsistent relationship label",
      (invalid: LibraryAssetDetail) => {
        invalid.relationships = invalid.relationships.map((relationship) =>
          relationship.role === "reference"
            ? { ...relationship, label: "Wrong label" }
            : relationship
        );
      }
    ]
  ] as const)("fails closed for %s without primary-output fallback", (_label, mutate) => {
    const invalid = cloneAsset();
    mutate(invalid);
    expect(() => createLibraryRetryHandoff(invalid)).toThrow(/Library handoff unavailable/u);
  });

  it("keeps edit-again on the selected output and rejects a source primary", () => {
    const edit = createLibraryEditHandoff(asset);
    expect(edit.draft.target?.locator).toEqual({
      source: "artifact",
      artifactId: "artifact-output-01"
    });

    const invalid = cloneAsset();
    invalid.primaryArtifactId = "artifact-source-primary";
    invalid.renditions = [
      rendition("artifact-source-primary", "source"),
      rendition("artifact-output-01", "final")
    ];
    expect(() => createLibraryEditHandoff(invalid)).toThrow(/selected output artifact/u);
  });

  it("consumes each stable handoff once and rejects path-shaped or temporary resource payloads", () => {
    const transition = createStudioLibraryHandoffTransition(
      createLibraryRetryHandoff(asset),
      1
    );
    expect(shouldConsumeCreationExternalHandoff(transition.handoff, undefined)).toBe(true);
    expect(
      shouldConsumeCreationExternalHandoff(transition.handoff, transition.handoff.id)
    ).toBe(false);

    const unsafe = {
      ...transition.handoff,
      draft: {
        ...transition.handoff.draft,
        target: {
          ...transition.handoff.draft.target!,
          locator: {
            source: "asset",
            assetId: "asset-target-01",
            path: "C:\\private\\target.png"
          }
        }
      }
    } as unknown as CreationExternalHandoff;
    expect(isIdentifierOnlyCreationExternalHandoff(unsafe)).toBe(false);
    expect(
      isIdentifierOnlyLibraryHandoff({
        ...createLibraryRetryHandoff(asset),
        draft: unsafe.draft
      })
    ).toBe(false);

    const unsafeMask = {
      ...createLibraryRetryHandoff(asset),
      draft: {
        ...createLibraryRetryHandoff(asset).draft,
        mask: {
          image: {
            source: "artifact",
            artifactId: "artifact-mask-01",
            path: "/private/mask.png"
          },
          targetSlot: 0
        }
      }
    } as unknown as ReturnType<typeof createLibraryRetryHandoff>;
    expect(isIdentifierOnlyLibraryHandoff(unsafeMask)).toBe(false);

    const temporary = {
      ...transition.handoff,
      draft: {
        ...transition.handoff.draft,
        target: {
          ...transition.handoff.draft.target!,
          upload: upload("temporary-target")
        }
      }
    };
    expect(isIdentifierOnlyCreationExternalHandoff(temporary)).toBe(false);
  });

  it("collects every replaced upload and mask exactly once for existing cleanup", () => {
    const shared = upload("shared");
    const target = upload("target");
    const supporting = upload("supporting");
    const mask = { ...upload("mask"), purpose: "mask" as const };
    const draft = {
      ...createLibraryRetryHandoff(asset).draft,
      references: [
        { id: "reference-upload", role: "reference" as const, upload: shared },
        { id: "reference-duplicate", role: "reference" as const, upload: shared }
      ],
      target: { id: "target-upload", role: "previous-output" as const, upload: target },
      supportingImages: [
        { id: "supporting-upload", role: "supporting" as const, upload: supporting }
      ],
      maskUpload: mask
    } satisfies CreationDraft;

    expect(collectCreationDraftUploads([draft]).map((item) => item.id)).toEqual([
      "shared",
      "target",
      "supporting",
      "mask"
    ]);
  });

  it("keeps the integration free of storage, URL payload, and global event channels", () => {
    const sources = [
      "../src/app/StudioApp.tsx",
      "../src/features/library/handoff.ts",
      "../src/features/creation/CreationWorkbench.tsx"
    ]
      .map((relative) => readFileSync(new URL(relative, import.meta.url), "utf8"))
      .join("\n");

    expect(sources).not.toMatch(/localStorage|sessionStorage|indexedDB/iu);
    expect(sources).not.toMatch(/new URLSearchParams|location\.(?:hash|search)|history\.(?:push|replace)State/iu);
    expect(sources).not.toMatch(/window\.(?:addEventListener|dispatchEvent)|CustomEvent/iu);
    expect(sources).toContain('hidden={state.route !== "workbench"}');
  });
});
