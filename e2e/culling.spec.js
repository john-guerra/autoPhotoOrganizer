import { test, expect } from "@playwright/test";
import {
  trackPageErrors,
  openApp,
  reload,
  resetRatings,
  grid,
  loupe,
} from "./helpers.js";

/**
 * P0 — CULLING. This is what the app is FOR: sit on a photo, hit a number, move
 * on. If a rating doesn't stick, the user's whole afternoon of triage is gone and
 * nothing else in the app matters.
 *
 * These are the app's data-integrity tests: every one of them reloads the page and
 * re-asserts, so they prove the rating reached SQLite — not just the Svelte store.
 */

test.describe("@p0 culling", () => {
  // Ratings are persisted to SQLite, so they leak from one spec to the next.
  // Start every test from "nothing is rated".
  test.beforeEach(async ({ page }) => {
    await resetRatings(page);
  });

  test("rating the focused photo with 1-5 persists across a reload", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);

    await grid.focus(page, 0);
    await page.keyboard.press("3");

    // Shown immediately…
    await expect(grid.ratingBadge(page, 0)).toContainText("3");

    // …and it actually reached the database.
    await reload(page);
    await expect(grid.ratingBadge(page, 0)).toContainText("3");

    expect(errors).toEqual([]);
  });

  test("0 clears a rating, and that clearing persists too", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);

    await grid.focus(page, 0);
    await page.keyboard.press("4");
    await expect(grid.ratingBadge(page, 0)).toContainText("4");

    await page.keyboard.press("0");
    await expect(grid.ratingBadge(page, 0)).toHaveCount(0);

    // A clear that only lived in memory would silently come back as 4.
    await reload(page);
    await expect(grid.ratingBadge(page, 0)).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test("rating in the loupe applies to the photo on screen and persists", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);

    await loupe.open(page, 0);
    await loupe.star(page, 5).click(); // click the 5th star

    await loupe.close(page).click();
    await expect(loupe.root(page)).toHaveCount(0);

    await expect(grid.ratingBadge(page, 0)).toContainText("5");
    await reload(page);
    await expect(grid.ratingBadge(page, 0)).toContainText("5");

    expect(errors).toEqual([]);
  });

  test("ratings are per-photo — rating one does not touch its neighbour", async ({
    page,
  }) => {
    // The nastiest possible triage bug: a rating landing on the wrong photo.
    const errors = trackPageErrors(page);
    await openApp(page);

    await grid.focus(page, 1);
    await page.keyboard.press("2");
    await expect(grid.ratingBadge(page, 1)).toContainText("2");

    await reload(page);
    await expect(grid.ratingBadge(page, 1)).toContainText("2");
    await expect(grid.ratingBadge(page, 0)).toHaveCount(0);
    await expect(grid.ratingBadge(page, 2)).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test("clicking the first photo then rating rates THAT photo (#104)", async ({
    page,
  }) => {
    // The user-visible consequence of #104, and the reason it's a P0 and not a
    // papercut: a plain click on photo #1 used to open the loupe, where rating
    // auto-advances — so this "1" landed on photo #2 while photo #1 stayed on
    // screen. You'd rate a whole run of photos one slot off and never see it.
    const errors = trackPageErrors(page);
    await openApp(page);

    await page.locator(".thumb").first().click(); // a plain click, no helper
    await page.keyboard.press("1");

    await expect(grid.ratingBadge(page, 0)).toContainText("1");
    await expect(grid.ratingBadge(page, 1)).toHaveCount(0);

    await reload(page);
    await expect(grid.ratingBadge(page, 0)).toContainText("1");
    await expect(grid.ratingBadge(page, 1)).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test("typing a digit into a text field does NOT rate a photo", async ({
    page,
  }) => {
    // The guard that stops the grouping box (or any input) from eating your
    // keystrokes and silently re-rating the focused photo.
    const errors = trackPageErrors(page);
    await openApp(page);

    await grid.focus(page, 0);
    const input = page.locator(".group-by input").first();
    await input.click();
    await input.type("2024");

    await expect(grid.ratingBadge(page, 0)).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
