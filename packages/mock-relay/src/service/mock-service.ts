import { createHash } from "node:crypto";

import {
  capabilityProbeInputSchema,
  capabilityProbeResultSchema,
  discardUploadResourceInputSchema,
  discardUploadResourceResultSchema,
  executeLibraryMutationInputSchema,
  executeLibraryMutationResultSchema,
  finalizeUploadResourceInputSchema,
  finalizeUploadResourceResultSchema,
  getAssetDetailInputSchema,
  getAssetDetailResultSchema,
  getBrowserResourceInputSchema,
  getBrowserResourceResultSchema,
  getUploadResourceStatusInputSchema,
  getUploadResourceStatusResultSchema,
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
  reserveUploadResourceInputSchema,
  reserveUploadResourceResultSchema,
  removeProviderProfileInputSchema,
  removeProviderProfileResultSchema,
  reorderFoldersInputSchema,
  reorderFoldersResultSchema,
  routegoBatchInputSchema,
  routegoBatchResultSchema,
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
  studioProviderSwitchInputSchema,
  studioProviderSwitchResultSchema,
  studioBatchInputSchema,
  studioBatchResultSchema,
  studioGenerateInputSchema,
  studioImageOperationResultSchema,
  studioLibrarySearchInputSchema,
  studioLibrarySearchResultSchema,
  studioServiceErrorSchema,
  uploadServiceErrorSchema,
  uploadResourceDescriptorSchema,
  updateSettingsInputSchema,
  updateSettingsResultSchema,
  upsertProviderProfileInputSchema,
  upsertProviderProfileResultSchema,
  type BrowserResourceDescriptor,
  type CapabilityProbeInput,
  type CapabilityProbeResult,
  type DiscardUploadResourceInput,
  type DiscardUploadResourceResult,
  type ExecuteLibraryMutationInput,
  type ExecuteLibraryMutationResult,
  type FinalizeUploadResourceInput,
  type FinalizeUploadResourceResult,
  type GetAssetDetailInput,
  type GetAssetDetailResult,
  type GetBrowserResourceInput,
  type GetBrowserResourceResult,
  type GetUploadResourceStatusInput,
  type GetUploadResourceStatusResult,
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
  type StudioBatchInput,
  type StudioBatchResult,
  type StudioEditInput,
  type StudioGenerateInput,
  type StudioImageArtifact,
  type StudioImageRelationship,
  type StudioImageOperationRequest,
  type StudioImageOperationResult,
  type StudioLibrarySearchInput,
  type StudioLibrarySearchResult,
  type StudioServiceError,
  type StudioOperation,
  type StudioProviderSwitchInput,
  type StudioProviderSwitchResult,
  type UploadResourceDescriptor,
  type UpsertProviderProfileInput,
  type UpsertProviderProfileResult,
  type ReserveUploadResourceInput,
  type ReserveUploadResourceResult,
  type UpdateSettingsInput,
  type UpdateSettingsResult
} from "@routego-image/contracts";
import { describeProviderEndpoint } from "@routego-image/foundation";

export type MockServiceFixture =
  | "success"
  | "failure"
  | "partial"
  | "degraded"
  | "invalid-output"
  | "expired"
  | "not-found"
  | "invalid-type"
  | "oversize"
  | "checksum-failed"
  | "consumed"
  | "discarded";

export type MockServiceOperation = RoutegoOperation | StudioOperation;

export interface MockRoutegoServiceOptions {
  readonly fixture?: MockServiceFixture;
  readonly fixtureByOperation?: Partial<Record<MockServiceOperation, MockServiceFixture>>;
  readonly requestId?: string;
  readonly timestamp?: string;
  readonly initiallyConfigured?: boolean;
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
  readonly #uploads = new Map<string, UploadResourceDescriptor>();
  readonly #preflights = new Map<
    string,
    { readonly action: LibraryMutationRequest["action"]; readonly targetIds: readonly string[] }
  >();
  #settings: ReadSettingsResult;

  constructor(options: MockRoutegoServiceOptions = {}) {
    this.#options = options;
    if (options.requestId !== undefined) {
      identifierSchema.parse(options.requestId);
    }
    const initiallyConfigured = options.initiallyConfigured ?? true;
    this.#settings = readSettingsResultSchema.parse({
      schemaVersion: 1,
      ...(initiallyConfigured ? { activeProviderId: "mock-provider" } : {}),
      profiles: initiallyConfigured ? [this.#profile()] : [],
      defaults: {
        ...(initiallyConfigured ? { model: "mock-image-model" } : {}),
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

  #fixture(operation: MockServiceOperation): MockServiceFixture {
    return this.#options.fixtureByOperation?.[operation] ?? this.#options.fixture ?? "success";
  }

  #requestId(operation: MockServiceOperation, input: unknown): string {
    return this.#options.requestId ?? deterministicId(`mock-${operation}`, input);
  }

  #timestamp(): string {
    return this.#options.timestamp ?? DEFAULT_TIMESTAMP;
  }

  #timestampWithOffset(minutes: number): string {
    return new Date(Date.parse(this.#timestamp()) + minutes * 60_000).toISOString();
  }

  #redactedOutputDirectoryDisplay(path: string): string {
    const segments = path.split(/[\\/]/u).filter((segment) => segment.length > 0);
    const tail = segments.slice(-2).join("/");
    return tail.length > 0 ? `…/${tail}` : "Selected local output directory";
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

  #uploadError(
    code:
      | "not_found"
      | "upload_expired"
      | "upload_invalid_type"
      | "upload_oversize"
      | "upload_checksum_failed"
      | "upload_consumed"
      | "upload_discarded",
    safeMessage: string
  ) {
    return uploadServiceErrorSchema.parse({
      code,
      category: code === "not_found" ? "persistence" : "validation",
      stage: "validate",
      safeMessage,
      retryDisposition: "user-confirmation",
      partialArtifacts: [],
      receivedAnyOutput: false,
      mayHaveBilled: false
    });
  }

  #libraryUploadError(
    code:
      | "not_found"
      | "upload_expired"
      | "upload_invalid_type"
      | "upload_oversize"
      | "upload_checksum_failed"
      | "upload_consumed"
      | "upload_discarded",
    safeMessage: string
  ): RoutegoServiceError {
    return code === "not_found"
      ? this.#error("not_found", safeMessage)
      : this.#error("conflict", safeMessage);
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

  #folders(ids: readonly string[] = ["mock-folder-primary", "mock-folder-secondary"]): LibraryFolderDescriptor[] {
    return ids.map((id, index) => ({
      id,
      name:
        id === "mock-folder-primary"
          ? "Synthetic primary"
          : "Synthetic secondary",
      order: index,
      assetCount: 1,
      state: "active",
      createdAt: this.#timestamp(),
      updatedAt: this.#timestamp()
    }));
  }

  #browserResource(
    resourceId = "mock-resource-preview",
    mimeType: BrowserResourceDescriptor["mimeType"] = "image/png",
    scope: "library" | "creation" = "library"
  ): BrowserResourceDescriptor {
    const isImage = mimeType.startsWith("image/");
    return {
      resourceId,
      relativeUrl:
        scope === "library"
          ? `/api/v1/library/resources/${resourceId}`
          : `/api/v1/resources/${resourceId}`,
      requiresSession: true,
      mimeType,
      byteLength: isImage ? Buffer.from(MOCK_IMAGE_BASE64, "base64").byteLength : 256,
      ...(isImage ? { width: 1, height: 1 } : {}),
      etag: deterministicId("mock-etag", { resourceId, mimeType }),
      expiresAt: this.#timestampWithOffset(5)
    };
  }

  #libraryParameters(
    prompt: string,
    size: "1024x1024" | "1536x1024" | "1024x1536"
  ): LibraryOperationParameters {
    return {
      kind: "generate",
      prompt,
      references: [],
      size,
      aspectRatio: size === "1024x1024" ? "1:1" : size === "1536x1024" ? "3:2" : "2:3",
      quality: "high" as const,
      format: "png" as const,
      count: 1,
      partialImages: 0,
      transparentMode: "off" as const,
      moderation: "auto" as const,
      outputDirectoryMode: "default" as const,
      saveToLibrary: true
    };
  }

  #assetDetail(
    fixture: Exclude<MockServiceFixture, "invalid-output" | "failure">,
    assetId: string
  ): LibraryAssetDetail | undefined {
    const seed =
      assetId === "mock-asset-generate-success"
        ? {
            kind: "generate" as const,
            status: "succeeded" as const,
            prompt: "Synthetic astronaut cat in a quiet darkroom.",
            size: "1024x1024" as const,
            artifactId: "mock-artifact-generate-success",
            createdOffset: -20,
            folders: ["mock-folder-primary"]
          }
        : assetId === "mock-asset-output"
          ? {
              kind: "generate" as const,
              status: "partial" as const,
              prompt: "Synthetic partial generation for downstream Studio development.",
              size: "1536x1024" as const,
              artifactId: "mock-artifact-output",
              createdOffset: -10,
              folders: ["mock-folder-primary", "mock-folder-secondary"]
            }
          : undefined;
    if (!seed) {
      return undefined;
    }

    const parameters = this.#libraryParameters(seed.prompt, seed.size);
    const partial = seed.status === "partial" || fixture === "partial";
    const createdAt = this.#timestampWithOffset(seed.createdOffset);
    const folderMap = new Map(this.#folders().map((folder) => [folder.id, folder]));
    const relationships = [
      {
        id: `${assetId}-rel-output`,
        role: "output" as const,
        relatedAssetId: assetId,
        artifactId: seed.artifactId,
        order: 0
      }
    ];

    return {
      id: assetId,
      prompt: parameters.prompt,
      model: "mock-image-model",
      kind: seed.kind,
      status: partial ? "partial" : "succeeded",
      currentMark: assetId === "mock-asset-output",
      mimeType: "image/png",
      width: seed.size === "1536x1024" ? 1536 : 1024,
      height: 1024,
      createdAt,
      updatedAt: this.#timestampWithOffset(seed.createdOffset + 1),
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
      primaryArtifactId: seed.artifactId,
      renditions: [
        {
          artifactId: seed.artifactId,
          phase: partial ? "partial" : "final",
          mimeType: "image/png",
          byteLength: Buffer.from(MOCK_IMAGE_BASE64, "base64").byteLength,
          width: seed.size === "1536x1024" ? 1536 : 1024,
          height: 1024,
          sha256: createHash("sha256").update(MOCK_IMAGE_BASE64, "base64").digest("hex"),
          createdAt
        }
      ],
      relationships,
      folders: seed.folders.map((folderId) => {
        const folder = folderMap.get(folderId)!;
        return {
          folderId,
          name: folder.name,
          state: folder.state,
          order: folder.order
        };
      }),
      allowedActions: [
        "assign-folders",
        "remove-folders",
        "export-zip",
        "download",
        "mark",
        "copy-generation-info"
      ]
    };
  }

  #galleryDetails(): LibraryAssetDetail[] {
    return [
      this.#assetDetail("success", "mock-asset-generate-success")!,
      this.#assetDetail("success", "mock-asset-output")!
    ];
  }

  #galleryPage(input: ReturnType<typeof routegoSearchLibraryInputSchema.parse>): {
    readonly items: LibraryAssetDetail[];
    readonly total: number;
    readonly nextCursor?: string;
  } {
    const query = input.query?.toLocaleLowerCase();
    const filtered = this.#galleryDetails().filter((asset) => {
      if (!input.includeDeleted && asset.status === "deleted") {
        return false;
      }
      if (query && !asset.prompt.toLocaleLowerCase().includes(query)) {
        return false;
      }
      if (input.models.length > 0 && !input.models.includes(asset.model)) {
        return false;
      }
      if (input.from && Date.parse(asset.createdAt) < Date.parse(input.from)) {
        return false;
      }
      if (input.to && Date.parse(asset.createdAt) > Date.parse(input.to)) {
        return false;
      }
      if (input.kinds.length > 0 && !input.kinds.includes(asset.kind)) {
        return false;
      }
      if (input.sizes.length > 0 && !input.sizes.includes(asset.effectiveParams.size)) {
        return false;
      }
      if (input.statuses.length > 0 && !input.statuses.includes(asset.status)) {
        return false;
      }
      if (
        input.folderIds.length > 0 &&
        !asset.folders.some((folder) => input.folderIds.includes(folder.folderId))
      ) {
        return false;
      }
      return true;
    });

    filtered.sort((left, right) => {
      const tieBreak = left.id.localeCompare(right.id);
      if (input.sort === "created-asc") {
        return Date.parse(left.createdAt) - Date.parse(right.createdAt) || tieBreak;
      }
      if (input.sort === "prompt-asc") {
        return left.prompt.localeCompare(right.prompt) || tieBreak;
      }
      if (input.sort === "prompt-desc") {
        return right.prompt.localeCompare(left.prompt) || tieBreak;
      }
      return Date.parse(right.createdAt) - Date.parse(left.createdAt) || tieBreak;
    });

    const match = input.cursor?.match(/^mock-cursor:(\d+)$/u);
    const offset = match ? Number.parseInt(match[1]!, 10) : 0;
    const items = filtered.slice(offset, offset + input.limit);
    const nextOffset = offset + items.length;
    return {
      items,
      total: filtered.length,
      ...(nextOffset < filtered.length ? { nextCursor: `mock-cursor:${nextOffset}` } : {})
    };
  }

  #mutationTargets(mutation: LibraryMutationRequest): string[] {
    return "assetIds" in mutation ? [...mutation.assetIds] : [mutation.uploadResourceId];
  }

  #requiredConfirmation(
    action: LibraryMutationRequest["action"]
  ): "zip-export" | "zip-import" | undefined {
    return action === "export-zip" ? "zip-export" : action === "import-zip" ? "zip-import" : undefined;
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

  #studioArtifact(
    requestId: string,
    phase: "partial" | "final" = "final",
    saveToLibrary = true
  ): StudioImageArtifact {
    const artifactId = deterministicId("mock-studio-artifact", { requestId, phase });
    return {
      artifactId,
      ...(saveToLibrary
        ? { assetId: deterministicId("mock-studio-asset", { requestId, phase }) }
        : {}),
      slot: 0,
      phase,
      resource: this.#browserResource(
        deterministicId("mock-studio-resource", { requestId, phase }),
        "image/png",
        "creation"
      ),
      createdAt: this.#timestamp()
    };
  }

  #studioRelationships(outputArtifactId: string, partial: boolean): StudioImageRelationship[] {
    return [{ role: partial ? "stream-partial" : "output", outputArtifactId, order: 0 }];
  }

  #studioImageResult(
    fixture: Exclude<MockServiceFixture, "invalid-output">,
    request: StudioImageOperationRequest,
    requestId: string
  ): StudioImageOperationResult {
    if (fixture === "failure") {
      const error = studioServiceErrorSchema.parse({
        code: "capability_unavailable",
        category: "capability",
        stage: "route",
        safeMessage: "The selected synthetic Studio fixture has no image-input capability.",
        retryDisposition: "user-confirmation",
        partialArtifacts: [],
        receivedAnyOutput: false,
        mayHaveBilled: false
      });
      return studioImageOperationResultSchema.parse({
        schemaVersion: 1,
        requestId,
        status: "failed",
        requestedParams: request,
        effectiveParams: request,
        execution: {
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
        error
      });
    }

    if (fixture === "partial") {
      const artifact = this.#studioArtifact(requestId, "partial", request.saveToLibrary);
      const error = studioServiceErrorSchema.parse({
        code: "invalid_response",
        category: "protocol",
        stage: "stream",
        safeMessage: "The synthetic Studio stream ended after a partial image.",
        retryDisposition: "never",
        partialArtifacts: [artifact],
        receivedAnyOutput: true,
        mayHaveBilled: true
      });
      return studioImageOperationResultSchema.parse({
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
        relationships: this.#studioRelationships(artifact.artifactId, true),
        error
      });
    }

    const artifact = this.#studioArtifact(requestId, "final", request.saveToLibrary);
    return studioImageOperationResultSchema.parse({
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
        degradedContinuation: fixture === "degraded",
        providerImageIds: []
      },
      finalArtifacts: [artifact],
      partialArtifacts: [],
      failedSlots: [],
      relationships: this.#studioRelationships(artifact.artifactId, false)
    });
  }

  async status(input: RoutegoStatusInput): Promise<RoutegoStatusResult> {
    const parsed = routegoStatusInputSchema.parse(input);
    if (this.#fixture("status") === "invalid-output") {
      return invalidOutput<RoutegoStatusResult>();
    }
    const activeProfile = this.#settings.profiles.find(
      (profile) => profile.id === this.#settings.activeProviderId && profile.isActive
    );
    const model = this.#settings.defaults.model ?? activeProfile?.defaultModel;
    const configured = activeProfile?.hasApiKey === true && model !== undefined;
    return routegoStatusResultSchema.parse({
      schemaVersion: 1,
      configured,
      hasApiKey: activeProfile?.hasApiKey ?? false,
      ...(activeProfile?.apiKeyPreview === undefined ? {} : { apiKeyPreview: activeProfile.apiKeyPreview }),
      ...(activeProfile === undefined ? {} : { providerId: activeProfile.id, endpoint: activeProfile.endpoints.generation }),
      models: activeProfile?.models ?? [],
      capabilities: [],
      defaults: {
        ...(model === undefined ? {} : { model }),
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
    return readSettingsResultSchema.parse(this.#settings);
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
    const profileId = parsed.profileId ?? deterministicId("mock-provider", parsed.name);
    const existing = this.#settings.profiles.find((profile) => profile.id === profileId);
    const hasApiKey =
      parsed.apiKey.operation === "replace"
        ? true
        : parsed.apiKey.operation === "clear"
          ? false
          : (existing?.hasApiKey ?? false);
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
      ...(parsed.defaultModel
        ? { defaultModel: parsed.defaultModel, models: [parsed.defaultModel] }
        : existing?.defaultModel
          ? { defaultModel: existing.defaultModel, models: existing.models }
          : {}),
      hasApiKey,
      isActive: parsed.setActive || (existing?.isActive ?? false),
      createdAt: existing?.createdAt ?? this.#timestamp(),
      updatedAt: this.#timestamp()
    });
    const remaining = this.#settings.profiles.filter((item) => item.id !== profileId);
    const profiles = [...remaining, profile].map((item) =>
      profile.isActive ? { ...item, isActive: item.id === profile.id } : item
    );
    const activeProviderId = profiles.find((item) => item.isActive)?.id;
    this.#settings = readSettingsResultSchema.parse({
      ...this.#settings,
      profiles,
      ...(activeProviderId ? { activeProviderId } : { activeProviderId: undefined })
    });
    return upsertProviderProfileResultSchema.parse({
      schemaVersion: 1,
      profile,
      ...(activeProviderId ? { activeProviderId } : {})
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
    if (!this.#settings.profiles.some((profile) => profile.id === parsed.profileId)) {
      throw this.#error("not_found", "The synthetic provider profile does not exist.");
    }
    const profiles = this.#settings.profiles.filter((profile) => profile.id !== parsed.profileId);
    const activeProviderId = profiles.find((profile) => profile.isActive)?.id;
    this.#settings = readSettingsResultSchema.parse({
      ...this.#settings,
      profiles,
      ...(activeProviderId ? { activeProviderId } : { activeProviderId: undefined })
    });
    return removeProviderProfileResultSchema.parse({
      schemaVersion: 1,
      removedProfileId: parsed.profileId,
      ...(activeProviderId ? { activeProviderId } : {})
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
    const selected = this.#settings.profiles.find((profile) => profile.id === parsed.profileId);
    if (!selected) {
      throw this.#error("not_found", "The synthetic provider profile does not exist.");
    }
    const profiles = this.#settings.profiles.map((profile) => ({
      ...profile,
      isActive: profile.id === parsed.profileId,
      updatedAt: profile.id === parsed.profileId ? this.#timestamp() : profile.updatedAt
    }));
    const profile = profiles.find((item) => item.id === parsed.profileId)!;
    this.#settings = readSettingsResultSchema.parse({
      ...this.#settings,
      activeProviderId: parsed.profileId,
      profiles
    });
    return setActiveProviderProfileResultSchema.parse({
      schemaVersion: 1,
      activeProviderId: parsed.profileId,
      profile
    });
  }

  async studioProviderSwitch(
    input: StudioProviderSwitchInput
  ): Promise<StudioProviderSwitchResult> {
    const parsed = studioProviderSwitchInputSchema.parse(input);
    const fixture = this.#fixture("studioProviderSwitch");
    if (fixture === "invalid-output") {
      return invalidOutput<StudioProviderSwitchResult>();
    }
    const selected = this.#settings.profiles.find((profile) => profile.id === parsed.profileId);
    if (fixture === "failure" || !selected) {
      return studioProviderSwitchResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        error: this.#error("not_found", "The synthetic provider profile does not exist.")
      });
    }

    const selectedModel =
      parsed.preferredModel && selected.models.includes(parsed.preferredModel)
        ? parsed.preferredModel
        : selected.defaultModel ?? selected.models[0];
    if (!selectedModel) {
      return studioProviderSwitchResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        error: this.#error("conflict", "The synthetic provider profile has no usable model.")
      });
    }

    const profiles = this.#settings.profiles.map((profile) => ({
      ...profile,
      isActive: profile.id === selected.id,
      updatedAt: profile.id === selected.id ? this.#timestamp() : profile.updatedAt
    }));
    const profile = profiles.find((item) => item.id === selected.id)!;
    this.#settings = readSettingsResultSchema.parse({
      ...this.#settings,
      activeProviderId: profile.id,
      profiles,
      defaults: { ...this.#settings.defaults, model: selectedModel }
    });
    return studioProviderSwitchResultSchema.parse({
      schemaVersion: 1,
      status: "succeeded",
      activeProviderId: profile.id,
      selectedModel,
      modelPreserved: parsed.preferredModel === selectedModel,
      profile,
      appliesToFutureSubmissionsOnly: true
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
    const models =
      fixture === "degraded"
        ? ["mock-image-model"]
        : ["mock-image-model", "mock-image-model-v2"];
    this.#settings = readSettingsResultSchema.parse({
      ...this.#settings,
      profiles: this.#settings.profiles.map((profile) =>
        profile.id === parsed.providerId ? { ...profile, models, updatedAt: this.#timestamp() } : profile
      )
    });
    return refreshModelsResultSchema.parse({
      schemaVersion: 1,
      providerId: parsed.providerId,
      status: "succeeded",
      billable: false,
      models,
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

  async updateSettings(input: UpdateSettingsInput): Promise<UpdateSettingsResult> {
    const parsed = updateSettingsInputSchema.parse(input);
    const fixture = this.#fixture("updateSettings");
    if (fixture === "invalid-output") {
      return invalidOutput<UpdateSettingsResult>();
    }
    if (fixture === "failure") {
      throw this.#error("conflict", "The synthetic settings update was rejected.");
    }

    let outputDirectory = this.#settings.outputDirectory;
    if (parsed.outputDirectory) {
      if (parsed.outputDirectory.operation === "default") {
        outputDirectory = { configured: true, display: "Default Pictures/routego-image" };
      } else if (parsed.outputDirectory.operation === "clear") {
        outputDirectory = { configured: false };
      } else if (parsed.outputDirectory.operation === "replace") {
        outputDirectory = {
          configured: true,
          display: this.#redactedOutputDirectoryDisplay(parsed.outputDirectory.path)
        };
      }
    }

    this.#settings = updateSettingsResultSchema.parse({
      ...this.#settings,
      defaults: parsed.defaults ?? this.#settings.defaults,
      outputDirectory
    });
    return updateSettingsResultSchema.parse(this.#settings);
  }

  async generate(input: RoutegoGenerateInput): Promise<ImageOperationResult> {
    const request = routegoGenerateInputSchema.parse(input);
    const fixture = this.#fixture("generate");
    if (fixture === "invalid-output") {
      return invalidOutput<ImageOperationResult>();
    }
    return this.#imageResult(fixture, request, this.#requestId("generate", request));
  }

  async edit(_input: RoutegoEditInput): Promise<ImageOperationResult> {
    throw this.#error("conflict", "The generation-only mock service does not support edit operations.");
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
    const parsed = routegoSearchLibraryInputSchema.parse(input);
    const fixture = this.#fixture("searchLibrary");
    if (fixture === "invalid-output") {
      return invalidOutput<RoutegoSearchLibraryResult>();
    }
    if (fixture === "failure") {
      throw this.#error("conflict", "The synthetic public gallery search failed.");
    }
    const page = this.#galleryPage(parsed);
    return routegoSearchLibraryResultSchema.parse({
      schemaVersion: 1,
      items: page.items.map((asset) => ({
        id: asset.id,
        path: `/synthetic/routego-image/${asset.id}.png`,
        prompt: asset.prompt,
        model: asset.model,
        kind: asset.kind,
        mimeType: asset.mimeType,
        width: asset.width,
        height: asset.height,
        status: asset.status,
        folderIds: asset.folders.map((folder) => folder.folderId),
        createdAt: asset.createdAt,
        ...(asset.deletedAt ? { deletedAt: asset.deletedAt } : {})
      })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      total: page.total
    });
  }

  async studioGenerate(input: StudioGenerateInput): Promise<StudioImageOperationResult> {
    const request = studioGenerateInputSchema.parse(input);
    const fixture = this.#fixture("studioGenerate");
    if (fixture === "invalid-output") {
      return invalidOutput<StudioImageOperationResult>();
    }
    return this.#studioImageResult(
      fixture,
      request,
      this.#requestId("studioGenerate", request)
    );
  }

  async studioEdit(_input: StudioEditInput): Promise<StudioImageOperationResult> {
    throw this.#error("conflict", "The generation-only mock service does not support Studio edit operations.");
  }

  async studioBatch(input: StudioBatchInput): Promise<StudioBatchResult> {
    const parsed = studioBatchInputSchema.parse(input);
    const fixture = this.#fixture("studioBatch");
    if (fixture === "invalid-output") {
      return invalidOutput<StudioBatchResult>();
    }
    const requestId = this.#requestId("studioBatch", parsed);
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
        result: this.#studioImageResult(
          itemFixture,
          task.operation,
          deterministicId(`mock-studio-batch-${task.id}`, {
            requestId,
            operation: task.operation
          })
        )
      };
    });
    const allSucceeded = items.every((item) => item.result.status === "succeeded");
    const allFailed = items.every((item) => item.result.status === "failed");
    return studioBatchResultSchema.parse({
      schemaVersion: 1,
      requestId,
      status: allSucceeded ? "succeeded" : allFailed ? "failed" : "partial",
      concurrency: parsed.concurrency,
      taskIds: parsed.tasks.map((task) => task.id),
      items
    });
  }

  async searchStudioLibrary(
    input: StudioLibrarySearchInput
  ): Promise<StudioLibrarySearchResult> {
    const parsed = studioLibrarySearchInputSchema.parse(input);
    const fixture = this.#fixture("searchStudioLibrary");
    if (fixture === "invalid-output") {
      return invalidOutput<StudioLibrarySearchResult>();
    }
    if (fixture === "failure") {
      throw this.#error("conflict", "The synthetic Studio gallery search failed.");
    }
    const page = this.#galleryPage(parsed);
    return studioLibrarySearchResultSchema.parse({
      schemaVersion: 1,
      items: page.items.map((asset) => {
        const artifactId = asset.renditions[0]!.artifactId;
        return {
          assetId: asset.id,
          artifactId,
          prompt: asset.prompt,
          model: asset.model,
          kind: asset.kind,
          mimeType: asset.mimeType,
          width: asset.width,
          height: asset.height,
          status: asset.status,
          folderIds: asset.folders.map((folder) => folder.folderId),
          createdAt: asset.createdAt,
          ...(asset.deletedAt ? { deletedAt: asset.deletedAt } : {}),
          thumbnail: this.#browserResource(
            deterministicId("mock-thumbnail", { assetId: asset.id, artifactId }),
            "image/png"
          )
        };
      }),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      total: page.total
    });
  }

  async reserveUploadResource(
    input: ReserveUploadResourceInput
  ): Promise<ReserveUploadResourceResult> {
    const parsed = reserveUploadResourceInputSchema.parse(input);
    const fixture = this.#fixture("reserveUploadResource");
    if (fixture === "invalid-output") {
      return invalidOutput<ReserveUploadResourceResult>();
    }

    const maxBytes = parsed.purpose === "zip-import" ? 536_870_912 : 52_428_800;
    const failureCode =
      fixture === "expired"
        ? "upload_expired"
        : fixture === "not-found"
          ? "not_found"
          : fixture === "oversize" || parsed.declaredByteLength > maxBytes
            ? "upload_oversize"
            : fixture === "checksum-failed"
              ? "upload_checksum_failed"
              : fixture === "consumed"
                ? "upload_consumed"
                : fixture === "discarded"
                  ? "upload_discarded"
                  : fixture === "invalid-type" || fixture === "failure"
                    ? "upload_invalid_type"
                    : undefined;
    if (failureCode) {
      return reserveUploadResourceResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        error: this.#uploadError(
          failureCode,
          `The synthetic upload reservation failed with ${failureCode}.`
        )
      });
    }

    const uploadResourceId = deterministicId("mock-upload", parsed);
    const allowedMimeTypes =
      parsed.purpose === "zip-import"
        ? (["application/zip"] as const)
        : parsed.purpose === "mask"
          ? (["image/png"] as const)
          : (["image/png", "image/jpeg", "image/webp"] as const);
    const resource = uploadResourceDescriptorSchema.parse({
      uploadResourceId,
      purpose: parsed.purpose,
      status: "reserved",
      reusePolicy:
        parsed.purpose === "zip-import" ? "single-consume" : "reusable-until-expiry",
      binaryUpload: {
        method: "PUT",
        relativeUrl: `/api/v1/uploads/${uploadResourceId}/content`,
        requiresSession: true,
        requiresOrigin: true,
        allowedMimeTypes,
        maxBytes,
        expiresAt: this.#timestampWithOffset(5)
      },
      declaredMimeType: parsed.declaredMimeType,
      declaredByteLength: parsed.declaredByteLength,
      ...(parsed.expectedSha256 ? { expectedSha256: parsed.expectedSha256 } : {}),
      createdAt: this.#timestamp()
    });
    this.#uploads.set(uploadResourceId, resource);
    return reserveUploadResourceResultSchema.parse({
      schemaVersion: 1,
      status: "succeeded",
      resource
    });
  }

  async finalizeUploadResource(
    input: FinalizeUploadResourceInput
  ): Promise<FinalizeUploadResourceResult> {
    const parsed = finalizeUploadResourceInputSchema.parse(input);
    const fixture = this.#fixture("finalizeUploadResource");
    if (fixture === "invalid-output") {
      return invalidOutput<FinalizeUploadResourceResult>();
    }
    const resource = this.#uploads.get(parsed.uploadResourceId);
    if (fixture === "not-found" || !resource) {
      return finalizeUploadResourceResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        error: this.#uploadError("not_found", "The synthetic upload resource was not found.")
      });
    }
    if (resource.status === "consumed" || fixture === "consumed") {
      return finalizeUploadResourceResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        error: this.#uploadError("upload_consumed", "The synthetic ZIP upload was consumed.")
      });
    }
    if (resource.status === "discarded" || fixture === "discarded") {
      return finalizeUploadResourceResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        error: this.#uploadError("upload_discarded", "The synthetic upload was discarded.")
      });
    }
    if (resource.status === "expired" || fixture === "expired") {
      const { finalized, consumedAt, discardedAt, error, ...base } = resource;
      void finalized;
      void consumedAt;
      void discardedAt;
      void error;
      this.#uploads.set(
        parsed.uploadResourceId,
        uploadResourceDescriptorSchema.parse({ ...base, status: "expired" })
      );
      return finalizeUploadResourceResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        error: this.#uploadError("upload_expired", "The synthetic upload expired.")
      });
    }
    if (resource.status === "finalized") {
      return finalizeUploadResourceResultSchema.parse({
        schemaVersion: 1,
        status: "succeeded",
        resource
      });
    }

    const failureCode =
      fixture === "oversize"
        ? "upload_oversize"
        : fixture === "checksum-failed"
          ? "upload_checksum_failed"
          : fixture === "invalid-type" || fixture === "failure"
            ? "upload_invalid_type"
            : undefined;
    if (failureCode) {
      const uploadError = this.#uploadError(
        failureCode,
        `The synthetic upload finalization failed with ${failureCode}.`
      );
      const { finalized, consumedAt, discardedAt, error, ...base } = resource;
      void finalized;
      void consumedAt;
      void discardedAt;
      void error;
      this.#uploads.set(
        parsed.uploadResourceId,
        uploadResourceDescriptorSchema.parse({
          ...base,
          status: "failed",
          error: uploadError
        })
      );
      return finalizeUploadResourceResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        error: uploadError
      });
    }

    const { finalized, consumedAt, discardedAt, error, ...base } = resource;
    void finalized;
    void consumedAt;
    void discardedAt;
    void error;
    const finalizedResource = uploadResourceDescriptorSchema.parse({
      ...base,
      status: "finalized",
      finalized: {
        detectedMimeType: resource.declaredMimeType,
        byteLength: resource.declaredByteLength,
        sha256:
          resource.expectedSha256 ??
          createHash("sha256").update(parsed.uploadResourceId, "utf8").digest("hex"),
        ...(resource.declaredMimeType.startsWith("image/") ? { width: 1, height: 1 } : {}),
        finalizedAt: this.#timestampWithOffset(1)
      }
    });
    this.#uploads.set(parsed.uploadResourceId, finalizedResource);
    return finalizeUploadResourceResultSchema.parse({
      schemaVersion: 1,
      status: "succeeded",
      resource: finalizedResource
    });
  }

  async getUploadResourceStatus(
    input: GetUploadResourceStatusInput
  ): Promise<GetUploadResourceStatusResult> {
    const parsed = getUploadResourceStatusInputSchema.parse(input);
    const fixture = this.#fixture("getUploadResourceStatus");
    if (fixture === "invalid-output") {
      return invalidOutput<GetUploadResourceStatusResult>();
    }
    const resource = this.#uploads.get(parsed.uploadResourceId);
    if (fixture === "not-found" || !resource) {
      return getUploadResourceStatusResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        error: this.#uploadError("not_found", "The synthetic upload resource was not found.")
      });
    }
    if (fixture === "expired" || resource.status === "expired") {
      return getUploadResourceStatusResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        error: this.#uploadError("upload_expired", "The synthetic upload expired.")
      });
    }
    return getUploadResourceStatusResultSchema.parse({
      schemaVersion: 1,
      status: "succeeded",
      resource
    });
  }

  async discardUploadResource(
    input: DiscardUploadResourceInput
  ): Promise<DiscardUploadResourceResult> {
    const parsed = discardUploadResourceInputSchema.parse(input);
    const fixture = this.#fixture("discardUploadResource");
    if (fixture === "invalid-output") {
      return invalidOutput<DiscardUploadResourceResult>();
    }
    const resource = this.#uploads.get(parsed.uploadResourceId);
    if (fixture === "not-found" || !resource) {
      return discardUploadResourceResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        error: this.#uploadError("not_found", "The synthetic upload resource was not found.")
      });
    }
    if (fixture === "expired" || resource.status === "expired") {
      return discardUploadResourceResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        error: this.#uploadError("upload_expired", "The synthetic upload expired.")
      });
    }
    if (fixture === "consumed" || resource.status === "consumed") {
      return discardUploadResourceResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        error: this.#uploadError("upload_consumed", "The synthetic ZIP upload was consumed.")
      });
    }
    if (resource.status === "discarded") {
      return discardUploadResourceResultSchema.parse({
        schemaVersion: 1,
        status: "succeeded",
        resource
      });
    }
    const { finalized, consumedAt, discardedAt, error, ...base } = resource;
    void finalized;
    void consumedAt;
    void discardedAt;
    void error;
    const discardedResource = uploadResourceDescriptorSchema.parse({
      ...base,
      status: "discarded",
      discardedAt: this.#timestampWithOffset(1)
    });
    this.#uploads.set(parsed.uploadResourceId, discardedResource);
    return discardUploadResourceResultSchema.parse({
      schemaVersion: 1,
      status: "succeeded",
      resource: discardedResource
    });
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
    const asset = this.#assetDetail(fixture, parsed.assetId);
    if (!asset) {
      return getAssetDetailResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        error: this.#error("not_found", "The synthetic Library asset was not found.")
      });
    }
    return getAssetDetailResultSchema.parse({
      schemaVersion: 1,
      status: "succeeded",
      asset
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
      const upload =
        parsed.mutation.action === "import-zip" ? this.#uploads.get(targetId) : undefined;
      const uploadError =
        parsed.mutation.action !== "import-zip"
          ? undefined
          : !upload
            ? this.#libraryUploadError("not_found", "The synthetic ZIP upload was not found.")
            : upload.purpose !== "zip-import"
              ? this.#libraryUploadError(
                  "upload_invalid_type",
                  "The synthetic upload is not a ZIP import resource."
                )
              : upload.status === "consumed"
                ? this.#libraryUploadError(
                    "upload_consumed",
                    "The synthetic ZIP upload was consumed."
                  )
                : upload.status === "expired"
                  ? this.#libraryUploadError(
                      "upload_expired",
                      "The synthetic ZIP upload expired."
                    )
                  : upload.status === "discarded"
                    ? this.#libraryUploadError(
                        "upload_discarded",
                        "The synthetic ZIP upload was discarded."
                      )
                    : upload.status !== "finalized"
                      ? this.#error(
                          "conflict",
                          "The synthetic ZIP upload must be finalized before import."
                        )
                      : undefined;
      const eligible = !blocked && !uploadError && (!partial || index === 0);
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
              error:
                uploadError ??
                this.#error(
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
      expiresAt: this.#timestampWithOffset(5),
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
      const upload = parsed.action === "import-zip" ? this.#uploads.get(targetId) : undefined;
      const fixtureUploadError =
        parsed.action !== "import-zip"
          ? undefined
          : fixture === "not-found"
            ? this.#libraryUploadError("not_found", "The synthetic ZIP upload was not found.")
            : fixture === "expired"
              ? this.#libraryUploadError(
                  "upload_expired",
                  "The synthetic ZIP upload expired."
                )
              : fixture === "invalid-type"
                ? this.#libraryUploadError(
                    "upload_invalid_type",
                    "The synthetic upload is not an importable ZIP."
                  )
                : fixture === "oversize"
                  ? this.#libraryUploadError(
                      "upload_oversize",
                      "The synthetic ZIP upload is oversized."
                    )
                  : fixture === "checksum-failed"
                    ? this.#libraryUploadError(
                        "upload_checksum_failed",
                        "The synthetic ZIP checksum failed."
                      )
                    : fixture === "consumed"
                      ? this.#libraryUploadError(
                          "upload_consumed",
                          "The synthetic ZIP upload was consumed."
                        )
                      : fixture === "discarded"
                        ? this.#libraryUploadError(
                            "upload_discarded",
                            "The synthetic ZIP upload was discarded."
                          )
                        : undefined;
      const stateUploadError =
        parsed.action !== "import-zip" || fixtureUploadError
          ? undefined
          : !upload
            ? this.#libraryUploadError("not_found", "The synthetic ZIP upload was not found.")
            : upload.status === "consumed"
              ? this.#libraryUploadError(
                  "upload_consumed",
                  "The synthetic ZIP upload was consumed."
                )
              : upload.status === "expired"
                ? this.#libraryUploadError(
                    "upload_expired",
                    "The synthetic ZIP upload expired."
                  )
                : upload.status === "discarded"
                  ? this.#libraryUploadError(
                      "upload_discarded",
                      "The synthetic ZIP upload was discarded."
                    )
                  : upload.status !== "finalized"
                    ? this.#error(
                        "conflict",
                        "The synthetic ZIP upload must be finalized before import."
                      )
                    : undefined;
      const itemError = fixtureUploadError ?? stateUploadError;
      const succeeded = !failed && !itemError && (!partial || index === 0);
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
            error:
              itemError ??
              this.#error(
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
    if (parsed.action === "import-zip") {
      for (const item of items) {
        if (item.status !== "succeeded") {
          continue;
        }
        const upload = this.#uploads.get(item.targetId);
        if (!upload || upload.status !== "finalized" || upload.purpose !== "zip-import") {
          continue;
        }
        const { discardedAt, error, ...base } = upload;
        void discardedAt;
        void error;
        this.#uploads.set(
          item.targetId,
          uploadResourceDescriptorSchema.parse({
            ...base,
            status: "consumed",
            consumedAt: this.#timestampWithOffset(2)
          })
        );
      }
    }
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
