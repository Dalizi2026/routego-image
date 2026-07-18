import type {
  LibraryAssetDetail
} from "@routego-image/contracts";

import type { LibraryAssetRelationship } from "./types";

export function clampComparisonPosition(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function comparisonPositionFromPointer(
  clientX: number,
  bounds: { readonly left: number; readonly width: number }
): number {
  if (!Number.isFinite(clientX) || bounds.width <= 0) return 50;
  return clampComparisonPosition(((clientX - bounds.left) / bounds.width) * 100);
}

export function comparisonPositionFromKey(
  position: number,
  key: string,
  step = 5
): number | undefined {
  if (key === "Home") return 0;
  if (key === "End") return 100;
  if (key === "ArrowLeft" || key === "ArrowDown") {
    return clampComparisonPosition(position - step);
  }
  if (key === "ArrowRight" || key === "ArrowUp") {
    return clampComparisonPosition(position + step);
  }
  return undefined;
}

export function orderedLibraryRelationships(
  asset: LibraryAssetDetail
): readonly LibraryAssetRelationship[] {
  return [...asset.relationships].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id)
  );
}

export function selectComparisonRelationships(asset: LibraryAssetDetail): {
  readonly source?: LibraryAssetRelationship | undefined;
  readonly output?: LibraryAssetRelationship | undefined;
} {
  const ordered = orderedLibraryRelationships(asset);
  return {
    source:
      ordered.find((relationship) => relationship.role === "source") ??
      ordered.find((relationship) => relationship.role === "target"),
    output: ordered.find((relationship) => relationship.role === "output")
  };
}

export function relationshipResourceInput(relationship: LibraryAssetRelationship) {
  return {
    assetId: relationship.relatedAssetId,
    ...(relationship.artifactId === undefined ? {} : { artifactId: relationship.artifactId }),
    rendition: "preview" as const
  };
}
