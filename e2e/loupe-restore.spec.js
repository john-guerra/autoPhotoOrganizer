import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, group, loupe } from "./helpers.js";

/**
 * Closing the loupe puts you back where you were.
 *
 * Opening a photo has to EXPAND the group it lives in — a snapshot group is
 * collapsed SERVER-side, so its photos aren't in the feed window at all and there
 * is nothing to open. But that expansion was permanent: click a photo in a strip,
 * press Esc, and instead of the strip you were looking at you got the group's full
 * grid, with the feed scrolled somewhere else entirely.
 *
 * e2e because the bug lives in the seam — the strip is a client widget, the
 * collapse is a server query, and the loupe is a third thing again.
 */

test.describe("@p1 the loupe returns you to the view you left", () => {
  test("a photo opened from a snapshot strip closes back into the strip", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    // Put the first group into snapshot mode.
    const header = group.header(page, 0);
    await group.toggle(header).click();
    const band = group.bands(page).first();
    await expect(band).toBeVisible();

    // Open a photo FROM the strip.
    await band.locator(".snap-thumb").first().click();
    await expect(loupe.root(page)).toBeVisible();

    // ...and come back.
    await page.keyboard.press("Escape");
    await expect(loupe.root(page)).toHaveCount(0);

    // The strip is still a strip. It used to come back as a full grid — the
    // expansion the loupe needed was never undone.
    await expect(group.bands(page).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("a photo opened from the ordinary grid leaves the grid alone", async ({
    page,
  }) => {
    // The restore must not fire when there is nothing to restore — a group you
    // opened from full view must not come back collapsed.
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    await expect(group.bands(page)).toHaveCount(0);

    // loupe.open, not a bare click: the FIRST click on an unfocused tile only
    // focuses it (see helpers), so a bare click here opens nothing.
    await loupe.open(page, 0);
    await expect(loupe.root(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(loupe.root(page)).toHaveCount(0);

    await expect(group.bands(page)).toHaveCount(0);
    await expect(page.locator(".thumb").first()).toBeVisible();

    expect(errors).toEqual([]);
  });
});
