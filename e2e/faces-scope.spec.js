import { test, expect } from "@playwright/test";
import {
  trackPageErrors,
  openApp,
  grid,
  mlPanel,
  faceSettings,
  seedFaces,
  clearFaces,
  statusBar,
  filterBar,
  clearScope,
  resetRatings,
} from "./helpers.js";
import { TOTAL_PHOTOS } from "./fixture.mjs";

/** Faces still waiting for a person, straight from the status endpoint. */
async function ungroupedCount(page) {
  const r = await page.request.get("/api/ml/faces?model=buffalo_s");
  const d = await r.json();
  return d.grouping?.pending ?? 0;
}

/**
 * FINDING FACES IN A SCOPE (#221).
 *
 * The panel used to offer exactly one thing: scan the whole library. Select
 * twenty photos and it proposed ~14 minutes of inference to answer a question
 * about twenty — the violation `docs/UI-CONTRACTS.md` § Scope names by number.
 *
 * Nothing here downloads a model or starts real inference. Everything asserted
 * is readable with faces switched off, which is also what every new user sees.
 */
test.describe("faces scope @p1", () => {
  // This file now writes TWO kinds of global state (#245), and both outlive it:
  //
  //  - the keep_scope table, from "Keep only" — since #212 that survives a
  //    reload, and `filmstripBurst.spec.js` runs after this one without ever
  //    calling `openApp`, which is what would otherwise clear it;
  //  - RATINGS, from the overlap test, which needs one rated photo to make the
  //    selection and the filter disagree. Ratings live in SQLite on purpose
  //    (docs/TESTING.md), so a photo rated here is still rated when
  //    people-view.spec.js asserts the first tile is unrated — a failure that
  //    reads as a product bug in a file this one has never heard of.
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await clearScope(page);
    await resetRatings(page);
    await page.close();
  });

  /**
   * The scope control only renders once the weights are present — offering a
   * scope for an operation you cannot run would be noise. The real weights are
   * 191 MB, and a suite that downloads them is a suite that fails on a plane
   * (the same rule `ml-settings.spec.js` follows for embedding), so the STATUS
   * is stubbed and nothing is ever downloaded or inferred.
   *
   * The stub answers 200, deliberately: Chromium logs any non-2xx as its own
   * console.error, which `trackPageErrors` would then fail on — see
   * docs/AGENT-NOTES.md.
   */
  // The panel POLLS /api/ml/faces, so a request is often still in flight when
  // a test ends — `route.fetch()` then rejects with "Test ended", and
  // Playwright attributes the error to whichever spec runs NEXT. It surfaced
  // as a failure in feed.spec.js, which touches none of this. Tear the routes
  // down before the page closes.
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test.beforeEach(async ({ page }) => {
    // `**/api/ml/faces*`, NOT `...faces?**`: in a Playwright URL glob `?` is a
    // LITERAL, not a wildcard, so that pattern matched only the query-string
    // form. The panel's FIRST fetch has no query string at all (modelId is ""
    // until the first response), so the stub missed it and the spec passed
    // only because a second, model-qualified fetch followed — load-bearing on
    // an implementation detail nobody wrote down.
    await page.route("**/api/ml/faces*", async (route, request) => {
      if (request.method() !== "GET") return route.continue();
      const real = await route.fetch();
      const body = await real.json();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...body,
          // Everything else — counts, models, running — stays REAL, so the
          // numbers under test are the fixture's own.
          weights: { ready: true, missing: [], corrupt: [] },
        }),
      });
    });
  });

  test("offers All / Filtered / Selected with live counts", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await mlPanel.open(page);

    await expect(faceSettings.scope(page)).toBeVisible();
    for (const key of ["selected", "filtered", "all"]) {
      await expect(faceSettings.scopeOption(page, key)).toHaveCount(1);
    }
    // The rename IS the fix (#245): "visible" was read as "what is on screen"
    // and meant "what the filter matches", so the count came from the loaded
    // feed window. The old key must be gone, not merely relabelled — a stale
    // `value="visible"` would mean a stale code path is still wired up.
    await expect(faceSettings.scopeOption(page, "visible")).toHaveCount(0);
    // "Keep only" is a FOURTH option that appears only while a working set is
    // in force. Without one it is the same set as All, and offering a
    // duplicate invites the user to distinguish two identical things.
    await expect(faceSettings.scopeOption(page, "keep")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("adds a Keep only scope, with its count, once one is in force (#245)", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);

    // Keep a real subset, so the scope is narrower than the library.
    await page.keyboard.press("Meta+a");
    const kept = Number(
      (await statusBar.root(page).textContent()).match(/(\d+) selected/)[1]
    );
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(TOTAL_PHOTOS);
    await statusBar.keepOnly(page).click();
    await expect(statusBar.scopeChip(page)).toBeVisible();

    await mlPanel.open(page);
    const keep = faceSettings.scopeOption(page, "keep");
    await expect(keep).toHaveCount(1);
    // The count is the working set's, read back from the server — not the
    // number of rows the grid happens to have loaded.
    await expect(faceSettings.scope(page)).toContainText(String(kept));
    expect(errors).toEqual([]);
  });

  test("says how many SELECTED photos the filter actually matches (#245)", async ({
    page,
  }) => {
    // A selection SURVIVES a filter change on purpose, so "Selected" can hold
    // photos "Filtered" excludes. Both numbers are true and the control has to
    // say which is which, rather than showing one that looks like a subset of
    // the other.
    //
    // NOTE what this file CANNOT prove: that the Filtered COUNT is the
    // filter's whole result set rather than the loaded feed window. The
    // fixture's 19 photos fit in a single feed page, so the two are equal here
    // and were equal before the fix. Distinguishing them needs a library
    // larger than one page — see the large-fixture note on #248.
    const errors = trackPageErrors(page);
    await openApp(page);

    // Rate exactly one photo, select two, then filter to rated. The selection
    // outlives the filter, so 2 selected / 1 in filter.
    await grid.focus(page, 0);
    await page.keyboard.press("5");
    await page.keyboard.press("x");
    await grid.focus(page, 1);
    await page.keyboard.press("x");
    await expect(statusBar.root(page)).toContainText(/2 selected/);

    await filterBar.minRating(page, 5);

    await mlPanel.open(page);
    // "Selected 2 · 1 in the current filter" — the exact disclosure John asked
    // for. The number can only come from the server: the client holds the feed
    // window, which is the mistake this issue is about.
    await expect(faceSettings.scope(page)).toContainText(
      /1 in the current filter/
    );
    expect(errors).toEqual([]);
  });

  test("an empty scope is offered but DISABLED, never silently widened", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await mlPanel.open(page);

    // Nothing is selected, so "Selected" reads 0 — and is disabled rather than
    // hidden. Hiding it makes the set of choices shift under the cursor as a
    // selection changes; falling back to the library is the expensive bug.
    const selected = faceSettings.scopeOption(page, "selected");
    await expect(selected).toBeDisabled();
    await expect(faceSettings.scope(page)).toContainText("Selected");

    // The default stays "All", so the primary button is still usable.
    await expect(faceSettings.scopeOption(page, "all")).toBeChecked();
    expect(errors).toEqual([]);
  });

  test("selecting photos enables Selected, and the button says how many", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);

    // Select two photos in the grid.
    await grid.selectCircle(page, 0).click();
    await grid.selectCircle(page, 1).click();

    await mlPanel.open(page);
    const selected = faceSettings.scopeOption(page, "selected");
    await expect(selected).toBeEnabled();
    await expect(faceSettings.scope(page)).toContainText("2");

    await selected.check();

    // The button names the scope it will actually run on — not the library.
    // This is the whole issue in one assertion.
    await expect(faceSettings.scan(page)).toContainText("2");
    await expect(faceSettings.scan(page)).not.toContainText(/all photos/i);
    expect(errors).toEqual([]);
  });

  test("the cost line is recomputed from the chosen scope", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await grid.selectCircle(page, 0).click();
    await mlPanel.open(page);

    // WHAT THIS CAN AND CANNOT PROVE — worth stating, because the obvious
    // version of this test is a lie.
    //
    // The contract is that the count and the "about N" move TOGETHER. But on
    // a 19-photo fixture both scopes round to the SAME string: 19 x ~52ms is
    // 0.99s and 1 x ~52ms is 0.05s, and formatEstimate clamps anything
    // sub-second to "about 1s". So asserting the time string changed here
    // asserts something this fixture cannot show, and it fails for a reason
    // that has nothing to do with the feature.
    //
    // The SCALING is therefore proved where it is genuinely testable —
    // ui/src/lib/scopeControl.test.js, which pins 10 -> "about 5s",
    // 600 -> "about 5 min", 60000 -> "about 8.3 h". This asserts the half a
    // browser is needed for: the line is rebuilt from the chosen scope rather
    // than frozen at whatever the default rendered.
    // The "All" count is read from the control rather than hard-coded. It is
    // NOT the fixture's photo count: faces only looks at `kind = 'image'`, so
    // the fixture's videos are excluded and the number is 17, not 19. Pinning
    // a literal here would be pinning an unrelated fixture detail, and it
    // would break the day a video is added.
    const allCount = await faceSettings
      .scope(page)
      .locator("label", { hasText: "All remaining" })
      .locator(".scope-n")
      .innerText();

    await expect(faceSettings.estimate(page)).toContainText(
      `Up to ${allCount} photos`
    );
    await expect(faceSettings.estimate(page)).toContainText(/about\s/);

    await faceSettings.scopeOption(page, "selected").check();

    await expect(faceSettings.estimate(page)).toContainText("Up to 1 photos");
    await expect(faceSettings.estimate(page)).toContainText(/about\s/);
    // ...and it really did move, rather than the two scopes happening to hold
    // the same number.
    expect(allCount).not.toBe("1");
    expect(errors).toEqual([]);
  });

  test("faces and embedding use the SAME control, and their choices are independent", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await grid.selectCircle(page, 0).click();
    await mlPanel.open(page);

    // Both panels render a scope fieldset — one component, two instances.
    await expect(faceSettings.scope(page)).toBeVisible();
    await expect(page.getByTestId("ml-scope")).toBeVisible();

    // The radio GROUPS must not share a name. Two groups with one name are a
    // single group to the browser, so choosing a scope for faces would
    // silently clear embedding's — a bug you only find by doing both.
    await faceSettings.scopeOption(page, "selected").check();
    await expect(
      page.getByTestId("ml-scope").locator('input[value="all"]')
    ).toBeChecked();
    expect(errors).toEqual([]);
  });
});

/**
 * GROUPING IN A SCOPE (#235).
 *
 * Grouping was the last long operation with no scope at all: it read every
 * face for the model, unconditionally. On a 118,371-face library that left one
 * offer — do everything — and a cancelled run wrote nothing, so there was no
 * way to work through it in chunks.
 *
 * Faces are seeded straight into the scratch index because the fixture is
 * sharp-drawn rectangles and detection is unreachable in e2e (see seedFaces).
 */
test.describe("grouping scope @p1", () => {
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test.beforeEach(async ({ page }) => {
    // UNGROUPED on purpose: grouping only has something to do when faces
    // have no person yet, which is the state a real library is in after a
    // face scan.
    await seedFaces(30, 2, { assign: false });
    await page.route("**/api/ml/faces*", async (route, request) => {
      if (request.method() !== "GET") return route.continue();
      const real = await route.fetch();
      const body = await real.json();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...body,
          weights: { ready: true, missing: [], corrupt: [] },
        }),
      });
    });
  });

  test.afterAll(async () => {
    // Seeded people outlive this file and render extra toolbar controls; the
    // toolbar folds by WIDTH, which breaks specs that have nothing to do with
    // faces (docs/AGENT-NOTES.md).
    await clearFaces();
  });

  test("offers grouping its OWN All / Filtered / Selected", async ({
    page,
  }) => {
    // Its own control, not detection's: "All" means a different quantity for
    // each — faces without a person versus photos without a scan — and
    // contract 1 says `allCount` is the operation's remaining work.
    const errors = trackPageErrors(page);
    await openApp(page);
    await mlPanel.open(page);

    await expect(faceSettings.groupScope(page)).toBeVisible();
    for (const key of ["selected", "filtered", "all"]) {
      await expect(faceSettings.groupScopeOption(page, key)).toHaveCount(1);
    }
    // ...and it is a SEPARATE radio group. Two groups sharing a name are one
    // group to the browser, so choosing here would silently clear the other.
    await expect(faceSettings.scope(page)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("the button names how many faces it will actually group", async ({
    page,
  }) => {
    // A bare "Group faces into people" is the shape contract 1 refuses: it
    // does not say what it is about to do.
    const errors = trackPageErrors(page);
    await openApp(page);
    await mlPanel.open(page);

    await expect(faceSettings.cluster(page)).toContainText(
      /Group [\d,]+ faces/
    );
    expect(errors).toEqual([]);
  });

  test("an empty selection is offered but DISABLED, never widened", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await mlPanel.open(page);

    await expect(
      faceSettings.groupScopeOption(page, "selected")
    ).toBeDisabled();
    await expect(faceSettings.groupScopeOption(page, "all")).toBeChecked();
    expect(errors).toEqual([]);
  });

  test("grouping runs and KEEPS its work, so a second run has less to do", async ({
    page,
  }) => {
    // The heart of #235. docs/TESTING.md: click the button, do not merely
    // assert that it renders — a control that looked right and did nothing is
    // why this tier exists.
    const errors = trackPageErrors(page);
    await openApp(page);
    await mlPanel.open(page);

    const before = await ungroupedCount(page);
    expect(before).toBeGreaterThan(0);

    await faceSettings.cluster(page).click();
    await expect.poll(() => ungroupedCount(page), { timeout: 30_000 }).toBe(0);

    // Everything now has a person, so the operation says so rather than
    // offering a job that would finish instantly.
    await page.reload();
    await mlPanel.open(page);
    await expect(faceSettings.cluster(page)).toBeDisabled();
    expect(errors).toEqual([]);
  });
});
