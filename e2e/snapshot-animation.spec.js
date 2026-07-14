import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, group } from "./helpers.js";

/**
 * A group folding into a snapshot should look like the grid closing, not like the
 * photos blinking out and an unrelated widget blinking in.
 *
 * The strip now opens from exactly the spot, and at exactly the photo size, that
 * the group's first row of photos occupied. (The photos BELOW have always glided —
 * `.thumb-wrap` carries its own top/left transition. The strip was the piece that
 * simply appeared.)
 *
 * The second test is the one that would have caught the obvious way to get this
 * wrong. The feed is virtualized: a band scrolled out of view is destroyed and
 * re-created when you come back, so an unguarded entry animation replays the unfurl
 * every single time a snapshot group returns to the screen — which is not a
 * flourish, it is a flicker.
 */

/** The band's transform as the browser computes it. "none" (or the identity
 *  matrix) means it is sitting still; anything else means it is mid-unfurl. */
const transformOf = (band) =>
  band.evaluate((el) => getComputedStyle(el).transform);

const AT_REST = ["none", "matrix(1, 0, 0, 1, 0, 0)"];

test.describe("@p1 folding a group into a snapshot is animated", () => {
  test("the strip unfurls in place, then settles", async ({ page }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    // The unfurl lasts 260ms, which any `await` in this file can easily outrun —
    // so watch every FRAME rather than trying to catch it in the act. The sampler
    // records the band's transform from the moment it appears.
    await page.evaluate(() => {
      window.__frames = [];
      const tick = () => {
        const el = document.querySelector(".group-band");
        if (el) window.__frames.push(getComputedStyle(el).transform);
        if (window.__frames.length < 60) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await group.toggle(group.header(page, 0)).click();

    const band = group.bands(page).first();
    await expect(band).toBeVisible();

    // At least one frame caught it mid-unfurl: scaled, not simply present. With no
    // animation the band is at its final size from its very first frame and every
    // sample is the identity matrix.
    await expect
      .poll(
        async () => {
          const frames = await page.evaluate(() => window.__frames ?? []);
          return frames.some((t) => !AT_REST.includes(t));
        },
        { timeout: 3000 }
      )
      .toBe(true);

    // And it finishes: it must not be left permanently transformed.
    await expect
      .poll(() => transformOf(band), { timeout: 3000 })
      .toMatch(/none|matrix\(1, 0, 0, 1, 0, 0\)/);

    expect(errors).toEqual([]);
  });

  /**
   * NOT TESTED HERE, deliberately: that scrolling a snapshot group off screen and
   * back does not replay its unfurl.
   *
   * That is the whole reason `foldMs` is gated on a fold actually landing — the
   * grid renders only `visibleItems` (windowing.js, 800px of overscan), so on a
   * real library a band scrolled away is destroyed and re-created, and an
   * unguarded `in:` would re-unfurl it every time it came back.
   *
   * But this fixture's entire feed is ~1,100px tall, which is inside the overscan:
   * no band ever unmounts, so a test written here passes just as happily with the
   * guard removed. It was written, it was checked, and it proved nothing — so it
   * is gone rather than sitting in the suite looking like coverage. The guard is
   * verified against the real 114k library instead (scroll a snapshot group away,
   * come back, it is not transformed).
   */
});
