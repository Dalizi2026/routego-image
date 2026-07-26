import {
  imageOperationRequestSchema,
  studioImageOperationRequestSchema,
  type ImageOperationRequest,
  type StudioImageOperationRequest
} from "@routego-image/contracts";
import type { RoutegoLibraryService } from "@routego-image/library";

import {
  DurableInputGraphError,
  buildDurableInputGraph,
  type DurableInputGraphPlan,
  type InputGraphIdFactory
} from "./graph";

export type StudioInputResolutionErrorCode =
  | "identity-conflict"
  | "input-limit"
  | "invalid-request"
  | "not-found"
  | "purpose-mismatch"
  | "resource-integrity"
  | "resource-unavailable";

export class StudioInputResolutionError extends Error {
  readonly code: StudioInputResolutionErrorCode;

  constructor(code: StudioInputResolutionErrorCode, message: string) {
    super(message);
    this.name = "StudioInputResolutionError";
    this.code = code;
  }
}

export interface ResolveStudioOperationInputOptions {
  /**
   * Retained at the composition boundary so callers do not need a separate
   * text-only path. Studio generation deliberately does not read it.
   */
  readonly library: Pick<RoutegoLibraryService, "resolveImageResource">;
  readonly idFactory: InputGraphIdFactory;
  readonly now?: () => Date;
}

export interface PreparedStudioOperationInput {
  readonly studioRequest: StudioImageOperationRequest;
  readonly creationRequest: ImageOperationRequest;
  readonly graph: DurableInputGraphPlan;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Studio is text-generation-only. Build an empty durable-input graph so the
 * existing result pipeline retains a stable operation identity without
 * resolving, staging, or retaining any image locator.
 */
export async function resolveStudioOperationInput(
  input: unknown,
  options: ResolveStudioOperationInputOptions
): Promise<PreparedStudioOperationInput> {
  if (options === null || typeof options !== "object" || typeof options.idFactory !== "function") {
    throw new StudioInputResolutionError(
      "invalid-request",
      "Studio input resolution requires deterministic identity allocation."
    );
  }
  const parsed = studioImageOperationRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new StudioInputResolutionError(
      "invalid-request",
      "The Studio image operation request is invalid."
    );
  }
  try {
    const graph = buildDurableInputGraph([], { idFactory: options.idFactory });
    const studioRequest = deepFreeze(parsed.data);
    const creationRequest = deepFreeze(imageOperationRequestSchema.parse({
      schemaVersion: studioRequest.schemaVersion,
      kind: "generate",
      prompt: studioRequest.prompt,
      references: [],
      size: studioRequest.size,
      aspectRatio: studioRequest.aspectRatio,
      format: studioRequest.format,
      count: studioRequest.count,
      transparentMode: studioRequest.transparentMode,
      saveToLibrary: studioRequest.saveToLibrary
    }));
    return Object.freeze({ studioRequest, creationRequest, graph });
  } catch (error) {
    if (error instanceof DurableInputGraphError) {
      throw new StudioInputResolutionError(
        error.code === "invalid-input" ? "invalid-request" : error.code,
        error.message
      );
    }
    throw error;
  }
}
