import { describe, expect, it, vi } from "vitest";

import {
  imageOperationRequestSchema,
  imageOperationResultSchema,
  routegoBatchResultSchema,
  routegoManageLibraryResultSchema,
  routegoOpenStudioResultSchema,
  routegoOperationDefinitions,
  routegoOperationNames,
  routegoSearchLibraryResultSchema,
  routegoStatusResultSchema,
  type ImageOperationRequest,
  type RoutegoService
} from "@routego-image/contracts";
import {
  JsonRpcLineDecoder,
  ROUTEGO_MCP_PROTOCOL_VERSION,
  createRoutegoMcpServer,
  type JsonRpcResponse,
  type McpToolResult
} from "../src/runtime/mcp/index";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZVt8AAAAASUVORK5CYII=";
const GIF_BASE64 = "R0lGODlhAQABAIAAAAUEBA==";
const SVG_BASE64 = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxyZWN0IHdpZHRoPSIxIiBoZWlnaHQ9IjEiLz48L3N2Zz4=";
const UNKNOWN_HEADER_BASE64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0123456789abcd".repeat(2);
const ORDINARY_LONG_TEXT =
  "This is deliberately long ordinary prose with spaces and punctuation; it must remain readable after projection. " +
  "This is deliberately long ordinary prose with spaces and punctuation; it must remain readable after projection.";
const GIF_DATA_URL = `data:image/gif;base64,${GIF_BASE64}`;
const SVG_DATA_URL = `data:image/svg+xml;charset=utf-8;base64,${SVG_BASE64}`;
const CUSTOM_DATA_URL = `data:image/x-routego-synthetic;profile=test;base64,${UNKNOWN_HEADER_BASE64}`;
const PARAMETERIZED_PNG_DATA_URL = `data:image/png;charset=utf-8;base64,${PNG_BASE64}`;
const PERCENT_ENCODED_SVG_DATA_URL =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E";
const ORDINARY_WEB_URL = "https://example.invalid/docs/image.svg?view=ordinary";

function request(prompt = "MCP synthetic image"): ImageOperationRequest {
  return imageOperationRequestSchema.parse({ kind: "generate", prompt });
}

function editRequest(
  prompt = "MCP synthetic edit",
  embeddedImagePayload?: string
): ImageOperationRequest {
  const payloadSuffix = embeddedImagePayload === undefined ? "" : ` ${embeddedImagePayload}`;
  return imageOperationRequestSchema.parse({
    kind: "edit",
    prompt,
    targetImage: {
      path: "/synthetic/target.png",
      label: `Synthetic target${payloadSuffix}`
    },
    invariants: { preserve: [`Keep the synthetic subject identity.${payloadSuffix}`] }
  });
}

function imageResult(
  input: unknown,
  options: {
    readonly artifactId?: string;
    readonly path?: string;
    readonly requestId?: string;
    readonly withPartial?: boolean;
  } = {}
) {
  const parsedInput = imageOperationRequestSchema.parse(input);
  const artifactId = options.artifactId ?? "artifact-mcp";
  return imageOperationResultSchema.parse({
    schemaVersion: 1,
    requestId: options.requestId ?? "request-mcp-result",
    status: "succeeded",
    requestedParams: parsedInput,
    effectiveParams: parsedInput,
    execution: {
      transport: "single-endpoint-json",
      attemptCount: 1,
      providerRequestCount: 1,
      receivedAnyOutput: true,
      mayHaveBilled: true,
      degradedContinuation: false,
      providerImageIds: ["provider-image-mcp"]
    },
    finalArtifacts: [
      {
        id: artifactId,
        slot: 0,
        phase: "final",
        ...(options.path === undefined ? {} : { path: options.path }),
        mimeType: "image/png",
        byteLength: 68,
        width: 1,
        height: 1,
        sha256: "a".repeat(64),
        providerImageId: `provider-${artifactId}`,
        display: { type: "image", dataUrl: `data:image/png;base64,${PNG_BASE64}` },
        createdAt: "2026-07-18T12:00:00.000Z"
      }
    ],
    partialArtifacts: options.withPartial
      ? [
          {
            id: `${artifactId}-partial`,
            slot: 0,
            phase: "partial",
            mimeType: "image/png",
            display: { type: "image", dataUrl: `data:image/png;base64,${PNG_BASE64}` },
            createdAt: "2026-07-18T11:59:59.000Z"
          }
        ]
      : [],
    failedSlots: [],
    relationships: [
      {
        inputRole: "output",
        outputArtifactId: artifactId,
        order: 0
      }
    ]
  });
}

function failedImageResult(input: unknown) {
  const parsedInput = imageOperationRequestSchema.parse(input);
  return imageOperationResultSchema.parse({
    schemaVersion: 1,
    requestId: "request-mcp-failed",
    status: "failed",
    requestedParams: parsedInput,
    effectiveParams: parsedInput,
    execution: {
      transport: "single-endpoint-json",
      attemptCount: 1,
      providerRequestCount: 1,
      receivedAnyOutput: false,
      mayHaveBilled: false,
      degradedContinuation: false,
      providerImageIds: []
    },
    finalArtifacts: [],
    partialArtifacts: [],
    failedSlots: [],
    relationships: [],
    error: {
      code: "invalid_response",
      category: "protocol",
      stage: "stream",
      safeMessage:
        `Authorization: Bearer synthetic-secret https://relay.invalid/error?token=synthetic ` +
        `C:\\Users\\Synthetic User\\私密\\image.png ` +
        `\\\\synthetic-server\\Private Share\\私密 图.png ` +
        `/home/Synthetic User/私密/image.png ../private folder/私密.png ` +
        `file:///C:/Users/Synthetic%20User/private/image.png ` +
        `file:///home/Synthetic%20User/private/image.png ` +
        `source:'file:///home/Synthetic%20User/punctuation/私密 image.png' ` +
        `source:'../punctuation folder/私密 image.png' ` +
        `${GIF_DATA_URL} ${SVG_DATA_URL} ${PERCENT_ENCODED_SVG_DATA_URL} ${UNKNOWN_HEADER_BASE64}`,
      retryDisposition: "never",
      partialArtifacts: [],
      receivedAnyOutput: false,
      mayHaveBilled: false,
      details: {
        authorization: "Bearer synthetic-secret",
        endpoint: "https://relay.invalid/error?token=synthetic",
        windowsPath: "C:\\Users\\Synthetic User\\私密\\image.png",
        uncPath: "\\\\synthetic-server\\Private Share\\私密 图.png",
        posixPath: "/home/Synthetic User/私密/image.png",
        windowsRelativePath: "..\\private folder\\私密.png",
        posixRelativePath: "../private folder/私密.png",
        windowsFileUrl: "file:///C:/Users/Synthetic%20User/private/image.png",
        posixFileUrl: "file:///home/Synthetic%20User/private/image.png",
        bytes: [137, 80, 78, 71, 13, 10, 26, 10],
        dataUrl: `data:image/png;base64,${PNG_BASE64}`,
        arbitrary: {
          note: "source:'C:\\Users\\Synthetic User\\punctuation\\私密 image.png'",
          shortFragment: [137, 80, 78],
          snapshot: [137, 80, 78, 71, 13, 10, 26, 10],
          bufferShape: { type: "Buffer", data: [255, 216, 255, 224] },
          imagePayload: CUSTOM_DATA_URL,
          percentImagePayload: PERCENT_ENCODED_SVG_DATA_URL,
          rawPayload: UNKNOWN_HEADER_BASE64
        }
      }
    }
  });
}

function service(overrides: Record<string, unknown>): RoutegoService {
  const unavailable = async () => {
    throw new Error("Unused service method");
  };
  return {
    status: unavailable,
    generate: unavailable,
    edit: unavailable,
    batch: unavailable,
    searchLibrary: unavailable,
    manageLibrary: unavailable,
    openStudio: unavailable,
    ...overrides
  } as RoutegoService;
}

async function initialize(server: ReturnType<typeof createRoutegoMcpServer>): Promise<void> {
  const response = await server.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: ROUTEGO_MCP_PROTOCOL_VERSION }
    })
  );
  expect(response).toMatchObject({
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: ROUTEGO_MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "routego-image", version: "1.0.0" }
    }
  });
}

function resultValue(response: JsonRpcResponse | undefined): unknown {
  if (response === undefined || "error" in response) throw new Error("Expected JSON-RPC success");
  return response.result;
}

function structuredText(result: McpToolResult): Record<string, unknown> {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Expected structured MCP text content");
  return JSON.parse(content.text) as Record<string, unknown>;
}

describe("dependency-free JSON-RPC framing", () => {
  it("decodes fragmented UTF-8 and CRLF/newline-delimited messages", () => {
    const decoder = new JsonRpcLineDecoder();
    const payload = new TextEncoder().encode(
      '{"jsonrpc":"2.0","method":"ping","params":{"text":"中文"}}\r\n' +
      '{"jsonrpc":"2.0","method":"ping"}\n'
    );
    const lines = [
      ...decoder.push(payload.subarray(0, 17)),
      ...decoder.push(payload.subarray(17, 49)),
      ...decoder.push(payload.subarray(49)),
      ...decoder.finish()
    ];
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ params: { text: "中文" } });
  });

  it("returns parse/invalid-request errors without terminating the server", async () => {
    const server = createRoutegoMcpServer({
      service: service({ generate: async (input: unknown) => imageResult(input) })
    });
    expect(await server.handleLine("{invalid")).toMatchObject({ error: { code: -32700 } });
    expect(await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2 }))).toMatchObject({
      error: { code: -32600 }
    });
    expect((await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" })))?.id).toBe(3);
  });
});

describe("MCP lifecycle, exact tools, and schema dispatch", () => {
  it("requires initialization and lists exactly the seven frozen tools with derived schemas", async () => {
    const server = createRoutegoMcpServer({
      service: service({ generate: async (input: unknown) => imageResult(input) })
    });
    expect(
      await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }))
    ).toMatchObject({ error: { code: -32002 } });
    await initialize(server);
    const response = await server.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    );
    const value = resultValue(response) as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
    expect(value.tools.map((tool) => tool.name)).toEqual(
      routegoOperationNames.map((operation) => routegoOperationDefinitions[operation].toolName)
    );
    expect(value.tools).toHaveLength(7);
    for (const tool of value.tools) {
      expect(tool.inputSchema).toMatchObject({ type: "object" });
      const variants = tool.inputSchema["oneOf"];
      if (Array.isArray(variants)) {
        expect(variants.length).toBeGreaterThan(0);
        for (const variant of variants) {
          expect(variant).toMatchObject({ type: "object", additionalProperties: false });
        }
      } else {
        expect(tool.inputSchema["additionalProperties"]).toBe(false);
      }
    }
  });

  it("validates input, calls the service once, validates output, and returns text plus final image content", async () => {
    const embeddedDataUrl = `data:image/png;base64,${PNG_BASE64}`;
    const projectedInput = imageOperationRequestSchema.parse({
      kind: "generate",
      prompt: `ordinary before ${embeddedDataUrl} after`,
      references: [
        {
          path: "/synthetic/reference.png",
          role: "reference",
          label: `raw payload ${PNG_BASE64} remains ordinary text around it`
        }
      ]
    });
    const generate = vi.fn(async (_input: ImageOperationRequest) =>
      imageResult(projectedInput, { withPartial: true })
    );
    const server = createRoutegoMcpServer({ service: service({ generate }) });
    await initialize(server);
    const response = await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "call-1",
        method: "tools/call",
        params: {
          name: "routego_generate",
          arguments: { kind: "generate", prompt: "中文 MCP prompt" }
        }
      })
    );
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      prompt: "中文 MCP prompt",
      count: 1,
      quality: "auto"
    });
    const toolResult = resultValue(response) as McpToolResult;
    expect(toolResult.isError).toBeUndefined();
    expect(toolResult.content).toHaveLength(2);
    const text = structuredText(toolResult);
    expect(text).toMatchObject({
      requestId: "request-mcp-result",
      status: "succeeded",
      requestedParams: {
        prompt: "ordinary before [REDACTED_IMAGE_DATA] after",
        references: [
          {
            label: "raw payload [REDACTED_IMAGE_DATA] remains ordinary text around it"
          }
        ]
      },
      finalArtifacts: [
        {
          id: "artifact-mcp",
          slot: 0,
          phase: "final",
          mimeType: "image/png",
          byteLength: 68,
          width: 1,
          height: 1,
          providerImageId: "provider-artifact-mcp"
        }
      ],
      partialArtifacts: [
        { id: "artifact-mcp-partial", slot: 0, phase: "partial", mimeType: "image/png" }
      ],
      relationships: [{ inputRole: "output", outputArtifactId: "artifact-mcp", order: 0 }]
    });
    expect((text["finalArtifacts"] as Array<Record<string, unknown>>)[0]).not.toHaveProperty("path");
    expect((text["finalArtifacts"] as Array<Record<string, unknown>>)[0]).not.toHaveProperty("display");
    expect((text["partialArtifacts"] as Array<Record<string, unknown>>)[0]).not.toHaveProperty("display");
    expect(JSON.stringify(text)).not.toContain("data:image");
    expect(JSON.stringify(text)).not.toContain(PNG_BASE64);
    expect(JSON.stringify(text)).toContain("ordinary before [REDACTED_IMAGE_DATA] after");
    expect(JSON.stringify(text)).toContain("remains ordinary text around it");
    expect(toolResult.content[1]).toEqual({ type: "image", data: PNG_BASE64, mimeType: "image/png" });
  });

  it("removes every image payload form while preserving ordinary text and business numbers", async () => {
    const projectedInput = imageOperationRequestSchema.parse({
      kind: "edit",
      prompt:
        `gif ${GIF_DATA_URL} svg ${SVG_DATA_URL} custom ${CUSTOM_DATA_URL} ` +
        `parameterized ${PARAMETERIZED_PNG_DATA_URL} raw ${UNKNOWN_HEADER_BASE64} ` +
        `percent before ${PERCENT_ENCODED_SVG_DATA_URL} after-percent ` +
        `adjacent (${PERCENT_ENCODED_SVG_DATA_URL})after-adjacent ` +
        `ordinary ${ORDINARY_LONG_TEXT} web ${ORDINARY_WEB_URL}`,
      targetImage: {
        path: "/synthetic/target.png",
        label: `percent ${PERCENT_ENCODED_SVG_DATA_URL} label-after`
      },
      invariants: {
        preserve: [
          `preserve ${CUSTOM_DATA_URL}`,
          `percent ${PERCENT_ENCODED_SVG_DATA_URL} invariant-after`,
          `keep ${ORDINARY_LONG_TEXT}`
        ]
      }
    });
    const server = createRoutegoMcpServer({
      service: service({ edit: async () => imageResult(projectedInput) })
    });
    await initialize(server);

    const toolResult = resultValue(
      await server.handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "all-image-payload-forms",
          method: "tools/call",
          params: { name: "routego_edit", arguments: editRequest() }
        })
      )
    ) as McpToolResult;
    const text = structuredText(toolResult);
    const rendered = JSON.stringify(text);
    expect(rendered).not.toContain("data:image");
    expect(rendered).not.toContain(GIF_BASE64);
    expect(rendered).not.toContain(SVG_BASE64);
    expect(rendered).not.toContain(UNKNOWN_HEADER_BASE64);
    expect(rendered).not.toContain(PNG_BASE64);
    expect(rendered).not.toContain("%3Csvg");
    expect(rendered).toContain(ORDINARY_LONG_TEXT);
    expect(rendered).toContain(ORDINARY_WEB_URL);
    expect(rendered).toContain("after-percent");
    expect(rendered).toContain(")after-adjacent");
    expect(rendered).toContain("label-after");
    expect(rendered).toContain("invariant-after");
    expect(text).toMatchObject({
      requestedParams: { count: 1 },
      execution: { attemptCount: 1, providerRequestCount: 1 },
      finalArtifacts: [{ slot: 0, byteLength: 68, width: 1, height: 1, sha256: "a".repeat(64) }]
    });
    expect(toolResult.content[1]).toEqual({ type: "image", data: PNG_BASE64, mimeType: "image/png" });
  });

  it("preserves a schema-valid Studio launch URL with its fresh one-time token", async () => {
    const studioResult = routegoOpenStudioResultSchema.parse({
      schemaVersion: 1,
      url: "http://127.0.0.1:43123/?token=synthetic-session-token",
      expiresAt: "2026-07-18T12:05:00.000Z",
      reused: false,
      address: "127.0.0.1"
    });
    const openStudio = vi.fn(async () => studioResult);
    const server = createRoutegoMcpServer({ service: service({ openStudio }) });
    await initialize(server);

    const response = await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "open-studio",
        method: "tools/call",
        params: {
          name: "routego_open_studio",
          arguments: { reuseExisting: true, address: "127.0.0.1" }
        }
      })
    );
    const toolResult = resultValue(response) as McpToolResult;
    const text = structuredText(toolResult);
    expect(openStudio).toHaveBeenCalledTimes(1);
    expect(routegoOpenStudioResultSchema.parse(text)).toEqual(studioResult);
    expect(text["url"]).toBe("http://127.0.0.1:43123/?token=synthetic-session-token");
    expect(toolResult.content).toHaveLength(1);
  });

  it("leaves representative status, search, and manage success text unchanged", async () => {
    const fixtures = [
      {
        operation: "status",
        toolName: "routego_status",
        arguments: {},
        output: routegoStatusResultSchema.parse({
          schemaVersion: 1,
          configured: false,
          hasApiKey: false,
          models: ["synthetic-model"],
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
            uptimeSeconds: 12,
            mcpAvailable: true,
            httpAvailable: true,
            studioAvailable: true
          }
        })
      },
      {
        operation: "searchLibrary",
        toolName: "routego_search_library",
        arguments: {},
        output: routegoSearchLibraryResultSchema.parse({
          schemaVersion: 1,
          items: [
            {
              id: "asset-public-path",
              path: "C:\\Users\\Synthetic User\\图像\\result image.png",
              prompt: "ordinary searchable prompt",
              model: "synthetic-model",
              kind: "generate",
              mimeType: "image/png",
              width: 1024,
              height: 1024,
              status: "succeeded",
              folderIds: ["folder-public"],
              createdAt: "2026-07-18T12:00:00.000Z"
            }
          ]
        })
      },
      {
        operation: "manageLibrary",
        toolName: "routego_manage_library",
        arguments: { action: "create-folder", name: "Synthetic Folder" },
        output: routegoManageLibraryResultSchema.parse({
          schemaVersion: 1,
          action: "create-folder",
          affectedAssetIds: [],
          affectedFolderIds: ["folder-public"],
          warnings: ["ordinary public warning"]
        })
      }
    ] as const;

    for (const fixture of fixtures) {
      const server = createRoutegoMcpServer({
        service: service({ [fixture.operation]: async () => fixture.output })
      });
      await initialize(server);
      const response = await server.handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: `non-image-${fixture.operation}`,
          method: "tools/call",
          params: { name: fixture.toolName, arguments: fixture.arguments }
        })
      );
      const toolResult = resultValue(response) as McpToolResult;
      expect(structuredText(toolResult)).toEqual(fixture.output);
      expect(toolResult.content).toHaveLength(1);
    }
  });

  it("preserves a truthful image path while omitting its display payload", async () => {
    const input = editRequest(
      `ordinary edit prompt data:image/png;base64,${PNG_BASE64} after`,
      PNG_BASE64
    );
    const edit = vi.fn(async (parsedInput: ImageOperationRequest) =>
      imageResult(parsedInput, {
        artifactId: "artifact-edit",
        path: "/synthetic/output/edit.png"
      })
    );
    const server = createRoutegoMcpServer({ service: service({ edit }) });
    await initialize(server);

    const response = await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "edit-path",
        method: "tools/call",
        params: { name: "routego_edit", arguments: input }
      })
    );
    const toolResult = resultValue(response) as McpToolResult;
    const text = structuredText(toolResult);
    const artifact = (text["finalArtifacts"] as Array<Record<string, unknown>>)[0]!;
    expect(edit).toHaveBeenCalledTimes(1);
    expect(artifact).toMatchObject({
      id: "artifact-edit",
      path: "/synthetic/output/edit.png",
      phase: "final",
      mimeType: "image/png",
      providerImageId: "provider-artifact-edit"
    });
    expect(artifact).not.toHaveProperty("display");
    expect(JSON.stringify(text)).not.toContain("data:image");
    expect(JSON.stringify(text)).not.toContain(PNG_BASE64);
    expect(text).toMatchObject({
      requestedParams: {
        prompt: "ordinary edit prompt [REDACTED_IMAGE_DATA] after",
        targetImage: { label: "Synthetic target [REDACTED_IMAGE_DATA]" },
        invariants: {
          preserve: ["Keep the synthetic subject identity. [REDACTED_IMAGE_DATA]"]
        }
      }
    });
    expect(toolResult.content[1]).toEqual({ type: "image", data: PNG_BASE64, mimeType: "image/png" });
  });

  it("projects path-bearing and pathless batch artifacts without fabricating a path", async () => {
    const generateInput = request(
      `Batch path-bearing image data:image/png;base64,${PNG_BASE64} after`
    );
    const editInput = editRequest(
      `Batch pathless edit data:image/png;base64,${PNG_BASE64} after`,
      PNG_BASE64
    );
    const batchResult = routegoBatchResultSchema.parse({
      schemaVersion: 1,
      requestId: "request-mcp-batch",
      status: "succeeded",
      concurrency: 2,
      items: [
        {
          id: "task-path",
          result: imageResult(generateInput, {
            artifactId: "artifact-batch-path",
            path: "/synthetic/output/batch.png",
            requestId: "request-batch-path"
          })
        },
        {
          id: "task-pathless",
          result: imageResult(editInput, {
            artifactId: "artifact-batch-pathless",
            requestId: "request-batch-pathless"
          })
        }
      ]
    });
    const batch = vi.fn(async () => batchResult);
    const server = createRoutegoMcpServer({ service: service({ batch }) });
    await initialize(server);

    const response = await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "batch-projection",
        method: "tools/call",
        params: {
          name: "routego_batch",
          arguments: {
            tasks: [
              { id: "task-path", operation: generateInput },
              { id: "task-pathless", operation: editInput }
            ],
            concurrency: 2
          }
        }
      })
    );
    const toolResult = resultValue(response) as McpToolResult;
    const text = structuredText(toolResult);
    const items = text["items"] as Array<{ result: { finalArtifacts: Array<Record<string, unknown>> } }>;
    const pathArtifact = items[0]!.result.finalArtifacts[0]!;
    const pathlessArtifact = items[1]!.result.finalArtifacts[0]!;
    expect(batch).toHaveBeenCalledTimes(1);
    expect(pathArtifact["path"]).toBe("/synthetic/output/batch.png");
    expect(pathlessArtifact).not.toHaveProperty("path");
    expect(pathArtifact).not.toHaveProperty("display");
    expect(pathlessArtifact).not.toHaveProperty("display");
    expect(pathlessArtifact).toMatchObject({
      id: "artifact-batch-pathless",
      phase: "final",
      mimeType: "image/png",
      providerImageId: "provider-artifact-batch-pathless"
    });
    expect(JSON.stringify(text)).not.toContain("data:image");
    expect(JSON.stringify(text)).not.toContain(PNG_BASE64);
    expect(JSON.stringify(text)).toContain("Batch path-bearing image [REDACTED_IMAGE_DATA] after");
    expect(JSON.stringify(text)).toContain("Batch pathless edit [REDACTED_IMAGE_DATA] after");
    expect(toolResult.content.slice(1)).toEqual([
      { type: "image", data: PNG_BASE64, mimeType: "image/png" },
      { type: "image", data: PNG_BASE64, mimeType: "image/png" }
    ]);
  });

  it("preserves failure facts while recursively redacting the structured error boundary", async () => {
    const generate = vi.fn(async (input: ImageOperationRequest) => failedImageResult(input));
    const server = createRoutegoMcpServer({ service: service({ generate }) });
    await initialize(server);

    const response = await server.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "failed-result",
        method: "tools/call",
        params: {
          name: "routego_generate",
          arguments: { kind: "generate", prompt: "Synthetic failed result" }
        }
      })
    );
    const toolResult = resultValue(response) as McpToolResult;
    const text = structuredText(toolResult);
    const rendered = JSON.stringify(text);
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content).toHaveLength(1);
    expect(text).toMatchObject({
      status: "failed",
      execution: { receivedAnyOutput: false, mayHaveBilled: false },
      error: {
        code: "invalid_response",
        category: "protocol",
        stage: "stream",
        retryDisposition: "never",
        receivedAnyOutput: false,
        mayHaveBilled: false
      }
    });
    expect(rendered).not.toContain("synthetic-secret");
    expect(rendered).not.toContain("token=synthetic");
    expect(rendered).not.toContain("Synthetic User");
    expect(rendered).not.toContain("synthetic-server");
    expect(rendered).not.toContain("Private Share");
    expect(rendered).not.toContain("私密");
    expect(rendered).not.toContain("file:///");
    expect(rendered).not.toContain("..\\private folder");
    expect(rendered).not.toContain("../private folder");
    expect(rendered).not.toContain("Synthetic%20User/punctuation");
    expect(rendered).not.toContain("137,80,78,71");
    expect(rendered).not.toContain("137,80,78");
    expect(rendered).not.toContain("255,216,255,224");
    expect(rendered).not.toContain(PNG_BASE64);
    expect(rendered).not.toContain(GIF_BASE64);
    expect(rendered).not.toContain(SVG_BASE64);
    expect(rendered).not.toContain(UNKNOWN_HEADER_BASE64);
    expect(rendered).not.toContain("%3Csvg");
    expect(rendered).not.toContain("data:image");
    expect(rendered).not.toContain("dataUrl");
    expect(rendered).toContain("[REDACTED_PATH]");
    expect(rendered).toContain("[REDACTED_BINARY_DATA]");
  });

  it("fails closed on invalid input or service output and never dispatches Studio-only names", async () => {
    const generate = vi.fn(async (_input: ImageOperationRequest) => ({ invalid: true }));
    const diagnostics: unknown[] = [];
    const server = createRoutegoMcpServer({
      service: service({ generate }),
      logger: (value) => {
        diagnostics.push(value);
      }
    });
    await initialize(server);
    const invalidInput = resultValue(
      await server.handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "routego_generate",
            arguments: { kind: "generate", prompt: "x", unknown: true }
          }
        })
      )
    ) as McpToolResult;
    expect(invalidInput.isError).toBe(true);
    expect(generate).not.toHaveBeenCalled();

    const invalidOutput = resultValue(
      await server.handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "routego_generate",
            arguments: { kind: "generate", prompt: "Valid input" }
          }
        })
      )
    ) as McpToolResult;
    expect(invalidOutput.isError).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(diagnostics).toHaveLength(1);

    expect(
      await server.handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "studioGenerate", arguments: {} }
        })
      )
    ).toMatchObject({ error: { code: -32601 } });
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe("STDIO channel safety and lifecycle", () => {
  it("writes only JSON-RPC lines, redacts diagnostics, and continues serving after success", async () => {
    const output: string[] = [];
    const diagnostics: unknown[] = [];
    let callCount = 0;
    const server = createRoutegoMcpServer({
      service: service({
        generate: async (input: unknown) => {
          callCount += 1;
          if (callCount === 2) {
            throw new Error(
              `Authorization: Bearer synthetic-secret ` +
              `https://relay.invalid/fail?token=logger-secret ` +
              `C:\\Users\\Synthetic User\\私密\\image.png ` +
              `\\\\synthetic-server\\Private Share\\私密 图.png ` +
              `/home/Synthetic User/私密/image.png ../private folder/私密.png ` +
              `file:///C:/Users/Synthetic%20User/private/server.ts ` +
              `file:///home/Synthetic%20User/private/server.ts ` +
              `data:image/png;base64,${PNG_BASE64}`
            );
          }
          if (callCount === 3) {
            throw {
              message: "Binary diagnostic at ..\\private folder\\私密.bin",
              stack: "Synthetic stack file:///home/Synthetic%20User/private/server.ts",
              windowsPath: "C:\\Users\\Synthetic User\\私密\\image.png",
              uncPath: "\\\\synthetic-server\\Private Share\\私密 图.png",
              posixPath: "/home/Synthetic User/私密/image.png",
              windowsRelativePath: "..\\private folder\\私密.png",
              posixRelativePath: "../private folder/私密.png",
              bytes: [137, 80, 78, 71, 13, 10, 26, 10],
              binaryPayload: [255, 216, 255, 224],
              typedBytes: Uint8Array.from([82, 73, 70, 70])
            };
          }
          return imageResult(input);
        }
      }),
      write: (line) => {
        output.push(line);
      },
      logger: (value) => {
        diagnostics.push(value);
      }
    });
    const lines = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "routego_generate", arguments: { kind: "generate", prompt: "first" } }
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "routego_generate", arguments: { kind: "generate", prompt: "second" } }
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "routego_generate", arguments: { kind: "generate", prompt: "third" } }
      },
      { jsonrpc: "2.0", id: 5, method: "ping" }
    ].map((line) => `${JSON.stringify(line)}\n`).join("");
    const bytes = new TextEncoder().encode(lines);
    await server.handleChunk(bytes.subarray(0, 31));
    await server.handleChunk(bytes.subarray(31));
    await server.finish();

    expect(output).toHaveLength(5);
    expect(output.every((line) => line.endsWith("\n") && JSON.parse(line).jsonrpc === "2.0")).toBe(true);
    expect(JSON.parse(output[1]!).result.isError).toBeUndefined();
    expect(JSON.parse(output[2]!).result.isError).toBe(true);
    expect(JSON.parse(output[3]!).result.isError).toBe(true);
    expect(JSON.parse(output[4]!).result).toEqual({});
    const renderedDiagnostics = JSON.stringify(diagnostics);
    expect(renderedDiagnostics).not.toContain("synthetic-secret");
    expect(renderedDiagnostics).not.toContain("token=logger-secret");
    expect(renderedDiagnostics).not.toContain("Synthetic User");
    expect(renderedDiagnostics).not.toContain("synthetic-server");
    expect(renderedDiagnostics).not.toContain("Private Share");
    expect(renderedDiagnostics).not.toContain("私密");
    expect(renderedDiagnostics).not.toContain("file:///");
    expect(renderedDiagnostics).not.toContain("..\\private folder");
    expect(renderedDiagnostics).not.toContain("../private folder");
    expect(renderedDiagnostics).not.toContain("137,80,78,71");
    expect(renderedDiagnostics).not.toContain("255,216,255,224");
    expect(renderedDiagnostics).not.toContain("82,73,70,70");
    expect(renderedDiagnostics).not.toContain(PNG_BASE64);
    expect(renderedDiagnostics).toContain("[REDACTED_PATH]");
    expect(renderedDiagnostics).toContain("[REDACTED_BINARY_DATA]");

    server.shutdown();
    expect(server.closed).toBe(true);
    expect(
      await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "ping" }))
    ).toMatchObject({ error: { code: -32000 } });
  });

  it("fails closed for arbitrary diagnostic keys, punctuation paths, byte shapes, and Error causes", async () => {
    const diagnostics: unknown[] = [];
    let callCount = 0;
    const byteView = Uint8Array.from([82, 73, 70, 70]);
    const cause = {
      note: "source:'file:///home/Synthetic%20User/punctuation/私密 cause.png'",
      snapshot: [137, 80, 78, 71, 13, 10, 26, 10],
      shortFragment: [251, 250, 249],
      bufferShape: { type: "Buffer", data: [255, 216, 255, 224] },
      typedView: byteView,
      arrayBuffer: byteView.buffer,
      imagePayload: SVG_DATA_URL,
      percentImagePayload: PERCENT_ENCODED_SVG_DATA_URL,
      rawPayload: UNKNOWN_HEADER_BASE64
    };
    const server = createRoutegoMcpServer({
      service: service({
        generate: async () => {
          callCount += 1;
          if (callCount === 1) {
            throw {
              message: "source:'C:\\Users\\Synthetic User\\punctuation\\私密 image.png'",
              unc: "source:['\\\\synthetic-server\\Private Share\\私密 image.png']",
              posix: "source:(/home/Synthetic User/punctuation/私密 image.png)",
              dot: "source:'./relative folder/私密 image.png'",
              parent: "source:'../relative folder/私密 image.png'",
              home: "source:'~/relative folder/私密 image.png'",
              semicolon: "note;../semicolon folder/私密 image.png",
              closingBracket: "note]../bracket folder/私密 image.png",
              closingBrace: "note}C:\\private folder\\私密 image.png",
              closingParen: "note)-/style folder/私密 image.png",
              cause,
              ordinary: ORDINARY_LONG_TEXT
            };
          }
          throw new Error("source:'../relative folder/私密 error.png'", { cause });
        }
      }),
      logger: (value) => {
        diagnostics.push(value);
      }
    });
    await initialize(server);

    for (const id of ["plain-diagnostic", "error-cause"]) {
      const result = resultValue(
        await server.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: "routego_generate", arguments: request() }
          })
        )
      ) as McpToolResult;
      expect(result.isError).toBe(true);
      expect(structuredText(result)).toMatchObject({
        error: { code: "internal_contract", safeMessage: "The Routego Image service call failed safely." }
      });
    }

    const rendered = JSON.stringify(diagnostics);
    expect(diagnostics).toHaveLength(2);
    expect(rendered).not.toContain("Synthetic User");
    expect(rendered).not.toContain("synthetic-server");
    expect(rendered).not.toContain("Private Share");
    expect(rendered).not.toContain("Synthetic%20User/punctuation");
    expect(rendered).not.toContain("relative folder");
    expect(rendered).not.toContain("semicolon folder");
    expect(rendered).not.toContain("bracket folder");
    expect(rendered).not.toContain("private folder");
    expect(rendered).not.toContain("style folder");
    expect(rendered).not.toContain("file:///");
    expect(rendered).not.toContain("私密");
    expect(rendered).not.toContain("137,80,78,71");
    expect(rendered).not.toContain("251,250,249");
    expect(rendered).not.toContain("255,216,255,224");
    expect(rendered).not.toContain("82,73,70,70");
    expect(rendered).not.toContain("data:image");
    expect(rendered).not.toContain(SVG_BASE64);
    expect(rendered).not.toContain(UNKNOWN_HEADER_BASE64);
    expect(rendered).not.toContain("%3Csvg");
    expect(rendered).toContain(ORDINARY_LONG_TEXT);
    expect(rendered).toContain("[REDACTED_PATH]");
    expect(rendered).toContain("[REDACTED_BINARY_DATA]");
    expect((await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: "still-serving", method: "ping" })))?.id)
      .toBe("still-serving");
  });

  it("does not copy image payload text into framing diagnostics", async () => {
    const diagnostics: unknown[] = [];
    const output: string[] = [];
    const server = createRoutegoMcpServer({
      service: service({ generate: async (input: unknown) => imageResult(input) }),
      logger: (value) => {
        diagnostics.push(value);
      },
      write: (line) => {
        output.push(line);
      }
    });
    const encoded = new TextEncoder().encode(
      `{"jsonrpc":"2.0","method":"ping","payload":"${GIF_DATA_URL}`
    );
    const invalidUtf8Frame = new Uint8Array(encoded.length + 2);
    invalidUtf8Frame.set(encoded);
    invalidUtf8Frame[encoded.length] = 0xff;
    invalidUtf8Frame[encoded.length + 1] = 0x0a;
    await server.handleChunk(invalidUtf8Frame);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ error: { code: -32700 } });
    const rendered = JSON.stringify(diagnostics);
    expect(diagnostics).toHaveLength(1);
    expect(rendered).not.toContain("data:image");
    expect(rendered).not.toContain(GIF_BASE64);
    expect(server.closed).toBe(false);
  });

  it("emits sanitized framing failures for invalid UTF-8 without forcing process exit", async () => {
    const output: string[] = [];
    const server = createRoutegoMcpServer({
      service: service({ generate: async (input: unknown) => imageResult(input) }),
      write: (line) => {
        output.push(line);
      }
    });
    await server.handleChunk(Uint8Array.of(0xff, 0xfe));
    expect(JSON.parse(output[0]!)).toMatchObject({ error: { code: -32700 } });
    expect(server.closed).toBe(false);
  });
});
