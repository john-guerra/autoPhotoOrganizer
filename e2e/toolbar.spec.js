import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, toolbar } from "./helpers.js";

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

  test("every control sits in a named group, and the groups say what they do", async ({
    page,
  }) => {
    // A toolbar of undifferentiated icons makes you work out for yourself which
    // control is the reason you can only see 300 of your 114,000 photos. Each
    // group answers exactly one question and is labelled with it — so this asserts
    // membership by LABEL, which is what the user reads, rather than by the class
    // names the markup happens to use today.
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    // The ＋ has no group of its own: a legend telling you that ＋ adds things is
    // chrome about chrome, and a border around a single button is a panel. It
    // earns its place by being the toolbar's one PRIMARY button instead.
    expect(await toolbar.groupLabels(page)).toEqual([
      "Filter",
      "Group",
      "View",
    ]);

    // FILTER holds everything that takes photos away — including the timeline,
    // which narrows by capture time exactly as the stars and the kinds do.
    const filters = toolbar.group(page, "Filter");
    await expect(filters.locator(".search")).toBeVisible();
    await expect(filters.locator(".kinds")).toBeVisible();
    await expect(filters.locator(".time-filter")).toBeVisible();

    // GROUP is not a filter: it hides nothing, it decides how the survivors are
    // carved up — the same question the sidebar switch answers, so they sit
    // together. The pills used to live among the filters, which read as a category
    // error.
    const grouping = toolbar.group(page, "Group");
    await expect(grouping.locator(".group-by")).toBeVisible();
    await expect(grouping.locator(".seg-toggle")).toBeVisible(); // tree / fisheye
    await expect(filters.locator(".group-by")).toHaveCount(0);

    // VIEW is one group, not three: full view / Locate / Auto Albums, size and
    // burst, and sort are the same question asked several ways — how do I want to
    // LOOK at what's left? — so they share a border and a name.
    const view = toolbar.group(page, "View");
    await expect(view.locator(".cycle-all")).toBeVisible();
    await expect(view.locator(".grid-controls")).toBeVisible();
    await expect(view.locator(".sort-control")).toBeVisible();

    // Sort sits at the group's far RIGHT — the last question you ask. (Its right
    // edge, not its left: it is the last control, whatever is beside it.)
    const edges = await view.evaluate((el) => ({
      group: el.getBoundingClientRect().right,
      sort: el.querySelector(".sort-control").getBoundingClientRect().right,
    }));
    expect(edges.group - edges.sort).toBeLessThan(20);

    // And size/burst are out of the status bar, whose right half is the jobs
    // widget's now.
    await expect(page.locator(".statusbar .grid-controls")).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test("the ＋ menu is the one door to the library", async ({ page }) => {
    // The big blue "Folders" button spent a permanent ~120px of the toolbar on
    // something you press once a week, sitting next to a ＋ that did the other half
    // of the same job. Both live behind the ＋ now, and both are NAMED — a bare ＋
    // said "add", so "manage" had nowhere to live but a second button.
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    await expect(page.locator(".topbar .library-toggle")).toHaveCount(0);

    await toolbar.plus(page).click();
    await expect(toolbar.menuItem(page, "Add folder…")).toBeVisible();
    await expect(toolbar.menuItem(page, "Manage library")).toBeVisible();

    await toolbar.menuItem(page, "Manage library").click();
    await expect(
      page.locator('dialog.modal[aria-label="Manage library"]')
    ).toBeVisible();

    expect(errors).toEqual([]);
  });
});
