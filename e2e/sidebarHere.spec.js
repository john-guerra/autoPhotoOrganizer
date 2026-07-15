import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, tree } from "./helpers.js";

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
