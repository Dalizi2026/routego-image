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

  it("bridges folder create and rename while every other public route stays unavailable", async () => {
    const baseUrl = await startBridge();
    const gateway = new HttpStudioGateway({
      baseUrl,
      session: new InMemoryStudioSession(SESSION_TOKEN)
    });

    await expect(
      gateway.invoke("manageLibrary", { action: "create-folder", name: "Archive" })
    ).resolves.toMatchObject({ action: "create-folder", affectedFolderIds: ["mock-folder"] });
    await expect(
      gateway.invoke("manageLibrary", {
        action: "rename-folder",
        folderId: "mock-folder-current",
        name: "Finals"
      })
    ).resolves.toMatchObject({
      action: "rename-folder",
      affectedFolderIds: ["mock-folder-current"]
    });

    const blockedManage = await fetch(`${baseUrl}/api/v1/library/manage`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [STUDIO_SESSION_HEADER]: SESSION_TOKEN
      },
      body: JSON.stringify({ action: "soft-delete", assetIds: ["mock-asset-output"] })
    });
    expect(blockedManage.status).toBe(400);

    for (const path of [
      "/api/v1/generate",
      "/api/v1/edit",
      "/api/v1/batch",
      "/api/v1/library/search",
      "/api/v1/studio/open"
    ]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [STUDIO_SESSION_HEADER]: SESSION_TOKEN
        },
        body: "{}"
      });
      expect(response.status).toBe(404);
    }
  });

  it("uploads and consumes one ZIP import and downloads a protected ZIP export", async () => {
    const baseUrl = await startBridge();
    const gateway = new HttpStudioGateway({
      baseUrl,
      session: new InMemoryStudioSession(SESSION_TOKEN)
    });
    const reserved = await gateway.invoke("reserveUploadResource", {
      purpose: "zip-import",
      declaredMimeType: "application/zip",
      declaredByteLength: 256
    });
    if (reserved.resource === undefined) throw new Error("expected ZIP reservation");
    await gateway.uploadBinary(
      reserved.resource,
      new Blob([new Uint8Array(256)], { type: "application/zip" })
    );
    const finalized = await gateway.invoke("finalizeUploadResource", {
      uploadResourceId: reserved.resource.uploadResourceId
    });
    expect(finalized).toMatchObject({ status: "succeeded", resource: { status: "finalized" } });

    const importPreflight = await gateway.invoke("preflightLibraryMutation", {
      mutation: {
        action: "import-zip",
        uploadResourceId: reserved.resource.uploadResourceId
      }
    });
    expect(importPreflight).toMatchObject({
      status: "ready",
      requiredConfirmations: ["zip-import"]
    });
    const imported = await gateway.invoke("executeLibraryMutation", {
      preflightId: importPreflight.preflightId,
      action: "import-zip",
      confirmations: ["zip-import"]
    });
    expect(imported).toMatchObject({
      status: "succeeded",
      importedCount: 1,
      skippedCount: 0
    });
    expect(
      await gateway.invoke("getUploadResourceStatus", {
        uploadResourceId: reserved.resource.uploadResourceId
      })
    ).toMatchObject({ status: "succeeded", resource: { status: "consumed" } });
    expect(
      await gateway.invoke("preflightLibraryMutation", {
        mutation: {
          action: "import-zip",
          uploadResourceId: reserved.resource.uploadResourceId
        }
      })
    ).toMatchObject({ status: "blocked", items: [{ eligible: false }] });

    const exportPreflight = await gateway.invoke("preflightLibraryMutation", {
      mutation: { action: "export-zip", assetIds: ["mock-asset-output"] }
    });
    const exported = await gateway.invoke("executeLibraryMutation", {
      preflightId: exportPreflight.preflightId,
      action: "export-zip",
      confirmations: ["zip-export"]
    });
    expect(exported.outputResource).toMatchObject({
      mimeType: "application/zip",
      requiresSession: true
    });
    if (exported.outputResource === undefined) throw new Error("expected protected ZIP export");
    const zip = await gateway.fetchProtectedBlob(exported.outputResource);
    expect(zip).toMatchObject({ size: 256, type: "application/zip" });
    expect(JSON.stringify({ imported, exported })).not.toMatch(
      /(?:C:\\|\/Users\/|data:image|base64|Authorization)/u
    );
  });
});
