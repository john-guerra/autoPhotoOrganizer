import { test, expect } from "@playwright/test";
import { openApp, trackPageErrors, statusBar, mlPanel } from "./helpers.js";

/**
 * Filtering by a saved semantic tag (#164).
 *
 * e2e rather than unit because both halves of what matters here are invisible
 * to a unit test: the picker must not exist at all until a tag does (this
 * toolbar folds by WIDTH, and two extra controls in GridControls once pushed
 * the whole Group group into an overflow popover — a regression e2e caught and
 * no unit test could), and choosing a tag has to narrow the real feed through
 * all three layers of the facet. A facet missing from the server's allowlist
 * is silently dropped however correct the SQL and the UI are, and that failure
 * looks like nothing at all from the client side.
 *
 * The tag is created through the API rather than by running a search: a real
 * search needs embeddings, and creating those means downloading ~90 MB, which
 * ml-settings.spec.js explains a test suite may not do.
 */

const TAG = "e2e-sunset";

async function clearTag(request) {
  await request
    .delete(`/api/ml/tags/${encodeURIComponent(TAG)}`)
    .catch(() => {});
}

test.describe("@p1 saved tag filter", () => {
  test.afterEach(async ({ request }) => clearTag(request));

  test("no picker until a tag exists, then it narrows the feed", async ({
    page,
    request,
  }) => {
    const errors = trackPageErrors(page);
    await clearTag(request);
    await openApp(page);

    // Nothing saved: the control must not be taking toolbar width.
    await expect(page.getByTestId("tag-filter")).toHaveCount(0);

    // Take two real photo ids from the grid and save them as a tag.
    const ids = await page.evaluate(() =>
      [...document.querySelectorAll(".thumb")]
        .slice(0, 2)
        .map((t) => Number(t.dataset.id))
        .filter(Number.isFinite)
    );
    expect(ids.length).toBe(2);

    const res = await request.post("/api/ml/tags", {
      data: { value: TAG, ids },
    });
    expect(res.ok()).toBe(true);

    // Reload so App re-reads the tag list on mount.
    await openApp(page);
    const picker = page.getByTestId("tag-filter");
    await expect(picker).toBeVisible();
    await expect(picker).toContainText(TAG);

    const before = await statusBar.showingCount(page);
    await picker.selectOption(TAG);

    // The feed is now exactly the tagged photos — proving the facet survived
    // client spec -> server allowlist -> SQL.
    await expect
      .poll(() => statusBar.showingCount(page), { timeout: 15000 })
      .toBe(2);
    expect(before).toBeGreaterThan(2);

    expect(errors).toEqual([]);
  });

  test("deleting the tag you are filtered by restores the view and says why", async ({
    page,
    request,
  }) => {
    const errors = trackPageErrors(page);
    await clearTag(request);
    await openApp(page);

    const ids = await page.evaluate(() =>
      [...document.querySelectorAll(".thumb")]
        .slice(0, 2)
        .map((t) => Number(t.dataset.id))
        .filter(Number.isFinite)
    );
    await request.post("/api/ml/tags", { data: { value: TAG, ids } });

    await openApp(page);
    await page.getByTestId("tag-filter").selectOption(TAG);
    await expect.poll(() => statusBar.showingCount(page)).toBe(2);

    // The real path: the ML panel is the ONLY place a tag can be deleted, and
    // closing it is what makes App re-read the list. Driving it through the
    // panel is what makes this exercise the guard rather than a page reload,
    // which never restores the tag and so proves nothing.
    await mlPanel.open(page);
    await expect(mlPanel.search(page)).toBeVisible();
    await clearTag(request);
    await mlPanel.close(page);

    // Without the guard the user is left on an empty grid, filtered by a tag
    // that no longer exists, with nothing on screen explaining either.
    await expect
      .poll(() => statusBar.showingCount(page), { timeout: 15000 })
      .toBeGreaterThan(2);
    // In the PERSISTENT channel, not the transient one: clearing the filter
    // rebuilds the feed, whose "N photos loaded" overwrites `status` a beat
    // later. This spec caught exactly that, twice now (see #211).
    await expect(statusBar.notice(page)).toContainText("no longer exists");
    await expect(page.getByTestId("tag-filter")).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});
