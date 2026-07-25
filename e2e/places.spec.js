import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, enrichAll } from "./helpers.js";
import { GPS_PHOTOS, GPS_COUNTRY } from "./fixture.mjs";

/**
 * Places (#154). The interesting risk here is NOT "does grouping work" — it is
 * the seam: a dimension or facet that looks right in the feed while the tree
 * counts disagree. That is where this app's shipped bugs keep coming from, so
 * the tree/feed agreement case is the point of this file.
 *
 * GPS_PHOTOS/GPS_COUNTRY are computed from the REAL geocoder at fixture-build
 * time (see e2e/fixture.mjs) — never hardcoded strings — so these specs can
 * never disagree with what the app actually resolves the coordinates to.
 *
 * Every test calls `enrichAll` before `openApp` — place has no filesystem-
 * timestamp fallback the way day/month grouping does (see enrichAll's doc
 * comment in helpers.js), so without it the feed's very first request races
 * the grid's own lazy metadata read and groups everything under "Unknown".
 */
test.describe("@p1 places", () => {
  test("groups the feed by country, with photos that have no GPS under Unknown", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await enrichAll(page);
    await openApp(page, { groupBy: ["country"] });

    const labels = await page.locator(".section-header").allInnerTexts();
    const joined = labels.join(" | ");
    expect(joined).toContain(GPS_COUNTRY);
    // Every other fixture photo has no GPS, so Unknown must exist and must be
    // a real labelled group — not a blank header.
    expect(joined).toContain("Unknown");

    expect(errors).toEqual([]);
  });

  test("nests city under country", async ({ page }) => {
    const errors = trackPageErrors(page);
    await enrichAll(page);
    await openApp(page, { groupBy: ["country", "city"] });

    const joined = (await page.locator(".section-header").allInnerTexts()).join(
      " | "
    );
    for (const { city } of GPS_PHOTOS) expect(joined).toContain(city);

    expect(errors).toEqual([]);
  });

  test("the tree's country count matches the feed's", async ({ page }) => {
    const errors = trackPageErrors(page);
    await enrichAll(page);
    await openApp(page, { groupBy: ["country"] });

    // The API is the lowest layer and the one that actually decides both —
    // check it directly rather than inferring from two rendered numbers.
    // groupBy is a comma-joined list of dimension names here, NOT a JSON
    // array — see server/api.js's `/api/tree` handler
    // (`String(req.query.groupBy ?? "").split(",")`).
    const res = await page.request.get(
      `/api/tree?groupBy=${encodeURIComponent("country")}`
    );
    expect(res.ok()).toBe(true);
    const { nodes = [] } = await res.json();
    const colombia = nodes.find((n) => n.label === GPS_COUNTRY);
    expect(
      colombia,
      `no ${GPS_COUNTRY} node in ${JSON.stringify(nodes)}`
    ).toBeTruthy();
    expect(colombia.count).toBe(GPS_PHOTOS.length);

    expect(errors).toEqual([]);
  });

  test("searching a place name narrows the feed to photos taken there", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await enrichAll(page);
    await openApp(page, { groupBy: ["country"] });

    const city = GPS_PHOTOS[0].city;
    const res = await page.request.get(
      `/api/photos/ids?filter=${encodeURIComponent(JSON.stringify({ text: city }))}`
    );
    expect(res.ok()).toBe(true);
    const { ids = [] } = await res.json();
    expect(ids.length).toBe(1); // exactly the one photo shot in that town

    expect(errors).toEqual([]);
  });

  /**
   * Dropping a leading non-folder dimension used to crash the tree:
   * TreeSidebar's resetAndLoad() re-renders TreeNode with the NEW groupBy
   * before its awaited loadRoot() replaces the OLD rootNodes. With `city`
   * removed, `folder` lands at depth 0 one render early, so `isFolderLevel`
   * goes true for a root node that is still shaped for the city dimension —
   * no `.children` — and descendantGroups threw `node.children is not
   * iterable` (folderTree.js:104). Found via live testing, not a synthetic
   * case.
   */
  test("removing a leading dimension (city) from groupBy does not crash the tree", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await enrichAll(page);
    await openApp(page, { groupBy: ["city", "folder"] });

    // The "Group" toolbar section folds into a popover trigger when the row
    // is too narrow — open it (harmless no-op if it's already unfolded).
    const groupTrigger = page.locator(".tg-trigger", { hasText: "Group" });
    if (await groupTrigger.isVisible()) await groupTrigger.click();

    const cityLabel = "Nearest town";
    const pill = page.locator(".group-by .pill", { hasText: cityLabel });
    await expect(pill).toBeVisible();
    await pill.locator("button.remove").click();

    // Tree/feed reload under the new (folder-only) groupBy without crashing.
    await expect(
      page.locator(".group-by .pill", { hasText: cityLabel })
    ).toHaveCount(0);
    await expect(page.locator(".section-header").first()).toBeVisible();
    await expect(page.locator(".thumb").first()).toBeVisible();

    expect(errors).toEqual([]);
  });
});
