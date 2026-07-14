import { describe, it, expect, vi } from "vitest";
import { buildTreeMenuItems } from "./treeMenu.js";

const FOLDER = {
  path: [{ dimension: "folder", value: "/L/Trip" }],
  folderPath: "/L/Trip",
  isFolder: true,
};

/** The labels a user would actually see, separators dropped. */
const labels = (items) => items.filter((i) => !i.separator).map((i) => i.label);
const find = (items, re) => items.find((i) => re.test(i.label ?? ""));

describe("buildTreeMenuItems", () => {
  it("offers the folder actions on a real folder", () => {
    const items = buildTreeMenuItems(FOLDER);
    expect(labels(items)).toEqual(
      expect.arrayContaining([
        "Jump to this group",
        "Keep only these photos",
        "Reveal in Finder",
        "Copy path",
        "Rescan this folder",
        "Remove from library…",
      ])
    );
    expect(find(items, /Remove/).enabled).toBe(true);
    expect(find(items, /Remove/).danger).toBe(true);
  });

  it("never offers Remove on a virtual ancestor", () => {
    // It is a real directory, but the index has no row for it (only folders that
    // CONTAIN photos get one) — so there is nothing to remove, and an enabled
    // Remove would be a menu item that silently does nothing.
    const items = buildTreeMenuItems({ ...FOLDER, isVirtual: true });
    expect(find(items, /Remove/).enabled).toBe(false);
    // …but it IS a folder on disk, so these still make sense.
    expect(find(items, /Reveal/).enabled).toBe(true);
    expect(find(items, /Rescan/).enabled).toBe(true);
  });

  it("says a virtual ancestor's selection covers the whole subtree", () => {
    const real = buildTreeMenuItems(FOLDER);
    const virt = buildTreeMenuItems({ ...FOLDER, isVirtual: true });
    expect(find(real, /Select all/).label).toMatch(/this group/);
    expect(find(virt, /Select all/).label).toMatch(/subtree/);
  });

  it("offers no folder actions on a non-folder group (a year, a camera)", () => {
    const items = buildTreeMenuItems({
      path: [{ dimension: "year", value: "2024" }],
      isFolder: false,
    });
    expect(labels(items)).not.toContain("Reveal in Finder");
    expect(labels(items)).not.toContain("Remove from library…");
    expect(labels(items)).toContain("Jump to this group");
  });

  it("names the view action by what it DOES, not by the current state", () => {
    const at = (rendererId) =>
      find(
        buildTreeMenuItems({ ...FOLDER, rendererId }),
        /snapshot|Collapse|Show all/
      ).label;
    expect(at("grid")).toBe("Show as a snapshot strip");
    expect(at("snapshot")).toBe("Collapse this group");
    expect(at("collapsed")).toBe("Show all photos");
  });

  it("only offers the sub-folder fold when there ARE sub-folders", () => {
    expect(labels(buildTreeMenuItems(FOLDER))).not.toContain(
      "Expand all sub-folders"
    );
    const withKids = buildTreeMenuItems({ ...FOLDER, hasChildren: true });
    expect(labels(withKids)).toContain("Expand all sub-folders");
    const open = buildTreeMenuItems({
      ...FOLDER,
      hasChildren: true,
      expanded: true,
    });
    expect(labels(open)).toContain("Collapse all sub-folders");
  });

  it("disables Jump when there is nowhere to jump", () => {
    const items = buildTreeMenuItems({ ...FOLDER, canJump: false });
    expect(find(items, /Jump/).enabled).toBe(false);
  });

  it("runs the handler the item names", () => {
    const on = { reveal: vi.fn(), remove: vi.fn(), rescan: vi.fn() };
    const items = buildTreeMenuItems({ ...FOLDER, on });
    find(items, /Reveal/).action();
    find(items, /Rescan/).action();
    find(items, /Remove/).action();
    expect(on.reveal).toHaveBeenCalledOnce();
    expect(on.rescan).toHaveBeenCalledOnce();
    expect(on.remove).toHaveBeenCalledOnce();
  });
});
