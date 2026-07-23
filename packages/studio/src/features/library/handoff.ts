export const studioLibraryActionSchemaVersion = 1 as const;

export interface CopyGenerationInfoRequest {
  readonly schemaVersion: typeof studioLibraryActionSchemaVersion;
  readonly recordId: string;
}

export interface MarkImageRequest {
  readonly schemaVersion: typeof studioLibraryActionSchemaVersion;
  readonly recordId: string;
}

interface BrowserSafeActionError {
  readonly safeMessage: string;
}

export interface CopyGenerationInfoResult {
  readonly status: "succeeded" | "failed";
  readonly clipboardText?: string | undefined;
  readonly providerRequestCount: number;
  readonly error?: BrowserSafeActionError | undefined;
}

export interface MarkImageResult {
  readonly status: "succeeded" | "failed";
  readonly currentMarkRecordId?: string | undefined;
  readonly markCleared: boolean;
  readonly providerRequestCount: number;
  readonly error?: BrowserSafeActionError | undefined;
}

function requiredRecordId(recordId: string): string {
  if (recordId.trim() === "") throw new Error("必须选择有效的图库记录。");
  return recordId;
}

export function createCopyGenerationInfoRequest(recordId: string): CopyGenerationInfoRequest {
  return { schemaVersion: studioLibraryActionSchemaVersion, recordId: requiredRecordId(recordId) };
}

export function createMarkImageRequest(recordId: string): MarkImageRequest {
  return { schemaVersion: studioLibraryActionSchemaVersion, recordId: requiredRecordId(recordId) };
}

export function copiedGenerationInformation(result: CopyGenerationInfoResult): string {
  if (
    result.status !== "succeeded" ||
    result.providerRequestCount !== 0 ||
    typeof result.clipboardText !== "string"
  ) {
    throw new Error(result.error?.safeMessage ?? "无法复制生成信息。");
  }
  return result.clipboardText;
}

export function nextCurrentMarkRecordId(result: MarkImageResult): string | undefined {
  if (result.status !== "succeeded" || result.providerRequestCount !== 0) {
    throw new Error(result.error?.safeMessage ?? "无法更新图片标记。");
  }
  return result.markCleared ? undefined : result.currentMarkRecordId;
}
