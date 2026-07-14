import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp } from "./helpers.js";

/**
 * The toolbar must not reflow under the user.
 *
 * It used to be ONE wrapping flex row whose children were all flex-shrink:0, so
 * "wrap" was its only relief valve: add a third grouping dimension and the
 * group-by pills dropped onto a second line, shoving everything else around. The
 * fix is a deliberate shrink order (the search box gives; the pills never do),
 * which is exactly the kind of thing that a CSS edit elsewhere silently undoes —
 * and which no unit test can see.
 */

const ROW = ".topbar-row.primary";
const THREE_DIMS = ["folder", "year", "camera"];

/** Narrow enough that the row is genuinely UNDER PRESSURE, wide enough that the
 *  shrink order can still absorb it.
 *
 *  This matters more than it looks. At Playwright's default 1280px these
 *  assertions pass even with the old wrapping CSS restored — the row simply fits,
 *  and the test proves nothing. With three grouping dimensions the row's content
 *  wants ~1250px and can compress to ~1170px (the search box is the only thing
 *  that gives). So the window where the fix is the ONLY thing keeping the row on
 *  one line is a viewport of roughly 1200–1280px: the old CSS, which could not
 *  shrink anything, had to wrap here. That is also a real laptop width. */
const NARROW = { width: 1220, height: 800 };

/** Harder still: past the point where the shrink order can absorb the deficit.
 *
 *  A different bug lives out here, and it needs a different width to see. At 1220
 *  the row is only ~30px short, which the search box swallows on its own — so a
 *  child that shrinks when it shouldn't loses a pixel or two and clips nothing.
 *  Squeeze by ~350px and the choice becomes visible: either the group-by pills and
 *  the Type filter give up width (and get sliced, which is the bug), or they hold
 *  and the row overflows (which is what we want, and what test 1 measures at a
 *  width where it doesn't have to happen). */
const SQUEEZED = { width: 900, height: 800 };

test.describe("@p1 the toolbar", () => {
  test("stays a single row, even with three grouping dimensions", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.setViewportSize(NARROW);
    await openApp(page, { groupBy: THREE_DIMS });

    const row = page.locator(ROW);
    // One line: the row is no taller than its tallest control. Measuring HEIGHT
    // (not "did it wrap") is what a user actually sees, and it stays true however
    // the wrapping is implemented.
    const rowH = await row.evaluate((el) => el.getBoundingClientRect().height);
    const tallest = await row.evaluate((el) =>
      Math.max(...[...el.children].map((c) => c.getBoundingClientRect().height))
    );
    expect(rowH).toBeLessThanOrEqual(tallest + 2);

    // And nothing inside it is clipped or overflowing.
    const overflowing = await row.evaluate(
      (el) => el.scrollWidth > el.clientWidth + 1
    );
    expect(overflowing).toBe(false);

    expect(errors).toEqual([]);
  });

  test("the group-by pills keep their width; the search box is what gives", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.setViewportSize(SQUEEZED);
    await openApp(page, { groupBy: THREE_DIMS });

    // The pills all sit on ONE line. This is the reported bug, seen from inside
    // the widget: starve the group-by box of width and MultiAutoSelect doesn't
    // clip, it wraps — three dimensions stack onto three lines and the toolbar
    // grows to 154px. Comparing pill tops says that directly; measuring the box's
    // height can't, because when it wraps the whole ROW grows with it, so the box
    // still "fits" its parent.
    const pillTops = await page
      .locator(".group-by")
      .evaluate((el) =>
        [...el.querySelectorAll(".pill")].map((p) =>
          Math.round(p.getBoundingClientRect().top)
        )
      );
    expect(pillTops.length).toBe(THREE_DIMS.length);
    expect(new Set(pillTops).size).toBe(1);

    // And the search box is what gave: it is below its 150px preferred width.
    const searchW = await page
      .locator(".search-input")
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(searchW).toBeLessThan(150);

    expect(errors).toEqual([]);
  });

  test("the three rows split what NARROWS the library from how it is DRAWN", async ({
    page,
  }) => {
    // Rows 1 and 2 narrow the library: grouping, the filters, and the timeline —
    // which is a filter like any other (it cuts the working set by capture time,
    // and the counts follow it). Row 3 draws: full-view/snapshot/collapse, size,
    // burst, order — plus the two things that DO something, Locate and Auto
    // Albums. Getting this backwards is what made the timeline read as a display
    // widget.
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    // The timeline has a row to ITSELF, between the filters it belongs with and
    // the display controls it does not. It is not a slider — it draws a histogram
    // and hangs a date badge off each handle — so sharing a row rationed it ~200px
    // and the two badges landed on top of each other.
    await expect(
      page.locator(".topbar-row.timeline .time-filter")
    ).toBeVisible();
    await expect(page.locator(".topbar-row.primary .time-filter")).toHaveCount(
      0
    );
    await expect(
      page.locator(".topbar-row.secondary .time-filter")
    ).toHaveCount(0);

    await expect(
      page.locator(".topbar-row.secondary .cycle-all")
    ).toBeVisible();
    await expect(page.locator(".topbar-row.primary .cycle-all")).toHaveCount(0);

    // Size/burst/order moved out of the status bar so its right half is free for
    // the jobs widget.
    await expect(page.locator(".topbar .grid-controls")).toBeVisible();
    await expect(page.locator(".statusbar .grid-controls")).toHaveCount(0);

    // And the sidebar switch sits on its own row, over the sidebar it controls.
    await expect(
      page.locator(".topbar-row.secondary .seg-toggle")
    ).toBeVisible();

    expect(errors).toEqual([]);
  });
});
