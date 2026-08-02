import { describe, expect, it, vi } from "vitest";

import type { SelectedProviderRoute } from "@routego-image/foundation";
import {
  ProviderDownloadException,
  SseDecoder,
  decodeProviderImageBase64,
  downloadProviderImage,
  normalizeImagesJsonResponse,
  normalizeResponsesJsonResponse,
  normalizeResponsesSseResponse,
  parseProviderResponse,
  parseSseJson,
  redactNormalizedProviderResponse,
  type PreparedImageInputs,
  type ProviderResponseParseContext
} from "../src/provider/index";

const PROVIDER_ENDPOINT = "https://provider.example/v1/images/generations?tenant=synthetic";
const RESPONSES_ENDPOINT = "https://provider.example/v1/responses";
const ROUTE_A: SelectedProviderRoute = {
  selected: true,
  tier: "A",
  transport: "single-endpoint-json",
  endpoint: PROVIDER_ENDPOINT,
  requestShape: "single-endpoint-json:text",
  effectiveKind: "generate",
  requiredCapabilities: ["text-generation"],
  degraded: false,
  replayPolicy: "never-cross-transport"
};
const ROUTE_C: SelectedProviderRoute = {
  selected: true,
  tier: "C",
  transport: "openai-responses",
  endpoint: RESPONSES_ENDPOINT,
  requestShape: "openai-responses:image-generation",
  effectiveKind: "generate",
  requiredCapabilities: ["text-generation"],
  degraded: false,
  replayPolicy: "never-cross-transport"
};

function uint32Be(value: number): Buffer {
  const output = Buffer.alloc(4);
  output.writeUInt32BE(value);
  return output;
}

function uint32Le(value: number): Buffer {
  const output = Buffer.alloc(4);
  output.writeUInt32LE(value);
  return output;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  return Buffer.concat([
    uint32Be(data.byteLength),
    Buffer.from(type, "ascii"),
    Buffer.from(data),
    Buffer.alloc(4)
  ]);
}

function syntheticPng(width = 1, height = 1): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function syntheticJpeg(width = 2, height = 1): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xd9
  ]);
}

function syntheticWebp(width = 3, height = 2): Buffer {
  const data = Buffer.alloc(10);
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  const chunk = Buffer.concat([Buffer.from("VP8X", "ascii"), uint32Le(data.length), data]);
  return Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    uint32Le(4 + chunk.length),
    Buffer.from("WEBP", "ascii"),
    chunk
  ]);
}

const PNG_BASE64 = syntheticPng().toString("base64");
const JPEG_BASE64 = syntheticJpeg().toString("base64");
const WEBP_BASE64 = syntheticWebp().toString("base64");

function context(
  route: SelectedProviderRoute = ROUTE_A,
  overrides: Partial<ProviderResponseParseContext> = {}
): ProviderResponseParseContext {
  return {
    requestId: "request-provider-response",
    route,
    now: () => new Date("2026-07-18T09:00:00.000Z"),
    ...overrides
  };
}

function byteStream(parts: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(typeof part === "string" ? encoder.encode(part) : part);
      }
      controller.close();
    }
  });
}

function sse(event: string, data: unknown, newline = "\n"): string {
  return `event: ${event}${newline}data: ${JSON.stringify(data)}${newline}${newline}`;
}

describe("bounded Base64 and synchronous provider response normalization", () => {
  it("adds only safe Windows response metadata when a success body cannot be parsed", async () => {
    const priorTarget = process.env["ROUTEGO_PACKAGE_TARGET"];
    try {
      process.env["ROUTEGO_PACKAGE_TARGET"] = "windows";
      const result = await parseProviderResponse(
        new Response(Uint8Array.from([0xff, 0xfe, 0xfd]), {
          status: 200,
          headers: {
            "content-type": "text/html; charset=gbk",
            "content-encoding": "identity",
            "content-length": "3"
          }
        }),
        context()
      );
      expect(result.error).toMatchObject({
        code: "invalid_response",
        details: {
          responseContentType: "text/html; charset=gbk",
          responseContentEncoding: "identity",
          responseContentLength: 3,
          responseParser: "strict-utf8-json"
        }
      });
      expect(JSON.stringify(result.error?.details)).not.toContain("provider.example");
    } finally {
      if (priorTarget === undefined) delete process.env["ROUTEGO_PACKAGE_TARGET"];
      else process.env["ROUTEGO_PACKAGE_TARGET"] = priorTarget;
    }
  });

  it("keeps Mac response parse diagnostics at the established minimal shape", async () => {
    const priorTarget = process.env["ROUTEGO_PACKAGE_TARGET"];
    try {
      delete process.env["ROUTEGO_PACKAGE_TARGET"];
      const result = await parseProviderResponse(
        new Response(Uint8Array.from([0xff, 0xfe, 0xfd]), { status: 200 }),
        context()
      );
      expect(result.error).toMatchObject({
        code: "invalid_response",
        details: { reason: expect.any(String) }
      });
      expect(result.error?.details).not.toHaveProperty("responseContentType");
    } finally {
      if (priorTarget === undefined) delete process.env["ROUTEGO_PACKAGE_TARGET"];
      else process.env["ROUTEGO_PACKAGE_TARGET"] = priorTarget;
    }
  });

  it("detects PNG, JPEG, and WebP bytes rather than trusting the requested format", async () => {
    const inputBytes = new Uint8Array(syntheticPng());
    const inputs: PreparedImageInputs = {
      images: [
        {
          slot: 0,
          kind: "reference",
          role: "style",
          sourceIndex: 0,
          path: "synthetic-reference.png",
          fileName: "reference-0.png",
          byteLength: inputBytes.byteLength,
          bytes: inputBytes,
          mimeType: "image/png",
          width: 1,
          height: 1,
          hasAlpha: true,
          id: "reference-1"
        }
      ],
      totalBytes: inputBytes.byteLength
    };
    const result = await normalizeImagesJsonResponse(
      {
        data: [
          { id: "provider-image-0", b64_json: PNG_BASE64, revised_prompt: "revised one" },
          { id: "provider-image-1", b64_json: JPEG_BASE64 },
          { id: "provider-image-2", b64_json: WEBP_BASE64 }
        ]
      },
      context(ROUTE_A, { inputs })
    );
    expect(result.error).toBeUndefined();
    expect(result.finalArtifacts.map(({ slot, mimeType, width, height }) => ({ slot, mimeType, width, height }))).toEqual([
      { slot: 0, mimeType: "image/png", width: 1, height: 1 },
      { slot: 1, mimeType: "image/jpeg", width: 2, height: 1 },
      { slot: 2, mimeType: "image/webp", width: 3, height: 2 }
    ]);
    expect(result.providerImageIds).toEqual([
      "provider-image-0",
      "provider-image-1",
      "provider-image-2"
    ]);
    expect(result.revisedPrompts).toEqual(["revised one"]);
    expect(result.receivedAnyOutput).toBe(true);
    expect(result.mayHaveBilled).toBe(true);
    expect(result.relationships.map((item) => item.inputRole)).toEqual([
      "reference",
      "output",
      "reference",
      "output",
      "reference",
      "output"
    ]);
    expect(result.relationships[0]).toMatchObject({
      inputId: "reference-1",
      outputArtifactId: result.finalArtifacts[0]?.id
    });
  });

  it("rejects malformed, oversized, MIME-mismatched, empty, or ambiguous success payloads", async () => {
    expect(() => decodeProviderImageBase64("%%%not-base64%%%")) .toThrow();
    expect(() => decodeProviderImageBase64(PNG_BASE64, 8)).toThrow(/oversize/u);
    expect(() => decodeProviderImageBase64(`data:image/jpeg;base64,${PNG_BASE64}`)).toThrow(/mime/u);

    for (const body of [
      { data: [] },
      { data: [{}] },
      { data: [{ b64_json: PNG_BASE64, url: "https://cdn.example/image.png" }] },
      { data: [{ b64_json: "invalid" }] }
    ]) {
      const result = await normalizeImagesJsonResponse(body, context());
      expect(result.error).toMatchObject({
        code: "invalid_response",
        retryDisposition: "never",
        receivedAnyOutput: false,
        mayHaveBilled: true
      });
      expect(result.finalArtifacts).toEqual([]);
    }
  });

  it("accepts a provider's duplicate inline image URL while preferring its Base64 result", async () => {
    const duplicate = await normalizeImagesJsonResponse(
      { data: [{ b64_json: PNG_BASE64, url: `data:image/png;base64,${PNG_BASE64}` }] },
      context()
    );
    expect(duplicate.error).toBeUndefined();
    expect(duplicate.finalArtifacts).toHaveLength(1);

    const inlineOnly = await normalizeImagesJsonResponse(
      { data: [{ url: `data:image/png;base64,${PNG_BASE64}` }] },
      context()
    );
    expect(inlineOnly.error).toBeUndefined();
    expect(inlineOnly.finalArtifacts).toHaveLength(1);
  });

  it("normalizes completed and failed Responses JSON while preserving partial output and identifiers", async () => {
    const completed = await normalizeResponsesJsonResponse(
      {
        id: "response-1",
        status: "completed",
        output: [
          {
            type: "image_generation_call",
            id: "image-call-1",
            status: "completed",
            result: PNG_BASE64
          }
        ]
      },
      context(ROUTE_C)
    );
    expect(completed).toMatchObject({
      providerResponseId: "response-1",
      providerImageIds: ["image-call-1"],
      receivedAnyOutput: true,
      mayHaveBilled: true
    });
    expect(completed.finalArtifacts).toHaveLength(1);

    const partial = await normalizeResponsesJsonResponse(
      {
        id: "response-2",
        status: "failed",
        output: [
          {
            type: "image_generation_call",
            id: "image-call-2",
            status: "in_progress",
            result: JPEG_BASE64
          }
        ],
        error: { code: "provider_partial_failure", message: "Failed after output." }
      },
      context(ROUTE_C)
    );
    expect(partial.finalArtifacts).toEqual([]);
    expect(partial.partialArtifacts).toHaveLength(1);
    expect(partial.error).toMatchObject({
      code: "invalid_response",
      retryDisposition: "never",
      receivedAnyOutput: true,
      mayHaveBilled: true
    });

    const falseSuccess = await normalizeResponsesJsonResponse(
      { id: "response-empty", status: "completed", output: [] },
      context(ROUTE_C)
    );
    expect(falseSuccess.error?.code).toBe("invalid_response");
  });
});

describe("safe result URL downloads and redirect authorization", () => {
  it("upgrades a same-authority provider result URL to HTTPS before downloading", async () => {
    const observed: Array<{ url: string; authorization: string | null }> = [];
    const downloaded = await downloadProviderImage(
      "http://provider.example:8443/results/generated.png",
      {
        fetch: async (input, init) => {
          observed.push({
            url: String(input),
            authorization: new Headers(init?.headers).get("authorization")
          });
          return new Response(new Uint8Array(syntheticPng()), {
            headers: { "content-type": "image/png" }
          });
        },
        providerEndpoint: "https://provider.example:8443/v1/images/generations",
        authorization: "Bearer synthetic-token",
        explicitSameOriginAuthorization: true
      }
    );

    expect(observed).toEqual([{
      url: "https://provider.example:8443/results/generated.png",
      authorization: "Bearer synthetic-token"
    }]);
    expect(downloaded).toMatchObject({ mimeType: "image/png", width: 1, height: 1 });
  });

  it("upgrades a cross-origin result URL to HTTPS without forwarding authorization", async () => {
    const observed: Array<{ url: string; authorization: string | null }> = [];
    await downloadProviderImage("http://images.example/generated.png", {
      fetch: async (input, init) => {
        observed.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization")
        });
        return new Response(new Uint8Array(syntheticPng()), {
          headers: { "content-type": "image/png" }
        });
      },
      providerEndpoint: PROVIDER_ENDPOINT,
      authorization: "Bearer synthetic-token",
      explicitSameOriginAuthorization: true
    });

    expect(observed).toEqual([{
      url: "https://images.example/generated.png",
      authorization: null
    }]);
  });

  it("falls back to cleartext once after HTTPS fails and never forwards authorization", async () => {
    const observed: Array<{ url: string; authorization: string | null }> = [];
    const downloaded = await downloadProviderImage("http://images.example/generated.png", {
      fetch: async (input, init) => {
        const observation = {
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization")
        };
        observed.push(observation);
        if (observation.url.startsWith("https:")) throw new TypeError("synthetic TLS failure");
        return new Response(new Uint8Array(syntheticPng()), {
          headers: { "content-type": "image/png" }
        });
      },
      providerEndpoint: PROVIDER_ENDPOINT,
      authorization: "Bearer synthetic-token",
      explicitSameOriginAuthorization: true
    });

    expect(observed).toEqual([
      { url: "https://images.example/generated.png", authorization: null },
      { url: "http://images.example/generated.png", authorization: null }
    ]);
    expect(downloaded).toMatchObject({ mimeType: "image/png", width: 1, height: 1 });
  });

  it("falls back to the original cleartext result when the HTTPS body cannot be read", async () => {
    const observed: Array<{ url: string; authorization: string | null }> = [];
    const downloaded = await downloadProviderImage("http://images.example/generated.png", {
      fetch: async (input, init) => {
        const observation = {
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization")
        };
        observed.push(observation);
        if (observation.url.startsWith("https:")) {
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new TypeError("synthetic HTTPS body decoding failure"));
            }
          }), { headers: { "content-type": "image/png" } });
        }
        return new Response(new Uint8Array(syntheticPng()), {
          headers: { "content-type": "image/png" }
        });
      },
      providerEndpoint: PROVIDER_ENDPOINT,
      authorization: "Bearer synthetic-token",
      explicitSameOriginAuthorization: true
    });

    expect(observed).toEqual([
      { url: "https://images.example/generated.png", authorization: null },
      { url: "http://images.example/generated.png", authorization: null }
    ]);
    expect(downloaded).toMatchObject({ mimeType: "image/png", width: 1, height: 1 });
  });

  it("omits authorization cross-origin and forwards it only for explicit same-origin policy", async () => {
    const observed: Array<{ url: string; authorization: string | null; accept: string | null }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      observed.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        accept: new Headers(init?.headers).get("accept")
      });
      return new Response(new Uint8Array(syntheticPng()), { headers: { "content-type": "image/png" } });
    };

    await downloadProviderImage("https://cdn.example/image.png", {
      fetch: fetchMock,
      providerEndpoint: PROVIDER_ENDPOINT,
      authorization: "Bearer synthetic-token",
      explicitSameOriginAuthorization: true
    });
    await downloadProviderImage("https://provider.example/result.png", {
      fetch: fetchMock,
      providerEndpoint: PROVIDER_ENDPOINT,
      authorization: "Bearer synthetic-token",
      explicitSameOriginAuthorization: true
    });
    expect(observed).toEqual([
      { url: "https://cdn.example/image.png", authorization: null, accept: "*/*" },
      { url: "https://provider.example/result.png", authorization: "Bearer synthetic-token", accept: "*/*" }
    ]);
  });

  it("revalidates every redirect and strips authorization when the origin changes", async () => {
    const observed: Array<{ url: string; authorization: string | null }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      observed.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return url.includes("provider.example")
        ? new Response(null, {
            status: 302,
            headers: { location: "https://cdn.example/final.jpg" }
          })
        : new Response(new Uint8Array(syntheticJpeg()), { headers: { "content-type": "image/jpeg" } });
    };
    const result = await downloadProviderImage("https://provider.example/start", {
      fetch: fetchMock,
      providerEndpoint: PROVIDER_ENDPOINT,
      authorization: "Bearer synthetic-token",
      explicitSameOriginAuthorization: true
    });
    expect(result).toMatchObject({ mimeType: "image/jpeg", redirectCount: 1 });
    expect(observed).toEqual([
      { url: "https://provider.example/start", authorization: "Bearer synthetic-token" },
      { url: "https://cdn.example/final.jpg", authorization: null }
    ]);
  });

  it("rejects unsupported protocols, MIME mismatch, and byte limits without leaking target URLs", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(new Uint8Array(syntheticPng()), {
        headers: { "content-type": "image/jpeg", "content-length": "999" }
      })
    );
    await expect(
      downloadProviderImage("ftp://unsafe.example/image.png", {
        fetch: fetchMock,
        providerEndpoint: PROVIDER_ENDPOINT
      })
    ).rejects.toMatchObject({ error: { code: "download_failed", details: { reason: "unsupported-protocol" } } });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      downloadProviderImage("https://cdn.example/image.png", {
        fetch: fetchMock,
        providerEndpoint: PROVIDER_ENDPOINT,
        maximumBytes: 100
      })
    ).rejects.toBeInstanceOf(ProviderDownloadException);
    const sniffedRaster = await downloadProviderImage("https://cdn.example/mismatch.png", {
      fetch: async () =>
        new Response(new Uint8Array(syntheticPng()), {
          headers: { "content-type": "image/jpeg" }
        }),
      providerEndpoint: PROVIDER_ENDPOINT
    });
    expect(sniffedRaster).toMatchObject({ mimeType: "image/png", width: 1, height: 1 });
    await expect(
      downloadProviderImage("https://cdn.example/not-an-image-header.png", {
        fetch: async () =>
          new Response(new Uint8Array(syntheticPng()), {
            headers: { "content-type": "text/html" }
          }),
        providerEndpoint: PROVIDER_ENDPOINT
      })
    ).rejects.toMatchObject({ error: { code: "download_failed", details: { reason: "mime-mismatch" } } });
    const rendered = JSON.stringify(
      await downloadProviderImage("https://cdn.example/image.png", {
        fetch: async () => new Response(new Uint8Array(syntheticPng()), { headers: { "content-type": "image/png" } }),
        providerEndpoint: PROVIDER_ENDPOINT
      })
    );
    expect(rendered).not.toContain("cdn.example");
  });

  it("normalizes Images URL results after safe materialization", async () => {
    const observed: string[] = [];
    const result = await normalizeImagesJsonResponse(
      { data: [{ id: "downloaded-image", url: "https://cdn.example/image.webp" }] },
      context(ROUTE_A, {
        fetch: async (input) => {
          observed.push(String(input));
          return new Response(new Uint8Array(syntheticWebp()), { headers: { "content-type": "image/webp" } });
        }
      })
    );
    expect(observed).toEqual(["https://cdn.example/image.webp"]);
    expect(result.finalArtifacts[0]).toMatchObject({
      providerImageId: "downloaded-image",
      mimeType: "image/webp"
    });
  });
});

describe("SSE framing and Responses stream normalization", () => {
  it("parses LF/CRLF, comments, multiline data, fragmented UTF-8, metadata, and DONE", () => {
    const text = [
      ": keepalive\r\n",
      "event: sample\r\n",
      "id: event-1\r\n",
      "retry: 250\r\n",
      "data: {\"message\":\"中文\"\r\n",
      "data: ,\"ok\":true}\r\n\r\n",
      "data: [DONE]\n\n"
    ].join("");
    const encoded = new TextEncoder().encode(text);
    const decoder = new SseDecoder();
    const frames = [
      ...decoder.push(encoded.subarray(0, 23)),
      ...decoder.push(encoded.subarray(23, 47)),
      ...decoder.push(encoded.subarray(47)),
      ...decoder.finish()
    ];
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ event: "sample", id: "event-1", retry: 250, done: false });
    expect(parseSseJson(frames[0]!)).toEqual({ message: "中文", ok: true });
    expect(frames[1]).toMatchObject({ data: "[DONE]", done: true });
    expect(() =>
      parseSseJson({ data: "{invalid", done: false })
    ).toThrow(/invalid JSON/u);
  });

  it("preserves partial artifacts, emits callbacks, then returns a final artifact", async () => {
    const callbacks: string[] = [];
    const stream = byteStream([
      sse("response.created", {
        type: "response.created",
        response: { id: "response-stream-1", status: "in_progress" }
      }, "\r\n"),
      sse("response.image_generation_call.partial_image", {
        type: "response.image_generation_call.partial_image",
        item_id: "image-call-stream-1",
        output_index: 0,
        partial_image_index: 0,
        partial_image_b64: JPEG_BASE64
      }),
      sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "image_generation_call",
          id: "image-call-stream-1",
          status: "completed",
          result: PNG_BASE64
        }
      }),
      sse("response.completed", {
        type: "response.completed",
        response: { id: "response-stream-1", status: "completed" }
      }),
      "data: [DONE]\n\n"
    ]);
    const result = await normalizeResponsesSseResponse(
      stream,
      context(ROUTE_C, {
        onPartialArtifact: (artifact) => {
          callbacks.push(artifact.id);
        }
      })
    );
    expect(result.error).toBeUndefined();
    expect(result.partialArtifacts).toHaveLength(1);
    expect(result.finalArtifacts).toHaveLength(1);
    expect(callbacks).toEqual([result.partialArtifacts[0]?.id]);
    expect(result.providerResponseId).toBe("response-stream-1");
  });

  it("preserves partial output and billing flags when a fragmented stream fails", async () => {
    const text =
      sse("response.image_generation_call.partial_image", {
        type: "response.image_generation_call.partial_image",
        item_id: "image-call-partial",
        output_index: 0,
        partial_image_index: 0,
        partial_image_b64: PNG_BASE64
      }) +
      sse("error", {
        type: "error",
        error: {
          code: "provider_stream_failure",
          message: "Authorization: Bearer synthetic-secret data:image/png;base64,c2VjcmV0"
        }
      }) +
      "data: [DONE]\n\n";
    const bytes = new TextEncoder().encode(text);
    const result = await normalizeResponsesSseResponse(
      byteStream([bytes.subarray(0, 17), bytes.subarray(17, 91), bytes.subarray(91)]),
      context(ROUTE_C)
    );
    expect(result.partialArtifacts).toHaveLength(1);
    expect(result.error).toMatchObject({
      retryDisposition: "never",
      receivedAnyOutput: true,
      mayHaveBilled: true
    });
    const rendered = JSON.stringify(result.error);
    expect(rendered).not.toContain("synthetic-secret");
    expect(rendered).not.toContain("c2VjcmV0");
  });
});

describe("HTTP/provider error mapping and high-level parsing", () => {
  it.each([
    [401, { error: { code: "invalid_api_key", message: "Bad key" } }, "auth_failed", "never"],
    [400, { error: { code: "content_policy_violation", message: "Moderation blocked" } }, "moderation_blocked", "never"],
    [429, { error: { code: "rate_limit", message: "Slow down" } }, "rate_limited", "user-confirmation"],
    [503, { error: { code: "unavailable", message: "Unavailable" } }, "provider_5xx", "user-confirmation"]
  ] as const)(
    "maps status %s without treating it as unsupported capability",
    async (status, body, code, retryDisposition) => {
      const result = await parseProviderResponse(
        Response.json(body, {
          status,
          headers: status === 429 ? { "retry-after": "2" } : {}
        }),
        context()
      );
      expect(result.error).toMatchObject({ code, retryDisposition });
      expect(result.error?.code).not.toBe("capability_unavailable");
    }
  );

  it("dispatches bounded JSON and SSE parsing through the selected route", async () => {
    const images = await parseProviderResponse(
      Response.json({ data: [{ b64_json: PNG_BASE64 }] }),
      context()
    );
    expect(images.finalArtifacts).toHaveLength(1);

    const responses = await parseProviderResponse(
      new Response(
        sse("response.output_item.done", {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "image_generation_call",
            id: "image-call-high-level",
            status: "completed",
            result: PNG_BASE64
          }
        }) + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream; charset=utf-8" } }
      ),
      context(ROUTE_C)
    );
    expect(responses.finalArtifacts).toHaveLength(1);
  });

  it("recursively redacts provider diagnostics without exposing image data", () => {
    const rendered = JSON.stringify(
      redactNormalizedProviderResponse({
        authorization: "Bearer synthetic-token",
        apiKey: "synthetic-api-key",
        image: `data:image/png;base64,${PNG_BASE64}`,
        bytes: syntheticPng()
      })
    );
    expect(rendered).not.toContain("synthetic-token");
    expect(rendered).not.toContain("synthetic-api-key");
    expect(rendered).not.toContain(PNG_BASE64);
    expect(rendered).toContain("[REDACTED_IMAGE_DATA]");
    expect(rendered).toContain("[REDACTED_BINARY_DATA]");
  });
});
