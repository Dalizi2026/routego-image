import {
  studioGenerateInputSchema,
  type ReadSettingsResult,
  type StudioImageOperationRequest
} from "@routego-image/contracts";

import type { CreationDraft, CreationVisibleControls } from "./types";

export class CreationDraftError extends Error {
  readonly fields: Readonly<Record<string, string>>;

  constructor(message: string, fields: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "CreationDraftError";
    this.fields = fields;
  }
}

export function visibleControlsFromDefaults(
  defaults: ReadSettingsResult["defaults"]
): CreationVisibleControls {
  return normalizeVisibleControls({
    size: defaults.size,
    aspectRatio: defaults.aspectRatio,
    format: defaults.format,
    count: defaults.count,
    transparentMode: defaults.transparentMode
  });
}

export function createInitialCreationDraft(
  defaults: ReadSettingsResult["defaults"]
): CreationDraft {
  return {
    mode: "generate",
    prompt: "",
    controls: visibleControlsFromDefaults(defaults)
  };
}

export function normalizeVisibleControls(
  controls: CreationVisibleControls
): CreationVisibleControls {
  const format = controls.transparentMode === "off" ? controls.format : "png";
  const transparentMode = format === "png" ? controls.transparentMode : "off";
  return {
    // Studio defaults store an exact size together with its descriptive ratio
    // (for example 2880x2880 and 1:1). The provider accepts one sizing control,
    // so preserve the exact saved size and drop only the duplicate ratio.
    size: controls.size,
    aspectRatio: controls.size === "auto" ? controls.aspectRatio : "auto",
    format,
    count: controls.count,
    transparentMode
  };
}

function fieldsFromIssues(issues: readonly { readonly path: PropertyKey[]; readonly message: string }[]) {
  return Object.fromEntries(
    issues.map((issue) => [issue.path.map(String).join(".") || "form", issue.message])
  );
}

export function buildStudioCreationRequest(draft: CreationDraft): StudioImageOperationRequest {
  try {
    const prompt = draft.prompt.trim();
    if (prompt === "") {
      throw new CreationDraftError("请输入提示词。", { prompt: "提示词不能为空。" });
    }
    if (draft.mode !== "generate") {
      throw new CreationDraftError("Studio 工作台只支持文本生成。", {
        mode: "请选择生成模式。"
      });
    }
    if (draft.controls.size !== "auto" && draft.controls.aspectRatio !== "auto") {
      throw new CreationDraftError("尺寸和画幅只能指定一个。", {
        size: "选择具体尺寸时画幅必须为 auto。",
        aspectRatio: "选择具体画幅时尺寸必须为 auto。"
      });
    }
    if (draft.controls.format !== "png" && draft.controls.transparentMode !== "off") {
      throw new CreationDraftError("JPEG/WebP 不支持透明背景。", {
        format: "透明背景需要 PNG。",
        transparentMode: "选择 JPEG 或 WebP 时透明背景必须关闭。"
      });
    }
    const request = {
      kind: "generate",
      prompt,
      size: draft.controls.size,
      aspectRatio: draft.controls.aspectRatio,
      format: draft.controls.format,
      count: draft.controls.count,
      transparentMode: draft.controls.transparentMode
    } satisfies Record<string, unknown>;
    studioGenerateInputSchema.parse(request);
    return request as unknown as StudioImageOperationRequest;
  } catch (error) {
    if (error instanceof CreationDraftError) {
      throw error;
    }
    if (
      error !== null &&
      typeof error === "object" &&
      "issues" in error &&
      Array.isArray((error as { issues?: unknown }).issues)
    ) {
      const issues = (error as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues;
      throw new CreationDraftError("请检查工作台中的输入。", fieldsFromIssues(issues));
    }
    throw new CreationDraftError("工作台输入不符合本地契约。");
  }
}
