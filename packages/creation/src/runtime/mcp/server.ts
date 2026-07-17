import {
  imageOperationResultSchema,
  routegoBatchResultSchema,
  routegoOperationDefinitions,
  routegoOperationNames,
  type RoutegoOperation,
  type RoutegoService
} from "@routego-image/contracts";
import { redactDiagnostic } from "@routego-image/foundation";

import {
  JsonRpcFramingError,
  JsonRpcLineDecoder,
  jsonRpcFailure,
  jsonRpcSuccess,
  parseJsonRpcRequest,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse
} from "./protocol";

export const ROUTEGO_MCP_PROTOCOL_VERSION = "2025-06-18" as const;

export interface McpTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface McpImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
}

export type McpToolContent = McpTextContent | McpImageContent;

export interface McpToolResult {
  readonly content: readonly McpToolContent[];
  readonly isError?: boolean;
}

export interface McpServerOptions {
  readonly service: RoutegoService;
  readonly write?: (line: string) => void | Promise<void>;
  readonly logger?: (diagnostic: unknown) => void | Promise<void>;
  readonly maximumLineBytes?: number;
}

const TOOL_DESCRIPTIONS: Readonly<Record<RoutegoOperation, string>> = {
  status: "Inspect Routego Image health, defaults, and redacted provider capabilities.",
  generate: "Generate image variants from a validated Routego Image request.",
  edit: "Edit a resolved target image with validated references and invariants.",
  batch: "Execute an ordered bounded batch of independent image operations.",
  searchLibrary: "Search the Routego Image library through the composed service.",
  manageLibrary: "Run a validated Routego Image library management action.",
  openStudio: "Open the local Routego Image Studio through the composed service."
};

const TOOL_TO_OPERATION = new Map<string, RoutegoOperation>(
  routegoOperationNames.map((operation) => [routegoOperationDefinitions[operation].toolName, operation])
);

function inputJsonSchema(operation: RoutegoOperation): Record<string, unknown> {
  const generated = routegoOperationDefinitions[operation].inputSchema.toJSONSchema({
    target: "draft-07",
    io: "input",
    unrepresentable: "any"
  }) as Record<string, unknown>;
  if (generated["type"] === undefined && Array.isArray(generated["oneOf"])) {
    return { ...generated, type: "object" };
  }
  return generated;
}

function toolDefinitions() {
  return routegoOperationNames.map((operation) => {
    const definition = routegoOperationDefinitions[operation];
    return {
      name: definition.toolName,
      description: TOOL_DESCRIPTIONS[operation],
      inputSchema: inputJsonSchema(operation)
    };
  });
}

function errorToolResult(code: string, safeMessage: string, details?: unknown): McpToolResult {
  const value = redactDiagnostic({
    error: {
      code,
      safeMessage,
      ...(details === undefined ? {} : { details })
    }
  });
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(value) }]
  };
}

function imageContentFromDataUrl(
  dataUrl: string,
  mimeType: "image/png" | "image/jpeg" | "image/webp"
): McpImageContent | undefined {
  const match = dataUrl.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/u);
  if (match === null || `image/${match[1]}` !== mimeType || match[2] === undefined) return undefined;
  return { type: "image", data: match[2], mimeType };
}

function finalImageContents(output: unknown): McpImageContent[] {
  const contents: McpImageContent[] = [];
  const operation = imageOperationResultSchema.safeParse(output);
  if (operation.success) {
    for (const artifact of operation.data.finalArtifacts) {
      const dataUrl = artifact.display?.dataUrl;
      if (dataUrl === undefined) continue;
      const content = imageContentFromDataUrl(dataUrl, artifact.mimeType);
      if (content !== undefined) contents.push(content);
    }
    return contents;
  }
  const batch = routegoBatchResultSchema.safeParse(output);
  if (batch.success) {
    for (const item of batch.data.items) {
      for (const artifact of item.result.finalArtifacts) {
        const dataUrl = artifact.display?.dataUrl;
        if (dataUrl === undefined) continue;
        const content = imageContentFromDataUrl(dataUrl, artifact.mimeType);
        if (content !== undefined) contents.push(content);
      }
    }
  }
  return contents;
}

function outputIsError(output: unknown): boolean {
  if (output === null || typeof output !== "object") return false;
  const record = output as Record<string, unknown>;
  return record["status"] === "failed" || record["status"] === "cancelled" || record["error"] !== undefined;
}

function successToolResult(output: unknown): McpToolResult {
  const sanitized = redactDiagnostic(output);
  const images = finalImageContents(output);
  const text = JSON.stringify(sanitized);
  return {
    content: [{ type: "text", text }, ...images],
    ...(outputIsError(output) ? { isError: true } : {})
  };
}

function requestId(request: JsonRpcRequest): JsonRpcId {
  return request.id ?? null;
}

export class RoutegoMcpServer {
  readonly #service: RoutegoService;
  readonly #write: ((line: string) => void | Promise<void>) | undefined;
  readonly #logger: ((diagnostic: unknown) => void | Promise<void>) | undefined;
  readonly #decoder: JsonRpcLineDecoder;
  #initialized = false;
  #closed = false;

  constructor(options: McpServerOptions) {
    this.#service = options.service;
    this.#write = options.write;
    this.#logger = options.logger;
    this.#decoder = new JsonRpcLineDecoder({
      ...(options.maximumLineBytes === undefined
        ? {}
        : { maximumLineBytes: options.maximumLineBytes })
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  async #diagnose(value: unknown): Promise<void> {
    if (this.#logger === undefined) return;
    try {
      await this.#logger(redactDiagnostic(value));
    } catch {
      // Diagnostic sinks cannot affect protocol behavior.
    }
  }

  async #emit(response: JsonRpcResponse | undefined): Promise<void> {
    if (response === undefined || this.#write === undefined) return;
    await this.#write(`${JSON.stringify(response)}\n`);
  }

  async #callTool(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
    if (request.id === undefined) return undefined;
    const params = request.params;
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      return jsonRpcSuccess(requestId(request), errorToolResult("invalid_request", "Tool call parameters are invalid."));
    }
    const record = params as Record<string, unknown>;
    const name = record["name"];
    if (typeof name !== "string") {
      return jsonRpcSuccess(requestId(request), errorToolResult("invalid_request", "A tool name is required."));
    }
    const operation = TOOL_TO_OPERATION.get(name);
    if (operation === undefined) {
      return jsonRpcFailure(requestId(request), -32601, "Tool not found.");
    }
    const definition = routegoOperationDefinitions[operation];
    const parsedInput = definition.inputSchema.safeParse(record["arguments"] ?? {});
    if (!parsedInput.success) {
      return jsonRpcSuccess(
        requestId(request),
        errorToolResult(
          "invalid_request",
          "Tool arguments do not match the frozen Routego Image schema.",
          parsedInput.error.issues.map((issue) => ({
            path: issue.path.map(String).join("."),
            message: issue.message
          }))
        )
      );
    }

    try {
      const method = this.#service[operation] as (input: unknown) => Promise<unknown>;
      const rawOutput = await method.call(this.#service, parsedInput.data);
      const parsedOutput = definition.outputSchema.safeParse(rawOutput);
      if (!parsedOutput.success) {
        await this.#diagnose({
          code: "internal_contract",
          operation,
          issues: parsedOutput.error.issues
        });
        return jsonRpcSuccess(
          requestId(request),
          errorToolResult(
            "internal_contract",
            "The Routego Image service returned an invalid result."
          )
        );
      }
      return jsonRpcSuccess(requestId(request), successToolResult(parsedOutput.data));
    } catch (error) {
      await this.#diagnose(error);
      return jsonRpcSuccess(
        requestId(request),
        errorToolResult("internal_contract", "The Routego Image service call failed safely.")
      );
    }
  }

  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
    if (this.#closed) {
      return request.id === undefined
        ? undefined
        : jsonRpcFailure(requestId(request), -32000, "Server is shut down.");
    }
    if (request.method === "initialize") {
      if (request.id === undefined) return undefined;
      this.#initialized = true;
      return jsonRpcSuccess(requestId(request), {
        protocolVersion: ROUTEGO_MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "routego-image", version: "1.0.0" }
      });
    }
    if (request.method === "notifications/initialized") return undefined;
    if (request.method === "ping") {
      return request.id === undefined ? undefined : jsonRpcSuccess(requestId(request), {});
    }
    if (request.method === "shutdown") {
      if (request.id === undefined) {
        this.#closed = true;
        return undefined;
      }
      const response = jsonRpcSuccess(requestId(request), {});
      this.#closed = true;
      return response;
    }
    if (!this.#initialized) {
      return request.id === undefined
        ? undefined
        : jsonRpcFailure(requestId(request), -32002, "Server is not initialized.");
    }
    if (request.method === "tools/list") {
      return request.id === undefined
        ? undefined
        : jsonRpcSuccess(requestId(request), { tools: toolDefinitions() });
    }
    if (request.method === "tools/call") return this.#callTool(request);
    return request.id === undefined
      ? undefined
      : jsonRpcFailure(requestId(request), -32601, "Method not found.");
  }

  async handleLine(line: string): Promise<JsonRpcResponse | undefined> {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return jsonRpcFailure(null, -32700, "Parse error.");
    }
    const request = parseJsonRpcRequest(value);
    if (request === undefined) return jsonRpcFailure(null, -32600, "Invalid Request.");
    return this.handleRequest(request);
  }

  async handleChunk(chunk: Uint8Array | string): Promise<void> {
    try {
      for (const line of this.#decoder.push(chunk)) {
        await this.#emit(await this.handleLine(line));
      }
    } catch (error) {
      await this.#diagnose(error);
      await this.#emit(
        jsonRpcFailure(
          null,
          error instanceof JsonRpcFramingError && error.code === "line-too-large" ? -32600 : -32700,
          "Invalid JSON-RPC framing."
        )
      );
    }
  }

  async finish(): Promise<void> {
    try {
      for (const line of this.#decoder.finish()) {
        await this.#emit(await this.handleLine(line));
      }
    } catch (error) {
      await this.#diagnose(error);
      await this.#emit(jsonRpcFailure(null, -32700, "Invalid JSON-RPC framing."));
    }
  }

  shutdown(): void {
    this.#closed = true;
  }
}

export function createRoutegoMcpServer(options: McpServerOptions): RoutegoMcpServer {
  return new RoutegoMcpServer(options);
}
