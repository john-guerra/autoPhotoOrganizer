import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, tree } from "./helpers.js";

/**
 * "Follow here" (2026-07-17): an opt-in tree checkbox that keeps the feed's VIEW
 * location (the eye anchor) revealed + scrolled into view in the tree as you
 * scroll. The scroll-FOLLOW itself needs a large virtualized feed (renderStart
 * only moves once tiles unmount) so it is verified manually on the real library
 * per the ROADMAP — the hermetic fixture is too small to virtualize. This spec
 * covers the control: it exists, defaults OFF, and its state persists.
 */
test("'Follow here' is on by default, drives the reveal without looping, and persists", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await openApp(page, { groupBy: ["folder"] });

  const follow = page.locator(".tree-follow input[type=checkbox]");
  // On by default — so the follow effect runs on load. That effect reads
  // treeSidebarRef (a bind:this ref) inside untrack(); tracking it would re-fire
  // forever (effect_update_depth_exceeded). The trackPageErrors assertion below is
  // what catches that loop — it fires on load now, no toggle needed.
  await expect(follow).toBeChecked();

  // Turning it off persists like the other sidebar prefs. (Asserting the stored
  // value, not via reload: the e2e harness re-clears localStorage on every
  // navigation, so a reload would wipe it regardless of the app's behaviour.)
  await follow.uncheck();
  await expect(follow).not.toBeChecked();
  const stored = await page.evaluate(() =>
    localStorage.getItem("autogallery.treeFollowHere")
  );
  expect(stored).toBe("false");

  expect(errors).toEqual([]);
});

/**
 * "You are here" in the tree — the same two anchors the timeline draws (#130):
 * an amber FOCUS dot (the photo you're working on) and a grey VIEW eye (the top
 * of the feed viewport). When they land on the same group the eye collapses into
 * the dot, exactly as the timeline's two ticks do. The tree used to have no live
 * marker at all — only a transient highlight from the "reveal" button.
 */
test("@p1 the tree marks where you are with a focus dot that follows the feed", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await openApp(page, { groupBy: ["folder"] });

  // On load focus and view coincide at the top of the feed, so exactly one amber
  // dot shows and no eye (the coincident case).
  await expect(page.locator(".tree-node-row .here-focus")).toHaveCount(1);
  await expect(page.locator(".tree-node-row .here-view")).toHaveCount(0);

  // The dot FOLLOWS the feed: jumping to another folder moves it there.
  await tree.label(page, "Cam 10").click();
  const marked = page.locator(".tree-node-row", {
    has: page.locator(".here-focus"),
  });
  await expect(marked).toHaveCount(1);
  await expect(marked).toContainText("Cam 10");

  expect(errors).toEqual([]);
});
