import { test, expect } from "@playwright/test";
import { openApp, trackPageErrors, scrubber } from "./helpers.js";

// The scrubber lives in the seam between the manifest fetch, the layout window
// and the feed-jump machinery — exactly where this app's DOM/scroll bugs hide, so
// it belongs in e2e (not a unit test). trackPageErrors alone catches a crash in
// the render or the pointer/keyboard paths.

test("scrubber shows landmarks for the current grouping and a thumb", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await openApp(page); // default folder grouping

  await expect(scrubber.rail(page)).toBeVisible();
  await expect(scrubber.thumb(page)).toBeVisible();
  await expect(scrubber.labels(page).first()).toBeVisible();

  // Labels reflect the folder landmarks of the hermetic fixture.
  const texts = (await scrubber.labelTexts(page)).join("|");
  expect(texts).toMatch(/Trip|Party|Cam|Cards/);

  expect(errors).toEqual([]);
});

test("clicking a landmark and the [ / ] keys navigate without errors", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await openApp(page);

  // Clicking a landmark drives the rail's pointer handler → guarded jumpToPath.
  await scrubber.labels(page).first().click();
  await expect(page.locator(".section-header").first()).toBeVisible();

  // Keyboard hops both directions (window-bound; no input focused).
  await page.keyboard.press("]");
  await page.keyboard.press("[");
  await expect(page.locator(".section-header").first()).toBeVisible();

  // The grid never threw and no key spliced a duplicate row (the classic feed
  // freeze) — the section headers are still rendering.
  expect(errors).toEqual([]);
});
