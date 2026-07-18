import { existsSync } from "node:fs";

import { chromium, expect, test, type Page } from "@playwright/test";

import {
  STUDIO_BASE_URL,
  STUDIO_SESSION_TOKEN,
  installDeterministicMock,
  installSyntheticFaviconBoundary,
  observeBrowserSecurity,
  openStudio,
  startStudioServer,
  stopStudioServer,
  syntheticPng,
  syntheticZip,
  type BrowserSecurityAudit,
  type StudioServer
} from "./harness";

test.describe.configure({ mode: "serial" });

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

interface SecurityExpectationOptions {
  readonly sensitiveMarkers?: readonly string[];
  readonly expectedSessionHeader?: string;
  readonly allowedConsoleHttpStatuses?: readonly number[];
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

function uploadInput(page: Page, heading: string) {
  return page
    .locator(".file-dropzone-wrap")
    .filter({ has: page.getByRole("heading", { name: heading }) })
    .locator('input[type="file"]');
}

async function runCapabilityProbe(page: Page, capability: string): Promise<void> {
  const form = page.locator("form.settings-probe");
  await form.getByLabel("能力").selectOption(capability);
  await form.getByLabel("我确认本次探测可能产生费用").check();
  await form.getByRole("button", { name: "执行一次能力探测" }).click();
  await expect(form.locator(".settings-probe-result")).toHaveAttribute("data-state", "supported");
  await expect(form.locator(".settings-probe-result")).toContainText(capability);
}

async function submitTextGeneration(page: Page, prompt: string): Promise<void> {
  await page.getByLabel("提示词").fill(prompt);
  await page.getByRole("button", { name: "开始生成" }).click();
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
  const readyNavigation = page.goto(`/?token=${encodeURIComponent(STUDIO_SESSION_TOKEN)}`);
  await expect(page.getByText("正在显影工作区")).toBeVisible();
  await readyNavigation;
  await expect(page.getByRole("heading", { name: "把想法放进显影盘" })).toBeVisible();
  await expect(page).toHaveURL("http://127.0.0.1:4173/");
  await expect(page.getByRole("navigation", { name: "Studio 主导航" })).toBeVisible();

  await page.getByLabel("提示词").fill("保留语言切换前的草稿");
  await page.getByRole("button", { name: "界面语言" }).click();
  await expect(page.getByRole("heading", { name: "Place the idea in the developer tray" })).toBeVisible();
  await expect(page.getByLabel("Prompt")).toHaveValue("保留语言切换前的草稿");
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
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Relay configuration & capability calibration" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await expectSecurityClean(page, audit);

  const rejectedSessionToken = "routego-studio-rejected-session-token";
  const rejectedPage = await context.newPage();
  const rejectedAudit = observeBrowserSecurity(rejectedPage);
  await installSyntheticFaviconBoundary(rejectedPage);
  await rejectedPage.goto(`/?token=${encodeURIComponent(rejectedSessionToken)}`);
  await expect(rejectedPage.getByRole("heading", { name: "本地工作区无法载入" })).toBeVisible();
  await expect(rejectedPage.getByText("本地会话已失效或被拒绝。")).toBeVisible();
  await expect(rejectedPage.getByText("请关闭此页面，再从 Routego Image 重新打开 Studio。")).toBeVisible();
  await expect(rejectedPage.getByRole("heading", { name: "把想法放进显影盘" })).toHaveCount(0);
  await expect(rejectedPage).toHaveURL(STUDIO_BASE_URL + "/");
  await expectSecurityClean(rejectedPage, rejectedAudit, {
    sensitiveMarkers: [rejectedSessionToken],
    expectedSessionHeader: rejectedSessionToken,
    allowedConsoleHttpStatuses: [401]
  });
  await rejectedPage.close();
});

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
      await expect(page.getByText("The selected synthetic Studio fixture has no image-input capability.")).toBeVisible();
    }
    if (scenario.fixture === "degraded") {
      await expect(page.locator(".creation-result--degraded")).toBeVisible();
    }
    await expectSecurityClean(page, audit);
    await page.close();
  }
});

test("confirmed capability probes unlock reference upload, generation, target edit, and target-slot-zero mask save", async ({ page }) => {
  const audit = observeBrowserSecurity(page);
  await installDeterministicMock(page);
  await openStudio(page);

  await expect(page.getByRole("button", { name: "编辑", exact: true })).toBeDisabled();
  await expect(page.getByText("当前中转未确认支持").first()).toBeVisible();
  await expect(uploadInput(page, "参考图")).toBeDisabled();

  await page.getByRole("button", { name: "设置" }).click();
  await runCapabilityProbe(page, "single-image-input");
  await runCapabilityProbe(page, "target-edit");
  await runCapabilityProbe(page, "mask-edit");
  await page.getByRole("button", { name: "工作台" }).click();

  await expect(uploadInput(page, "参考图")).toBeEnabled();
  await uploadInput(page, "参考图").setInputFiles(syntheticPng);
  await expect(page.locator(".upload-card", { hasText: syntheticPng.name })).toContainText("ready");
  await submitTextGeneration(page, "使用一张合成参考图的安静暗房场景");
  await expect(page.getByRole("heading", { name: "图像已生成" })).toBeVisible();

  await page.locator(".upload-card", { hasText: syntheticPng.name }).getByRole("button", { name: "移除" }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const targetFile = { ...syntheticPng, name: "synthetic-target.png" };
  await uploadInput(page, "编辑目标").setInputFiles(targetFile);
  await expect(page.locator(".upload-card", { hasText: targetFile.name })).toContainText("ready");
  await page.getByLabel("允许修改").fill("仅修改中央区域");
  await page.getByRole("button", { name: "打开遮罩编辑器" }).click();
  await expect(page.getByRole("dialog", { name: "遮罩暗房" })).toBeVisible();
  const canvas = page.getByRole("region", { name: "目标图与可编辑遮罩覆盖层" });
  await expect(canvas).toBeVisible();
  const canvasBounds = await canvas.boundingBox();
  expect(canvasBounds).not.toBeNull();
  await canvas.click({
    position: {
      x: Math.max(1, Math.floor((canvasBounds?.width ?? 2) / 2)),
      y: Math.max(1, Math.floor((canvasBounds?.height ?? 2) / 2))
    }
  });
  await page.getByRole("button", { name: "保存遮罩" }).click();
  await expect(page.getByText("遮罩已就绪")).toBeVisible();
  await page.getByRole("button", { name: "关闭编辑器" }).click();
  await expect(page.getByText("遮罩已绑定 TARGET[0]")).toBeVisible();
  await page.getByRole("button", { name: "提交编辑" }).click();
  await expect(page.getByRole("heading", { name: "图像已生成" })).toBeVisible();

  const editRequest = audit.requests.find((request) => request.body?.includes('"targetSlot":0'));
  expect(editRequest?.body).toContain('"targetSlot":0');
  expect(editRequest?.body).not.toMatch(/path|data:image|base64/iu);
  await expectSecurityClean(page, audit);
});

test("ordered batch keeps task identity and displays mixed outcomes in submitted order", async ({ page }) => {
  const audit = observeBrowserSecurity(page);
  await installDeterministicMock(page, { studioBatch: "partial" });
  await openStudio(page);

  await page.getByRole("button", { name: "批量队列" }).click();
  await page.getByLabel("提示词").fill("batch-first");
  await page.getByRole("button", { name: /新增任务/ }).click();
  await page.getByLabel("提示词").fill("batch-second");
  await expect(page.locator(".batch-editor__list > li").nth(0)).toContainText("batch-first");
  await expect(page.locator(".batch-editor__list > li").nth(1)).toContainText("batch-second");
  await page.getByLabel("并发数").fill("2");
  await page.getByRole("button", { name: "提交整个批次" }).click();
  await expect(page.locator(".batch-editor__summary")).toContainText("批量任务部分完成");
  await expect(page.locator(".batch-editor__list > li").nth(0)).toContainText("成功");
  await expect(page.locator(".batch-editor__list > li").nth(1)).toContainText("失败");

  const batchRequest = audit.requests.find(
    (request) => request.body?.includes("batch-first") && request.body.includes("batch-second")
  );
  const batchBody = JSON.parse(batchRequest?.body ?? "{}") as {
    tasks?: Array<{ operation?: { prompt?: string } }>;
  };
  expect(batchBody.tasks?.map((item) => item.operation?.prompt)).toEqual([
    "batch-first",
    "batch-second"
  ]);
  await expectSecurityClean(page, audit);
});

async function executeVisiblePreflight(page: Page, expectedAction: string): Promise<void> {
  const preflight = page.locator(".library-preflight");
  await expect(preflight).toBeVisible();
  await expect(preflight).toContainText(expectedAction);
  const confirmationCode = preflight.locator("code");
  const confirmation =
    (await confirmationCode.count()) === 0 ? null : await confirmationCode.textContent();
  if (confirmation !== null && confirmation !== "") {
    await preflight.locator('input[autocomplete="off"]').fill(confirmation);
  }
  const execute = preflight.getByRole("button", { name: "执行已预检变更" });
  await expect(execute).toBeEnabled();
  await execute.click();
  await expect(page.locator(".library-mutation-result")).toBeVisible();
}

test("Library search, detail, comparison, folders, partial mutations, Trash, and ZIP stay identifier based", async ({ page }) => {
  test.setTimeout(90_000);
  const audit = observeBrowserSecurity(page);
  await installDeterministicMock(page, { executeLibraryMutation: "partial" });
  await openStudio(page);

  await page.getByRole("button", { name: "图库" }).click();
  await expect(page.getByRole("heading", { name: "底片档案与成片图库" })).toBeVisible();
  await expect(page.locator(".library-card")).toHaveCount(2);

  await page.getByLabel("提示词检索").fill("no-synthetic-match");
  await page.getByRole("button", { name: "应用筛选" }).click();
  await expect(page.getByRole("heading", { name: "没有符合当前筛选的作品" })).toBeVisible();
  await page.getByLabel("提示词检索").fill("Synthetic edit request");
  await page.getByRole("button", { name: "应用筛选" }).click();
  const editPrompt = "Synthetic edit request for downstream Studio development.";
  await expect(page.getByRole("button", { name: `查看详情: ${editPrompt}` })).toBeVisible();
  await page.getByRole("button", { name: `查看详情: ${editPrompt}` }).click();
  const detail = page.getByRole("dialog", { name: editPrompt });
  await expect(detail).toBeVisible();
  const comparison = detail.getByRole("slider", { name: "调整源图与结果图的对比分隔线" });
  await expect(comparison).toHaveValue("50");
  await comparison.focus();
  await page.keyboard.press("ArrowRight");
  await expect(comparison).toHaveValue("55");
  await page.keyboard.press("End");
  await expect(comparison).toHaveValue("100");
  await detail.getByRole("button", { name: "关闭详情" }).click();

  await page.getByRole("button", { name: "重置" }).click();
  await expect(page.locator(".library-card")).toHaveCount(2);
  const createFolderForm = page
    .locator(".library-mutation-panel form")
    .filter({ has: page.getByRole("heading", { name: "创建档案夹" }) });
  await createFolderForm.getByLabel("档案夹名称").fill("Synthetic browser folder");
  await createFolderForm.getByRole("button", { name: "创建" }).click();
  await expect(page.locator(".library-mutation-panel__message")).toContainText("create-folder");
  const renameFolderForm = page
    .locator(".library-mutation-panel form")
    .filter({ has: page.getByRole("heading", { name: "重命名档案夹" }) });
  await renameFolderForm.getByLabel("选择档案夹").selectOption("mock-folder-primary");
  await renameFolderForm.getByLabel("档案夹名称").fill("Synthetic renamed folder");
  await renameFolderForm.getByRole("button", { name: "重命名" }).click();
  await expect(page.locator(".library-mutation-panel__message")).toContainText("rename-folder");
  await page.getByRole("button", { name: "保存完整顺序" }).click();
  await expect(page.locator(".library-mutation-panel__message")).toContainText("完整排序");

  await page.getByRole("button", { name: "选择当前页" }).click();
  await page.getByLabel("Synthetic primary", { exact: true }).check();
  await page.getByRole("button", { name: "分配到档案夹" }).click();
  await executeVisiblePreflight(page, "assign-folders");
  await expect(page.locator(".library-mutation-result")).toHaveAttribute("data-state", "partial");
  await expect(page.locator(".library-mutation-result li")).toHaveCount(2);

  const selectCurrentPage = page.getByRole("button", { name: /选择当前页|取消当前页选择/ });
  if ((await selectCurrentPage.textContent())?.includes("选择当前页")) {
    await selectCurrentPage.click();
  }
  await page.getByRole("button", { name: "移入回收站" }).click();
  await executeVisiblePreflight(page, "soft-delete");
  await expect(page.locator(".library-mutation-result")).toHaveAttribute("data-state", "partial");
  if ((await selectCurrentPage.textContent())?.includes("选择当前页")) {
    await selectCurrentPage.click();
  }
  await page.getByRole("button", { name: "导出 ZIP" }).click();
  await executeVisiblePreflight(page, "export-zip");
  await expect(page.locator(".library-preflight")).toContainText("export-zip");

  const zipPicker = page.locator(".library-zip-import input[type=file]");
  await zipPicker.setInputFiles(syntheticZip);
  await expect(page.getByText("ZIP 已完成上传，可开始导入预检。")).toBeVisible();
  await page.locator(".library-zip-import__state").getByRole("button", { name: "预检" }).click();
  await executeVisiblePreflight(page, "import-zip");
  await expect(page.getByText("ZIP 已单次使用；再次导入必须重新上传。")).toBeVisible();

  await page.getByRole("button", { name: "回收站", exact: true }).click();
  await expect(page.getByRole("heading", { name: "回收站与保留记录" })).toBeVisible();
  await expect(page.getByText("30 天保留策略").first()).toBeVisible();
  await page.getByRole("button", { name: "选择当前页" }).click();
  await page.getByRole("button", { name: "恢复所选项目" }).click();
  await executeVisiblePreflight(page, "restore");
  await expect(page.locator(".library-preflight")).toContainText("restore");
  const trashPageSelection = page.getByRole("button", { name: /选择当前页|取消当前页选择/ });
  if ((await trashPageSelection.textContent())?.includes("选择当前页")) {
    await trashPageSelection.click();
  }
  await page.getByRole("button", { name: "永久删除" }).click();
  await executeVisiblePreflight(page, "permanent-delete");
  await expect(page.locator(".library-preflight")).toContainText("permanent-delete");

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
