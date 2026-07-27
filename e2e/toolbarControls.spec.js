import { test, expect } from "@playwright/test";
import { openApp, trackPageErrors, grid } from "./helpers.js";

/**
 * The toolbar's icon controls, and the width budget they live inside.
 *
 * Both halves of this file exist because of the same afternoon. The near-dupe
 * work (#162) added two buttons beside the burst gap; text labels pushed the
 * whole Group group into an overflow popover and broke two unrelated specs,
 * and icons fixed the width at the cost of nobody being able to tell what the
 * buttons did. A `title` attribute is not the answer to that — it needs a
 * deliberate hover-and-wait, never fires for keyboard users, and reads as
 * unlabelled in practice however correct the markup is.
 *
 * So: an accessible name AND a tooltip that actually shows, asserted here
 * because neither is provable at the unit tier — one is an ARIA property and
 * the other only exists on :hover.
 */

test.describe("@p1 toolbar icon controls", () => {
  test("the burst-selection icon has an accessible name and a tooltip that shows on hover", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);

    // The control only exists with a selection — it stacks the selected
    // photos, so with nothing selected there is nothing for it to act on.
    await grid.tile(page, 0).click();
    await page.keyboard.down("Shift");
    await grid.tile(page, 1).click();
    await page.keyboard.up("Shift");

    const btn = page.getByTestId("burst-selection");
    await expect(btn).toBeVisible();

    // 1. Screen readers: the icon must never be the whole label.
    await expect(btn).toHaveAccessibleName(/stack the \d+ selected photos/i);

    // 2. Sighted users: the tooltip must actually appear, and say something
    //    a person can act on rather than repeating the glyph.
    const tip = page.locator(".tip", { has: btn });
    await expect(tip).toHaveAttribute("data-tip", /stack the \d+ selected/i);
    // Hidden until pointed at…
    const tipOpacity = () =>
      tip.evaluate((el) => Number(getComputedStyle(el, "::after").opacity));
    expect(await tipOpacity()).toBeLessThan(0.1);

    // …and visible once it is. Polled rather than read once: the reveal is a
    // 90ms transition, so a single synchronous read right after hover catches
    // it mid-fade and fails for a reason that has nothing to do with the
    // behaviour under test.
    await btn.hover();
    await expect.poll(tipOpacity, { timeout: 2000 }).toBeGreaterThan(0.9);

    expect(errors).toEqual([]);
  });

  test("the Group controls survive at the narrowest supported width", async ({
    page,
  }) => {
    // Recommendation 5 of docs/ML-UX-REVIEW-2026-07-26.md, made enforceable.
    //
    // ToolbarRow folds by width, and the Group group folds FIRST — so every
    // control added to row 2 spends part of a budget nobody was tracking. Two
    // text buttons were enough to hide the grouping pills, the Add… input and
    // the Tree/Fisheye switch, which is how #162 broke culling.spec and
    // fisheye.spec: both timed out clicking controls that were no longer
    // rendered, with nothing in either spec mentioning the toolbar.
    //
    // 1280 is the floor this asserts. Anything that folds Group above it is a
    // regression, and this test is the one place that says so out loud.
    const errors = trackPageErrors(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openApp(page);

    await expect(page.locator(".group-by input").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Fisheye" })).toBeVisible();

    expect(errors).toEqual([]);
  });
});
