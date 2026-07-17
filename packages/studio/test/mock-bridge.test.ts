import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";

import {
  HttpStudioGateway,
  InMemoryStudioSession,
  STUDIO_SESSION_HEADER,
  type ObjectUrlApi
} from "../src/api";

const SESSION_TOKEN = "routego-studio-synthetic-session-token";
let server: ViteDevServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  delete process.env["ROUTEGO_STUDIO_MOCK"];
  delete process.env["ROUTEGO_STUDIO_MOCK_SESSION"];
});

async function startBridge(): Promise<string> {
  process.env["ROUTEGO_STUDIO_MOCK"] = "1";
  process.env["ROUTEGO_STUDIO_MOCK_SESSION"] = SESSION_TOKEN;
  server = await createServer({
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: false }
  });
  await server.listen();
  const address = server.httpServer?.address() as AddressInfo | null;
  if (address === null) {
    throw new Error("mock bridge did not bind");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("explicit Vite deterministic mock bridge", () => {
  it("requires the synthetic session and returns contract-valid status/settings", async () => {
    const baseUrl = await startBridge();
    expect((await fetch(`${baseUrl}/api/v1/status?schemaVersion=1`)).status).toBe(401);

    const gateway = new HttpStudioGateway({
      baseUrl,
      session: new InMemoryStudioSession(SESSION_TOKEN)
    });
    const [status, settings] = await Promise.all([
      gateway.invoke("status", {}),
      gateway.invoke("readSettings", {})
    ]);
    expect(status.service).toMatchObject({ status: "ready", studioAvailable: true });
    expect(settings.profiles).toHaveLength(1);
    expect(JSON.stringify({ status, settings })).not.toMatch(
      /(?:C:\\|\/Users\/|data:image|base64|Authorization)/u
    );
  });

  it("validates reserve, binary PUT, finalize, and protected object URLs", async () => {
    const baseUrl = await startBridge();
    const gateway = new HttpStudioGateway({
      baseUrl,
      session: new InMemoryStudioSession(SESSION_TOKEN)
    });
    const reserved = await gateway.invoke("reserveUploadResource", {
      purpose: "image",
      declaredMimeType: "image/png",
      declaredByteLength: 68
    });
    expect(reserved.status).toBe("succeeded");
    const resource = reserved.resource;
    if (resource === undefined) {
      throw new Error("expected a reserved upload resource");
    }
    await gateway.uploadBinary(resource, new Blob([new Uint8Array(68)], { type: "image/png" }));
    const finalized = await gateway.invoke("finalizeUploadResource", {
      uploadResourceId: resource.uploadResourceId
    });
    expect(finalized).toMatchObject({ status: "succeeded", resource: { status: "finalized" } });

    const lookup = await gateway.invoke("getBrowserResource", { assetId: "mock-asset-output" });
    if (lookup.resource === undefined) {
      throw new Error("expected a protected resource");
    }
    const revoked: string[] = [];
    const objectUrlApi: ObjectUrlApi = {
      createObjectURL: (blob) => `blob:synthetic/${blob.size}`,
      revokeObjectURL: (url) => revoked.push(url)
    };
    const objectUrl = await gateway.fetchProtectedObjectUrl(lookup.resource, objectUrlApi);
    expect(objectUrl).toMatchObject({ url: "blob:synthetic/68", byteLength: 68 });
    objectUrl.revoke();
    objectUrl.revoke();
    expect(revoked).toEqual(["blob:synthetic/68"]);
  });

  it("rejects invalid JSON inputs without forwarding credentials or bytes into errors", async () => {
    const baseUrl = await startBridge();
    const response = await fetch(`${baseUrl}/api/v1/uploads/reserve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [STUDIO_SESSION_HEADER]: SESSION_TOKEN
      },
      body: JSON.stringify({ purpose: "image", declaredMimeType: "image/png", rawBytes: [1, 2] })
    });
    expect(response.status).toBe(400);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain("invalid_input");
    expect(serialized).not.toContain(SESSION_TOKEN);
    expect(serialized).not.toContain("rawBytes");
  });
});
