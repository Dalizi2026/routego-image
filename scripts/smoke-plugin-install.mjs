#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

import { verifyPluginPackage } from "./verify-plugin-package.mjs";

export const ACCEPTED_ARTIFACT_MANIFEST_SHA256 =
  "2b3dc2d607cf6f82891cd3a1a3920e784196dc7d5627d8ad6b1c5ec9aeb2fee5";

const ROOT_PREFIX = "routego-plugin-install-smoke-";
const OWNER_MARKER = ".routego-install-smoke-owner.json";
const OWNER_PURPOSE = "routego-image-task-5.3-install-smoke";
const REQUEST_TIMEOUT_MS = 15_000;
const EXPECTED_TOOLS = [
  "routego_batch",
  "routego_edit",
  "routego_generate",
  "routego_manage_library",
  "routego_open_studio",
  "routego_search_library",
  "routego_status"
];
const SYNTHETIC_PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
  0, 0, 0, 13, 73, 68, 65, 84, 120, 1, 99, 80, 77, 126, 253, 31,
  0, 4, 151, 2, 115, 164, 173, 44, 142, 0, 0, 0, 0, 73, 69, 78, 68,
  174, 66, 96, 130
]);

function fail(message) {
  throw new Error(`Routego plugin install smoke failed: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, "en"));
  const expected = [...keys].sort((left, right) => left.localeCompare(right, "en"));
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function createOwnedTemporaryRoot(parentDirectory) {
  const requestedParent = path.resolve(parentDirectory ?? os.tmpdir());
  await mkdir(requestedParent, { recursive: true });
  const parent = await realpath(requestedParent);
  const root = await mkdtemp(path.join(parent, ROOT_PREFIX));
  const marker = {
    schemaVersion: 1,
    purpose: OWNER_PURPOSE,
    rootName: path.basename(root),
    nonce: randomUUID()
  };
  await writeFile(path.join(root, OWNER_MARKER), `${JSON.stringify(marker)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  return root;
}

export async function cleanupOwnedTemporaryRoot(directory) {
  const requested = path.resolve(directory);
  const metadata = await lstat(requested);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() ||
      !path.basename(requested).startsWith(ROOT_PREFIX)) {
    fail("cleanup refused a directory that is not an owned temporary root");
  }
  let marker;
  try {
    const markerMetadata = await lstat(path.join(requested, OWNER_MARKER));
    if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()) {
      fail("cleanup refused an invalid owned temporary root marker");
    }
    marker = JSON.parse(await readFile(path.join(requested, OWNER_MARKER), "utf8"));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Routego plugin install smoke failed:")) throw error;
    fail("cleanup refused a directory without a valid owned temporary root marker");
  }
  if (!exactKeys(marker, ["schemaVersion", "purpose", "rootName", "nonce"]) ||
      marker.schemaVersion !== 1 || marker.purpose !== OWNER_PURPOSE ||
      marker.rootName !== path.basename(requested) ||
      typeof marker.nonce !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(marker.nonce)) {
    fail("cleanup refused an invalid owned temporary root marker");
  }
  await rm(requested, { recursive: true, force: false });
}

function sanitizeDiagnostic(value, temporaryRoot) {
  return value.replaceAll(temporaryRoot, "<smoke-root>").slice(-4_000);
}

class AppServerClient {
  #child;
  #nextId = 1;
  #pending = new Map();
  #stdoutBuffer = "";
  #stderr = "";
  #closed = false;

  constructor(executable, options) {
    this.#child = spawn(executable, [
      "app-server",
      "--stdio",
      "--disable",
      "web_search_request",
      "--disable",
      "apps"
    ], {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => this.#receive(chunk));
    this.#child.stderr.on("data", (chunk) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-8_000);
    });
    this.#child.once("error", (error) => this.#rejectAll(error));
    this.#child.once("close", (code, signal) => {
      this.#closed = true;
      this.#rejectAll(new Error(
        `Codex app-server exited before the smoke completed (code=${String(code)}, signal=${String(signal)}).`
      ));
    });
  }

  #receive(chunk) {
    this.#stdoutBuffer += chunk;
    for (;;) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#stdoutBuffer.slice(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (line.trim() === "") continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#rejectAll(new Error("Codex app-server emitted invalid JSON-RPC output."));
        continue;
      }
      if (message.id === undefined || !this.#pending.has(message.id)) continue;
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error !== undefined) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    }
  }

  #rejectAll(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  request(method, params) {
    if (this.#closed) return Promise.reject(new Error("Codex app-server is closed."));
    const id = this.#nextId++;
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timeout });
    });
  }

  notify(method, params) {
    if (!this.#closed) {
      const message = params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
      this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  }

  async close(temporaryRoot) {
    if (this.#closed) return;
    this.#child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => this.#child.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1_000))
    ]);
    if (!this.#closed) {
      this.#child.kill("SIGKILL");
      await new Promise((resolve) => this.#child.once("close", resolve));
    }
    if (this.#pending.size > 0) {
      fail(`Codex app-server closed with pending requests: ${sanitizeDiagnostic(this.#stderr, temporaryRoot)}`);
    }
  }

  diagnostic(temporaryRoot) {
    return sanitizeDiagnostic(this.#stderr, temporaryRoot);
  }
}

class StreamRpcClient {
  #input;
  #nextId = 1;
  #pending = new Map();
  #buffer = "";

  constructor(input, output) {
    this.#input = input;
    output.setEncoding("utf8");
    output.on("data", (chunk) => {
      this.#buffer += chunk;
      for (;;) {
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) return;
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line.trim() === "") continue;
        const message = JSON.parse(line);
        const pending = this.#pending.get(message.id);
        if (pending === undefined) continue;
        this.#pending.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error !== undefined) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
    });
  }

  request(method, params) {
    const id = this.#nextId++;
    this.#input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params })
    })}\n`);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`installed runtime MCP request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timeout });
    });
  }
}

function parsedToolResult(result) {
  if (result?.isError === true) fail("an MCP tool returned an error result");
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.find((entry) => entry?.type === "text")?.text;
  if (typeof text !== "string") fail("an MCP tool did not return structured JSON text");
  try {
    return JSON.parse(text);
  } catch {
    fail("an MCP tool returned invalid JSON text");
  }
}

function collectExactArtifactPhases(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectExactArtifactPhases(item, output);
    return output;
  }
  if (value === null || typeof value !== "object") return output;
  if (Array.isArray(value.enum) && value.enum.length === 2 &&
      value.enum.includes("partial") && value.enum.includes("final")) {
    output.add("partial");
    output.add("final");
  }
  for (const child of Object.values(value)) collectExactArtifactPhases(child, output);
  return output;
}

function sessionTokenFromBootstrap(html) {
  const match = /"sessionToken":"([A-Za-z0-9_-]+)"/u.exec(html);
  if (match?.[1] === undefined) fail("Studio bootstrap did not contain an in-memory session token");
  return match[1];
}

async function checkedJson(response, expectedStatus = 200) {
  const text = await response.text();
  if (response.status !== expectedStatus) {
    fail(`Studio API returned HTTP ${response.status} instead of ${expectedStatus}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail("Studio API returned invalid JSON");
  }
}

function parseSseEvents(text) {
  return text.split(/\r?\n\r?\n/u).filter((record) => record.trim() !== "").map((record) => {
    const fields = new Map();
    for (const line of record.split(/\r?\n/u)) {
      const separator = line.indexOf(":");
      if (separator < 0) fail("Studio stream emitted an invalid SSE field");
      const name = line.slice(0, separator);
      const value = line.slice(separator + 1).replace(/^ /u, "");
      const existing = fields.get(name);
      fields.set(name, existing === undefined ? value : `${existing}\n${value}`);
    }
    if (!fields.has("id") || !fields.has("event") || !fields.has("data") || fields.size !== 3) {
      fail("Studio stream did not use the frozen id/event/data SSE framing");
    }
    let event;
    try {
      event = JSON.parse(fields.get("data"));
    } catch {
      fail("Studio stream emitted invalid JSON event data");
    }
    if (event.type !== fields.get("event") ||
        `${event.requestId}:${event.sequence}` !== fields.get("id")) {
      fail("Studio stream SSE fields disagree with the event payload");
    }
    return event;
  });
}

function studioHeaders(origin, sessionToken, json = false) {
  return {
    origin,
    "x-routego-session": sessionToken,
    ...(json ? { "content-type": "application/json; charset=utf-8" } : {})
  };
}

async function exerciseStudio(urlText, installedPackage, folderId) {
  const launchUrl = new URL(urlText);
  if (launchUrl.protocol !== "http:" || launchUrl.hostname !== "127.0.0.1" ||
      launchUrl.pathname !== "/" || launchUrl.searchParams.size !== 1 ||
      !launchUrl.searchParams.has("token")) {
    fail("Studio launch URL is not a single-use IPv4 loopback URL");
  }
  const bootstrapResponse = await fetch(launchUrl, { redirect: "error" });
  if (bootstrapResponse.status !== 200) fail("Studio bootstrap did not load");
  const bootstrap = await bootstrapResponse.text();
  const sessionToken = sessionTokenFromBootstrap(bootstrap);
  if (bootstrap.includes(launchUrl.searchParams.get("token"))) {
    fail("Studio bootstrap retained the one-time launch token");
  }
  const origin = launchUrl.origin;
  const assetManifest = JSON.parse(
    await readFile(path.join(installedPackage, "runtime/studio-assets.json"), "utf8")
  );
  const assetRoutes = Object.keys(assetManifest.assets ?? {});
  if (assetRoutes.length === 0 || !assetRoutes.includes(assetManifest.entryModuleRoute)) {
    fail("Studio asset manifest is incomplete");
  }
  for (const route of assetRoutes) {
    const response = await fetch(new URL(route, origin), { redirect: "error" });
    if (response.status !== 200 || (await response.arrayBuffer()).byteLength === 0) {
      fail("a hashed Studio static asset did not load");
    }
  }

  const status = await checkedJson(await fetch(
    new URL("/api/v1/status?refreshCapabilities=false", origin),
    { headers: studioHeaders(origin, sessionToken) }
  ));
  if (status.configured !== false || status.service?.status !== "ready") {
    fail("Studio offline status is not ready and unconfigured");
  }

  const folders = await checkedJson(await fetch(
    new URL("/api/v1/library/folders", origin),
    { headers: studioHeaders(origin, sessionToken) }
  ));
  const folderCollection = Array.isArray(folders) ? folders : folders.folders;
  if (!Array.isArray(folderCollection) ||
      !folderCollection.some((folder) => folder?.folderId === folderId || folder?.id === folderId)) {
    fail("Studio did not observe the folder identity created through MCP");
  }

  const pngSha256 = sha256(SYNTHETIC_PNG);
  const reserve = await checkedJson(await fetch(new URL("/api/v1/uploads/reserve", origin), {
    method: "POST",
    headers: studioHeaders(origin, sessionToken, true),
    body: JSON.stringify({
      schemaVersion: 1,
      purpose: "image",
      declaredMimeType: "image/png",
      declaredByteLength: SYNTHETIC_PNG.byteLength,
      expectedSha256: pngSha256
    })
  }));
  const upload = reserve.resource;
  if (reserve.status !== "succeeded" || typeof upload?.uploadResourceId !== "string") {
    fail("Studio upload reservation failed");
  }
  const staged = await checkedJson(await fetch(new URL(upload.binaryUpload.relativeUrl, origin), {
    method: "PUT",
    headers: {
      ...studioHeaders(origin, sessionToken),
      "content-type": "image/png",
      "content-length": String(SYNTHETIC_PNG.byteLength)
    },
    body: SYNTHETIC_PNG
  }));
  if (staged.status !== "succeeded" || staged.resource?.status !== "uploaded") {
    fail("Studio upload staging failed");
  }
  const finalized = await checkedJson(await fetch(new URL("/api/v1/uploads/finalize", origin), {
    method: "POST",
    headers: studioHeaders(origin, sessionToken, true),
    body: JSON.stringify({ schemaVersion: 1, uploadResourceId: upload.uploadResourceId })
  }));
  if (finalized.status !== "succeeded" || finalized.resource?.status !== "finalized" ||
      finalized.resource?.finalized?.sha256 !== pngSha256) {
    fail("Studio upload finalization failed");
  }
  const uploadStatus = await checkedJson(await fetch(new URL("/api/v1/uploads/status", origin), {
    method: "POST",
    headers: studioHeaders(origin, sessionToken, true),
    body: JSON.stringify({ schemaVersion: 1, uploadResourceId: upload.uploadResourceId })
  }));
  if (uploadStatus.resource?.uploadResourceId !== upload.uploadResourceId ||
      uploadStatus.resource?.status !== "finalized") {
    fail("Studio could not read the finalized upload resource");
  }

  const missingResource = await fetch(
    new URL("/api/v1/resources/synthetic-missing-resource", origin),
    { headers: studioHeaders(origin, sessionToken) }
  );
  if (missingResource.status !== 404) fail("Studio did not safely reject a missing resource");

  const streamResponse = await fetch(new URL("/api/v1/studio/creation/stream", origin), {
    method: "POST",
    headers: studioHeaders(origin, sessionToken, true),
    body: JSON.stringify({
      schemaVersion: 1,
      kind: "generate",
      prompt: "Synthetic offline installation smoke"
    })
  });
  if (streamResponse.status !== 200) fail("Studio creation stream did not open");
  if (!streamResponse.headers.get("content-type")?.startsWith("text/event-stream")) {
    fail("Studio creation stream did not use SSE");
  }
  const events = parseSseEvents(await streamResponse.text());
  const terminal = events.at(-1);
  if (events.map((event) => event.type).join(",") !== "started,partial,completed" ||
      terminal?.result?.status !== "succeeded") {
    fail("Studio synthetic creation stream did not complete with the frozen event sequence");
  }
  const protectedResource = terminal.result.finalArtifacts?.[0]?.resource;
  if (typeof protectedResource?.relativeUrl !== "string" ||
      protectedResource.requiresSession !== true) {
    fail("Studio stream did not return a protected final resource");
  }
  const protectedResponse = await fetch(new URL(protectedResource.relativeUrl, origin), {
    headers: studioHeaders(origin, sessionToken)
  });
  const protectedBytes = new Uint8Array(await protectedResponse.arrayBuffer());
  if (protectedResponse.status !== 200 || sha256(protectedBytes) !== sha256(SYNTHETIC_PNG)) {
    fail("Studio protected resource did not return the synthetic PNG bytes");
  }

  return {
    bootstrapLoaded: true,
    staticAssetsLoaded: true,
    statusConfigured: false,
    uploadFinalized: true,
    uploadResourceReadable: true,
    missingResourceRejected: true,
    streamTerminalType: terminal.type,
    sharedLibraryIdentity: true
  };
}

function syntheticArtifact(id, phase) {
  return {
    id,
    slot: 0,
    phase,
    mimeType: "image/png",
    byteLength: SYNTHETIC_PNG.byteLength,
    width: 1,
    height: 1,
    sha256: sha256(SYNTHETIC_PNG),
    display: {
      type: "image",
      dataUrl: `data:image/png;base64,${Buffer.from(SYNTHETIC_PNG).toString("base64")}`
    },
    createdAt: new Date().toISOString()
  };
}

async function syntheticExecution(request, context) {
  const partial = syntheticArtifact(`${context.requestId}:synthetic-partial`, "partial");
  const final = syntheticArtifact(`${context.requestId}:synthetic-final`, "final");
  await context.onEvent?.({
    type: "partial",
    requestId: context.requestId,
    sequence: 1,
    occurredAt: new Date().toISOString(),
    artifact: partial
  });
  return {
    schemaVersion: 1,
    requestId: context.requestId,
    status: "succeeded",
    requestedParams: request,
    effectiveParams: request,
    execution: {
      transport: "single-endpoint-json",
      attemptCount: 1,
      providerRequestCount: 1,
      receivedAnyOutput: true,
      mayHaveBilled: true,
      degradedContinuation: false,
      providerImageIds: []
    },
    finalArtifacts: [final],
    partialArtifacts: [partial],
    failedSlots: [],
    relationships: [
      { inputRole: "stream-partial", outputArtifactId: partial.id, order: 0 },
      { inputRole: "output", outputArtifactId: final.id, order: 1 }
    ]
  };
}

async function exerciseSyntheticInstalledRuntime(paths, folderId) {
  const runtimeModule = await import(
    `${pathToFileURL(path.join(paths.installedPackage, "runtime/index.js")).href}?smoke=${randomUUID()}`
  );
  if (typeof runtimeModule.createProductionRoutegoMcpProcess !== "function") {
    fail("the installed runtime does not expose its production MCP composition boundary");
  }
  const staticManifest = JSON.parse(
    await readFile(path.join(paths.installedPackage, "runtime/studio-assets.json"), "utf8")
  );
  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  let diagnostics = "";
  error.setEncoding("utf8").on("data", (chunk) => { diagnostics += chunk; });
  const runtime = await runtimeModule.createProductionRoutegoMcpProcess({
    homeDirectory: paths.home,
    runtimeRoot: path.join(paths.data, "synthetic-runtime"),
    stagingRoot: path.join(paths.data, "synthetic-staging"),
    staticAssets: {
      rootDirectory: path.join(paths.installedPackage, "runtime/studio"),
      assets: staticManifest.assets
    },
    entryModuleRoute: staticManifest.entryModuleRoute,
    styleRoutes: staticManifest.styleRoutes,
    input,
    output,
    error,
    serviceOptions: {
      executeCreation: syntheticExecution,
      defaultModel: "synthetic-model"
    }
  });
  const mcp = new StreamRpcClient(input, output);
  try {
    await runtime.start();
    const initialized = await mcp.request("initialize");
    if (initialized?.serverInfo?.name !== "routego-image" ||
        initialized?.serverInfo?.version !== "1.0.0") {
      fail("the isolated synthetic runtime did not initialize as Routego Image 1.0.0");
    }
    const studioLaunch = parsedToolResult(await mcp.request("tools/call", {
      name: "routego_open_studio",
      arguments: { reuseExisting: false, address: "127.0.0.1" }
    }));
    const studio = await exerciseStudio(studioLaunch.url, paths.installedPackage, folderId);
    if (diagnostics !== "") fail("the isolated synthetic runtime emitted a diagnostic");
    return studio;
  } finally {
    await runtime.shutdown("install-smoke-complete");
  }
}

function childEnvironment(paths) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: paths.home,
    CODEX_HOME: paths.codexHome,
    TMPDIR: paths.temp,
    TMP: paths.temp,
    TEMP: paths.temp,
    NODE_PATH: "",
    CI: "1",
    NO_COLOR: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost"
  };
}

async function runInsideOwnedRoot(options, root, verification) {
  const paths = {
    home: path.join(root, "home"),
    codexHome: path.join(root, "codex-home"),
    workspace: path.join(root, "workspace"),
    temp: path.join(root, "temp"),
    data: path.join(root, "data"),
    output: path.join(root, "output"),
    installedPackage: path.join(root, "install", "routego-image")
  };
  await Promise.all([
    mkdir(paths.home, { recursive: true }),
    mkdir(paths.codexHome, { recursive: true }),
    mkdir(paths.workspace, { recursive: true }),
    mkdir(paths.temp, { recursive: true }),
    mkdir(paths.data, { recursive: true }),
    mkdir(paths.output, { recursive: true }),
    cp(verification.root, paths.installedPackage, { recursive: true })
  ]);
  const copiedVerification = await verifyPluginPackage(paths.installedPackage);
  if (copiedVerification.artifactManifestFileSha256 !== options.acceptedArtifactManifestSha256) {
    fail("the isolated package copy changed after strict verification");
  }

  const client = new AppServerClient(options.codexExecutable, {
    cwd: paths.workspace,
    environment: childEnvironment(paths)
  });
  try {
    const initialized = await client.request("initialize", {
      clientInfo: { name: "routego-install-smoke", version: "1.0.0" },
      capabilities: { experimentalApi: true }
    });
    client.notify("initialized");
    if (await realpath(initialized.codexHome) !== await realpath(paths.codexHome)) {
      fail("Codex app-server did not use the isolated CODEX_HOME");
    }
    const started = await client.request("thread/start", {
      cwd: paths.workspace,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      runtimeWorkspaceRoots: [paths.workspace],
      selectedCapabilityRoots: [{
        id: "routego-image",
        location: {
          type: "environment",
          environmentId: "local",
          path: paths.installedPackage
        }
      }]
    });
    const threadId = started?.thread?.id;
    if (typeof threadId !== "string" || threadId.length === 0) fail("fresh Codex thread did not start");
    const mcpStatus = await client.request("mcpServerStatus/list", {
      threadId,
      detail: "full"
    });
    const server = mcpStatus?.data?.find((entry) => entry?.name === "routego-image");
    if (server?.serverInfo?.name !== "routego-image" || server?.serverInfo?.version !== "1.0.0") {
      fail("fresh Codex did not discover Routego Image 1.0.0");
    }
    const tools = Object.keys(server.tools ?? {}).sort((left, right) => left.localeCompare(right, "en"));
    if (JSON.stringify(tools) !== JSON.stringify(EXPECTED_TOOLS)) {
      fail("fresh Codex did not discover the exact seven frozen MCP tools");
    }
    const creationSchemas = ["routego_generate", "routego_edit", "routego_batch"]
      .map((name) => server.tools[name]?.outputSchema)
      .filter((schema) => schema !== undefined);
    if (creationSchemas.length > 0 &&
        JSON.stringify([...collectExactArtifactPhases(creationSchemas)]) !==
          JSON.stringify(["partial", "final"])) {
      fail("public creation artifacts do not expose exactly partial and final phases");
    }
    const runtimeText = await readFile(path.join(paths.installedPackage, "runtime/index.js"), "utf8");
    if (!/imageArtifactPhaseSchema\s*=\s*external_exports\.enum\(\["partial",\s*"final"\]\)/u
      .test(runtimeText)) {
      fail("the strict-verified runtime does not freeze public artifact phases to partial and final");
    }
    const publicArtifactPhases = ["partial", "final"];

    const status = parsedToolResult(await client.request("mcpServer/tool/call", {
      threadId,
      server: "routego-image",
      tool: "routego_status",
      arguments: { refreshCapabilities: false }
    }));
    if (status.configured !== false || status.hasApiKey !== false ||
        status.service?.status !== "ready" || status.service?.version !== "1.0.0") {
      fail("offline MCP status is not ready, unconfigured, and credential-free");
    }
    const managed = parsedToolResult(await client.request("mcpServer/tool/call", {
      threadId,
      server: "routego-image",
      tool: "routego_manage_library",
      arguments: { action: "create-folder", name: "Synthetic Shared Identity" }
    }));
    const folderId = managed.affectedFolderIds?.[0];
    if (managed.action !== "create-folder" || typeof folderId !== "string") {
      fail("MCP did not create the synthetic Library identity");
    }
    await client.close(root);
    const studio = await exerciseSyntheticInstalledRuntime(paths, folderId);

    const skillText = await readFile(
      path.join(paths.installedPackage, "skills/routego-image/SKILL.md"),
      "utf8"
    );
    if (!/[A-Za-z]{4}/u.test(skillText) || !/\p{Script=Han}/u.test(skillText) ||
        !EXPECTED_TOOLS.every((name) => skillText.includes(`\`${name}\``))) {
      fail("the installed Skill is not bilingual or does not name the exact seven tools");
    }

    return {
      artifact: {
        manifestSha256: options.acceptedArtifactManifestSha256,
        name: copiedVerification.contentManifest.name,
        version: copiedVerification.contentManifest.version,
        strictVerificationPassed: true
      },
      codex: {
        isolatedHome: true,
        isolatedCodexHome: true,
        freshProcess: true,
        pluginDiscovered: true,
        pluginVersion: server.serverInfo.version
      },
      skill: { bilingual: true, exactPublicToolCount: EXPECTED_TOOLS.length },
      mcp: {
        tools,
        publicArtifactPhases,
        configured: status.configured,
        serviceStatus: status.service.status,
        offlineSafe: status.hasApiKey === false && status.models.length === 0
      },
      studio,
      isolation: {
        sourceCheckoutIndependent: paths.workspace !== verification.root &&
          paths.installedPackage !== verification.root,
        nodeModulesIndependent: !copiedVerification.files.some((file) => file.split("/").includes("node_modules")),
        legacyStateUntouchedByHarness: true
      }
    };
  } catch (error) {
    const detail = client.diagnostic(root);
    const message = error instanceof Error ? error.message : "unknown error";
    throw new Error(`${message}${detail === "" ? "" : `\nCodex app-server diagnostic:\n${detail}`}`);
  } finally {
    await client.close(root);
  }
}

export async function runPluginInstallSmoke(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    fail("options are required");
  }
  const packageDirectory = path.resolve(options.packageDirectory);
  const acceptedArtifactManifestSha256 = options.acceptedArtifactManifestSha256 ??
    ACCEPTED_ARTIFACT_MANIFEST_SHA256;
  if (!/^[a-f0-9]{64}$/u.test(acceptedArtifactManifestSha256)) {
    fail("accepted artifact manifest SHA-256 must be 64 lowercase hexadecimal characters");
  }
  const artifactManifestBytes = await readFile(path.join(packageDirectory, "artifact-manifest.json"));
  const artifactManifestSha256 = sha256(artifactManifestBytes);
  if (artifactManifestSha256 !== acceptedArtifactManifestSha256) {
    fail("package does not match the accepted artifact manifest SHA-256");
  }
  const verification = await verifyPluginPackage(packageDirectory);
  if (verification.artifactManifestFileSha256 !== acceptedArtifactManifestSha256 ||
      verification.contentManifest.name !== "routego-image" ||
      verification.contentManifest.version !== "1.0.0") {
    fail("strict package verification did not return the accepted Routego Image 1.0.0 artifact");
  }
  const temporaryRoot = await createOwnedTemporaryRoot(options.temporaryParent);
  let result;
  let operationError;
  try {
    result = await runInsideOwnedRoot({
      acceptedArtifactManifestSha256,
      codexExecutable: path.resolve(
        options.codexExecutable ?? "/Applications/ChatGPT.app/Contents/Resources/codex"
      )
    }, temporaryRoot, verification);
  } catch (error) {
    operationError = error;
  }
  try {
    await cleanupOwnedTemporaryRoot(temporaryRoot);
  } catch (cleanupError) {
    if (operationError !== undefined) throw new AggregateError([operationError, cleanupError], "smoke and cleanup failed");
    throw cleanupError;
  }
  if (operationError !== undefined) throw operationError;
  return { ...result, cleanup: { removedOwnedRoot: true } };
}

function parseArguments(argv) {
  if (argv.length === 1) {
    return { packageDirectory: path.resolve(argv[0]) };
  }
  if (argv.length === 3 && argv[1] === "--artifact-sha256") {
    return {
      packageDirectory: path.resolve(argv[0]),
      acceptedArtifactManifestSha256: argv[2]
    };
  }
  throw new Error(
    "Usage: node scripts/smoke-plugin-install.mjs <routego-image-package> [--artifact-sha256 <sha256>]"
  );
}

async function main() {
  const result = await runPluginInstallSmoke(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Routego plugin install smoke failed."}\n`);
    process.exitCode = 1;
  });
}
