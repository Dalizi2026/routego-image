import { existsSync } from "node:fs";

import { chromium, expect, test, type Page } from "@playwright/test";

import {
  STUDIO_BASE_URL,
  STUDIO_SESSION_TOKEN,
  installDeterministicMock,
  installSyntheticFaviconBoundary,
  installSyntheticStudioBootstrap,
  observeBrowserSecurity,
  openStudio,
  startStudioServer,
  stopStudioServer,
  syntheticPng,
  type BrowserSecurityAudit,
  type StudioServer
} from "./harness";

test.describe.configure({ mode: "serial" });
test.use({ baseURL: STUDIO_BASE_URL });

const localBrowserFallback = [
  process.env["PROGRAMFILES"] === undefined
    ? undefined
    : `${process.env["PROGRAMFILES"]}\\Google\\Chrome\\Application\\chrome.exe`,
  process.env["PROGRAMFILES(X86)"] === undefined
    ? undefined
    : `${process.env["PROGRAMFILES(X86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].find((candidate): candidate is string => candidate !== undefined && existsSync(candidate));

if (!existsSync(chromium.executablePath()) && localBrowserFallback !== undefined) {
  test.use({ launchOptions: { executablePath: localBrowserFallback } });
}

let studioServer: StudioServer | undefined;

const STUDIO_CREATION_STREAM_PATH = "/api/v1/studio/creation/stream";
const STREAM_REGISTERED_AT = Date.parse("2026-01-01T00:00:00.000Z");
const STREAM_FULL_EXPIRY = Date.parse("2026-01-01T00:05:00.000Z");
const STREAM_NEAR_EXPIRY = Date.parse("2026-01-01T00:00:30.000Z");

interface RawStreamResource {
  readonly resourceId: string;
  readonly relativeUrl: string;
  readonly expiresAt: string;
}

interface RawStreamEvent {
  readonly type: string;
  readonly artifact?: { readonly resource?: RawStreamResource };
  readonly result?: {
    readonly finalArtifacts?: ReadonlyArray<{ readonly resource?: RawStreamResource }>;
  };
}

interface RawStreamProbe {
  readonly status: number;
  readonly contentType: string | null;
  readonly fixture: string | null;
  readonly chunkSizes: readonly number[];
  readonly body: string;
}

interface ResourceBoundaryState {
  now: number;
  shutdown: boolean;
  readonly expiresAtByResourceId: Map<string, number>;
}

interface SecurityExpectationOptions {
  readonly sensitiveMarkers?: readonly string[];
  readonly expectedSessionHeader?: string;
  readonly allowedConsoleHttpStatuses?: readonly number[];
  readonly allowedConsoleMessages?: readonly RegExp[];
}

test.beforeAll(async () => {
  studioServer = await startStudioServer();
});

test.afterAll(async () => {
  await stopStudioServer(studioServer);
});

async function expectSecurityClean(
  page: Page,
  audit: BrowserSecurityAudit,
  options: SecurityExpectationOptions = {}
): Promise<void> {
  const sensitiveMarkers = options.sensitiveMarkers ?? [];
  const expectedSessionHeader = options.expectedSessionHeader ?? STUDIO_SESSION_TOKEN;
  const allowedConsoleHttpStatuses = options.allowedConsoleHttpStatuses ?? [];
  const allowedConsoleMessages = options.allowedConsoleMessages ?? [];
  const body = await page.locator("body").innerText();
  const storage = await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage }
  }));
  const transcript = audit.sanitizedTranscript.join("\n");
  const diagnostics = [...audit.consoleMessages, ...audit.pageErrors].join("\n");

  expect(audit.pageErrors).toEqual([]);
  expect(body).not.toContain(STUDIO_SESSION_TOKEN);
  expect(JSON.stringify(storage)).not.toContain(STUDIO_SESSION_TOKEN);
  expect(transcript).not.toContain(STUDIO_SESSION_TOKEN);
  expect(diagnostics).not.toContain(STUDIO_SESSION_TOKEN);
  expect(transcript).not.toMatch(/authorization/iu);
  expect(transcript).not.toMatch(/data:image\//iu);
  expect(transcript).not.toMatch(/;base64,/iu);
  expect(transcript).not.toMatch(/[A-Za-z]:\\/u);
  expect(diagnostics).not.toMatch(/authorization|data:image\/|;base64,|[A-Za-z]:\\/iu);
  const unexpectedConsoleProblems = audit.consoleMessages.filter((message) => {
    if (!/^(?:warning|error):/iu.test(message)) return false;
    if (allowedConsoleMessages.some((pattern) => pattern.test(message))) return false;
    return !allowedConsoleHttpStatuses.some((status) =>
      message.includes(`server responded with a status of ${status}`)
    );
  });
  expect(unexpectedConsoleProblems).toEqual([]);
  for (const marker of sensitiveMarkers) {
    expect(body).not.toContain(marker);
    expect(JSON.stringify(storage)).not.toContain(marker);
    expect(transcript).not.toContain(marker);
    expect(diagnostics).not.toContain(marker);
  }

  for (const request of audit.requests) {
    const url = new URL(request.url);
    if (url.protocol === "http:" || url.protocol === "https:") {
      expect(url.origin).toBe(STUDIO_BASE_URL);
    }
  }

  for (const request of audit.requests.filter((item) => item.url.includes("/api/v1/"))) {
    expect(request.headers["authorization"]).toBeUndefined();
    expect(request.headers["cookie"]).toBeUndefined();
    expect(request.headers["x-routego-session"]).toBe(expectedSessionHeader);
    expect(request.url).not.toContain(STUDIO_SESSION_TOKEN);
    expect(request.body ?? "").not.toContain(STUDIO_SESSION_TOKEN);
    expect(request.body ?? "").not.toMatch(/data:image\/|;base64,|[A-Za-z]:\\/iu);
    expect(request.body ?? "").not.toMatch(/"(?:path|filePath|dataUrl|authorization)"\s*:/iu);
  }
}

async function submitTextGeneration(page: Page, prompt: string): Promise<void> {
  await page.getByLabel("提示词").fill(prompt);
  await page.getByRole("button", { name: "开始生成" }).click();
}

async function probeRawStream(page: Page, fixture: string): Promise<RawStreamProbe> {
  return page.evaluate(
    async ({ path, prompt, token }) => {
      const response = await fetch(path, {
        method: "POST",
        headers: {
          accept: "text/event-stream; charset=utf-8",
          "content-type": "application/json",
          "x-routego-session": token
        },
        body: JSON.stringify({ kind: "generate", prompt }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error"
      });
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("The deterministic stream omitted its body.");
      const decoder = new TextDecoder();
      const chunkSizes: number[] = [];
      let body = "";
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        chunkSizes.push(result.value.byteLength);
        body += decoder.decode(result.value, { stream: true });
      }
      body += decoder.decode();
      reader.releaseLock();
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        fixture: response.headers.get("x-routego-mock-stream-fixture"),
        chunkSizes,
        body
      };
    },
    {
      path: STUDIO_CREATION_STREAM_PATH,
      prompt: `mock-stream:${fixture}`,
      token: STUDIO_SESSION_TOKEN
    }
  );
}

function parseRawStreamEvents(body: string): readonly RawStreamEvent[] {
  return body
    .split(/\r?\n\r?\n/u)
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const data = record
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /u, ""))
        .join("\n");
      return JSON.parse(data) as RawStreamEvent;
    });
}

function partialResource(events: readonly RawStreamEvent[]): RawStreamResource {
  const resource = events.find((event) => event.type === "partial")?.artifact?.resource;
  if (resource === undefined) throw new Error("The deterministic stream omitted its partial resource.");
  return resource;
}

async function installStreamUiObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const observation = {
      states: [] as string[],
      resourceIds: [] as string[]
    };
    const capture = (): void => {
      for (const panel of document.querySelectorAll<HTMLElement>("[data-stream-state]")) {
        const state = panel.dataset["streamState"];
        if (state !== undefined && !observation.states.includes(state)) {
          observation.states.push(state);
        }
      }
      for (const card of document.querySelectorAll<HTMLElement>("[data-resource-id]")) {
        const resourceId = card.dataset["resourceId"];
        if (resourceId !== undefined && !observation.resourceIds.includes(resourceId)) {
          observation.resourceIds.push(resourceId);
        }
      }
    };
    const observer = new MutationObserver(capture);
    observer.observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true
    });
    capture();
    Object.defineProperty(window, "__routegoStreamUiObservation", {
      configurable: true,
      value: { observation, observer }
    });
  });
}

async function readStreamUiObservation(page: Page): Promise<{
  readonly states: readonly string[];
  readonly resourceIds: readonly string[];
}> {
  return page.evaluate(() => {
    const value = (window as unknown as {
      readonly __routegoStreamUiObservation?: {
        readonly observation: { readonly states: string[]; readonly resourceIds: string[] };
      };
    }).__routegoStreamUiObservation;
    return value?.observation ?? { states: [], resourceIds: [] };
  });
}

async function installResourceBoundary(page: Page): Promise<ResourceBoundaryState> {
  const state: ResourceBoundaryState = {
    now: STREAM_REGISTERED_AT,
    shutdown: false,
    expiresAtByResourceId: new Map()
  };
  await page.route("**/api/v1/resources/**", async (route) => {
    const resourceId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1) ?? "");
    const expiresAt =
      state.expiresAtByResourceId.get(resourceId) ??
      (resourceId.endsWith("-stream-partial-resource") ? STREAM_FULL_EXPIRY : Number.POSITIVE_INFINITY);
    if (state.shutdown) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "runtime_shutdown", safeMessage: "The local runtime is unavailable." } })
      });
      return;
    }
    if (state.now >= expiresAt) {
      await route.fulfill({
        status: 410,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "resource_expired", safeMessage: "The protected resource expired." } })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: {
        "cache-control": "no-store",
        "content-length": String(syntheticPng.buffer.byteLength)
      },
      body: syntheticPng.buffer
    });
  });
  return state;
}

async function fetchProtectedStatus(page: Page, relativeUrl: string): Promise<number> {
  return page.evaluate(
    async ({ relativeUrl: url, token }) => {
      try {
        const response = await fetch(url, {
          headers: {
            accept: "image/png",
            "x-routego-session": token
          },
          cache: "no-store",
          credentials: "omit",
          redirect: "error"
        });
        return response.status;
      } catch {
        return 0;
      }
    },
    { relativeUrl, token: STUDIO_SESSION_TOKEN }
  );
}

function expectExactStreamRequest(
  audit: BrowserSecurityAudit,
  prompt: string
): void {
  const request = audit.requests.find((item) => {
    if (new URL(item.url).pathname !== STUDIO_CREATION_STREAM_PATH) return false;
    try {
      return (JSON.parse(item.body ?? "{}") as { readonly prompt?: unknown }).prompt === prompt;
    } catch {
      return false;
    }
  });
  expect(request).toBeDefined();
  expect(request?.method).toBe("POST");
  expect(new URL(request?.url ?? STUDIO_BASE_URL).search).toBe("");
  expect(request?.headers["accept"]).toBe("text/event-stream; charset=utf-8");
  expect(request?.headers["content-type"]).toBe("application/json");
  expect(request?.headers["x-routego-session"]).toBe(STUDIO_SESSION_TOKEN);
  expect(request?.headers["authorization"]).toBeUndefined();
  expect(request?.headers["cookie"]).toBeUndefined();
}

test("secure boot blocks missing and rejected sessions, then keeps a valid localized responsive shell usable", async ({ page, context }) => {
  const audit = observeBrowserSecurity(page);
  await installSyntheticFaviconBoundary(page);

  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("本地会话缺失或无效");
  expect(audit.requests.some((request) => request.url.includes("/api/v1/"))).toBe(false);

  await page.route(/\/api\/v1\/(?:status|settings)(?:\?|$)/u, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    await route.continue();
  });
  await installSyntheticStudioBootstrap(page);
  const readyNavigation = page.goto("/");
  await expect(page.getByText("正在显影工作区")).toBeVisible();
  await readyNavigation;
  await expect(page.getByRole("heading", { name: "为 Codex 设定默认出图参数" })).toBeVisible();
  await expect(page).toHaveURL(`${STUDIO_BASE_URL}/`);
  await expect(page.getByRole("navigation", { name: "Studio 主导航" })).toBeVisible();

  await page.getByLabel("图片比例").selectOption("16:9");
  await page.getByRole("button", { name: "界面语言" }).click();
  await expect(page.getByRole("heading", { name: "Set Codex image defaults" })).toBeVisible();
  await expect(page.getByLabel("Aspect ratio")).toHaveValue("16:9");
  await expect(page.getByRole("button", { name: "Library" })).toBeVisible();

  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return active === null
      ? null
      : {
          tag: active.tagName,
          outline: getComputedStyle(active).outlineStyle,
          text: active.textContent?.trim() ?? ""
        };
  });
  expect(focused?.tag).not.toBe("BODY");

  await page.emulateMedia({ reducedMotion: "reduce" });
  const transitionDuration = await page.locator(".studio-nav__item").first().evaluate((element) =>
    getComputedStyle(element).transitionDuration
  );
  expect(Number.parseFloat(transitionDuration)).toBeLessThanOrEqual(0.00001);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileNavigation = await page.locator(".studio-nav").evaluate((element) => {
    const style = getComputedStyle(element);
    return { position: style.position, bottom: style.bottom };
  });
  expect(mobileNavigation).toEqual({ position: "fixed", bottom: "0px" });
  await page.getByRole("navigation", { name: "Studio primary navigation" }).getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Provider management" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
  await expect(page.getByText("Relay configuration & capability calibration")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await expectSecurityClean(page, audit);

  const rejectedSessionToken = "routego-studio-rejected-session-token";
  const rejectedPage = await context.newPage();
  const rejectedAudit = observeBrowserSecurity(rejectedPage);
  await installSyntheticFaviconBoundary(rejectedPage);
  await installSyntheticStudioBootstrap(rejectedPage, rejectedSessionToken);
  await rejectedPage.goto("/");
  await expect(rejectedPage.getByRole("heading", { name: "本地工作区无法载入" })).toBeVisible();
  await expect(rejectedPage.getByText("本地会话已失效或被拒绝。")).toBeVisible();
  await expect(rejectedPage.getByText("请关闭此页面，再从 Routego Image 重新打开 Studio。")).toBeVisible();
  await expect(rejectedPage.getByRole("heading", { name: "为 Codex 设定默认出图参数" })).toHaveCount(0);
  await expect(rejectedPage).toHaveURL(STUDIO_BASE_URL + "/");
  await expectSecurityClean(rejectedPage, rejectedAudit, {
    sensitiveMarkers: [rejectedSessionToken],
    expectedSessionHeader: rejectedSessionToken,
    allowedConsoleHttpStatuses: [401]
  });
  await rejectedPage.close();
});

test("first run connects with endpoint and key, fetches models once, then returns work to Codex", async ({ page }) => {
  const audit = observeBrowserSecurity(page);
  const replacementMarker = "synthetic-first-run-write-only-key";
  await installDeterministicMock(page, {}, { initiallyConfigured: false });
  await openStudio(page, { firstRun: true });

  await expect(page.getByRole("navigation", { name: "Studio 主导航" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "供应商管理" })).toBeVisible();
  await expect(page.getByLabel("调用端点")).toBeVisible();
  await expect(page.getByLabel("API Key")).toBeVisible();
  await expect(page.getByRole("button", { name: "获取模型" })).toBeVisible();
  await expect(page.getByText("能力探测")).toHaveCount(0);
  await expect(page.getByText("生成默认值")).toHaveCount(0);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("heading", { name: "供应商管理" })).toBeVisible();
  const desktopSetupBox = await page.locator(".provider-manager").boundingBox();
  expect(desktopSetupBox?.width).toBeGreaterThan(600);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });

  const automaticOperations = audit.requests.filter((request) =>
    new URL(request.url).pathname.startsWith("/api/v1/") &&
    /refresh-models|probe|creation\/stream/u.test(new URL(request.url).pathname)
  );
  expect(automaticOperations).toEqual([]);

  await page.getByRole("button", { name: "界面语言" }).click();
  await expect(page.getByRole("heading", { name: "Provider management" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Get models" })).toBeVisible();
  await page.getByRole("button", { name: "Interface language" }).click();

  await page.getByLabel("调用端点").fill("https://first-run.invalid/");
  await page.getByLabel("API Key").fill(replacementMarker);
  await page.getByRole("button", { name: "获取模型" }).click();
  await expect(page.getByLabel("默认模型")).toHaveValue("mock-image-model");
  await page.getByRole("button", { name: "保存" }).click();

  await expect(page.getByRole("heading", { name: "为 Codex 设定默认出图参数" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(replacementMarker);

  const requestedOperations = audit.requests
    .map((request) => new URL(request.url).pathname)
    .filter((pathname) =>
      pathname.startsWith("/api/v1/") &&
      (pathname === "/api/v1/settings/providers/refresh-models" ||
        pathname.includes("/creation/stream"))
    );
  expect(requestedOperations).toEqual(["/api/v1/settings/providers/refresh-models"]);

  await expect(page.getByRole("navigation", { name: "Studio 主导航" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "为 Codex 设定默认出图参数" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expectSecurityClean(page, audit, { sensitiveMarkers: [replacementMarker] });
});

test.describe.skip("retired Studio stream controls", () => {
test("creation reports success, partial, failure, and degraded outcomes without automatic replay", async ({ context }) => {
  const scenarios = [
    { fixture: "success", title: "图像已生成" },
    { fixture: "partial", title: "部分图像已保留" },
    { fixture: "failure", title: "生成未完成" },
    { fixture: "degraded", title: "已通过降级路径完成" }
  ] as const;

  for (const scenario of scenarios) {
    const page = await context.newPage();
    const audit = observeBrowserSecurity(page);
    await installDeterministicMock(page, { studioGenerate: scenario.fixture });
    await openStudio(page);
    await submitTextGeneration(page, `synthetic ${scenario.fixture} journey`);
    await expect(page.getByRole("heading", { name: scenario.title })).toBeVisible();
    if (scenario.fixture === "partial") {
      await expect(page.getByText("已收到输出或可能计费；重试会创建一次新的明确请求。")).toBeVisible();
      await expect(page.getByRole("button", { name: "以当前草稿再次提交" })).toBeDisabled();
    }
    if (scenario.fixture === "failure") {
      await expect(page.getByRole("alert")).toContainText(
        "The deterministic stream requires a valid base result."
      );
    }
    if (scenario.fixture === "degraded") {
      await expect(page.locator(".creation-result--degraded")).toBeVisible();
    }
    await expectSecurityClean(page, audit, {
      allowedConsoleHttpStatuses: scenario.fixture === "failure" ? [500] : []
    });
    await page.close();
  }
});

test("authenticated streamed success is genuinely chunked, enters streaming state, and repeats deterministically", async ({ context }) => {
  test.setTimeout(90_000);
  const descriptorFixtures = [
    { fixture: "full-expiry", expectedExpiry: STREAM_FULL_EXPIRY },
    { fixture: "near-expiry", expectedExpiry: STREAM_NEAR_EXPIRY }
  ] as const;
  const observations: Array<{ readonly eventTypes: readonly string[]; readonly sawStreaming: boolean }> = [];

  for (const descriptorFixture of descriptorFixtures) {
    const page = await context.newPage();
    const audit = observeBrowserSecurity(page);
    const resourceBoundary = await installResourceBoundary(page);
    await page.clock.setFixedTime(new Date(STREAM_REGISTERED_AT));
    await openStudio(page);

    const probe = await probeRawStream(page, descriptorFixture.fixture);
    expect(probe.status).toBe(200);
    expect(probe.contentType).toBe("text/event-stream; charset=utf-8");
    expect(probe.fixture).toBe(descriptorFixture.fixture);
    expect(probe.chunkSizes.length).toBeGreaterThan(1);
    expect(probe.chunkSizes.every((size) => size > 0)).toBe(true);
    const events = parseRawStreamEvents(probe.body);
    expect(events.map((event) => event.type)).toEqual(["started", "partial", "completed"]);
    const resource = partialResource(events);
    expect(Date.parse(resource.expiresAt)).toBe(descriptorFixture.expectedExpiry);
    expect(descriptorFixture.expectedExpiry - STREAM_REGISTERED_AT).toBe(
      descriptorFixture.fixture === "full-expiry" ? 300_000 : 30_000
    );
    resourceBoundary.expiresAtByResourceId.set(resource.resourceId, descriptorFixture.expectedExpiry);
    resourceBoundary.now = descriptorFixture.expectedExpiry - 1;
    expect(await fetchProtectedStatus(page, resource.relativeUrl)).toBe(200);
    resourceBoundary.now = descriptorFixture.expectedExpiry;
    expect(await fetchProtectedStatus(page, resource.relativeUrl)).toBe(410);

    resourceBoundary.now = STREAM_REGISTERED_AT;
    await installStreamUiObserver(page);
    await submitTextGeneration(page, "mock-stream:completed");
    await expect(page.getByRole("heading", { name: "图像已生成" })).toBeVisible();
    const observation = await readStreamUiObservation(page);
    expect(observation.states).toContain("streaming");
    observations.push({
      eventTypes: events.map((event) => event.type),
      sawStreaming: observation.states.includes("streaming")
    });

    expectExactStreamRequest(audit, `mock-stream:${descriptorFixture.fixture}`);
    expectExactStreamRequest(audit, "mock-stream:completed");
    await expectSecurityClean(page, audit, { allowedConsoleHttpStatuses: [410] });
    await page.close();
  }

  expect(observations).toEqual([
    { eventTypes: ["started", "partial", "completed"], sawStreaming: true },
    { eventTypes: ["started", "partial", "completed"], sawStreaming: true }
  ]);
});

test("failure after partial preserves risk and descriptor lifetime without automatic replay", async ({ page }) => {
  const audit = observeBrowserSecurity(page);
  const resourceBoundary = await installResourceBoundary(page);
  await page.clock.setFixedTime(new Date(STREAM_REGISTERED_AT));
  await openStudio(page);

  await submitTextGeneration(page, "mock-stream:failed");
  const panel = page.locator('[data-stream-state="stream-failure"]');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "部分图像已保留" })).toBeVisible();
  await expect(panel.getByRole("alert")).toContainText(
    "The deterministic Studio stream ended after a partial image."
  );
  const card = panel.locator(".result-card");
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("data-browser-object-url-cleanup", "true");
  await expect(card).toHaveAttribute("data-server-descriptor-revocation", "false");
  const resourceId = await card.getAttribute("data-resource-id");
  if (resourceId === null) throw new Error("The streamed partial omitted its resource identifier.");
  resourceBoundary.expiresAtByResourceId.set(resourceId, STREAM_FULL_EXPIRY);
  await expect(card.getByRole("img", { name: "Streamed partial result" })).toBeVisible();
  await expect(card.locator("time")).toHaveAttribute(
    "datetime",
    new Date(STREAM_FULL_EXPIRY).toISOString()
  );
  const facts = panel.locator(".creation-result__facts > div");
  await expect(facts.filter({ has: page.getByText("已收到输出", { exact: true }) }).locator("dd")).toHaveText("是");
  await expect(facts.filter({ has: page.getByText("可能计费", { exact: true }) }).locator("dd")).toHaveText("是");
  await expect(panel.getByRole("button", { name: "以当前草稿再次提交" })).toBeDisabled();

  const relativeUrl = `/api/v1/resources/${encodeURIComponent(resourceId)}`;

  resourceBoundary.now = STREAM_FULL_EXPIRY - 1;
  expect(await fetchProtectedStatus(page, relativeUrl)).toBe(200);
  resourceBoundary.now = STREAM_FULL_EXPIRY;
  expect(await fetchProtectedStatus(page, relativeUrl)).toBe(410);
  expectExactStreamRequest(audit, "mock-stream:failed");
  await expectSecurityClean(page, audit, { allowedConsoleHttpStatuses: [410] });
});

test("invalid stream state, request identity, schema, sentinel, terminal, and EOF cases fail closed", async ({ context }) => {
  test.setTimeout(180_000);
  const scenarios = [
    { fixture: "missing-started", keepsPartial: false },
    { fixture: "duplicate-started", keepsPartial: false },
    { fixture: "late-started", keepsPartial: true },
    { fixture: "request-id-drift", keepsPartial: false },
    { fixture: "invalid-sequence", keepsPartial: false },
    { fixture: "invalid-schema", keepsPartial: false },
    { fixture: "sentinel", keepsPartial: false },
    { fixture: "missing-terminal", keepsPartial: false },
    { fixture: "duplicate-terminal", keepsPartial: true },
    { fixture: "post-terminal", keepsPartial: false },
    { fixture: "eof-before-terminal", keepsPartial: true },
    { fixture: "oversize", keepsPartial: false }
  ] as const;

  for (const scenario of scenarios) {
    const page = await context.newPage();
    const audit = observeBrowserSecurity(page);
    await page.clock.setFixedTime(new Date(STREAM_REGISTERED_AT));
    await openStudio(page);
    const prompt = `mock-stream:${scenario.fixture}`;
    await submitTextGeneration(page, prompt);
    const panel = page.locator('[data-stream-state="stream-failure"]');
    await expect(panel).toBeVisible();
    await expect(page.getByRole("heading", { name: "图像已生成" })).toHaveCount(0);
    await expect(page.getByLabel("提示词")).toHaveValue(prompt);
    await expect(page.getByRole("button", { name: "开始生成" })).toBeEnabled();
    await expect(panel.locator(".result-card")).toHaveCount(scenario.keepsPartial ? 1 : 0);
    if (scenario.keepsPartial) {
      await expect(panel.getByRole("heading", { name: "部分图像已保留" })).toBeVisible();
      await expect(panel.getByRole("button", { name: "以当前草稿再次提交" })).toBeDisabled();
    } else {
      await expect(panel.getByRole("heading", { name: "生成未完成" })).toBeVisible();
    }
    expectExactStreamRequest(audit, prompt);
    await expectSecurityClean(page, audit);
    await page.close();
  }
});

test("disconnect fixture remains live until explicit abort, then closes without replay and preserves validated partials", async ({ page }) => {
  const audit = observeBrowserSecurity(page);
  await page.clock.setFixedTime(new Date(STREAM_REGISTERED_AT));
  await openStudio(page);
  const streamFailures: string[] = [];
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).pathname === STUDIO_CREATION_STREAM_PATH) {
      streamFailures.push(request.failure()?.errorText ?? "request-failed");
    }
  });

  await submitTextGeneration(page, "mock-stream:disconnect");
  const streaming = page.locator('[data-stream-state="streaming"]');
  await expect(streaming).toBeVisible();
  await expect(streaming.locator(".result-card")).toHaveCount(1);
  await expect(streaming.getByRole("button", { name: "取消当前请求" })).toBeVisible();
  await streaming.getByRole("button", { name: "取消当前请求" }).click();

  const failed = page.locator('[data-stream-state="stream-failure"]');
  await expect(failed).toBeVisible();
  await expect(failed.getByRole("heading", { name: "部分图像已保留" })).toBeVisible();
  await expect(failed.locator(".result-card")).toHaveCount(1);
  await expect(failed.getByRole("button", { name: "以当前草稿再次提交" })).toBeDisabled();
  await expect(page.getByLabel("提示词")).toHaveValue("mock-stream:disconnect");
  await page.waitForTimeout(50);
  expect(streamFailures.length).toBeLessThanOrEqual(1);
  expect(audit.requests.filter((request) => new URL(request.url).pathname === STUDIO_CREATION_STREAM_PATH)).toHaveLength(1);
  expectExactStreamRequest(audit, "mock-stream:disconnect");
  await expectSecurityClean(page, audit);
});

test("generation-only workbench keeps accessible text generation while removed controls stay absent", async ({ page }) => {
  const audit = observeBrowserSecurity(page);
  await installDeterministicMock(page);
  await openStudio(page);

  await expect(page.getByLabel("提示词")).toBeVisible();
  await expect(page.getByRole("button", { name: "开始生成" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "编辑", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "批量队列" })).toHaveCount(0);
  await expect(page.getByText("能力探测", { exact: true })).toHaveCount(0);
  await expect(page.locator('.file-dropzone-wrap input[type="file"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "打开遮罩编辑器" })).toHaveCount(0);

  const prompt = "只用文本描述的安静暗房场景";
  await submitTextGeneration(page, prompt);
  await expect(page.getByRole("heading", { name: "图像已生成" })).toBeVisible();

  expectExactStreamRequest(audit, prompt);
  const generationRequest = audit.requests.find((request) =>
    request.body?.includes(prompt) && new URL(request.url).pathname === STUDIO_CREATION_STREAM_PATH
  );
  expect(generationRequest?.body).not.toMatch(/target|mask|edit|upload|data:image|base64/iu);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expectSecurityClean(page, audit);
});

test("mobile and desktop generation surfaces remain accessible without a batch queue", async ({ page }) => {
  const audit = observeBrowserSecurity(page);
  await installDeterministicMock(page);
  await openStudio(page);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("heading", { name: "把想法放进显影盘" })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始生成" })).toBeEnabled();
  await expect(page.getByRole("button", { name: /新增任务|提交整个批次|取消批次/ })).toHaveCount(0);
  await expect(page.locator(".batch-editor")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("navigation", { name: "Studio 主导航" })).toBeVisible();
  await expect(page.getByLabel("提示词")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expectSecurityClean(page, audit);
});
});

test("Studio saves compact Codex defaults without exposing a prompt or dispatching generation", async ({ page }) => {
  const audit = observeBrowserSecurity(page);
  await installDeterministicMock(page);
  await openStudio(page);

  await expect(page.getByRole("heading", { name: "为 Codex 设定默认出图参数" })).toBeVisible();
  await expect(page.getByLabel("提示词")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "开始生成" })).toHaveCount(0);
  await page.getByLabel("图片比例").selectOption("16:9");
  await page.getByLabel("清晰度").selectOption("4K");
  await page.getByLabel("背景透明").selectOption("chromakey");
  await page.getByRole("button", { name: "保存并作为 Codex 默认值" }).click();
  await expect(page.getByRole("status")).toContainText("之后在 Codex 对话生图将默认使用这些参数");
  expect(audit.requests.some((request) => new URL(request.url).pathname === STUDIO_CREATION_STREAM_PATH)).toBe(false);
  await expectSecurityClean(page, audit);
});

test("Library search, detail, folders, mark, and copy stay identifier based", async ({ page }) => {
  test.setTimeout(90_000);
  const audit = observeBrowserSecurity(page);
  await installDeterministicMock(page);
  await openStudio(page);

  await page.getByRole("button", { name: "图库" }).click();
  await expect(page.locator('[data-studio-route="library"] h1')).toHaveText("图库");
  await expect(page.locator(".library-card")).toHaveCount(2);

  await page.getByLabel("提示词检索").fill("no-synthetic-match");
  await page.getByRole("button", { name: "应用筛选" }).click();
  await expect(page.getByRole("heading", { name: "没有符合当前筛选的作品" })).toBeVisible();
  await page.getByLabel("提示词检索").fill("Synthetic astronaut cat");
  await page.getByRole("button", { name: "应用筛选" }).click();
  const prompt = "Synthetic astronaut cat in a quiet darkroom.";
  await expect(page.getByRole("button", { name: `查看详情: ${prompt}` })).toBeVisible();
  await page.getByRole("button", { name: `查看详情: ${prompt}` }).click();
  const detail = page.getByRole("dialog");
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("slider", { name: "调整源图与结果图的对比分隔线" })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "复制生成信息" })).toBeVisible();
  await detail.getByRole("button", { name: "关闭详情" }).click();

  await page.getByRole("button", { name: "重置" }).click();
  await expect(page.locator(".library-card")).toHaveCount(2);
  await expect(page.getByRole("navigation", { name: "档案夹" })).toBeVisible();
  await expect(page.getByRole("button", { name: "回收站", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "导出 ZIP" })).toHaveCount(0);
  await expect(page.locator(".library-mutation-panel")).toHaveCount(0);
  await expect(page.locator('.library-zip-import input[type="file"]')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  const apiText = audit.requests
    .filter((request) => request.url.includes("/api/v1/"))
    .map((request) => `${request.url}\n${request.body ?? ""}`)
    .join("\n");
  expect(apiText).not.toMatch(/file:\/\/|data:image|;base64,|[A-Za-z]:\\/iu);
  expect(apiText).toContain("mock-asset");
  await expectSecurityClean(page, audit);
});

test("Settings keeps API-key replacement write-only and returns only redacted state", async ({ page }) => {
  const audit = observeBrowserSecurity(page);
  const replacementMarker = "synthetic-write-only-marker";
  await installDeterministicMock(page);
  await openStudio(page);
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByText("高级设置", { exact: true }).click();

  const profileForm = page.locator("form.settings-profile-editor");
  await profileForm.getByLabel("替换", { exact: true }).check();
  const replacement = profileForm.getByLabel("新 API Key");
  await replacement.fill(replacementMarker);
  await profileForm.getByRole("button", { name: "保存提供方资料" }).click();
  await expect(profileForm.getByRole("status")).toContainText("设置已保存");
  await expect(profileForm.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.locator(".settings-redacted-endpoints")).toContainText("mock.invalid");

  await page.getByRole("button", { name: "刷新模型（非计费）" }).click();
  await expect(page.locator(".settings-models").getByRole("status")).toContainText("非计费刷新");
  await page.getByLabel("清除配置", { exact: true }).check();
  await page.getByRole("button", { name: "应用输出目录操作" }).click();
  await expect(page.locator(".settings-output-directory").getByRole("status")).toContainText("设置已保存");
  await expect(page.locator(".settings-output-directory__current")).toContainText("未配置");

  const secretWrites = audit.requests.filter((request) => request.body?.includes(replacementMarker));
  expect(secretWrites).toHaveLength(1);
  const secretBody = JSON.parse(secretWrites[0]?.body ?? "{}") as {
    apiKey?: { operation?: string; value?: string };
  };
  expect(secretBody.apiKey).toEqual({ operation: "replace", value: replacementMarker });
  await expectSecurityClean(page, audit, { sensitiveMarkers: [replacementMarker] });
});

test("process shutdown immediately makes an otherwise live protected stream resource unavailable", async ({ page }) => {
  const audit = observeBrowserSecurity(page);
  await page.clock.setFixedTime(new Date(STREAM_REGISTERED_AT));
  await openStudio(page);
  const probe = await probeRawStream(page, "full-expiry");
  const resource = partialResource(parseRawStreamEvents(probe.body));
  expect(Date.parse(resource.expiresAt)).toBe(STREAM_FULL_EXPIRY);
  expect(await fetchProtectedStatus(page, resource.relativeUrl)).toBe(200);
  expectExactStreamRequest(audit, "mock-stream:full-expiry");

  await stopStudioServer(studioServer);
  studioServer = undefined;
  expect(await fetchProtectedStatus(page, resource.relativeUrl)).toBe(0);
  await expectSecurityClean(page, audit, {
    allowedConsoleMessages: [/^error:Failed to load resource: net::ERR_CONNECTION_REFUSED$/u]
  });
});
