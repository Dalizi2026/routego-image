import { createHash, randomUUID } from "node:crypto";

import {
  failedOutputSlotSchema,
  identifierSchema,
  imageArtifactSchema,
  imageOperationEventSchema,
  imageOperationRequestSchema,
  imageOperationResultSchema,
  imageRelationshipSchema,
  routegoServiceErrorSchema,
  type FailedOutputSlot,
  type ImageArtifact,
  type ImageOperationEvent,
  type ImageOperationRequest,
  type ImageOperationResult,
  type ImageRelationship,
  type RoutegoServiceError
} from "@routego-image/contracts";
import { selectProviderRoute, type SelectedProviderRoute } from "@routego-image/foundation";

import {
  prepareProviderRequest,
  type NormalizedProviderResponse,
  type PreparedProviderRequest,
  type ProviderRuntimeContext
} from "../provider";
import { parseProviderResponse } from "../provider/responses";
import type {
  ImageExecutionDependencies,
  ResolvedExecutionOptions,
  ResolvedImageExecutor,
  VariantExecutionMode
} from "./types";

interface AbortMarker {
  readonly kind: "timeout" | "cancelled";
  readonly stage: "submit" | "stream" | "complete";
}

interface PreparedExecutionPlan {
  readonly prepared: true;
  readonly request: ImageOperationRequest;
  readonly effectiveRequest: ImageOperationRequest;
  readonly provider: ProviderRuntimeContext;
  readonly providerRequest: PreparedProviderRequest;
  readonly mode: VariantExecutionMode;
  readonly variantCount: number;
}

interface UnavailableExecutionPlan {
  readonly prepared: false;
  readonly request: ImageOperationRequest;
  readonly effectiveRequest: ImageOperationRequest;
  readonly provider?: ProviderRuntimeContext;
  readonly error: RoutegoServiceError;
}

type ExecutionPlan = PreparedExecutionPlan | UnavailableExecutionPlan;

interface SubmissionResult {
  readonly normalized: NormalizedProviderResponse;
  readonly attemptCount: number;
  readonly providerRequestCount: number;
}

interface VariantCollection {
  finalArtifacts: ImageArtifact[];
  partialArtifacts: ImageArtifact[];
  relationships: ImageRelationship[];
  failedSlots: FailedOutputSlot[];
  errors: RoutegoServiceError[];
  providerImageIds: string[];
  providerResponseIds: string[];
  attemptCount: number;
  providerRequestCount: number;
  receivedAnyOutput: boolean;
  mayHaveBilled: boolean;
}

type ExecutionEventInput =
  | { readonly type: "started" }
  | { readonly type: "partial"; readonly artifact: ImageArtifact }
  | { readonly type: "completed"; readonly artifactIds: readonly string[] }
  | {
      readonly type: "failed";
      readonly code: string;
      readonly safeMessage: string;
      readonly receivedAnyOutput: boolean;
      readonly mayHaveBilled: boolean;
    };

function safeRequestId(value: string): string {
  const parsed = identifierSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return `request:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24)}`;
}

function childRequestId(requestId: string, slot: number): string {
  return `child:${createHash("sha256").update(requestId, "utf8").digest("hex").slice(0, 20)}:${slot}`;
}

function createExecutionError(input: {
  readonly code: RoutegoServiceError["code"];
  readonly category: RoutegoServiceError["category"];
  readonly stage: RoutegoServiceError["stage"];
  readonly safeMessage: string;
  readonly receivedAnyOutput?: boolean;
  readonly mayHaveBilled?: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}): RoutegoServiceError {
  const receivedAnyOutput = input.receivedAnyOutput === true;
  return routegoServiceErrorSchema.parse({
    code: input.code,
    category: input.category,
    stage: input.stage,
    safeMessage: input.safeMessage,
    retryDisposition: "never",
    partialArtifacts: [],
    receivedAnyOutput,
    mayHaveBilled: receivedAnyOutput || input.mayHaveBilled === true,
    ...(input.details === undefined ? {} : { details: input.details })
  });
}

function abortError(
  marker: AbortMarker,
  providerRequestStarted: boolean,
  partialArtifacts: readonly ImageArtifact[] = [],
  receivedAnyOutput = false
): RoutegoServiceError {
  const received = receivedAnyOutput || partialArtifacts.length > 0;
  return routegoServiceErrorSchema.parse({
    code: marker.kind === "cancelled" ? "cancelled" : "timeout",
    category: marker.kind === "cancelled" ? "cancelled" : "timeout",
    stage: marker.stage,
    safeMessage:
      marker.kind === "cancelled"
        ? "The image operation was cancelled."
        : marker.stage === "submit"
          ? "The provider did not return response headers before the deadline."
          : marker.stage === "stream"
            ? "The provider response body or stream exceeded its deadline."
            : "The image operation exceeded its total deadline.",
    retryDisposition: "never",
    partialArtifacts: [...partialArtifacts].slice(0, 4),
    receivedAnyOutput: received,
    mayHaveBilled: received || providerRequestStarted,
    details: { timeoutStage: marker.stage }
  });
}

function normalizedAbort(
  normalizedResponse: NormalizedProviderResponse,
  marker: AbortMarker,
  providerRequestStarted: boolean
): NormalizedProviderResponse {
  const receivedAnyOutput =
    normalizedResponse.receivedAnyOutput ||
    normalizedResponse.finalArtifacts.length > 0 ||
    normalizedResponse.partialArtifacts.length > 0;
  return {
    ...normalizedResponse,
    receivedAnyOutput,
    mayHaveBilled: receivedAnyOutput || providerRequestStarted || normalizedResponse.mayHaveBilled,
    error: abortError(
      marker,
      providerRequestStarted,
      normalizedResponse.partialArtifacts,
      receivedAnyOutput
    )
  };
}

function abortMarker(signal: AbortSignal): AbortMarker | undefined {
  const reason = signal.reason;
  return typeof reason === "object" &&
    reason !== null &&
    "kind" in reason &&
    "stage" in reason
    ? reason as AbortMarker
    : undefined;
}

function linkAbort(source: AbortSignal | undefined, target: AbortController, marker: AbortMarker): () => void {
  if (source === undefined) return () => undefined;
  const abort = () => target.abort(abortMarker(source) ?? marker);
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function providerContextFor(
  dependencies: ImageExecutionDependencies,
  request: ImageOperationRequest
): Promise<ProviderRuntimeContext> {
  return Promise.resolve(
    typeof dependencies.providerContext === "function"
      ? dependencies.providerContext(request)
      : dependencies.providerContext
  );
}

async function prepareSelectedRoute(
  provider: ProviderRuntimeContext,
  request: ImageOperationRequest,
  route: SelectedProviderRoute
): Promise<PreparedProviderRequest | RoutegoServiceError> {
  const providerRequest = route.transparency === "local-fallback"
    ? imageOperationRequestSchema.parse({ ...request, transparentMode: "off" })
    : request;
  const prepared = await prepareProviderRequest(provider, providerRequest);
  return prepared.prepared ? prepared.value : prepared.error;
}

async function prepareExecutionPlan(
  dependencies: ImageExecutionDependencies,
  requestInput: ImageOperationRequest,
  providerInput?: ProviderRuntimeContext
): Promise<ExecutionPlan> {
  const request = imageOperationRequestSchema.parse(requestInput);
  let provider: ProviderRuntimeContext;
  try {
    provider = providerInput ?? await providerContextFor(dependencies, request);
  } catch {
    return {
      prepared: false,
      request,
      effectiveRequest: request,
      error: createExecutionError({
        code: "config_missing",
        category: "configuration",
        stage: "configure",
        safeMessage: "The active provider context is unavailable."
      })
    };
  }
  if (provider.apiKey.trim().length === 0) {
    return {
      prepared: false,
      request,
      effectiveRequest: request,
      provider,
      error: createExecutionError({
        code: "config_missing",
        category: "configuration",
        stage: "configure",
        safeMessage: "The active provider API key is missing."
      })
    };
  }

  const directRoute = selectProviderRoute(provider, request);
  if (directRoute.selected) {
    const prepared = await prepareSelectedRoute(provider, request, directRoute);
    if ("code" in prepared) {
      return { prepared: false, request, effectiveRequest: request, provider, error: prepared };
    }
    return {
      prepared: true,
      request,
      effectiveRequest: directRoute.transparency === "local-fallback"
        ? imageOperationRequestSchema.parse({ ...request, transparentMode: "off" })
        : request,
      provider,
      providerRequest: prepared,
      mode: request.count > 1 ? "native" : "single",
      variantCount: request.count
    };
  }

  if (request.count > 1) {
    const singleRequest = imageOperationRequestSchema.parse({ ...request, count: 1 });
    const singleRoute = selectProviderRoute(provider, singleRequest);
    if (singleRoute.selected) {
      const prepared = await prepareSelectedRoute(provider, singleRequest, singleRoute);
      if ("code" in prepared) {
        return { prepared: false, request, effectiveRequest: request, provider, error: prepared };
      }
      return {
        prepared: true,
        request,
        effectiveRequest: singleRoute.transparency === "local-fallback"
          ? imageOperationRequestSchema.parse({ ...request, transparentMode: "off" })
          : request,
        provider,
        providerRequest: prepared,
        mode: "fan-out",
        variantCount: request.count
      };
    }
  }
  return { prepared: false, request, effectiveRequest: request, provider, error: directRoute.error };
}

class ExecutionEvents {
  readonly #requestId: string;
  readonly #handler: ((event: ImageOperationEvent) => void | Promise<void>) | undefined;
  readonly #now: () => number;
  #sequence = 0;

  constructor(
    requestId: string,
    handler: ((event: ImageOperationEvent) => void | Promise<void>) | undefined,
    now: () => number
  ) {
    this.#requestId = requestId;
    this.#handler = handler;
    this.#now = now;
  }

  async emit(event: ExecutionEventInput): Promise<void> {
    if (this.#handler === undefined) return;
    const parsed = imageOperationEventSchema.parse({
      ...event,
      requestId: this.#requestId,
      sequence: this.#sequence,
      occurredAt: new Date(this.#now()).toISOString()
    });
    this.#sequence += 1;
    try {
      await this.#handler(parsed);
    } catch {
      // Event observers cannot change provider execution or billing semantics.
    }
  }
}

function requestBody(prepared: PreparedProviderRequest): BodyInit {
  return prepared.submission.bodyType === "multipart"
    ? prepared.submission.body
    : JSON.stringify(prepared.submission.body);
}

function wrapResponseBody(
  response: Response,
  signal: AbortSignal,
  onComplete: () => void
): Response {
  if (response.body === null) {
    onComplete();
    return response;
  }
  const reader = response.body.getReader();
  let completed = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  const abort = () => {
    complete();
    void reader.cancel(signal.reason).catch(() => undefined);
    try {
      controllerRef?.close();
    } catch {
      // The stream may already have closed while cancellation propagated.
    }
  };
  const complete = () => {
    if (!completed) {
      completed = true;
      signal.removeEventListener("abort", abort);
      onComplete();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          complete();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        complete();
        if (signal.aborted) controller.close();
        else controller.error(error);
      }
    },
    async cancel(reason) {
      complete();
      await reader.cancel(reason);
    }
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

function normalizedFailure(error: RoutegoServiceError): NormalizedProviderResponse {
  return {
    finalArtifacts: [],
    partialArtifacts: [],
    relationships: [],
    providerImageIds: [],
    revisedPrompts: [],
    receivedAnyOutput: false,
    mayHaveBilled: error.mayHaveBilled,
    error
  };
}

async function submitAttempt(
  prepared: PreparedProviderRequest,
  provider: ProviderRuntimeContext,
  requestId: string,
  operationSignal: AbortSignal,
  dependencies: ImageExecutionDependencies,
  events: ExecutionEvents,
  slotOffset?: number
): Promise<NormalizedProviderResponse> {
  const attemptController = new AbortController();
  const unlink = linkAbort(operationSignal, attemptController, { kind: "cancelled", stage: "complete" });
  let headerTimer: ReturnType<typeof setTimeout> | undefined;
  let bodyTimer: ReturnType<typeof setTimeout> | undefined;
  let providerRequestStarted = false;
  try {
    if (operationSignal.aborted) {
      return normalizedFailure(abortError(abortMarker(operationSignal) ?? { kind: "cancelled", stage: "complete" }, false));
    }
    headerTimer = setTimeout(
      () => attemptController.abort({ kind: "timeout", stage: "submit" } satisfies AbortMarker),
      provider.deadlines.responseHeaderMs
    );
    const headers = new Headers(prepared.submission.headers);
    headers.set("authorization", `Bearer ${provider.apiKey}`);
    providerRequestStarted = true;
    let response: Response;
    try {
      response = await provider.fetch(prepared.submission.endpoint, {
        method: "POST",
        headers,
        body: requestBody(prepared),
        signal: attemptController.signal
      });
    } catch {
      const marker = abortMarker(attemptController.signal);
      return normalizedFailure(
        marker === undefined
          ? createExecutionError({
              code: "invalid_response",
              category: "provider",
              stage: "submit",
              safeMessage: "The provider request failed before response headers were available.",
              mayHaveBilled: true,
              details: { reason: "network-failure" }
            })
          : abortError(marker, providerRequestStarted)
      );
    }
    clearTimeout(headerTimer);
    headerTimer = undefined;
    bodyTimer = setTimeout(
      () => attemptController.abort({ kind: "timeout", stage: "stream" } satisfies AbortMarker),
      provider.deadlines.bodyMs
    );
    const wrapped = wrapResponseBody(response, attemptController.signal, () => {
      if (bodyTimer !== undefined) clearTimeout(bodyTimer);
      bodyTimer = undefined;
    });
    const normalizedResponse = await parseProviderResponse(wrapped, {
      requestId,
      route: prepared.route,
      inputs: prepared.inputs,
      fetch: provider.fetch,
      authorization: `Bearer ${provider.apiKey}`,
      ...(dependencies.explicitSameOriginDownloadAuthorization === undefined
        ? {}
        : {
            explicitSameOriginAuthorization:
              dependencies.explicitSameOriginDownloadAuthorization
          }),
      ...(dependencies.maximumImageBytes === undefined
        ? {}
        : { maximumImageBytes: dependencies.maximumImageBytes }),
      downloadTimeoutMs: provider.deadlines.downloadMs,
      signal: attemptController.signal,
      now: () => new Date(provider.now?.() ?? Date.now()),
      onPartialArtifact: async (artifact) => {
        const mapped = slotOffset === undefined
          ? artifact
          : imageArtifactSchema.parse({ ...artifact, slot: slotOffset });
        await events.emit({ type: "partial", artifact: mapped });
      }
    });
    const marker = abortMarker(attemptController.signal);
    return marker === undefined
      ? normalizedResponse
      : normalizedAbort(normalizedResponse, marker, providerRequestStarted);
  } finally {
    if (headerTimer !== undefined) clearTimeout(headerTimer);
    if (bodyTimer !== undefined) clearTimeout(bodyTimer);
    unlink();
  }
}

async function submitOnce(
  prepared: PreparedProviderRequest,
  provider: ProviderRuntimeContext,
  requestId: string,
  operationSignal: AbortSignal,
  dependencies: ImageExecutionDependencies,
  events: ExecutionEvents,
  slotOffset?: number
): Promise<SubmissionResult> {
  if (operationSignal.aborted) {
    return {
      normalized: normalizedFailure(
        abortError(
          abortMarker(operationSignal) ?? { kind: "cancelled", stage: "complete" },
          false
        )
      ),
      attemptCount: 0,
      providerRequestCount: 0
    };
  }
  const normalized = await submitAttempt(
    prepared,
    provider,
    requestId,
    operationSignal,
    dependencies,
    events,
    slotOffset
  );
  return { normalized, attemptCount: 1, providerRequestCount: 1 };
}

function remapArtifact(artifact: ImageArtifact, slot: number): ImageArtifact {
  return imageArtifactSchema.parse({ ...artifact, slot });
}

function remapError(error: RoutegoServiceError, slot: number): RoutegoServiceError {
  return routegoServiceErrorSchema.parse({
    ...error,
    partialArtifacts: error.partialArtifacts.map((artifact) => remapArtifact(artifact, slot))
  });
}

function collectSubmission(
  collection: VariantCollection,
  submission: SubmissionResult,
  slot: number | undefined
): void {
  const mappedFinal = slot === undefined
    ? [...submission.normalized.finalArtifacts]
    : submission.normalized.finalArtifacts.map((artifact) => remapArtifact(artifact, slot));
  const mappedPartial = slot === undefined
    ? [...submission.normalized.partialArtifacts]
    : submission.normalized.partialArtifacts.map((artifact) => remapArtifact(artifact, slot));
  collection.finalArtifacts.push(...mappedFinal);
  collection.partialArtifacts.push(...mappedPartial);
  collection.relationships.push(...submission.normalized.relationships);
  collection.providerImageIds.push(...submission.normalized.providerImageIds);
  if (submission.normalized.providerResponseId !== undefined) {
    collection.providerResponseIds.push(submission.normalized.providerResponseId);
  }
  collection.attemptCount += submission.attemptCount;
  collection.providerRequestCount += submission.providerRequestCount;
  collection.receivedAnyOutput ||= submission.normalized.receivedAnyOutput;
  collection.mayHaveBilled ||= submission.normalized.mayHaveBilled;
  if (submission.normalized.error !== undefined) {
    const error = slot === undefined
      ? submission.normalized.error
      : remapError(submission.normalized.error, slot);
    collection.errors.push(error);
    if (slot !== undefined) {
      collection.failedSlots.push(failedOutputSlotSchema.parse({ slot, error }));
    }
  }
}

function emptyCollection(): VariantCollection {
  return {
    finalArtifacts: [],
    partialArtifacts: [],
    relationships: [],
    failedSlots: [],
    errors: [],
    providerImageIds: [],
    providerResponseIds: [],
    attemptCount: 0,
    providerRequestCount: 0,
    receivedAnyOutput: false,
    mayHaveBilled: false
  };
}

function missingOutputError(receivedAnyOutput: boolean): RoutegoServiceError {
  return createExecutionError({
    code: "invalid_response",
    category: "protocol",
    stage: "complete",
    safeMessage: "The provider returned fewer final images than requested.",
    receivedAnyOutput,
    mayHaveBilled: true,
    details: { reason: "missing-output-slot" }
  });
}

function finalizeCollection(
  collection: VariantCollection,
  variantCount: number,
  mode: VariantExecutionMode
): void {
  const slotCounts = new Map<number, number>();
  for (const artifact of collection.finalArtifacts) {
    slotCounts.set(artifact.slot, (slotCounts.get(artifact.slot) ?? 0) + 1);
  }
  const hasUnexpectedOutput = [...slotCounts].some(
    ([slot, count]) => slot < 0 || slot >= variantCount || count !== 1
  );
  if (hasUnexpectedOutput) {
    const error = createExecutionError({
      code: "invalid_response",
      category: "protocol",
      stage: "complete",
      safeMessage: "The provider returned duplicate or out-of-range output slots.",
      receivedAnyOutput: true,
      mayHaveBilled: true,
      details: { reason: "invalid-output-slots" }
    });
    collection.errors.push(error);
    collection.receivedAnyOutput = true;
    collection.mayHaveBilled = true;
  }
  const finalSlots = new Set(collection.finalArtifacts.map((artifact) => artifact.slot));
  if (mode === "fan-out") {
    for (let slot = 0; slot < variantCount; slot += 1) {
      if (!finalSlots.has(slot) && !collection.failedSlots.some((item) => item.slot === slot)) {
        const error = missingOutputError(collection.receivedAnyOutput);
        collection.errors.push(error);
        collection.failedSlots.push(failedOutputSlotSchema.parse({ slot, error }));
      }
    }
    return;
  }
  for (let slot = 0; slot < variantCount; slot += 1) {
    if (!finalSlots.has(slot)) {
      const error = collection.errors[0] ?? missingOutputError(collection.receivedAnyOutput);
      if (!collection.failedSlots.some((item) => item.slot === slot)) {
        collection.failedSlots.push(failedOutputSlotSchema.parse({ slot, error }));
      }
      if (collection.errors.length === 0) collection.errors.push(error);
    }
  }
}

function resultStatus(collection: VariantCollection, variantCount: number): ImageOperationResult["status"] {
  const finalSlots = new Set(collection.finalArtifacts.map((artifact) => artifact.slot));
  if (finalSlots.size === variantCount && collection.errors.length === 0) return "succeeded";
  if (collection.finalArtifacts.length > 0 || collection.partialArtifacts.length > 0) return "partial";
  return collection.errors.some((error) => error.code === "cancelled") ? "cancelled" : "failed";
}

function buildResult(
  requestId: string,
  plan: ExecutionPlan,
  collection: VariantCollection,
  route: SelectedProviderRoute | undefined
): ImageOperationResult {
  collection.relationships = collection.relationships.map((relationship, order) =>
    imageRelationshipSchema.parse({ ...relationship, order })
  );
  const status = resultStatus(collection, plan.request.count);
  const providerResponseIds = [...new Set(collection.providerResponseIds)];
  const topError = status === "succeeded" ? undefined : collection.errors[0];
  return imageOperationResultSchema.parse({
    schemaVersion: 1,
    requestId,
    status,
    requestedParams: plan.request,
    effectiveParams: plan.effectiveRequest,
    execution: {
      ...(route === undefined ? {} : { transport: route.transport }),
      attemptCount: collection.attemptCount,
      providerRequestCount: collection.providerRequestCount,
      receivedAnyOutput: collection.receivedAnyOutput,
      mayHaveBilled: collection.mayHaveBilled,
      degradedContinuation: false,
      ...(providerResponseIds.length === 1 ? { providerResponseId: providerResponseIds[0] } : {}),
      providerImageIds: [...new Set(collection.providerImageIds)].slice(0, 16)
    },
    finalArtifacts: collection.finalArtifacts.slice(0, 4),
    partialArtifacts: collection.partialArtifacts.slice(0, 12),
    failedSlots: collection.failedSlots.slice(0, 4),
    relationships: collection.relationships.slice(0, 128),
    ...(topError === undefined ? {} : { error: topError })
  });
}

async function executePlan(
  requestId: string,
  plan: PreparedExecutionPlan,
  dependencies: ImageExecutionDependencies,
  options: ResolvedExecutionOptions,
  operationSignal: AbortSignal,
  events: ExecutionEvents
): Promise<ImageOperationResult> {
  const collection = emptyCollection();
  if (plan.mode === "fan-out") {
    for (let slot = 0; slot < plan.variantCount; slot += 1) {
      if (operationSignal.aborted) {
        const error = abortError(
          abortMarker(operationSignal) ?? { kind: "cancelled", stage: "complete" },
          collection.providerRequestCount > 0
        );
        collection.errors.push(error);
        collection.failedSlots.push(failedOutputSlotSchema.parse({ slot, error }));
        for (let pending = slot + 1; pending < plan.variantCount; pending += 1) {
          collection.failedSlots.push(failedOutputSlotSchema.parse({ error, slot: pending }));
        }
        break;
      }
      const submission = await submitOnce(
        plan.providerRequest,
        plan.provider,
        childRequestId(requestId, slot),
        operationSignal,
        dependencies,
        events,
        slot
      );
      collectSubmission(collection, submission, slot);
    }
  } else {
    const submission = await submitOnce(
      plan.providerRequest,
      plan.provider,
      requestId,
      operationSignal,
      dependencies,
      events
    );
    collectSubmission(collection, submission, undefined);
  }
  finalizeCollection(collection, plan.variantCount, plan.mode);
  const result = buildResult(requestId, plan, collection, plan.providerRequest.route);
  if (result.status === "succeeded" || (result.status === "partial" && result.finalArtifacts.length > 0)) {
    await events.emit({ type: "completed", artifactIds: result.finalArtifacts.map((artifact) => artifact.id) });
  } else {
    await events.emit({
      type: "failed",
      code: result.error?.code ?? "invalid_response",
      safeMessage: result.error?.safeMessage ?? "The image operation did not produce a final image.",
      receivedAnyOutput: result.execution.receivedAnyOutput,
      mayHaveBilled: result.execution.mayHaveBilled
    });
  }
  return result;
}

export function createResolvedImageExecutor(
  dependencies: ImageExecutionDependencies
): ResolvedImageExecutor {
  return {
    async execute(requestInput, options = {}) {
      const request = imageOperationRequestSchema.parse(requestInput);
      const requestId = safeRequestId(dependencies.createRequestId?.() ?? randomUUID());
      let provider: ProviderRuntimeContext;
      try {
        provider = await providerContextFor(dependencies, request);
      } catch {
        const events = new ExecutionEvents(
          requestId,
          options.onEvent ?? dependencies.onEvent,
          Date.now
        );
        await events.emit({ type: "started" });
        const error = createExecutionError({
          code: "config_missing",
          category: "configuration",
          stage: "configure",
          safeMessage: "The active provider context is unavailable."
        });
        const plan: UnavailableExecutionPlan = {
          prepared: false,
          request,
          effectiveRequest: request,
          error
        };
        const collection = emptyCollection();
        collection.errors.push(error);
        collection.failedSlots.push(failedOutputSlotSchema.parse({ slot: 0, error }));
        const result = buildResult(requestId, plan, collection, undefined);
        await events.emit({
          type: "failed",
          code: error.code,
          safeMessage: error.safeMessage,
          receivedAnyOutput: false,
          mayHaveBilled: false
        });
        return result;
      }
      const events = new ExecutionEvents(
        requestId,
        options.onEvent ?? dependencies.onEvent,
        provider.now ?? Date.now
      );
      await events.emit({ type: "started" });
      const operationController = new AbortController();
      const unlinkCaller = linkAbort(options.signal, operationController, {
        kind: "cancelled",
        stage: "complete"
      });
      const totalTimer = setTimeout(
        () => operationController.abort({ kind: "timeout", stage: "complete" } satisfies AbortMarker),
        provider.deadlines.totalMs
      );
      try {
        const plan = await prepareExecutionPlan(dependencies, request, provider);
        if (!plan.prepared) {
          const collection = emptyCollection();
          collection.errors.push(plan.error);
          collection.failedSlots.push(failedOutputSlotSchema.parse({ slot: 0, error: plan.error }));
          const result = buildResult(requestId, plan, collection, undefined);
          await events.emit({
            type: "failed",
            code: plan.error.code,
            safeMessage: plan.error.safeMessage,
            receivedAnyOutput: false,
            mayHaveBilled: plan.error.mayHaveBilled
          });
          return result;
        }
        return await executePlan(
          requestId,
          plan,
          dependencies,
          options,
          operationController.signal,
          events
        );
      } finally {
        clearTimeout(totalTimer);
        unlinkCaller();
      }
    }
  };
}
