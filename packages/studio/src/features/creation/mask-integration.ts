import type {
  BrowserResourceDescriptor,
  UploadResourceDescriptor
} from "@routego-image/contracts";

import type { StudioGateway } from "../../api";
import {
  UNCONFIRMED_CAPABILITY_MESSAGE,
  type CapabilityDecision
} from "../capabilities";
import type { MaskPngUploadRequest, MaskUploadLocator } from "../mask";
import type {
  CreationDraft,
  DraftImageInput,
  UploadLifecycleItem
} from "./types";
import { createUploadItem, performUploadLifecycle } from "./upload";

export interface ReadyMaskTarget {
  readonly key: string;
  readonly resource?: BrowserResourceDescriptor | undefined;
  readonly blob?: Blob | undefined;
  readonly size: { readonly width: number; readonly height: number };
}

export interface FinalizedMaskUpload {
  readonly item: UploadLifecycleItem;
  readonly resource: UploadResourceDescriptor;
}

export class MaskIntegrationError extends Error {
  readonly fields: Readonly<Record<string, string>>;

  constructor(message: string, fields: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "MaskIntegrationError";
    this.fields = fields;
  }
}

export function validateMaskCapability(
  draft: CreationDraft,
  decision: CapabilityDecision
): readonly string[] {
  if (draft.mask === undefined) return [];
  if (!decision.enabled) {
    throw new MaskIntegrationError(UNCONFIRMED_CAPABILITY_MESSAGE, {
      mask: UNCONFIRMED_CAPABILITY_MESSAGE
    });
  }
  if (draft.mode !== "edit" || draft.target === undefined || draft.mask.targetSlot !== 0) {
    const message = "遮罩必须绑定编辑目标的 target slot 0。";
    throw new MaskIntegrationError(message, { mask: message });
  }
  return decision.state === "degraded" && decision.detail ? [decision.detail] : [];
}

export function maskTargetIdentity(target: DraftImageInput | undefined): string | undefined {
  if (target?.locator?.source === "asset") {
    return `asset:${target.locator.assetId}`;
  }
  if (target?.locator?.source === "artifact") {
    return `artifact:${target.locator.artifactId}`;
  }
  if (target?.locator?.source === "upload") {
    return `upload:${target.locator.uploadResourceId}`;
  }
  if (target?.upload?.uploadResourceId !== undefined) {
    return `upload:${target.upload.uploadResourceId}`;
  }
  return target === undefined ? undefined : `draft:${target.id}`;
}

function imageResourceTarget(
  target: DraftImageInput,
  resource: BrowserResourceDescriptor
): ReadyMaskTarget | undefined {
  if (
    !resource.mimeType.startsWith("image/") ||
    resource.width === undefined ||
    resource.height === undefined
  ) {
    return undefined;
  }
  return {
    key: maskTargetIdentity(target) ?? `resource:${resource.resourceId}`,
    resource,
    size: { width: resource.width, height: resource.height }
  };
}

export function immediateMaskTarget(
  target: DraftImageInput | undefined
): ReadyMaskTarget | undefined {
  if (target?.resource !== undefined) {
    return imageResourceTarget(target, target.resource);
  }
  const upload = target?.upload;
  const finalized = upload?.descriptor?.finalized;
  if (
    target !== undefined &&
    upload?.status === "ready" &&
    upload.descriptor?.status === "finalized" &&
    upload.descriptor.purpose === "target" &&
    upload.source.blob.type.startsWith("image/") &&
    finalized?.width !== undefined &&
    finalized.height !== undefined
  ) {
    return {
      key: maskTargetIdentity(target) ?? `draft:${target.id}`,
      blob: upload.source.blob,
      size: { width: finalized.width, height: finalized.height }
    };
  }
  return undefined;
}

export async function resolveMaskTarget(
  gateway: StudioGateway,
  target: DraftImageInput | undefined
): Promise<ReadyMaskTarget> {
  if (target === undefined) {
    throw new MaskIntegrationError("Add and finalize one edit target first.");
  }
  const immediate = immediateMaskTarget(target);
  if (immediate !== undefined) {
    return immediate;
  }
  if (target.locator?.source !== "asset") {
    throw new MaskIntegrationError(
      "The edit target does not expose a protected image resource with confirmed dimensions."
    );
  }
  const result = await gateway.invoke("getBrowserResource", {
    assetId: target.locator.assetId,
    rendition: "original"
  });
  if (result.status !== "succeeded" || result.resource === undefined) {
    throw new MaskIntegrationError(
      result.error?.safeMessage ?? "The protected edit target could not be resolved."
    );
  }
  const resolved = imageResourceTarget(target, result.resource);
  if (resolved === undefined) {
    throw new MaskIntegrationError(
      "The protected edit target does not provide valid image dimensions."
    );
  }
  return resolved;
}

export async function uploadMaskPng(
  gateway: StudioGateway,
  request: MaskPngUploadRequest,
  onChange: (item: UploadLifecycleItem) => void = () => undefined,
  id?: string
): Promise<FinalizedMaskUpload> {
  if (
    request.purpose !== "mask" ||
    request.targetSlot !== 0 ||
    request.width < 1 ||
    request.height < 1
  ) {
    throw new MaskIntegrationError("The mask upload request is not bound to target slot zero.");
  }
  const item = createUploadItem(
    "mask",
    { name: "routego-mask.png", blob: request.blob },
    id
  );
  const ready = await performUploadLifecycle(gateway, item, onChange);
  if (
    ready.status !== "ready" ||
    ready.descriptor?.status !== "finalized" ||
    ready.descriptor.purpose !== "mask"
  ) {
    throw new MaskIntegrationError("The PNG mask upload did not finalize.");
  }
  return { item: ready, resource: ready.descriptor };
}

export function attachFinalizedMask(
  draft: CreationDraft,
  locator: MaskUploadLocator,
  upload: UploadLifecycleItem
): CreationDraft {
  if (
    draft.mode !== "edit" ||
    draft.target === undefined ||
    locator.targetSlot !== 0 ||
    upload.status !== "ready" ||
    upload.purpose !== "mask" ||
    upload.uploadResourceId !== locator.image.uploadResourceId ||
    upload.descriptor?.status !== "finalized"
  ) {
    throw new MaskIntegrationError("The finalized mask no longer matches the active edit target.");
  }
  return { ...draft, mask: locator, maskUpload: upload };
}

export function clearDraftMask(draft: CreationDraft): CreationDraft {
  return { ...draft, mask: undefined, maskUpload: undefined };
}
