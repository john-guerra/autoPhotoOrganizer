import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, menu } from "./helpers.js";

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

  test("a virtual-ancestor header can be revealed but not removed", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    await rightClickHeader(page, "Cards");
    await expect(menu.root(page)).toBeVisible();
    // No `folders` row to remove — same rule the tree menu enforces.
    await expect(menu.item(page, "Remove from library…")).toBeDisabled();
    await expect(menu.item(page, "Reveal in Finder")).toBeEnabled();

    expect(errors).toEqual([]);
  });
});
