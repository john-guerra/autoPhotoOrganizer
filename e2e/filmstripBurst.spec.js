import { test, expect } from "@playwright/test";
import { trackPageErrors, loupe } from "./helpers.js";

/**
 * The loupe filmstrip shows a burst the same way the grid does — a collapsed
 * cover carries a ×N badge (#127). The strip used to draw a flat sequence with no
 * hint that a cell stood for several photos.
 *
 * Same trick as burst.spec.js: the shared fixture spaces photos 60s apart to
 * AVOID bursts, so a 90s gap (seeded via localStorage, over the slider's 10s cap)
 * clusters each folder's same-day photos into one stack without touching the
 * fixture.
 */
async function openWithBursts(page) {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("autogallery.burstGapMs", "90000");
  });
  await page.goto("/");
  await expect(page.locator(".thumb").first()).toBeVisible();
  await page.waitForTimeout(400);
}

test("@p0 the loupe filmstrip badges a collapsed burst with its count", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await openWithBursts(page);

  // The wide gap actually produced a burst: a grid cover with a ×N badge.
  await expect(page.locator(".thumb .stack-badge").first()).toBeVisible();

  // Open the loupe. Its filmstrip is drawn from the SAME collapsed entries as the
  // grid, so the burst cover appears there too — now carrying the same ×N badge
  // (before the fix the strip drew it as an ordinary, unmarked cell).
  await loupe.open(page, 0);
  await expect(page.locator(".filmstrip")).toBeVisible();
  await expect(page.locator(".filmstrip .stack-badge").first()).toBeVisible();

  expect(errors).toEqual([]);
});
