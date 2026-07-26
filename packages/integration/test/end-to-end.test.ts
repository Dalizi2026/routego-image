import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";

import {
  imageArtifactPhaseSchema,
  routegoOperationDefinitions,
  routegoOperationNames,
  studioGenerateInputSchema,
  studioImageOperationEventSchema,
  type ImageOperationRequest,
  type StudioImageOperationEvent
} from "@routego-image/contracts";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRoutegoMcpProcess } from "../src/runtime/mcp-process";
import {
  BackgroundRemovalQueue,
  type BackgroundRemovalResult
} from "../src/runtime/background-removal";
import {
  ControlledMcpInput,
  FIXED_NOW,
  MemoryMcpOutput,
  collectStudioEvents,
  createOfflineHarness,
  publicGenerate,
  responseText,
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

describe("Task 4.2 generation-only batch boundary", () => {
  it("returns ordered generation results with fixed concurrency two", async () => {
    const created = await harness();
    const ids = ["batch-1", "batch-2", "batch-3"];
    const result = await created.service.batch({
      tasks: ids.map((id) => ({
        id,
        operation: publicGenerate({ prompt: id, saveToLibrary: false, outputDir: created.outputRoot })
      }))
    });
    expect(result.status).toBe("succeeded");
    expect(result.concurrency).toBe(2);
    expect(result.items.map((item) => item.id)).toEqual(ids);
  });
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

function transparentSyntheticArtifact(id: string, slot = 0) {
  const artifact = syntheticArtifact(id, "final", slot, 0x55 + slot);
  const encoded = artifact.display?.dataUrl?.split(",")[1];
  if (encoded === undefined) throw new Error("The synthetic artifact has no image bytes.");
  const decoded = PNG.sync.read(Buffer.from(encoded, "base64"));
  decoded.data[3] = 0;
  const bytes = PNG.sync.write(decoded, {
    colorType: 6,
    inputColorType: 6,
    inputHasAlpha: true
  });
  return {
    ...artifact,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    display: { type: "image" as const, dataUrl: `data:image/png;base64,${bytes.toString("base64")}` }
  };
}

function failedLocalRemoval(bytes: Uint8Array): BackgroundRemovalResult {
  return {
    status: "failed",
    originalBytes: new Uint8Array(bytes),
    error: { code: "worker-failed", message: "Synthetic local inference failed." }
  };
}

function studioTextGenerate() {
  return studioGenerateInputSchema.parse({
    kind: "generate",
    prompt: "一张完全离线的合成图片"
  });
}

describe("task 6.1 offline production composition", () => {
  it("shares one saved asset identity across public creation, Studio search, detail and generation-copy data", async () => {
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
    expect(detail.asset?.allowedActions).toEqual(expect.arrayContaining([
      "mark",
      "copy-generation-info",
      "export-zip",
      "download"
    ]));
    expect(detail.asset?.allowedActions).not.toEqual(expect.arrayContaining(["edit", "retry"]));
    expect(JSON.stringify({ studioSearch, detail })).not.toMatch(/data:image|base64|"path"/u);
  });

  it("stages direct generation references and preserves provider execution metadata", async () => {
    const calls: ImageOperationRequest[] = [];
    const created = await harness({
      executeCreation: async (request, context) => {
        calls.push(request);
        return syntheticResult(request, context.requestId, { degradedContinuation: true });
      }
    });
    const sourceRoot = path.join(created.root, "synthetic-inputs");
    await mkdir(sourceRoot, { recursive: true });
    const referenceOne = path.join(sourceRoot, "reference-one.png");
    const referenceTwo = path.join(sourceRoot, "reference-two.png");
    await Promise.all([
      writeFile(referenceOne, syntheticPng(3, 3, 0x31)),
      writeFile(referenceTwo, syntheticPng(3, 3, 0x41))
    ]);

    const result = await created.service.generate(publicGenerate({
      prompt: "Generate with deterministic local references",
      references: [
        { path: referenceOne, role: "reference" },
        { path: referenceTwo, role: "style" }
      ],
      saveToLibrary: true
    }));

    expect(result).toMatchObject({
      status: "succeeded",
      execution: { degradedContinuation: true }
    });
    expect(calls).toHaveLength(1);
    const executed = calls[0]!;
    expect(executed.references.map((item) => item.path)).not.toContain(referenceOne);
    expect(executed.references.map((item) => item.path)).not.toContain(referenceTwo);
    const canonicalRoot = await realpath(created.root);
    expect(executed.references.map((item) => item.path))
      .toSatisfy((paths: Array<string | undefined>) =>
        paths.every((value) => value !== undefined && path.relative(canonicalRoot, value).startsWith("staging/")));
  });

  it("keeps Studio generation text-only without upload source relationships", async () => {
    const calls: ImageOperationRequest[] = [];
    const created = await harness({
      executeCreation: async (request, context) => {
        calls.push(request);
        return syntheticResult(request, context.requestId);
      }
    });

    const result = await created.service.studioGenerate(studioTextGenerate());
    expect(result.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.references).toEqual([]);
    const assetId = result.finalArtifacts[0]!.assetId!;
    const detail = (await created.service.getAssetDetail({ assetId })).asset!;
    expect(detail.renditions.filter((item) => item.phase === "source")).toHaveLength(0);
    expect(detail.relationships).toEqual(expect.arrayContaining([
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
      tasks: ids.map((id) => ({
        id,
        operation: publicGenerate({ prompt: id, saveToLibrary: false, outputDir: created.outputRoot })
      }))
    });
    expect(maximum).toBe(2);
    expect(result.items.map((item) => item.id)).toEqual(ids);
    expect(result.items.map((item) => item.result.partialArtifacts.length)).toEqual([1, 1, 1, 1]);
  });

  it("persists five generation sources plus 12 partial and 4 final renditions on one identity", async () => {
    const created = await harness({
      executeCreation: async (request, context) =>
        syntheticResult(request, context.requestId, { partialCount: 12, finalCount: 4 })
    });
    const sourceRoot = path.join(created.root, "maximum-inputs");
    await mkdir(sourceRoot, { recursive: true });
    const sources = Array.from({ length: 5 }, (_, index) => path.join(sourceRoot, `source-${index}.png`));
    await Promise.all(sources.map(async (source, index) =>
      await writeFile(source, syntheticPng(2, 2, 0x20 + index))));

    const result = await created.service.generate(publicGenerate({
      prompt: "Maximum bounded generation graph",
      references: sources.map((source) => ({ path: source, role: "reference" as const })),
      count: 4,
      partialImages: 3,
      saveToLibrary: true
    }));
    expect(["succeeded", "partial"]).toContain(result.status);
    expect(result.partialArtifacts).toHaveLength(12);
    expect(result.finalArtifacts).toHaveLength(4);
    const assetId = (await created.service.searchLibrary({})).items[0]!.id;
    const detail = (await created.service.getAssetDetail({ assetId })).asset!;
    expect(detail.renditions).toHaveLength(21);
    expect(detail.renditions.filter((item) => item.phase === "source")).toHaveLength(5);
    expect(detail.renditions.filter((item) => item.phase === "partial")).toHaveLength(12);
    expect(detail.renditions.filter((item) => item.phase === "final")).toHaveLength(4);
    expect(new Set(detail.renditions.map((item) => item.artifactId)).size).toBe(21);
    expect(new Set(detail.relationships.map((item) => item.relatedAssetId))).toEqual(new Set([assetId]));
    expect(detail.relationships.map((item) => item.role)).not.toContain("transparent-original");
  });

  it("copies a saved asset to a project without overwriting an existing file", async () => {
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
    const response = await created.dispatchStudio(studioTextGenerate());
    expect(response.status).toBe(200);
    expect(response.headers?.["content-type"]).toBe("text/event-stream; charset=utf-8");
    const events = decodeSse(await responseText(response));
    expect(events.map((event) => event.type)).toEqual(["started", "partial", "completed"]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(new Set(events.map((event) => event.requestId)).size).toBe(1);

    const alternate = await created.dispatchStudio(studioTextGenerate(), {
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

describe("task 6.5 native transparency fallback", () => {
  it("accepts meaningful native alpha without local processing or a second provider request", async () => {
    const providerCalls: ImageOperationRequest[] = [];
    const localRemoval = vi.spyOn(BackgroundRemovalQueue.prototype, "remove");
    const created = await harness({
      executeCreation: async (request, context) => {
        providerCalls.push(request);
        const result = syntheticResult(request, context.requestId);
        return { ...result, finalArtifacts: [transparentSyntheticArtifact(`${context.requestId}:final:0`)] };
      }
    });

    const result = await created.service.generate(publicGenerate({
      transparentMode: "native",
      saveToLibrary: false,
      outputDir: created.outputRoot
    }));

    expect(result.status).toBe("succeeded");
    expect(result.execution.providerRequestCount).toBe(1);
    expect(providerCalls).toHaveLength(1);
    expect(localRemoval).not.toHaveBeenCalled();
    const output = result.finalArtifacts[0]!;
    const bytes = Buffer.from(output.display!.dataUrl!.split(",")[1]!, "base64");
    expect(PNG.sync.read(bytes).data[3]).toBe(0);
  });

  it("processes an opaque native result locally without replaying the provider request", async () => {
    const providerCalls: ImageOperationRequest[] = [];
    let localCalls = 0;
    const localRemoval = vi.spyOn(BackgroundRemovalQueue.prototype, "remove").mockImplementation(async (bytes) => {
      localCalls += 1;
      const replacement = transparentSyntheticArtifact("local-fallback:final:0");
      const encoded = replacement.display!.dataUrl!.split(",")[1]!;
      return {
        status: "succeeded",
        originalBytes: new Uint8Array(bytes),
        transparentBytes: new Uint8Array(Buffer.from(encoded, "base64")),
        width: replacement.width!,
        height: replacement.height!
      };
    });
    const created = await harness({
      executeCreation: async (request, context) => {
        providerCalls.push(request);
        return syntheticResult(request, context.requestId);
      }
    });

    const result = await created.service.generate(publicGenerate({
      transparentMode: "native",
      saveToLibrary: false,
      outputDir: created.outputRoot
    }));

    expect(result.status).toBe("succeeded");
    expect(result.execution.providerRequestCount).toBe(1);
    expect(providerCalls).toHaveLength(1);
    expect(localRemoval).toHaveBeenCalledTimes(1);
    expect(localCalls).toBe(1);
    const output = result.finalArtifacts[0]!;
    expect(PNG.sync.read(Buffer.from(output.display!.dataUrl!.split(",")[1]!, "base64")).data[3]).toBe(0);
  });

  it("keeps the provider original and reports a structured failure when local processing fails", async () => {
    const localRemoval = vi.spyOn(BackgroundRemovalQueue.prototype, "remove").mockImplementation(async (bytes) => failedLocalRemoval(bytes));
    const created = await harness({
      executeCreation: async (request, context) => syntheticResult(request, context.requestId)
    });

    const result = await created.service.generate(publicGenerate({
      transparentMode: "native",
      saveToLibrary: false,
      outputDir: created.outputRoot
    }));

    expect(result.status).toBe("partial");
    expect(result.error).toMatchObject({ code: "postprocess_failed", stage: "postprocess" });
    expect(result.execution.providerRequestCount).toBe(1);
    expect(localRemoval).toHaveBeenCalledTimes(1);
    const output = result.finalArtifacts[0]!;
    expect(PNG.sync.read(Buffer.from(output.display!.dataUrl!.split(",")[1]!, "base64")).data[3]).toBe(255);
  });
});
