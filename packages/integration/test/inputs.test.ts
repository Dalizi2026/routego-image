import {
  studioImageOperationRequestSchema,
  type StudioImageOperationRequest
} from "@routego-image/contracts";
import type { RoutegoLibraryService } from "@routego-image/library";
import { describe, expect, it, vi } from "vitest";

import {
  StudioInputResolutionError,
  resolveStudioOperationInput,
  type ResolveStudioOperationInputOptions
} from "../src/composition/inputs";
import type { InputGraphIdFactory } from "../src/composition/graph";

const NOW = new Date("2026-07-18T12:00:00.000Z");

type ImageOwner = Pick<RoutegoLibraryService, "resolveImageResource">;

function deterministicIdFactory(
  kind: Parameters<InputGraphIdFactory>[0],
  order: number,
  attempt: number
): string {
  return `${kind}-${order}-${attempt}`;
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

  it("projects only approved Studio controls into a generation-only Creation request", async () => {
    const resolveImageResource = vi.fn();
    const prepared = await resolveStudioOperationInput(
      {
        kind: "generate",
        prompt: "A controlled text-only scene",
        size: "auto",
        aspectRatio: "auto",
        format: "png",
        count: 1,
        transparentMode: "native",
        saveToLibrary: false
      },
      options({ resolveImageResource })
    );

    expect(resolveImageResource).not.toHaveBeenCalled();
    expect(prepared.creationRequest).toMatchObject({
      kind: "generate",
      prompt: "A controlled text-only scene",
      references: [],
      size: "auto",
      aspectRatio: "auto",
      format: "png",
      count: 1,
      transparentMode: "native",
      saveToLibrary: false
    });
    expect(prepared.creationRequest).not.toHaveProperty("outputDir");
  });

  it.each([
    ["edit kind", { kind: "edit", prompt: "removed edit", target: { source: "asset", assetId: "asset-1" } }],
    ["references", { kind: "generate", prompt: "stale references", references: [] }],
    ["target", { kind: "generate", prompt: "stale target", target: { source: "asset", assetId: "asset-1" } }],
    ["supporting images", { kind: "generate", prompt: "stale support", supportingImages: [] }],
    ["mask", { kind: "generate", prompt: "stale mask", mask: { image: { source: "upload", uploadResourceId: "upload-1" }, targetSlot: 0 } }],
    ["continuation ids", { kind: "generate", prompt: "stale continuation", previousResponseId: "response-1", imageIds: ["image-1"], fileIds: ["file-1"] }],
    ["action", { kind: "generate", prompt: "stale action", action: "generate" }],
    ["concurrency", { kind: "generate", prompt: "stale concurrency", concurrency: 1 }]
  ])("rejects removed Studio image input field: %s", async (_name, input) => {
    const resolveImageResource = vi.fn();
    await expect(
      resolveStudioOperationInput(input, options({ resolveImageResource }))
    ).rejects.toSatisfy(expectResolutionCode("invalid-request"));
    expect(resolveImageResource).not.toHaveBeenCalled();
  });

  it("maps a failing deterministic identity allocator to a safe graph error", async () => {
    await expect(
      resolveStudioOperationInput(
        { kind: "generate", prompt: "Synthetic identity allocator failure" },
        options({ resolveImageResource: vi.fn() }, {
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
    const input: StudioImageOperationRequest = studioImageOperationRequestSchema.parse({
      kind: "generate",
      prompt: "Synthetic immutable request",
      size: "auto",
      aspectRatio: "auto",
      format: "png",
      count: 1,
      transparentMode: "off",
      saveToLibrary: true
    });
    const before = structuredClone(input);
    const prepared = await resolveStudioOperationInput(
      input,
      options({ resolveImageResource: vi.fn() })
    );

    expect(input).toEqual(before);
    expect(prepared.creationRequest).not.toHaveProperty("outputDir");
    expect(prepared.studioRequest).not.toBe(input);
    expect(Object.isFrozen(prepared.studioRequest)).toBe(true);
    expect(Object.isFrozen(prepared.creationRequest)).toBe(true);
    expect(Object.isFrozen(prepared.creationRequest.references)).toBe(true);
    expect(Reflect.set(prepared.creationRequest, "prompt", "mutated")).toBe(false);
    expect(Reflect.set(prepared.creationRequest.references, "0", {})).toBe(false);
  });
});
