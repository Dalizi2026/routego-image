import type { StudioLibrarySearchInput } from "@routego-image/contracts";

import type { LibraryFilters, LibraryPageState, LibraryView } from "./types";

export class LibraryQueryError extends Error {
  readonly fields: Readonly<Record<string, string>>;

  constructor(message: string, fields: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "LibraryQueryError";
    this.fields = fields;
  }
}

const knownSizes = ["auto", "1024x1024", "1536x1024", "1024x1536"] as const;

export function createLibraryFilters(view: LibraryView): LibraryFilters {
  void view;
  return {
    query: "",
    models: "",
    from: "",
    to: "",
    kinds: ["generate", "edit"],
    sizes: [],
    statuses: [],
    sort: "created-desc",
    limit: 20
  };
}

export function parseLibraryList(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/u)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ];
}

function dateBoundary(value: string, end: boolean): string | undefined {
  if (value.trim() === "") return undefined;
  const parsed = new Date(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z`);
  if (Number.isNaN(parsed.valueOf())) {
    throw new LibraryQueryError("图库日期筛选无效。", {
      [end ? "to" : "from"]: "请输入有效日期。"
    });
  }
  return parsed.toISOString();
}

export function buildLibrarySearchInput(
  filters: LibraryFilters,
  view: LibraryView,
  cursor?: string
): StudioLibrarySearchInput {
  void view;
  const from = dateBoundary(filters.from, false);
  const to = dateBoundary(filters.to, true);
  if (from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to)) {
    throw new LibraryQueryError("图库日期范围无效。", {
      from: "开始日期不能晚于结束日期。"
    });
  }
  const sizes = filters.sizes.filter((size): size is (typeof knownSizes)[number] =>
    knownSizes.includes(size as (typeof knownSizes)[number])
  );
  return {
    ...(filters.query.trim() === "" ? {} : { query: filters.query.trim() }),
    models: [...parseLibraryList(filters.models)],
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    kinds: [...filters.kinds],
    sizes,
    statuses: filters.statuses.filter((status) => status !== "deleted"),
    ...(filters.folderId === undefined ? {} : { folderIds: [filters.folderId] }),
    includeDeleted: false,
    sort: filters.sort,
    limit: Math.min(200, Math.max(1, Math.round(filters.limit))),
    ...(cursor === undefined ? {} : { cursor })
  };
}

export function initialLibraryPage(): LibraryPageState {
  return { cursors: [undefined], index: 0 };
}

export function advanceLibraryPage(
  state: LibraryPageState,
  nextCursor: string | undefined
): LibraryPageState {
  if (nextCursor === undefined) return state;
  return {
    cursors: [...state.cursors.slice(0, state.index + 1), nextCursor],
    index: state.index + 1
  };
}

export function retreatLibraryPage(state: LibraryPageState): LibraryPageState {
  return state.index === 0 ? state : { ...state, index: state.index - 1 };
}

export function currentLibraryCursor(state: LibraryPageState): string | undefined {
  return state.cursors[state.index];
}
