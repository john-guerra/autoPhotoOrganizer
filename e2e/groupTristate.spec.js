import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, grid, group } from "./helpers.js";

/**
 * The group tri-state select indicator must not storm the server with a
 * per-group id request when there is NOTHING selected.
 *
 * Each feed section header shows none/some/all of its photos selected. The
 * client only holds a flat id set, so it caches each group's full id list and
 * intersects. On the real 114k library, folder grouping renders ~1,000 headers
 * (and a single virtual-ancestor header expands to one request per descendant
 * folder), so rendering fired ~1,000 `/api/photos/ids` requests AT ONCE. That
 * blows past the browser's ~6-connections-per-host cap and STARVES the requests
 * that matter — the feed page and the tree reload — which then fail with
 * "Failed to fetch" and leave the grid looking empty (issue #4's real cause).
 *
 * The fix: when the selection is empty every group is trivially "none", so no
 * request is needed at all. This test pins that — and that a real selection
 * still drives the indicator, so the optimisation didn't just delete the
 * feature.
 */

/** Every `/api/photos/ids` request that scopes to a group (`path=`) — i.e. a
 *  tri-state indicator fetch, not the whole-library select-all query. */
function trackGroupIdRequests(page) {
  const urls = [];
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("/api/photos/ids") && u.includes("path=")) urls.push(u);
  });
  return urls;
}

test("@p0 no selection ⇒ the group tri-state fires zero per-group id requests", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  const idReqs = trackGroupIdRequests(page);

  // Folder grouping guarantees several folder headers, so before the fix this
  // load fired one id request per header. openApp waits for headers + thumbs.
  await openApp(page, { groupBy: ["folder"] });

  // The headers are on screen with their select checkboxes...
  await expect(group.selectBox(group.header(page, 0))).toBeVisible();
  // ...yet nothing is selected, so not a single group-scoped id request fired.
  expect(idReqs).toEqual([]);
  // And every visible indicator reads "none" outright — never a stuck "loading"
  // that would betray a fetch we simply hadn't waited for.
  expect(await group.selectStateOf(group.header(page, 0))).toBe("none");

  expect(errors).toEqual([]);
});

test("@p0 selecting a photo still drives the tri-state indicator", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  const idReqs = trackGroupIdRequests(page);
  await openApp(page, { groupBy: ["folder"] });
  expect(idReqs).toEqual([]); // still nothing before we select

  // Select the first photo. Its group must now light up — which requires the
  // id fetch to actually run when there IS a selection to intersect.
  await grid.selectCircle(page, 0).click();

  await expect
    .poll(async () => await group.selectStateOf(group.header(page, 0)))
    .toMatch(/^(some|all)$/);
  // The indicator resolved because a group-scoped id request was made.
  expect(idReqs.length).toBeGreaterThan(0);

  expect(errors).toEqual([]);
});
