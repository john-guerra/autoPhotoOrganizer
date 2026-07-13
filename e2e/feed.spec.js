import { test, expect } from "@playwright/test";
import { loupe as loupeHelper } from "./helpers.js";

/**
 * These cover the interactions that actually regressed during the 2.9.x usability
 * batch. Each one maps to a real bug that shipped:
 *
 *  - "cycles a group ... without throwing"  -> 2.9.24 (collapse threw TypeError:
 *    _collapsedKeys.has is not a function — a Set/Array mixup no unit test saw)
 *  - "hovering a header does not resize it" -> 2.9.19 (a mangled CSS selector list
 *    gave the action buttons padding:4rem; the header grew 31px -> 155px)
 *  - "the toggle icon stays icon-sized"     -> 2.9.18 (renderer id "grid" collided
 *    with the .grid photo-container rule and flex-grew the button to 1193px)
 *  - "a folded group keeps its own header"  -> 2.9.18 (the group's header used to
 *    be deleted and replaced by a row with a duplicate label)
 *  - "clicking a tile's circle selects"     -> 2.9.3 (must NOT open the loupe)
 *
 * The assertions are deliberately about OBSERVABLE behaviour, not internals.
 */

/** Fail a test if the page logged an uncaught error — the class of bug that kept
 *  reaching users while 619 green unit tests said nothing. */
function trackPageErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message ?? e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

async function gotoFeed(page) {
  // A clean slate: no carried-over selection/collapse/sort from a previous spec.
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await expect(page.locator(".section-header").first()).toBeVisible();
  // Let the first thumbnails settle so layout numbers are stable.
  await page.waitForTimeout(500);
}

test("loads the library and renders group headers", async ({ page }) => {
  const errors = trackPageErrors(page);
  await gotoFeed(page);

  await expect(page.locator(".section-header")).not.toHaveCount(0);
  await expect(page.locator(".thumb").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("cycles a group grid -> snapshot -> collapsed -> grid without throwing", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await gotoFeed(page);

  const header = page.locator(".section-header").last();
  const icon = header.locator(".section-toggle-icon");

  // The feed is VIRTUALIZED: a group below the fold has no band in the DOM, so
  // the band assertions below would read 0 whatever the click did. This spec used
  // to pass only because the fixture happened to fit on one screen — it doesn't
  // any more, and "it fits" was never what this test is about.
  await header.scrollIntoViewIfNeeded();

  // grid: no band, icon not amber
  await expect(page.locator(".group-band")).toHaveCount(0);
  await expect(icon).not.toHaveClass(/not-grid/);

  // -> snapshot: exactly one band appears, icon goes amber
  await icon.click();
  await expect(page.locator(".group-band")).toHaveCount(1);
  await expect(icon).toHaveClass(/not-grid/);

  // -> collapsed: band goes away, but the HEADER REMAINS (invariant 1 of the
  // group-renderers contract: a group always has exactly one label)
  await icon.click();
  await expect(page.locator(".group-band")).toHaveCount(0);
  await expect(header).toBeVisible();
  await expect(icon).toHaveClass(/not-grid/);

  // -> back to grid
  await icon.click();
  await expect(icon).not.toHaveClass(/not-grid/);

  expect(errors).toEqual([]);
});

test("hovering a header reveals its actions without resizing it", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await gotoFeed(page);

  const header = page.locator(".section-header").last();
  const before = await header.boundingBox();

  await header.hover();
  await expect(
    header.getByRole("button", { name: /keep only/i })
  ).toBeVisible();

  const after = await header.boundingBox();
  // 2.9.19: this grew 31 -> 155px and shoved the photos down.
  expect(Math.round(after.height)).toBe(Math.round(before.height));

  expect(errors).toEqual([]);
});

test("the group toggle stays icon-sized (no CSS class collision)", async ({
  page,
}) => {
  await gotoFeed(page);
  const icon = page.locator(".section-toggle-icon").first();
  const box = await icon.boundingBox();
  // 2.9.18: the "grid" renderer id collided with the .grid container rule and
  // flex-grew this button to ~1193px, shoving the label off to the right.
  expect(box.width).toBeLessThan(60);
});

test("a single click on the FIRST tile focuses it — it does not open the loupe (#104)", async ({
  page,
}) => {
  // `selected` starts at 0 so the keyboard has an anchor, and clicking an
  // ALREADY-focused tile opens the loupe — which used to mean one click on photo
  // #1 jumped straight into the loupe, while every other tile needed two. Worse:
  // rating auto-advances in the loupe, so a user who landed there by accident
  // rated a different photo with every keystroke.
  const errors = trackPageErrors(page);
  await gotoFeed(page);

  const tile = page.locator(".thumb").first();
  await tile.click();
  await expect(page.locator(".loupe")).toHaveCount(0); // focused, not opened

  await tile.click(); // now it IS explicitly focused, so this opens it
  await expect(page.locator(".loupe")).toBeVisible();

  expect(errors).toEqual([]);
});

test("clicking a tile's circle selects it and does NOT open the loupe", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await gotoFeed(page);

  const tile = page.locator(".thumb").first();
  await tile.hover();
  await tile.locator(".select-circle").click();

  await expect(page.locator(".statusbar")).toContainText(/1 selected/);
  // The loupe must not have opened — that was the whole point of the circle.
  await expect(page.locator(".loupe")).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("the loupe opens on a tile click and closes with its ✕", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await gotoFeed(page);

  // Via the helper: a click opens the loupe on an ALREADY-focused tile, and the
  // first tile is focused by default — so a blind double-click would open the
  // loupe and then click straight into it.
  await loupeHelper.open(page, 0);

  const loupe = page.locator(".loupe");
  await loupe.locator(".loupe-close").click();
  await expect(loupe).toHaveCount(0);

  expect(errors).toEqual([]);
});
