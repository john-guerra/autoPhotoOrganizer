import { test, expect } from "@playwright/test";
import {
  trackPageErrors,
  openApp,
  views,
  peopleView,
  statusBar,
  grid,
} from "./helpers.js";

/**
 * PEOPLE AS A VIEW (#223).
 *
 * Browsing and naming people used to happen in a scrolling list of text inputs
 * inside gear → Machine learning. Two things were wrong with that: a settings
 * panel is for settings, and naming someone from an "Unnamed · 34 faces"
 * placeholder is guessing — you need to see the face.
 *
 * The fixture has no real faces (detection needs a 191 MB model this suite must
 * never download), so `/api/ml/people` is stubbed. That is honest here: what is
 * under test is the VIEW — that it is registered, reachable by keyboard,
 * renders a tile per person, and drives App's existing `personId` filter. The
 * crop geometry is proved in `server/ml/faceCrop.test.js`, and the registry
 * declaration in `ui/src/lib/views/registry.test.js`.
 */
const PEOPLE = [
  { id: 7, name: "Ada", coverFaceId: 101, faces: 34, photos: 21 },
  { id: 8, name: "", coverFaceId: 102, faces: 12, photos: 9 },
  { id: 9, name: "Grace", coverFaceId: null, faces: 3, photos: 3 },
];

test.describe("People view @p1", () => {
  test.afterEach(async ({ page }) => {
    // An in-flight route handler at teardown rejects with "Test ended" and
    // Playwright blames the NEXT spec file — see faces-scope.spec.js.
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test.beforeEach(async ({ page }) => {
    await page.route("**/api/ml/people", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ people: PEOPLE }),
      });
    });
    // The crops would 404 (no such faces in the fixture) and Chromium logs any
    // non-2xx as its own console.error, which trackPageErrors then fails on.
    // A 1x1 GIF keeps the tiles honest without needing real face data.
    await page.route("**/api/ml/faces/*/crop*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "image/gif",
        body: Buffer.from(
          "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
          "base64"
        ),
      });
    });
  });

  test("the switcher offers People only once there ARE people", async ({
    page,
  }) => {
    // The toolbar folds by WIDTH — a third always-on button pushed Group-by
    // into the overflow popover at 1280px, which is how CI caught this. So the
    // button is earned, not permanent. Same rule PersonFilter follows.
    const errors = trackPageErrors(page);
    await page.route("**/api/ml/people", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ people: [] }),
      });
    });
    await openApp(page);

    await expect(views.switchBtn(page, "people")).toHaveCount(0);
    // ...and the controls it would have displaced are still on the toolbar.
    await expect(page.locator(".group-by").first()).toBeVisible();

    // But V still REACHES it: hiding a button is about width, not about
    // taking the view away, and its empty state explains how to fill it.
    await views.cycle(page); // albums
    const modal = page.locator('dialog.modal[aria-label="Auto Albums"]');
    await modal.locator("button", { hasText: "Cancel" }).click();
    await expect(modal).toBeHidden();
    await views.cycle(page); // people
    await expect(peopleView.root(page)).toBeVisible();
    await expect(peopleView.root(page)).toContainText(
      /Nobody has been grouped/
    );
    expect(errors).toEqual([]);
  });

  test("is reachable from the main interface with the keyboard alone", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await expect(views.grid(page)).toBeVisible();

    // grid → albums → people. It is the third registered view, so V reaches it
    // without a mouse ever being involved — the acceptance's "keyboard-
    // accessible" clause.
    await views.cycle(page);
    await expect(page.locator(".albums-view")).toBeVisible({ timeout: 15000 });
    const modal = page.locator('dialog.modal[aria-label="Auto Albums"]');
    await modal.locator("button", { hasText: "Cancel" }).click();
    await expect(modal).toBeHidden();

    await views.cycle(page);
    await expect(peopleView.root(page)).toBeVisible();
    await expect(views.grid(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("draws a tile per person, largest first, naming the unnamed ones honestly", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await views.switchBtn(page, "people").click();
    await expect(peopleView.root(page)).toBeVisible();

    await expect(peopleView.tiles(page)).toHaveCount(3);
    await expect(peopleView.name(page, 0)).toHaveText("Ada");
    // An unnamed person is still listed and still browsable — #167 is explicit
    // about that — and the tile invites a name rather than pretending to have
    // one.
    await expect(peopleView.name(page, 1)).toHaveText("Add a name");
    // A person with no crop gets initials, not a broken image.
    await expect(peopleView.tiles(page).nth(2).locator(".initials")).toHaveText(
      "G"
    );
    expect(errors).toEqual([]);
  });

  test("clicking a person filters the feed to them, and says how to undo it", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await views.switchBtn(page, "people").click();
    await expect(peopleView.root(page)).toBeVisible();

    await peopleView.face(page, 0).click();

    // It drives App's EXISTING personId filter, not a second mechanism — so
    // the status bar's count reflects it exactly as any other filter would.
    await expect(peopleView.tiles(page).first()).toHaveClass(/active/);
    await expect(peopleView.clearFilter(page)).toBeVisible();

    // The filter OUTLIVES this view, so the way out has to be here rather than
    // something the user must go hunting for in the toolbar.
    await peopleView.clearFilter(page).click();
    await expect(peopleView.tiles(page).first()).not.toHaveClass(/active/);
    expect(errors).toEqual([]);
  });

  test("naming a person happens on the face, not in a settings list", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);

    let renamed = null;
    await page.route("**/api/ml/people/*", async (route, request) => {
      if (request.method() !== "PUT") return route.continue();
      renamed = JSON.parse(request.postData() ?? "{}");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: 8, name: renamed.name }),
      });
    });

    await views.switchBtn(page, "people").click();
    await peopleView.name(page, 1).click();
    await peopleView.nameInput(page).fill("Lin");
    await peopleView.nameInput(page).press("Enter");

    await expect.poll(() => renamed?.name).toBe("Lin");
    expect(errors).toEqual([]);
  });

  test("rating and selection are REFUSED here, not silently applied to the feed", async ({
    page,
  }) => {
    // People declares open/select/rate: false. `selected` indexes a feed
    // window this view is not rendering, so a `3` here would rate a photo the
    // user cannot see — the exact bug #155's capability system exists to stop,
    // now exercised by a third view rather than argued about.
    const errors = trackPageErrors(page);
    await openApp(page);
    await grid.focus(page, 0);
    await expect(grid.ratingBadge(page, 0)).toHaveCount(0);

    await views.switchBtn(page, "people").click();
    await expect(peopleView.root(page)).toBeVisible();

    await page.keyboard.press("3");
    await expect(statusBar.notice(page)).toContainText(
      /Rating isn't available/
    );
    await expect(statusBar.notice(page)).toContainText("People");

    // And nothing was rated behind the user's back.
    await views.switchBtn(page, "people").click();
    await expect(views.grid(page)).toBeVisible();
    await expect(grid.ratingBadge(page, 0)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("the ML panel keeps the settings and stops being where you browse", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    // The faces block only renders past the weights gate — without them the
    // panel correctly shows "Not downloaded yet" and nothing else. The real
    // weights are 191 MB, so the STATUS is stubbed; counts stay the fixture's.
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

    await openApp(page);
    await page.locator(".topbar button[aria-label='Settings']").click();
    await page.getByRole("button", { name: /Machine learning/ }).click();

    // The acceptance's second half. The old text-input list is gone; what
    // remains is a pointer to where browsing now lives.
    await expect(page.getByTestId("people-list")).toHaveCount(0);
    await expect(peopleView.movedNotice(page)).toContainText(/People/);
    expect(errors).toEqual([]);
  });
});
