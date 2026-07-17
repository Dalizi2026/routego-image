import { createHash } from "node:crypto";

import {
  capabilityProbeInputSchema,
  capabilityProbeResultSchema,
  executeLibraryMutationInputSchema,
  executeLibraryMutationResultSchema,
  getAssetDetailInputSchema,
  getAssetDetailResultSchema,
  getBrowserResourceInputSchema,
  getBrowserResourceResultSchema,
  identifierSchema,
  imageOperationResultSchema,
  listFoldersInputSchema,
  listFoldersResultSchema,
  preflightLibraryMutationInputSchema,
  preflightLibraryMutationResultSchema,
  readSettingsInputSchema,
  readSettingsResultSchema,
  refreshModelsInputSchema,
  refreshModelsResultSchema,
  removeProviderProfileInputSchema,
  removeProviderProfileResultSchema,
  reorderFoldersInputSchema,
  reorderFoldersResultSchema,
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
  routegoServiceErrorSchema,
  setActiveProviderProfileInputSchema,
  setActiveProviderProfileResultSchema,
  upsertProviderProfileInputSchema,
  upsertProviderProfileResultSchema,
  type BrowserResourceDescriptor,
  type CapabilityProbeInput,
  type CapabilityProbeResult,
  type ExecuteLibraryMutationInput,
  type ExecuteLibraryMutationResult,
  type GetAssetDetailInput,
  type GetAssetDetailResult,
  type GetBrowserResourceInput,
  type GetBrowserResourceResult,
  type ImageArtifact,
  type ImageOperationRequest,
  type ImageOperationResult,
  type LibraryAssetDetail,
  type LibraryFolderDescriptor,
  type LibraryMutationRequest,
  type LibraryOperationParameters,
  type ListFoldersInput,
  type ListFoldersResult,
  type LocalRoutegoService,
  type PreflightLibraryMutationInput,
  type PreflightLibraryMutationResult,
  type ProviderProfileDescriptor,
  type ReadSettingsInput,
  type ReadSettingsResult,
  type RefreshModelsInput,
  type RefreshModelsResult,
  type RemoveProviderProfileInput,
  type RemoveProviderProfileResult,
  type ReorderFoldersInput,
  type ReorderFoldersResult,
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
  type RoutegoServiceError,
  type RoutegoStatusInput,
  type RoutegoStatusResult,
  type SetActiveProviderProfileInput,
  type SetActiveProviderProfileResult,
  type StudioOperation,
  type UpsertProviderProfileInput,
  type UpsertProviderProfileResult
} from "@routego-image/contracts";
import { describeProviderEndpoint } from "@routego-image/foundation";

export type MockServiceFixture =
  | "success"
  | "failure"
  | "partial"
  | "degraded"
  | "invalid-output";

export type MockServiceOperation = RoutegoOperation | StudioOperation;

export interface MockRoutegoServiceOptions {
  readonly fixture?: MockServiceFixture;
  readonly fixtureByOperation?: Partial<Record<MockServiceOperation, MockServiceFixture>>;
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

export class MockRoutegoService implements LocalRoutegoService {
  readonly #options: MockRoutegoServiceOptions;
  readonly #preflights = new Map<
    string,
    { readonly action: LibraryMutationRequest["action"]; readonly targetIds: readonly string[] }
  >();

  constructor(options: MockRoutegoServiceOptions = {}) {
    this.#options = options;
    if (options.requestId !== undefined) {
      identifierSchema.parse(options.requestId);
    }
  }

  #fixture(operation: MockServiceOperation): MockServiceFixture {
    return this.#options.fixtureByOperation?.[operation] ?? this.#options.fixture ?? "success";
  }

  #requestId(operation: MockServiceOperation, input: unknown): string {
    return this.#options.requestId ?? deterministicId(`mock-${operation}`, input);
  }

  #timestamp(): string {
    return this.#options.timestamp ?? DEFAULT_TIMESTAMP;
  }

  #error(
    code: RoutegoServiceError["code"] = "conflict",
    safeMessage = "The selected synthetic mock fixture failed."
  ): RoutegoServiceError {
    const categoryByCode: Partial<
      Record<RoutegoServiceError["code"], RoutegoServiceError["category"]>
    > = {
      auth_failed: "authentication",
      capability_unavailable: "capability",
      conflict: "persistence",
      not_found: "persistence",
      timeout: "timeout"
    };
    const stageByCode: Partial<Record<RoutegoServiceError["code"], RoutegoServiceError["stage"]>> = {
      auth_failed: "submit",
      capability_unavailable: "route",
      conflict: "persist",
      not_found: "persist",
      timeout: "submit"
    };
    return routegoServiceErrorSchema.parse({
      code,
      category: categoryByCode[code] ?? "internal",
      stage: stageByCode[code] ?? "complete",
      safeMessage,
      retryDisposition: code === "timeout" ? "never" : "user-confirmation",
      partialArtifacts: [],
      receivedAnyOutput: false,
      mayHaveBilled: false,
      details: { fixture: "synthetic" }
    });
  }

  #profile(overrides: Partial<ProviderProfileDescriptor> = {}): ProviderProfileDescriptor {
    const { hasApiKey = true, apiKeyPreview, ...rest } = overrides;
    return {
      id: "mock-provider",
      name: "Synthetic mock relay",
      endpoints: {
        generation: describeProviderEndpoint(
          "https://mock.invalid/v1/images/generations",
          "exact-generation-endpoint"
        )
      },
      defaultModel: "mock-image-model",
      models: ["mock-image-model"],
      hasApiKey,
      ...(hasApiKey ? { apiKeyPreview: apiKeyPreview ?? "mock-present" } : {}),
      isActive: true,
      createdAt: this.#timestamp(),
      updatedAt: this.#timestamp(),
      ...rest
    };
  }

  #folders(ids: readonly string[] = ["mock-folder-primary", "mock-folder-archive"]): LibraryFolderDescriptor[] {
    return ids.map((id, index) => ({
      id,
      name: index === 0 ? "Synthetic primary" : `Synthetic folder ${index + 1}`,
      order: index,
      assetCount: index === 0 ? 2 : 1,
      state: id.includes("archive") ? "deleted" : "active",
      createdAt: this.#timestamp(),
      updatedAt: this.#timestamp()
    }));
  }

  #browserResource(
    resourceId = "mock-resource-preview",
    mimeType: BrowserResourceDescriptor["mimeType"] = "image/png"
  ): BrowserResourceDescriptor {
    const isImage = mimeType.startsWith("image/");
    return {
      resourceId,
      relativeUrl: `/api/v1/library/resources/${resourceId}`,
      requiresSession: true,
      mimeType,
      byteLength: isImage ? Buffer.from(MOCK_IMAGE_BASE64, "base64").byteLength : 256,
      ...(isImage ? { width: 1, height: 1 } : {}),
      etag: deterministicId("mock-etag", { resourceId, mimeType }),
      expiresAt: "2026-01-01T00:05:00.000Z"
    };
  }

  #libraryParameters(): LibraryOperationParameters {
    return {
      kind: "edit",
      prompt: "Synthetic edit request for downstream Studio development.",
      references: [{ assetId: "mock-asset-reference", role: "style", label: "Synthetic style" }],
      target: { assetId: "mock-asset-target", label: "Synthetic target" },
      supportingImages: [
        {
          assetId: "mock-asset-supporting",
          role: "supporting",
          label: "Synthetic supporting image"
        }
      ],
      maskAssetId: "mock-asset-mask",
      invariants: {
        allowedChanges: ["background"],
        preserve: ["subject and composition"],
        forbiddenChanges: []
      },
      size: "1024x1024",
      aspectRatio: "1:1",
      quality: "high",
      format: "png",
      count: 1,
      partialImages: 0,
      transparentMode: "off",
      moderation: "auto",
      action: "edit",
      imageIds: [],
      fileIds: [],
      outputDirectoryMode: "default",
      saveToLibrary: true
    };
  }

  #assetDetail(
    fixture: Exclude<MockServiceFixture, "invalid-output" | "failure">,
    assetId: string
  ): LibraryAssetDetail {
    const parameters = this.#libraryParameters();
    const partial = fixture === "partial";
    return {
      id: assetId,
      prompt: parameters.prompt,
      model: "mock-image-model",
      kind: "edit",
      status: partial ? "partial" : "succeeded",
      mimeType: "image/png",
      width: 1,
      height: 1,
      createdAt: this.#timestamp(),
      updatedAt: this.#timestamp(),
      requestedParams: parameters,
      effectiveParams: parameters,
      execution: {
        transport: "single-endpoint-json",
        attemptCount: 1,
        providerRequestCount: 1,
        receivedAnyOutput: true,
        mayHaveBilled: true,
        degradedContinuation: fixture === "degraded",
        providerImageIds: []
      },
      ...(partial
        ? {
            error: {
              code: "invalid_response",
              category: "protocol",
              stage: "stream",
              safeMessage: "The synthetic detail preserves a partial provider result.",
              retryDisposition: "never",
              partialArtifacts: [],
              receivedAnyOutput: true,
              mayHaveBilled: true,
              details: { fixture: "partial" }
            } satisfies RoutegoServiceError
          }
        : {}),
      renditions: [
        {
          artifactId: "mock-artifact-output",
          phase: partial ? "partial" : "final",
          mimeType: "image/png",
          byteLength: Buffer.from(MOCK_IMAGE_BASE64, "base64").byteLength,
          width: 1,
          height: 1,
          sha256: createHash("sha256").update(MOCK_IMAGE_BASE64, "base64").digest("hex"),
          createdAt: this.#timestamp()
        }
      ],
      relationships: [
        { id: "mock-rel-source", role: "source", relatedAssetId: "mock-asset-source", order: 0 },
        { id: "mock-rel-target", role: "target", relatedAssetId: "mock-asset-target", order: 1 },
        {
          id: "mock-rel-reference",
          role: "reference",
          relatedAssetId: "mock-asset-reference",
          order: 2
        },
        {
          id: "mock-rel-supporting",
          role: "supporting",
          relatedAssetId: "mock-asset-supporting",
          order: 3
        },
        { id: "mock-rel-mask", role: "mask", relatedAssetId: "mock-asset-mask", order: 4 },
        {
          id: "mock-rel-output",
          role: "output",
          relatedAssetId: assetId,
          artifactId: "mock-artifact-output",
          order: 5
        }
      ],
      folders: [
        { folderId: "mock-folder-primary", name: "Synthetic primary", state: "active", order: 0 }
      ],
      allowedActions: [
        "edit",
        "retry",
        "assign-folders",
        "soft-delete",
        "export-zip",
        "download"
      ]
    };
  }

  #mutationTargets(mutation: LibraryMutationRequest): string[] {
    return "assetIds" in mutation ? [...mutation.assetIds] : [mutation.uploadResourceId];
  }

  #requiredConfirmation(
    action: LibraryMutationRequest["action"]
  ): "permanent-delete" | "zip-export" | "zip-import" | undefined {
    return action === "permanent-delete"
      ? "permanent-delete"
      : action === "export-zip"
        ? "zip-export"
        : action === "import-zip"
          ? "zip-import"
          : undefined;
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

  async readSettings(input: ReadSettingsInput): Promise<ReadSettingsResult> {
    readSettingsInputSchema.parse(input);
    const fixture = this.#fixture("readSettings");
    if (fixture === "invalid-output") {
      return invalidOutput<ReadSettingsResult>();
    }
    if (fixture === "failure") {
      throw this.#error("not_found", "The synthetic settings fixture is unavailable.");
    }
    return readSettingsResultSchema.parse({
      schemaVersion: 1,
      activeProviderId: "mock-provider",
      profiles: [this.#profile()],
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
      outputDirectory: { configured: true, display: "Pictures/routego-image/mock" }
    });
  }

  async upsertProviderProfile(
    input: UpsertProviderProfileInput
  ): Promise<UpsertProviderProfileResult> {
    const parsed = upsertProviderProfileInputSchema.parse(input);
    const fixture = this.#fixture("upsertProviderProfile");
    if (fixture === "invalid-output") {
      return invalidOutput<UpsertProviderProfileResult>();
    }
    if (fixture === "failure") {
      throw this.#error("conflict", "The synthetic provider profile could not be saved.");
    }
    const hasApiKey = parsed.apiKey.operation !== "clear";
    const profileId = parsed.profileId ?? deterministicId("mock-provider", parsed.name);
    const endpoints = {
      generation: describeProviderEndpoint(
        parsed.endpoints.generation.value,
        parsed.endpoints.generation.mode
      ),
      ...(parsed.endpoints.models
        ? {
            models: describeProviderEndpoint(
              parsed.endpoints.models,
              "exact-generation-endpoint"
            )
          }
        : {}),
      ...(parsed.endpoints.edits
        ? {
            edits: describeProviderEndpoint(
              parsed.endpoints.edits,
              "exact-generation-endpoint"
            )
          }
        : {}),
      ...(parsed.endpoints.responses
        ? {
            responses: describeProviderEndpoint(
              parsed.endpoints.responses,
              "exact-generation-endpoint"
            )
          }
        : {})
    };
    const profile = this.#profile({
      id: profileId,
      name: parsed.name,
      endpoints,
      ...(parsed.defaultModel ? { defaultModel: parsed.defaultModel, models: [parsed.defaultModel] } : {}),
      hasApiKey,
      isActive: parsed.setActive
    });
    return upsertProviderProfileResultSchema.parse({
      schemaVersion: 1,
      profile,
      ...(profile.isActive ? { activeProviderId: profile.id } : {})
    });
  }

  async removeProviderProfile(
    input: RemoveProviderProfileInput
  ): Promise<RemoveProviderProfileResult> {
    const parsed = removeProviderProfileInputSchema.parse(input);
    const fixture = this.#fixture("removeProviderProfile");
    if (fixture === "invalid-output") {
      return invalidOutput<RemoveProviderProfileResult>();
    }
    if (fixture === "failure") {
      throw this.#error("conflict", "The active synthetic provider profile cannot be removed.");
    }
    return removeProviderProfileResultSchema.parse({
      schemaVersion: 1,
      removedProfileId: parsed.profileId
    });
  }

  async setActiveProviderProfile(
    input: SetActiveProviderProfileInput
  ): Promise<SetActiveProviderProfileResult> {
    const parsed = setActiveProviderProfileInputSchema.parse(input);
    const fixture = this.#fixture("setActiveProviderProfile");
    if (fixture === "invalid-output") {
      return invalidOutput<SetActiveProviderProfileResult>();
    }
    if (fixture === "failure") {
      throw this.#error("not_found", "The synthetic provider profile does not exist.");
    }
    return setActiveProviderProfileResultSchema.parse({
      schemaVersion: 1,
      activeProviderId: parsed.profileId,
      profile: this.#profile({ id: parsed.profileId, isActive: true })
    });
  }

  async refreshModels(input: RefreshModelsInput): Promise<RefreshModelsResult> {
    const parsed = refreshModelsInputSchema.parse(input);
    const fixture = this.#fixture("refreshModels");
    if (fixture === "invalid-output") {
      return invalidOutput<RefreshModelsResult>();
    }
    if (fixture === "failure" || fixture === "partial") {
      return refreshModelsResultSchema.parse({
        schemaVersion: 1,
        providerId: parsed.providerId,
        status: "failed",
        billable: false,
        models: [],
        error: this.#error("timeout", "The synthetic non-billable model refresh timed out.")
      });
    }
    return refreshModelsResultSchema.parse({
      schemaVersion: 1,
      providerId: parsed.providerId,
      status: "succeeded",
      billable: false,
      models: fixture === "degraded" ? ["mock-image-model"] : ["mock-image-model", "mock-image-model-v2"],
      refreshedAt: this.#timestamp()
    });
  }

  async probeCapabilities(input: CapabilityProbeInput): Promise<CapabilityProbeResult> {
    const parsed = capabilityProbeInputSchema.parse(input);
    const fixture = this.#fixture("probeCapabilities");
    if (fixture === "invalid-output") {
      return invalidOutput<CapabilityProbeResult>();
    }
    const failed = fixture === "failure" || fixture === "partial";
    const state = failed ? "unknown" : fixture === "degraded" ? "degraded" : "supported";
    const source = failed
      ? "transient-failure"
      : fixture === "degraded"
        ? "degraded-fallback"
        : "successful-request";
    const record = {
      capability: parsed.capability,
      scope: {
        providerId: parsed.providerId,
        model: parsed.model,
        endpointFingerprint: "a".repeat(64),
        transport: parsed.transport,
        requestShape: parsed.requestShape
      },
      state,
      evidence: [
        {
          source,
          observedAt: this.#timestamp(),
          summary: failed
            ? "A synthetic transient failure preserved the prior capability state."
            : fixture === "degraded"
              ? "A synthetic fallback completed with weaker semantics."
              : "A synthetic provider-shaped request completed successfully.",
          requestShape: parsed.requestShape
        }
      ],
      ...(!failed ? { verifiedAt: this.#timestamp() } : {}),
      ...(fixture === "degraded"
        ? { degradedReason: "The previous output must be uploaded as a new target." }
        : {})
    } as const;
    return capabilityProbeResultSchema.parse({
      schemaVersion: 1,
      providerId: parsed.providerId,
      model: parsed.model,
      status: failed ? "failed" : "completed",
      record,
      mayHaveBilled: !failed,
      ...(failed
        ? { error: this.#error("timeout", "The synthetic capability probe timed out.") }
        : {})
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

  async listFolders(input: ListFoldersInput): Promise<ListFoldersResult> {
    const parsed = listFoldersInputSchema.parse(input);
    const fixture = this.#fixture("listFolders");
    if (fixture === "invalid-output") {
      return invalidOutput<ListFoldersResult>();
    }
    if (fixture === "failure") {
      throw this.#error("not_found", "The synthetic folder collection is unavailable.");
    }
    const folders = this.#folders().filter(
      (folder) => parsed.includeDeleted || folder.state !== "deleted"
    );
    return listFoldersResultSchema.parse({ schemaVersion: 1, folders });
  }

  async reorderFolders(input: ReorderFoldersInput): Promise<ReorderFoldersResult> {
    const parsed = reorderFoldersInputSchema.parse(input);
    const fixture = this.#fixture("reorderFolders");
    if (fixture === "invalid-output") {
      return invalidOutput<ReorderFoldersResult>();
    }
    if (fixture === "failure") {
      return reorderFoldersResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        folders: this.#folders(),
        error: this.#error("conflict", "The synthetic folder order changed concurrently.")
      });
    }
    return reorderFoldersResultSchema.parse({
      schemaVersion: 1,
      status: "succeeded",
      folders: this.#folders(parsed.folderIds)
    });
  }

  async getAssetDetail(input: GetAssetDetailInput): Promise<GetAssetDetailResult> {
    const parsed = getAssetDetailInputSchema.parse(input);
    const fixture = this.#fixture("getAssetDetail");
    if (fixture === "invalid-output") {
      return invalidOutput<GetAssetDetailResult>();
    }
    if (fixture === "failure") {
      return getAssetDetailResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        error: this.#error("not_found", "The synthetic Library asset was not found.")
      });
    }
    return getAssetDetailResultSchema.parse({
      schemaVersion: 1,
      status: "succeeded",
      asset: this.#assetDetail(fixture, parsed.assetId)
    });
  }

  async getBrowserResource(
    input: GetBrowserResourceInput
  ): Promise<GetBrowserResourceResult> {
    const parsed = getBrowserResourceInputSchema.parse(input);
    const fixture = this.#fixture("getBrowserResource");
    if (fixture === "invalid-output") {
      return invalidOutput<GetBrowserResourceResult>();
    }
    if (fixture === "failure") {
      return getBrowserResourceResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        error: this.#error("access_denied", "The synthetic browser resource is unavailable.")
      });
    }
    const resourceId = deterministicId("mock-resource", {
      assetId: parsed.assetId,
      artifactId: parsed.artifactId,
      rendition: parsed.rendition
    });
    return getBrowserResourceResultSchema.parse({
      schemaVersion: 1,
      status: "succeeded",
      resource: this.#browserResource(resourceId)
    });
  }

  async preflightLibraryMutation(
    input: PreflightLibraryMutationInput
  ): Promise<PreflightLibraryMutationResult> {
    const parsed = preflightLibraryMutationInputSchema.parse(input);
    const fixture = this.#fixture("preflightLibraryMutation");
    if (fixture === "invalid-output") {
      return invalidOutput<PreflightLibraryMutationResult>();
    }
    const targets = this.#mutationTargets(parsed.mutation);
    const preflightId = deterministicId("mock-preflight", parsed);
    this.#preflights.set(preflightId, {
      action: parsed.mutation.action,
      targetIds: targets
    });
    const requiredConfirmation = this.#requiredConfirmation(parsed.mutation.action);
    const partial = fixture === "partial" && targets.length > 1;
    const blocked = fixture === "failure";
    const items = targets.map((targetId, index) => {
      const eligible = !blocked && (!partial || index === 0);
      return {
        targetId,
        targetKind: parsed.mutation.action === "import-zip" ? "upload-resource" : "asset",
        eligible,
        ...(parsed.mutation.action === "import-zip" ? {} : { currentStatus: "succeeded" as const }),
        allowedActions:
          parsed.mutation.action === "import-zip" ? [] : [parsed.mutation.action],
        requiredConfirmations: requiredConfirmation ? [requiredConfirmation] : [],
        warnings: fixture === "degraded" ? ["Synthetic degraded preflight warning."] : [],
        ...(eligible
          ? {}
          : {
              error: this.#error(
                "conflict",
                "The synthetic target is blocked by a concurrent state change."
              )
            })
      };
    });
    const eligibleCount = items.filter((item) => item.eligible).length;
    const status =
      eligibleCount === items.length ? "ready" : eligibleCount === 0 ? "blocked" : "partial";
    return preflightLibraryMutationResultSchema.parse({
      schemaVersion: 1,
      preflightId,
      action: parsed.mutation.action,
      status,
      expiresAt: "2026-01-01T00:05:00.000Z",
      requiredConfirmations: requiredConfirmation ? [requiredConfirmation] : [],
      items,
      warnings: fixture === "degraded" ? ["Synthetic degraded preflight warning."] : [],
      ...(status === "blocked"
        ? { error: this.#error("conflict", "Every synthetic mutation target is blocked.") }
        : {})
    });
  }

  async executeLibraryMutation(
    input: ExecuteLibraryMutationInput
  ): Promise<ExecuteLibraryMutationResult> {
    const parsed = executeLibraryMutationInputSchema.parse(input);
    const fixture = this.#fixture("executeLibraryMutation");
    if (fixture === "invalid-output") {
      return invalidOutput<ExecuteLibraryMutationResult>();
    }
    const preflight = this.#preflights.get(parsed.preflightId);
    if (!preflight || preflight.action !== parsed.action) {
      return executeLibraryMutationResultSchema.parse({
        schemaVersion: 1,
        preflightId: parsed.preflightId,
        action: parsed.action,
        status: "failed",
        items: [
          {
            targetId: parsed.preflightId,
            status: "failed",
            error: this.#error("conflict", "The synthetic preflight is missing or stale.")
          }
        ],
        error: this.#error("conflict", "The synthetic preflight is missing or stale.")
      });
    }
    const partial = fixture === "partial" && preflight.targetIds.length > 1;
    const failed = fixture === "failure";
    const items = preflight.targetIds.map((targetId, index) => {
      const succeeded = !failed && (!partial || index === 0);
      return succeeded
        ? {
            targetId,
            status: "succeeded" as const,
            ...(parsed.action === "import-zip" ? {} : { affectedAssetId: targetId }),
            warnings: fixture === "degraded" ? ["Synthetic degraded mutation warning."] : []
          }
        : {
            targetId,
            status: "failed" as const,
            error: this.#error(
              "conflict",
              "The synthetic mutation target changed after preflight."
            )
          };
    });
    const succeededCount = items.filter((item) => item.status === "succeeded").length;
    const status =
      succeededCount === items.length
        ? "succeeded"
        : succeededCount === 0
          ? "failed"
          : "partial";
    return executeLibraryMutationResultSchema.parse({
      schemaVersion: 1,
      preflightId: parsed.preflightId,
      action: parsed.action,
      status,
      items,
      ...(parsed.action === "export-zip" && succeededCount > 0
        ? {
            outputResource: this.#browserResource(
              deterministicId("mock-export", parsed.preflightId),
              "application/zip"
            )
          }
        : {}),
      ...(parsed.action === "import-zip"
        ? { importedCount: succeededCount, skippedCount: items.length - succeededCount }
        : {}),
      warnings: fixture === "degraded" ? ["Synthetic degraded mutation warning."] : [],
      ...(status === "failed"
        ? { error: this.#error("conflict", "Every synthetic mutation target failed.") }
        : {})
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
): LocalRoutegoService {
  return new MockRoutegoService(options);
}
