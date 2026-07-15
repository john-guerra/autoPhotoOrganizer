import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp } from "./helpers.js";

/**
 * The Fisheye navigator must fill the whole sidebar. The widget keeps 6px of
 * right-edge clearance (its `gutter`) by default, which read as wasted space in
 * this narrow pane — we pass `gutter: 0` so the bars reach the divider (#128).
 * Measured in the real browser because it's the widget's own SVG geometry, not
 * anything a unit test can see.
 */
test("@p1 the fisheye bars fill the full sidebar width (no right gutter)", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await openApp(page);

  await page.getByRole("button", { name: "Fisheye" }).click();
  const body = page.locator(".fisheye-body");
  await expect(body).toBeVisible();
  await expect(body.locator("svg rect").first()).toBeVisible();

  // The widest bar's right edge must reach the container's right edge. With the
  // default gutter it stops 6px short; with gutter:0 it fills.
  const gap = await page.evaluate(() => {
    const b = document.querySelector(".fisheye-body");
    const bodyRight = b.getBoundingClientRect().right;
    const rights = [...b.querySelectorAll("svg rect")].map(
      (r) => r.getBoundingClientRect().right
    );
    return Math.round(bodyRight - Math.max(...rights));
  });
  expect(gap).toBeLessThanOrEqual(1);

  expect(errors).toEqual([]);
});
