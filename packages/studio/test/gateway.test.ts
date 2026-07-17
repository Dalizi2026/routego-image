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
});
