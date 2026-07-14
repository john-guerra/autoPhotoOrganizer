import { describe, it, expect } from "vitest";
import { buildFolderTree } from "./folderTree.js";
import { pathKey } from "./feed.js";
import { nestFolderHeaders } from "./folderSections.js";

/** The trie the feed already has in hand: the tree API's folder level, which
 *  App fetches for the header counts anyway. */
function rootsFor(entries, parentPath = []) {
  return new Map([[pathKey(parentPath), buildFolderTree(entries)]]);
}

/** A header as computeHeaderPaths(deriveSectionHeaders(...)) produces it. */
function header(index, depth, dimension, value, path) {
  return { index, depth, dimension, value, label: value, path };
}

const folderHeader = (index, value, prefix = []) =>
  header(index, prefix.length, "folder", value, [
    ...prefix,
    { dimension: "folder", value },
  ]);

describe("nestFolderHeaders", () => {
  it("nests a sub-folder under its parent", () => {
    const roots = rootsFor([
      { value: "/L/Trip", count: 2 },
      { value: "/L/Trip/Day1", count: 3 },
    ]);
    const out = nestFolderHeaders(
      [folderHeader(0, "/L/Trip"), folderHeader(2, "/L/Trip/Day1")],
      { groupBy: ["folder"], rootsByParentKey: roots }
    );
    // No separate "/L" row: it has one child and no photos, so folderTree merges
    // it into /L/Trip (labelled "L/Trip"). That merging is the whole reason a
    // 5-deep absolute path does not cost 5 levels of indent.
    expect(out.map((h) => [h.value, h.visualDepth])).toEqual([
      ["/L/Trip", 0],
      ["/L/Trip/Day1", 1],
    ]);
  });

  it("does not re-emit an ancestor already open above a sibling", () => {
    const roots = rootsFor([
      { value: "/L/Trip/Day1", count: 1 },
      { value: "/L/Trip/Day2", count: 1 },
    ]);
    const out = nestFolderHeaders(
      [folderHeader(0, "/L/Trip/Day1"), folderHeader(1, "/L/Trip/Day2")],
      { groupBy: ["folder"], rootsByParentKey: roots }
    );
    // "/L/Trip" is a virtual ancestor of BOTH; it must appear exactly once, and
    // the second sibling must not restart the whole chain under it.
    expect(out.map((h) => h.value)).toEqual([
      "/L/Trip", // compacted "/L/Trip" (unary chain /L -> /L/Trip), virtual
      "/L/Trip/Day1",
      "/L/Trip/Day2",
    ]);
    expect(out.filter((h) => h.value === "/L/Trip")).toHaveLength(1);
  });

  it("merges a unary chain into one row, so deep paths cost one level", () => {
    const roots = rootsFor([{ value: "/Users/j/Pictures/Trip", count: 1 }]);
    const out = nestFolderHeaders([folderHeader(0, "/Users/j/Pictures/Trip")], {
      groupBy: ["folder"],
      rootsByParentKey: roots,
    });
    // The 4 levels above Trip have no photos and one child each — one row.
    expect(out).toHaveLength(1);
    expect(out[0].visualDepth).toBe(0);
    expect(out[0].label).toBe("Users/j/Pictures/Trip");
  });

  it("marks a photo-less ancestor virtual, and carries the subtree's groups", () => {
    const roots = rootsFor([
      { value: "/L/Cards/Cam1", count: 1 },
      { value: "/L/Cards/Cam10", count: 1 },
    ]);
    const out = nestFolderHeaders(
      [folderHeader(0, "/L/Cards/Cam1"), folderHeader(1, "/L/Cards/Cam10")],
      { groupBy: ["folder"], rootsByParentKey: roots }
    );
    const cards = out[0];
    expect(cards.isVirtual).toBe(true);
    expect(cards.count).toBe(2); // rolled up — it has no photos of its own
    // Actions on a virtual row apply to the whole subtree (there is no folders
    // row to select/collapse), so it carries every real group beneath it.
    expect(cards.groupPaths).toEqual([
      [{ dimension: "folder", value: "/L/Cards/Cam1" }],
      [{ dimension: "folder", value: "/L/Cards/Cam10" }],
    ]);
    expect(out[1].isVirtual).toBe(false);
    expect(out[1].groupPaths).toEqual([
      [{ dimension: "folder", value: "/L/Cards/Cam1" }],
    ]);
  });

  it("a real folder keeps its own row even when it has one child", () => {
    // folderTree never compacts a folder that has photos of its own — it would
    // lose its feed section. The nesting must respect that.
    const roots = rootsFor([
      { value: "/L/Trip", count: 5 },
      { value: "/L/Trip/Day1", count: 1 },
    ]);
    const out = nestFolderHeaders(
      [folderHeader(0, "/L/Trip"), folderHeader(5, "/L/Trip/Day1")],
      { groupBy: ["folder"], rootsByParentKey: roots }
    );
    expect(out.map((h) => h.value)).toContain("/L/Trip");
    expect(out.find((h) => h.value === "/L/Trip").isVirtual).toBe(false);
  });

  it("nests a second grouping dimension BELOW the deepest folder", () => {
    // Two children, so /L/Trip is a real branch point and survives compaction —
    // giving a folder chain 2 rows deep for the day header to nest under.
    const roots = rootsFor([
      { value: "/L/Trip/Day1", count: 2 },
      { value: "/L/Trip/Day2", count: 1 },
    ]);
    const out = nestFolderHeaders(
      [
        folderHeader(0, "/L/Trip/Day1"),
        header(0, 1, "day", "2024-01-01", [
          { dimension: "folder", value: "/L/Trip/Day1" },
          { dimension: "day", value: "2024-01-01" },
        ]),
      ],
      { groupBy: ["folder", "day"], rootsByParentKey: roots }
    );
    // The folder chain is "/L/Trip" (virtual) -> "/L/Trip/Day1" = depths 0,1.
    // The day header must land BELOW it, at 2 — not at its groupBy index of 1.
    expect(out.map((h) => [h.dimension, h.visualDepth])).toEqual([
      ["folder", 0],
      ["folder", 1],
      ["day", 2],
    ]);
  });

  it("re-emits the folder chain when an OUTER dimension changes", () => {
    // groupBy ["year","folder"]: the same folder appearing under a new year is a
    // new section and must get its own headers back, under that year.
    const roots = new Map([
      [
        pathKey([{ dimension: "year", value: "2024" }]),
        buildFolderTree([{ value: "/L/Trip", count: 1 }]),
      ],
      [
        pathKey([{ dimension: "year", value: "2023" }]),
        buildFolderTree([{ value: "/L/Trip", count: 1 }]),
      ],
    ]);
    const y = (index, value) =>
      header(index, 0, "year", value, [{ dimension: "year", value }]);
    const out = nestFolderHeaders(
      [
        y(0, "2024"),
        folderHeader(0, "/L/Trip", [{ dimension: "year", value: "2024" }]),
        y(1, "2023"),
        folderHeader(1, "/L/Trip", [{ dimension: "year", value: "2023" }]),
      ],
      { groupBy: ["year", "folder"], rootsByParentKey: roots }
    );
    expect(out.map((h) => [h.dimension, h.value, h.visualDepth])).toEqual([
      ["year", "2024", 0],
      ["folder", "/L/Trip", 1],
      ["year", "2023", 0],
      ["folder", "/L/Trip", 1], // NOT swallowed as "already open"
    ]);
  });

  it("nests a folder whose stored path has a trailing slash", () => {
    // Exactly one folder in the real library is stored as "…/Fotos_Caos/". The
    // trie splits on "/" and drops empties, so its node value has no trailing
    // slash and a naive lookup misses — that folder alone rendered flat, with its
    // whole absolute path, while every other folder nested.
    const stored = "/L/Trip/Caos/";
    const roots = rootsFor([
      { value: stored, count: 1 },
      { value: "/L/Trip/Other", count: 1 },
    ]);
    const out = nestFolderHeaders([folderHeader(0, stored)], {
      groupBy: ["folder"],
      rootsByParentKey: roots,
    });
    expect(out.map((h) => [h.label, h.visualDepth])).toEqual([
      ["L/Trip", 0], // virtual ancestor
      ["Caos", 1], // nested, not a flat full path
    ]);
    // …but the group's own value/path must stay EXACTLY as the server gave it,
    // or equality against folders.abs_path stops matching and select / collapse /
    // remove silently do nothing on this one folder.
    const leaf = out[1];
    expect(leaf.value).toBe(stored);
    expect(leaf.path).toEqual([{ dimension: "folder", value: stored }]);
  });

  it("falls back to a flat header when the trie has not loaded yet", () => {
    // The counts fetch is async; until it lands there is no trie. The feed must
    // render flat rather than blank.
    const out = nestFolderHeaders([folderHeader(0, "/L/Trip/Day1")], {
      groupBy: ["folder"],
      rootsByParentKey: new Map(),
    });
    expect(out).toHaveLength(1);
    expect(out[0].visualDepth).toBe(0);
    expect(out[0].value).toBe("/L/Trip/Day1");
  });

  it("leaves a non-folder grouping untouched", () => {
    const out = nestFolderHeaders(
      [
        header(0, 0, "year", "2024", [{ dimension: "year", value: "2024" }]),
        header(3, 1, "day", "2024-01-01", [
          { dimension: "year", value: "2024" },
          { dimension: "day", value: "2024-01-01" },
        ]),
      ],
      { groupBy: ["year", "day"], rootsByParentKey: new Map() }
    );
    expect(out.map((h) => h.visualDepth)).toEqual([0, 1]);
  });
});
