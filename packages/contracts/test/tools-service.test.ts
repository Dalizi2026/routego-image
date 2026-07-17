import { describe, expect, it } from "vitest";

import {
  imageOperationResultSchema,
  parseRoutegoOperationInput,
  parseRoutegoOperationOutput,
  routegoBatchInputSchema,
  routegoBatchResultSchema,
  routegoManageLibraryInputSchema,
  routegoManageLibraryResultSchema,
  routegoOpenStudioInputSchema,
  routegoOpenStudioResultSchema,
  routegoOperationDefinitions,
  routegoOperationNames,
  routegoSearchLibraryInputSchema,
  routegoSearchLibraryResultSchema,
  routegoStatusInputSchema,
  routegoStatusResultSchema
} from "../src/index";
import {
  createEditRequest,
  createGenerateRequest,
  createSuccessResult,
  TEST_TIMESTAMP
} from "./fixtures";

describe("seven public tool contracts", () => {
  it("freezes all seven MCP names and loopback HTTP mappings to shared schemas", () => {
    expect(routegoOperationNames).toEqual([
      "status",
      "generate",
      "edit",
      "batch",
      "searchLibrary",
      "manageLibrary",
      "openStudio"
    ]);
    expect(Object.values(routegoOperationDefinitions).map((item) => item.toolName)).toEqual([
      "routego_status",
      "routego_generate",
      "routego_edit",
      "routego_batch",
      "routego_search_library",
      "routego_manage_library",
      "routego_open_studio"
    ]);

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
    expect(
      routegoStatusInputSchema.safeParse({ confirmBillableProbe: true }).success
    ).toBe(false);

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

  it("keeps variants separate from a bounded ordered batch", () => {
    const input = routegoBatchInputSchema.parse({
      tasks: [
        { id: "task-generate", operation: createGenerateRequest({ count: 4 }) },
        { id: "task-edit", operation: createEditRequest() }
      ],
      concurrency: 10
    });
    expect(input.tasks.map((item) => item.id)).toEqual(["task-generate", "task-edit"]);
    expect(input.tasks[0]?.operation.count).toBe(4);
    expect(input.concurrency).toBe(10);

    expect(
      routegoBatchInputSchema.safeParse({
        tasks: [{ id: "duplicate", operation: createGenerateRequest() }, { id: "duplicate", operation: createGenerateRequest() }]
      }).success
    ).toBe(false);
    expect(
      routegoBatchInputSchema.safeParse({
        tasks: Array.from({ length: 21 }, (_, index) => ({
          id: `task-${index}`,
          operation: createGenerateRequest()
        })),
        concurrency: 11
      }).success
    ).toBe(false);
  });

  it("validates library search/manage and UTF-8 path results", () => {
    const search = routegoSearchLibraryInputSchema.parse({
      query: "宇航猫 🚀",
      kinds: ["generate"],
      statuses: ["succeeded"],
      limit: 20
    });
    expect(search.query).toBe("宇航猫 🚀");

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
    const edit = createEditRequest();
    const imageResult = createSuccessResult(generate);
    const batchInput = routegoBatchInputSchema.parse({
      tasks: [{ id: "task-1", operation: generate }],
      concurrency: 1
    });
    const batchResult = routegoBatchResultSchema.parse({
      schemaVersion: 1,
      requestId: "batch-result-1",
      status: "succeeded",
      concurrency: 1,
      items: [{ id: "task-1", result: imageResult }]
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
      edit: { input: edit, output: imageOperationResultSchema.parse(createSuccessResult(edit)) },
      batch: { input: batchInput, output: batchResult },
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
      expect(parseRoutegoOperationInput(operation, fixtures[operation].input)).toEqual(
        fixtures[operation].input
      );
      expect(parseRoutegoOperationOutput(operation, fixtures[operation].output)).toEqual(
        fixtures[operation].output
      );
    }
  });

  it("rejects unknown fields at public boundaries", () => {
    expect(routegoSearchLibraryInputSchema.safeParse({ limit: 10, unknown: true }).success).toBe(false);
    expect(
      routegoManageLibraryInputSchema.safeParse({
        action: "create-folder",
        name: "folder",
        unknown: true
      }).success
    ).toBe(false);
  });
});
