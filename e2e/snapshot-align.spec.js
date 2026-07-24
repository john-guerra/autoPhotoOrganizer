import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, group } from "./helpers.js";

/**
 * A group must not JUMP when you toggle it between full view and a snapshot
 * strip. Its first photo stays where it was, and stays the size it was.
 *
 * Two separate causes, both invisible to a unit test and both only measurable
 * against real geometry:
 *
 *  - Absolutely-positioned children ignore the grid's CSS padding, so every box
 *    adds the frame inset itself (`box.x + pad`, as Thumb does). The band didn't,
 *    which put every strip 12px left of, and 12px above, the photos it replaced.
 *  - The band was a hard-coded 148px tall ("label row + strip") — a number left
 *    over from when renderers drew their own label. The grid's rows follow the
 *    zoom, so the strip's photos were a different size from the group's photos at
 *    every zoom level.
 */

test.describe("@p1 snapshot / full view alignment", () => {
  test("toggling a group to a snapshot leaves its first photo where it was, at the size it was", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    // The first group in the feed owns the first tile — measure it in FULL view.
    const before = await page
      .locator(".thumb-wrap")
      .first()
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: el.style.left, height: Math.round(r.height) };
      });

    // Toggle the LEAF group that OWNS the first tile. Grouping by folder nests,
    // so the first HEADER is a photo-less virtual ancestor (the library-root
    // breadcrumb, over "Trip"/"Party"/"Cards"…); plain-toggling THAT — or any
    // parent — now aggregates its whole subtree into one band at the PARENT's
    // indent (#142), a different behaviour covered by subtree-fold.spec.js. This
    // test is about a single group's strip staying aligned with its own photos,
    // so target "Trip": the first top-level LEAF folder, which owns the first
    // tile (its photos sort first) and has no subfolders to aggregate.
    const header = group.folderHeaderExact(page, "Trip").first();
    await group.toggle(header).click();
    const band = group.bands(page).first();
    await expect(band).toBeVisible();

    // offset*, not getBoundingClientRect: the strip UNFURLS (a scale transform —
    // see snapshot-animation.spec.js), and a client rect includes that transform,
    // so mid-animation this measured a band that was 92% of its real size and the
    // assertions below failed at random. The offset metrics are the LAID-OUT
    // geometry, which is what "is the strip where the photos were" actually means.
    const measure = () =>
      band.evaluate((el) => {
        const t = el.querySelector(".snap-thumb");
        return {
          left: el.style.left,
          bandHeight: el.offsetHeight,
          firstPhotoInset: t.offsetLeft, // .group-band is the offset parent
          firstPhotoHeight: t.offsetHeight,
        };
      });

    const after = await measure();

    // SAME X. The band sits exactly where the group's photos sat — this is the
    // one the user sees, because the group is directly under a header that
    // doesn't move.
    expect(after.left).toBe(before.left);
    expect(after.firstPhotoInset).toBe(0);

    // SAME SIZE. The strip's photo fills the band, and the band is one grid row.
    // Asserting against the first tile's own height would be wrong: the justified
    // layout scales each ROW to fill the width, so any individual tile can be
    // shorter than the target. What must hold is that the strip is driven by the
    // same zoom the grid is — so zooming in has to grow it. A hard-coded 148px
    // (which is what this replaced) passes every static check and fails this one.
    expect(after.firstPhotoHeight).toBe(after.bandHeight);

    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("+");
    await expect
      .poll(async () => (await measure()).bandHeight)
      .toBeGreaterThan(after.bandHeight);

    expect((await measure()).firstPhotoHeight).toBe(
      (await measure()).bandHeight
    );

    expect(errors).toEqual([]);
  });

  test("the timeline's settings popover actually opens", async ({ page }) => {
    // The timeline moved into the Filter group, whose `.time-filter` box clipped
    // its overflow — so the gear opened a panel into nothing. A control that does
    // nothing when you press it is the same bug as a control that isn't there.
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    await page.locator(".time-filter .za-gear").click();

    const panel = page.locator(".za-scent-panel");
    await expect(panel).toBeVisible();

    // toBeVisible is NOT enough, and this is the whole point of the test: an
    // ancestor's `overflow: hidden` doesn't change the panel's layout, so it keeps
    // its box and Playwright happily calls it visible while the browser paints
    // none of it. Ask what is actually AT the panel's centre instead — if the
    // clip is back, the hit-test lands on whatever is behind it.
    const painted = await panel.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(
        Math.round(r.left + r.width / 2),
        Math.round(r.top + r.height / 2)
      );
      return el.contains(hit);
    });
    expect(painted).toBe(true);

    // And on screen: a panel pushed off the right edge is no more usable.
    const box = await panel.boundingBox();
    const vw = page.viewportSize().width;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vw);

    expect(errors).toEqual([]);
  });
});
