import { test, expect } from "@playwright/test";
import { openApp, trackPageErrors, tree } from "./helpers.js";

/**
 * The tree keeps the user's collapse/expand choices across a FILTER change.
 *
 * The tree resets its expand state on every reload; the reload fires on filter,
 * sort and grouping changes alike. So collapsing a folder and then typing in the
 * search box (a filter change, same grouping) used to re-expand the whole tree —
 * the collapse you just made sprang back open on the next keystroke (#125). A
 * grouping change SHOULD still start fresh (the old paths mean nothing under a
 * new hierarchy), but a mere filter change must leave your choices alone.
 *
 * Fixture: "Cards" is a virtual ancestor over "Cam 1"/"Cam 10". Searching "Cam"
 * keeps that subtree but drops "Trip" — a VISIBLE change we can wait on, so the
 * assertion runs only after the tree has actually reloaded under the new filter
 * (the earlier version raced the search debounce and passed even when broken).
 */
test("@p0 collapsing a tree folder survives a filter change", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await openApp(page, { groupBy: ["folder"] });

  // Starts expanded: "Trip" and the children under "Cards" are all on screen.
  await expect(tree.node(page, "Trip")).toBeVisible();
  await expect(tree.node(page, "Cam 1")).toBeVisible();
  await expect(tree.node(page, "Cam 10")).toBeVisible();

  // Collapse "Cards" in the TREE — its children leave the sidebar entirely.
  await tree.foldIcon(page, "Cards").click();
  await expect(page.locator(".tree-node-row", { hasText: "Cam 1" })).toHaveCount(
    0
  );

  // A filter change (search) that reshapes the tree: "Cam" keeps the Cards
  // subtree but drops "Trip". Waiting for Trip to vanish proves the tree actually
  // reloaded under the new filter — which is when the bug (a full re-expand)
  // would strike.
  await page.locator(".search-input").fill("Cam");
  await expect(page.locator(".tree-node-row", { hasText: "Trip" })).toHaveCount(
    0
  );
  await expect(tree.node(page, "Cards")).toBeVisible();

  // "Cards" is STILL collapsed after the reload — the children did not come back.
  await expect(page.locator(".tree-node-row", { hasText: "Cam 1" })).toHaveCount(
    0
  );
  await expect(
    page.locator(".tree-node-row", { hasText: "Cam 10" })
  ).toHaveCount(0);
  await expect(tree.foldIcon(page, "Cards")).toHaveAttribute(
    "aria-expanded",
    "false"
  );

  expect(errors).toEqual([]);
});
