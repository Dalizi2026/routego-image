import type { BrowserResourceDescriptor, LibraryAssetDetail } from "@routego-image/contracts";

import type { StudioGateway } from "../../api";

export interface LibraryDownload {
  readonly blob: Blob;
  readonly fileName: string;
  readonly resource: BrowserResourceDescriptor;
}

export async function fetchProtectedResourceDownload(
  gateway: StudioGateway,
  resource: BrowserResourceDescriptor,
  fileName: string
): Promise<LibraryDownload> {
  return {
    blob: await gateway.fetchProtectedBlob(resource),
    resource,
    fileName
  };
}

function extension(mimeType: BrowserResourceDescriptor["mimeType"]): string {
  return mimeType === "image/jpeg"
    ? "jpg"
    : mimeType === "image/webp"
      ? "webp"
      : mimeType === "application/zip"
        ? "zip"
        : "png";
}

export async function fetchLibraryDownload(
  gateway: StudioGateway,
  asset: LibraryAssetDetail
): Promise<LibraryDownload> {
  const rendition = asset.renditions[0];
  if (rendition === undefined) {
    throw new Error("此图库项目没有可下载的图像版本。");
  }
  const result = await gateway.invoke("getBrowserResource", {
    assetId: asset.id,
    artifactId: rendition.artifactId,
    rendition: "original"
  });
  if (result.status !== "succeeded" || result.resource === undefined) {
    throw new Error(result.error?.safeMessage ?? "无法解析受保护下载资源。");
  }
  const blob = await gateway.fetchProtectedBlob(result.resource);
  return {
    blob,
    resource: result.resource,
    fileName: `routego-${asset.id}.${extension(result.resource.mimeType)}`
  };
}

export function triggerLibraryDownload(
  download: LibraryDownload,
  browser: {
    readonly createObjectURL: (blob: Blob) => string;
    readonly revokeObjectURL: (url: string) => void;
    readonly createAnchor: () => { href: string; download: string; click: () => void };
  } = {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    createAnchor: () => document.createElement("a")
  }
): void {
  const url = browser.createObjectURL(download.blob);
  try {
    const anchor = browser.createAnchor();
    anchor.href = url;
    anchor.download = download.fileName;
    anchor.click();
  } finally {
    browser.revokeObjectURL(url);
  }
}
