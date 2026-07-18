import { describe, expect, it, vi } from "vitest";

import { studioGenerateInputSchema } from "@routego-image/contracts";
import {
  HttpStudioGateway,
  InMemoryStudioSession,
  StudioGatewayError,
  STUDIO_SESSION_HEADER
} from "../src/api";
import { STUDIO_CREATION_STREAM_PATH } from "../src/api/sse";

const SESSION_TOKEN = "routego-studio-synthetic-session-token";

describe("contract-validating HTTP Studio gateway", () => {
  function streamResponse(text: string, contentType = "text/event-stream; charset=utf-8") {
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      }
    }), { headers: { "content-type": contentType } });
  }

  it("streams the exact route with only the in-memory session header", async () => {
    const input = studioGenerateInputSchema.parse({ kind: "generate", prompt: "stream" });
    const requestId = "gateway-stream";
    const started = {
      type: "started",
      requestId,
      sequence: 0,
      occurredAt: "2026-07-18T12:00:00.000Z",
      requestedParams: input
    };
    const failed = {
      type: "failed",
      requestId,
      sequence: 1,
      occurredAt: "2026-07-18T12:00:00.000Z",
      error: {
        code: "capability_unavailable",
        category: "capability",
        stage: "route",
        safeMessage: "The synthetic stream ended safely.",
        retryDisposition: "safe-pre-generation",
        partialArtifacts: [],
        receivedAnyOutput: false,
        mayHaveBilled: false
      },
      receivedAnyOutput: false,
      mayHaveBilled: false
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      streamResponse(
        `id: ${requestId}:0\nevent: started\ndata: ${JSON.stringify(started)}\n\n` +
          `id: ${requestId}:1\nevent: failed\ndata: ${JSON.stringify(failed)}\n\n`
      )
    );
    const gateway = new HttpStudioGateway({
      baseUrl: "http://127.0.0.1:4173",
      session: new InMemoryStudioSession(SESSION_TOKEN),
      fetch: fetchMock
    });

    const events: unknown[] = [];
    for await (const event of gateway.streamImageOperation(input)) events.push(event);

    expect(events).toEqual([started, failed]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(`http://127.0.0.1:4173${STUDIO_CREATION_STREAM_PATH}`);
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get(STUDIO_SESSION_HEADER)).toBe(SESSION_TOKEN);
    expect(headers.has("authorization")).toBe(false);
    expect(String(url)).not.toContain(SESSION_TOKEN);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("text/event-stream; charset=utf-8");
    expect(JSON.stringify(init?.body)).not.toMatch(/(?:C:\\|\/Users\/|data:image|base64)/iu);
  });

  it("validates stream input before fetch and rejects strict MIME mismatches", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const gateway = new HttpStudioGateway({
      baseUrl: "http://127.0.0.1:4173",
      session: new InMemoryStudioSession(SESSION_TOKEN),
      fetch: fetchMock
    });

    await expect(
      gateway.streamImageOperation({ prompt: "" } as never)[Symbol.asyncIterator]().next()
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(streamResponse("", "text/event-stream"));
    await expect((async () => {
      for await (const _event of gateway.streamImageOperation({ kind: "generate", prompt: "stream" })) {
        void _event;
      }
    })()).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("redacts unsafe HTTP stream error messages", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        { error: { safeMessage: "Authorization: Bearer secret at C:\\Users\\x\\image.png" } },
        { status: 502, headers: { "content-type": "application/json" } }
      )
    );
    const gateway = new HttpStudioGateway({
      baseUrl: "http://127.0.0.1:4173",
      session: new InMemoryStudioSession(SESSION_TOKEN),
      fetch: fetchMock
    });

    try {
      await (async () => {
        for await (const _event of gateway.streamImageOperation({ kind: "generate", prompt: "stream" })) {
          void _event;
        }
      })();
    } catch (error) {
      expect(String((error as Error).message)).not.toMatch(/Bearer|C:\\Users/iu);
    }
  });
  it("validates input before fetch and does not serialize rejected data", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const gateway = new HttpStudioGateway({
      baseUrl: "http://127.0.0.1:4173",
      session: new InMemoryStudioSession(SESSION_TOKEN),
      fetch: fetchMock
    });

    await expect(
      gateway.invoke("studioGenerate", { prompt: "" } as never)
    ).rejects.toMatchObject({ code: "invalid_input" } satisfies Partial<StudioGatewayError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("attaches only the local session header and rejects invalid output", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ invalid: true }, { headers: { "content-type": "application/json" } })
    );
    const gateway = new HttpStudioGateway({
      baseUrl: "http://127.0.0.1:4173",
      session: new InMemoryStudioSession(SESSION_TOKEN),
      fetch: fetchMock
    });

    await expect(gateway.invoke("readSettings", {})).rejects.toMatchObject({
      code: "invalid_output"
    } satisfies Partial<StudioGatewayError>);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).not.toContain(SESSION_TOKEN);
    const headers = new Headers(init?.headers);
    expect(headers.get(STUDIO_SESSION_HEADER)).toBe(SESSION_TOKEN);
    expect(headers.has("authorization")).toBe(false);
  });

  it("accepts only exact loopback origins", () => {
    expect(
      () =>
        new HttpStudioGateway({
          baseUrl: "https://example.invalid",
          session: new InMemoryStudioSession(SESSION_TOKEN)
        })
    ).toThrow(/loopback/u);
  });

  it("routes only folder create and rename through the public manage endpoint", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            schemaVersion: 1,
            action: "create-folder",
            affectedAssetIds: [],
            affectedFolderIds: ["folder-created"],
            warnings: []
          },
          { headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            schemaVersion: 1,
            action: "rename-folder",
            affectedAssetIds: [],
            affectedFolderIds: ["folder-created"],
            warnings: []
          },
          { headers: { "content-type": "application/json" } }
        )
      );
    const gateway = new HttpStudioGateway({
      baseUrl: "http://127.0.0.1:4173",
      session: new InMemoryStudioSession(SESSION_TOKEN),
      fetch: fetchMock
    });

    await expect(
      gateway.invoke("manageLibrary", { action: "create-folder", name: "Archive" })
    ).resolves.toMatchObject({ action: "create-folder", affectedFolderIds: ["folder-created"] });
    await expect(
      gateway.invoke("manageLibrary", {
        action: "rename-folder",
        folderId: "folder-created",
        name: "Finals"
      })
    ).resolves.toMatchObject({ action: "rename-folder", affectedFolderIds: ["folder-created"] });

    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toBe("http://127.0.0.1:4173/api/v1/library/manage");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get(STUDIO_SESSION_HEADER)).toBe(SESSION_TOKEN);
      expect(JSON.stringify(init?.body)).not.toMatch(/(?:C:\\|\/Users\/|data:image|base64)/u);
    }
  });

  it("rejects every other public operation and manage action before fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const gateway = new HttpStudioGateway({
      baseUrl: "http://127.0.0.1:4173",
      session: new InMemoryStudioSession(SESSION_TOKEN),
      fetch: fetchMock
    });

    await expect(
      gateway.invoke("manageLibrary", {
        action: "soft-delete",
        assetIds: ["asset-01"]
      } as never)
    ).rejects.toMatchObject({ code: "invalid_input" });
    for (const operation of ["generate", "edit", "batch", "searchLibrary", "openStudio"] as const) {
      await expect(gateway.invoke(operation as never, {} as never)).rejects.toMatchObject({
        code: "invalid_input"
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a manage response whose action does not match the request", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          schemaVersion: 1,
          action: "rename-folder",
          affectedAssetIds: [],
          affectedFolderIds: ["folder-created"],
          warnings: []
        },
        { headers: { "content-type": "application/json" } }
      )
    );
    const gateway = new HttpStudioGateway({
      baseUrl: "http://127.0.0.1:4173",
      session: new InMemoryStudioSession(SESSION_TOKEN),
      fetch: fetchMock
    });

    await expect(
      gateway.invoke("manageLibrary", { action: "create-folder", name: "Archive" })
    ).rejects.toMatchObject({ code: "invalid_output" });
  });
});
