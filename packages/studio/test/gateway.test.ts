import { describe, expect, it, vi } from "vitest";

import {
  HttpStudioGateway,
  InMemoryStudioSession,
  StudioGatewayError,
  STUDIO_SESSION_HEADER
} from "../src/api";

const SESSION_TOKEN = "routego-studio-synthetic-session-token";

describe("contract-validating HTTP Studio gateway", () => {
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
