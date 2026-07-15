import { test, expect } from "@playwright/test";
import { trackPageErrors } from "./helpers.js";

/**
 * Clicking a burst stack expands it inline; Escape collapses it again.
 *
 * This is the test the Svelte 5 migration needed and didn't have. `expandedStackIds`
 * became a `$state(new Set())`, and the expand handler mutated it in place
 * (`.add()` / `.delete()`) then self-assigned `x = x` to "trigger reactivity" — the
 * Svelte 4 idiom. But a `$state` Set is NOT deeply reactive (only arrays/objects
 * are; reactive collections need `svelte/reactivity`), and `x = x` is a no-op, so
 * the `displayEntries` derived never recomputed and clicking a burst did nothing.
 * No e2e covered it because the shared fixture deliberately spaces photos a minute
 * apart to AVOID bursts. This one opts back in by widening the burst gap.
 *
 * The gap is seeded through localStorage (`autogallery.burstGapMs`) rather than the
 * slider, which caps at 10s: the fixture's photos are 60s apart, so a 90s gap
 * clusters each folder's same-day photos into one stack, with no fixture change.
 */
async function openWithBursts(page) {
  await page.addInitScript(() => {
    window.localStorage.clear();
    // 90s > the fixture's 60s spacing → same-day photos in a folder burst-cluster.
    window.localStorage.setItem("autogallery.burstGapMs", "90000");
  });
  await page.goto("/");
  await expect(page.locator(".thumb").first()).toBeVisible();
  await page.waitForTimeout(400);
}

test("@p0 clicking a burst expands it inline, and Escape collapses it", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await openWithBursts(page);

  // The wide gap must actually produce a stack, or the test proves nothing.
  const stackBadge = page.locator(".stack-badge").first();
  await expect(stackBadge).toBeVisible();
  await expect(page.locator(".stack-marker")).toHaveCount(0); // nothing expanded yet

  // The stack's cover tile is the .thumb that carries the ×N badge.
  const stackTile = page.locator(".thumb", {
    has: page.locator(".stack-badge"),
  });
  await stackTile.first().click();

  // Expanding replaces the single cover with its individual members, each tagged
  // as an expanded-stack member. If the Set mutation isn't reactive, this stays 0.
  await expect(page.locator(".stack-marker").first()).toBeVisible();
  expect(await page.locator(".stack-marker").count()).toBeGreaterThan(1);

  // Escape re-collapses the stack back to a single ×N cover tile.
  await page.keyboard.press("Escape");
  await expect(page.locator(".stack-marker")).toHaveCount(0);
  await expect(page.locator(".stack-badge").first()).toBeVisible();

  expect(errors).toEqual([]);
});
