import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";

import {
  imageArtifactPhaseSchema,
  routegoOperationDefinitions,
  routegoOperationNames,
  studioEditInputSchema,
  studioImageOperationEventSchema,
  type ImageOperationRequest,
  type StudioImageOperationEvent
} from "@routego-image/contracts";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRoutegoMcpProcess } from "../src/runtime/mcp-process";
import {
  ControlledMcpInput,
  FIXED_NOW,
  MemoryMcpOutput,
  collectStudioEvents,
  createOfflineHarness,
  publicGenerate,
  responseText,
  studioGenerate,
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

function decodeSse(text: string): StudioImageOperationEvent[] {
  return text.trim().split("\n\n").map((record) => {
    const lines = record.split("\n");
    const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
    const eventName = lines.find((line) => line.startsWith("event: "))?.slice(7);
    const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
    if (id === undefined || eventName === undefined || data === undefined) {
      throw new Error("The production SSE response omitted id/event/data framing.");
    }
    const event = studioImageOperationEventSchema.parse(JSON.parse(data));
    expect(id).toBe(`${event.requestId}:${event.sequence}`);
    expect(eventName).toBe(event.type);
    return event;
  });
}

describe("task 6.1 offline production composition", () => {
  it("shares one saved asset identity across public creation, Studio search, detail and retry data", async () => {
    const { service } = await harness();
    const publicResult = await service.generate(publicGenerate());
    expect(publicResult.status).toBe("succeeded");

    const publicSearch = await service.searchLibrary({});
    const studioSearch = await service.searchStudioLibrary({});
    const assetId = publicSearch.items[0]?.id;
    expect(assetId).toBeDefined();
    expect(studioSearch.items[0]?.assetId).toBe(assetId);

    const detail = await service.getAssetDetail({ assetId: assetId! });
    expect(detail.asset).toMatchObject({
      id: assetId,
      primaryArtifactId: publicResult.finalArtifacts[0]?.id,
      requestedParams: { prompt: "A deterministic offline Routego image" },
      effectiveParams: { prompt: "A deterministic offline Routego image" }
    });
    expect(detail.asset?.allowedActions).toEqual(expect.arrayContaining(["edit", "retry", "export-zip"]));
    const moduleUrl = new URL("../../studio/src/features/library/handoff.ts", import.meta.url).href;
    const { createLibraryRetryHandoff, isIdentifierOnlyLibraryHandoff } = await import(moduleUrl) as {
      createLibraryRetryHandoff(asset: NonNullable<typeof detail.asset>): {
        readonly action: string;
        readonly assetId: string;
        readonly draft: { readonly prompt: string };
      };
      isIdentifierOnlyLibraryHandoff(value: unknown): boolean;
    };
    const retry = createLibraryRetryHandoff(detail.asset!);
    expect(retry).toMatchObject({
      action: "retry",
      assetId,
      draft: { prompt: "A deterministic offline Routego image" }
    });
    expect(isIdentifierOnlyLibraryHandoff(retry)).toBe(true);
    expect(JSON.stringify({ studioSearch, detail })).not.toMatch(/data:image|base64|"path"/u);
  });

  it("stages direct target, supporting and mask inputs and preserves degraded continuation metadata", async () => {
    const calls: ImageOperationRequest[] = [];
    const created = await harness({
      executeCreation: async (request, context) => {
        calls.push(request);
        return syntheticResult(request, context.requestId, { degradedContinuation: true });
      }
    });
    const sourceRoot = path.join(created.root, "synthetic-inputs");
    await mkdir(sourceRoot, { recursive: true });
    const target = path.join(sourceRoot, "target.png");
    const supporting = path.join(sourceRoot, "supporting.png");
    const mask = path.join(sourceRoot, "mask.png");
    await Promise.all([
      writeFile(target, syntheticPng(3, 3, 0x31)),
      writeFile(supporting, syntheticPng(3, 3, 0x41)),
      writeFile(mask, syntheticPng(3, 3, 0x51))
    ]);

    const result = await created.service.edit({
      kind: "edit",
      prompt: "Continue a deterministic edit without a previous provider response",
      targetImage: { path: target },
      supportingImages: [{ path: supporting, role: "supporting" }],
      maskPath: mask,
      invariants: { allowedChanges: ["background"], preserve: ["subject"], forbiddenChanges: ["text"] },
      action: "edit",
      previousResponseId: "previous-response-unavailable",
      saveToLibrary: true
    });

    expect(result).toMatchObject({
      status: "succeeded",
      execution: { degradedContinuation: true }
    });
    expect(calls).toHaveLength(1);
    const executed = calls[0]!;
    expect(executed.targetImage?.path).not.toBe(target);
    expect(executed.supportingImages[0]?.path).not.toBe(supporting);
    expect(executed.maskPath).not.toBe(mask);
    const canonicalRoot = await realpath(created.root);
    expect([executed.targetImage?.path, executed.supportingImages[0]?.path, executed.maskPath])
      .toSatisfy((paths: Array<string | undefined>) =>
        paths.every((value) => value !== undefined && path.relative(canonicalRoot, value).startsWith("staging/")));
  });

  it("snapshots a finalized upload reference before creation and preserves its source relationship", async () => {
    const calls: ImageOperationRequest[] = [];
    const created = await harness({
      executeCreation: async (request, context) => {
        calls.push(request);
        return syntheticResult(request, context.requestId);
      }
    });
    const bytes = syntheticPng(3, 2, 0x67);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const reserved = await created.service.reserveUploadResource({
      purpose: "reference",
      declaredMimeType: "image/png",
      declaredByteLength: bytes.byteLength,
      expectedSha256: sha256
    });
    const uploadResourceId = reserved.resource!.uploadResourceId;
    await created.library.stageUpload(uploadResourceId, (async function* () {
      yield bytes.subarray(0, 9);
      yield bytes.subarray(9);
    })());
    const finalized = await created.service.finalizeUploadResource({ uploadResourceId });
    expect(finalized).toMatchObject({
      status: "succeeded",
      resource: { finalized: { sha256, detectedMimeType: "image/png" } }
    });

    const result = await created.service.studioGenerate(studioGenerate({
      references: [{ image: { source: "upload", uploadResourceId }, role: "reference" }],
      saveToLibrary: true
    }));
    expect(result.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.references[0]?.path).toContain("/staging/");
    const assetId = result.finalArtifacts[0]!.assetId!;
    const detail = (await created.service.getAssetDetail({ assetId })).asset!;
    expect(detail.renditions.filter((item) => item.phase === "source")).toHaveLength(1);
    expect(detail.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "reference", relatedAssetId: assetId }),
      expect.objectContaining({ role: "output", relatedAssetId: assetId })
    ]));
  });

  it("preserves caller order for a bounded partial batch even when completion order differs", async () => {
    let active = 0;
    let maximum = 0;
    const created = await harness({
      executeCreation: async (request, context) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, request.prompt.endsWith("2") ? 4 : 12));
        active -= 1;
        return syntheticResult(request, context.requestId, { partialCount: 1 });
      }
    });
    const ids = ["offline-1", "offline-2", "offline-3", "offline-4"];
    const result = await created.service.batch({
      concurrency: 2,
      tasks: ids.map((id) => ({
        id,
        operation: publicGenerate({ prompt: id, saveToLibrary: false, outputDir: created.outputRoot })
      }))
    });
    expect(maximum).toBe(2);
    expect(result.items.map((item) => item.id)).toEqual(ids);
    expect(result.items.map((item) => item.result.partialArtifacts.length)).toEqual([1, 1, 1, 1]);
  });

  it("persists exactly 17 source plus 12 partial plus 4 final renditions on one chromakey identity", async () => {
    const created = await harness({
      executeCreation: async (request, context) =>
        syntheticResult(request, context.requestId, { partialCount: 12, finalCount: 4 })
    });
    const sourceRoot = path.join(created.root, "maximum-inputs");
    await mkdir(sourceRoot, { recursive: true });
    const sources = Array.from({ length: 17 }, (_, index) => path.join(sourceRoot, `source-${index}.png`));
    await Promise.all(sources.map(async (source, index) =>
      await writeFile(source, syntheticPng(2, 2, 0x20 + index))));

    const result = await created.service.edit({
      kind: "edit",
      prompt: "Maximum bounded chromakey graph",
      targetImage: { path: sources[0]! },
      references: sources.slice(1, 16).map((source) => ({ path: source, role: "reference" as const })),
      maskPath: sources[16],
      invariants: { preserve: ["single operation identity"] },
      action: "edit",
      transparentMode: "chromakey",
      count: 4,
      partialImages: 3,
      saveToLibrary: true
    });
    expect(["succeeded", "partial"]).toContain(result.status);
    expect(result.partialArtifacts).toHaveLength(12);
    expect(result.finalArtifacts).toHaveLength(4);
    const assetId = (await created.service.searchLibrary({})).items[0]!.id;
    const detail = (await created.service.getAssetDetail({ assetId })).asset!;
    expect(detail.renditions).toHaveLength(33);
    expect(detail.renditions.filter((item) => item.phase === "source")).toHaveLength(17);
    expect(detail.renditions.filter((item) => item.phase === "partial")).toHaveLength(12);
    expect(detail.renditions.filter((item) => item.phase === "final")).toHaveLength(4);
    expect(new Set(detail.renditions.map((item) => item.artifactId)).size).toBe(33);
    expect(new Set(detail.relationships.map((item) => item.relatedAssetId))).toEqual(new Set([assetId]));
    expect(detail.relationships.map((item) => item.role)).not.toContain("transparent-original");
  });

  it("round-trips a saved asset through ZIP without overwriting an existing project copy", async () => {
    const created = await harness();
    const result = await created.service.generate(publicGenerate());
    const assetId = (await created.service.searchLibrary({})).items[0]!.id;
    const project = path.join(created.root, "project");
    await mkdir(project, { recursive: true });
    const collision = path.join(project, "routego-final-0.png");
    await writeFile(collision, "existing-project-file", "utf8");
    const copied = await created.service.generate(publicGenerate({ outputDir: project }));
    expect(path.basename(copied.finalArtifacts[0]!.path!)).toBe("routego-final-0-2.png");
    expect(await readFile(collision, "utf8")).toBe("existing-project-file");

    const zipPath = path.join(created.root, "portable.zip");
    const exported = await created.service.manageLibrary({ action: "export-zip", assetIds: [assetId], outputPath: zipPath });
    expect(exported.outputPath).toBe(zipPath);
    expect((await readFile(zipPath)).subarray(0, 2)).toEqual(Buffer.from("PK"));
    const imported = await created.service.manageLibrary({ action: "import-zip", zipPath });
    expect(imported.importedCount).toBe(0);
    expect(imported.skippedCount).toBe(1);
    expect((await created.service.searchLibrary({})).items.map((item) => item.id)).toContain(assetId);
    expect(result.finalArtifacts[0]?.id).toBeDefined();
  });

  it("serves the exact authenticated Studio stream with strict id/event/data framing", async () => {
    const created = await harness({
      executeCreation: async (request, context) => {
        const partial = syntheticArtifact(`${context.requestId}:partial`, "partial");
        await context.onEvent?.({
          type: "partial",
          requestId: context.requestId,
          sequence: 1,
          occurredAt: new Date(FIXED_NOW).toISOString(),
          artifact: partial
        });
        return syntheticResult(request, context.requestId, { partialCount: 1 });
      }
    });
    const response = await created.dispatchStudio(studioGenerate());
    expect(response.status).toBe(200);
    expect(response.headers?.["content-type"]).toBe("text/event-stream; charset=utf-8");
    const events = decodeSse(await responseText(response));
    expect(events.map((event) => event.type)).toEqual(["started", "partial", "completed"]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(new Set(events.map((event) => event.requestId)).size).toBe(1);

    const alternate = await created.dispatchStudio(studioGenerate(), {
      pathname: "/api/v1/studio/creation/events"
    });
    expect(alternate.status).toBe(404);
  });

  it("exposes exactly seven MCP tools and freezes public artifact phases to partial and final", async () => {
    const created = await harness();
    const input = new ControlledMcpInput();
    const output = new MemoryMcpOutput();
    const error = new MemoryMcpOutput();
    const runtime = createRoutegoMcpProcess({
      service: created.service,
      httpLifecycle: { shutdown: async () => undefined },
      input,
      output,
      error
    });
    await runtime.start();
    input.push(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
    input.push(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    await vi.waitFor(() => expect(output.responses()).toHaveLength(2));
    const listed = output.responses()[1]!["result"] as { tools: Array<{ name: string }> };
    expect(listed.tools.map((tool) => tool.name)).toEqual(
      routegoOperationNames.map((name) => routegoOperationDefinitions[name].toolName)
    );
    expect(listed.tools).toHaveLength(7);
    expect(imageArtifactPhaseSchema.options).toEqual(["partial", "final"]);
    expect(imageArtifactPhaseSchema.safeParse("source").success).toBe(false);
    input.end();
    await runtime.waitUntilClosed();
    expect(error.responses()).toEqual([]);
  });
});
