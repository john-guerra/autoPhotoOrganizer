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
    expect(find(items, /Remove/).enabled).not.toBe(false); // enabled (undefined = on)
    expect(find(items, /Remove/).danger).toBe(true);
  });

  it("offers an ENABLED, subtree-worded Remove on a virtual ancestor", () => {
    // A virtual ancestor has no `folders` row of its OWN, but removal is now a
    // subtree operation (deleteFolderSubtree), so removing it drops every
    // descendant folder + their photos. Disabling it — while it rendered in the
    // danger colour and so LOOKED clickable — was the reported bug: an option that
    // shows up enabled must be enabled.
    const items = buildTreeMenuItems({ ...FOLDER, isVirtual: true });
    const remove = find(items, /Remove/);
    expect(remove.enabled).not.toBe(false); // enabled (undefined defaults to on)
    expect(remove.label).toMatch(/and its contents/i); // says it takes the subtree
    expect(remove.danger).toBe(true);
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
