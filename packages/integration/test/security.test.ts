import { createHash } from "node:crypto";
import path from "node:path";
import { access, writeFile } from "node:fs/promises";

import {
  studioGenerateInputSchema,
  studioImageOperationEventSchema,
  studioServiceErrorSchema,
  type StudioImageOperationEvent
} from "@routego-image/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EphemeralImageResourceError } from "../src/runtime/ephemeral-resources";
import {
  FIXED_NOW,
  collectStudioEvents,
  createOfflineHarness,
  readableSse,
  sseRecord,
  syntheticArtifact,
  syntheticPng,
  syntheticResult,
  type OfflineHarness
} from "./fixtures";

const harnesses: OfflineHarness[] = [];

afterEach(async () => {
  await Promise.allSettled(harnesses.splice(0).map(async (harness) => await harness.close()));
  vi.restoreAllMocks();
});

async function harness(
  options: Parameters<typeof createOfflineHarness>[0] = {}
): Promise<OfflineHarness> {
  const created = await createOfflineHarness(options);
  harnesses.push(created);
  return created;
}

function started(requestId = "request-sse", sequence = 0): StudioImageOperationEvent {
  return studioImageOperationEventSchema.parse({
    type: "started",
    requestId,
    sequence,
    occurredAt: new Date(FIXED_NOW).toISOString(),
    requestedParams: studioTextGenerate()
  });
}

function studioTextGenerate() {
  return studioGenerateInputSchema.parse({
    kind: "generate",
    prompt: "一张完全离线的合成图片"
  });
}

function failed(requestId = "request-sse", sequence = 1): StudioImageOperationEvent {
  return studioImageOperationEventSchema.parse({
    type: "failed",
    requestId,
    sequence,
    occurredAt: new Date(FIXED_NOW).toISOString(),
    error: studioServiceErrorSchema.parse({
      code: "capability_unavailable",
      category: "capability",
      stage: "route",
      safeMessage: "The deterministic offline operation is unavailable.",
      retryDisposition: "safe-pre-generation",
      partialArtifacts: [],
      receivedAnyOutput: false,
      mayHaveBilled: false
    }),
    receivedAnyOutput: false,
    mayHaveBilled: false
  });
}

async function parseStudioSse(text: string): Promise<StudioImageOperationEvent[]> {
  const moduleUrl = new URL("../../studio/src/api/sse.ts", import.meta.url).href;
  const { parseStudioImageOperationEventStream } = await import(moduleUrl) as {
    parseStudioImageOperationEventStream(
      body: ReadableStream<Uint8Array>
    ): AsyncGenerator<StudioImageOperationEvent>;
  };
  const events: StudioImageOperationEvent[] = [];
  for await (const event of parseStudioImageOperationEventStream(readableSse(text))) events.push(event);
  return events;
}

async function expectInvalidSse(text: string): Promise<void> {
  await expect(parseStudioSse(text)).rejects.toMatchObject({ code: "invalid_output" });
}

describe("task 6.1 strict Studio stream and security boundaries", () => {
  it("accepts one started/terminal stream and rejects framing, request, sequence, EOF and sentinel drift", async () => {
    const valid = `${sseRecord(started())}${sseRecord(failed())}`;
    expect((await parseStudioSse(valid)).map((event) => event.type)).toEqual(["started", "failed"]);

    const cases = [
      sseRecord(failed()),
      `${sseRecord(started())}${sseRecord(started("request-sse", 1))}${sseRecord(failed("request-sse", 2))}`,
      `${sseRecord(started())}${sseRecord(failed("other-request", 1))}`,
      `${sseRecord(started())}${sseRecord(failed("request-sse", 0))}`,
      sseRecord(started()),
      `${sseRecord(started())}data: [DONE]\n\n`,
      `${valid}${sseRecord(failed("request-sse", 2))}`,
      valid.replace("event: failed", "event: completed"),
      valid.replace("id: request-sse:1", "id: request-sse:9")
    ];
    for (const candidate of cases) await expectInvalidSse(candidate);
  });

  it("preserves partial output after failure while redacting credentials, paths and image payloads", async () => {
    const created = await harness({
      executeCreation: async (_request, context) => {
        await context.onEvent?.({
          type: "partial",
          requestId: context.requestId,
          sequence: 1,
          occurredAt: new Date(FIXED_NOW).toISOString(),
          artifact: syntheticArtifact(`${context.requestId}:partial`, "partial")
        });
        throw new Error(
          "Authorization: Bearer synthetic-secret /Users/Synthetic/Library/private.png " +
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
        );
      }
    });
    const events = await collectStudioEvents(created.service.executeStudioStream(studioTextGenerate()));
    expect(events.map((event) => event.type)).toEqual(["started", "partial", "failed"]);
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      receivedAnyOutput: true,
      mayHaveBilled: true,
      error: { code: "internal_contract", partialArtifacts: [{ phase: "partial" }] }
    });
    const rendered = JSON.stringify(events);
    expect(rendered).not.toMatch(/synthetic-secret|\/Users\/Synthetic|data:image|base64/u);
  });

  it("fails closed after recovery corruption and never invokes creation or network", async () => {
    const execute = vi.fn();
    const created = await harness({
      recoverFailure: new Error("Bearer synthetic-recovery-secret /tmp/private-state.json"),
      executeCreation: execute
    });
    const status = await created.service.status({});
    expect(status.service.status).toBe("degraded");
    const events = await collectStudioEvents(created.service.executeStudioStream(studioTextGenerate()));
    expect(events.map((event) => event.type)).toEqual(["started", "failed"]);
    expect(events.at(-1)).toMatchObject({ type: "failed", error: { code: "config_corrupt" } });
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toMatch(/synthetic-recovery-secret|\/tmp\/private-state/u);
  });

  it("rejects missing output approval and invalid Studio upload identities before provider execution", async () => {
    const execute = vi.fn();
    const created = await harness({ executeCreation: execute });
    const publicResult = await created.service.generate({
      kind: "generate",
      prompt: "Unsaved output without an approved directory",
      saveToLibrary: false
    });
    expect(publicResult).toMatchObject({ status: "failed", error: { code: "invalid_input" } });
    await expect(created.service.studioGenerate({
      kind: "generate",
      prompt: "Stale upload identity must be rejected",
      references: [{
        image: { source: "upload", uploadResourceId: "missing-upload" },
        role: "reference"
      }]
    } as never)).rejects.toThrow(/references/u);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not infer credentials or data roots from ambient environment", async () => {
    const previous = {
      OPENAI_API_KEY: process.env["OPENAI_API_KEY"],
      HOME: process.env["HOME"],
      CODEX_HOME: process.env["CODEX_HOME"]
    };
    process.env["OPENAI_API_KEY"] = ["sk", "synthetic-must-not-be-read"].join("-");
    process.env["HOME"] = "/tmp/routego-forbidden-real-home";
    process.env["CODEX_HOME"] = "/tmp/routego-forbidden-real-codex-home";
    try {
      const created = await harness();
      const status = await created.service.status({});
      expect(status).toMatchObject({ configured: false, hasApiKey: false });
      expect(created.root).not.toBe(process.env["HOME"]);
      expect(created.root).not.toBe(process.env["CODEX_HOME"]);
      await expect(access(process.env["HOME"]!)).rejects.toThrow();
      await expect(access(process.env["CODEX_HOME"]!)).rejects.toThrow();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("task 6.1 immutable ephemeral resource lifetime", () => {
  async function register(
    created: OfflineHarness,
    owningSessionExpiresAt: number,
    id: string
  ) {
    const bytes = syntheticPng(1, 1, 0x62);
    const source = path.join(created.root, `${id}.png`);
    await writeFile(source, bytes);
    return await created.registry.registerImage({
      owningSessionId: "session-resource-test",
      owningSessionExpiresAt: new Date(owningSessionExpiresAt),
      output: {
        artifactId: id,
        slot: 0,
        phase: "partial",
        path: source,
        mimeType: "image/png",
        byteLength: bytes.byteLength,
        width: 1,
        height: 1,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        createdAt: new Date(FIXED_NOW).toISOString(),
        source: "provider-original"
      }
    });
  }

  const isResourceError = (code: EphemeralImageResourceError["code"]) =>
    (error: unknown) => error instanceof EphemeralImageResourceError && error.code === code;

  it("uses the full five-minute lifetime and keeps browser cleanup independent", async () => {
    const created = await harness();
    const descriptor = await register(created, FIXED_NOW + 10 * 60_000, "normal-resource");
    expect(descriptor.expiresAt).toBe(new Date(FIXED_NOW + 5 * 60_000).toISOString());
    created.clock.now = FIXED_NOW + 5 * 60_000 - 1;
    const opened = await created.registry.open(descriptor.resourceId, "session-resource-test");
    await opened.close();
    expect(created.registry.size).toBe(1);
    const moduleUrl = new URL("../../studio/src/api/resources.ts", import.meta.url).href;
    const { createProtectedObjectUrl } = await import(moduleUrl) as {
      createProtectedObjectUrl(
        blob: Blob,
        api: { createObjectURL(value: Blob): string; revokeObjectURL(url: string): void }
      ): { readonly revoked: boolean; revoke(): void };
    };
    const revokeObjectURL = vi.fn();
    const browserResource = createProtectedObjectUrl(new Blob([Uint8Array.from(syntheticPng(1, 1))]), {
      createObjectURL: () => "blob:synthetic-task-6-1",
      revokeObjectURL
    });
    browserResource.revoke();
    browserResource.revoke();
    expect(browserResource.revoked).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(created.registry.size).toBe(1);
    const reopened = await created.registry.open(descriptor.resourceId, "session-resource-test");
    await reopened.close();
    created.clock.now = FIXED_NOW + 5 * 60_000;
    await expect(created.registry.open(descriptor.resourceId, "session-resource-test"))
      .rejects.toSatisfy(isResourceError("expired"));
  });

  it("caps near-expiry resources at the session and rejects exactly at the boundary", async () => {
    const created = await harness();
    const boundary = FIXED_NOW + 2_000;
    const descriptor = await register(created, boundary, "near-expiry-resource");
    expect(descriptor.expiresAt).toBe(new Date(boundary).toISOString());
    created.clock.now = boundary - 1;
    const opened = await created.registry.open(descriptor.resourceId, "session-resource-test");
    await opened.close();
    created.clock.now = boundary;
    await expect(created.registry.open(descriptor.resourceId, "session-resource-test"))
      .rejects.toSatisfy(isResourceError("expired"));
  });

  it("preserves failure/disconnect resources until expiry and revokes all leases on shutdown", async () => {
    const created = await harness();
    const failure = await register(created, FIXED_NOW + 60_000, "failed-partial-resource");
    const disconnected = await register(created, FIXED_NOW + 60_000, "disconnect-resource");
    const cancelled = await register(created, FIXED_NOW + 60_000, "cancel-resource");
    created.clock.now = FIXED_NOW + 59_999;
    const leases = await Promise.all([failure, disconnected, cancelled].map(async (descriptor) =>
      await created.registry.open(descriptor.resourceId, "session-resource-test")));
    expect(leases.every((lease) => !lease.signal.aborted)).toBe(true);
    expect(await created.registry.shutdown()).toBe(3);
    expect(leases.every((lease) => lease.signal.aborted)).toBe(true);
    for (const descriptor of [failure, disconnected, cancelled]) {
      await expect(created.registry.open(descriptor.resourceId, "session-resource-test"))
        .rejects.toSatisfy(isResourceError("registry-shutdown"));
    }
  });
});
