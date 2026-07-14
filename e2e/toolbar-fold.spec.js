import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, toolbar } from "./helpers.js";

/**
 * When the toolbar runs out of width, groups fold into dropdowns — they do not
 * slide off the right edge.
 *
 * The rows are `flex-wrap: nowrap` on purpose (a wrapping toolbar reflowed the
 * whole bar every time you added a grouping dimension), and the shrink order only
 * buys so much: once the search box and the timeline are at their floor, the next
 * pixel taken away pushed Sort — and then the zoom slider — past the window's
 * right edge, where they could be neither seen nor clicked. A control you cannot
 * reach is a control you do not have.
 *
 * e2e, and only e2e: the decision is made from real measurements of a real flex
 * layout (see toolbarOverflow.js — the elastic groups have no single "natural
 * width" to add up), so nothing short of a browser can tell whether it fired.
 */

/** Narrower than any laptop, which is the point: this is the width at which the
 *  old toolbar had nowhere left to put things. */
const TINY = { width: 760, height: 800 };
const ROOMY = { width: 1600, height: 900 };

/** Every control in the toolbar, with its right edge — the measurement the bug
 *  was actually about. */
async function overflowing(page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const out = [];
    for (const el of document.querySelectorAll(
      ".topbar button, .topbar select, .topbar input"
    )) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // not on screen at all
      if (r.right > vw + 1 || r.left < -1) {
        out.push(
          `${el.className || el.tagName} @ ${Math.round(r.left)}..${Math.round(r.right)}`
        );
      }
    }
    return out;
  });
}

test.describe("@p1 the toolbar folds instead of overflowing", () => {
  test("at a narrow window no control hangs off the edge — the groups fold away", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.setViewportSize(TINY);
    await openApp(page, { groupBy: ["folder", "year"] });

    // THE assertion. Restore the old CSS and the Sort select, the zoom slider and
    // half of View sit out past the right edge of the window.
    await expect.poll(() => overflowing(page)).toEqual([]);

    // And they folded rather than vanishing: Group is now a button.
    await expect(toolbar.foldTrigger(page, "Group")).toBeVisible();
    expect(await toolbar.groupReachable(page, "Group")).toBe(false);
    expect(errors).toEqual([]);
  });

  test("a folded group's controls still work — the dropdown opens them, with their state intact", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.setViewportSize(TINY);
    await openApp(page, { groupBy: ["folder", "year"] });

    const trigger = toolbar.foldTrigger(page, "Group");
    await expect(trigger).toBeVisible();

    await trigger.click();

    // The group is back on screen, in a panel — and it still knows it is grouping
    // by folder and year. (The controls are never unmounted or re-parented, which
    // is the whole reason this holds; a fold that rebuilt them would drop the
    // selection.)
    expect(await toolbar.groupReachable(page, "Group")).toBe(true);
    const panel = toolbar.group(page, "Group");
    await expect(panel).toContainText("folder");
    await expect(panel).toContainText("year");

    // The panel is on screen, not half past the edge — that is what Floating UI's
    // shift() is there for.
    const box = await panel.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(TINY.width);

    // Escape closes it.
    await page.keyboard.press("Escape");
    expect(await toolbar.groupReachable(page, "Group")).toBe(false);

    expect(errors).toEqual([]);
  });

  test("widening the window gives the groups back", async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.setViewportSize(TINY);
    await openApp(page, { groupBy: ["folder", "year"] });
    await expect(toolbar.foldTrigger(page, "Group")).toBeVisible();

    await page.setViewportSize(ROOMY);

    // No trigger left, and the group is back in the row where it belongs —
    // unfolding is not something the user should have to ask for.
    await expect(toolbar.foldTrigger(page, "Group")).toHaveCount(0);
    await expect.poll(() => toolbar.groupReachable(page, "Group")).toBe(true);
    await expect.poll(() => overflowing(page)).toEqual([]);

    expect(errors).toEqual([]);
  });

  test("a folded Filter group still says that it is hiding photos", async ({
    page,
  }) => {
    // The one state where the control responsible for a shrunken library is not
    // on screen at all. If the fold hid that too, "why can I only see 12 photos?"
    // would have no answer anywhere in the window.
    const errors = trackPageErrors(page);
    await page.setViewportSize(ROOMY);
    await openApp(page, { groupBy: ["folder"] });

    // Turn a filter on while the group is still in the toolbar, then take the
    // width away from under it.
    await page.getByRole("button", { name: "filter: 3 stars or more" }).click();
    await expect(toolbar.group(page, "Filter")).toHaveClass(/active/);
    await page.setViewportSize(TINY);

    const filter = toolbar.foldTrigger(page, "Filter");
    if (await filter.isVisible()) {
      await expect(filter).toHaveClass(/active/);
    } else {
      // Filter still fits at this width — then it must be lit in the row itself.
      await expect(toolbar.group(page, "Filter")).toHaveClass(/active/);
    }

    expect(errors).toEqual([]);
  });
});
