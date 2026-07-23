import path from "node:path";

import type {
  StudioImageInputRef,
  StudioImageOperationRequest,
  UploadResourcePurpose
} from "@routego-image/contracts";
import {
  LibraryError,
  type ResolvedStableImageResource,
  type RoutegoLibraryService
} from "@routego-image/library";
import { describe, expect, it, vi } from "vitest";

import {
  StudioInputResolutionError,
  resolveStudioOperationInput,
  type ResolveStudioOperationInputOptions
} from "../src/composition/inputs";
import type { InputGraphIdFactory } from "../src/composition/graph";

const NOW = new Date("2026-07-18T12:00:00.000Z");
const FUTURE_EXPIRY = "2026-07-18T12:05:00.000Z";
const SHA = "a".repeat(64);

type ImageOwner = Pick<RoutegoLibraryService, "resolveImageResource">;

function deterministicIdFactory(
  kind: Parameters<InputGraphIdFactory>[0],
  order: number,
  attempt: number
): string {
  return `${kind}-${order}-${attempt}`;
}

function assetResource(assetId: string, artifactId: string): ResolvedStableImageResource {
  return {
    source: "asset",
    assetId,
    artifactId,
    path: path.resolve("synthetic-library", `${artifactId}.png`),
    mimeType: "image/png",
    byteLength: 128,
    sha256: SHA,
    width: 8,
    height: 6
  };
}

function artifactResource(assetId: string, artifactId: string): ResolvedStableImageResource {
  return {
    source: "artifact",
    assetId,
    artifactId,
    path: path.resolve("synthetic-library", `${artifactId}.png`),
    mimeType: "image/png",
    byteLength: 128,
    sha256: SHA,
    width: 8,
    height: 6
  };
}

function uploadResource(
  uploadResourceId: string,
  purpose: Exclude<UploadResourcePurpose, "zip-import">,
  overrides: Partial<ResolvedStableImageResource> = {}
): ResolvedStableImageResource {
  return {
    source: "upload",
    uploadResourceId,
    purpose,
    path: path.resolve("synthetic-uploads", `${uploadResourceId}.png`),
    mimeType: "image/png",
    byteLength: 128,
    sha256: SHA,
    width: 8,
    height: 6,
    expiresAt: FUTURE_EXPIRY,
    reusePolicy: "reusable-until-expiry",
    ...overrides
  } as ResolvedStableImageResource;
}

function fakeLibrary(
  resolver: (
    locator: StudioImageInputRef,
    expectedUploadPurposes?: readonly UploadResourcePurpose[]
  ) => ResolvedStableImageResource | Promise<ResolvedStableImageResource>
): ImageOwner {
  return {
    resolveImageResource: async (locator, expectedUploadPurposes) =>
      await resolver(locator, expectedUploadPurposes)
  };
}

function options(
  library: ImageOwner,
  overrides: Partial<Omit<ResolveStudioOperationInputOptions, "library">> = {}
): ResolveStudioOperationInputOptions {
  return {
    library,
    idFactory: deterministicIdFactory,
    now: () => new Date(NOW),
    ...overrides
  };
}

function expectResolutionCode(code: StudioInputResolutionError["code"]) {
  return (error: unknown): boolean =>
    error instanceof StudioInputResolutionError && error.code === code;
}

describe("Studio input resolution and durable graph planning", () => {
  it("supports text-only generation without resolving or inventing physical inputs", async () => {
    const resolveImageResource = vi.fn(async () => {
      throw new Error("unexpected input resolution");
    });
    const prepared = await resolveStudioOperationInput(
      { kind: "generate", prompt: "A synthetic text-only scene" },
      options({ resolveImageResource })
    );

    expect(resolveImageResource).not.toHaveBeenCalled();
    expect(prepared.graph).toEqual({
      operationAssetId: "operation-asset-0-0",
      inputs: [],
      sourceRenditions: [],
      relationships: [],
      physicalImageCount: 0,
      maskCount: 0
    });
    expect(prepared.creationRequest).toMatchObject({
      kind: "generate",
      prompt: "A synthetic text-only scene",
      references: [],
      saveToLibrary: true
    });
    expect(JSON.stringify(prepared.creationRequest)).not.toMatch(
      /assetId|artifactId|uploadResourceId|targetImage|maskPath|\\|\//u
    );
  });

  it("resolves mixed edit inputs in exact order and builds operation-owned upload sources", async () => {
    const calls: Array<{
      locator: StudioImageInputRef;
      purposes: readonly UploadResourcePurpose[] | undefined;
    }> = [];
    const library = fakeLibrary((locator, purposes) => {
      calls.push({ locator, purposes });
      if (locator.source === "asset") {
        return assetResource(locator.assetId, "artifact-target-primary");
      }
      if (locator.source === "artifact") {
        return artifactResource("asset-reference-owner", locator.artifactId);
      }
      if (locator.uploadResourceId === "upload-reference") {
        return uploadResource(locator.uploadResourceId, "reference");
      }
      if (locator.uploadResourceId === "upload-supporting") {
        return uploadResource(locator.uploadResourceId, "supporting");
      }
      return uploadResource(locator.uploadResourceId, "mask");
    });

    const prepared = await resolveStudioOperationInput(
      {
        kind: "edit",
        prompt: "Preserve the subject and change the synthetic background",
        target: { source: "asset", assetId: "asset-target" },
        references: [
          {
            image: { source: "artifact", artifactId: "artifact-reference-exact" },
            role: "style",
            label: "Lighting"
          },
          {
            image: { source: "upload", uploadResourceId: "upload-reference" },
            role: "previous-output",
            label: "Previous output"
          }
        ],
        supportingImages: [
          {
            image: { source: "upload", uploadResourceId: "upload-supporting" },
            role: "supporting",
            label: "Pose guide"
          }
        ],
        mask: {
          image: { source: "upload", uploadResourceId: "upload-mask" },
          targetSlot: 0
        },
        invariants: { preserve: ["subject identity"] },
        action: "edit",
        previousResponseId: "response-previous",
        imageIds: ["provider-image-previous"],
        fileIds: ["provider-file-previous"]
      },
      options(library)
    );

    expect(calls).toEqual([
      { locator: { source: "asset", assetId: "asset-target" }, purposes: ["target", "image"] },
      {
        locator: { source: "artifact", artifactId: "artifact-reference-exact" },
        purposes: ["reference", "image"]
      },
      {
        locator: { source: "upload", uploadResourceId: "upload-reference" },
        purposes: ["reference", "image"]
      },
      {
        locator: { source: "upload", uploadResourceId: "upload-supporting" },
        purposes: ["supporting", "image"]
      },
      {
        locator: { source: "upload", uploadResourceId: "upload-mask" },
        purposes: ["mask"]
      }
    ]);
    expect(prepared.graph.operationAssetId).toBe("operation-asset-0-0");
    expect(prepared.graph.inputs.map((input) => ({
      key: input.key,
      role: input.role,
      order: input.order,
      origin: input.origin,
      relatedAssetId: input.relatedAssetId,
      artifactId: input.artifactId,
      referenceRole: input.referenceRole,
      label: input.label,
      targetSlot: input.targetSlot
    }))).toEqual([
      {
        key: "target",
        role: "target",
        order: 0,
        origin: "library",
        relatedAssetId: "asset-target",
        artifactId: "artifact-target-primary",
        referenceRole: undefined,
        label: undefined,
        targetSlot: undefined
      },
      {
        key: "reference:0",
        role: "reference",
        order: 1,
        origin: "library",
        relatedAssetId: "asset-reference-owner",
        artifactId: "artifact-reference-exact",
        referenceRole: "style",
        label: "Lighting",
        targetSlot: undefined
      },
      {
        key: "reference:1",
        role: "reference",
        order: 2,
        origin: "upload",
        relatedAssetId: "operation-asset-0-0",
        artifactId: "source-artifact-2-0",
        referenceRole: "previous-output",
        label: "Previous output",
        targetSlot: undefined
      },
      {
        key: "supporting:0",
        role: "supporting",
        order: 3,
        origin: "upload",
        relatedAssetId: "operation-asset-0-0",
        artifactId: "source-artifact-3-0",
        referenceRole: "supporting",
        label: "Pose guide",
        targetSlot: undefined
      },
      {
        key: "mask",
        role: "mask",
        order: 4,
        origin: "upload",
        relatedAssetId: "operation-asset-0-0",
        artifactId: "source-artifact-4-0",
        referenceRole: undefined,
        label: undefined,
        targetSlot: 0
      }
    ]);
    expect(prepared.graph.relationships).toEqual([
      {
        id: "relationship-0-0",
        role: "target",
        relatedAssetId: "asset-target",
        artifactId: "artifact-target-primary",
        order: 0
      },
      {
        id: "relationship-1-0",
        role: "reference",
        relatedAssetId: "asset-reference-owner",
        artifactId: "artifact-reference-exact",
        order: 1,
        label: "Lighting"
      },
      {
        id: "relationship-2-0",
        role: "reference",
        relatedAssetId: "operation-asset-0-0",
        artifactId: "source-artifact-2-0",
        order: 2,
        label: "Previous output"
      },
      {
        id: "relationship-3-0",
        role: "supporting",
        relatedAssetId: "operation-asset-0-0",
        artifactId: "source-artifact-3-0",
        order: 3,
        label: "Pose guide"
      },
      {
        id: "relationship-4-0",
        role: "mask",
        relatedAssetId: "operation-asset-0-0",
        artifactId: "source-artifact-4-0",
        order: 4
      }
    ]);
    expect(prepared.graph.sourceRenditions.map((rendition) => ({
      artifactId: rendition.artifactId,
      phase: rendition.phase,
      requestedBaseName: rendition.requestedBaseName,
      expected: rendition.expected
    }))).toEqual([
      {
        artifactId: "source-artifact-2-0",
        phase: "source",
        requestedBaseName: "reference-2",
        expected: {
          mimeType: "image/png",
          byteLength: 128,
          sha256: SHA,
          width: 8,
          height: 6
        }
      },
      {
        artifactId: "source-artifact-3-0",
        phase: "source",
        requestedBaseName: "supporting-3",
        expected: {
          mimeType: "image/png",
          byteLength: 128,
          sha256: SHA,
          width: 8,
          height: 6
        }
      },
      {
        artifactId: "source-artifact-4-0",
        phase: "source",
        requestedBaseName: "mask-4",
        expected: {
          mimeType: "image/png",
          byteLength: 128,
          sha256: SHA,
          width: 8,
          height: 6
        }
      }
    ]);
    expect(prepared.creationRequest).toMatchObject({
      kind: "edit",
      targetImage: {
        id: "artifact-target-primary",
        path: path.resolve("synthetic-library", "artifact-target-primary.png")
      },
      references: [
        {
          id: "artifact-reference-exact",
          role: "style",
          label: "Lighting"
        },
        {
          id: "source-artifact-2-0",
          role: "previous-output",
          label: "Previous output"
        }
      ],
      supportingImages: [
        {
          id: "source-artifact-3-0",
          role: "supporting",
          label: "Pose guide"
        }
      ],
      maskPath: path.resolve("synthetic-uploads", "upload-mask.png"),
      action: "edit",
      previousResponseId: "response-previous",
      imageIds: ["provider-image-previous"],
      fileIds: ["provider-file-previous"]
    });
    expect(JSON.stringify(prepared.creationRequest)).not.toMatch(
      /assetId|artifactId|uploadResourceId|relativeUrl|data:image|file:\/\//u
    );
  });

  it("accepts exactly sixteen physical images plus one slot-zero mask", async () => {
    const supportingImages = Array.from({ length: 15 }, (_, index) => ({
      image: { source: "upload" as const, uploadResourceId: `upload-supporting-${index}` },
      role: "supporting" as const,
      label: `Supporting ${index}`
    }));
    const library = fakeLibrary((locator) => {
      if (locator.source === "asset") return assetResource(locator.assetId, "artifact-target");
      if (locator.source !== "upload") throw new Error("unexpected artifact locator");
      return uploadResource(
        locator.uploadResourceId,
        locator.uploadResourceId === "upload-mask" ? "mask" : "supporting"
      );
    });
    const prepared = await resolveStudioOperationInput(
      {
        kind: "edit",
        prompt: "Synthetic maximum input edit",
        target: { source: "asset", assetId: "asset-target" },
        supportingImages,
        mask: {
          image: { source: "upload", uploadResourceId: "upload-mask" },
          targetSlot: 0
        },
        invariants: { preserve: ["all synthetic identities"] }
      },
      options(library)
    );

    expect(prepared.graph.physicalImageCount).toBe(16);
    expect(prepared.graph.maskCount).toBe(1);
    expect(prepared.graph.inputs).toHaveLength(17);
    expect(prepared.graph.sourceRenditions).toHaveLength(16);
    expect(prepared.creationRequest.supportingImages).toHaveLength(15);
    expect(prepared.creationRequest.maskPath).toBe(
      path.resolve("synthetic-uploads", "upload-mask.png")
    );
  });

  it("rejects a seventeenth physical image before any Library or provider call", async () => {
    const resolveImageResource = vi.fn();
    const provider = vi.fn();
    const invalid = {
      kind: "edit",
      prompt: "Too many synthetic inputs",
      target: { source: "asset", assetId: "asset-target" },
      references: [
        {
          image: { source: "asset", assetId: "asset-reference" },
          role: "reference"
        }
      ],
      supportingImages: Array.from({ length: 15 }, (_, index) => ({
        image: { source: "upload", uploadResourceId: `upload-${index}` },
        role: "supporting"
      })),
      invariants: { preserve: ["identity"] }
    };
    const prepareAndInvoke = async () => {
      const prepared = await resolveStudioOperationInput(invalid, options({ resolveImageResource }));
      return await provider(prepared.creationRequest);
    };

    await expect(prepareAndInvoke()).rejects.toSatisfy(expectResolutionCode("invalid-request"));
    expect(resolveImageResource).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it("preserves continuation previous-output intent without copying Studio locators", async () => {
    const prepared = await resolveStudioOperationInput(
      {
        kind: "generate",
        prompt: "Continue from a synthetic previous output",
        references: [
          {
            image: { source: "artifact", artifactId: "artifact-previous-output" },
            role: "previous-output",
            label: "Continuation source"
          }
        ],
        action: "generate",
        previousResponseId: "response-continuation",
        imageIds: ["provider-image-continuation"],
        fileIds: ["provider-file-continuation"]
      },
      options(fakeLibrary((locator) => {
        if (locator.source !== "artifact") throw new Error("unexpected locator");
        return artifactResource("asset-previous-output", locator.artifactId);
      }))
    );

    expect(prepared.creationRequest).toMatchObject({
      references: [
        {
          id: "artifact-previous-output",
          role: "previous-output",
          label: "Continuation source"
        }
      ],
      action: "generate",
      previousResponseId: "response-continuation",
      imageIds: ["provider-image-continuation"],
      fileIds: ["provider-file-continuation"]
    });
    expect(JSON.stringify(prepared.creationRequest)).not.toContain("asset-previous-output");
  });

  it("rejects strict locator ambiguity before resolution", async () => {
    const resolveImageResource = vi.fn();
    await expect(
      resolveStudioOperationInput(
        {
          kind: "edit",
          prompt: "Ambiguous synthetic locator",
          target: {
            source: "asset",
            assetId: "asset-target",
            artifactId: "artifact-forbidden-extra"
          },
          invariants: { preserve: ["identity"] }
        },
        options({ resolveImageResource })
      )
    ).rejects.toSatisfy(expectResolutionCode("invalid-request"));
    expect(resolveImageResource).not.toHaveBeenCalled();
  });

  it.each([
    ["not_found", "not-found"],
    ["upload_expired", "resource-unavailable"],
    ["upload_consumed", "resource-unavailable"],
    ["upload_discarded", "resource-unavailable"],
    ["upload_checksum_failed", "resource-integrity"],
    ["upload_invalid_type", "purpose-mismatch"]
  ] as const)("maps %s failures before provider invocation", async (libraryCode, expectedCode) => {
    const provider = vi.fn();
    const prepareAndInvoke = async () => {
      const prepared = await resolveStudioOperationInput(
        {
          kind: "generate",
          prompt: "Synthetic failing locator",
          references: [
            {
              image: { source: "upload", uploadResourceId: "upload-failure" },
              role: "reference"
            }
          ]
        },
        options(fakeLibrary(() => {
          throw new LibraryError(libraryCode, "synthetic library failure");
        }))
      );
      return await provider(prepared.creationRequest);
    };

    await expect(prepareAndInvoke()).rejects.toSatisfy(expectResolutionCode(expectedCode));
    expect(provider).not.toHaveBeenCalled();
  });

  it("rejects an upload whose returned purpose does not match its target role", async () => {
    const resolveImageResource = vi.fn(async () => uploadResource("upload-target", "reference"));
    await expect(
      resolveStudioOperationInput(
        {
          kind: "edit",
          prompt: "Synthetic target purpose mismatch",
          target: { source: "upload", uploadResourceId: "upload-target" },
          invariants: { preserve: ["identity"] }
        },
        options({ resolveImageResource })
      )
    ).rejects.toSatisfy(expectResolutionCode("purpose-mismatch"));
    expect(resolveImageResource).toHaveBeenCalledWith(
      { source: "upload", uploadResourceId: "upload-target" },
      ["target", "image"]
    );
  });

  it("rejects a non-PNG mask before provider invocation", async () => {
    const provider = vi.fn();
    const prepareAndInvoke = async () => {
      const prepared = await resolveStudioOperationInput(
        {
          kind: "edit",
          prompt: "Synthetic invalid mask type",
          target: { source: "asset", assetId: "asset-target" },
          mask: {
            image: { source: "upload", uploadResourceId: "upload-mask-jpeg" },
            targetSlot: 0
          },
          invariants: { preserve: ["identity"] }
        },
        options(fakeLibrary((locator) => {
          if (locator.source === "asset") {
            return assetResource(locator.assetId, "artifact-target");
          }
          if (locator.source !== "upload") throw new Error("unexpected locator");
          return uploadResource(locator.uploadResourceId, "mask", {
            mimeType: "image/jpeg",
            path: path.resolve("synthetic-uploads", "upload-mask-jpeg.jpg")
          });
        }))
      );
      return await provider(prepared.creationRequest);
    };

    await expect(prepareAndInvoke()).rejects.toSatisfy(
      expectResolutionCode("purpose-mismatch")
    );
    expect(provider).not.toHaveBeenCalled();
  });

  it("rejects upload expiry that races with input preparation", async () => {
    await expect(
      resolveStudioOperationInput(
        {
          kind: "generate",
          prompt: "Synthetic expired upload",
          references: [
            {
              image: { source: "upload", uploadResourceId: "upload-expiring" },
              role: "reference"
            }
          ]
        },
        options(fakeLibrary(() =>
          uploadResource("upload-expiring", "reference", {
            expiresAt: NOW.toISOString()
          })
        ))
      )
    ).rejects.toSatisfy(expectResolutionCode("resource-unavailable"));
  });

  it("rechecks earlier uploads after later inputs finish resolving", async () => {
    let nowCalls = 0;
    const now = () => {
      nowCalls += 1;
      return new Date(nowCalls >= 4 ? NOW.getTime() + 2_000 : NOW.getTime());
    };
    await expect(
      resolveStudioOperationInput(
        {
          kind: "generate",
          prompt: "Synthetic multi-input expiry race",
          references: [
            {
              image: { source: "upload", uploadResourceId: "upload-short" },
              role: "reference"
            },
            {
              image: { source: "artifact", artifactId: "artifact-later" },
              role: "style"
            }
          ]
        },
        options(
          fakeLibrary((locator) =>
            locator.source === "upload"
              ? uploadResource(locator.uploadResourceId, "reference", {
                  expiresAt: new Date(NOW.getTime() + 1_000).toISOString()
                })
              : locator.source === "artifact"
                ? artifactResource("asset-later", locator.artifactId)
                : assetResource(locator.assetId, "artifact-later-primary")
          ),
          { now }
        )
      )
    ).rejects.toSatisfy(expectResolutionCode("resource-unavailable"));
  });

  it.each([
    ["relative path", { path: "relative/input.png" }],
    ["invalid checksum", { sha256: "invalid" }],
    ["missing dimensions", { width: undefined, height: undefined }],
    ["ZIP MIME", { mimeType: "application/zip" }]
  ] as const)("rejects corrupt resolved metadata: %s", async (_name, overrides) => {
    await expect(
      resolveStudioOperationInput(
        {
          kind: "generate",
          prompt: "Synthetic corrupt metadata",
          references: [
            {
              image: { source: "upload", uploadResourceId: "upload-corrupt" },
              role: "reference"
            }
          ]
        },
        options(fakeLibrary(() =>
          uploadResource("upload-corrupt", "reference", overrides as never)
        ))
      )
    ).rejects.toSatisfy(expectResolutionCode("resource-integrity"));
  });

  it.each([
    ["null result", null],
    [
      "non-string path",
      uploadResource("upload-malformed", "reference", { path: 42 as never })
    ],
    [
      "oversized path",
      uploadResource("upload-malformed", "reference", {
        path: `${path.resolve("synthetic-uploads")}${path.sep}${"a".repeat(33_000)}`
      })
    ]
  ])("maps malformed resolver output to resource-integrity: %s", async (_name, malformed) => {
    await expect(
      resolveStudioOperationInput(
        {
          kind: "generate",
          prompt: "Synthetic malformed resolver output",
          references: [
            {
              image: { source: "upload", uploadResourceId: "upload-malformed" },
              role: "reference"
            }
          ]
        },
        options(fakeLibrary(() => malformed as never))
      )
    ).rejects.toSatisfy(expectResolutionCode("resource-integrity"));
  });

  it("rejects repeated artifact ownership drift before provider invocation", async () => {
    const provider = vi.fn();
    const prepareAndInvoke = async () => {
      const prepared = await resolveStudioOperationInput(
        {
          kind: "generate",
          prompt: "Synthetic conflicting artifact ownership",
          references: [
            {
              image: { source: "asset", assetId: "asset-owner-one" },
              role: "reference"
            },
            {
              image: { source: "asset", assetId: "asset-owner-two" },
              role: "style"
            }
          ]
        },
        options(fakeLibrary((locator) => {
          if (locator.source !== "asset") throw new Error("unexpected locator");
          return assetResource(locator.assetId, "artifact-shared-conflict");
        }))
      );
      return await provider(prepared.creationRequest);
    };

    await expect(prepareAndInvoke()).rejects.toSatisfy(
      expectResolutionCode("resource-integrity")
    );
    expect(provider).not.toHaveBeenCalled();
  });

  it("allows an exact repeated artifact with stable owner and metadata", async () => {
    const prepared = await resolveStudioOperationInput(
      {
        kind: "generate",
        prompt: "Synthetic repeated exact artifact",
        references: [
          {
            image: { source: "artifact", artifactId: "artifact-repeated" },
            role: "reference"
          },
          {
            image: { source: "artifact", artifactId: "artifact-repeated" },
            role: "style"
          }
        ]
      },
      options(fakeLibrary(() => artifactResource("asset-owner", "artifact-repeated")))
    );

    expect(prepared.creationRequest.references.map((reference) => reference.id)).toEqual([
      "artifact-repeated",
      "artifact-repeated"
    ]);
    expect(prepared.graph.relationships.map((relationship) => relationship.relatedAssetId)).toEqual([
      "asset-owner",
      "asset-owner"
    ]);
  });

  it.each([
    [
      { source: "asset", assetId: "asset-requested" } as const,
      assetResource("asset-other", "artifact-primary")
    ],
    [
      { source: "artifact", artifactId: "artifact-requested" } as const,
      artifactResource("asset-owner", "artifact-other")
    ],
    [
      { source: "upload", uploadResourceId: "upload-requested" } as const,
      uploadResource("upload-other", "reference")
    ]
  ])("rejects inconsistent locator ownership for %o", async (locator, resolved) => {
    await expect(
      resolveStudioOperationInput(
        {
          kind: "generate",
          prompt: "Synthetic inconsistent owner",
          references: [{ image: locator, role: "reference" }]
        },
        options(fakeLibrary(() => resolved))
      )
    ).rejects.toSatisfy(expectResolutionCode("resource-integrity"));
  });

  it("retries deterministic identity allocation and fails closed on exhausted collisions", async () => {
    const idFactory = vi.fn(() => "same-identity");
    await expect(
      resolveStudioOperationInput(
        {
          kind: "generate",
          prompt: "Synthetic identity collision",
          references: [
            {
              image: { source: "upload", uploadResourceId: "upload-collision" },
              role: "reference"
            }
          ]
        },
        options(
          fakeLibrary(() => uploadResource("upload-collision", "reference")),
          { idFactory }
        )
      )
    ).rejects.toSatisfy(expectResolutionCode("identity-conflict"));
    expect(idFactory).toHaveBeenCalledTimes(17);
  });

  it("maps a failing deterministic identity allocator to a safe graph error", async () => {
    await expect(
      resolveStudioOperationInput(
        { kind: "generate", prompt: "Synthetic identity allocator failure" },
        options(fakeLibrary(() => {
          throw new Error("unexpected resolution");
        }), {
          idFactory: () => {
            throw new Error("sensitive allocator failure");
          }
        })
      )
    ).rejects.toSatisfy(expectResolutionCode("identity-conflict"));
  });

  it("requires an explicit deterministic identity allocator even for text-only input", async () => {
    const resolveImageResource = vi.fn();
    await expect(
      resolveStudioOperationInput(
        { kind: "generate", prompt: "Synthetic missing identity owner" },
        {
          library: { resolveImageResource },
          now: () => new Date(NOW)
        } as never
      )
    ).rejects.toSatisfy(expectResolutionCode("invalid-request"));
    expect(resolveImageResource).not.toHaveBeenCalled();
  });

  it("does not mutate the parsed Studio request or expose a public output path", async () => {
    const input: StudioImageOperationRequest = {
      schemaVersion: 1,
      kind: "generate",
      prompt: "Synthetic immutable request",
      references: [],
      size: "auto",
      aspectRatio: "auto",
      quality: "auto",
      format: "png",
      count: 1,
      partialImages: 0,
      transparentMode: "off",
      moderation: "auto",
      action: "auto",
      imageIds: [],
      fileIds: [],
      saveToLibrary: true
    };
    const before = structuredClone(input);
    const prepared = await resolveStudioOperationInput(
      input,
      options(fakeLibrary(() => {
        throw new Error("unexpected resolution");
      }))
    );

    expect(input).toEqual(before);
    expect(prepared.creationRequest).not.toHaveProperty("outputDir");
    expect(prepared.studioRequest).not.toBe(input);
    expect(Object.isFrozen(prepared.studioRequest)).toBe(true);
    expect(Object.isFrozen(prepared.studioRequest.references)).toBe(true);
    expect(Object.isFrozen(prepared.creationRequest)).toBe(true);
    expect(Object.isFrozen(prepared.creationRequest.references)).toBe(true);
    expect(Reflect.set(prepared.creationRequest, "prompt", "mutated")).toBe(false);
    expect(Reflect.set(prepared.creationRequest.references, "0", {})).toBe(false);
  });
});

describe("Task 4.2 generation-only inputs", () => {
  it("creates an empty frozen Studio graph without resolving Library inputs", async () => {
    const resolveImageResource = vi.fn();
    const prepared = await resolveStudioOperationInput(
      { kind: "generate", prompt: "A text-only batch item", format: "png", transparentMode: "native" },
      options({ resolveImageResource })
    );
    expect(resolveImageResource).not.toHaveBeenCalled();
    expect(prepared.graph.inputs).toEqual([]);
    expect(prepared.creationRequest).toMatchObject({
      kind: "generate",
      prompt: "A text-only batch item",
      references: [],
      format: "png",
      transparentMode: "native"
    });
    expect(Object.isFrozen(prepared.creationRequest)).toBe(true);
  });

  it("rejects stale image and concurrency fields before any resolution", async () => {
    const resolveImageResource = vi.fn();
    await expect(resolveStudioOperationInput(
      { kind: "generate", prompt: "stale", references: [], concurrency: 1 },
      options({ resolveImageResource })
    )).rejects.toMatchObject({ code: "invalid-request" });
    expect(resolveImageResource).not.toHaveBeenCalled();
  });
});
