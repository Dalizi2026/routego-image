import { describe, expect, it, vi } from "vitest";

import {
  imageOperationRequestSchema,
  imageOperationResultSchema,
  routegoServiceErrorSchema,
  type ImageOperationRequest,
  type ImageOperationResult
} from "@routego-image/contracts";
import {
  createBatchExecutor,
  createCreationImageService,
  type ResolvedImageExecutor
} from "../src/execution/index";
import type { ProviderRuntimeContext } from "../src/provider/index";

const CREATED_AT = "2026-07-18T11:00:00.000Z";
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZVt8AAAAASUVORK5CYII=";

function operation(id: number): ImageOperationRequest {
  return imageOperationRequestSchema.parse({
    kind: "generate",
    prompt: `Batch operation ${id}`
  });
}

function error(code: "invalid_response" | "cancelled" = "invalid_response") {
  return routegoServiceErrorSchema.parse({
    code,
    category: code === "cancelled" ? "cancelled" : "protocol",
    stage: "complete",
    safeMessage: code === "cancelled" ? "Synthetic cancellation" : "Synthetic failure",
    retryDisposition: "never",
    partialArtifacts: [],
    receivedAnyOutput: false,
    mayHaveBilled: false
  });
}

function itemResult(
  request: ImageOperationRequest,
  id: number,
  status: "succeeded" | "partial" | "failed" | "cancelled",
  providerRequestCount = 1
): ImageOperationResult {
  const hasArtifact = status === "succeeded" || status === "partial";
  const itemError = status === "succeeded" ? undefined : error(status === "cancelled" ? "cancelled" : "invalid_response");
  return imageOperationResultSchema.parse({
    schemaVersion: 1,
    requestId: `item-request-${id}`,
    status,
    requestedParams: request,
    effectiveParams: request,
    execution: {
      transport: "single-endpoint-json",
      attemptCount: providerRequestCount,
      providerRequestCount,
      receivedAnyOutput: hasArtifact,
      mayHaveBilled: hasArtifact,
      degradedContinuation: false,
      providerImageIds: []
    },
    finalArtifacts: hasArtifact
      ? [
          {
            id: `artifact-${id}`,
            slot: 0,
            phase: "final",
            mimeType: "image/png",
            display: { type: "image", dataUrl: `data:image/png;base64,${PNG_BASE64}` },
            createdAt: CREATED_AT
          }
        ]
      : [],
    partialArtifacts: [],
    failedSlots: [],
    relationships: [],
    ...(itemError === undefined ? {} : { error: { ...itemError, mayHaveBilled: hasArtifact, receivedAnyOutput: hasArtifact } })
  });
}

function batchInput(count: number) {
  return {
    tasks: Array.from({ length: count }, (_, index) => ({
      id: `task-${index}`,
      operation: operation(index)
    }))
  };
}

describe("bounded ordered batch scheduling", () => {
  it("uses fixed concurrency two and preserves exact input order and identity", async () => {
    let active = 0;
    let maximumActive = 0;
    const executor: ResolvedImageExecutor = {
      async execute(request) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, request.prompt.endsWith("0") ? 15 : 2));
        active -= 1;
        const id = Number(request.prompt.split(" ").at(-1));
        return itemResult(request, id, "succeeded");
      }
    };
    const result = await createBatchExecutor({
      executor,
      createBatchRequestId: () => "batch-request-order"
    }).execute(batchInput(6));
    expect(maximumActive).toBe(2);
    expect(result.status).toBe("succeeded");
    expect(result.concurrency).toBe(2);
    expect(result.items.map((item) => item.id)).toEqual([
      "task-0",
      "task-1",
      "task-2",
      "task-3",
      "task-4",
      "task-5"
    ]);
    expect(result.items.map((item) => item.result.requestedParams.prompt)).toEqual(
      Array.from({ length: 6 }, (_, index) => `Batch operation ${index}`)
    );
  });

  it("isolates mixed success, partial, failure, and thrown item outcomes", async () => {
    const executor: ResolvedImageExecutor = {
      async execute(request) {
        const id = Number(request.prompt.split(" ").at(-1));
        if (id === 3) throw new Error("Synthetic executor exception");
        return itemResult(
          request,
          id,
          id === 0 ? "succeeded" : id === 1 ? "partial" : "failed",
          id + 1
        );
      }
    };
    const result = await createBatchExecutor({ executor }).execute(batchInput(4));
    expect(result.status).toBe("partial");
    expect(result.items.map((item) => item.result.status)).toEqual([
      "succeeded",
      "partial",
      "failed",
      "failed"
    ]);
    expect(result.items[3]?.result.error?.code).toBe("internal_contract");
    expect(result.items.map((item) => item.result.execution.providerRequestCount)).toEqual([1, 2, 3, 0]);
  });

  it("preserves completed results and cancels every pending item without starting it", async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const executor: ResolvedImageExecutor = {
      async execute(request) {
        started.push(request.prompt);
        controller.abort(new Error("cancel remaining batch"));
        return itemResult(request, 0, "succeeded");
      }
    };
    const result = await createBatchExecutor({ executor }).execute(batchInput(5), {
      signal: controller.signal
    });
    expect(started).toEqual(["Batch operation 0"]);
    expect(result.status).toBe("partial");
    expect(result.items[0]?.result.status).toBe("succeeded");
    expect(result.items.slice(1).map((item) => item.result.status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
      "cancelled"
    ]);
    expect(result.items.slice(1).every((item) => item.result.execution.providerRequestCount === 0)).toBe(true);
  });

  it("rejects caller concurrency and non-generation tasks before starting the executor", async () => {
    const executor = {
      execute: vi.fn(async (request: ImageOperationRequest) => itemResult(request, 0, "succeeded"))
    } satisfies ResolvedImageExecutor;
    const batch = createBatchExecutor({ executor });

    await expect(batch.execute({ ...batchInput(1), concurrency: 3 })).rejects.toThrow();
    await expect(
      batch.execute({
        tasks: [{ id: "edit-is-not-a-batch-operation", operation: { kind: "edit", prompt: "Removed" } }]
      })
    ).rejects.toThrow();
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("fails closed on duplicate identifiers and invalid executor output", async () => {
    const executor = {
      execute: vi.fn(async () => ({ invalid: true }) as unknown as ImageOperationResult)
    } satisfies ResolvedImageExecutor;
    const batch = createBatchExecutor({ executor });
    await expect(
      batch.execute({
        tasks: [
          { id: "duplicate", operation: operation(0) },
          { id: "duplicate", operation: operation(1) }
        ]
      })
    ).rejects.toThrow(/unique/u);

    const result = await batch.execute(batchInput(1));
    expect(result).toMatchObject({
      status: "failed",
      items: [{ id: "task-0", result: { status: "failed", error: { code: "internal_contract" } } }]
    });
  });
});

describe("public Creation batch service", () => {
  it("runs validated public batch inputs through the shared executor and reports provider counts", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [{ b64_json: PNG_BASE64 }] })
    );
    const provider: ProviderRuntimeContext = {
      providerId: "provider-a",
      model: "gpt-image-2",
      endpoints: {
        generation: { mode: "exact-generation-endpoint", value: "https://provider.example/generate" }
      },
      capabilities: [],
      apiKey: "synthetic-api-key",
      fetch: fetchMock,
      deadlines: {
        responseHeaderMs: 1_000,
        bodyMs: 1_000,
        downloadMs: 1_000,
        totalMs: 5_000
      },
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }
    };
    const service = createCreationImageService({ providerContext: provider });
    const result = await service.batch(batchInput(2));
    expect(result.status).toBe("succeeded");
    expect(result.concurrency).toBe(2);
    expect(result.items.map((item) => item.result.execution.providerRequestCount)).toEqual([1, 1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
