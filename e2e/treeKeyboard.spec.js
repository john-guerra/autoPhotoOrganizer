import { test, expect } from "@playwright/test";
import { openApp, trackPageErrors, grid, tree } from "./helpers.js";

/**
 * Keyboard navigation for the Library tree (VS Code-style): T focuses it, arrows
 * move a roving cursor, type-ahead jumps to a folder, Enter opens it in the feed,
 * and ←/→ collapse/expand. Lives in the seam between the tree DOM and App's
 * keydown owner, so it's e2e.
 * See docs/superpowers/specs/2026-07-17-tree-keyboard-nav-design.md.
 */
test("@p1 T focuses the tree; arrows + type-ahead move the cursor; Enter opens the folder", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await openApp(page, { groupBy: ["folder"] });

  // Move focus off any input (the groupBy pill can hold it on load), then T.
  await grid.focus(page, 0);
  await page.keyboard.press("t");
  await expect(page.locator(".tree-scroll")).toBeFocused();

  const cursor = page.locator(".tree-node-row.tree-cursor");
  await expect(cursor).toHaveCount(1); // a cursor appears on focus

  // ArrowDown moves it to a different row.
  const key1 = await cursor.getAttribute("data-tree-key");
  await page.keyboard.press("ArrowDown");
  const key2 = await cursor.getAttribute("data-tree-key");
  expect(key2).not.toBe(key1);

  // Type-ahead jumps the cursor to "Party", and Enter opens it in the feed.
  await page.keyboard.type("Party");
  await expect(cursor).toContainText("Party");
  await page.keyboard.press("Enter");
  await expect(
    page.locator(".section-header").filter({ hasText: "Party" }).first()
  ).toBeVisible();

  expect(errors).toEqual([]);
});

test("@p1 Esc hands keyboard control back to the photo feed", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await openApp(page, { groupBy: ["folder"] });

  await grid.focus(page, 0);
  await page.keyboard.press("t");
  await expect(page.locator(".tree-scroll")).toBeFocused();

  // Esc: focus leaves the tree, so the feed's window-level shortcuts (which
  // stand down while the tree holds focus) can act on the grid again.
  await page.keyboard.press("Escape");
  await expect(page.locator(".tree-scroll")).not.toBeFocused();

  // A feed shortcut now works: ArrowRight moves the grid's focused tile (the
  // blue-bordered .thumb.selected), which it could not while the tree owned the
  // keyboard. Identity is the tile's data-id, not a render index (virtualized).
  const focusedId = () =>
    page.locator(".thumb.selected").first().getAttribute("data-id");
  const before = await focusedId();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".thumb.selected").first()).not.toHaveAttribute(
    "data-id",
    before
  );

  expect(errors).toEqual([]);
});

test("@p1 ← collapses the folder under the cursor", async ({ page }) => {
  const errors = trackPageErrors(page);
  await openApp(page, { groupBy: ["folder"] });

  // The fixture starts expanded, so Cam 1/Cam 10 (under the virtual "Cards") show.
  await expect(tree.node(page, "Cam 10")).toBeVisible();

  await grid.focus(page, 0);
  await page.keyboard.press("t");
  await page.keyboard.type("Cards"); // cursor to the Cards row
  await expect(page.locator(".tree-node-row.tree-cursor")).toContainText(
    "Cards"
  );

  // ← collapses it — its children leave the tree.
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.locator(".tree-node-row", { hasText: "Cam 10" })
  ).toHaveCount(0);

  expect(errors).toEqual([]);
});
