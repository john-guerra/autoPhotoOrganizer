import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, enrichAll, loupe } from "./helpers.js";
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

  /** #173. Region sits between country and city — GeoNames admin1, "state" in
   *  the US, "departamento" in Colombia. GPS_PHOTOS' two towns are in
   *  different Colombian departments (Bogotá's own Distrito Capital vs.
   *  Medellín's Antioquia), so both group labels must appear, not just one. */
  test("nests region between country and city", async ({ page }) => {
    const errors = trackPageErrors(page);
    await enrichAll(page);
    await openApp(page, { groupBy: ["country", "region", "city"] });

    const joined = (await page.locator(".section-header").allInnerTexts()).join(
      " | "
    );
    for (const { region, city } of GPS_PHOTOS) {
      expect(joined).toContain(region);
      expect(joined).toContain(city);
    }

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

    const cityLabel = "City";
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

  /**
   * #175 follow-up: the loupe never showed a photo's location at all — not
   * missing data, a missing wire. server/lib/place.js resolved country/city
   * back in #154 and /api/enrich stored lat/lon, but /api/meta (what the
   * loupe actually fetches) never returned any of it.
   */
  test("the loupe shows a GPS photo's place hierarchy and a minimap", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await enrichAll(page);
    await openApp(page);

    // Narrow to exactly the one GPS photo in that city (see the search test
    // above) so tile 0 is guaranteed to be it, not whichever photo the
    // default sort happens to put first.
    await page.locator(".search-input").fill(GPS_PHOTOS[0].city);
    await expect(page.locator(".thumb")).toHaveCount(1);

    await loupe.open(page);
    await expect(loupe.locationText(page)).toHaveText(
      `${GPS_PHOTOS[0].country} › ${GPS_PHOTOS[0].region} › ${GPS_PHOTOS[0].city}`
    );
    await expect(loupe.miniMapSvg(page)).toBeVisible();
    // Not just present — actually drew something, not an empty frame.
    await expect(loupe.miniMapSvg(page).locator(".land, .pin")).not.toHaveCount(
      0
    );
    // smart-labels drew at least one text label (a country name, or the
    // photo's own bolded one) — not just an unlabelled shape map.
    await expect(
      loupe.miniMapSvg(page).locator("g.labels text")
    ).not.toHaveCount(0);

    expect(errors).toEqual([]);
  });

  /**
   * #179: the minimap drew an orange leader line from the pin to a label that
   * was never visible. Two causes, both in MiniMap.svelte's smart-labels use:
   * `labelsInCentroids` (default true) offset every label into its Voronoi cell
   * and drew an anchor back to the point; and a 4-viewport data margin fed the
   * labeller points far outside the 220px canvas it was told about, so their
   * labels landed off-screen. The old test above only checked a <text> EXISTED
   * — it did, just anchored off into space — so the bug sailed through. This
   * asserts the two things the user actually needs: no leader lines, and the
   * city label rendered INSIDE the map.
   */
  test("labels the photo's place on the map, with no leader line to nowhere (#179)", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await enrichAll(page);
    await openApp(page);

    await page.locator(".search-input").fill(GPS_PHOTOS[0].city);
    await expect(page.locator(".thumb")).toHaveCount(1);
    await loupe.open(page);
    await expect(loupe.miniMapSvg(page)).toBeVisible();

    // No anchor/leader lines at all.
    await expect(loupe.miniMapAnchors(page)).toHaveCount(0);

    // The photo's own city label is rendered, and its box sits INSIDE the svg —
    // asserted on getBoundingClientRect, not the x/y attrs, since smart-labels
    // positions via a group transform the raw attrs don't reflect.
    const cityLabel = loupe.miniMapLabel(page, GPS_PHOTOS[0].city);
    await expect(cityLabel).toBeVisible();
    const insideMap = await cityLabel.first().evaluate((el) => {
      const svg = el.ownerSVGElement;
      const t = el.getBoundingClientRect();
      const s = svg.getBoundingClientRect();
      return (
        t.width > 0 &&
        t.height > 0 &&
        t.left >= s.left - 1 &&
        t.right <= s.right + 1 &&
        t.top >= s.top - 1 &&
        t.bottom <= s.bottom + 1
      );
    });
    expect(insideMap).toBe(true);

    expect(errors).toEqual([]);
  });

  test("the loupe shows no Location section for a photo with no GPS", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await enrichAll(page);
    await openApp(page);

    // Every fixture photo except the two GPS ones has no location — the
    // search test above already proves those two are a 1-photo match each,
    // so anything NOT matching a GPS city is safely GPS-less.
    await page.locator(".search-input").fill("Cards");
    await expect(page.locator(".thumb").first()).toBeVisible();

    await loupe.open(page);
    await expect(loupe.locationText(page)).toHaveCount(0);
    await expect(loupe.miniMapSvg(page)).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});
