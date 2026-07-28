import { test, expect } from "@playwright/test";
import {
  trackPageErrors,
  openApp,
  grid,
  mlPanel,
  faceSettings,
} from "./helpers.js";

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
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/ml/faces?**", async (route, request) => {
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

  test("offers All / Visible / Selected with live counts", async ({ page }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await mlPanel.open(page);

    await expect(faceSettings.scope(page)).toBeVisible();
    for (const key of ["selected", "visible", "all"]) {
      await expect(faceSettings.scopeOption(page, key)).toHaveCount(1);
    }
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

  test("the estimate tracks the scope", async ({ page }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await grid.selectCircle(page, 0).click();
    await mlPanel.open(page);

    // An estimate that does not move with the scope is worse than none — the
    // user plans around it.
    const before = await faceSettings.estimate(page).innerText();
    await faceSettings.scopeOption(page, "selected").check();
    const after = await faceSettings.estimate(page).innerText();

    expect(after).not.toBe(before);
    expect(after).toContain("1");
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
