import { describe, expect, it, vi } from "vitest";

import {
  imageOperationRequestSchema,
  imageOperationResultSchema,
  routegoOperationDefinitions,
  routegoOperationNames,
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

function request(prompt = "MCP synthetic image"): ImageOperationRequest {
  return imageOperationRequestSchema.parse({ kind: "generate", prompt });
}

function imageResult(input: ImageOperationRequest) {
  return imageOperationResultSchema.parse({
    schemaVersion: 1,
    requestId: "request-mcp-result",
    status: "succeeded",
    requestedParams: input,
    effectiveParams: input,
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
        id: "artifact-mcp",
        slot: 0,
        phase: "final",
        mimeType: "image/png",
        display: { type: "image", dataUrl: `data:image/png;base64,${PNG_BASE64}` },
        createdAt: "2026-07-18T12:00:00.000Z"
      }
    ],
    partialArtifacts: [],
    failedSlots: [],
    relationships: []
  });
}

function service(generate: (input: ImageOperationRequest) => Promise<unknown>): RoutegoService {
  const unavailable = async () => {
    throw new Error("Unused service method");
  };
  return {
    status: unavailable,
    generate,
    edit: unavailable,
    batch: unavailable,
    searchLibrary: unavailable,
    manageLibrary: unavailable,
    openStudio: unavailable
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
    const server = createRoutegoMcpServer({ service: service(async (input) => imageResult(input)) });
    expect(await server.handleLine("{invalid")).toMatchObject({ error: { code: -32700 } });
    expect(await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2 }))).toMatchObject({
      error: { code: -32600 }
    });
    expect((await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" })))?.id).toBe(3);
  });
});

describe("MCP lifecycle, exact tools, and schema dispatch", () => {
  it("requires initialization and lists exactly the seven frozen tools with derived schemas", async () => {
    const server = createRoutegoMcpServer({ service: service(async (input) => imageResult(input)) });
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
      expect(tool.inputSchema["additionalProperties"]).toBe(false);
    }
  });

  it("validates input, calls the service once, validates output, and returns text plus final image content", async () => {
    const generate = vi.fn(async (input: ImageOperationRequest) => imageResult(input));
    const server = createRoutegoMcpServer({ service: service(generate) });
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
    expect(toolResult.content[0]).toMatchObject({ type: "text" });
    expect((toolResult.content[0] as { text: string }).text).toContain("[REDACTED_IMAGE_DATA]");
    expect((toolResult.content[0] as { text: string }).text).not.toContain(PNG_BASE64);
    expect(toolResult.content[1]).toEqual({ type: "image", data: PNG_BASE64, mimeType: "image/png" });
  });

  it("fails closed on invalid input or service output and never dispatches Studio-only names", async () => {
    const generate = vi.fn(async (_input: ImageOperationRequest) => ({ invalid: true }));
    const diagnostics: unknown[] = [];
    const server = createRoutegoMcpServer({
      service: service(generate),
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
      service: service(async (input) => {
        callCount += 1;
        if (callCount === 2) {
          throw new Error(
            `Authorization: Bearer synthetic-secret data:image/png;base64,${PNG_BASE64}`
          );
        }
        return imageResult(input);
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
      { jsonrpc: "2.0", id: 4, method: "ping" }
    ].map((line) => `${JSON.stringify(line)}\n`).join("");
    const bytes = new TextEncoder().encode(lines);
    await server.handleChunk(bytes.subarray(0, 31));
    await server.handleChunk(bytes.subarray(31));
    await server.finish();

    expect(output).toHaveLength(4);
    expect(output.every((line) => line.endsWith("\n") && JSON.parse(line).jsonrpc === "2.0")).toBe(true);
    expect(JSON.parse(output[1]!).result.isError).toBeUndefined();
    expect(JSON.parse(output[2]!).result.isError).toBe(true);
    expect(JSON.parse(output[3]!).result).toEqual({});
    const renderedDiagnostics = JSON.stringify(diagnostics);
    expect(renderedDiagnostics).not.toContain("synthetic-secret");
    expect(renderedDiagnostics).not.toContain(PNG_BASE64);

    server.shutdown();
    expect(server.closed).toBe(true);
    expect(
      await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" }))
    ).toMatchObject({ error: { code: -32000 } });
  });

  it("emits sanitized framing failures for invalid UTF-8 without forcing process exit", async () => {
    const output: string[] = [];
    const server = createRoutegoMcpServer({
      service: service(async (input) => imageResult(input)),
      write: (line) => {
        output.push(line);
      }
    });
    await server.handleChunk(Uint8Array.of(0xff, 0xfe));
    expect(JSON.parse(output[0]!)).toMatchObject({ error: { code: -32700 } });
    expect(server.closed).toBe(false);
  });
});
