import { describe, it, expect } from "vitest";
import { buildFolderTree, chainTo, descendantGroups } from "./folderTree.js";

/** The server hands us a flat list of every folder that has photos, as
 * {value: absPath, count}. These tests pin the shape we turn that into. */
const at = (roots, ...labels) => {
  let nodes = roots;
  let node;
  for (const label of labels) {
    node = nodes.find((n) => n.label === label);
    if (!node)
      throw new Error(`no node "${label}" among ${nodes.map((n) => n.label)}`);
    nodes = node.children;
  }
  return node;
};

describe("buildFolderTree", () => {
  it("nests folders under their parent instead of repeating the path", () => {
    const roots = buildFolderTree([
      { value: "/lib/2005", count: 2 },
      { value: "/lib/2005/harbour", count: 3 },
      { value: "/lib/2006", count: 4 },
    ]);
    expect(roots).toHaveLength(1);
    expect(roots[0].label).toBe("lib");
    expect(roots[0].children.map((n) => n.label)).toEqual(["2005", "2006"]);
    expect(at(roots, "lib", "2005").children.map((n) => n.label)).toEqual([
      "harbour",
    ]);
  });

  it("compacts single-child chains into one row (explorer.compactFolders)", () => {
    const roots = buildFolderTree([
      { value: "/Users/j/Pictures/backup/2024", count: 1 },
      { value: "/Users/j/Pictures/backup/2025", count: 1 },
    ]);
    expect(roots.map((n) => n.label)).toEqual(["Users/j/Pictures/backup"]);
    expect(roots[0].value).toBe("/Users/j/Pictures/backup");
    expect(roots[0].children.map((n) => n.label)).toEqual(["2024", "2025"]);
  });

  it("promotes the branch point to roots, so volumes do not share a useless '/' row", () => {
    const roots = buildFolderTree([
      { value: "/Volumes/EOS/DCIM/100CANON", count: 5 },
      { value: "/Volumes/EOS/DCIM/101CANON", count: 5 },
      { value: "/Users/j/Pictures/trip", count: 7 },
    ]);
    // Order follows the server's (abs_path ASC); we never re-sort, because the
    // server's ordering is what the feed's group order is built from.
    expect(roots.map((n) => n.label)).toEqual([
      "Volumes/EOS/DCIM",
      "Users/j/Pictures/trip",
    ]);
    expect(at(roots, "Volumes/EOS/DCIM").children.map((n) => n.label)).toEqual([
      "100CANON",
      "101CANON",
    ]);
  });

  it("never swallows a folder that has photos of its own into its only child", () => {
    const roots = buildFolderTree([
      { value: "/lib/2005", count: 2 },
      { value: "/lib/2005/harbour", count: 3 },
    ]);
    // /lib is empty with a single child, so it joins that child (compactFolders).
    // But the joined row IS the group /lib/2005 — 2005 has photos, so it keeps
    // its own row and harbour stays beneath it, or 2005 would lose its section.
    expect(roots.map((n) => n.label)).toEqual(["lib/2005"]);
    expect(roots[0].value).toBe("/lib/2005");
    expect(roots[0].isGroup).toBe(true);
    expect(roots[0].children.map((n) => n.label)).toEqual(["harbour"]);
  });

  it("rolls counts up: every row totals itself plus its descendants", () => {
    const roots = buildFolderTree([
      { value: "/lib/2005", count: 2 },
      { value: "/lib/2005/harbour", count: 3 },
      { value: "/lib/2006", count: 4 },
    ]);
    expect(roots[0].count).toBe(9);
    expect(at(roots, "lib", "2005").count).toBe(5);
    expect(at(roots, "lib", "2005").ownCount).toBe(2);
    expect(at(roots, "lib", "2005", "harbour").count).toBe(3);
  });

  it("marks folders with no photos of their own as virtual ancestors", () => {
    const roots = buildFolderTree([
      { value: "/lib/2005/harbour", count: 3 },
      { value: "/lib/2005/cali", count: 1 },
    ]);
    const y = at(roots, "lib/2005");
    expect(y.isGroup).toBe(false);
    expect(y.ownCount).toBe(0);
    expect(y.count).toBe(4);
    expect(at(roots, "lib/2005", "harbour").isGroup).toBe(true);
  });

  it("keeps the server's ordering of leaves within a parent", () => {
    const roots = buildFolderTree([
      { value: "/lib/b", count: 1 },
      { value: "/lib/a", count: 1 },
    ]);
    expect(roots[0].children.map((n) => n.label)).toEqual(["b", "a"]);
  });

  it("survives the degenerate inputs", () => {
    expect(buildFolderTree([])).toEqual([]);
    const one = buildFolderTree([{ value: "/lib/only", count: 1 }]);
    expect(one.map((n) => n.label)).toEqual(["lib/only"]);
    expect(one[0].isGroup).toBe(true);
  });

  it("keeps a folder's EXACT server value in groupValue, trailing slash and all", () => {
    // A rare abs_path carries a trailing slash. The rebuilt `value` drops it
    // (splitPath ignores empty segments), so a jump built from `value` would miss
    // the group the feed/seek key on — "jump to that folder" showed no photos.
    // `groupValue` preserves the verbatim string so the jump lands.
    const roots = buildFolderTree([
      { value: "/lib/normal", count: 1 },
      { value: "/lib/odd/", count: 2 }, // trailing slash
    ]);
    const normal = at(roots, "lib", "normal");
    const odd = at(roots, "lib", "odd");
    expect(odd.value).toBe("/lib/odd"); // rebuilt — no trailing slash
    expect(odd.groupValue).toBe("/lib/odd/"); // verbatim — keeps it
    expect(normal.groupValue).toBe(normal.value); // identical for normal folders
  });

  it("chainTo tolerates the trailing slash the feed hands back", () => {
    // reveal/Follow looks the row up by the feed's raw group value ("/lib/odd/"),
    // but tree node values are normalised ("/lib/odd") — chainTo must still find it.
    const roots = buildFolderTree([{ value: "/lib/odd/", count: 2 }]);
    expect(chainTo(roots, "/lib/odd/").at(-1)?.value).toBe("/lib/odd");
    expect(chainTo(roots, "/lib/odd").at(-1)?.value).toBe("/lib/odd");
  });
});

/**
 * #172. TreeNode.svelte re-renders reactively to a `groupBy` change; the tree's
 * async reload (TreeSidebar.svelte's resetAndLoad) replaces the stale node data
 * behind it a tick later. In that window a node built for a NON-folder
 * dimension — no `.children` at all — can be treated as a folder node. This
 * was caught live (removing a leading dimension crashed the app, e2e coverage
 * in e2e/places.spec.js), not by a unit test — these pin the pure-logic half
 * of that fix directly, cheaply, without a browser.
 */
describe("stale-node-shape guards (#172)", () => {
  it("descendantGroups treats a missing .children as childless, not a crash", () => {
    // Not buildFolderTree output — a node shaped for a different dimension,
    // exactly what a mid-transition groupBy change can hand TreeNode.
    const bareLeaf = { isGroup: true, value: "/x" };
    expect(descendantGroups(bareLeaf)).toEqual(["/x"]);

    const bareNonGroup = { isGroup: false, value: "/x" };
    expect(descendantGroups(bareNonGroup)).toEqual([]);
  });

  it("descendantGroups still walks a real subtree normally", () => {
    const roots = buildFolderTree([
      { value: "/lib/2005", count: 2 },
      { value: "/lib/2005/harbour", count: 3 },
    ]);
    // /lib/2005 has photos of its own, so it keeps its own row (compacted with
    // /lib into one label) rather than being swallowed into "harbour".
    expect(descendantGroups(at(roots, "lib/2005"))).toEqual([
      "/lib/2005",
      "/lib/2005/harbour",
    ]);
  });

  it("chainTo treats a missing .children as childless, not a crash", () => {
    const bareNode = { value: "/lib", isGroup: false };
    expect(() => chainTo([bareNode], "/lib/2005")).not.toThrow();
    expect(chainTo([bareNode], "/lib/2005")).toEqual([]);
  });
});
