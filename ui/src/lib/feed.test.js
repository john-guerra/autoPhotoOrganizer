import { describe, it, expect } from "vitest";
import {
  formatGroupValue,
  mergeFeedPage,
  deriveSectionHeaders,
  nearestRealItemId,
  computeHeaderPaths,
  pathKey,
  headerParentPaths,
} from "./feed.js";

describe("formatGroupValue — absent levels (collapsed-group placeholders)", () => {
  // Regression: a collapsed group's placeholder only carries the grouping levels
  // down to where it was collapsed, so a deeper level is `undefined`. This hit
  // `value.replace()` and threw, blanking the whole feed.
  it("treats undefined/null as Unknown instead of throwing", () => {
    for (const dim of ["folderName", "folder", "year", "month"]) {
      expect(() => formatGroupValue(dim, undefined)).not.toThrow();
      expect(formatGroupValue(dim, undefined)).toBe("Unknown");
      expect(formatGroupValue(dim, null)).toBe("Unknown");
    }
  });
});

describe("deriveSectionHeaders — items that don't define every level", () => {
  it("skips levels an item lacks, and never emits an undefined value", () => {
    const items = [
      { groupValues: { kind: "image", folderName: "/a/x" } },
      // A collapsed nested group: only the outer level is present.
      { groupValues: { kind: "image" } },
      { groupValues: { kind: "image", folderName: "/a/y" } },
    ];
    const headers = deriveSectionHeaders(items, ["kind", "folderName"]);
    expect(() => headers.map((h) => h.label)).not.toThrow();
    for (const h of headers) expect(h.value).not.toBeUndefined();
    // The folderName level re-emits for /a/y after the gap.
    const names = headers
      .filter((h) => h.dimension === "folderName")
      .map((h) => h.value);
    expect(names).toEqual(["/a/x", "/a/y"]);
  });
});

describe("formatGroupValue", () => {
  it("maps the empty-string sentinel to 'Unknown'", () => {
    expect(formatGroupValue("year", "")).toBe("Unknown");
  });

  it("passes through a real value unchanged", () => {
    expect(formatGroupValue("year", "2024")).toBe("2024");
    expect(formatGroupValue("folder", "/photos/trip")).toBe("/photos/trip");
  });

  it("labels folderName as the POSIX path's basename", () => {
    expect(formatGroupValue("folderName", "/photos/2017/DCIM")).toBe("DCIM");
  });

  it("labels folderName as the Windows path's basename", () => {
    expect(formatGroupValue("folderName", "C:\\a\\b\\Trip")).toBe("Trip");
  });

  it("strips a trailing slash before taking folderName's basename", () => {
    expect(formatGroupValue("folderName", "/a/b/")).toBe("b");
  });

  it("maps the empty-string sentinel to 'Unknown' for folderName too", () => {
    expect(formatGroupValue("folderName", "")).toBe("Unknown");
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
      {
        items: [{ id: 1 }, { id: 2 }],
        hasMoreBefore: false,
        hasMoreAfter: true,
      },
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

describe("pathKey", () => {
  it("returns the same key for equal paths and different keys for different ones", () => {
    const a = [{ dimension: "folder", value: "/a" }];
    const b = [{ dimension: "folder", value: "/a" }];
    const c = [{ dimension: "folder", value: "/b" }];
    expect(pathKey(a)).toBe(pathKey(b));
    expect(pathKey(a)).not.toBe(pathKey(c));
  });

  it("gives the empty root path a stable key", () => {
    expect(pathKey([])).toBe(pathKey([]));
  });

  it("does not collide when a delimiter-like character sits inside a value", () => {
    // A folder value can contain '/', '=', ',' etc. — a naive join would let
    // [{folder,'a'},{year,'b'}] collide with [{folder,'a/year=b'}].
    const nested = [
      { dimension: "folder", value: "a" },
      { dimension: "year", value: "b" },
    ];
    const flat = [{ dimension: "folder", value: "a/year=b" }];
    expect(pathKey(nested)).not.toBe(pathKey(flat));
  });
});

describe("headerParentPaths", () => {
  it("returns each header's parent path, deduped, in first-appearance order", () => {
    const headers = computeHeaderPaths(
      deriveSectionHeaders(
        [
          { id: 1, groupValues: { year: "2024", folder: "/a" } },
          { id: 2, groupValues: { year: "2024", folder: "/b" } },
          { id: 3, groupValues: { year: "2020", folder: "/a" } },
        ],
        ["year", "folder"]
      )
    );
    // headers: 2024, 2024>/a, 2024>/b, 2020, 2020>/a
    // parents: [] (for 2024), [2024] (for /a and /b — deduped), [] (2020, dup),
    //          [2020] (for /a)
    expect(headerParentPaths(headers)).toEqual([
      [],
      [{ dimension: "year", value: "2024" }],
      [{ dimension: "year", value: "2020" }],
    ]);
  });

  it("keeps the empty root parent for a single top-level dimension", () => {
    const headers = computeHeaderPaths(
      deriveSectionHeaders(
        [{ id: 1, groupValues: { folder: "/a" } }],
        ["folder"]
      )
    );
    expect(headerParentPaths(headers)).toEqual([[]]);
  });

  it("returns nothing for no headers", () => {
    expect(headerParentPaths([])).toEqual([]);
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
