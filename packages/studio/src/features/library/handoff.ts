export const studioLibraryActionSchemaVersion = 1 as const;

export interface CopyGenerationInfoRequest {
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

function requiredRecordId(recordId: string): string {
  if (recordId.trim() === "") throw new Error("必须选择有效的图库记录。");
  return recordId;
}

export function createCopyGenerationInfoRequest(recordId: string): CopyGenerationInfoRequest {
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
