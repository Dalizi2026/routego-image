import { describe, expect, it } from "vitest";

import { createRoutegoMcpServer, type McpToolResult } from "@routego-image/creation";
import {
  routegoOpenStudioResultSchema,
  type RoutegoService
} from "@routego-image/contracts";

function studioOnlyService(): RoutegoService {
  return new Proxy({
    async openStudio() {
      return routegoOpenStudioResultSchema.parse({
        schemaVersion: 1,
        url: "http://127.0.0.1:43119/?token=synthetic-session",
        expiresAt: "2026-07-19T12:05:00.000Z",
        reused: false,
        address: "127.0.0.1"
      });
    }
  }, {
    get(target, property) {
      if (typeof property === "string" && property in target) {
        return target[property as keyof typeof target];
      }
      return async () => {
        throw new Error(`Unused service method: ${String(property)}`);
      };
    }
  }) as unknown as RoutegoService;
}

describe("task 4.3 MCP process integration", () => {
  it("preserves the schema-valid one-time Studio launch URL in MCP content", async () => {
    const server = createRoutegoMcpServer({ service: studioOnlyService() });
    await server.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {}
    }));
    const response = await server.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "routego_open_studio",
        arguments: { address: "127.0.0.1", reuseExisting: true }
      }
    }));
    if (response === undefined || "error" in response) {
      throw new Error("Expected a successful MCP tool response.");
    }
    const result = response.result as McpToolResult;
    const text = result.content.find((content) => content.type === "text");
    if (text?.type !== "text") throw new Error("Expected structured MCP text content.");
    const projected = JSON.parse(text.text) as unknown;

    expect(routegoOpenStudioResultSchema.safeParse(projected).success).toBe(true);
    expect((projected as { url: string }).url).toContain("token=synthetic-session");
  });
});
