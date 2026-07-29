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
  peopleView,
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

  // The race test below registers a `page.route`. An in-flight handler at
  // teardown rejects with "Test ended" and Playwright attributes it to
  // whichever spec runs NEXT — it has already surfaced once as a phantom
  // failure in feed.spec.js. Both faces specs carry this guard; this one was
  // one file short.
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
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

    // Dismiss the first-run explainer before the second V. It is a MODAL
    // <dialog>, and this only worked by accident: showModal() happens to focus
    // its "Fixed" button rather than its number input, so isTypingTarget() is
    // false. Reordering that modal's controls would break this test for a
    // reason that has nothing to do with views.
    const modal = page.locator('dialog.modal[aria-label="Auto Albums"]');
    await modal.locator("button", { hasText: "Cancel" }).click();
    await expect(modal).toBeHidden();

    // ...and onward.
    await views.cycle(page);
    await expect(peopleView.root(page)).toBeVisible();

    // Wrapping. This used to assert "one more press returns you to the grid",
    // which encoded a TWO-view world and broke when People landed; it was then
    // rewritten to encode a THREE-view world and broke again when the Face Map
    // landed (#232). So stop counting: press V until the grid comes back, and
    // assert only what is actually true of the registry — that the cycle
    // terminates, and that it passes through every view on the way.
    const seen = new Set(["albums", "people"]);
    let returned = false;
    for (let i = 0; i < 10; i++) {
      await views.cycle(page);
      // Settle BEFORE looking. Entering a working-set view runs a fetch, and
      // checking immediately reports the view you just left — which made this
      // miss the Face Map entirely and then "succeed" on the next press.
      await page.waitForTimeout(400);
      if (await page.locator('[data-testid="face-map"]').count()) {
        seen.add("face-map");
      }
      if (await views.grid(page).count()) {
        returned = true;
        break;
      }
    }
    expect(returned, "V should cycle back to the grid").toBe(true);
    expect(seen.has("face-map"), "V should reach the Face Map").toBe(true);
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
    await expect(statusBar.notice(page)).toContainText("Auto Albums");
    await expect(statusBar.notice(page)).toContainText(
      /Rating isn't available/
    );

    // And crucially: nothing was rated behind your back.
    await views.toGrid(page);
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

    await expect(statusBar.notice(page)).toContainText(
      /Selecting photos isn't available/
    );

    await views.toGrid(page);
    expect(await statusBar.selectedCount(page)).toBe(0);
    expect(errors).toEqual([]);
  });

  test("select-all is refused too, not just the plain keys", async ({
    page,
  }) => {
    // The capability guard originally covered `1-5`, `0` and `x` — and left
    // Cmd/Ctrl+A, which is handled ABOVE the blanket meta/ctrl bail and so
    // needs its own check. It ran `selectAllInView()` against the hidden feed
    // window and posted "Selected N photos", from a view that declares
    // `select: false`. Exactly the bug the guard was written for, one branch
    // higher up the handler.
    const errors = trackPageErrors(page);
    await openApp(page);
    await albums.open(page);

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+a" : "Control+a"
    );

    await expect(statusBar.notice(page)).toContainText(
      /Selecting photos isn't available/
    );

    await views.toGrid(page);
    expect(await statusBar.selectedCount(page)).toBe(0);
    // 404s for image resources are filtered, as groupJump.spec.js already
    // does. This test enters Auto Albums, which pulls a working set over the
    // SHARED fixture — and other specs move files in it (materialize), so a
    // thumbnail can 404 for a photo that was fine when this spec started.
    // Chromium logs any non-2xx as its own console.error. It passes 8/8 in
    // isolation and only fails when it lands after a file-moving spec; the
    // errors this test could actually cause are still asserted.
    expect(
      errors.filter((e) => !/Failed to load resource.*404/.test(e))
    ).toEqual([]);
  });

  test("hammering V does not strand you in the view you just left", async ({
    page,
  }) => {
    // Entering a working-set view runs a bounded fetch. Without an entry guard
    // AND an ownership re-check after the await, two presses race: press (load
    // A starts), press (load B starts — viewId is still "grid"), A lands ->
    // albums, press -> grid, B lands -> albums. You asked for the grid and are
    // sitting in the album review, with nothing reporting an error.
    //
    // THE DELAY IS THE TEST. On a 19-photo fixture the timeline fetch returns
    // faster than the next keystroke arrives, so there is no race window at
    // all and this passes against the broken code — decoration. Holding the
    // response open makes the window real and deterministic. (Verified: with
    // the guard removed this goes red; with it, green.)
    let releaseFirst;
    const firstHeld = new Promise((r) => (releaseFirst = r));
    let seen = 0;
    await page.route("**/api/albums/timeline*", async (route) => {
      if (++seen === 1) await firstHeld;
      await route.continue();
    });

    const errors = trackPageErrors(page);
    await openApp(page);
    await expect(views.grid(page)).toBeVisible();

    await views.cycle(page); // starts load A, which is now stuck
    await views.cycle(page); // would start load B — must be refused
    await views.cycle(page); // ...and so would this

    // Still on the grid: nothing has resolved yet.
    await expect(views.grid(page)).toBeVisible();

    releaseFirst();
    await expect(page.locator(".albums-view")).toBeVisible({ timeout: 15000 });

    // Exactly ONE fetch was allowed to start. Without the entry guard, each
    // auto-repeat would have fired its own 20,000-photo pull.
    expect(seen).toBe(1);

    // Now leave, and prove it STAYS left — a late-resolving pull is precisely
    // what used to flip the view back underneath the user.
    const modal = page.locator('dialog.modal[aria-label="Auto Albums"]');
    await modal.locator("button", { hasText: "Cancel" }).click();
    await expect(modal).toBeHidden();

    await views.toGrid(page);
    await page.waitForLoadState("networkidle");
    await expect(views.grid(page)).toBeVisible();
    await expect(page.locator(".albums-view")).toHaveCount(0);
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

/**
 * The shortcuts overlay renders the ACTIVE view's declared keys (#232).
 *
 * A view declares the keys it handles in `registry.js`, and the overlay builds
 * a group from them rather than from a hand-copied list — so a new view's
 * shortcuts cannot ship undocumented. No view declares any yet, which is why
 * this asserts the *absence* of a phantom section as well as the absence of
 * errors: an empty titled group would read as "this view has no shortcuts",
 * which is a different claim from "this view adds none to the shared set".
 *
 * It becomes a real behavioural test the moment a view declares keys, without
 * being edited — the same self-extending shape as the conformance test above.
 */
test.describe("declared view keys @p2", () => {
  test("the overlay opens in every view without a phantom section", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);

    for (let i = 0; i < 3; i++) {
      const overlay = await views.shortcuts(page);
      // The shared groups are always there...
      await expect(
        overlay.getByRole("heading", { name: "Grid & Loupe" })
      ).toBeVisible();
      // ...and no group is titled with a view's own name unless that view
      // actually declared rows, so an empty section can never appear.
      // Section headings only — the modal's own title is a heading too, and
      // it is not a shortcut group.
      const sections = overlay.locator("section");
      const n = await sections.count();
      expect(n).toBeGreaterThan(0);
      for (let s = 0; s < n; s++) {
        await expect(sections.nth(s).locator(".row").first()).toBeVisible();
      }
      await page.keyboard.press("?");
      await views.cycle(page);
    }
    expect(errors).toEqual([]);
  });
});
