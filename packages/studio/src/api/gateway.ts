import {
  browserResourceDescriptorSchema,
  routegoOperationDefinitions,
  studioImageOperationRequestSchema,
  studioOperationDefinitions,
  uploadResourceDescriptorSchema,
  type BrowserResourceDescriptor,
  type LocalRoutegoService,
  routegoManageLibraryResultSchema,
  type RoutegoManageLibraryInput,
  type RoutegoManageLibraryResult,
  type StudioGenerateInput,
  type StudioImageOperationEvent,
  type StudioOperation,
  type UploadResourceDescriptor
} from "@routego-image/contracts";

import { StudioGatewayError } from "./errors";
import {
  createProtectedObjectUrl,
  type ObjectUrlApi,
  type ProtectedObjectUrl
} from "./resources";
import type { StudioSession } from "./session";
import {
  STUDIO_CREATION_STREAM_PATH,
  assertStudioEventStreamContentType,
  parseStudioImageOperationEventStream,
  type StudioSseParserLimits
} from "./sse";

export type StudioManageLibraryInput = Extract<
  RoutegoManageLibraryInput,
  {
    readonly action:
      | "create-folder"
      | "rename-folder"
      | "list-locations"
      | "add-location"
      | "move-assets"
      | "delete-assets"
      | "rename-asset";
  }
>;

export type StudioGatewayOperation = "status" | "manageLibrary" | StudioOperation;

export type StudioGatewayInput<Operation extends StudioGatewayOperation> =
  Operation extends "manageLibrary"
    ? StudioManageLibraryInput
    : LocalRoutegoService[Operation] extends (input: infer Input) => Promise<unknown>
      ? Input
      : never;

export type StudioGatewayOutput<Operation extends StudioGatewayOperation> =
  LocalRoutegoService[Operation] extends (input: never) => Promise<infer Output> ? Output : never;

export interface StudioGateway {
  invoke<Operation extends StudioGatewayOperation>(
    operation: Operation,
    input: StudioGatewayInput<Operation>
  ): Promise<StudioGatewayOutput<Operation>>;
  uploadBinary(resource: UploadResourceDescriptor, body: Blob): Promise<void>;
  selectLibraryDirectory(): Promise<{ readonly selected: boolean; readonly result?: RoutegoManageLibraryResult }>;
  fetchProtectedBlob(resource: BrowserResourceDescriptor): Promise<Blob>;
  fetchProtectedObjectUrl(
    resource: BrowserResourceDescriptor,
    objectUrlApi?: ObjectUrlApi
  ): Promise<ProtectedObjectUrl>;
  streamImageOperation(
    input: StudioGenerateInput,
    options?: StudioImageOperationStreamOptions
  ): AsyncIterable<StudioImageOperationEvent>;
}

export interface StudioImageOperationStreamOptions {
  readonly signal?: AbortSignal;
  readonly limits?: StudioSseParserLimits;
}

export interface HttpStudioGatewayOptions {
  readonly baseUrl: string | URL;
  readonly session: StudioSession;
  readonly fetch?: typeof globalThis.fetch;
}

type OperationDefinition = {
  readonly http: { readonly method: "GET" | "POST"; readonly path: string };
  readonly inputSchema: { parse(value: unknown): unknown };
  readonly outputSchema: { parse(value: unknown): unknown };
};

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "[::1]", "::1"]);

function operationDefinition(operation: StudioGatewayOperation): OperationDefinition {
  if (operation === "status") return routegoOperationDefinitions.status;
  if (operation === "manageLibrary") return routegoOperationDefinitions.manageLibrary;
  const definition = studioOperationDefinitions[operation as StudioOperation];
  if (definition === undefined) {
    throw new StudioGatewayError(
      "invalid_input",
      "Studio blocked a public operation that is not exposed to the browser."
    );
  }
  return definition;
}

function isAllowedManageLibraryInput(value: unknown): value is StudioManageLibraryInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const action = (value as { readonly action?: unknown }).action;
  return [
    "create-folder",
    "rename-folder",
    "list-locations",
    "add-location",
    "move-assets",
    "delete-assets",
    "rename-asset"
  ].includes(action as string);
}

function normalizeLoopbackBaseUrl(value: string | URL): URL {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase()) ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new StudioGatewayError(
      "unsafe_resource",
      "Studio can connect only to an exact loopback HTTP origin."
    );
  }
  return new URL(parsed.origin);
}

function protectedUrl(baseUrl: URL, relativeUrl: string): URL {
  const resolved = new URL(relativeUrl, baseUrl);
  if (resolved.origin !== baseUrl.origin || !relativeUrl.startsWith("/api/v1/")) {
    throw new StudioGatewayError(
      "unsafe_resource",
      "The service returned an unsafe protected resource route."
    );
  }
  return resolved;
}

function appendGetInput(url: URL, input: unknown): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return;
  }
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    if (value !== undefined) {
      url.searchParams.set(name, JSON.stringify(value));
    }
  }
}

function normalizedContentType(value: string | null): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
}

async function safeHttpMessage(response: Response): Promise<string> {
  try {
    const value: unknown = await response.json();
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const nested =
        record["error"] !== null && typeof record["error"] === "object"
          ? (record["error"] as Record<string, unknown>)
          : undefined;
      const message = record["safeMessage"] ?? nested?.["safeMessage"];
      if (
        typeof message === "string" &&
        message.trim() !== "" &&
        !/(?:[A-Za-z]:\\|\/Users\/|\/home\/|data:image|base64|authorization|bearer\s|x-routego-session)/iu.test(
          message
        )
      ) {
        return message.slice(0, 1_000);
      }
    }
  } catch {
    // HTTP failures are intentionally reduced to a stable safe message.
  }
  return "The local Routego service could not complete this request.";
}

export class HttpStudioGateway implements StudioGateway {
  readonly #baseUrl: URL;
  readonly #session: StudioSession;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: HttpStudioGatewayOptions) {
    this.#baseUrl = normalizeLoopbackBaseUrl(options.baseUrl);
    this.#session = options.session;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async invoke<Operation extends StudioGatewayOperation>(
    operation: Operation,
    input: StudioGatewayInput<Operation>
  ): Promise<StudioGatewayOutput<Operation>> {
    if (operation === "manageLibrary" && !isAllowedManageLibraryInput(input)) {
      throw new StudioGatewayError(
        "invalid_input",
        "Studio blocked a Library action that is not safe for the local browser bridge."
      );
    }
    const definition = operationDefinition(operation);
    let parsedInput: unknown;
    try {
      parsedInput = definition.inputSchema.parse(input);
    } catch {
      throw new StudioGatewayError(
        "invalid_input",
        "Studio blocked a request that does not match the frozen local contract."
      );
    }

    const url = protectedUrl(this.#baseUrl, definition.http.path);
    const headers = this.#session.apply({ accept: "application/json" });
    const request: RequestInit = {
      method: definition.http.method,
      headers,
      cache: "no-store",
      credentials: "omit",
      redirect: "error"
    };
    if (definition.http.method === "GET") {
      appendGetInput(url, parsedInput);
    } else {
      headers.set("content-type", "application/json");
      request.body = JSON.stringify(parsedInput);
    }

    let response: Response;
    try {
      response = await this.#fetch(url, request);
    } catch {
      throw new StudioGatewayError(
        "network_error",
        "Studio could not reach the local Routego service."
      );
    }
    if (!response.ok) {
      throw new StudioGatewayError(
        "http_error",
        await safeHttpMessage(response),
        response.status
      );
    }
    if (normalizedContentType(response.headers.get("content-type")) !== "application/json") {
      throw new StudioGatewayError(
        "invalid_output",
        "The local service returned an invalid response type."
      );
    }

    let output: unknown;
    try {
      output = await response.json();
      const parsedOutput = definition.outputSchema.parse(output);
      if (
        operation === "manageLibrary" &&
        (parsedOutput as { readonly action?: unknown }).action !==
          (parsedInput as StudioManageLibraryInput).action
      ) {
        throw new Error("manage-library-action-mismatch");
      }
      return parsedOutput as StudioGatewayOutput<Operation>;
    } catch {
      throw new StudioGatewayError(
        "invalid_output",
        "Studio rejected a response that does not match the frozen local contract."
      );
    }
  }

  async uploadBinary(resource: UploadResourceDescriptor, body: Blob): Promise<void> {
    let parsed: UploadResourceDescriptor;
    try {
      parsed = uploadResourceDescriptorSchema.parse(resource);
    } catch {
      throw new StudioGatewayError(
        "unsafe_resource",
        "Studio rejected an invalid upload reservation."
      );
    }
    if (
      (parsed.status !== "reserved" && parsed.status !== "uploaded") ||
      body.size !== parsed.declaredByteLength ||
      body.size > parsed.binaryUpload.maxBytes ||
      body.type !== parsed.declaredMimeType ||
      !parsed.binaryUpload.allowedMimeTypes.includes(parsed.declaredMimeType)
    ) {
      throw new StudioGatewayError(
        "binary_upload_failed",
        "The selected file no longer matches its upload reservation."
      );
    }

    const url = protectedUrl(this.#baseUrl, parsed.binaryUpload.relativeUrl);
    const headers = this.#session.apply({ "content-type": parsed.declaredMimeType });
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "PUT",
        headers,
        body,
        cache: "no-store",
        credentials: "omit",
        redirect: "error"
      });
    } catch {
      throw new StudioGatewayError(
        "network_error",
        "Studio could not upload the selected file to the local service."
      );
    }
    if (!response.ok) {
      throw new StudioGatewayError(
        "binary_upload_failed",
        await safeHttpMessage(response),
        response.status
      );
    }
  }

  async selectLibraryDirectory(): Promise<{ readonly selected: boolean; readonly result?: RoutegoManageLibraryResult }> {
    const url = protectedUrl(this.#baseUrl, "/api/v1/library/select-directory");
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: this.#session.apply({ accept: "application/json", "content-type": "application/json" }),
        body: "{}",
        cache: "no-store",
        credentials: "omit",
        redirect: "error"
      });
    } catch {
      throw new StudioGatewayError("network_error", "Studio could not reach the local Routego service.");
    }
    if (!response.ok) throw new StudioGatewayError("http_error", await safeHttpMessage(response), response.status);
    if (normalizedContentType(response.headers.get("content-type")) !== "application/json") {
      throw new StudioGatewayError("invalid_output", "The local service returned an invalid response type.");
    }
    try {
      const value: unknown = await response.json();
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-picker-result");
      const record = value as Record<string, unknown>;
      if (record["schemaVersion"] !== 1 || typeof record["selected"] !== "boolean") throw new Error("invalid-picker-result");
      if (!record["selected"]) {
        if (Object.keys(record).length !== 2) throw new Error("invalid-picker-result");
        return { selected: false };
      }
      if (Object.keys(record).length !== 3 || record["result"] === undefined) throw new Error("invalid-picker-result");
      const result = routegoManageLibraryResultSchema.parse(record["result"]);
      if (result.action !== "add-location") throw new Error("invalid-picker-result");
      return { selected: true, result };
    } catch {
      throw new StudioGatewayError("invalid_output", "Studio rejected an invalid directory-picker response.");
    }
  }

  async fetchProtectedBlob(resource: BrowserResourceDescriptor): Promise<Blob> {
    let parsed: BrowserResourceDescriptor;
    try {
      parsed = browserResourceDescriptorSchema.parse(resource);
    } catch {
      throw new StudioGatewayError(
        "unsafe_resource",
        "Studio rejected an invalid protected resource descriptor."
      );
    }
    const url = protectedUrl(this.#baseUrl, parsed.relativeUrl);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: this.#session.apply({ accept: parsed.mimeType }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error"
      });
    } catch {
      throw new StudioGatewayError(
        "network_error",
        "Studio could not load the protected local resource."
      );
    }
    if (!response.ok) {
      throw new StudioGatewayError(
        "http_error",
        await safeHttpMessage(response),
        response.status
      );
    }
    if (normalizedContentType(response.headers.get("content-type")) !== parsed.mimeType) {
      throw new StudioGatewayError(
        "unsafe_resource",
        "The protected resource MIME type did not match its descriptor."
      );
    }
    const blob = await response.blob();
    if (blob.size !== parsed.byteLength) {
      throw new StudioGatewayError(
        "unsafe_resource",
        "The protected resource size did not match its descriptor."
      );
    }
    return blob;
  }

  async fetchProtectedObjectUrl(
    resource: BrowserResourceDescriptor,
    objectUrlApi?: ObjectUrlApi
  ): Promise<ProtectedObjectUrl> {
    return createProtectedObjectUrl(await this.fetchProtectedBlob(resource), objectUrlApi);
  }

  streamImageOperation(
    input: StudioGenerateInput,
    options: StudioImageOperationStreamOptions = {}
  ): AsyncIterable<StudioImageOperationEvent> {
    const gateway = this;
    return (async function* stream(): AsyncGenerator<StudioImageOperationEvent> {
      let parsedInput: ReturnType<typeof studioImageOperationRequestSchema.parse>;
      try {
        parsedInput = studioImageOperationRequestSchema.parse(input);
      } catch {
        throw new StudioGatewayError(
          "invalid_input",
          "Studio blocked an image stream request outside the frozen local contract."
        );
      }

      const url = protectedUrl(gateway.#baseUrl, STUDIO_CREATION_STREAM_PATH);
      const headers = gateway.#session.apply({
        accept: "text/event-stream; charset=utf-8",
        "content-type": "application/json"
      });
      let response: Response;
      try {
        response = await gateway.#fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(parsedInput),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          cache: "no-store",
          credentials: "omit",
          redirect: "error"
        });
      } catch {
        if (options.signal?.aborted === true) {
          throw new StudioGatewayError("network_error", "The Studio image stream was cancelled.");
        }
        throw new StudioGatewayError(
          "network_error",
          "Studio could not reach the local image event stream."
        );
      }
      if (!response.ok) {
        throw new StudioGatewayError(
          "http_error",
          await safeHttpMessage(response),
          response.status
        );
      }
      try {
        assertStudioEventStreamContentType(response.headers.get("content-type"));
      } catch (error) {
        try {
          await response.body?.cancel();
        } catch {
          // Invalid response cleanup must not replace the content-type error.
        }
        throw error;
      }
      if (response.body === null) {
        throw new StudioGatewayError(
          "invalid_output",
          "The local service returned an empty Studio image event stream."
        );
      }
      yield* parseStudioImageOperationEventStream(response.body, options);
    })();
  }
}
