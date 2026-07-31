import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, menu, clearScope } from "./helpers.js";

/**
 * Right-clicking a FEED section header opens the same group menu the tree offers.
 *
 * The header already has clickable icons for view-cycle and select, but the rest
 * of a group's actions (Jump, Keep only, Reveal, Rescan, Remove) lived only in
 * the tree's right-click menu — invisible to anyone working from the feed. This
 * wires the feed header through the SAME buildTreeMenuItems path, so the two can
 * never drift apart. (#126)
 *
 * Fixture: "Trip" is a real top-level folder; "Cards" is a virtual ancestor (a
 * directory with no photos of its own, hence no `folders` row) — it can be
 * revealed but not removed, exactly as in the tree menu.
 */

/** Right-click a feed section header on its LABEL text. The header box spans the
 *  whole row (its centre can be empty space, and the feed is virtualized + its
 *  headers are sticky, so a scrolled-to header can sit under a neighbour), but
 *  the label is always painted and always inside the header — a stable hit. The
 *  handler lives on the whole `.section-header`, so the event bubbles up to it. */
async function rightClickHeader(page, name) {
  const label = page
    .locator(".section-header", { hasText: name })
    .first()
    .locator(".section-label");
  await label.scrollIntoViewIfNeeded();
  await label.click({ button: "right" });
}

test.describe("@p1 the feed header's right-click menu", () => {
  // This file drives "Keep only these photos", which writes the server's
  // keep_scope table and — since #212 — outlives the page. `openApp` clears it
  // for the specs that call it; this is the belt to that pair of braces, for
  // the ones that do not (`burst.spec.js`, `filmstripBurst.spec.js`).
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await clearScope(page);
    await page.close();
  });

  test("a real folder header offers the full group menu", async ({ page }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    await rightClickHeader(page, "Trip");
    await expect(menu.root(page)).toBeVisible();

    // The group actions (were tree-only) …
    await expect(menu.item(page, "Jump to this group")).toBeVisible();
    await expect(
      menu.item(page, "Select all photos in this group")
    ).toBeVisible();
    await expect(menu.item(page, "Keep only these photos")).toBeVisible();
    // … plus the folder actions, all enabled for a real folder.
    await expect(menu.item(page, "Reveal in Finder")).toBeEnabled();
    await expect(menu.item(page, "Rescan this folder")).toBeEnabled();
    await expect(menu.item(page, "Remove from library…")).toBeEnabled();

    expect(errors).toEqual([]);
  });

  test("a virtual-ancestor header offers an ENABLED subtree Remove that opens the confirm", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    await rightClickHeader(page, "Cards");
    await expect(menu.root(page)).toBeVisible();
    // "Cards" has no `folders` row of its own, but Remove is now a subtree
    // operation, so it must be ENABLED and worded for the subtree. (It used to be
    // disabled while still rendering in the danger colour — it LOOKED clickable
    // but wasn't, the reported bug.)
    const remove = menu.item(page, "Remove folder and its contents…");
    await expect(remove).toBeEnabled();
    await expect(menu.item(page, "Reveal in Finder")).toBeEnabled();

    // Clicking it actually does something: the confirm dialog (which outlives the
    // menu) appears — proof the enabled item is wired, not inert.
    await remove.click();
    await expect(
      page.getByRole("button", { name: "Remove from library" })
    ).toBeVisible();

    expect(errors).toEqual([]);
  });
});
