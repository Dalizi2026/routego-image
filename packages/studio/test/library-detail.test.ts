import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { BrowserResourceDescriptor, LibraryAssetDetail } from "@routego-image/contracts";

import type { StudioGateway } from "../src/api";
import { I18nProvider } from "../src/i18n";
import {
  DimensionMismatchNotice,
  ImageComparison,
  clampComparisonPosition,
  clampPreviewZoom,
  comparisonPositionFromKey,
  comparisonPositionFromPointer,
  fetchLibraryDownload,
  orderedLibraryRelationships,
  relationshipResourceInput,
  selectComparisonRelationships,
  previewZoomFromWheel,
  triggerLibraryDownload
} from "../src/features/library";

const resource: BrowserResourceDescriptor = {
  resourceId: "resource-output-01",
  relativeUrl: "/api/v1/resources/resource-output-01",
  requiresSession: true,
  mimeType: "image/png",
  byteLength: 12,
  width: 64,
  height: 32,
  etag: "synthetic-output-v1",
  expiresAt: "2026-07-18T12:30:00.000Z"
};

const asset = {
  id: "asset-output-01",
  renditions: [
    {
      artifactId: "artifact-output-01",
      phase: "final",
      mimeType: "image/png",
      byteLength: 12,
      width: 64,
      height: 32,
      createdAt: "2026-07-18T12:00:00.000Z"
    }
  ],
  relationships: [
    {
      id: "relationship-output",
      role: "output",
      relatedAssetId: "asset-output-01",
      artifactId: "artifact-output-01",
      order: 2
    },
    {
      id: "relationship-source",
      role: "source",
      relatedAssetId: "asset-source-01",
      artifactId: "artifact-source-01",
      order: 0
    },
    {
      id: "relationship-reference",
      role: "reference",
      relatedAssetId: "asset-reference-01",
      order: 1
    }
  ]
} as unknown as LibraryAssetDetail;

describe("Library detail resources, comparison, and download", () => {
  it("labels a saved image when its actual dimensions differ from the request", () => {
    const markup = renderToStaticMarkup(
      createElement(DimensionMismatchNotice, {
        asset: {
          width: 1488,
          height: 1057,
          requestedParams: { size: "2048x1456", aspectRatio: "7:5" }
        } as LibraryAssetDetail,
        labels: {
          dimensionMismatch: "实际尺寸与请求尺寸不一致",
          requestedDimensions: "请求尺寸",
          actualDimensions: "实际尺寸",
          requestedAspectRatio: "请求比例"
        }
      })
    );

    expect(markup).toContain("实际尺寸与请求尺寸不一致");
    expect(markup).toContain("请求尺寸：2048 × 1456");
    expect(markup).toContain("实际尺寸：1488 × 1057");
  });

  it("keeps relationship order and protected resource lookups aligned", () => {
    const ordered = orderedLibraryRelationships(asset);
    expect(ordered.map((relationship) => relationship.id)).toEqual([
      "relationship-source",
      "relationship-reference",
      "relationship-output"
    ]);
    expect(selectComparisonRelationships(asset)).toMatchObject({
      source: { id: "relationship-source" },
      output: { id: "relationship-output" }
    });
    expect(relationshipResourceInput(ordered[0]!)).toEqual({
      assetId: "asset-source-01",
      artifactId: "artifact-source-01",
      rendition: "preview"
    });
    expect(relationshipResourceInput(ordered[1]!)).toEqual({
      assetId: "asset-reference-01",
      rendition: "preview"
    });
  });

  it("bounds pointer and keyboard comparison controls from zero through one hundred", () => {
    expect(clampComparisonPosition(-9)).toBe(0);
    expect(clampComparisonPosition(110)).toBe(100);
    expect(comparisonPositionFromPointer(125, { left: 100, width: 100 })).toBe(25);
    expect(comparisonPositionFromPointer(10, { left: 0, width: 0 })).toBe(50);
    expect(comparisonPositionFromKey(2, "ArrowLeft")).toBe(0);
    expect(comparisonPositionFromKey(98, "ArrowRight")).toBe(100);
    expect(comparisonPositionFromKey(55, "Home")).toBe(0);
    expect(comparisonPositionFromKey(55, "End")).toBe(100);
    expect(comparisonPositionFromKey(55, "Enter")).toBeUndefined();

    const markup = renderToStaticMarkup(
      createElement(
        I18nProvider,
        {
          initialLanguage: "en",
          children: createElement(ImageComparison, {
            gateway: {} as StudioGateway,
            source: resource,
            output: { ...resource, resourceId: "resource-output-02" },
            sourceLabel: "Source",
            outputLabel: "Result",
            controlLabel: "Comparison divider"
          })
        }
      )
    );
    expect(markup).toContain('type="range"');
    expect(markup).toContain('min="0"');
    expect(markup).toContain('max="100"');
    expect(markup).toContain('aria-label="Comparison divider"');
  });

  it("keeps original-image zoom within usable limits for wheel and trackpad input", () => {
    expect(clampPreviewZoom(0.1)).toBe(0.25);
    expect(clampPreviewZoom(8)).toBe(5);
    expect(previewZoomFromWheel(1, -120)).toBeGreaterThan(1);
    expect(previewZoomFromWheel(1, 120)).toBeLessThan(1);
    expect(previewZoomFromWheel(5, -120)).toBe(5);
    expect(previewZoomFromWheel(0.25, 120)).toBe(0.25);
  });

  it("downloads only a protected original and always revokes the temporary object URL", async () => {
    const invoke = vi.fn(async () => ({ schemaVersion: 1, status: "succeeded", resource }));
    const fetchProtectedBlob = vi.fn(async () => new Blob(["synthetic"], { type: "image/png" }));
    const gateway = { invoke, fetchProtectedBlob } as unknown as StudioGateway;

    const download = await fetchLibraryDownload(gateway, asset);
    expect(invoke).toHaveBeenCalledWith("getBrowserResource", {
      assetId: "asset-output-01",
      artifactId: "artifact-output-01",
      rendition: "original"
    });
    expect(download.fileName).toBe("routego-asset-output-01.png");

    const revoked: string[] = [];
    const click = vi.fn();
    triggerLibraryDownload(download, {
      createObjectURL: () => "blob:synthetic-download",
      revokeObjectURL: (url) => revoked.push(url),
      createAnchor: () => ({ href: "", download: "", click })
    });
    expect(click).toHaveBeenCalledOnce();
    expect(revoked).toEqual(["blob:synthetic-download"]);
  });
});
