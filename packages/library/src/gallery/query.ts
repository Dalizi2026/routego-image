import { createHash } from "node:crypto";

import {
  identifierSchema,
  routegoSearchLibraryInputSchema,
  type RoutegoSearchLibraryInput
} from "@routego-image/contracts";

import { LibraryError } from "../errors";
import type {
  ImageLibraryIndex,
  StoredAssetRendition,
  StoredImageBlob,
  StoredLibraryAsset
} from "./model";

const CURSOR_VERSION = 1 as const;
const cursorPattern = /^[A-Za-z0-9_-]+$/u;

type ParsedSearchInput = ReturnType<typeof routegoSearchLibraryInputSchema.parse>;
type LibrarySort = ParsedSearchInput["sort"];

interface LibraryCursor {
  readonly version: 1;
  readonly sort: LibrarySort;
  readonly key: string;
  readonly assetId: string;
}

export interface LibraryQueryItem {
  readonly asset: StoredLibraryAsset;
  readonly rendition: StoredAssetRendition;
  readonly blob: StoredImageBlob;
}

export interface LibraryQueryPage {
  readonly input: ParsedSearchInput;
  readonly items: readonly LibraryQueryItem[];
  readonly total: number;
  readonly nextCursor?: string;
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function normalizedPrompt(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und");
}

function cursorKey(asset: StoredLibraryAsset, sort: LibrarySort): string {
  return sort === "prompt-asc" || sort === "prompt-desc"
    ? normalizedPrompt(asset.prompt)
    : String(Date.parse(asset.createdAt)).padStart(16, "0");
}

function encodedCursorKey(asset: StoredLibraryAsset, sort: LibrarySort): string {
  const key = cursorKey(asset, sort);
  return sort === "prompt-asc" || sort === "prompt-desc"
    ? `sha256:${createHash("sha256").update(key, "utf8").digest("hex")}`
    : key;
}

function compareKeyed(
  leftKey: string,
  leftAssetId: string,
  rightKey: string,
  rightAssetId: string,
  sort: LibrarySort
): number {
  const keyOrder = compareText(leftKey, rightKey);
  if (keyOrder !== 0) {
    return sort === "created-desc" || sort === "prompt-desc" ? -keyOrder : keyOrder;
  }
  return compareText(leftAssetId, rightAssetId);
}

function compareItems(left: LibraryQueryItem, right: LibraryQueryItem, sort: LibrarySort): number {
  return compareKeyed(
    cursorKey(left.asset, sort),
    left.asset.id,
    cursorKey(right.asset, sort),
    right.asset.id,
    sort
  );
}

function invalidCursor(): never {
  throw new LibraryError("invalid_request", "The Library search cursor is invalid.");
}

function encodeCursor(item: LibraryQueryItem, sort: LibrarySort): string {
  const cursor: LibraryCursor = {
    version: CURSOR_VERSION,
    sort,
    key: encodedCursorKey(item.asset, sort),
    assetId: item.asset.id
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string, expectedSort: LibrarySort): LibraryCursor {
  if (!cursorPattern.test(value)) invalidCursor();
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    return invalidCursor();
  }
  if (decoded.byteLength === 0 || decoded.toString("base64url") !== value) invalidCursor();

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded)) as unknown;
  } catch {
    return invalidCursor();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) invalidCursor();
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).length !== 4 ||
    record["version"] !== CURSOR_VERSION ||
    record["sort"] !== expectedSort ||
    typeof record["key"] !== "string" ||
    record["key"].length < 1 ||
    record["key"].length > 80 ||
    ((expectedSort === "prompt-asc" || expectedSort === "prompt-desc") &&
      !/^sha256:[a-f0-9]{64}$/u.test(record["key"])) ||
    ((expectedSort === "created-asc" || expectedSort === "created-desc") &&
      !/^\d{16}$/u.test(record["key"]))
  ) {
    invalidCursor();
  }
  let assetId: string;
  try {
    assetId = identifierSchema.parse(record["assetId"]);
  } catch {
    return invalidCursor();
  }
  return {
    version: CURSOR_VERSION,
    sort: expectedSort,
    key: record["key"],
    assetId
  };
}

function primaryItem(index: ImageLibraryIndex, asset: StoredLibraryAsset): LibraryQueryItem {
  const rendition = asset.renditions.find(
    (candidate) => candidate.artifactId === asset.primaryArtifactId
  );
  const blob = index.blobs.find((candidate) => candidate.sha256 === rendition?.blobSha256);
  if (!rendition || !blob) {
    throw new LibraryError("config_corrupt", "The Library search metadata is inconsistent.");
  }
  return { asset, rendition, blob };
}

function matches(input: ParsedSearchInput, item: LibraryQueryItem): boolean {
  const asset = item.asset;
  if (!input.includeDeleted && asset.status === "deleted") return false;
  if (
    input.query !== undefined &&
    !normalizedPrompt(asset.prompt).includes(normalizedPrompt(input.query))
  ) {
    return false;
  }
  if (input.models.length > 0 && !input.models.includes(asset.model)) return false;
  if (input.from !== undefined && Date.parse(asset.createdAt) < Date.parse(input.from)) return false;
  if (input.to !== undefined && Date.parse(asset.createdAt) > Date.parse(input.to)) return false;
  if (input.kinds.length > 0 && !input.kinds.includes(asset.kind)) return false;
  if (input.sizes.length > 0 && !input.sizes.includes(asset.effectiveParams.size)) return false;
  if (input.statuses.length > 0 && !input.statuses.includes(asset.status)) return false;
  if (
    input.folderIds.length > 0 &&
    !asset.folderIds.some((folderId) => input.folderIds.includes(folderId))
  ) {
    return false;
  }
  return true;
}

export function queryLibraryIndex(
  index: ImageLibraryIndex,
  input: RoutegoSearchLibraryInput
): LibraryQueryPage {
  const parsed = routegoSearchLibraryInputSchema.parse(input);
  const cursor = parsed.cursor === undefined ? undefined : decodeCursor(parsed.cursor, parsed.sort);
  const filtered = index.assets
    .map((asset) => primaryItem(index, asset))
    .filter((item) => matches(parsed, item))
    .sort((left, right) => compareItems(left, right, parsed.sort));
  const total = filtered.length;
  let cursorComparisonKey: string | undefined;
  if (cursor !== undefined) {
    if (parsed.sort === "prompt-asc" || parsed.sort === "prompt-desc") {
      const cursorAsset = index.assets.find((asset) => asset.id === cursor.assetId);
      if (!cursorAsset || encodedCursorKey(cursorAsset, parsed.sort) !== cursor.key) {
        invalidCursor();
      }
      cursorComparisonKey = cursorKey(cursorAsset, parsed.sort);
    } else {
      cursorComparisonKey = cursor.key;
    }
  }
  const afterCursor =
    cursor === undefined
      ? filtered
      : filtered.filter(
          (item) =>
            compareKeyed(
              cursorKey(item.asset, parsed.sort),
              item.asset.id,
              cursorComparisonKey!,
              cursor.assetId,
              parsed.sort
            ) > 0
        );
  const items = afterCursor.slice(0, parsed.limit);
  const hasMore = afterCursor.length > items.length;
  return {
    input: parsed,
    items,
    total,
    ...(hasMore && items.length > 0
      ? { nextCursor: encodeCursor(items[items.length - 1]!, parsed.sort) }
      : {})
  };
}
