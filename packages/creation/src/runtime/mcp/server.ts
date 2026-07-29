import {
  imageOperationResultSchema,
  routegoBatchResultSchema,
  routegoOperationDefinitions,
  routegoOperationNames,
  type RoutegoOperation,
  type RoutegoService
} from "@routego-image/contracts";
import {
  REDACTED_BINARY_DATA,
  REDACTED_IMAGE_DATA,
  redactDiagnostic
} from "@routego-image/foundation";

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
  edit: "Edit one target image with ordered references and explicit preservation constraints.",
  prepareRegeneration: "Prepare read-only generation information for an explicit library image.",
  batch: "Execute an ordered bounded batch of independent image operations.",
  searchLibrary: "Search the Routego Image library through the composed service.",
  manageLibrary: "Run a validated Routego Image library management action.",
  openStudio: "Open the local Routego Image Studio through the composed service."
};

const TOOL_TO_OPERATION = new Map<string, RoutegoOperation>(
  routegoOperationNames.map((operation) => [routegoOperationDefinitions[operation].toolName, operation])
);

const REDACTED_LOCAL_PATH = "[REDACTED_PATH]" as const;
const OMIT_PROJECTED_FIELD = Symbol("omit-projected-field");
const IMAGE_DATA_URL_PATTERN =
  /data:image\/[a-z0-9][a-z0-9.+-]*(?:;[a-z0-9!#$&^_.+-]+=(?:"[^"\r\n]*"|[^;,\s]*))*(?:;base64)?,(?:(?:%[0-9a-f]{2})|[a-z0-9+/_~.!$&*=@?:-])*/giu;
const LONG_BASE64_TOKEN_PATTERN =
  /(^|[^A-Za-z0-9+/_=-])([A-Za-z0-9+/_-]{64,}={0,2})(?=$|[^A-Za-z0-9+/_=-])/gu;

function preservesOmittedPublicControls(operation: RoutegoOperation): boolean {
  return operation === "generate" || operation === "batch";
}

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

function normalizedKey(key: string | undefined): string {
  return key?.toLowerCase().replace(/[^a-z0-9]/gu, "") ?? "";
}

function isPathDiagnosticKey(key: string | undefined): boolean {
  const normalized = normalizedKey(key);
  return (
    normalized === "cwd" ||
    normalized === "directory" ||
    normalized === "dir" ||
    normalized === "filename" ||
    normalized === "root" ||
    normalized.endsWith("path") ||
    normalized.endsWith("paths") ||
    normalized.endsWith("directory") ||
    normalized.endsWith("filename")
  );
}

function isOpaquePublicStringKey(key: string | undefined): boolean {
  const normalized = normalizedKey(key);
  return normalized === "sha256" || normalized.endsWith("id") || normalized.endsWith("ids");
}

function isNumericByteArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
  );
}

function containsLocalPath(value: string): boolean {
  const withoutWebUrls = value.replace(/https?:\/\/[^\s<>"']+/giu, "");
  return /[\\/]/u.test(withoutWebUrls);
}

function sanitizeDiagnosticProjection(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    const withoutImagePayloads = replaceImagePayloadsInText(value);
    return isPathDiagnosticKey(key) || containsLocalPath(withoutImagePayloads)
      ? REDACTED_LOCAL_PATH
      : withoutImagePayloads;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return REDACTED_BINARY_DATA;
  if (Array.isArray(value)) {
    if (isNumericByteArray(value)) return REDACTED_BINARY_DATA;
    return value.map((item) => sanitizeDiagnosticProjection(item));
  }
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeDiagnosticProjection(childValue, childKey)
    ])
  );
}

function sanitizeMcpDiagnostic(value: unknown): unknown {
  return sanitizeDiagnosticProjection(redactDiagnostic(value));
}

function errorToolResult(code: string, safeMessage: string, details?: unknown): McpToolResult {
  const value = sanitizeMcpDiagnostic({
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function replaceImagePayloadsInText(value: string, redactLongBase64 = true): string {
  const withoutDataUrls = value.replace(IMAGE_DATA_URL_PATTERN, REDACTED_IMAGE_DATA);
  if (!redactLongBase64) return withoutDataUrls;
  return withoutDataUrls.replace(
    LONG_BASE64_TOKEN_PATTERN,
    (_match, prefix: string) => `${prefix}${REDACTED_IMAGE_DATA}`
  );
}

function imageSuccessProjection(value: unknown, key?: string): unknown | typeof OMIT_PROJECTED_FIELD {
  if (key === "dataUrl") return OMIT_PROJECTED_FIELD;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return REDACTED_BINARY_DATA;
  if (Array.isArray(value)) {
    if (isNumericByteArray(value)) return REDACTED_BINARY_DATA;
    return value.map((item) => imageSuccessProjection(item, key));
  }
  if (typeof value === "string") {
    const withoutImagePayloads = replaceImagePayloadsInText(value, !isOpaquePublicStringKey(key));
    return isPathDiagnosticKey(key)
      ? REDACTED_LOCAL_PATH
      : withoutImagePayloads;
  }
  if (!isPlainRecord(value)) return value;

  const projected: Record<string, unknown> = {};
  for (const [key, childValue] of Object.entries(value)) {
    const child = key === "error" ? sanitizeMcpDiagnostic(childValue) : childValue;
    const projectedChild = imageSuccessProjection(child, key);
    if (projectedChild === OMIT_PROJECTED_FIELD) continue;

    if (
      key === "display" &&
      isPlainRecord(projectedChild) &&
      Object.keys(projectedChild).every(
        (displayKey) => displayKey === "type" && projectedChild[displayKey] === "image"
      )
    ) {
      continue;
    }
    projected[key] = projectedChild;
  }
  return projected;
}

function nonImageSuccessProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(nonImageSuccessProjection);
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, childValue]) => [
      key,
      key === "error" ? sanitizeMcpDiagnostic(childValue) : nonImageSuccessProjection(childValue)
    ])
  );
}

function successToolResult(operation: RoutegoOperation, output: unknown): McpToolResult {
  const projected =
    operation === "generate" || operation === "edit" || operation === "batch"
      ? imageSuccessProjection(output)
      : nonImageSuccessProjection(output);
  const images = finalImageContents(output);
  const text = JSON.stringify(projected);
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
      await this.#logger(sanitizeMcpDiagnostic(value));
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
      // Validate with the frozen schema, but preserve omitted public controls for
      // the service layer. That layer merges the saved Studio defaults only when
      // a caller did not explicitly provide a control; Zod defaults would erase
      // that distinction by turning omissions into "auto" here.
      const serviceInput = preservesOmittedPublicControls(operation)
        ? record["arguments"] ?? {}
        : parsedInput.data;
      const rawOutput = await method.call(this.#service, serviceInput);
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
      return jsonRpcSuccess(requestId(request), successToolResult(operation, parsedOutput.data));
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
