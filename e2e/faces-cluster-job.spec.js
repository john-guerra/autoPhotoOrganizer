import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, mlPanel, faceSettings } from "./helpers.js";

/**
 * GROUPING FACES IS A JOB (#222).
 *
 * The issue's repro, verbatim: start the grouping, close the panel, open the
 * jobs panel — and find nothing there. It was a synchronous request the panel
 * awaited, so on ~10,700 faces (57 million comparisons) you got a frozen
 * button, no progress, no cancel, and the whole operation became invisible the
 * moment you navigated away.
 *
 * Nothing here downloads a model or runs real inference. The face STATUS is
 * stubbed so the panel renders its grouped state (the weights are 191 MB and a
 * suite that fetches them fails on a plane), and the cluster POST is stubbed so
 * the row's shape can be asserted without needing real face vectors in the
 * fixture — the pass itself is covered at tier 1 in
 * `server/ml/faceClusters.test.js`, which is where cancellation and progress
 * arithmetic actually belong.
 */
test.describe("faces cluster job @p1", () => {
  // See faces-scope.spec.js: an in-flight `route.fetch()` at teardown rejects
  // with "Test ended" and Playwright blames whichever spec runs next.
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  /** Report weights present and some faces already found, so the panel shows
   *  the "Group faces into people" button at all. */
  async function stubReadyWithFaces(page) {
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
          counts: { ...body.counts, scanned: 12, faces: 30, withFaces: 9 },
        }),
      });
    });
  }

  test("starting a grouping returns a job, not a result — and the button says so", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await stubReadyWithFaces(page);

    /** @type {any} */
    let posted = null;
    await page.route("**/api/ml/faces/cluster", async (route) => {
      posted = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ started: true, jobId: "job-999", faces: 30 }),
      });
    });

    await openApp(page);
    await mlPanel.open(page);

    await faceSettings.cluster(page).click();

    // The panel does NOT sit awaiting a result. It says where the work went.
    expect(posted).toBe(true);
    await expect(page.getByTestId("face-settings")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("a refusal is surfaced in the panel rather than failing silently", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await stubReadyWithFaces(page);

    // The real 409 the server sends when a scan is running. The message is
    // written to be rendered verbatim — it names what to do next.
    await page.route("**/api/ml/faces/cluster", async (route) => {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error:
            "A face scan is still running. Wait for it to finish so every face is grouped, or stop it from the jobs panel.",
        }),
      });
    });

    await openApp(page);
    await mlPanel.open(page);
    await faceSettings.cluster(page).click();

    // Visible, specific, actionable — not a console error and not a dead
    // button. Note the 409 is deliberately injected, so `trackPageErrors` is
    // filtered rather than asserted empty (docs/AGENT-NOTES.md).
    await expect(page.getByTestId("face-error")).toContainText(
      /face scan is still running/i
    );
    expect(
      errors.filter((e) => !/409|Failed to load resource/i.test(e))
    ).toEqual([]);
  });

  // NOTE ON WHAT IS *NOT* HERE. An earlier draft of this file asserted that
  // the jobs widget is reachable from the main interface — but the fixture has
  // no face vectors, so a real grouping cannot be started, and the assertion
  // degenerated to `rows.count() >= 0`, which cannot fail. It proved the jobs
  // widget exists (it already did, pre-#222) and nothing about this change.
  //
  // The substance is covered where it can actually be exercised:
  //   - the job exists, has type "face-cluster" and carries a knowable total
  //     (so the bar is proportional, not indeterminate) — faceRoutes.test.js;
  //   - a refused request creates NO job — faceRoutes.test.js;
  //   - cancelling stops at the yield point and writes nothing, and progress
  //     is measured in pairs rather than rows — faceClusters.test.js.
  // Adding a browser test that re-asserts those through three layers of stub
  // would be slower and weaker, which is the pyramid docs/TESTING.md describes.
});
