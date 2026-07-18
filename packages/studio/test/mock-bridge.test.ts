import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import type { StudioImageOperationEvent } from "@routego-image/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";

import {
  HttpStudioGateway,
  InMemoryStudioSession,
  STUDIO_CREATION_STREAM_PATH,
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

function gateway(baseUrl: string): HttpStudioGateway {
  return new HttpStudioGateway({
    baseUrl,
    session: new InMemoryStudioSession(SESSION_TOKEN)
  });
}

async function collectStream(
  baseUrl: string,
  fixture: string,
  signal?: AbortSignal
): Promise<StudioImageOperationEvent[]> {
  const events: StudioImageOperationEvent[] = [];
  for await (const event of gateway(baseUrl).streamImageOperation(
    { kind: "generate", prompt: `mock-stream:${fixture}` },
    signal === undefined ? {} : { signal }
  )) {
    events.push(event);
  }
  return events;
}

function streamFetch(baseUrl: string, fixture: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${baseUrl}${STUDIO_CREATION_STREAM_PATH}`, {
    method: "POST",
    headers: {
      accept: "text/event-stream; charset=utf-8",
      "content-type": "application/json",
      [STUDIO_SESSION_HEADER]: SESSION_TOKEN
    },
    body: JSON.stringify({ kind: "generate", prompt: `mock-stream:${fixture}` }),
    ...(signal === undefined ? {} : { signal })
  });
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

  it("streams genuinely chunked started, partial, and completed events through the production parser", async () => {
    const baseUrl = await startBridge();
    const response = await streamFetch(baseUrl, "completed");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    if (response.body === null) throw new Error("expected a stream body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
    }
    expect(chunks.length).toBeGreaterThan(3);
    const serialized = new TextDecoder().decode(
      Uint8Array.from(chunks.flatMap((chunk) => [...chunk]))
    );
    expect(serialized).toContain("event: started");
    expect(serialized).toContain("event: partial");
    expect(serialized).toContain("event: completed");
    expect(serialized).not.toContain(SESSION_TOKEN);
    expect(serialized).not.toMatch(/(?:C:\\|\/Users\/|data:image|base64|Authorization)/u);

    const events = await collectStream(baseUrl, "completed");
    expect(events.map((event) => event.type)).toEqual(["started", "partial", "completed"]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(new Set(events.map((event) => event.requestId)).size).toBe(1);
    const terminal = events[2];
    expect(terminal?.type).toBe("completed");
    if (terminal?.type !== "completed") throw new Error("expected completed event");
    expect(terminal.result.status).toBe("succeeded");
  });

  it("authenticates the exact POST stream route before accepting JSON or invoking fixtures", async () => {
    const baseUrl = await startBridge();
    const unauthorized = await fetch(`${baseUrl}${STUDIO_CREATION_STREAM_PATH}`, {
      method: "POST",
      headers: {
        accept: "text/event-stream; charset=utf-8",
        "content-type": "application/json"
      },
      body: JSON.stringify({ kind: "generate", prompt: "mock-stream:completed" })
    });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.text()).not.toContain("event:");

    const wrongMethod = await fetch(`${baseUrl}${STUDIO_CREATION_STREAM_PATH}`, {
      method: "GET",
      headers: {
        accept: "text/event-stream; charset=utf-8",
        [STUDIO_SESSION_HEADER]: SESSION_TOKEN
      }
    });
    expect(wrongMethod.status).toBe(405);

    const wrongContentType = await fetch(`${baseUrl}${STUDIO_CREATION_STREAM_PATH}`, {
      method: "POST",
      headers: {
        accept: "text/event-stream; charset=utf-8",
        "content-type": "text/plain",
        [STUDIO_SESSION_HEADER]: SESSION_TOKEN
      },
      body: JSON.stringify({ kind: "generate", prompt: "mock-stream:completed" })
    });
    expect(wrongContentType.status).toBe(415);

    const wrongAccept = await fetch(`${baseUrl}${STUDIO_CREATION_STREAM_PATH}`, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        [STUDIO_SESSION_HEADER]: SESSION_TOKEN
      },
      body: JSON.stringify({ kind: "generate", prompt: "mock-stream:completed" })
    });
    expect(wrongAccept.status).toBe(406);

    const query = await fetch(`${baseUrl}${STUDIO_CREATION_STREAM_PATH}?token=forbidden`, {
      method: "POST",
      headers: {
        accept: "text/event-stream; charset=utf-8",
        "content-type": "application/json",
        [STUDIO_SESSION_HEADER]: SESSION_TOKEN
      },
      body: JSON.stringify({ kind: "generate", prompt: "mock-stream:completed" })
    });
    expect(query.status).toBe(400);
  });

  it("preserves a validated partial artifact and billing risk in a failed terminal stream", async () => {
    const baseUrl = await startBridge();
    const events = await collectStream(baseUrl, "failed");
    expect(events.map((event) => event.type)).toEqual(["started", "partial", "failed"]);
    const partial = events[1];
    const terminal = events[2];
    if (partial?.type !== "partial" || terminal?.type !== "failed") {
      throw new Error("expected partial then failed events");
    }
    expect(terminal).toMatchObject({ receivedAnyOutput: true, mayHaveBilled: true });
    expect(terminal.error).toMatchObject({
      retryDisposition: "never",
      receivedAnyOutput: true,
      mayHaveBilled: true
    });
    expect(terminal.error.partialArtifacts[0]?.artifactId).toBe(partial.artifact.artifactId);
  });

  it("provides deterministic full-five-minute and near-expiry descriptor fixtures", async () => {
    const baseUrl = await startBridge();
    const full = await collectStream(baseUrl, "full-expiry");
    const near = await collectStream(baseUrl, "near-expiry");
    const fullPartial = full.find((event) => event.type === "partial");
    const nearPartial = near.find((event) => event.type === "partial");
    const fullTerminal = full.find((event) => event.type === "completed");
    const nearTerminal = near.find((event) => event.type === "completed");
    expect(fullPartial?.type === "partial" ? fullPartial.artifact.resource.expiresAt : undefined).toBe(
      "2026-01-01T00:05:00.000Z"
    );
    expect(nearPartial?.type === "partial" ? nearPartial.artifact.resource.expiresAt : undefined).toBe(
      "2026-01-01T00:00:30.000Z"
    );
    expect(
      fullTerminal?.type === "completed"
        ? fullTerminal.result.finalArtifacts[0]?.resource.expiresAt
        : undefined
    ).toBe("2026-01-01T00:05:00.000Z");
    expect(
      nearTerminal?.type === "completed"
        ? nearTerminal.result.finalArtifacts[0]?.resource.expiresAt
        : undefined
    ).toBe("2026-01-01T00:00:30.000Z");
    expect(Date.parse("2026-01-01T00:05:00.000Z") - Date.parse("2026-01-01T00:00:00.000Z")).toBe(
      300_000
    );

    const repeated = await collectStream(baseUrl, "full-expiry");
    expect(repeated).toEqual(full);
    const serialized = JSON.stringify({ full, near });
    expect(serialized).not.toContain(SESSION_TOKEN);
    expect(serialized).not.toMatch(/(?:C:\\|\/Users\/|data:image|base64|Authorization)/u);
  });

  it("fails closed for every invalid deterministic stream fixture", async () => {
    const baseUrl = await startBridge();
    for (const fixture of [
      "missing-started",
      "duplicate-started",
      "late-started",
      "request-id-drift",
      "invalid-sequence",
      "invalid-schema",
      "sentinel",
      "missing-terminal",
      "duplicate-terminal",
      "post-terminal",
      "eof-before-terminal",
      "oversize"
    ]) {
      await expect(collectStream(baseUrl, fixture), fixture).rejects.toMatchObject({
        code: "invalid_output"
      });
    }
    await expect(collectStream(baseUrl, "completed")).resolves.toHaveLength(3);
  });

  it("cleans up aborted and disconnected streams without adding another route", async () => {
    const baseUrl = await startBridge();
    const controller = new AbortController();
    const iterator = gateway(baseUrl)
      .streamImageOperation(
        { kind: "generate", prompt: "mock-stream:disconnect" },
        { signal: controller.signal }
      )
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "started" } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "partial" } });
    const pending = iterator.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "network_error" });

    const disconnected = await streamFetch(baseUrl, "disconnect");
    if (disconnected.body === null) throw new Error("expected disconnect fixture body");
    const reader = disconnected.body.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await reader.cancel();

    const alternate = await fetch(`${baseUrl}/api/v1/studio/creation/events`, {
      method: "POST",
      headers: {
        accept: "text/event-stream; charset=utf-8",
        "content-type": "application/json",
        [STUDIO_SESSION_HEADER]: SESSION_TOKEN
      },
      body: JSON.stringify({ kind: "generate", prompt: "mock-stream:completed" })
    });
    expect(alternate.status).toBe(404);
    await expect(collectStream(baseUrl, "completed")).resolves.toHaveLength(3);
  });
});
