import type {
  ExecuteLibraryMutationResult,
  LibraryMutationRequest,
  PreflightLibraryMutationResult
} from "@routego-image/contracts";

export type LibraryMutationAction = LibraryMutationRequest["action"];
export type AssetLibraryMutationAction = Exclude<LibraryMutationAction, "import-zip">;
export type FolderAssetMutationAction = Extract<
  AssetLibraryMutationAction,
  "assign-folders" | "remove-folders"
>;

export class LibraryMutationWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryMutationWorkflowError";
  }
}

function uniqueIds(values: readonly string[], label: string): string[] {
  const normalized = values.map((value) => value.trim()).filter((value) => value !== "");
  if (normalized.length === 0) {
    throw new LibraryMutationWorkflowError(label);
  }
  return [...new Set(normalized)];
}

export function buildAssetLibraryMutation(
  action: AssetLibraryMutationAction,
  assetIds: readonly string[],
  folderIds: readonly string[] = []
): LibraryMutationRequest {
  const assets = uniqueIds(assetIds, "请至少选择一个图库项目。");
  if (action === "assign-folders" || action === "remove-folders") {
    return {
      action,
      assetIds: assets,
      folderIds: uniqueIds(folderIds, "请至少选择一个档案夹。")
    };
  }
  return { action, assetIds: assets };
}

export function buildZipImportMutation(
  uploadResourceId: string | undefined,
  consumed: boolean
): LibraryMutationRequest {
  if (consumed) {
    throw new LibraryMutationWorkflowError("该 ZIP 上传资源已经使用，必须重新选择并上传文件。");
  }
  if (uploadResourceId === undefined || uploadResourceId.trim() === "") {
    throw new LibraryMutationWorkflowError("ZIP 必须完成上传后才能预检导入。");
  }
  return { action: "import-zip", uploadResourceId };
}

export function moveFolderIds(
  folderIds: readonly string[],
  folderId: string,
  direction: -1 | 1
): readonly string[] {
  const ordered = uniqueIds(folderIds, "完整档案夹顺序不能为空。");
  if (ordered.length !== folderIds.length) {
    throw new LibraryMutationWorkflowError("完整档案夹顺序不能包含重复项。");
  }
  const index = ordered.indexOf(folderId);
  if (index < 0) {
    throw new LibraryMutationWorkflowError("待移动的档案夹不在当前完整顺序中。");
  }
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= ordered.length) return ordered;
  const next = [...ordered];
  [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
  return next;
}

export function confirmationForAction(
  action: LibraryMutationAction
): "permanent-delete" | "zip-export" | "zip-import" | undefined {
  return action === "permanent-delete"
    ? "permanent-delete"
    : action === "export-zip"
      ? "zip-export"
      : action === "import-zip"
        ? "zip-import"
        : undefined;
}

export function executionConfirmations(
  preflight: PreflightLibraryMutationResult,
  exactConfirmation: string,
  now?: number
): ("permanent-delete" | "zip-export" | "zip-import")[] {
  if (now !== undefined && Date.parse(preflight.expiresAt) <= now) {
    throw new LibraryMutationWorkflowError("预检已经过期，请重新预检后再执行。");
  }
  if (preflight.status === "blocked" || !preflight.items.some((item) => item.eligible)) {
    throw new LibraryMutationWorkflowError("当前预检没有可执行项目。");
  }
  const required = confirmationForAction(preflight.action);
  if (required === undefined) return [];
  if (
    preflight.requiredConfirmations.length !== 1 ||
    preflight.requiredConfirmations[0] !== required ||
    exactConfirmation !== required
  ) {
    throw new LibraryMutationWorkflowError(`请输入精确确认文本：${required}`);
  }
  return [required];
}

export function mutationResultCounts(result: ExecuteLibraryMutationResult): {
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
} {
  return result.items.reduce(
    (counts, item) => ({ ...counts, [item.status]: counts[item.status] + 1 }),
    { succeeded: 0, failed: 0, skipped: 0 }
  );
}

export function remainingSelectedAssetIds(
  selectedAssetIds: readonly string[],
  result: ExecuteLibraryMutationResult
): readonly string[] {
  const succeeded = new Set(
    result.items
      .filter((item) => item.status === "succeeded")
      .flatMap((item) => [item.targetId, ...(item.affectedAssetId ? [item.affectedAssetId] : [])])
  );
  return selectedAssetIds.filter((assetId) => !succeeded.has(assetId));
}
