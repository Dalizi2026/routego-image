import { createHash } from "node:crypto";

import {
  identifierSchema,
  imageOperationResultSchema,
  routegoBatchInputSchema,
  routegoBatchResultSchema,
  routegoEditInputSchema,
  routegoGenerateInputSchema,
  routegoManageLibraryInputSchema,
  routegoManageLibraryResultSchema,
  routegoOpenStudioInputSchema,
  routegoOpenStudioResultSchema,
  routegoSearchLibraryInputSchema,
  routegoSearchLibraryResultSchema,
  routegoStatusInputSchema,
  routegoStatusResultSchema,
  type ImageArtifact,
  type ImageOperationRequest,
  type ImageOperationResult,
  type RoutegoBatchInput,
  type RoutegoBatchResult,
  type RoutegoEditInput,
  type RoutegoGenerateInput,
  type RoutegoManageLibraryInput,
  type RoutegoManageLibraryResult,
  type RoutegoOpenStudioInput,
  type RoutegoOpenStudioResult,
  type RoutegoOperation,
  type RoutegoSearchLibraryInput,
  type RoutegoSearchLibraryResult,
  type RoutegoService,
  type RoutegoStatusInput,
  type RoutegoStatusResult
} from "@routego-image/contracts";
import { describeProviderEndpoint } from "@routego-image/foundation";

export type MockServiceFixture =
  | "success"
  | "failure"
  | "partial"
  | "degraded"
  | "invalid-output";

export interface MockRoutegoServiceOptions {
  readonly fixture?: MockServiceFixture;
  readonly fixtureByOperation?: Partial<Record<RoutegoOperation, MockServiceFixture>>;
  readonly requestId?: string;
  readonly timestamp?: string;
}

const MOCK_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZVt8AAAAASUVORK5CYII=";
const MOCK_IMAGE_DATA_URL = `data:image/png;base64,${MOCK_IMAGE_BASE64}`;
const DEFAULT_TIMESTAMP = "2026-01-01T00:00:00.000Z";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
}

function deterministicId(prefix: string, value: unknown): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex")
    .slice(0, 24);
  return identifierSchema.parse(`${prefix}:${digest}`);
}

function invalidOutput<T>(): T {
  return { fixture: "invalid-output", valid: false } as T;
}

export class MockRoutegoService implements RoutegoService {
  readonly #options: MockRoutegoServiceOptions;

  constructor(options: MockRoutegoServiceOptions = {}) {
    this.#options = options;
    if (options.requestId !== undefined) {
      identifierSchema.parse(options.requestId);
    }
  }

  #fixture(operation: RoutegoOperation): MockServiceFixture {
    return this.#options.fixtureByOperation?.[operation] ?? this.#options.fixture ?? "success";
  }

  #requestId(operation: RoutegoOperation, input: unknown): string {
    return this.#options.requestId ?? deterministicId(`mock-${operation}`, input);
  }

  #timestamp(): string {
    return this.#options.timestamp ?? DEFAULT_TIMESTAMP;
  }

  #artifact(requestId: string, phase: "partial" | "final" = "final"): ImageArtifact {
    return {
      id: deterministicId("mock-artifact", { requestId, phase }),
      slot: 0,
      phase,
      mimeType: "image/png",
      byteLength: Buffer.from(MOCK_IMAGE_BASE64, "base64").byteLength,
      width: 1,
      height: 1,
      sha256: createHash("sha256").update(MOCK_IMAGE_BASE64, "base64").digest("hex"),
      display: { type: "image", dataUrl: MOCK_IMAGE_DATA_URL },
      createdAt: this.#timestamp()
    };
  }

  #imageResult(
    fixture: Exclude<MockServiceFixture, "invalid-output">,
    request: ImageOperationRequest,
    requestId: string
  ): ImageOperationResult {
    if (fixture === "failure") {
      return imageOperationResultSchema.parse({
        schemaVersion: 1,
        requestId,
        status: "failed",
        requestedParams: request,
        effectiveParams: request,
        execution: {
          transport: "single-endpoint-json",
          attemptCount: 0,
          providerRequestCount: 0,
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
          code: "capability_unavailable",
          category: "capability",
          stage: "route",
          safeMessage: "The selected mock fixture has no available provider capability.",
          retryDisposition: "user-confirmation",
          partialArtifacts: [],
          receivedAnyOutput: false,
          mayHaveBilled: false,
          details: { fixture }
        }
      });
    }

    if (fixture === "partial") {
      const artifact = this.#artifact(requestId, "partial");
      const error = {
        code: "invalid_response" as const,
        category: "protocol" as const,
        stage: "stream" as const,
        safeMessage: "The mock stream ended after a partial image.",
        retryDisposition: "never" as const,
        partialArtifacts: [artifact],
        receivedAnyOutput: true,
        mayHaveBilled: true,
        details: { fixture }
      };
      return imageOperationResultSchema.parse({
        schemaVersion: 1,
        requestId,
        status: "partial",
        requestedParams: request,
        effectiveParams: request,
        execution: {
          transport: "openai-responses",
          attemptCount: 1,
          providerRequestCount: 1,
          receivedAnyOutput: true,
          mayHaveBilled: true,
          degradedContinuation: false,
          providerImageIds: []
        },
        finalArtifacts: [],
        partialArtifacts: [artifact],
        failedSlots: [{ slot: 0, error }],
        relationships: [],
        error
      });
    }

    const artifact = this.#artifact(requestId);
    const degraded = fixture === "degraded";
    return imageOperationResultSchema.parse({
      schemaVersion: 1,
      requestId,
      status: "succeeded",
      requestedParams: request,
      effectiveParams: request,
      execution: {
        transport: "single-endpoint-json",
        attemptCount: 1,
        providerRequestCount: 1,
        receivedAnyOutput: true,
        mayHaveBilled: true,
        degradedContinuation: degraded,
        providerImageIds: []
      },
      finalArtifacts: [artifact],
      partialArtifacts: [],
      failedSlots: [],
      relationships: []
    });
  }

  async status(input: RoutegoStatusInput): Promise<RoutegoStatusResult> {
    const parsed = routegoStatusInputSchema.parse(input);
    if (this.#fixture("status") === "invalid-output") {
      return invalidOutput<RoutegoStatusResult>();
    }
    return routegoStatusResultSchema.parse({
      schemaVersion: 1,
      configured: true,
      hasApiKey: true,
      apiKeyPreview: "mock-present",
      providerId: "mock-provider",
      endpoint: describeProviderEndpoint(
        "https://mock.invalid/v1/images/generations",
        "exact-generation-endpoint"
      ),
      models: ["mock-image-model"],
      capabilities: [],
      defaults: {
        model: "mock-image-model",
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
        status: parsed.refreshCapabilities ? "degraded" : "ready",
        version: "1.0.0-mock",
        nodeVersion: "v20.19.0-mock",
        uptimeSeconds: 0,
        mcpAvailable: true,
        httpAvailable: true,
        studioAvailable: true
      }
    });
  }

  async generate(input: RoutegoGenerateInput): Promise<ImageOperationResult> {
    const request = routegoGenerateInputSchema.parse(input);
    const fixture = this.#fixture("generate");
    if (fixture === "invalid-output") {
      return invalidOutput<ImageOperationResult>();
    }
    return this.#imageResult(fixture, request, this.#requestId("generate", request));
  }

  async edit(input: RoutegoEditInput): Promise<ImageOperationResult> {
    const request = routegoEditInputSchema.parse(input);
    const fixture = this.#fixture("edit");
    if (fixture === "invalid-output") {
      return invalidOutput<ImageOperationResult>();
    }
    return this.#imageResult(fixture, request, this.#requestId("edit", request));
  }

  async batch(input: RoutegoBatchInput): Promise<RoutegoBatchResult> {
    const parsed = routegoBatchInputSchema.parse(input);
    const fixture = this.#fixture("batch");
    if (fixture === "invalid-output") {
      return invalidOutput<RoutegoBatchResult>();
    }

    const items = parsed.tasks.map((task, index) => {
      const itemFixture =
        fixture === "partial"
          ? parsed.tasks.length === 1
            ? "partial"
            : index === 0
              ? "success"
              : "failure"
          : fixture;
      return {
        id: task.id,
        result: this.#imageResult(
          itemFixture,
          task.operation,
          deterministicId(`mock-batch-${task.id}`, {
            requestId: this.#requestId("batch", parsed),
            operation: task.operation
          })
        )
      };
    });
    const statuses = new Set(items.map((item) => item.result.status));
    const status =
      fixture === "failure"
        ? "failed"
        : fixture === "partial" || statuses.size > 1 || statuses.has("partial")
          ? "partial"
          : "succeeded";

    return routegoBatchResultSchema.parse({
      schemaVersion: 1,
      requestId: this.#requestId("batch", parsed),
      status,
      concurrency: parsed.concurrency,
      items
    });
  }

  async searchLibrary(input: RoutegoSearchLibraryInput): Promise<RoutegoSearchLibraryResult> {
    routegoSearchLibraryInputSchema.parse(input);
    if (this.#fixture("searchLibrary") === "invalid-output") {
      return invalidOutput<RoutegoSearchLibraryResult>();
    }
    return routegoSearchLibraryResultSchema.parse({ schemaVersion: 1, items: [], total: 0 });
  }

  async manageLibrary(input: RoutegoManageLibraryInput): Promise<RoutegoManageLibraryResult> {
    const parsed = routegoManageLibraryInputSchema.parse(input);
    if (this.#fixture("manageLibrary") === "invalid-output") {
      return invalidOutput<RoutegoManageLibraryResult>();
    }

    const affectedAssetIds =
      "assetIds" in parsed ? parsed.assetIds : [];
    const affectedFolderIds =
      parsed.action === "create-folder"
        ? ["mock-folder"]
        : "folderId" in parsed
          ? [parsed.folderId]
          : "folderIds" in parsed
            ? parsed.folderIds
            : [];
    return routegoManageLibraryResultSchema.parse({
      schemaVersion: 1,
      action: parsed.action,
      affectedAssetIds,
      affectedFolderIds,
      ...(parsed.action === "export-zip" ? { outputPath: parsed.outputPath } : {}),
      ...(parsed.action === "import-zip" ? { importedCount: 0, skippedCount: 0 } : {}),
      warnings: []
    });
  }

  async openStudio(input: RoutegoOpenStudioInput): Promise<RoutegoOpenStudioResult> {
    const parsed = routegoOpenStudioInputSchema.parse(input);
    if (this.#fixture("openStudio") === "invalid-output") {
      return invalidOutput<RoutegoOpenStudioResult>();
    }
    const host = parsed.address === "::1" ? "[::1]" : parsed.address;
    return routegoOpenStudioResultSchema.parse({
      schemaVersion: 1,
      url: `http://${host}:43119/?token=mock-session-token`,
      expiresAt: "2026-01-01T00:05:00.000Z",
      reused: parsed.reuseExisting,
      address: parsed.address
    });
  }
}

export function createMockRoutegoService(
  options: MockRoutegoServiceOptions = {}
): RoutegoService {
  return new MockRoutegoService(options);
}
