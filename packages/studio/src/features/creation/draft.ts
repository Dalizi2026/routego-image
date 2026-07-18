import {
  studioEditInputSchema,
  studioGenerateInputSchema,
  type ReadSettingsResult,
  type StudioImageInputRef,
  type StudioImageOperationRequest,
  type StudioImageOperationResult
} from "@routego-image/contracts";

import type {
  CreationDraft,
  DraftImageInput,
  EditInvariantsDraft
} from "./types";
import { uploadLocator } from "./upload";

export class CreationDraftError extends Error {
  readonly fields: Readonly<Record<string, string>>;

  constructor(message: string, fields: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "CreationDraftError";
    this.fields = fields;
  }
}

export function createInitialCreationDraft(
  defaults: ReadSettingsResult["defaults"]
): CreationDraft {
  return {
    mode: "generate",
    prompt: "",
    references: [],
    supportingImages: [],
    invariants: { allowedChanges: [], preserve: [], forbiddenChanges: [] },
    controls: {
      size: defaults.size,
      aspectRatio: defaults.aspectRatio,
      quality: defaults.quality,
      format: defaults.format,
      count: defaults.count,
      partialImages: defaults.partialImages,
      transparentMode: defaults.transparentMode,
      moderation: defaults.moderation,
      action: "auto",
      saveToLibrary: defaults.saveToLibrary
    }
  };
}

export function draftImageLocator(image: DraftImageInput): StudioImageInputRef | undefined {
  return image.locator ?? (image.upload === undefined ? undefined : uploadLocator(image.upload));
}

function requiredLocator(image: DraftImageInput, field: string): StudioImageInputRef {
  const locator = draftImageLocator(image);
  if (locator === undefined) {
    throw new CreationDraftError("图像仍在上传或上传失败。", {
      [field]: "请等待该图像完成上传，或安全重试/移除。"
    });
  }
  return locator;
}

function nonEmptyInvariants(invariants: EditInvariantsDraft): boolean {
  return (
    invariants.allowedChanges.some((value) => value.trim() !== "") ||
    invariants.preserve.some((value) => value.trim() !== "") ||
    invariants.forbiddenChanges.some((value) => value.trim() !== "")
  );
}

function commonRequest(draft: CreationDraft) {
  const references = draft.references.map((reference, index) => ({
    image: requiredLocator(reference, `references.${index}`),
    role: reference.role,
    ...(reference.label?.trim() ? { label: reference.label.trim() } : {})
  }));
  return {
    prompt: draft.prompt.trim(),
    references,
    size: draft.controls.size,
    aspectRatio: draft.controls.aspectRatio,
    quality: draft.controls.quality,
    format: draft.controls.format,
    ...(draft.controls.compression === undefined
      ? {}
      : { compression: draft.controls.compression }),
    count: draft.controls.count,
    partialImages: draft.controls.partialImages,
    transparentMode: draft.controls.transparentMode,
    moderation: draft.controls.moderation,
    action: draft.controls.action,
    ...(draft.controls.previousResponseId === undefined
      ? {}
      : { previousResponseId: draft.controls.previousResponseId }),
    imageIds: [],
    fileIds: [],
    saveToLibrary: draft.controls.saveToLibrary
  };
}

function fieldsFromIssues(issues: readonly { readonly path: PropertyKey[]; readonly message: string }[]) {
  return Object.fromEntries(
    issues.map((issue) => [issue.path.map(String).join(".") || "form", issue.message])
  );
}

export function buildStudioCreationRequest(draft: CreationDraft): StudioImageOperationRequest {
  try {
    if (draft.prompt.trim() === "") {
      throw new CreationDraftError("请输入提示词。", { prompt: "提示词不能为空。" });
    }
    if (draft.mode === "generate") {
      return studioGenerateInputSchema.parse({ kind: "generate", ...commonRequest(draft) });
    }
    if (draft.target === undefined) {
      throw new CreationDraftError("编辑需要一张目标图。", { target: "请添加目标图。" });
    }
    if (!nonEmptyInvariants(draft.invariants)) {
      throw new CreationDraftError("请明确至少一项编辑约束。", {
        invariants: "填写允许修改、必须保留或禁止修改中的至少一项。"
      });
    }
    return studioEditInputSchema.parse({
      kind: "edit",
      ...commonRequest(draft),
      target: requiredLocator(draft.target, "target"),
      supportingImages: draft.supportingImages.map((supporting, index) => ({
        image: requiredLocator(supporting, `supportingImages.${index}`),
        role: supporting.role,
        ...(supporting.label?.trim() ? { label: supporting.label.trim() } : {})
      })),
      ...(draft.mask === undefined ? {} : { mask: draft.mask }),
      invariants: {
        allowedChanges: draft.invariants.allowedChanges.filter((value) => value.trim() !== ""),
        preserve: draft.invariants.preserve.filter((value) => value.trim() !== ""),
        forbiddenChanges: draft.invariants.forbiddenChanges.filter((value) => value.trim() !== "")
      }
    });
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

export function createEditHandoff(
  result: StudioImageOperationResult,
  artifactId: string
): CreationDraft {
  const artifact = [...result.finalArtifacts, ...result.partialArtifacts].find(
    (candidate) => candidate.artifactId === artifactId
  );
  if (artifact === undefined) {
    throw new CreationDraftError("无法找到要继续编辑的结果。");
  }
  const effective = result.effectiveParams;
  const targetLocator: StudioImageInputRef = artifact.assetId
    ? { source: "asset", assetId: artifact.assetId }
    : { source: "artifact", artifactId: artifact.artifactId };
  return {
    mode: "edit",
    prompt: effective.prompt,
    references: effective.references.map((reference, index) => ({
      id: `handoff-reference-${index}`,
      role: reference.role,
      ...(reference.label ? { label: reference.label } : {}),
      locator: reference.image
    })),
    target: {
      id: `handoff-target-${artifact.artifactId}`,
      role: "previous-output",
      locator: targetLocator,
      resource: artifact.resource
    },
    supportingImages: [],
    mask: undefined,
    maskUpload: undefined,
    invariants: { allowedChanges: [], preserve: [], forbiddenChanges: [] },
    controls: {
      size: effective.size,
      aspectRatio: effective.aspectRatio,
      quality: effective.quality,
      format: effective.format,
      ...(effective.compression === undefined ? {} : { compression: effective.compression }),
      count: effective.count,
      partialImages: effective.partialImages,
      transparentMode: effective.transparentMode,
      moderation: effective.moderation,
      action: effective.action,
      ...(effective.previousResponseId === undefined
        ? {}
        : { previousResponseId: effective.previousResponseId }),
      saveToLibrary: effective.saveToLibrary
    }
  };
}
