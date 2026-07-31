import { test, expect } from "@playwright/test";
import {
  trackPageErrors,
  openApp,
  enrichAll,
  albums,
  grid,
  statusBar,
  clearScope,
} from "./helpers.js";

/**
 * Auto Albums AUTO-SCOPES to the selection (see the test below — the chip says
 * "3 photos"), which writes the server's keep_scope table. `openApp` clears that
 * for any spec that calls it, but `burst.spec.js` and `filmstripBurst.spec.js`
 * do not call it, and `burst` runs immediately after this file. So this cleanup
 * is not redundant with openApp's: it is what protects the two specs openApp
 * cannot reach. Without it they browse a three-photo library (#212).
 */
test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await clearScope(page);
  await page.close();
});

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
 *
 * Every test here calls `enrichAll` BEFORE `openApp`. Album detection
 * gap-clusters on `COALESCE(taken_at, …, mtime)` (see `workingSetTimeline`),
 * and enrichment is otherwise LAZY — only the photos the grid actually renders
 * get their EXIF read. So without this, how many albums the fixture produces
 * depends on how many thumbnails happened to paint first: the un-enriched ones
 * fall back to their build-time mtimes, which are milliseconds apart, and
 * collapse into a single album. That is the long-standing flake on the
 * album-count precondition below (see docs/AGENT-NOTES.md).
 */

test.describe("@p0 album timeline", () => {
  test("clicking a band jumps the list to that album — all the way, not 7px", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await enrichAll(page);
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
    await enrichAll(page);
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
  await enrichAll(page);
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
  await enrichAll(page);
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

/**
 * Editing an album's name feeds through to the materialize request. The name
 * input is one-way (`value={names[i]}` + oninput → editedNames), so a reactivity
 * slip would silently send the DEFAULT name and the folders on disk wouldn't
 * match what you typed. We intercept the POST (fulfilling with an error so
 * nothing is written to disk or indexed — the shared e2e DB stays hermetic) and
 * assert the payload carries the edit.
 */
test("@p1 materialize sends the edited album names, not the defaults", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await enrichAll(page);
  await openApp(page);
  await albums.open(page);

  const before = await albums.nameInput(page, 0).inputValue();
  await albums.nameInput(page, 0).fill("MyCustomTrip");
  expect(await albums.nameInput(page, 0).inputValue()).toBe("MyCustomTrip");

  let payload = null;
  await page.route("**/api/albums/materialize", async (route) => {
    payload = route.request().postDataJSON();
    // Fulfil with an error so doMaterialize stops here — no files copied/moved,
    // no rescan, nothing added to the shared fixture DB.
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: "stubbed after capturing payload" }),
    });
  });

  await albums.dest(page).fill("/tmp/autogallery-e2e-noop");
  await albums.materializeBtn(page).click();

  await expect.poll(() => payload).not.toBeNull();
  const names = payload.albums.map((a) => a.name);
  expect(names, `edited "${before}" → "MyCustomTrip"`).toContain(
    "MyCustomTrip"
  );

  // The stubbed 400 above is real from the browser's point of view — Chromium
  // logs ANY non-2xx resource response as its own "Failed to load resource"
  // console.error, whether or not the app intercepted it on purpose. Whether
  // that async console event lands before or after this assertion is a race
  // (CI's slower runners lose it far more often than a local machine does —
  // see docs/AGENT-NOTES.md's flaky-spec note for this file), so filter out
  // the one error this test itself caused instead of racing to outrun it.
  expect(errors.filter((e) => !/materialize|400/i.test(e))).toEqual([]);
});

/** "#4e79a7" -> "rgb(78, 121, 167)", the form getComputedStyle reports. */
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
