import { describe, expect, it } from "vitest";

import {
  generationRecipeSchema,
  imageOperationResultSchema,
  parseRoutegoOperationInput,
  parseRoutegoOperationOutput,
  routegoBatchInputSchema,
  routegoBatchResultSchema,
  routegoEditInputSchema,
  routegoManageLibraryInputSchema,
  routegoManageLibraryResultSchema,
  routegoOpenStudioInputSchema,
  routegoOpenStudioResultSchema,
  routegoOperationDefinitions,
  routegoOperationNames,
  routegoPrepareRegenerationInputSchema,
  routegoPrepareRegenerationResultSchema,
  routegoSearchLibraryInputSchema,
  routegoSearchLibraryResultSchema,
  routegoStatusInputSchema,
  routegoStatusResultSchema
} from "../src/index";
import { createGenerateRequest, createSuccessResult, TEST_TIMESTAMP } from "./fixtures";

describe("public tool contracts", () => {
  it("freezes all MCP names and loopback HTTP mappings to shared schemas", () => {
    expect(routegoOperationNames).toEqual([
      "status",
      "generate",
      "edit",
      "prepareRegeneration",
      "batch",
      "searchLibrary",
      "manageLibrary",
      "openStudio"
    ]);
    expect(Object.values(routegoOperationDefinitions).map((item) => item.toolName)).toEqual([
      "routego_status",
      "routego_generate",
      "routego_edit",
      "routego_prepare_regeneration",
      "routego_batch",
      "routego_search_library",
      "routego_manage_library",
      "routego_open_studio"
    ]);
    expect(routegoOperationNames).toHaveLength(8);

    for (const operation of routegoOperationNames) {
      const definition = routegoOperationDefinitions[operation];
      expect(definition.http.path).toMatch(/^\/api\/v1\//u);
      expect(definition.inputSchema).toBe(routegoOperationDefinitions[operation].inputSchema);
      expect(definition.outputSchema).toBe(routegoOperationDefinitions[operation].outputSchema);
    }
  });

  it("validates status input/result and billable-probe confirmation semantics", () => {
    expect(routegoStatusInputSchema.parse({})).toEqual({
      refreshCapabilities: false,
      confirmBillableProbe: false
    });
    expect(routegoStatusInputSchema.safeParse({ confirmBillableProbe: true }).success).toBe(false);

    const result = routegoStatusResultSchema.parse({
      schemaVersion: 1,
      configured: false,
      hasApiKey: false,
      models: [],
      capabilities: [],
      defaults: {
        size: "auto",
        aspectRatio: "auto",
        quality: "auto",
        format: "png",
        count: 1,
        partialImages: 0,
        transparentMode: "off",
        moderation: "auto",
        saveToLibrary: true
      },
      service: {
        status: "ready",
        version: "1.0.0",
        nodeVersion: "v20.19.0",
        uptimeSeconds: 1,
        mcpAvailable: true,
        httpAvailable: true,
        studioAvailable: false
      }
    });
    expect(result.hasApiKey).toBe(false);
  });

  it("keeps generation-only batches with fixed concurrency two", () => {
    const input = routegoBatchInputSchema.parse({
      tasks: [
        { id: "task-generate-a", operation: createGenerateRequest({ count: 4 }) },
        { id: "task-generate-b", operation: createGenerateRequest({ prompt: "第二张独立生成" }) }
      ]
    });
    expect(input.tasks.map((item) => item.id)).toEqual(["task-generate-a", "task-generate-b"]);
    expect(input.tasks[0]?.operation.count).toBe(4);
    expect(input.concurrency).toBe(2);

    expect(
      routegoBatchInputSchema.safeParse({
        tasks: [
          { id: "duplicate", operation: createGenerateRequest() },
          { id: "duplicate", operation: createGenerateRequest() }
        ]
      }).success
    ).toBe(false);
    expect(
      routegoBatchInputSchema.safeParse({
        tasks: Array.from({ length: 21 }, (_, index) => ({
          id: `task-${index}`,
          operation: createGenerateRequest()
        }))
      }).success
    ).toBe(false);
    expect(
      routegoBatchInputSchema.safeParse({
        tasks: [{ id: "task-1", operation: createGenerateRequest() }],
        concurrency: 3
      }).success
    ).toBe(false);
    expect(
      routegoBatchInputSchema.safeParse({
        tasks: [{ id: "task-1", operation: createGenerateRequest() }],
        concurrency: 2
      }).success
    ).toBe(false);
    expect(
      routegoBatchResultSchema.safeParse({
        schemaVersion: 1,
        requestId: "batch-result-1",
        status: "succeeded",
        concurrency: 3,
        items: [{ id: "task-1", result: createSuccessResult() }]
      }).success
    ).toBe(false);
  });

  it("validates direct edit inputs and accepts read-only prepare_regeneration recipes", () => {
    const edit = routegoEditInputSchema.parse({
      kind: "edit",
      prompt: "Replace the jacket with a red dress",
      targetImage: { path: "/tmp/target.png" },
      references: [{ path: "/tmp/style.png", role: "style" }],
      invariants: { preserve: ["identity", "pose"] }
    });
    expect(edit.kind).toBe("edit");
    expect(edit.references).toHaveLength(1);
    expect(
      routegoEditInputSchema.safeParse({
        kind: "edit",
        prompt: "should fail",
        targetImage: { path: "/tmp/target.png" },
        invariants: {}
      }).success
    ).toBe(false);
    expect(routegoEditInputSchema.safeParse({ kind: "edit" }).success).toBe(false);
    expect(
      routegoBatchInputSchema.safeParse({
        tasks: [{ id: "edit-not-batchable", operation: edit }]
      }).success
    ).toBe(false);

    expect(routegoPrepareRegenerationInputSchema.safeParse({}).success).toBe(false);
    expect(
      routegoPrepareRegenerationInputSchema.parse({
        recordId: "asset-generation-1"
      })
    ).toEqual({
      schemaVersion: 1,
      recordId: "asset-generation-1"
    });
    expect(
      routegoPrepareRegenerationInputSchema.safeParse({
        recordId: "asset-1",
        unknown: true
      }).success
    ).toBe(false);

    const recipe = generationRecipeSchema.parse({
      kind: "generate",
      sourceRecordId: "asset-generation-1",
      prompt: "宇航猫 🚀",
      referenceIds: ["ref-1", "ref-2"],
      size: "1024x1024",
      count: 2
    });
    expect(recipe.referenceIds).toEqual(["ref-1", "ref-2"]);
    expect(recipe).not.toHaveProperty("outputDir");
    expect(
      generationRecipeSchema.safeParse({
        kind: "generate",
        sourceRecordId: "asset-1",
        prompt: "too many refs",
        referenceIds: ["a", "b", "c", "d", "e", "f"]
      }).success
    ).toBe(false);
    expect(
      generationRecipeSchema.safeParse({
        kind: "generate",
        sourceRecordId: "asset-1",
        prompt: "path leak",
        referenceIds: [],
        outputDir: "/Users/secret/out"
      }).success
    ).toBe(false);

    const prepared = routegoPrepareRegenerationResultSchema.parse({
      schemaVersion: 1,
      recipe,
      providerRequestCount: 0,
      markUnchanged: true
    });
    expect(prepared.providerRequestCount).toBe(0);
    expect(prepared.markUnchanged).toBe(true);
    expect(
      routegoPrepareRegenerationResultSchema.safeParse({
        schemaVersion: 1,
        recipe,
        providerRequestCount: 1,
        markUnchanged: true
      }).success
    ).toBe(false);
  });

  it("accepts non-ASCII library paths and folder names without truncation", () => {
    const searchResult = routegoSearchLibraryResultSchema.parse({
      schemaVersion: 1,
      items: [
        {
          id: "asset-1",
          path: "C:\\Users\\测试 用户\\Pictures\\结果 图.png",
          prompt: "宇航猫 🚀\r\n第二行",
          model: "gpt-image-2",
          kind: "generate",
          mimeType: "image/png",
          width: 1024,
          height: 1024,
          status: "succeeded",
          folderIds: ["folder-1"],
          createdAt: TEST_TIMESTAMP
        }
      ]
    });
    expect(searchResult.items[0]?.path).toContain("测试 用户");

    const manage = routegoManageLibraryInputSchema.parse({
      action: "create-folder",
      name: "收藏夹 🎨"
    });
    expect(manage.action).toBe("create-folder");
    expect(
      routegoManageLibraryResultSchema.parse({
        schemaVersion: 1,
        action: "create-folder",
        affectedAssetIds: [],
        affectedFolderIds: ["folder-new"],
        warnings: []
      }).affectedFolderIds
    ).toEqual(["folder-new"]);
  });

  it("validates Studio loopback output with a session token", () => {
    expect(routegoOpenStudioInputSchema.parse({})).toEqual({
      reuseExisting: true,
      address: "127.0.0.1"
    });
    expect(
      routegoOpenStudioResultSchema.parse({
        schemaVersion: 1,
        url: "http://127.0.0.1:43119/?token=synthetic-session",
        expiresAt: TEST_TIMESTAMP,
        reused: false,
        address: "127.0.0.1"
      }).url
    ).toContain("token=");
    expect(
      routegoOpenStudioResultSchema.safeParse({
        schemaVersion: 1,
        url: "http://127.0.0.1:43119/",
        expiresAt: TEST_TIMESTAMP,
        reused: false,
        address: "127.0.0.1"
      }).success
    ).toBe(false);
  });

  it("dispatches inputs and outputs through the exact shared operation schemas", () => {
    const generate = createGenerateRequest();
    const imageResult = createSuccessResult(generate);
    const batchRawInput = {
      tasks: [{ id: "task-1", operation: generate }]
    };
    const batchInput = routegoBatchInputSchema.parse(batchRawInput);
    expect(batchInput.concurrency).toBe(2);
    const batchResult = routegoBatchResultSchema.parse({
      schemaVersion: 1,
      requestId: "batch-result-1",
      status: "succeeded",
      concurrency: 2,
      items: [{ id: "task-1", result: imageResult }]
    });
    const prepareInput = routegoPrepareRegenerationInputSchema.parse({
      recordId: "asset-generation-1"
    });
    const prepareOutput = routegoPrepareRegenerationResultSchema.parse({
      schemaVersion: 1,
      recipe: {
        kind: "generate",
        sourceRecordId: "asset-generation-1",
        prompt: generate.prompt,
        referenceIds: [],
        size: generate.size,
        aspectRatio: generate.aspectRatio,
        quality: generate.quality,
        format: generate.format,
        count: generate.count,
        partialImages: generate.partialImages,
        transparentMode: generate.transparentMode,
        moderation: generate.moderation,
        saveToLibrary: generate.saveToLibrary
      },
      providerRequestCount: 0,
      markUnchanged: true
    });
    const edit = routegoEditInputSchema.parse({
      kind: "edit",
      prompt: "Change the clothing only",
      targetImage: { path: "/tmp/target.png" },
      invariants: { preserve: ["identity"] }
    });
    const fixtures = {
      status: {
        input: routegoStatusInputSchema.parse({}),
        output: routegoStatusResultSchema.parse({
          schemaVersion: 1,
          configured: false,
          hasApiKey: false,
          models: [],
          capabilities: [],
          defaults: {
            size: "auto",
            aspectRatio: "auto",
            quality: "auto",
            format: "png",
            count: 1,
            partialImages: 0,
            transparentMode: "off",
            moderation: "auto",
            saveToLibrary: true
          },
          service: {
            status: "ready",
            version: "1.0.0",
            nodeVersion: "v20.19.0",
            uptimeSeconds: 0,
            mcpAvailable: true,
            httpAvailable: true,
            studioAvailable: false
          }
        })
      },
      generate: { input: generate, output: imageOperationResultSchema.parse(imageResult) },
      edit: { input: edit, output: imageOperationResultSchema.parse({
        ...imageResult,
        requestedParams: edit,
        effectiveParams: edit
      }) },
      prepareRegeneration: { input: prepareInput, output: prepareOutput },
      batch: { input: batchRawInput, output: batchResult },
      searchLibrary: {
        input: routegoSearchLibraryInputSchema.parse({}),
        output: routegoSearchLibraryResultSchema.parse({ schemaVersion: 1, items: [] })
      },
      manageLibrary: {
        input: routegoManageLibraryInputSchema.parse({ action: "create-folder", name: "测试" }),
        output: routegoManageLibraryResultSchema.parse({
          schemaVersion: 1,
          action: "create-folder",
          affectedAssetIds: [],
          affectedFolderIds: ["folder-1"],
          warnings: []
        })
      },
      openStudio: {
        input: routegoOpenStudioInputSchema.parse({}),
        output: routegoOpenStudioResultSchema.parse({
          schemaVersion: 1,
          url: "http://127.0.0.1:43119/?token=synthetic-session",
          expiresAt: TEST_TIMESTAMP,
          reused: false,
          address: "127.0.0.1"
        })
      }
    } as const;

    for (const operation of routegoOperationNames) {
      const parsedInput = parseRoutegoOperationInput(operation, fixtures[operation].input);
      if (operation === "batch") {
        expect(parsedInput).toEqual(batchInput);
      } else {
        expect(parsedInput).toEqual(fixtures[operation].input);
      }
      expect(parseRoutegoOperationOutput(operation, fixtures[operation].output)).toEqual(
        fixtures[operation].output
      );
    }
  });

  it("rejects unknown fields at public boundaries", () => {
    expect(routegoSearchLibraryInputSchema.safeParse({ limit: 10, unknown: true }).success).toBe(
      false
    );
    expect(
      routegoManageLibraryInputSchema.safeParse({
        action: "create-folder",
        name: "folder",
        unknown: true
      }).success
    ).toBe(false);
    expect(
      routegoPrepareRegenerationInputSchema.safeParse({
        recordId: "asset-1",
        path: "/Users/secret.png"
      }).success
    ).toBe(false);
  });
});
