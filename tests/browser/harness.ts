import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import type { Page, Request as PlaywrightRequest } from "@playwright/test";

const execFileAsync = promisify(execFile);

export const STUDIO_SESSION_TOKEN = "routego-studio-synthetic-session-token";
const configuredStudioPort = Number.parseInt(process.env["ROUTEGO_STUDIO_TEST_PORT"] ?? "", 10);
const studioPort = Number.isInteger(configuredStudioPort) && configuredStudioPort > 0 && configuredStudioPort <= 65_535
  ? configuredStudioPort
  : 42_000 + (process.pid % 2_000);
export const STUDIO_BASE_URL = `http://127.0.0.1:${studioPort}`;

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const mockServiceModuleUrl = `/@fs/${path
  .join(repositoryRoot, "packages/mock-relay/src/service/mock-service.ts")
  .replaceAll("\\", "/")}`;
const mockHandlerModuleUrl = `/@fs/${path
  .join(repositoryRoot, "packages/studio/src/dev/mock-handler.ts")
  .replaceAll("\\", "/")}`;

type MockServiceFixture =
  | "success"
  | "failure"
  | "partial"
  | "degraded"
  | "invalid-output"
  | "expired"
  | "not-found"
  | "invalid-type"
  | "oversize"
  | "checksum-failed"
  | "consumed"
  | "discarded";
type MockServiceOperation = string;

interface ViteModuleServer {
  close(): Promise<void>;
  ssrLoadModule(url: string): Promise<Record<string, unknown>>;
}

let mockModuleServer: ViteModuleServer | undefined;

const secretKeyPattern = /(?:api[-_ ]?key|authorization|cookie|secret|session|token)/iu;
const sensitiveValuePattern = /(?:bearer\s+\S+|data:image\/|;base64,|[A-Za-z]:[\\/]|file:\/\/)/iu;

export interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | undefined;
}

export interface BrowserSecurityAudit {
  readonly consoleMessages: string[];
  readonly pageErrors: string[];
  readonly requests: CapturedRequest[];
  readonly sanitizedTranscript: string[];
}

export interface StudioServer {
  readonly process: ChildProcess;
  readonly output: readonly string[];
}

function appendOutput(target: string[], chunk: Buffer | string): void {
  target.push(chunk.toString());
  if (target.length > 80) target.splice(0, target.length - 80);
}

async function waitForStudio(process: ChildProcess, output: readonly string[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`Studio Vite exited before readiness.\n${output.join("")}`);
    }
    try {
      const response = await fetch(STUDIO_BASE_URL, { redirect: "error" });
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Studio Vite did not become ready.\n${output.join("")}`);
}

export async function startStudioServer(): Promise<StudioServer> {
  const output: string[] = [];
  const command = process.platform === "win32" ? process.env["ComSpec"] ?? "cmd.exe" : "pnpm";
  const args =
    process.platform === "win32"
      ? [
          "/d",
          "/s",
          "/c",
          `pnpm --filter @routego-image/studio dev --port ${studioPort} --strictPort`
        ]
      : [
          "--filter",
          "@routego-image/studio",
          "dev",
          "--port",
          String(studioPort),
          "--strictPort"
        ];
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ROUTEGO_STUDIO_MOCK: "1",
      ROUTEGO_STUDIO_MOCK_SESSION: STUDIO_SESSION_TOKEN
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32"
  });
  child.stdout?.on("data", (chunk: Buffer) => appendOutput(output, chunk));
  child.stderr?.on("data", (chunk: Buffer) => appendOutput(output, chunk));
  await waitForStudio(child, output);
  return { process: child, output };
}

export async function stopStudioServer(server: StudioServer | undefined): Promise<void> {
  await mockModuleServer?.close();
  mockModuleServer = undefined;
  if (server === undefined || server.process.exitCode !== null) return;
  if (process.platform === "win32" && server.process.pid !== undefined) {
    await execFileAsync("taskkill", ["/pid", String(server.process.pid), "/T", "/F"])
      .catch(() => undefined);
    return;
  }
  if (server.process.pid !== undefined) {
    process.kill(-server.process.pid, "SIGTERM");
  } else {
    server.process.kill("SIGTERM");
  }
}

async function loadMockModules(): Promise<{
  createMockRoutegoService: (options: {
    readonly fixtureByOperation: Partial<Record<MockServiceOperation, MockServiceFixture>>;
  }) => unknown;
  createStudioMockHandler: (options: {
    readonly service: never;
    readonly sessionToken: string;
  }) => (request: Request) => Promise<Response | undefined>;
}> {
  if (mockModuleServer === undefined) {
    const studioRequire = createRequire(
      path.join(repositoryRoot, "packages/studio/package.json")
    );
    const viteEntry = studioRequire.resolve("vite");
    const viteModule = (await import(pathToFileURL(viteEntry).href)) as {
      readonly createServer: (config: unknown) => Promise<ViteModuleServer>;
    };
    mockModuleServer = await viteModule.createServer({
      configFile: false,
      appType: "custom",
      server: { middlewareMode: true },
      resolve: { conditions: ["development"] },
      ssr: {
        noExternal: [
          "@routego-image/contracts",
          "@routego-image/foundation",
          "@routego-image/mock-relay"
        ]
      }
    });
  }
  const [serviceModule, handlerModule] = await Promise.all([
    mockModuleServer.ssrLoadModule(mockServiceModuleUrl),
    mockModuleServer.ssrLoadModule(mockHandlerModuleUrl)
  ]);
  const createMockRoutegoService = serviceModule["createMockRoutegoService"];
  const createStudioMockHandler = handlerModule["createStudioMockHandler"];
  if (
    typeof createMockRoutegoService !== "function" ||
    typeof createStudioMockHandler !== "function"
  ) {
    throw new Error("The deterministic Studio mock modules could not be loaded.");
  }
  return { createMockRoutegoService, createStudioMockHandler };
}

function sanitizeUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeUnknown);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        secretKeyPattern.test(key) ? "[REDACTED]" : sanitizeUnknown(item)
      ])
    );
  }
  if (typeof value === "string" && sensitiveValuePattern.test(value)) {
    return "[REDACTED]";
  }
  return value;
}

function sanitizeText(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return value;
  try {
    return JSON.stringify(sanitizeUnknown(JSON.parse(value) as unknown));
  } catch {
    return sensitiveValuePattern.test(value) ? "[REDACTED]" : value;
  }
}

function capturedRequest(request: PlaywrightRequest): CapturedRequest {
  const body = request.postData() ?? undefined;
  return {
    method: request.method(),
    url: request.url(),
    headers: request.headers(),
    ...(body === undefined ? {} : { body })
  };
}

export function observeBrowserSecurity(page: Page): BrowserSecurityAudit {
  const audit: BrowserSecurityAudit = {
    consoleMessages: [],
    pageErrors: [],
    requests: [],
    sanitizedTranscript: []
  };
  page.on("console", (message) => {
    audit.consoleMessages.push(`${message.type()}:${message.text()}`);
  });
  page.on("pageerror", (error) => {
    audit.pageErrors.push(error.message);
  });
  page.on("request", (request) => {
    const captured = capturedRequest(request);
    audit.requests.push(captured);
    if (!captured.url.includes("/api/v1/")) return;
    const sanitizedHeaders = Object.fromEntries(
      Object.entries(captured.headers).map(([key, value]) => [
        key,
        secretKeyPattern.test(key) ? "[REDACTED]" : value
      ])
    );
    audit.sanitizedTranscript.push(
      JSON.stringify({
        method: captured.method,
        url: sanitizeText(captured.url),
        headers: sanitizedHeaders,
        body: sanitizeText(captured.body)
      })
    );
  });
  return audit;
}

async function toWebRequest(request: PlaywrightRequest): Promise<Request> {
  const body = request.postDataBuffer() ?? undefined;
  return new Request(request.url(), {
    method: request.method(),
    headers: await request.allHeaders(),
    ...(body === undefined ? {} : { body })
  });
}

export async function installDeterministicMock(
  page: Page,
  fixtureByOperation: Partial<Record<MockServiceOperation, MockServiceFixture>> = {},
  options: { readonly initiallyConfigured?: boolean } = {}
): Promise<void> {
  const { createMockRoutegoService, createStudioMockHandler } = await loadMockModules();
  const service = createMockRoutegoService({ fixtureByOperation, ...options });
  const handler = createStudioMockHandler({
    service: service as never,
    sessionToken: STUDIO_SESSION_TOKEN
  });
  await page.route("**/api/v1/**", async (route) => {
    const response = await handler(await toWebRequest(route.request()));
    if (response === undefined) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: Buffer.from(await response.arrayBuffer())
    });
  });
}

export async function installSyntheticFaviconBoundary(page: Page): Promise<void> {
  await page.route("**/favicon.ico", async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });
}

export async function installSyntheticStudioBootstrap(
  page: Page,
  sessionToken = STUDIO_SESSION_TOKEN
): Promise<void> {
  await page.addInitScript(({ token }) => {
    Object.defineProperty(globalThis, "__ROUTEGO_STUDIO_SESSION__", {
      value: Object.freeze({
        sessionToken: token,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      }),
      configurable: false
    });
  }, { token: sessionToken });
}

export async function openStudio(
  page: Page,
  options: { readonly firstRun?: boolean } = {}
): Promise<void> {
  await installSyntheticFaviconBoundary(page);
  await installSyntheticStudioBootstrap(page);
  await page.goto("/");
  await page.getByRole("heading", {
    name: options.firstRun ? "完成首次连接" : "把想法放进显影盘"
  }).waitFor();
}

export const syntheticPng = {
  name: "synthetic-reference.png",
  mimeType: "image/png",
  buffer: Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00,
    0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xfc, 0xff, 0x1f, 0x00,
    0x02, 0xeb, 0x01, 0xf5, 0x8f, 0x59, 0x56, 0xdf, 0x00, 0x00, 0x00, 0x00,
    0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
  ])
} as const;

export const syntheticZip = {
  name: "synthetic-library.zip",
  mimeType: "application/zip",
  buffer: Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(252)])
} as const;
