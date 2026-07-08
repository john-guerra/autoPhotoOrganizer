import { describe, it, expect } from "vitest";
import {
  formatGroupValue,
  mergeFeedPage,
  deriveSectionHeaders,
  suppressPlaceholderHeaders,
  nearestRealItemId,
  computeHeaderPaths,
} from "./feed.js";

describe("formatGroupValue", () => {
  it("maps the empty-string sentinel to 'Unknown'", () => {
    expect(formatGroupValue("year", "")).toBe("Unknown");
  });

  it("passes through a real value unchanged", () => {
    expect(formatGroupValue("year", "2024")).toBe("2024");
    expect(formatGroupValue("folder", "/photos/trip")).toBe("/photos/trip");
  });
});

describe("mergeFeedPage", () => {
  const EMPTY = { items: [], hasMoreBefore: true, hasMoreAfter: true };

  it("appends an 'after' page and flags exhaustion when it's short", () => {
    const win = mergeFeedPage(
      { items: [{ id: 1 }], hasMoreBefore: false, hasMoreAfter: true },
      { items: [{ id: 2 }, { id: 3 }] },
      "after",
      2 // requested count
    );
    expect(win.items.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(win.hasMoreAfter).toBe(true); // got exactly what was requested
  });

  it("flags hasMoreAfter false when a page returns fewer than requested", () => {
    const win = mergeFeedPage(EMPTY, { items: [{ id: 1 }] }, "after", 5);
    expect(win.hasMoreAfter).toBe(false);
  });

  it("prepends a 'before' page and flags exhaustion when it's short", () => {
    const win = mergeFeedPage(
      { items: [{ id: 3 }], hasMoreBefore: true, hasMoreAfter: false },
      { items: [{ id: 1 }, { id: 2 }] },
      "before",
      5
    );
    expect(win.items.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(win.hasMoreBefore).toBe(false); // 2 < requested 5
  });

  it("never introduces a duplicate id across merges", () => {
    const win = mergeFeedPage(
      { items: [{ id: 1 }, { id: 2 }], hasMoreBefore: false, hasMoreAfter: true },
      { items: [{ id: 2 }, { id: 3 }] }, // id 2 overlaps
      "after",
      2
    );
    expect(win.items.map((i) => i.id)).toEqual([1, 2, 3]);
  });
});

describe("deriveSectionHeaders", () => {
  const ITEMS = [
    { id: 1, groupValues: { year: "2024", folder: "/a" } },
    { id: 2, groupValues: { year: "2024", folder: "/a" } },
    { id: 3, groupValues: { year: "2024", folder: "/b" } },
    { id: 4, groupValues: { year: "2020", folder: "/a" } },
  ];

  it("emits a header at every level boundary, outermost first", () => {
    const headers = deriveSectionHeaders(ITEMS, ["year", "folder"]);
    expect(headers).toEqual([
      { index: 0, depth: 0, dimension: "year", value: "2024", label: "2024" },
      { index: 0, depth: 1, dimension: "folder", value: "/a", label: "/a" },
      { index: 2, depth: 1, dimension: "folder", value: "/b", label: "/b" },
      { index: 3, depth: 0, dimension: "year", value: "2020", label: "2020" },
      { index: 3, depth: 1, dimension: "folder", value: "/a", label: "/a" },
    ]);
  });

  it("returns an empty array for an empty item list", () => {
    expect(deriveSectionHeaders([], ["folder"])).toEqual([]);
  });

  it("uses formatGroupValue for the label (Unknown bucket)", () => {
    const headers = deriveSectionHeaders(
      [{ id: 1, groupValues: { year: "" } }],
      ["year"]
    );
    expect(headers[0].label).toBe("Unknown");
  });
});

describe("computeHeaderPaths", () => {
  const ITEMS = [
    { id: 1, groupValues: { year: "2024", folder: "/a" } },
    { id: 2, groupValues: { year: "2024", folder: "/a" } },
    { id: 3, groupValues: { year: "2024", folder: "/b" } },
    { id: 4, groupValues: { year: "2020", folder: "/a" } },
  ];

  it("reconstructs each header's full ancestor path, resetting on an outer-dimension change", () => {
    const headers = deriveSectionHeaders(ITEMS, ["year", "folder"]);
    const withPaths = computeHeaderPaths(headers);
    expect(withPaths.map((h) => h.path)).toEqual([
      [{ dimension: "year", value: "2024" }],
      [
        { dimension: "year", value: "2024" },
        { dimension: "folder", value: "/a" },
      ],
      [
        { dimension: "year", value: "2024" },
        { dimension: "folder", value: "/b" },
      ],
      [{ dimension: "year", value: "2020" }],
      [
        { dimension: "year", value: "2020" },
        { dimension: "folder", value: "/a" },
      ],
    ]);
  });

  it("returns an empty array for no headers", () => {
    expect(computeHeaderPaths([])).toEqual([]);
  });
});

describe("suppressPlaceholderHeaders", () => {
  const displayEntries = [
    { kind: "photo", item: { id: 1 } },
    {
      kind: "placeholder",
      item: {
        id: "collapsed:folder=/a>year=2019",
        path: [
          { dimension: "folder", value: "/a" },
          { dimension: "year", value: "2019" },
        ],
      },
    },
    { kind: "photo", item: { id: 2 } },
  ];

  it("drops a header at or below a placeholder's own collapse depth", () => {
    const headers = [
      { index: 1, depth: 0, dimension: "folder", value: "/a", label: "/a" },
      { index: 1, depth: 1, dimension: "year", value: "2019", label: "2019" },
    ];
    const kept = suppressPlaceholderHeaders(headers, displayEntries);
    expect(kept).toEqual([
      { index: 1, depth: 0, dimension: "folder", value: "/a", label: "/a" },
    ]);
  });

  it("keeps headers on real photo entries untouched", () => {
    const headers = [
      { index: 0, depth: 0, dimension: "folder", value: "/a", label: "/a" },
      { index: 2, depth: 0, dimension: "folder", value: "/b", label: "/b" },
    ];
    expect(suppressPlaceholderHeaders(headers, displayEntries)).toEqual(
      headers
    );
  });
});

describe("nearestRealItemId", () => {
  it("finds the last real item's id, skipping a trailing placeholder", () => {
    const items = [{ id: 1 }, { id: 2 }, { id: "ph", collapsed: true }];
    expect(nearestRealItemId(items, "end")).toBe(2);
  });

  it("finds the first real item's id, skipping a leading placeholder", () => {
    const items = [{ id: "ph", collapsed: true }, { id: 1 }, { id: 2 }];
    expect(nearestRealItemId(items, "start")).toBe(1);
  });

  it("returns null when every item is a placeholder", () => {
    const items = [
      { id: "ph1", collapsed: true },
      { id: "ph2", collapsed: true },
    ];
    expect(nearestRealItemId(items, "end")).toBeNull();
  });
});
