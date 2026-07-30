import { describe, expect, it } from "vitest";

import {
  LibraryQueryError,
  advanceLibraryPage,
  buildLibrarySearchInput,
  createLibraryFilters,
  currentLibraryCursor,
  initialLibraryPage,
  paginationPageNumbers,
  retreatLibraryPage,
  type LibraryFilters
} from "../src/features/library";

describe("Studio Library path-free query and cursor state", () => {
  it("maps the complete filter set to contract input without paths", () => {
    const filters: LibraryFilters = {
      ...createLibraryFilters("library"),
      query: "  neon portrait  ",
      providerId: "provider-a",
      from: "2026-07-01",
      to: "2026-07-18",
      kinds: ["generate", "edit"],
      sizes: ["1024x1024", "unsupported"],
      statuses: ["succeeded", "partial", "deleted"],
      folderId: "folder-archive",
      sort: "prompt-asc",
      limit: 999
    };

    const input = buildLibrarySearchInput(filters, "library", "cursor-page-2");

    expect(input).toEqual({
      query: "neon portrait",
      models: [],
      providerIds: ["provider-a"],
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-18T23:59:59.999Z",
      kinds: ["generate", "edit"],
      sizes: ["1024x1024"],
      statuses: ["succeeded", "partial"],
      folderIds: ["folder-archive"],
      includeDeleted: false,
      sort: "prompt-asc",
      limit: 200,
      cursor: "cursor-page-2"
    });
    expect(JSON.stringify(input)).not.toMatch(
      /(?:path|file:\/\/|[A-Za-z]:\\|\/Users\/|data:image|base64)/iu
    );
  });

  it("keeps deleted records out of every Studio Library query and validates date ranges", () => {
    expect(buildLibrarySearchInput(createLibraryFilters("trash"), "trash")).toMatchObject({
      statuses: [],
      includeDeleted: false,
      kinds: ["generate", "edit"]
    });

    expect(() =>
      buildLibrarySearchInput(
        {
          ...createLibraryFilters("library"),
          from: "2026-07-19",
          to: "2026-07-18"
        },
        "library"
      )
    ).toThrow(LibraryQueryError);
  });

  it("turns the relative time controls into exact timestamp boundaries", () => {
    const input = buildLibrarySearchInput(
      { ...createLibraryFilters("library"), timeRange: "last-24-hours" },
      "library"
    );
    expect(input.from).toBeDefined();
    expect(input.to).toBeDefined();
    expect(Date.parse(input.to!) - Date.parse(input.from!)).toBe(24 * 60 * 60 * 1000);
  });

  it("tracks forward and backward cursors without replaying an abandoned forward branch", () => {
    const first = initialLibraryPage();
    const second = advanceLibraryPage(first, "cursor-2");
    const third = advanceLibraryPage(second, "cursor-3");

    expect(currentLibraryCursor(third)).toBe("cursor-3");
    const returned = retreatLibraryPage(third);
    expect(currentLibraryCursor(returned)).toBe("cursor-2");

    const replacement = advanceLibraryPage(returned, "cursor-3b");
    expect(replacement).toEqual({
      cursors: [undefined, "cursor-2", "cursor-3b"],
      index: 2
    });
  });

  it("renders a real compact page range without inventing extra pages", () => {
    expect(paginationPageNumbers(1, 2)).toEqual([1, 2]);
    expect(paginationPageNumbers(4, 42)).toEqual([1, "ellipsis", 3, 4, 5, "ellipsis", 42]);
  });
});
