import { createHash, randomUUID } from "node:crypto";

import {
  failedOutputSlotSchema,
  identifierSchema,
  imageOperationResultSchema,
  routegoBatchInputSchema,
  routegoBatchResultSchema,
  routegoServiceErrorSchema,
  type ImageOperationRequest,
  type ImageOperationResult,
  type RoutegoBatchInput,
  type RoutegoBatchResult,
  type RoutegoServiceError
} from "@routego-image/contracts";

import type { ResolvedImageExecutor } from "./types";

export interface BatchExecutionOptions {
  readonly signal?: AbortSignal;
}

export interface BatchExecutionDependencies {
  readonly executor: ResolvedImageExecutor;
  readonly createBatchRequestId?: () => string;
}

export interface CreationBatchExecutor {
  execute(input: unknown, options?: BatchExecutionOptions): Promise<RoutegoBatchResult>;
}

export interface CreationBatchService {
  batch(input: RoutegoBatchInput): Promise<RoutegoBatchResult>;
}

function safeRequestId(value: string): string {
  const parsed = identifierSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return `batch:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24)}`;
}

function itemRequestId(batchRequestId: string, itemId: string): string {
  return `batch-item:${createHash("sha256")
    .update(`${batchRequestId}:${itemId}`, "utf8")
    .digest("hex")
    .slice(0, 20)}`;
}

function batchError(
  code: "cancelled" | "internal_contract",
  safeMessage: string,
  reason: string
): RoutegoServiceError {
  return routegoServiceErrorSchema.parse({
    code,
    category: code === "cancelled" ? "cancelled" : "internal",
    stage: code === "cancelled" ? "complete" : "complete",
    safeMessage,
    retryDisposition: "never",
    partialArtifacts: [],
    receivedAnyOutput: false,
    mayHaveBilled: false,
    details: { reason }
  });
}

function failedItemResult(
  requestId: string,
  operation: ImageOperationRequest,
  error: RoutegoServiceError,
  status: "failed" | "cancelled"
): ImageOperationResult {
  return imageOperationResultSchema.parse({
    schemaVersion: 1,
    requestId,
    status,
    requestedParams: operation,
    effectiveParams: operation,
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
    failedSlots: [failedOutputSlotSchema.parse({ slot: 0, error })],
    relationships: [],
    error
  });
}

function cancelledItem(
  batchRequestId: string,
  itemId: string,
  operation: ImageOperationRequest
): ImageOperationResult {
  return failedItemResult(
    itemRequestId(batchRequestId, itemId),
    operation,
    batchError("cancelled", "The batch item was cancelled before it could complete.", "batch-cancelled"),
    "cancelled"
  );
}

function internalItem(
  batchRequestId: string,
  itemId: string,
  operation: ImageOperationRequest
): ImageOperationResult {
  return failedItemResult(
    itemRequestId(batchRequestId, itemId),
    operation,
    batchError(
      "internal_contract",
      "The batch item returned an invalid internal result.",
      "invalid-item-result"
    ),
    "failed"
  );
}

function overallStatus(items: readonly { readonly result: ImageOperationResult }[]): RoutegoBatchResult["status"] {
  const statuses = items.map((item) => item.result.status);
  if (statuses.every((status) => status === "succeeded")) return "succeeded";
  if (statuses.every((status) => status === "failed")) return "failed";
  if (statuses.every((status) => status === "cancelled")) return "cancelled";
  return "partial";
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function createBatchExecutor(
  dependencies: BatchExecutionDependencies
): CreationBatchExecutor {
  return {
    async execute(input, options = {}) {
      const batch = routegoBatchInputSchema.parse(input);
      const requestId = safeRequestId(dependencies.createBatchRequestId?.() ?? randomUUID());
      const results: Array<{ id: string; result: ImageOperationResult } | undefined> =
        Array.from({ length: batch.tasks.length });
      let nextIndex = 0;

      const worker = async (): Promise<void> => {
        while (true) {
          const index = nextIndex;
          nextIndex += 1;
          const item = batch.tasks[index];
          if (item === undefined) return;
          if (signalAborted(options.signal)) {
            results[index] = {
              id: item.id,
              result: cancelledItem(requestId, item.id, item.operation)
            };
            continue;
          }
          try {
            const raw = await dependencies.executor.execute(item.operation, {
              ...(options.signal === undefined ? {} : { signal: options.signal })
            });
            const parsed = imageOperationResultSchema.safeParse(raw);
            results[index] = {
              id: item.id,
              result: parsed.success
                ? parsed.data
                : internalItem(requestId, item.id, item.operation)
            };
          } catch {
            results[index] = {
              id: item.id,
              result: signalAborted(options.signal)
                ? cancelledItem(requestId, item.id, item.operation)
                : internalItem(requestId, item.id, item.operation)
            };
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(batch.concurrency, batch.tasks.length) }, () => worker())
      );
      const items = results.map((item, index) => {
        if (item !== undefined) return item;
        const source = batch.tasks[index]!;
        return {
          id: source.id,
          result: cancelledItem(requestId, source.id, source.operation)
        };
      });
      const status = overallStatus(items);
      return routegoBatchResultSchema.parse({
        schemaVersion: 1,
        requestId,
        status,
        concurrency: batch.concurrency,
        items,
        ...(status === "cancelled"
          ? {
              error: batchError(
                "cancelled",
                "The batch was cancelled before any item completed successfully.",
                "batch-cancelled"
              )
            }
          : {})
      });
    }
  };
}
