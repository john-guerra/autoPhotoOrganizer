import { test, expect } from "@playwright/test";
import {
  trackPageErrors,
  openApp,
  grid,
  mlPanel,
  faceSettings,
  statusBar,
  views,
  albums,
} from "./helpers.js";

/**
 * THE TESTS THE SMALL FIXTURE CANNOT RUN.
 *
 * `PAGE_SIZE` is 60 and the standard fixture is 19 photos, so the loaded feed
 * window and the filter's whole result set are the SAME SET there. Every bug
 * that lives in the gap between those two is invisible — including the one
 * this file exists for: #245's "Visible" took its count from `items` while
 * meaning "what the filter matches", and reverting that fix does not turn the
 * normal suite red.
 *
 * ## Running it
 *
 *     node e2e/bigFixture.mjs 500
 *     E2E_KEEP_FIXTURE=1 npm run test:e2e -- e2e/scale.spec.js
 *
 * Without `E2E_KEEP_FIXTURE=1` the bulk folder is deleted by globalSetup
 * before the first spec runs.
 *
 * ## It SKIPS LOUDLY, and that is deliberate
 *
 * A silent skip on the only check that a count means anything is
 * indistinguishable from a pass — the same rule the ML integration tests
 * follow (`docs/AGENT-NOTES.md`). So when the library is too small this prints
 * why and how to fix it, rather than quietly reporting green.
 */

/** More than one page, with room to spare. PAGE_SIZE is 60. */
const NEED = 120;

test.describe("@p1 scale — bigger than one feed page", () => {
  test.afterEach(async ({ page }) => {
    // The faces panel POLLS, so a request can still be in flight when a test
    // ends; Playwright then attributes the error to whichever spec runs next.
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test.beforeEach(async ({ page }) => {
    const res = await page.request.get("/api/photos/count");
    const { count } = await res.json();
    if (count < NEED) {
      const why =
        `SKIPPED: this file needs more than one feed page (${NEED}+ photos), ` +
        `the library has ${count}.\n` +
        `  Build it:  node e2e/bigFixture.mjs 500\n` +
        `  Run it:    E2E_KEEP_FIXTURE=1 npm run test:e2e -- e2e/scale.spec.js`;
      console.warn(why);
      test.skip(true, why);
    }
    // Same weights stub the faces scope spec uses: the control only renders
    // once weights are present, and a suite that downloads 191 MB is a suite
    // that fails on a plane. Nothing is downloaded or inferred.
    await page.route("**/api/ml/faces*", async (route, request) => {
      if (request.method() !== "GET") return route.continue();
      const real = await route.fetch();
      const body = await real.json();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...body,
          weights: { ready: true, missing: [], corrupt: [] },
        }),
      });
    });
  });

  test("Filtered counts the FILTER's result set, not the loaded window (#245)", async ({
    page,
  }) => {
    // THE regression test for #245, and the reason this file exists. On the
    // small fixture both numbers are 19 and the bug is invisible; here the
    // grid renders a page while the filter matches the whole library, so the
    // two can finally disagree — and if `filteredCount` ever goes back to
    // `items.length`, this is what says so.
    const errors = trackPageErrors(page);
    await openApp(page);

    const total = Number(
      (await page.request.get("/api/photos/count").then((r) => r.json())).count
    );
    expect(total).toBeGreaterThanOrEqual(NEED);

    // The grid is virtualized: only a fraction of the library has DOM nodes.
    // That fraction is exactly what the old code was counting.
    const rendered = await grid.tileCount(page);
    expect(rendered).toBeLessThan(total);

    await mlPanel.open(page);
    await expect(faceSettings.scope(page)).toBeVisible();

    // The Filtered option's own count, read off the control the user reads.
    const filteredRow = faceSettings
      .scope(page)
      .locator("label", { has: page.locator('input[value="filtered"]') });
    await expect(filteredRow).toContainText(total.toLocaleString("en-US"));

    // And it is NOT the rendered count — stated as its own assertion so a
    // failure says which of the two numbers it found.
    await expect(filteredRow).not.toContainText(
      new RegExp(`\\b${rendered}\\b`)
    );

    expect(errors).toEqual([]);
  });

  test("returning from another view repaints the feed, with no scroll (#248)", async ({
    page,
  }) => {
    // Invisible on the small fixture: 19 photos all fit, so there is no
    // virtualization window to lose. Here the grid renders a slice, and
    // leaving unmounts it — `updateVisibleRange` collapses the window to
    // `renderStart = 0, renderEnd = -1` when `gridEl` is gone, and coming back
    // finds `retainWindow` with nothing to retain. Measured before the fix:
    // 33 tiles before leaving, **1** on return. Any scroll fixed it, which is
    // exactly how it was reported.
    const errors = trackPageErrors(page);
    await openApp(page);

    // Scroll into the feed first: the report is about returning to a feed you
    // were working in, not one sitting at the top.
    await page.locator(".main-column").evaluate((el) => (el.scrollTop = 4000));
    await expect
      .poll(() => grid.tileCount(page), { timeout: 10000 })
      .toBeGreaterThan(8);

    await albums.open(page); // dismisses the first-run explainer
    await expect(page.locator(".album-timeline")).toBeVisible();

    await views.toGrid(page);

    // The assertion that matters: tiles are THERE, without touching the
    // scroller. A count of 1 is the collapse; anything at viewport scale is a
    // real repaint.
    await expect
      .poll(() => grid.tileCount(page), { timeout: 10000 })
      .toBeGreaterThan(1);
    await expect(page.locator(".thumb").first()).toBeVisible();

    expect(errors).toEqual([]);
  });

  test("the status bar's showing count is the library, not the page", async ({
    page,
  }) => {
    // The same claim one layer out, and the cheaper signal: if this disagrees
    // with the scope control then App and the panel have diverged again, which
    // is the shape of the original bug.
    const errors = trackPageErrors(page);
    await openApp(page);

    const total = Number(
      (await page.request.get("/api/photos/count").then((r) => r.json())).count
    );
    const rendered = await grid.tileCount(page);
    expect(rendered).toBeLessThan(total);

    await expect(statusBar.root(page)).toContainText(
      total.toLocaleString("en-US")
    );
    expect(errors).toEqual([]);
  });
});
