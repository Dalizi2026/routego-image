import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  imageOperationRequestSchema,
  imageOperationResultSchema,
  imageArtifactPhaseSchema,
  routegoOpenStudioResultSchema,
  routegoOperationDefinitions,
  routegoOperationNames,
  routegoPrepareRegenerationResultSchema,
  routegoStatusResultSchema
} from "@routego-image/contracts";

import {
  RoutegoMcpProcessShutdownError,
  createRoutegoMcpProcess,
  resolveProductionStagingRoot,
  type ManagedRoutegoHttpLifecycle,
  type ManagedRoutegoService,
  type RoutegoMcpInput,
  type RoutegoMcpOutput
} from "../src/runtime/mcp-process";
import type { RuntimeSignalSource } from "../src/runtime/lifecycle";

const EXPECTED_TOOLS = [
  "routego_status",
  "routego_generate",
  "routego_edit",
  "routego_prepare_regeneration",
  "routego_batch",
  "routego_search_library",
  "routego_manage_library",
  "routego_open_studio"
] as const;

describe("production staging ownership", () => {
  it("isolates default staging folders by runtime process while preserving an explicit root", () => {
    const runtimeRoot = "/tmp/routego-image-runtime";

    expect(resolveProductionStagingRoot(runtimeRoot, undefined, 4101)).toBe(
      "/tmp/routego-image-runtime/staging/process-4101"
    );
    expect(resolveProductionStagingRoot(runtimeRoot, undefined, 4102)).toBe(
      "/tmp/routego-image-runtime/staging/process-4102"
    );
    expect(resolveProductionStagingRoot(runtimeRoot, "/tmp/routego-image-explicit-staging", 4101)).toBe(
      "/tmp/routego-image-explicit-staging"
    );
  });
});

class ControlledInput implements RoutegoMcpInput {
  readonly destroy = vi.fn((_error?: Error) => {
    this.end();
  });

  readonly #queued: Array<Uint8Array | string> = [];
  readonly #waiting: Array<(value: IteratorResult<Uint8Array | string>) => void> = [];
  #ended = false;

  push(chunk: Uint8Array | string): void {
    if (this.#ended) throw new Error("Cannot push after input end.");
    const waiter = this.#waiting.shift();
    if (waiter === undefined) this.#queued.push(chunk);
    else waiter({ done: false, value: chunk });
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiting.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array | string> {
    return {
      next: async () => {
        const value = this.#queued.shift();
        if (value !== undefined) return { done: false, value };
        if (this.#ended) return { done: true, value: undefined };
        return await new Promise<IteratorResult<Uint8Array | string>>((resolve) => {
          this.#waiting.push(resolve);
        });
      }
    };
  }
}

class MemoryOutput extends EventEmitter implements RoutegoMcpOutput {
  destroyed = false;
  writableEnded = false;
  readonly chunks: string[] = [];
  readonly #backpressure: boolean;

  constructor(backpressure = false) {
    super();
    this.#backpressure = backpressure;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    if (!this.#backpressure) return true;
    queueMicrotask(() => this.emit("drain"));
    return false;
  }

  text(): string {
    return this.chunks.join("");
  }

  responses(): Array<Record<string, unknown>> {
    return this.text()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

function statusResult() {
  return routegoStatusResultSchema.parse({
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
      studioAvailable: true
    }
  });
}

function regenerationResult() {
  return routegoPrepareRegenerationResultSchema.parse({
    schemaVersion: 1,
    recipe: {
      schemaVersion: 1,
      kind: "generate",
      sourceRecordId: "record-1",
      prompt: "A safe saved prompt",
      referenceIds: [],
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
    providerRequestCount: 0,
    markUnchanged: true
  });
}

function managedService(overrides: Record<string, unknown> = {}): ManagedRoutegoService {
  const target = {
    recover: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    status: vi.fn(async () => statusResult()),
    ...overrides
  };
  return new Proxy(target, {
    get(current, property) {
      if (typeof property === "string" && property in current) {
        return current[property as keyof typeof current];
      }
      return async () => {
        throw new Error(`Unused service method: ${String(property)}`);
      };
    }
  }) as unknown as ManagedRoutegoService;
}

function httpLifecycle(
  shutdown: () => Promise<void> = async () => undefined
): ManagedRoutegoHttpLifecycle & { readonly shutdown: ReturnType<typeof vi.fn> } {
  return { shutdown: vi.fn(shutdown) };
}

function request(id: string | number, method: string, params?: unknown): string {
  return `${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params })
  })}\n`;
}

async function waitForResponses(output: MemoryOutput, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(output.responses()).toHaveLength(count);
  });
}

function resultOf(response: Record<string, unknown>): Record<string, unknown> {
  const result = response["result"];
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Expected an object JSON-RPC result.");
  }
  return result as Record<string, unknown>;
}

function toolText(response: Record<string, unknown>): Record<string, unknown> {
  const result = resultOf(response);
  const content = result["content"];
  if (!Array.isArray(content) || content[0]?.type !== "text" || typeof content[0].text !== "string") {
    throw new Error("Expected MCP text content.");
  }
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe("task 4.3 MCP process protocol", () => {
  it("recovers before readiness and exposes exactly the eight tools and phases", async () => {
    const input = new ControlledInput();
    const output = new MemoryOutput();
    const error = new MemoryOutput();
    const service = managedService();
    const http = httpLifecycle();
    const runtime = createRoutegoMcpProcess({ service, httpLifecycle: http, input, output, error });

    await runtime.start();
    expect(service.recover).toHaveBeenCalledTimes(1);
    input.push(request(1, "initialize"));
    input.push(request(2, "tools/list"));
    await waitForResponses(output, 2);

    const responses = output.responses();
    expect(resultOf(responses[0]!)).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "routego-image", version: "1.0.7" }
    });
    const tools = resultOf(responses[1]!)["tools"] as Array<{
      name: string;
      inputSchema: Record<string, unknown>;
    }>;
    expect(tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
    expect(tools.map((tool) => tool.name)).toEqual(
      routegoOperationNames.map((operation) => routegoOperationDefinitions[operation].toolName)
    );
    expect(tools).toHaveLength(8);
    expect(tools.every((tool) => tool.inputSchema["type"] === "object")).toBe(true);
    expect(imageArtifactPhaseSchema.options).toEqual(["partial", "final"]);
    expect(http.shutdown).not.toHaveBeenCalled();
    expect(service.close).not.toHaveBeenCalled();
    expect(error.text()).toBe("");

    input.end();
    await runtime.waitUntilClosed();
    expect(http.shutdown).toHaveBeenCalledTimes(1);
    expect(service.close).toHaveBeenCalledTimes(1);
  });

  it("preserves Studio launch content, coexists with HTTP, and keeps serving after a call failure", async () => {
    const studioResult = routegoOpenStudioResultSchema.parse({
      schemaVersion: 1,
      url: "http://127.0.0.1:43119/?token=synthetic-session",
      expiresAt: "2026-07-19T12:05:00.000Z",
      reused: false,
      address: "127.0.0.1"
    });
    let statusCalls = 0;
    const service = managedService({
      status: vi.fn(async () => {
        statusCalls += 1;
        if (statusCalls === 1) throw new Error("Synthetic recoverable call failure.");
        return statusResult();
      }),
      openStudio: vi.fn(async () => studioResult)
    });
    const input = new ControlledInput();
    const output = new MemoryOutput();
    const error = new MemoryOutput();
    const http = httpLifecycle();
    const runtime = createRoutegoMcpProcess({ service, httpLifecycle: http, input, output, error });
    await runtime.start();

    input.push([
      request(1, "initialize"),
      request(2, "tools/call", { name: "routego_status", arguments: {} }),
      request(3, "tools/call", {
        name: "routego_open_studio",
        arguments: { address: "127.0.0.1", reuseExisting: true }
      }),
      request(4, "tools/call", { name: "routego_status", arguments: {} })
    ].join(""));
    await waitForResponses(output, 4);

    const responses = output.responses();
    expect(resultOf(responses[1]!)).toMatchObject({ isError: true });
    expect(routegoOpenStudioResultSchema.parse(toolText(responses[2]!))).toEqual(studioResult);
    expect(toolText(responses[2]!)["url"]).toContain("token=synthetic-session");
    expect(toolText(responses[3]!)).toEqual(statusResult());
    expect(statusCalls).toBe(2);
    expect(http.shutdown).not.toHaveBeenCalled();
    expect(runtime.closed).toBe(false);

    input.end();
    await runtime.waitUntilClosed();
  });

  it("exposes direct editing alongside read-only regeneration preparation", async () => {
    const prepareRegeneration = vi.fn(async () => regenerationResult());
    const edit = vi.fn(async (input: unknown) => {
      const request = imageOperationRequestSchema.parse(input);
      return imageOperationResultSchema.parse({
        schemaVersion: 1,
        requestId: "edit-result-1",
        status: "succeeded",
        requestedParams: request,
        effectiveParams: request,
        execution: { attemptCount: 1, providerRequestCount: 1, receivedAnyOutput: true, mayHaveBilled: true, degradedContinuation: false, providerImageIds: [] },
        finalArtifacts: [{ id: "edit-artifact-1", slot: 0, phase: "final", mimeType: "image/png", display: { type: "image", dataUrl: "data:image/png;base64,iVBORw0KGgo=" }, createdAt: "2026-07-19T12:00:00.000Z" }],
        partialArtifacts: [],
        failedSlots: [],
        relationships: [{ inputRole: "output", outputArtifactId: "edit-artifact-1", order: 0 }]
      });
    });
    const input = new ControlledInput();
    const output = new MemoryOutput();
    const runtime = createRoutegoMcpProcess({
      service: managedService({ prepareRegeneration, edit }),
      httpLifecycle: httpLifecycle(),
      input,
      output,
      error: new MemoryOutput()
    });
    await runtime.start();

    input.push([
      request(1, "initialize"),
      request(2, "tools/call", {
        name: "routego_prepare_regeneration",
        arguments: { recordId: "record-1" }
      }),
      request(3, "tools/call", {
        name: "routego_edit",
        arguments: {
          kind: "edit",
          prompt: "Change the dress only",
          targetImage: { path: "/tmp/target.png" },
          invariants: { preserve: ["identity"] }
        }
      })
    ].join(""));
    await waitForResponses(output, 3);

    const responses = output.responses();
    expect(toolText(responses[1]!)).toEqual(regenerationResult());
    expect(prepareRegeneration).toHaveBeenCalledWith({ schemaVersion: 1, recordId: "record-1" });
    expect(edit).toHaveBeenCalledTimes(1);
    expect(toolText(responses[2]!)).toMatchObject({
      status: "succeeded",
      requestedParams: { kind: "edit", targetImage: { path: "[REDACTED_PATH]" } }
    });

    input.end();
    await runtime.waitUntilClosed();
  });

  it("handles UTF-8 fragments, request errors, framing failures, and later valid requests", async () => {
    const input = new ControlledInput();
    const output = new MemoryOutput();
    const error = new MemoryOutput();
    const runtime = createRoutegoMcpProcess({
      service: managedService(),
      httpLifecycle: httpLifecycle(),
      input,
      output,
      error,
      maximumLineBytes: 256
    });
    await runtime.start();

    const encoded = new TextEncoder().encode(request("初始化", "initialize"));
    const split = encoded.findIndex((byte) => byte >= 0x80) + 1;
    input.push(encoded.subarray(0, split));
    input.push(encoded.subarray(split));
    input.push("{invalid-json\n");
    input.push(request(3, "tools/call", { name: "routego_studio_upload", arguments: {} }));
    input.push(request(4, "tools/call", { name: "routego_generate", arguments: { unknown: true } }));
    input.push(`${"x".repeat(257)}\n`);
    input.push(new Uint8Array([0xc3, 0x28]));
    input.push(request(5, "ping"));
    await waitForResponses(output, 7);

    const responses = output.responses();
    expect(responses.map((response) => response["id"])).toEqual([
      "初始化",
      null,
      3,
      4,
      null,
      null,
      5
    ]);
    expect(responses[1]).toMatchObject({ error: { code: -32700 } });
    expect(responses[2]).toMatchObject({ error: { code: -32601 } });
    expect(resultOf(responses[3]!)).toMatchObject({ isError: true });
    expect(responses[4]).toMatchObject({ error: { code: -32600 } });
    expect(responses[5]).toMatchObject({ error: { code: -32700 } });
    expect(resultOf(responses[6]!)).toEqual({});
    expect(output.text().split("\n").filter(Boolean).every((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return parsed["jsonrpc"] === "2.0";
    })).toBe(true);

    input.end();
    await runtime.waitUntilClosed();
  });

  it("drains repeated protocol writes for the Windows multi-response regression", async () => {
    const input = new ControlledInput();
    const output = new MemoryOutput(true);
    const runtime = createRoutegoMcpProcess({
      service: managedService(),
      httpLifecycle: httpLifecycle(),
      input,
      output,
      error: new MemoryOutput()
    });
    await runtime.start();
    input.push([
      request(1, "initialize"),
      request(2, "ping"),
      request(3, "ping"),
      request(4, "tools/list")
    ].join(""));
    await waitForResponses(output, 4);
    expect(output.responses().map((response) => response["id"])).toEqual([1, 2, 3, 4]);

    input.end();
    await runtime.waitUntilClosed();
  });

  it("turns an MCP shutdown request into normal owned-resource release", async () => {
    const input = new ControlledInput();
    const output = new MemoryOutput();
    const service = managedService();
    const http = httpLifecycle();
    const runtime = createRoutegoMcpProcess({
      service,
      httpLifecycle: http,
      input,
      output,
      error: new MemoryOutput()
    });
    await runtime.start();
    input.push(request(1, "initialize"));
    input.push(request(2, "shutdown"));

    await runtime.waitUntilClosed();
    expect(output.responses().map((response) => response["id"])).toEqual([1, 2]);
    expect(input.destroy).toHaveBeenCalledTimes(1);
    expect(http.shutdown).toHaveBeenCalledTimes(1);
    expect(service.close).toHaveBeenCalledTimes(1);
    expect(runtime.shutdownError).toBeUndefined();
  });

  it("fails closed for diagnostic paths, image strings, byte arrays, buffers, and causes", async () => {
    const input = new ControlledInput();
    const output = new MemoryOutput();
    const error = new MemoryOutput();
    const diagnostics: unknown[] = [];
    const longBase64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0123456789abcd".repeat(2);
    const unsafe = {
      message:
        "Authorization: Bearer synthetic-secret; note;../private folder/图像.png " +
        "note]C:\\Users\\Synthetic User\\私密\\image.png",
      cause: {
        dataUrl: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E",
        arbitrary: longBase64,
        shortBytes: [137],
        threeBytes: [137, 80, 78],
        bytes: [137, 80, 78, 71, 13, 10, 26, 10],
        buffer: { type: "Buffer", data: [255, 216, 255, 224] },
        view: new Uint8Array([82, 73, 70, 70]),
        ordinaryUrl: "https://example.test/docs/help"
      }
    };
    const service = managedService({ recover: vi.fn(async () => await Promise.reject(unsafe)) });
    const runtime = createRoutegoMcpProcess({
      service,
      httpLifecycle: httpLifecycle(),
      input,
      output,
      error,
      logger: (value) => {
        diagnostics.push(value);
      }
    });

    await expect(runtime.start()).rejects.toBe(unsafe);
    await runtime.waitUntilClosed();
    const rendered = `${error.text()}\n${JSON.stringify(diagnostics)}`;
    expect(rendered).not.toContain("synthetic-secret");
    expect(rendered).not.toContain("../private folder");
    expect(rendered).not.toContain("Synthetic User");
    expect(rendered).not.toContain("%3Csvg");
    expect(rendered).not.toContain(longBase64);
    expect(rendered).not.toContain("137,80,78");
    expect(rendered).not.toContain("255,216,255");
    expect(rendered).not.toContain("82,73,70,70");
    expect(rendered).toContain("https://example.test/docs/help");
    expect(output.text()).toBe("");
  });
});

describe("task 4.3 process shutdown", () => {
  it.each(["SIGINT", "SIGTERM"] as const)(
    "releases service, HTTP, input, and %s handlers without forcing process exit",
    async (signal) => {
      const signals = new EventEmitter();
      const input = new ControlledInput();
      const service = managedService();
      const http = httpLifecycle();
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      try {
        const runtime = createRoutegoMcpProcess({
          service,
          httpLifecycle: http,
          input,
          output: new MemoryOutput(),
          error: new MemoryOutput(),
          signalSource: signals as RuntimeSignalSource
        });
        await runtime.start();
        expect(signals.listenerCount("SIGINT")).toBe(1);
        expect(signals.listenerCount("SIGTERM")).toBe(1);

        signals.emit(signal);
        await runtime.waitUntilClosed();
        expect(runtime.shutdownError).toBeUndefined();
        expect(input.destroy).toHaveBeenCalledTimes(1);
        expect(http.shutdown).toHaveBeenCalledTimes(1);
        expect(service.close).toHaveBeenCalledTimes(1);
        expect(signals.listenerCount("SIGINT")).toBe(0);
        expect(signals.listenerCount("SIGTERM")).toBe(0);
        expect(exit).not.toHaveBeenCalled();
      } finally {
        exit.mockRestore();
      }
    }
  );

  it("bounds shutdown even when owned resources do not settle", async () => {
    const never = async () => await new Promise<void>(() => undefined);
    const input = new ControlledInput();
    const runtime = createRoutegoMcpProcess({
      service: managedService({ close: vi.fn(never) }),
      httpLifecycle: httpLifecycle(never),
      input,
      output: new MemoryOutput(),
      error: new MemoryOutput(),
      shutdownTimeoutMs: 50
    });
    await runtime.start();

    await expect(runtime.shutdown("bounded-test")).rejects.toMatchObject({
      name: "RoutegoMcpProcessShutdownError",
      code: "shutdown-timeout"
    });
    expect(runtime.shutdownError).toBeInstanceOf(RoutegoMcpProcessShutdownError);
    expect(runtime.closed).toBe(true);
    expect(input.destroy).toHaveBeenCalledTimes(1);
  });
});
