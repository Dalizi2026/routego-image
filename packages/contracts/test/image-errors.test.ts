import { describe, expect, it } from "vitest";

import {
  imageOperationRequestSchema,
  imageOperationResultSchema,
  operationExecutionMetadataSchema,
  routegoServiceErrorSchema
} from "../src/index";
import {
  createGenerateRequest,
  TEST_IMAGE_DATA_URL,
  TEST_TIMESTAMP
} from "./fixtures";

describe("image operation contracts", () => {
  it("preserves UTF-8 prompts, emoji, spaces, platform paths, and newlines", () => {
    const request = createGenerateRequest({
      references: [
        {
          id: "reference-0",
          path: "C:\\用户 甲\\图片\\参考 图.png",
          role: "style",
          label: "水墨 🎨\r\n第二行"
        },
        {
          id: "reference-1",
          path: "/Users/测试 用户/Pictures/reference image.webp",
          role: "composition",
          label: "构图\nline two"
        }
      ]
    });

    expect(request.prompt).toContain("猫 🚀\n");
    expect(request.references[0]?.path).toBe("C:\\用户 甲\\图片\\参考 图.png");
    expect(request.references[1]?.label).toBe("构图\nline two");
  });

  it("treats count as variants while batch remains a separate tool contract", () => {
    const variants = createGenerateRequest({ count: 4 });
    expect(variants.count).toBe(4);
    expect(variants).not.toHaveProperty("tasks");

    expect(imageOperationRequestSchema.safeParse({ ...variants, count: 5 }).success).toBe(false);
  });

  it.each([
    { kind: "edit", prompt: "removed edit operation" },
    { kind: "generate", prompt: "removed target", targetImage: { path: "/tmp/target.png" } },
    { kind: "generate", prompt: "mask without target", maskPath: "/tmp/mask.png" },
    { kind: "generate", prompt: "removed invariants", invariants: { preserve: ["subject"] } },
    { kind: "generate", prompt: "removed continuation", previousResponseId: "response-1" },
    { kind: "generate", prompt: "bad count", count: 0 },
    { kind: "generate", prompt: "bad compression", format: "jpeg", compression: 101 },
    { kind: "generate", prompt: "PNG compression", format: "png", compression: 50 },
    { kind: "generate", prompt: "transparent JPEG", format: "jpeg", transparentMode: "native" },
    { kind: "generate", prompt: "unknown", unexpected: true }
  ])("rejects ambiguous, bounded, or unknown request shape %#", (value) => {
    expect(imageOperationRequestSchema.safeParse(value).success).toBe(false);
  });

  it("accepts five ordered references and rejects a sixth", () => {
    const references = Array.from({ length: 5 }, (_, index) => ({
      id: `reference-${index}`,
      path: `/tmp/reference-${index}.png`,
      role: "reference" as const
    }));
    expect(
      imageOperationRequestSchema.safeParse({
        kind: "generate",
        prompt: "five references",
        references
      }).success
    ).toBe(true);
    expect(
      imageOperationRequestSchema.safeParse({
        kind: "generate",
        prompt: "too many references",
        references: [...references, { path: "/tmp/reference-5.png", role: "reference" }]
      }).success
    ).toBe(false);
  });
});

describe("result, execution, and structured error contracts", () => {
  it("records provider request counts, attempts, billing risk, and degraded continuation", () => {
    expect(
      operationExecutionMetadataSchema.parse({
        transport: "single-endpoint-json",
        attemptCount: 2,
        providerRequestCount: 2,
        receivedAnyOutput: true,
        mayHaveBilled: true,
        degradedContinuation: true,
        providerResponseId: "response-1",
        providerImageIds: ["image-1"]
      })
    ).toMatchObject({
      providerRequestCount: 2,
      receivedAnyOutput: true,
      mayHaveBilled: true,
      degradedContinuation: true
    });
  });

  it("accepts an explicit partial result with artifacts and failed slots", () => {
    const request = createGenerateRequest();
    const artifact = {
      id: "partial-artifact-0",
      slot: 0,
      phase: "partial" as const,
      mimeType: "image/png" as const,
      display: { type: "image" as const, dataUrl: TEST_IMAGE_DATA_URL },
      createdAt: TEST_TIMESTAMP
    };
    const error = {
      code: "invalid_response" as const,
      category: "protocol" as const,
      stage: "stream" as const,
      safeMessage: "The stream ended after a partial image.",
      retryDisposition: "never" as const,
      partialArtifacts: [artifact],
      receivedAnyOutput: true,
      mayHaveBilled: true
    };

    const result = imageOperationResultSchema.parse({
      schemaVersion: 1,
      requestId: "partial-request-1",
      status: "partial",
      requestedParams: request,
      effectiveParams: request,
      execution: {
        transport: "openai-responses",
        attemptCount: 1,
        providerRequestCount: 1,
        receivedAnyOutput: true,
        mayHaveBilled: true,
        providerImageIds: []
      },
      partialArtifacts: [artifact],
      finalArtifacts: [],
      failedSlots: [{ slot: 0, error }],
      relationships: [],
      error
    });

    expect(result.status).toBe("partial");
    expect(result.execution.receivedAnyOutput).toBe(true);
    expect(result.error?.retryDisposition).toBe("never");
  });

  it("prevents unsafe automatic retry metadata after output or billing risk", () => {
    expect(
      routegoServiceErrorSchema.safeParse({
        code: "rate_limited",
        category: "rate_limit",
        stage: "stream",
        safeMessage: "Rate limited after output.",
        retryDisposition: "respect-retry-after",
        partialArtifacts: [],
        receivedAnyOutput: true,
        mayHaveBilled: true
      }).success
    ).toBe(false);
  });

  it("rejects partial artifacts without output and billing flags and unknown error fields", () => {
    const invalid = {
      code: "timeout",
      category: "timeout",
      stage: "stream",
      safeMessage: "Timed out.",
      retryDisposition: "never",
      partialArtifacts: [
        {
          id: "partial-artifact-1",
          slot: 0,
          phase: "partial",
          mimeType: "image/png",
          display: { type: "image", dataUrl: TEST_IMAGE_DATA_URL },
          createdAt: TEST_TIMESTAMP
        }
      ],
      receivedAnyOutput: false,
      mayHaveBilled: false,
      rawAuthorization: "synthetic-secret"
    };
    expect(routegoServiceErrorSchema.safeParse(invalid).success).toBe(false);
  });
});
