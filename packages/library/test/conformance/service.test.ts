import { deflateSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { access, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";
import {
  routegoOperationNames,
  type LibraryOperationParameters,
  type StudioLibraryService,
  type StudioUploadService
} from "@routego-image/contracts";

import {
  BrowserResourceRegistry,
  GalleryService,
  ImageLibraryIndexStore,
  LibraryAssetStore,
  LibraryPortabilityService,
  LibraryResourceResolver,
  LibrarySettingsStore,
  RoutegoLibraryService,
  UploadStore,
  createRoutegoLibraryService,
  decodeZipArchive,
  type LibrarySettingsService
} from "../../src/index";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(data.byteLength + 12);
  output.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.byteLength + 8);
  return output;
}

function png(fill = 0x33): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, fill, fill, fill, 0xff, fill, fill, fill, 0xff]))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function parameters(prompt: string): LibraryOperationParameters {
  return {
    kind: "generate",
    prompt,
    references: [],
    size: "1024x1024",
    aspectRatio: "1:1",
    quality: "high",
    format: "png",
    count: 1,
    partialImages: 0,
    transparentMode: "off",
    moderation: "auto",
    action: "generate",
    imageIds: [],
    fileIds: [],
    outputDirectoryMode: "default",
    saveToLibrary: true
  };
}

const execution = {
  attemptCount: 1,
  providerRequestCount: 1,
  receivedAnyOutput: true,
  mayHaveBilled: true,
  degradedContinuation: false,
  providerImageIds: []
};

async function* binaryChunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  const middle = Math.max(1, Math.floor(bytes.byteLength / 2));
  yield bytes.subarray(0, middle);
  if (middle < bytes.byteLength) yield bytes.subarray(middle);
}

async function createHarness(
  prefix: string,
  options: {
    readonly publicProtectedRoots?: (root: string) => readonly string[];
  } = {}
) {
  const root = await mkdtemp(path.join(os.tmpdir(), `routego-conformance-${prefix}-`));
  roots.push(root);
  const homeDirectory = path.join(root, "home");
  const dataRoot = path.join(root, "data");
  const libraryRoot = path.join(root, "library");
  const counters = new Map<string, number>();
  const next = (kind: string) => {
    const value = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, value);
    return `${kind}-${prefix}-${value}`;
  };
  const service = createRoutegoLibraryService({
    homeDirectory,
    now: () => new Date("2026-07-18T10:00:00.000Z"),
    settings: {
      dataRoot,
      idFactory: () => next("provider"),
      protectCredentialFile: async () => undefined
    },
    uploads: { dataRoot, idFactory: () => next("upload") },
    index: { root: libraryRoot },
    assets: { protectedRoots: [], idFactory: (kind) => next(kind) },
    resources: { idFactory: (kind) => next(`resource-${kind}`) },
    read: { folderIdFactory: () => next("folder") },
    mutations: { protectedRoots: [], idFactory: (kind) => next(kind) },
    portability: { idFactory: (kind) => next(kind) },
    zipPreflightIdFactory: () => next("preflight"),
    publicProtectedRoots: options.publicProtectedRoots?.(root) ?? []
  });
  return { root, homeDirectory, dataRoot, libraryRoot, service };
}

async function seedAsset(
  harness: Awaited<ReturnType<typeof createHarness>>,
  options: { readonly assetId?: string; readonly artifactId?: string; readonly fill?: number } = {}
) {
  const assetId = options.assetId ?? "asset-conformance";
  const artifactId = options.artifactId ?? "artifact-conformance";
  const sourceRoot = path.join(harness.root, `source-${assetId}`);
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "image.png"), png(options.fill));
  const prompt = `Synthetic ${assetId}`;
  const result = await harness.service.assetStore.ingestAsset({
    assetId,
    primaryArtifactId: artifactId,
    prompt,
    model: "synthetic-model",
    requestedParams: parameters(prompt),
    effectiveParams: parameters(prompt),
    execution,
    renditions: [
      {
        artifactId,
        phase: "final",
        sourceRoot,
        sourceRelativePath: "image.png"
      }
    ],
    createdAt: "2026-07-18T09:00:00.000Z",
    updatedAt: "2026-07-18T09:00:00.000Z"
  });
  return { assetId, artifactId, result };
}

describe("@routego-image/library service composition", () => {
  it("exports the complete Library-owned API surface and preserves the seven public operations", () => {
    expect(routegoOperationNames).toEqual([
      "status",
      "generate",
      "prepareRegeneration",
      "batch",
      "searchLibrary",
      "manageLibrary",
      "openStudio"
    ]);
    expect(RoutegoLibraryService).toBeTypeOf("function");
    expect(LibrarySettingsStore).toBeTypeOf("function");
    expect(UploadStore).toBeTypeOf("function");
    expect(ImageLibraryIndexStore).toBeTypeOf("function");
    expect(LibraryAssetStore).toBeTypeOf("function");
    expect(BrowserResourceRegistry).toBeTypeOf("function");
    expect(GalleryService).toBeTypeOf("function");
    expect(LibraryPortabilityService).toBeTypeOf("function");
    expect(LibraryResourceResolver).toBeTypeOf("function");
  });

  it("composes settings, uploads, gallery reads/mutations, and stable locators without provider execution", async () => {
    const harness = await createHarness("owned-services");
    const service: RoutegoLibraryService = harness.service;
    const settings: LibrarySettingsService = service;
    const uploads: StudioUploadService = service;
    const gallery: StudioLibraryService = service;
    void settings;
    void uploads;
    void gallery;

    expect("generate" in service).toBe(false);
    expect("edit" in service).toBe(false);
    expect("batch" in service).toBe(false);
    expect("refreshModels" in service).toBe(false);
    expect("probeCapabilities" in service).toBe(false);

    const profile = await service.upsertProviderProfile({
      profileId: "provider-conformance",
      name: "Synthetic relay",
      endpoints: {
        generation: {
          mode: "exact-generation-endpoint",
          value: "https://relay.example/v1/images/generations"
        }
      },
      apiKey: { operation: "unchanged" },
      setActive: true
    });
    expect(profile.profile).toMatchObject({ id: "provider-conformance", hasApiKey: false });
    expect((await service.readSettings({})).activeProviderId).toBe("provider-conformance");

    const uploadedBytes = png(0x44);
    const reserved = await service.reserveUploadResource({
      purpose: "reference",
      declaredMimeType: "image/png",
      declaredByteLength: uploadedBytes.byteLength
    });
    expect(reserved.status).toBe("succeeded");
    const uploadResourceId = reserved.resource!.uploadResourceId;
    await service.stageUpload(uploadResourceId, binaryChunks(uploadedBytes));
    expect((await service.finalizeUploadResource({ uploadResourceId })).status).toBe("succeeded");
    const resolvedUpload = await service.resolveImageResource(
      { source: "upload", uploadResourceId },
      ["reference"]
    );
    expect(resolvedUpload).toMatchObject({
      source: "upload",
      uploadResourceId,
      mimeType: "image/png"
    });

    const seeded = await seedAsset(harness);
    const publicSearch = await service.searchLibrary({ query: "Synthetic" });
    const studioSearch = await service.searchStudioLibrary({ query: "Synthetic" });
    expect(publicSearch.items[0]).toMatchObject({ id: seeded.assetId });
    expect(publicSearch.items[0]).toHaveProperty("path");
    expect(studioSearch.items[0]).toMatchObject({
      assetId: seeded.assetId,
      artifactId: seeded.artifactId
    });
    expect(JSON.stringify(studioSearch)).not.toContain(harness.libraryRoot);

    const folder = await service.manageLibrary({ action: "create-folder", name: "精选" });
    const folderId = folder.affectedFolderIds[0]!;
    const assigned = await service.manageLibrary({
      action: "assign-folders",
      assetIds: [seeded.assetId],
      folderIds: [folderId]
    });
    expect(assigned.affectedAssetIds).toEqual([seeded.assetId]);
    expect((await service.getAssetDetail({ assetId: seeded.assetId })).asset?.folders).toHaveLength(1);

    const byAsset = await service.resolveImageResource({
      source: "asset",
      assetId: seeded.assetId
    });
    const byArtifact = await service.resolveImageResource({
      source: "artifact",
      artifactId: seeded.artifactId
    });
    expect(byAsset).toMatchObject({ source: "asset", assetId: seeded.assetId });
    expect(byArtifact).toMatchObject({
      source: "artifact",
      assetId: seeded.assetId,
      artifactId: seeded.artifactId
    });
    expect(byAsset.path).toBe(byArtifact.path);
  });

  it("wires Studio ZIP preflight/execution and public path-based export/import without overwrite", async () => {
    const source = await createHarness("zip-source");
    const seeded = await seedAsset(source, {
      assetId: "asset-portable-conformance",
      artifactId: "artifact-portable-conformance",
      fill: 0x55
    });

    const preflight = await source.service.preflightLibraryMutation({
      mutation: { action: "export-zip", assetIds: [seeded.assetId] }
    });
    expect(preflight).toMatchObject({
      action: "export-zip",
      status: "ready",
      requiredConfirmations: ["zip-export"]
    });
    const exported = await source.service.executeLibraryMutation({
      preflightId: preflight.preflightId,
      action: "export-zip",
      confirmations: ["zip-export"]
    });
    expect(exported).toMatchObject({ status: "succeeded", action: "export-zip" });
    expect(exported.outputResource).toMatchObject({
      mimeType: "application/zip",
      requiresSession: true
    });
    expect(JSON.stringify(exported)).not.toContain(source.libraryRoot);
    const protectedZip = source.service.resolveBrowserResource(
      exported.outputResource!.resourceId
    );
    await expect(access(protectedZip.path)).resolves.toBeUndefined();

    const requestedOutput = path.join(source.root, "exports", "portable.zip");
    await mkdir(path.dirname(requestedOutput), { recursive: true });
    await writeFile(requestedOutput, "preserve-existing", "utf8");
    const publicExport = await source.service.manageLibrary({
      action: "export-zip",
      assetIds: [seeded.assetId],
      outputPath: requestedOutput
    });
    expect(await readFile(requestedOutput, "utf8")).toBe("preserve-existing");
    expect(publicExport.outputPath).toBe(path.join(source.root, "exports", "portable-2.zip"));
    expect((await readFile(publicExport.outputPath!)).subarray(0, 4)).toEqual(
      Buffer.from([0x50, 0x4b, 0x03, 0x04])
    );

    const target = await createHarness("zip-target");
    const imported = await target.service.manageLibrary({
      action: "import-zip",
      zipPath: publicExport.outputPath!
    });
    expect(imported).toMatchObject({
      action: "import-zip",
      importedCount: 1,
      skippedCount: 0
    });
    const targetSearch = await target.service.searchStudioLibrary({});
    expect(targetSearch.items).toHaveLength(1);
    expect(targetSearch.items[0]?.assetId).toBe(seeded.assetId);
    expect(JSON.stringify(imported)).not.toContain(publicExport.outputPath);
  });

  it("writes every public ZIP byte when FileHandle.write completes partially", async () => {
    const source = await createHarness("zip-partial-write");
    const seeded = await seedAsset(source, {
      assetId: "asset-partial-write",
      artifactId: "artifact-partial-write",
      fill: 0x66
    });
    const requestedOutput = path.join(source.root, "exports", "partial.zip");
    await mkdir(path.dirname(requestedOutput), { recursive: true });
    await writeFile(requestedOutput, "preserve-existing", "utf8");

    const probeHandle = await open(path.join(source.root, "file-handle-prototype-probe"), "w");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
      write: (
        this: object,
        buffer: Uint8Array
      ) => Promise<{ readonly bytesWritten: number; readonly buffer: Uint8Array }>;
    };
    const originalWrite = fileHandlePrototype.write;
    await probeHandle.close();
    let partialCalls = 0;
    fileHandlePrototype.write = async function (buffer) {
      const length = buffer.byteLength > 1 ? Math.ceil(buffer.byteLength / 2) : buffer.byteLength;
      if (length < buffer.byteLength) partialCalls += 1;
      return await originalWrite.call(this, buffer.subarray(0, length));
    };

    const publicExport = await (async () => {
      try {
        return await source.service.manageLibrary({
          action: "export-zip",
          assetIds: [seeded.assetId],
          outputPath: requestedOutput
        });
      } finally {
        fileHandlePrototype.write = originalWrite;
      }
    })();

    expect(partialCalls).toBeGreaterThan(0);
    expect(await readFile(requestedOutput, "utf8")).toBe("preserve-existing");
    expect(publicExport.outputPath).toBe(path.join(source.root, "exports", "partial-2.zip"));
    const exportedBytes = await readFile(publicExport.outputPath!);
    expect(() => decodeZipArchive(exportedBytes)).not.toThrow();

    const target = await createHarness("zip-partial-write-import");
    const imported = await target.service.manageLibrary({
      action: "import-zip",
      zipPath: publicExport.outputPath!
    });
    expect(imported).toMatchObject({ importedCount: 1, skippedCount: 0 });
  });

  it("rejects a public ZIP destination whose symlink or junction resolves into a protected root", async () => {
    const source = await createHarness("zip-protected-link", {
      publicProtectedRoots: (root) => [path.join(root, "protected-legacy")]
    });
    const seeded = await seedAsset(source, {
      assetId: "asset-protected-link",
      artifactId: "artifact-protected-link",
      fill: 0x77
    });
    const protectedRoot = path.join(source.root, "protected-legacy");
    const apparentSafeRoot = path.join(source.root, "apparently-safe");
    const protectedExisting = path.join(protectedRoot, "export.zip");
    await mkdir(protectedRoot, { recursive: true });
    await writeFile(protectedExisting, "preserve-protected-existing", "utf8");
    await symlink(
      protectedRoot,
      apparentSafeRoot,
      process.platform === "win32" ? "junction" : "dir"
    );

    await expect(
      source.service.manageLibrary({
        action: "export-zip",
        assetIds: [seeded.assetId],
        outputPath: path.join(apparentSafeRoot, "export.zip")
      })
    ).rejects.toMatchObject({ code: "path_unsafe" });
    expect(await readFile(protectedExisting, "utf8")).toBe("preserve-protected-existing");
    await expect(access(path.join(protectedRoot, "export-2.zip"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("rejects a public ZIP directory redirected through a final symlink or junction", async () => {
    const source = await createHarness("zip-redirected-directory");
    const seeded = await seedAsset(source, {
      assetId: "asset-redirected-directory",
      artifactId: "artifact-redirected-directory"
    });
    const actualRoot = path.join(source.root, "actual-output");
    const redirectedRoot = path.join(source.root, "redirected-output");
    await mkdir(actualRoot, { recursive: true });
    await symlink(actualRoot, redirectedRoot, process.platform === "win32" ? "junction" : "dir");

    await expect(
      source.service.manageLibrary({
        action: "export-zip",
        assetIds: [seeded.assetId],
        outputPath: path.join(redirectedRoot, "export.zip")
      })
    ).rejects.toMatchObject({ code: "path_unsafe" });
    await expect(access(path.join(actualRoot, "export.zip"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
