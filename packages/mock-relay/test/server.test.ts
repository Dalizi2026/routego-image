import { describe, expect, it } from "vitest";

import { startMockRelayTestServer } from "../src/index";

describe("optional loopback mock relay test server", () => {
  it("starts on loopback, serves a deterministic request, and closes normally", async () => {
    const server = await startMockRelayTestServer({
      address: "127.0.0.1",
      fixture: "single-endpoint-text"
    });
    try {
      expect(server.address).toBe("127.0.0.1");
      expect(server.port).toBeGreaterThan(0);
      expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
      const response = await fetch(`${server.url}/v1/images/generations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-image-2", prompt: "loopback only" })
      });
      expect(response.status).toBe(200);
      expect(server.relay.observations).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("enforces the configured request size limit before relay processing", async () => {
    const server = await startMockRelayTestServer({
      address: "127.0.0.1",
      fixture: "single-endpoint-text",
      maxRequestBytes: 64
    });
    try {
      const response = await fetch(`${server.url}/v1/images/generations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "x".repeat(256) })
      });
      expect(response.status).toBe(413);
      expect((await response.json()) as object).toMatchObject({
        error: { code: "request_too_large" }
      });
      expect(server.relay.observations).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("rejects public bind addresses and invalid limits before listening", async () => {
    await expect(
      startMockRelayTestServer({ address: "0.0.0.0" as "127.0.0.1" })
    ).rejects.toThrow(/bind only/u);
    await expect(startMockRelayTestServer({ maxRequestBytes: 0 })).rejects.toThrow(
      /positive integer/u
    );
    await expect(startMockRelayTestServer({ port: 70_000 })).rejects.toThrow(/0 through 65535/u);
  });
});
