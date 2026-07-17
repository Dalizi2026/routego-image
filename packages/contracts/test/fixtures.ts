import {
  imageOperationRequestSchema,
  imageOperationResultSchema,
  type ImageOperationRequest,
  type ImageOperationResult
} from "../src/index";

export const TEST_TIMESTAMP = "2026-07-17T12:34:56.000Z";
export const TEST_IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZVt8AAAAASUVORK5CYII=";

export function createGenerateRequest(
  overrides: Record<string, unknown> = {}
): ImageOperationRequest {
  return imageOperationRequestSchema.parse({
    kind: "generate",
    prompt: "生成一只戴太空头盔的猫 🚀\n保留柔和光线",
    outputDir: "C:\\Users\\测试 用户\\Pictures\\routego image",
    ...overrides
  });
}

export function createEditRequest(
  overrides: Record<string, unknown> = {}
): ImageOperationRequest {
  return imageOperationRequestSchema.parse({
    kind: "edit",
    prompt: "把天空改成日落 🌇",
    targetImage: { id: "target-0", path: "/Users/test user/图片/source image.png" },
    invariants: {
      allowedChanges: ["天空颜色"],
      preserve: ["主体与构图"],
      forbiddenChanges: ["不要修改文字\r\nKeep text unchanged"]
    },
    ...overrides
  });
}

export function createSuccessResult(
  request: ImageOperationRequest = createGenerateRequest()
): ImageOperationResult {
  return imageOperationResultSchema.parse({
    schemaVersion: 1,
    requestId: "request-success-1",
    status: "succeeded",
    requestedParams: request,
    effectiveParams: request,
    execution: {
      transport: "single-endpoint-json",
      attemptCount: 1,
      providerRequestCount: 1,
      receivedAnyOutput: true,
      mayHaveBilled: true,
      degradedContinuation: false,
      providerImageIds: []
    },
    finalArtifacts: [
      {
        id: "artifact-final-0",
        slot: 0,
        phase: "final",
        path: "/Users/test user/图片/result image.png",
        mimeType: "image/png",
        byteLength: 68,
        width: 1,
        height: 1,
        display: { type: "image", dataUrl: TEST_IMAGE_DATA_URL },
        createdAt: TEST_TIMESTAMP
      }
    ],
    partialArtifacts: [],
    failedSlots: [],
    relationships: []
  });
}
