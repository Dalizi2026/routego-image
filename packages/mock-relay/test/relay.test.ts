import { describe, expect, it } from "vitest";

import { REDACTED_VALUE } from "@routego-image/foundation";
import { createMockRelay, type MockRelay } from "../src/index";

const PNG_DATA_URL = "data:image/png;base64,c3ludGhldGljLXBuZw==";
const JPEG_DATA_URL = "data:image/jpeg;base64,c3ludGhldGljLWpwZWc=";
const WEBP_DATA_URL = "data:image/webp;base64,c3ludGhldGljLXdlYnA=";

function jsonRequest(
  relay: MockRelay,
  pathname: string,
  body: unknown,
  headers: Record<string, string> = {}
) {
  return relay.handle(
    new Request(`https://mock.invalid${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body)
    })
  );
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function multipartRequest(pathname: string, form: FormData): Request {
  return new Request(`https://mock.invalid${pathname}`, { method: "POST", body: form });
}

function imageFile(name: string, type = "image/png"): Blob {
  return new Blob([`synthetic-${name}`], { type });
}

describe("single-endpoint relay modes", () => {
  it("defaults to text-only generation and leaves Edits/Responses unavailable", async () => {
    const relay = createMockRelay();
    const success = await jsonRequest(relay, "/v1/images/generations", {
      model: "gpt-image-2",
      prompt: "中文提示 🚀",
      n: 1,
      size: "1024x1024"
    });
    expect(success.status).toBe(200);
    expect(await responseJson(success)).toMatchObject({ data: [{ revised_prompt: "mock revised prompt" }] });

    const imageRejected = await jsonRequest(relay, "/v1/images/generations", {
      model: "gpt-image-2",
      prompt: "image not enabled",
      image: PNG_DATA_URL
    });
    expect(imageRejected.status).toBe(400);
    expect(await responseJson(imageRejected)).toMatchObject({
      error: { code: "unsupported_image_input" }
    });

    for (const pathname of ["/v1/images/edits", "/v1/responses", "/v1/models"]) {
      const response = await jsonRequest(relay, pathname, {});
      expect(response.status).toBe(404);
      expect(await responseJson(response)).toMatchObject({
        error: { code: "mock_route_unavailable" }
      });
    }
  });

  it("enables a single Tier A image field only when explicitly selected", async () => {
    const relay = createMockRelay({ fixture: "single-endpoint-image" });
    const response = await jsonRequest(relay, "/v1/images/generations", {
      model: "gpt-image-2",
      prompt: "single image",
      image: PNG_DATA_URL
    });
    expect(response.status).toBe(200);

    const invalidMultiple = await jsonRequest(relay, "/v1/images/generations", {
      model: "gpt-image-2",
      prompt: "multiple image field is not enabled",
      images: [PNG_DATA_URL, JPEG_DATA_URL]
    });
    expect(invalidMultiple.status).toBe(400);
    expect(await responseJson(invalidMultiple)).toMatchObject({
      error: { code: "unsupported_image_shape" }
    });
  });

  it("enables ordered images data URLs only in the explicit multi-image mode", async () => {
    const relay = createMockRelay({ fixture: "single-endpoint-images" });
    const response = await jsonRequest(relay, "/v1/images/generations", {
      model: "gpt-image-2",
      prompt: "ordered references",
      images: [PNG_DATA_URL, JPEG_DATA_URL, WEBP_DATA_URL]
    });
    expect(response.status).toBe(200);

    const shape = relay.observations[0]?.bodyShape as {
      fields: { images: { items: Array<{ mimeType: string }> } };
    };
    expect(shape.fields.images.items.map((item) => item.mimeType)).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp"
    ]);
  });

  it("returns a stable provider-shaped failure when configured", async () => {
    const relay = createMockRelay({ fixture: "single-endpoint-text", outcome: "failure" });
    const response = await jsonRequest(relay, "/v1/images/generations", {
      model: "gpt-image-2",
      prompt: "failure"
    });
    expect(response.status).toBe(500);
    expect(await responseJson(response)).toMatchObject({
      error: { code: "mock_provider_failure", type: "mock_relay_error" }
    });
  });
});

describe("standard Images relay mode", () => {
  it("supports explicit generations JSON", async () => {
    const relay = createMockRelay({ fixture: "openai-images" });
    const response = await jsonRequest(relay, "/v1/images/generations", {
      model: "gpt-image-2",
      prompt: "standard generations",
      n: 2
    });
    expect(response.status).toBe(200);
    expect(await responseJson(response)).toHaveProperty("data.0.b64_json");
  });

  it("preserves multipart target/supporting order with the mask immediately after slot zero", async () => {
    const relay = createMockRelay({ fixture: "openai-images" });
    const form = new FormData();
    form.append("model", "gpt-image-2");
    form.append("prompt", "masked edit");
    form.append("image", imageFile("target"), "target.png");
    form.append("mask", imageFile("mask"), "mask.png");
    form.append("image[]", imageFile("support-1", "image/jpeg"), "support-1.jpg");
    form.append("image[]", imageFile("support-2", "image/webp"), "support-2.webp");

    const response = await relay.handle(multipartRequest("/v1/images/edits", form));
    expect(response.status).toBe(200);
    const shape = relay.observations[0]?.bodyShape as {
      entries: Array<{ name: string; value: { type: string; mimeType?: string } }>;
    };
    expect(shape.entries.map((entry) => entry.name)).toEqual([
      "model",
      "prompt",
      "image",
      "mask",
      "image[]",
      "image[]"
    ]);
    expect(shape.entries.slice(2).map((entry) => entry.value.mimeType)).toEqual([
      "image/png",
      "image/png",
      "image/jpeg",
      "image/webp"
    ]);
  });

  it("rejects a mask before target slot zero, missing images, and ambiguous masks", async () => {
    const relay = createMockRelay({ fixture: "openai-images" });

    const before = new FormData();
    before.append("mask", imageFile("mask"), "mask.png");
    before.append("image", imageFile("target"), "target.png");
    expect((await relay.handle(multipartRequest("/v1/images/edits", before))).status).toBe(400);

    const missing = new FormData();
    missing.append("prompt", "missing image");
    const missingResponse = await relay.handle(multipartRequest("/v1/images/edits", missing));
    expect(missingResponse.status).toBe(400);
    expect(await responseJson(missingResponse)).toMatchObject({ error: { code: "image_required" } });

    const ambiguous = new FormData();
    ambiguous.append("image", imageFile("target"), "target.png");
    ambiguous.append("mask", imageFile("mask-1"), "mask-1.png");
    ambiguous.append("mask", imageFile("mask-2"), "mask-2.png");
    const ambiguousResponse = await relay.handle(
      multipartRequest("/v1/images/edits", ambiguous)
    );
    expect(ambiguousResponse.status).toBe(400);
    expect(await responseJson(ambiguousResponse)).toMatchObject({
      error: { code: "multiple_masks" }
    });
  });
});

describe("Responses JSON and SSE relay modes", () => {
  it.each([
    ["success", 200, "completed"],
    ["partial-then-failure", 200, "failed"],
    ["failure", 500, undefined]
  ] as const)("returns deterministic JSON outcome %s", async (outcome, status, responseStatus) => {
    const relay = createMockRelay({ fixture: "openai-responses-json", outcome });
    const response = await jsonRequest(relay, "/v1/responses", {
      model: "gpt-image-2",
      input: "create an image",
      tools: [{ type: "image_generation" }]
    });
    expect(response.status).toBe(status);
    const body = await responseJson(response);
    if (responseStatus === undefined) {
      expect(body).toHaveProperty("error.code", "mock_provider_failure");
    } else {
      expect(body).toHaveProperty("status", responseStatus);
      expect(body).toHaveProperty("output.0.result");
    }
  });

  it.each(["success", "partial-then-failure", "failure"] as const)(
    "returns deterministic SSE outcome %s",
    async (outcome) => {
      const relay = createMockRelay({ fixture: "openai-responses-sse", outcome });
      const response = await jsonRequest(relay, "/v1/responses", {
        model: "gpt-image-2",
        input: "stream image",
        stream: true,
        tools: [{ type: "image_generation" }]
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const body = await response.text();
      expect(body).toContain("event: response.created");
      expect(body).toContain("data: [DONE]");
      if (outcome === "success") {
        expect(body).toContain("event: response.image_generation_call.partial_image");
        expect(body).toContain("event: response.output_item.done");
        expect(body).toContain("event: response.completed");
      } else if (outcome === "partial-then-failure") {
        expect(body).toContain("event: response.image_generation_call.partial_image");
        expect(body).toContain("mock_partial_failure");
      } else {
        expect(body).not.toContain("partial_image_b64");
        expect(body).toContain("mock_provider_failure");
      }
    }
  );
});

describe("sanitized request observations", () => {
  it("retains method/path/content type and shape without credentials or image bytes", async () => {
    const relay = createMockRelay({ fixture: "single-endpoint-images" });
    await jsonRequest(
      relay,
      "/v1/images/generations",
      {
        model: "gpt-image-2",
        prompt: "secret-free observation",
        images: [PNG_DATA_URL, JPEG_DATA_URL]
      },
      {
        authorization: "Bearer synthetic-provider-token",
        cookie: "session=synthetic-cookie",
        "x-routego-session": "synthetic-session-token"
      }
    );
    const observation = relay.observations[0];
    expect(observation).toMatchObject({
      method: "POST",
      pathname: "/v1/images/generations",
      contentType: "application/json",
      headers: {
        authorization: REDACTED_VALUE,
        cookie: REDACTED_VALUE,
        "x-routego-session": REDACTED_VALUE
      }
    });
    const serialized = JSON.stringify(observation);
    expect(serialized).not.toContain("synthetic-provider-token");
    expect(serialized).not.toContain("synthetic-cookie");
    expect(serialized).not.toContain("synthetic-session-token");
    expect(serialized).not.toContain("c3ludGhldGljLXBuZw");
    expect(serialized).not.toContain("secret-free observation");

    const copy = relay.observations.map((item) => ({ pathname: item.pathname }));
    copy[0]!.pathname = "/mutated";
    expect(relay.observations[0]?.pathname).toBe("/v1/images/generations");
  });
});
