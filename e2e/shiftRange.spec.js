import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, grid, statusBar } from "./helpers.js";

/**
 * SHIFT-CLICK RANGE SELECTION, VIA THE SELECT CIRCLE (#253).
 *
 * Reported three times, and it kept "not reproducing" because every probe
 * clicked the TILE BODY — which routes to `onTileClick` and did range-select
 * correctly all along.
 *
 * The circle is a different path, and it is the one people actually use: a
 * plain click on a tile only FOCUSES it (or opens the loupe if it is already
 * focused), so the circle is the only control that genuinely *selects*.
 * `Thumb.svelte` called `e.stopPropagation()` and then `ontoggleselect()` with
 * no event at all, so the modifier was discarded before anything downstream
 * could read it — and the range silently became a single toggle.
 *
 * The lesson for the next spec: test the control the user reaches for, not the
 * one nearest the handler you are reading.
 */
test.describe("@p1 shift-click range selection", () => {
  test("shift-clicking the select CIRCLE takes the photos in between", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);

    // Select photo 1 with its circle — the way a user starts a selection.
    await grid.selectCircle(page, 1).click();
    await expect(statusBar.root(page)).toContainText(/1 selected/);

    // ...then shift-click photo 5's circle. Everything between must join.
    await grid.selectCircle(page, 5).click({ modifiers: ["Shift"] });
    await expect(statusBar.root(page)).toContainText(/5 selected/);

    expect(errors).toEqual([]);
  });

  test("a plain click on the circle still toggles just that photo", async ({
    page,
  }) => {
    // The range must not swallow the ordinary case: without a modifier the
    // circle is still a one-photo toggle, on and off.
    const errors = trackPageErrors(page);
    await openApp(page);

    await grid.selectCircle(page, 2).click();
    await expect(statusBar.root(page)).toContainText(/1 selected/);
    await grid.selectCircle(page, 4).click();
    await expect(statusBar.root(page)).toContainText(/2 selected/);
    await grid.selectCircle(page, 4).click();
    await expect(statusBar.root(page)).toContainText(/1 selected/);

    expect(errors).toEqual([]);
  });

  test("shift-clicking the TILE still ranges too — the path that always worked", async ({
    page,
  }) => {
    // Kept so a fix to the circle cannot quietly break the tile.
    const errors = trackPageErrors(page);
    await openApp(page);

    await grid.tile(page, 2).click();
    await grid.tile(page, 6).click({ modifiers: ["Shift"] });
    await expect(statusBar.root(page)).toContainText(/5 selected/);

    expect(errors).toEqual([]);
  });
});
