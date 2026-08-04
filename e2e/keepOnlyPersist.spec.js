import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, statusBar, clearScope } from "./helpers.js";
import { TOTAL_PHOTOS } from "./fixture.mjs";

/**
 * P1 — "Keep only" must survive a reload (#212).
 *
 * It did not, and the interesting part is that it half-did: the server's
 * keep_scope rows outlived the page, so the WORKING SET was still in force
 * while the UI came back showing the whole library. One side remembered and
 * the other did not — a state worse than either answer on its own, because the
 * next destructive action would run against a set the user could no longer see.
 *
 * No unit test could catch it. `loadScope()` was correct in isolation (it
 * restores folder scopes, and did), `setKeepScope` was correct in isolation
 * (it stored the ids, and did). The bug lived in the BOOT SEQUENCE — the seam
 * between them, where nobody asked the server what it was still holding. That
 * is tier 2's job (docs/TESTING.md).
 *
 * `openApp` clears localStorage on every navigation, which makes this a
 * sharper test than intended: the scope has to come back with no browser-side
 * help at all, which is exactly the claim — the server is the single source of
 * truth.
 */

test.describe("@p1 keep-only persistence", () => {
  test.beforeEach(async ({ page }) => await clearScope(page));
  test.afterAll(async ({ browser }) => {
    // A leaked scope would silently narrow every later spec's library.
    const page = await browser.newPage();
    await clearScope(page);
    await page.close();
  });

  test("a kept selection is still in force after a reload (#212)", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);

    // Keep the first group. ⌘A's first press takes the group you are in, which
    // is a real subset of the library — the point is that the library does not
    // come back, so the scope must be smaller than everything.
    await page.keyboard.press("Meta+a");
    // `[1-9]\d*`, not `\d+`: select-all fetches its ids from the server, and
    // the status bar reads "0 selected" until they land — which `\d+` happily
    // matches, so the wait returned immediately and the assertion below failed
    // with 0 under load. Same bug, same fix, in `faces-scope.spec.js`.
    await expect(statusBar.root(page)).toContainText(/[1-9]\d* selected/);
    const kept = Number(
      (await statusBar.root(page).textContent()).match(/(\d+) selected/)[1]
    );
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(TOTAL_PHOTOS);

    await statusBar.keepOnly(page).click();
    await expect(statusBar.scopeChip(page)).toBeVisible();
    await expect(statusBar.scopeChip(page)).toContainText(
      new RegExp(`${kept} photo`)
    );

    // THE RELOAD. Assert on the chip AND on the tile count: the chip alone
    // would pass on a scope that is remembered but not applied, and the tiles
    // alone would pass on one applied but not shown. The bug was precisely a
    // disagreement between those two, so testing one is testing neither.
    //
    // `preserveScope` opts out of openApp's harness-level scope reset — without
    // it the helper would clear the very thing this test exists to observe, and
    // the assertion below would be checking nothing. It changes no product
    // behaviour: localStorage is still wiped, so the scope still has to come
    // back from the server with no browser-side help.
    await openApp(page, { preserveScope: true });

    await expect(statusBar.scopeChip(page)).toBeVisible();
    await expect(statusBar.scopeChip(page)).toContainText(
      new RegExp(`${kept} photo`)
    );
    await expect(page.locator(".thumb")).toHaveCount(kept);

    expect(errors).toEqual([]);
  });

  test("exiting the scope stays exited across a reload (#212)", async ({
    page,
  }) => {
    // The other half of the acceptance criteria: restoring must not make the
    // scope sticky. Leaving it has to clear BOTH sides, or the next boot
    // re-narrows a library the user deliberately went back to.
    const errors = trackPageErrors(page);
    await openApp(page);

    await page.keyboard.press("Meta+a");
    await statusBar.keepOnly(page).click();
    await expect(statusBar.scopeChip(page)).toBeVisible();

    await statusBar.scopeChip(page).click(); // the chip IS the exit
    await expect(statusBar.scopeChip(page)).toHaveCount(0);

    // `preserveScope` here too, and for the same reason: if the helper cleared
    // the scope the assertion would pass whether or not exiting actually wrote
    // through to the server. The point is that the EXIT persisted, so the
    // harness must not do the persisting.
    await openApp(page, { preserveScope: true });
    await expect(statusBar.scopeChip(page)).toHaveCount(0);
    await expect(page.locator(".thumb").first()).toBeVisible();

    expect(errors).toEqual([]);
  });
});
