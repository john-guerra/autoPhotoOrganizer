import { test, expect } from "@playwright/test";
import { openApp, trackPageErrors, grid, statusBar } from "./helpers.js";

/**
 * What "Find duplicates" tells you afterwards (#211).
 *
 * This is an e2e and not a unit test because the bug it guards is not in the
 * message — `nearDupeReport.test.js` covers the wording — but in WHERE the
 * message is put. The run ends with a feed reload, whose thumbnail loading
 * writes "N photos loaded" to the transient status line a beat later; the
 * answer was being written to that same line and was gone before it could be
 * read. Every unit test passed and the feature still did not work, which is
 * the exact shape of bug this project keeps shipping (CLAUDE.md, "A fixed bug
 * gets a test that would have caught it").
 *
 * The ML endpoints are stubbed rather than exercised. A real near-duplicate
 * sweep is only SQLite and arithmetic — no model download — but it has nothing
 * to work on without embeddings, and creating those means fetching ~90 MB,
 * which ml-settings.spec.js explains is not something a test suite may do.
 * What is under test here is the client's own behaviour after the call
 * returns, and that is exercised in full.
 */

const STATS = {
  model: "Xenova/siglip-base-patch16-224",
  provider: "onnxruntime-node (cpu)",
  counts: { total: 2, embedded: 2, failed: 0 },
  storage: [],
  nearDupes: { photos: 4, groups: 2, computedAt: 1785122048462 },
};

test.describe("@p1 Find duplicates: the answer", () => {
  // Enabled only so the toolbar button renders — the button is hidden when
  // photo similarity is off, deliberately (it would otherwise spend toolbar
  // width doing nothing). Reset after, so a run never leaves the setting on:
  // `enabled` left true is what would let a later click start a real download.
  test.beforeEach(async ({ page }) => {
    await page.request.put("/api/ml/settings", {
      data: { modelId: "Xenova/siglip-base-patch16-224", enabled: true },
    });
  });

  test.afterEach(async ({ page }) => {
    await page.request.put("/api/ml/settings", {
      data: { modelId: "Xenova/siglip-base-patch16-224", enabled: false },
    });
  });

  /** Matched by exact pathname: a glob for the sweep would also swallow the
   *  /counts call underneath it, and the two must answer differently. */
  async function stubMl(page, { scoped }) {
    await page.route(
      (url) => url.pathname === "/api/ml/stats",
      (route) => route.fulfill({ json: STATS })
    );
    await page.route(
      (url) => url.pathname === "/api/ml/near-dupes",
      // No jobId: the client skips waiting on a job it was not given one for,
      // which is the same path a sweep that finished inside the request takes.
      (route) => route.fulfill({ json: { started: true } })
    );
    await page.route(
      (url) => url.pathname === "/api/ml/near-dupes/counts",
      (route) => route.fulfill({ json: { scoped, library: STATS.nearDupes } })
    );
  }

  test("survives the feed reload that follows it, and names the selection", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await stubMl(page, { scoped: { groups: 2, photos: 2, spillGroups: 1 } });
    await openApp(page);

    await grid.selectCircle(page, 0).click();
    await grid.selectCircle(page, 1).click();
    expect(await statusBar.selectedCount(page)).toBe(2);

    await page.getByTestId("find-dupes").click();

    // The answer is about the user's photos, not about the library.
    const notice = statusBar.notice(page);
    await expect(notice).toContainText(
      "2 groups of near-identical photos among your 2 selected photos",
      { timeout: 15000 }
    );
    // ...and it does not claim groups that reach past the selection.
    await expect(notice).toContainText("1 of them reaching photos outside it");

    // THE REGRESSION. Let the feed reload's thumbnail loading finish — that is
    // what used to overwrite the answer — and require it to still be readable.
    await page.waitForLoadState("networkidle");
    await expect(notice).toContainText("among your 2 selected photos");

    expect(errors).toEqual([]);
  });

  test("with nothing selected it reports the library, without inventing a selection", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await stubMl(page, { scoped: { groups: 0, photos: 0, spillGroups: 0 } });
    await openApp(page);

    await page.getByTestId("find-dupes").click();

    const notice = statusBar.notice(page);
    await expect(notice).toContainText("2 groups of near-identical photos", {
      timeout: 15000,
    });
    await expect(notice).not.toContainText("selected");
    await expect(notice).not.toContainText("library-wide");

    expect(errors).toEqual([]);
  });
});
