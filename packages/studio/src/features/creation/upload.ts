import {
  uploadMimeTypeSchema,
  type UploadResourcePurpose
} from "@routego-image/contracts";

import type { StudioGateway } from "../../api";
import type {
  UploadLifecycleItem,
  UploadLifecycleStatus,
  UploadSource
} from "./types";

const IMAGE_MAX_BYTES = 52_428_800;
const ZIP_MAX_BYTES = 536_870_912;

export class UploadLifecycleError extends Error {
  readonly status: UploadLifecycleStatus;

  constructor(status: UploadLifecycleStatus, message: string) {
    super(message);
    this.name = "UploadLifecycleError";
    this.status = status;
  }
}

export function createUploadItem(
  purpose: UploadResourcePurpose,
  source: UploadSource,
  id: string = globalThis.crypto.randomUUID()
): UploadLifecycleItem {
  return { id, purpose, source, status: "queued" };
}

export function validateUploadSource(
  purpose: UploadResourcePurpose,
  source: UploadSource
): string | undefined {
  const mime = uploadMimeTypeSchema.safeParse(source.blob.type);
  if (!mime.success) {
    return "仅支持 PNG、JPEG、WebP 图像或 ZIP 导入文件。";
  }
  if (purpose === "zip-import" && source.blob.type !== "application/zip") {
    return "图库导入只接受 ZIP 文件。";
  }
  if (purpose === "mask" && source.blob.type !== "image/png") {
    return "遮罩必须保存为 PNG。";
  }
  if (purpose !== "zip-import" && source.blob.type === "application/zip") {
    return "此图像位置不接受 ZIP 文件。";
  }
  const maximum = purpose === "zip-import" ? ZIP_MAX_BYTES : IMAGE_MAX_BYTES;
  if (source.blob.size < 1 || source.blob.size > maximum) {
    return `文件大小必须在 1 字节至 ${Math.floor(maximum / 1024 / 1024)} MB 之间。`;
  }
  return undefined;
}

function lifecycleFailure(
  code: string | undefined,
  safeMessage: string | undefined
): UploadLifecycleError {
  return new UploadLifecycleError(
    code === "upload_expired" ? "expired" : "failed",
    safeMessage ?? "本地上传未完成，请安全重试或移除该文件。"
  );
}

function unknownFailure(error: unknown, fallback: string): UploadLifecycleError {
  return new UploadLifecycleError(
    "failed",
    error instanceof Error && error.message.trim() !== "" ? error.message : fallback
  );
}

export async function performUploadLifecycle(
  gateway: StudioGateway,
  item: UploadLifecycleItem,
  onChange: (item: UploadLifecycleItem) => void
): Promise<UploadLifecycleItem> {
  const validation = validateUploadSource(item.purpose, item.source);
  if (validation !== undefined) {
    const failed = { ...item, status: "failed" as const, safeMessage: validation };
    onChange(failed);
    throw new UploadLifecycleError("failed", validation);
  }

  const reserving = { ...item, status: "reserving" as const, safeMessage: undefined };
  onChange(reserving);
  let reserved;
  try {
    reserved = await gateway.invoke("reserveUploadResource", {
      purpose: item.purpose,
      declaredMimeType: uploadMimeTypeSchema.parse(item.source.blob.type),
      declaredByteLength: item.source.blob.size
    });
  } catch (error) {
    const failure = unknownFailure(error, "无法预留本地上传资源。");
    onChange({ ...item, status: "failed", safeMessage: failure.message });
    throw failure;
  }
  if (reserved.status !== "succeeded" || reserved.resource === undefined) {
    const failure = lifecycleFailure(reserved.error?.code, reserved.error?.safeMessage);
    const failed = { ...item, status: failure.status, safeMessage: failure.message };
    onChange(failed);
    throw failure;
  }

  const uploading: UploadLifecycleItem = {
    ...item,
    status: "uploading",
    uploadResourceId: reserved.resource.uploadResourceId,
    descriptor: reserved.resource
  };
  onChange(uploading);
  try {
    await gateway.uploadBinary(reserved.resource, item.source.blob);
  } catch (error) {
    const message = error instanceof Error ? error.message : "二进制上传失败。";
    const failed = { ...uploading, status: "failed" as const, safeMessage: message };
    onChange(failed);
    throw new UploadLifecycleError("failed", message);
  }

  const finalizing = { ...uploading, status: "finalizing" as const };
  onChange(finalizing);
  let finalized;
  try {
    finalized = await gateway.invoke("finalizeUploadResource", {
      uploadResourceId: reserved.resource.uploadResourceId
    });
  } catch (error) {
    const failure = unknownFailure(error, "无法确认本地上传资源。");
    onChange({ ...finalizing, status: "failed", safeMessage: failure.message });
    throw failure;
  }
  if (finalized.status !== "succeeded" || finalized.resource === undefined) {
    const failure = lifecycleFailure(finalized.error?.code, finalized.error?.safeMessage);
    const failed = { ...finalizing, status: failure.status, safeMessage: failure.message };
    onChange(failed);
    throw failure;
  }
  const ready: UploadLifecycleItem = {
    ...finalizing,
    status: "ready",
    uploadResourceId: finalized.resource.uploadResourceId,
    descriptor: finalized.resource,
    safeMessage: undefined
  };
  onChange(ready);
  return ready;
}

export async function discardUploadLifecycle(
  gateway: StudioGateway,
  item: UploadLifecycleItem,
  onChange: (item: UploadLifecycleItem) => void
): Promise<UploadLifecycleItem> {
  if (item.uploadResourceId === undefined) {
    const discarded = { ...item, status: "discarded" as const };
    onChange(discarded);
    return discarded;
  }
  const discarding = { ...item, status: "discarding" as const };
  onChange(discarding);
  let result;
  try {
    result = await gateway.invoke("discardUploadResource", {
      uploadResourceId: item.uploadResourceId
    });
  } catch (error) {
    const failure = unknownFailure(error, "无法丢弃本地上传资源。");
    onChange({ ...item, status: "failed", safeMessage: failure.message });
    throw failure;
  }
  if (result.status !== "succeeded") {
    const failure = lifecycleFailure(result.error?.code, result.error?.safeMessage);
    const failed = { ...item, status: failure.status, safeMessage: failure.message };
    onChange(failed);
    throw failure;
  }
  const discarded = { ...item, status: "discarded" as const, safeMessage: undefined };
  onChange(discarded);
  return discarded;
}

export async function retryUploadLifecycle(
  gateway: StudioGateway,
  item: UploadLifecycleItem,
  onChange: (item: UploadLifecycleItem) => void
): Promise<UploadLifecycleItem> {
  if (item.uploadResourceId !== undefined) {
    try {
      await discardUploadLifecycle(gateway, item, onChange);
    } catch {
      // Expired or already removed resources can still be replaced by a fresh reservation.
    }
  }
  const queued: UploadLifecycleItem = {
    ...item,
    status: "queued",
    uploadResourceId: undefined,
    descriptor: undefined,
    safeMessage: undefined
  };
  onChange(queued);
  return performUploadLifecycle(gateway, queued, onChange);
}

export function uploadLocator(item: UploadLifecycleItem) {
  return item.status === "ready" && item.uploadResourceId !== undefined
    ? ({ source: "upload", uploadResourceId: item.uploadResourceId } as const)
    : undefined;
}
