import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, tree, menu } from "./helpers.js";

/**
 * The tree's right-click menu.
 *
 * Two things here can only be caught in a browser, which is why they are e2e:
 *
 *  - TreeNode recurses through TWO separate <svelte:self> blocks (sub-folders,
 *    and the next grouping dimension). A component event has to be forwarded at
 *    BOTH, and forgetting one leaves the menu working on the top level of the
 *    tree and silently dead everywhere below it — which looks fine in every
 *    screenshot of the first row.
 *  - ContextMenu closes on EVERY action, so the two-click "arm" that the group
 *    header uses for Remove cannot work inside it. The confirm has to outlive
 *    the menu.
 */

// The fixture nests "2024_03Mar_05 Cards/…Cam 1" and "…/Cam 10" under a Cards
// folder that holds NO photos of its own — a virtual ancestor.
const VIRTUAL_ANCESTOR = "Cards";
const REAL_LEAF = "Cam 10";

test.describe("@p1 the tree's right-click menu", () => {
  test("right-clicking a folder deep in the tree opens the menu", async ({
    page,
  }) => {
    // Cam 10 is rendered by TreeNode's SUB-FOLDER recursion, not the top level:
    // if only one of the two <svelte:self> sites forwards on:contextmenu, this is
    // the row that stays dead.
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    await tree.node(page, REAL_LEAF).click({ button: "right" });
    await expect(menu.root(page)).toBeVisible();
    await expect(menu.item(page, "Reveal in Finder")).toBeVisible();

    expect(errors).toEqual([]);
  });

  test("a real folder and a virtual ancestor can both be removed", async ({
    page,
  }) => {
    // A virtual ancestor is a real directory the index has no row for (only
    // folders that CONTAIN photos get one) — but its sub-folders do. Remove still
    // works: it drops the WHOLE subtree, so a photo-less parent is removable and
    // the menu says so ("…and its contents") instead of offering a dead item.
    // A leaf, holding its own photos, is a plain "Remove from library…".
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    await tree.node(page, REAL_LEAF).click({ button: "right" });
    await expect(menu.item(page, "Remove from library…")).toBeEnabled();
    await page.keyboard.press("Escape");

    await tree.node(page, VIRTUAL_ANCESTOR).click({ button: "right" });
    await expect(
      menu.item(page, "Remove folder and its contents…")
    ).toBeEnabled();
    // …and it IS a folder on disk, so these still apply.
    await expect(menu.item(page, "Reveal in Finder")).toBeEnabled();
    await expect(menu.item(page, "Rescan this folder")).toBeEnabled();

    expect(errors).toEqual([]);
  });

  test("Remove asks first, and cancelling leaves the library alone", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    const before = await tree.rowCount(page);

    await tree.node(page, REAL_LEAF).click({ button: "right" });
    await menu.item(page, "Remove from library…").click();

    // The confirm outlives the menu — the menu itself is already gone.
    await expect(menu.root(page)).toHaveCount(0);
    const dialog = page.locator(".modal");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Remove folder from library?");

    await dialog.locator(".confirm-cancel").click();
    await expect(dialog).toHaveCount(0);
    expect(await tree.rowCount(page)).toBe(before);

    expect(errors).toEqual([]);
  });

  test("a non-folder group is offered no folder actions", async ({ page }) => {
    // Group by day: a date is not a directory. Reveal / Rescan / Remove would all
    // be meaningless, so they must not be there at all.
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["day"] });

    await page.locator(".tree-node-row").first().click({ button: "right" });
    await expect(menu.root(page)).toBeVisible();
    await expect(menu.item(page, "Jump to this group")).toBeVisible();
    await expect(menu.item(page, "Reveal in Finder")).toHaveCount(0);
    await expect(menu.item(page, "Remove from library…")).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});
