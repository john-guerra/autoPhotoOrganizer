import { test, expect } from "@playwright/test";
import {
  openApp,
  reload,
  resetRatings,
  trackPageErrors,
  grid,
  views,
  albums,
  statusBar,
} from "./helpers.js";

/**
 * THE VIEW REGISTRY, as the user meets it (#155).
 *
 * The behavioural half of the conformance gate. `ui/src/lib/views/registry.js`
 * has a vitest suite for what each view DECLARES; this file checks the
 * declaration is true of the running app — which is the half that matters,
 * because a capability flag nobody enforces is a comment.
 *
 * The split follows vitest.config.js: that tier is `environment: "node"` with
 * no jsdom, and a mounted component that merely renders would prove nothing
 * about whether a rating keystroke reaches SQLite. This one clicks and types.
 */
test.describe("view registry @p1", () => {
  test.beforeEach(async ({ page }) => {
    await resetRatings(page);
  });

  test("the grid is the default view, and the extraction kept its DOM", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);

    // #feed-grid and .thumb are what every other spec selects on. If the
    // extraction had changed either, this is where it shows up — and the whole
    // point of #155's acceptance bar was that no existing spec needed editing.
    await expect(views.grid(page)).toBeVisible();
    expect(await grid.tileCount(page)).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test("V cycles the main area to the next view and back", async ({ page }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await expect(views.grid(page)).toBeVisible();

    // Into Auto Albums. It is a working-set view, so entering it runs a bounded
    // fetch first — the grid must not disappear until that lands.
    await views.cycle(page);
    await expect(page.locator(".albums-view")).toBeVisible({ timeout: 15000 });
    await expect(views.grid(page)).toHaveCount(0);

    // ...and back. Two views, so one more press wraps to the grid.
    await views.cycle(page);
    await expect(views.grid(page)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("a working-set view is NOT restored on reload — its data didn't survive", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await views.cycle(page);
    await expect(page.locator(".albums-view")).toBeVisible({ timeout: 15000 });

    await reload(page);

    // Restoring the id alone would drop you into the album review with no
    // albums in it — an empty shell that reads as the app having lost your
    // work. Only `feed` views are restored; the rest reopen on the grid, one
    // keypress from where you were. Assert the DECISION, not "something
    // sensible happened".
    await expect(views.grid(page)).toBeVisible();
    await expect(page.locator(".albums-view")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  /**
   * The bug this whole capability idea exists to kill.
   *
   * Nothing used to guard the rating keys on the active view, so `3` during the
   * Auto Albums review rated `displayEntries[selected]` — a photo in the FEED
   * window, which the albums view is not showing you. A rating landed on an
   * invisible photo, silently. Same for `X` and the selection.
   */
  test("a view that declares it cannot rate refuses the keystroke and says why", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);

    // Focus the first tile in the grid — this is the photo the old code would
    // have rated from inside the albums view.
    await grid.focus(page, 0);
    await expect(grid.ratingBadge(page, 0)).toHaveCount(0);

    await albums.open(page);
    await page.keyboard.press("3");

    // Told, specifically, naming the view and the way out — not a dead key.
    await expect(statusBar.status(page)).toContainText("Auto Albums");
    await expect(statusBar.status(page)).toContainText(
      /Rating isn't available/
    );

    // And crucially: nothing was rated behind your back.
    await views.cycle(page);
    await expect(views.grid(page)).toBeVisible();
    await expect(grid.ratingBadge(page, 0)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a view that declares it cannot select refuses X and says why", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await grid.focus(page, 0);

    await albums.open(page);
    await page.keyboard.press("x");

    await expect(statusBar.status(page)).toContainText(
      /Selecting photos isn't available/
    );

    await views.cycle(page);
    await expect(views.grid(page)).toBeVisible();
    expect(await statusBar.selectedCount(page)).toBe(0);
    expect(errors).toEqual([]);
  });

  test("the switcher button is rendered from the registry and toggles", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);

    // Not "a button that says Auto Albums" — the button exists BECAUSE the
    // registry has an entry with that id. A new view gets one for free, and
    // this is the assertion that proves it rather than assuming it.
    const btn = views.switchBtn(page, "albums");
    await expect(btn).toBeVisible();
    await expect(btn).toHaveAttribute("aria-pressed", "false");

    await btn.click();
    await expect(page.locator(".albums-view")).toBeVisible({ timeout: 15000 });
    await expect(btn).toHaveAttribute("aria-pressed", "true");

    // The first-run explainer is a <dialog>, so it is MODAL and swallows every
    // click on the page behind it — including the one below. `openApp` clears
    // localStorage, so a first-time user is exactly the state we are in.
    // (`albums.open` dismisses it for you; this test drives the button itself,
    // so it has to do the same.)
    const modal = page.locator('dialog.modal[aria-label="Auto Albums"]');
    await modal.locator("button", { hasText: "Cancel" }).click();
    await expect(modal).toBeHidden();

    // Pressing it again is the way out — a view you can enter and not leave is
    // a trap.
    await btn.click();
    await expect(views.grid(page)).toBeVisible();
    expect(errors).toEqual([]);
  });
});
