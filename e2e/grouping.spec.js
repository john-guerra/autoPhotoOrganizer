import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, group } from "./helpers.js";

/**
 * P0 — NESTED GROUPS. Every test in this file is a bug that SHIPPED to a user
 * during the 2.9.x usability round, with 619 unit tests green the whole time:
 *
 *  - collapsing a child group threw `Cannot read properties of undefined
 *    (reading 'replace')` — collapsed placeholders only carry the levels down to
 *    the collapse depth, and the header code walked every level;
 *  - collapsing threw `_collapsedKeys.has is not a function` — one call site
 *    still passed an Array after the Set refactor;
 *  - folding a parent left the child's own fold state visible underneath, so a
 *    snapshotted parent rendered TWO strips.
 *
 * None of them were reachable without a nested feed, which is exactly why they
 * survived. `trackPageErrors` alone catches the first two.
 */

// Two levels: folder > day. Both fixture folders carry EXIF dates.
const NESTED = ["folder", "day"];

test.describe("@p0 nested groups", () => {
  test("the feed nests: a child header is indented under its parent", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: NESTED });

    const headers = page.locator(".section-header");
    await expect(headers.first()).toBeVisible();
    expect(await headers.count()).toBeGreaterThan(1);

    // A depth-1 header's label sits to the RIGHT of its parent's — the
    // dendrogram indent. Note the header BOXES all share the same x: the indent
    // is padding-left (App.svelte's `--depth * --ind`), not an offset rect. So
    // measure the padding, which is the thing the eye actually reads as nesting.
    const padOf = (i) =>
      headers
        .nth(i)
        .evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
    expect(await padOf(1)).toBeGreaterThan(await padOf(0));

    expect(errors).toEqual([]);
  });

  test("folding a CHILD group does not throw", async ({ page }) => {
    // The `formatGroupValue` / `_collapsedKeys.has` crashes both landed here.
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: NESTED });

    const child = group.header(page, 1);
    const toggle = group.toggle(child);

    await toggle.click(); // grid -> snapshot
    await expect(child).toBeVisible();
    await toggle.click(); // snapshot -> collapsed
    await expect(child).toBeVisible();
    await toggle.click(); // collapsed -> grid
    await expect(child).toBeVisible();

    // The app must still be alive and rendering photos.
    await expect(page.locator(".thumb").first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("folding a PARENT does not throw, and hides its children", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: NESTED });

    const before = await page.locator(".section-header").count();
    await group.toggle(group.header(page, 0)).click(); // parent -> snapshot
    await group.toggle(group.header(page, 0)).click(); // -> collapsed

    // A collapsed parent represents its whole subtree with one header: its
    // child headers must go away, not linger under it.
    await expect
      .poll(() => page.locator(".section-header").count())
      .toBeLessThan(before);

    expect(errors).toEqual([]);
  });

  test("a snapshotted parent shows ONE strip, not one per child", async ({
    page,
  }) => {
    // Reported verbatim: "snapshot a leaf, then the parent, it shows two
    // snapshots — it should snapshot only the parent."
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: NESTED });

    // Addressed by PATH, not by nth(): folder subtrees now put one header per
    // ancestor folder above a group, so "header 0" is no longer its parent.
    const child = group.deepestHeader(page);
    const parent = await group.parentHeaderOf(page, child);

    // Snapshot a child first…
    await group.toggle(child).click();
    await expect(group.bands(page)).toHaveCount(1);

    // …then its parent. The parent subsumes the child; the child's strip must
    // not survive underneath it.
    await group.toggle(parent).click();
    await expect(group.bands(page)).toHaveCount(1);

    expect(errors).toEqual([]);
  });

  test("grouping by folder ALONE nests the folder subtree", async ({
    page,
  }) => {
    // The whole point of the folder hierarchy: one grouping dimension used to
    // mean one flat level (depth == index into groupBy), so every folder — even
    // a sub-folder of the one above it — rendered flush left with its entire
    // absolute path. The tree sidebar nested them; the feed did not.
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    const headers = page.locator(".section-header");
    await expect(headers.first()).toBeVisible();

    const pads = await headers.evaluateAll((els) =>
      els.map((el) => parseFloat(getComputedStyle(el).paddingLeft))
    );
    // With ONE dimension there must still be more than one indent level.
    expect(new Set(pads).size).toBeGreaterThan(1);

    // "Cards" is a virtual ancestor — it holds no photos of its own, only
    // Cam 1 and Cam 10 — so it exists in no feed item and must be invented.
    // Its count is the roll-up of the subtree beneath it.
    const cards = page
      .locator(".section-wrapper")
      .filter({ hasText: "Cards" })
      .first();
    await expect(cards.locator(".section-count")).toBeVisible();

    expect(errors).toEqual([]);
  });
});
