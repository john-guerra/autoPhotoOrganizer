import { test, expect } from "@playwright/test";
import {
  trackPageErrors,
  openApp,
  albums,
  grid,
  statusBar,
} from "./helpers.js";

/**
 * P0 — THE ALBUM TIMELINE. Both tests here are bugs that were live in the first
 * build of the timeline, and neither was reachable from a unit test:
 *
 *  - clicking an album band scrolled the list by SEVEN PIXELS and stopped.
 *    `scrollIntoView({behavior: "smooth"})` starts a 16,000px animation, and the
 *    snapshot strips mounting along the way interrupt it. The click handler was
 *    correct, the hit test was correct, the right album index was dispatched —
 *    and the user still went nowhere. Only a real browser, with real scrolling
 *    and real mounting, can see this.
 *  - the chart and the list disagreed about which album was which, which is only
 *    observable by comparing what two separate components actually painted.
 *
 * The lesson the repo keeps relearning: the bugs live in the seam between
 * modules and the DOM, not inside the modules.
 */

test.describe("@p0 album timeline", () => {
  test("clicking a band jumps the list to that album — all the way, not 7px", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await albums.open(page);

    const n = await albums.bands(page).count();
    expect(
      n,
      "the fixture must produce several albums or this proves nothing"
    ).toBeGreaterThan(2);

    // The list must actually be scrollable, or "it jumped" is vacuously true.
    const scrollable = await albums
      .scroll(page)
      .evaluate((el) => el.scrollHeight > el.clientHeight + 50);
    expect(scrollable, "album list is not scrollable — test is vacuous").toBe(
      true
    );
    expect(await albums.scrollTop(page)).toBe(0);

    // Click the LAST album's band: the furthest jump the chart can ask for, and
    // the one the interrupted smooth-scroll failed hardest at.
    await albums.band(page, n - 1).click();

    // Asserted IMMEDIATELY, with no polling and no waiting: the jump must have
    // already happened by the time the click returns.
    //
    // This is not pedantry about a millisecond — it is the only way to state the
    // property that was broken. Polling would happily wait out a smooth-scroll
    // animation and go green, which is exactly what it did when I put the bug
    // back to check: the fixture is small, nothing mounts mid-flight to interrupt
    // the animation, and the stall never reproduces here. What DOES reproduce,
    // deterministically and at any library size, is that an animated jump has not
    // arrived yet when the click ends — and an animation that has not arrived is
    // an animation that can be interrupted. Forbid the animation and the stall
    // cannot come back.
    expect(
      await albums.scrollTop(page),
      "the list never moved — the click was a dead control"
    ).toBeGreaterThan(0);
    expect(
      await albums.landedOn(page, n - 1),
      "the list did not arrive at the album that was clicked (an animated jump?)"
    ).toBe(true);

    // And the album you asked for is the one you can now see.
    await expect(albums.divider(page, n - 1)).toBeInViewport();

    expect(errors).toEqual([]);
  });

  test("the chart and the list agree: band i and divider i are the same album", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await albums.open(page);

    const n = await albums.bands(page).count();
    expect(await albums.dividers(page).count()).toBe(n);

    // The colour IS the link between the two views. If they ever stop being drawn
    // from the same source, the chart becomes a legend for a different list — and
    // it would still look perfectly plausible, which is why it needs asserting.
    for (let i = 0; i < n; i++) {
      const bandColor = await albums.band(page, i).getAttribute("fill");
      const chipColor = await albums
        .chip(page, i)
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(hexToRgb(bandColor), `album ${i}`).toBe(chipColor);
    }

    expect(errors).toEqual([]);
  });
});

/**
 * With photos selected, Auto Albums organizes JUST the selection — the global
 * button auto-scopes to it. Lives here because it's the seam between selection
 * state (App), the keep_scope server table, and the album timeline: exactly
 * where a unit test can't see it.
 */
test("@p1 a selection makes Auto Albums organize only those photos", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await openApp(page);

  // Pick three photos (the select circle toggles selection without opening the
  // loupe).
  await grid.selectCircle(page, 0).click();
  await grid.selectCircle(page, 1).click();
  await grid.selectCircle(page, 2).click();
  expect(await statusBar.selectedCount(page)).toBe(3);

  await albums.open(page);

  // The selection became the working scope — the chip says so — and the album
  // timeline was built from exactly those photos, not the whole library.
  await expect(statusBar.scopeChip(page)).toBeVisible();
  await expect(statusBar.scopeChip(page)).toContainText("3 photos");
  await expect(albums.bands(page).first()).toBeVisible();

  expect(errors).toEqual([]);
});

/**
 * The album-name field grows to fill the divider row. An <input>'s default width
 * is a fixed ~20ch that ignores its container, so without flex-grow the name
 * field stays cramped in a wide panel and the row's right half is dead space.
 * Only a real layout can show this — assert the field pushes the meta text to
 * the row's right edge.
 */
test("@p1 the album-name input grows to fill the row", async ({ page }) => {
  const errors = trackPageErrors(page);
  await openApp(page);
  await albums.open(page);

  await expect(albums.nameInput(page, 0)).toBeVisible();
  const divider = await albums.divider(page, 0).boundingBox();
  const meta = await albums.meta(page, 0).boundingBox();

  // The meta sits at the row's right edge (within the 4px right padding + a
  // little tolerance) — which is only true if the name field expanded to take
  // the slack. With the old fixed-width input, a large gap sat to meta's right.
  const gapToEdge = divider.x + divider.width - (meta.x + meta.width);
  expect(gapToEdge).toBeLessThan(12);

  expect(errors).toEqual([]);
});

/** "#4e79a7" -> "rgb(78, 121, 167)", the form getComputedStyle reports. */
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
