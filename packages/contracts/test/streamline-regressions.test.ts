import { describe, expect, it } from "vitest";

import {
  copyGenerationInfoResultSchema,
  generationRecipeSchema,
  imageOperationRequestSchema,
  routegoBatchInputSchema,
  routegoBatchResultSchema,
  routegoPrepareRegenerationInputSchema,
  routegoPrepareRegenerationResultSchema
} from "../src/index";
import { createGenerateRequest, createSuccessResult } from "./fixtures";

const reference = (index: number) => ({
  id: `reference-${index}`,
  path: `/tmp/reference-${index}.png`,
  role: "reference" as const,
  label: `Reference ${index}`
});

const recipe = {
  kind: "generate" as const,
  sourceRecordId: "asset-generation-1",
  prompt: "A safe regeneration recipe",
  referenceIds: ["reference-1", "reference-2"],
  size: "1024x1024",
  aspectRatio: "auto",
  quality: "high" as const,
  format: "png" as const,
  count: 2,
  partialImages: 0,
  transparentMode: "off" as const,
  moderation: "auto" as const,
  saveToLibrary: true
};

describe("streamlined generation contract regressions", () => {
  it("accepts exactly five ordered references and rejects a sixth before execution", () => {
    const references = Array.from({ length: 5 }, (_, index) => reference(index));
    const parsed = imageOperationRequestSchema.parse({
      kind: "generate",
      prompt: "Use all five references in order.",
      references
    });

    expect(parsed.references.map((item) => item.id)).toEqual([
      "reference-0",
      "reference-1",
      "reference-2",
      "reference-3",
      "reference-4"
    ]);
    expect(
      imageOperationRequestSchema.safeParse({
        kind: "generate",
        prompt: "A sixth reference is invalid.",
        references: [...references, reference(5)]
      }).success
    ).toBe(false);
  });

  it.each([
    { target: { path: "/tmp/target.png" } },
    { targetImage: { path: "/tmp/target.png" } },
    { mask: { path: "/tmp/mask.png" } },
    { maskPath: "/tmp/mask.png" },
    { invariants: { preserve: ["subject"] } },
    { action: "edit" },
    { editAction: "inpaint" },
    { continuationId: "continuation-1" },
    { previousResponseId: "response-1" },
    { imageIds: ["image-1"] },
    { fileIds: ["file-1"] }
  ])("strictly rejects removed generation field %#", (removedField) => {
    expect(
      imageOperationRequestSchema.safeParse({
        kind: "generate",
        prompt: "This request must remain generation-only.",
        ...removedField
      }).success
    ).toBe(false);
  });

  it("fixes batch concurrency at two while preserving task order and generation-only input", () => {
    const first = createGenerateRequest({ prompt: "First independent generation" });
    const second = createGenerateRequest({ prompt: "Second independent generation" });
    const input = routegoBatchInputSchema.parse({
      tasks: [
        { id: "task-first", operation: first },
        { id: "task-second", operation: second }
      ]
    });

    expect(input.concurrency).toBe(2);
    expect(input.tasks.map((task) => task.id)).toEqual(["task-first", "task-second"]);

    for (const concurrency of [1, 2, 3]) {
      expect(
        routegoBatchInputSchema.safeParse({
          tasks: [{ id: "task-first", operation: first }],
          concurrency
        }).success
      ).toBe(false);
    }
    expect(
      routegoBatchInputSchema.safeParse({
        tasks: [
          {
            id: "task-edit",
            operation: { kind: "edit", prompt: "must reject", target: { path: "/tmp/target.png" } }
          }
        ]
      }).success
    ).toBe(false);
    expect(
      routegoBatchResultSchema.safeParse({
        schemaVersion: 1,
        requestId: "batch-result",
        status: "succeeded",
        concurrency: 3,
        items: [{ id: "task-first", result: createSuccessResult(first) }]
      }).success
    ).toBe(false);
  });

  it("accepts only path-free, secret-free read-only regeneration recipes", () => {
    const parsedRecipe = generationRecipeSchema.parse(recipe);
    expect(parsedRecipe.referenceIds).toEqual(["reference-1", "reference-2"]);
    expect(routegoPrepareRegenerationInputSchema.parse({ recordId: recipe.sourceRecordId })).toEqual({
      schemaVersion: 1,
      recordId: recipe.sourceRecordId
    });
    expect(
      routegoPrepareRegenerationResultSchema.parse({
        schemaVersion: 1,
        recipe: parsedRecipe,
        providerRequestCount: 0,
        markUnchanged: true
      })
    ).toMatchObject({ providerRequestCount: 0, markUnchanged: true });

    for (const unsafeField of [
      { outputDir: "/Users/synthetic/output" },
      { path: "/tmp/recipe.json" },
      { referencePaths: ["/tmp/reference.png"] },
      { apiKey: "synthetic-secret" },
      { authorization: "Bearer synthetic-secret" },
      { providerHeaders: { Authorization: "Bearer synthetic-secret" } }
    ]) {
      expect(generationRecipeSchema.safeParse({ ...recipe, ...unsafeField }).success).toBe(false);
    }
    expect(
      routegoPrepareRegenerationInputSchema.safeParse({
        recordId: recipe.sourceRecordId,
        path: "/tmp/record.json"
      }).success
    ).toBe(false);
    expect(
      routegoPrepareRegenerationResultSchema.safeParse({
        schemaVersion: 1,
        recipe: parsedRecipe,
        providerRequestCount: 0,
        markUnchanged: true,
        authorization: "Bearer synthetic-secret"
      }).success
    ).toBe(false);
  });

  it.each([
    "path=/tmp/asset.png",
    "file:///Users/synthetic/asset.png",
    "https://example.invalid/private-image.png",
    "Authorization: Bearer synthetic-secret",
    "api_key=synthetic-secret",
    "data:image/png;base64,AAAA"
  ])("rejects unsafe copied generation information: %s", (clipboardText) => {
    expect(
      copyGenerationInfoResultSchema.safeParse({
        schemaVersion: 1,
        status: "succeeded",
        providerRequestCount: 0,
        projection: {
          recordId: recipe.sourceRecordId,
          prompt: recipe.prompt,
          referenceIds: recipe.referenceIds,
          parameters: {
            size: recipe.size,
            aspectRatio: recipe.aspectRatio,
            quality: recipe.quality,
            format: recipe.format,
            count: recipe.count,
            transparentMode: recipe.transparentMode,
            moderation: recipe.moderation
          }
        },
        clipboardText
      }).success
    ).toBe(false);
  });
});
