import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { BrowserResourceDescriptor } from "@routego-image/contracts";

import { MaskEditor } from "../src/features/mask/MaskEditor";
import { resolveMaskShortcut } from "../src/features/mask/shortcuts";
import { maskCloseDisposition } from "../src/features/mask/state";

const target: BrowserResourceDescriptor = {
  resourceId: "resource-target-01",
  relativeUrl: "/api/v1/resources/resource-target-01",
  requiresSession: true,
  mimeType: "image/png",
  byteLength: 13,
  width: 64,
  height: 32,
  etag: "synthetic-target-v1",
  expiresAt: "2026-07-18T12:30:00.000Z"
};

const gateway = {
  fetchProtectedObjectUrl: vi.fn(async () => ({
    url: "blob:synthetic-target",
    mimeType: "image/png",
    byteLength: 13,
    revoked: false,
    revoke: () => undefined
  }))
};

describe("isolated full-screen mask editor", () => {
  it("renders an accessible full-screen workspace and literal target-slot indicator", () => {
    const markup = renderToStaticMarkup(
      createElement(MaskEditor, {
        gateway,
        target,
        targetAlt: "Synthetic protected target",
        capability: "supported",
        onUploadMask: vi.fn(),
        onSave: vi.fn(),
        onClose: vi.fn()
      })
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("画笔 B");
    expect(markup).toContain("橡皮擦 E");
    expect(markup).toContain("MASK → TARGET[0]");
    expect(markup).toContain('aria-label="目标图与可编辑遮罩覆盖层"');
  });

  it("blocks unconfirmed mask capability without pretending success", () => {
    const markup = renderToStaticMarkup(
      createElement(MaskEditor, {
        gateway,
        target,
        targetAlt: "Synthetic protected target",
        capability: "unknown",
        onUploadMask: vi.fn(),
        onSave: vi.fn(),
        onClose: vi.fn()
      })
    );
    expect(markup).toContain("当前中转未确认支持");
    expect(markup).toContain("不会伪装为模型编辑成功");
    expect(markup).toContain("disabled");
  });

  it("defines keyboard and unsaved-close decisions deterministically", () => {
    expect(resolveMaskShortcut({ key: "z", ctrlKey: true })).toBe("undo");
    expect(resolveMaskShortcut({ key: "Z", metaKey: true, shiftKey: true })).toBe("redo");
    expect(resolveMaskShortcut({ key: "]" })).toBe("increase-brush");
    expect(resolveMaskShortcut({ key: "b", editableTarget: true })).toBeUndefined();
    expect(maskCloseDisposition(false)).toBe("close");
    expect(maskCloseDisposition(true)).toBe("confirm-discard");
  });

  it("captures pointers while keeping source pixels, storage, and logs outside the editor", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/features/mask/MaskEditor.tsx", import.meta.url)),
      "utf8"
    );
    expect(source).toContain("setPointerCapture");
    expect(source).toContain("releasePointerCapture");
    expect(source).not.toMatch(/\bdrawImage\b/u);
    expect(source).not.toMatch(/\bconsole\./u);
    expect(source).not.toMatch(/localStorage|sessionStorage|data:image|;base64,/u);
  });
});
