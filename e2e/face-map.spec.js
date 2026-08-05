import { test, expect } from "@playwright/test";
import { join } from "node:path";
import {
  openApp,
  trackPageErrors,
  views,
  faceMap,
  seedFaces,
  clearFaces,
  clearRatings,
  personCount,
} from "./helpers.js";

/**
 * THE FACE MAP, as a human meets it (#232).
 *
 * Everything here is a click or a drag. `docs/TESTING.md` exists because a
 * "Remove" button once rendered correctly and silently did nothing when
 * pressed — it had been verified to APPEAR and never verified to WORK. So this
 * lassos, drops a chip, merges, and undoes, and checks the person count moved
 * by the right amount each time.
 *
 * The map is canvas, so no other tier can see any of it.
 */
/**
 * Enough people that the view EARNS a switcher button (`offerable` requires
 * 100 — a map of a handful is useless, and the toolbar folds by width). The
 * un-advertised path below the threshold is covered by its own test.
 */
const PEOPLE = 120;

/**
 * Faces per seeded person, and it must CLEAR the product default.
 *
 * `minFaces` defaults to 5 (#255), so a fixture seeding 2 faces each puts
 * nobody on the map: every test below would then drive an empty map and fail
 * for a reason that has nothing to do with what it is testing. Seed at the
 * default rather than lowering the threshold per test — a spec that has to
 * reconfigure the product to see anything is testing a configuration no user
 * has.
 */
const FACES_EACH = 5;

/** Rate every photo that the first `n` seeded people appear in. */
async function ratePhotosOfFirstPeople(page, n) {
  const r = await page.request.post("/api/e2e-rate-people", {
    data: { people: n },
    failOnStatusCode: false,
  });
  if (r.ok()) return (await r.json()).rated;
  // No test-only route in the app (correctly). Do it through the index, the
  // same way seedFaces does.
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(
    join(process.cwd(), "e2e", ".tmp", "home", "index.db")
  );
  try {
    const ids = db
      .prepare(
        `SELECT DISTINCT photo_id FROM photo_faces
          WHERE person_id IS NOT NULL AND person_id <= ?`
      )
      .all(n)
      .map((x) => x.photo_id);
    if (!ids.length) return 0;
    db.prepare(
      `UPDATE photos SET rating = 5 WHERE id IN (${ids.join(",")})`
    ).run();
    return ids.length;
  } finally {
    db.close();
  }
}

/**
 * Seed the minimum-rating filter and reopen the map.
 *
 * An INIT script rather than `page.evaluate` + reload: `openApp` registers its
 * own init script that calls `localStorage.clear()` on every navigation, so a
 * value written into the live page is wiped by the very reload meant to apply
 * it. Init scripts run in registration order, so this one lands after the
 * clear.
 *
 * Seeding the storage key beats driving the toolbar's rating widget — a test
 * about the MAP should not break when that widget's markup changes.
 */
async function applyMinRating(page, stars) {
  await page.addInitScript((s) => {
    window.localStorage.setItem(
      "autogallery.filter",
      JSON.stringify({ minRating: s })
    );
  }, stars);
  await page.reload();
  await views.show(page, "face-map");
  await expect(faceMap.root(page)).toBeVisible();
  await page.waitForTimeout(1000);
}

test.describe("face map @p1", () => {
  // Leave the library as we found it. Seeded people outlive this file, and
  // enough of them render two extra toolbar controls (PersonFilter + the map's
  // switcher button) — the toolbar folds by width, so that breaks specs with
  // nothing to do with faces. This cost two red specs before it was added.
  test.afterAll(async () => {
    await clearFaces();
  });

  test.beforeEach(async () => {
    // The generated fixture has no faces in it and detection is unreachable in
    // e2e, so the rows detection would have written are seeded directly. See
    // seedFaces — it can only ever touch e2e/.tmp/home.
    //
    // Ratings are reset here TOO, and that is not tidiness: ratings live in
    // SQLite and outlive a test, so the filter tests below rate photos and the
    // next test inherits them. "Nothing is rated, so this filter matches
    // nobody" then quietly becomes false and the test fails for a reason that
    // has nothing to do with the map (docs/TESTING.md's rule 2).
    await seedFaces(PEOPLE, FACES_EACH);
    await clearRatings();
  });

  test("says what it cannot show, and builds a map on request", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await views.show(page, "face-map");

    // Never an empty canvas: the empty state explains what a map is for and
    // quotes the cost.
    await expect(faceMap.empty(page)).toBeVisible();

    await faceMap.build_(page);
    await expect(faceMap.count(page)).toContainText(String(PEOPLE));
    await expect(faceMap.scatter(page)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("the gear reports a live member count that tracks minimum faces", async ({
    page,
  }) => {
    // This is how the projection meets contract 1 without a ScopeControl: its
    // one scope dimension carries a count, so the user is never offered a bare
    // button meaning "do everything".
    const errors = trackPageErrors(page);
    await openApp(page);
    await views.show(page, "face-map");
    await faceMap.gear(page).click();

    // Everyone clears the default of 5 (#255), so the gear opens on everyone.
    await expect(faceMap.members(page)).toContainText(String(PEOPLE));
    await faceMap
      .gearPanel(page)
      .locator('input[type="number"]')
      .first()
      .fill(String(FACES_EACH + 1));
    await faceMap
      .gearPanel(page)
      .locator('input[type="number"]')
      .first()
      .blur();
    // Nobody has that many faces in the fixture, so the honest answer is zero.
    // "0 people", not "0" — `toContainText("0")` also matches "120 people",
    // which is the answer this assertion exists to rule out.
    await expect(faceMap.members(page)).toContainText("0 people");
    // And the threshold SAYS what it is hiding rather than just shrinking the
    // count — a filter that silently removes everyone reads as data loss
    // (#255).
    await expect(faceMap.hidden(page)).toContainText(String(PEOPLE));
    expect(errors).toEqual([]);
  });

  test("says how many people the minimum is leaving off, BEFORE you build", async ({
    page,
  }) => {
    // #255's third acceptance criterion, and the half of it that had no test:
    // the gear's version is covered above, but the EMPTY STATE version is what
    // a first-time visitor reads, and it is the moment the threshold is least
    // obvious — you have not opened the settings yet.
    //
    // It needs a mixed population. With every seeded person at exactly the
    // default, nobody is hidden, the element never renders, and a test
    // asserting on it would be asserting on nothing.
    const HIDDEN = 30;
    await seedFaces(PEOPLE, FACES_EACH, { below: HIDDEN, belowFaces: 1 });

    const errors = trackPageErrors(page);
    await openApp(page);
    await views.show(page, "face-map");

    await expect(faceMap.empty(page)).toBeVisible();
    await expect(faceMap.hiddenEmpty(page)).toContainText(String(HIDDEN));
    // Named, not just counted: it has to say what the threshold IS, or the
    // number is unactionable.
    await expect(faceMap.hiddenEmpty(page)).toContainText(String(FACES_EACH));
    // And the members line still reports only the people who clear it.
    await expect(faceMap.empty(page)).toContainText(String(PEOPLE));
    expect(errors).toEqual([]);
  });

  test("lasso, drop one, merge, undo @p1", async ({ page }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await views.show(page, "face-map");
    await faceMap.build_(page);

    const before = await personCount(page);
    expect(before).toBe(PEOPLE);

    // A generous lasso over most of the canvas.
    await faceMap.lasso(page, [
      [0.05, 0.05],
      [0.95, 0.05],
      [0.95, 0.95],
      [0.05, 0.95],
    ]);

    await expect(faceMap.tray(page)).toBeVisible();
    const caught = await faceMap.chips(page).count();
    expect(caught).toBeGreaterThan(2);

    // Drop one — the tray is a REVIEW step, not a receipt.
    await faceMap.chips(page).first().click();
    await expect(faceMap.chips(page)).toHaveCount(caught - 1);

    await faceMap.name(page).fill("Mafe");
    await faceMap.merge(page).click();

    // n people become 1, so the count falls by n-1.
    await expect
      .poll(() => personCount(page), { timeout: 20_000 })
      .toBe(before - (caught - 2));

    // And it is undoable, which CLAUDE.md requires of anything destructive.
    await expect(faceMap.undo(page)).toBeVisible();
    await faceMap.undoBtn(page).click();
    await expect
      .poll(() => personCount(page), { timeout: 20_000 })
      .toBe(before);

    expect(errors).toEqual([]);
  });

  test("shift-lasso adds to the selection rather than replacing it", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await views.show(page, "face-map");
    await faceMap.build_(page);

    // TWO DISJOINT HALVES, and the assertion is on IDENTITY, not on a count.
    //
    // Both halves of that matter, and each fixes a different way this test has
    // already been wrong:
    //
    // - The regions must not NEST. A second lasso that contains the first
    //   leaves `selected ∪ lasso2 == lasso2`, which is byte-identical to what
    //   a broken shift that REPLACED the selection would produce. The test
    //   then passes no matter which behaviour is wired up, and only fails if
    //   shift-lasso does nothing whatsoever.
    // - They must not leave a GAP either. Splitting at x<0.45 / x>0.55 assumed
    //   UMAP puts nobody in the middle band; when the fixture got denser it
    //   put most of the map there, the right-hand lasso caught nobody, and the
    //   test failed while shift-add worked perfectly.
    //
    // Meeting exactly at 0.5 satisfies both: disjoint, and between them they
    // cover the canvas, so neither side can be empty unless the whole layout
    // has collapsed — which is worth failing for.
    await faceMap.lasso(page, [
      [0.02, 0.02],
      [0.5, 0.02],
      [0.5, 0.98],
      [0.02, 0.98],
    ]);
    const left = await faceMap.chipIds(page);
    expect(left.length).toBeGreaterThan(0);
    expect(left.length).toBeLessThan(PEOPLE);

    await faceMap.lasso(
      page,
      [
        [0.5, 0.02],
        [0.98, 0.02],
        [0.98, 0.98],
        [0.5, 0.98],
      ],
      { shift: true }
    );

    const after = await faceMap.chipIds(page);
    // Everyone from the LEFT lasso is still selected. This is the assertion
    // that can tell add from replace: the right-hand lasso does not contain
    // them, so a shift that replaced would have dropped every one.
    for (const id of left) expect(after).toContain(id);
    // And the right-hand lasso genuinely contributed somebody new, so the
    // check above is not vacuously true against an unchanged tray.
    expect(after.length).toBeGreaterThan(left.length);
    expect(errors).toEqual([]);
  });

  test("Escape clears the selection instead of being refused", async ({
    page,
  }) => {
    // Without the registry's `keys` declaration this key reaches
    // refuseUnsupported and the user is told "Selecting photos isn't available
    // in Face Map" — while looking at a selection of people.
    const errors = trackPageErrors(page);
    await openApp(page);
    await views.show(page, "face-map");
    await faceMap.build_(page);

    await faceMap.lasso(page, [
      [0.05, 0.05],
      [0.95, 0.05],
      [0.95, 0.95],
      [0.05, 0.95],
    ]);
    await expect(faceMap.tray(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(faceMap.tray(page)).toHaveCount(0);
    // The wrong message must not appear.
    await expect(
      page.getByText(/Selecting photos isn't available/i)
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("REFUSES to merge two differently-named people silently", async ({
    page,
  }) => {
    // Merging keeps one name and destroys the other, and the loss is invisible
    // until someone goes looking weeks later. So the app asks.
    const errors = trackPageErrors(page);
    await openApp(page);
    await views.show(page, "face-map");
    await faceMap.build_(page);

    // Name two of them through the API the People view uses.
    await page.request.put("/api/ml/people/1", { data: { name: "Mafe" } });
    await page.request.put("/api/ml/people/2", { data: { name: "John" } });
    await page.reload();
    await views.show(page, "face-map");
    await faceMap.build_(page);

    await faceMap.lasso(page, [
      [0.05, 0.05],
      [0.95, 0.05],
      [0.95, 0.95],
      [0.05, 0.95],
    ]);
    await faceMap.merge(page).click();

    await expect(faceMap.conflict(page)).toBeVisible();
    // Nothing was merged while it asks.
    expect(await personCount(page)).toBe(PEOPLE);
    // Chromium logs ANY non-2xx as its own console error, including the 409
    // this test exists to provoke. Filtering it is the documented rule
    // (AGENT-NOTES: "never assert a bare [] in a test that stubs a failure");
    // asserting [] here would make the test fail for succeeding.
    expect(errors.filter((e) => !/409/.test(e))).toEqual([]);
  });

  test("stays reachable by keyboard when it has not earned a button", async ({
    page,
  }) => {
    // `offerable` hides the BUTTON when a map would be useless; it must not
    // hide the VIEW. "An un-offered view is reachable, just not advertised,
    // and its empty state explains how to fill it" — registry.js.
    //
    // The un-offered state used to be "fewer than 100 people" and is now "no
    // people at all" (#300 lowered the gate at John's request). So this seeds
    // NOBODY rather than four. The property under test is unchanged — an
    // un-offered view is still reachable by keyboard — only the way to reach
    // the un-offered state has moved.
    const errors = trackPageErrors(page);
    await clearFaces();
    await openApp(page);
    await expect(views.switchBtn(page, "face-map")).toHaveCount(0);

    // Entering a working-set view performs a fetch and `switchView` ignores a
    // second V while one is in flight — so pressing and checking immediately
    // both races the switch AND can skip past the view entirely.
    // Press, settle, THEN look.
    for (let i = 0; i < 6; i++) {
      await views.cycle(page);
      await page.waitForTimeout(400);
      if (await faceMap.root(page).count()) break;
    }
    await expect(faceMap.root(page)).toBeVisible();
    await expect(faceMap.empty(page)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("narrows to the people in the photos you are viewing @p1", async ({
    page,
  }) => {
    // "Show me only the faces of the keep-only photos." The map hides rather
    // than re-projects, so a person keeps their place whatever you filter to —
    // which is what makes positions comparable across filters.
    const errors = trackPageErrors(page);
    await openApp(page);
    await views.show(page, "face-map");
    await faceMap.build_(page);
    await expect(faceMap.count(page)).toContainText(String(PEOPLE));

    // Rate the photos of ONE person, then filter to rated. One, not three:
    // `seedFaces` puts each person's faces in `FACES_EACH` consecutive photos
    // (mod the fixture's 19), so three people's photos now cover 15 of 19 and
    // the "narrowed" set is the whole library — the assertion below would fail
    // with the filter working perfectly.
    const rated = await ratePhotosOfFirstPeople(page, 1);
    expect(rated).toBeGreaterThan(0);

    await page.reload();
    await views.show(page, "face-map");
    await applyMinRating(page, 5);

    // The count must SAY it is narrowed, not quietly look like the library.
    await expect(faceMap.count(page)).toContainText("in view");
    const shown = Number(
      (await faceMap.count(page).innerText())
        .match(/^([\d,]+)/)[1]
        .replace(/,/g, "")
    );
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(PEOPLE);
    expect(errors).toEqual([]);
  });

  test("says so when the filter matches nobody, instead of an empty canvas", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await views.show(page, "face-map");
    await faceMap.build_(page);

    // Nothing is rated, so a 5-star filter matches no photos at all.
    await applyMinRating(page, 5);
    await expect(faceMap.filteredEmpty(page)).toBeVisible();
    await expect(faceMap.filteredEmpty(page)).toContainText(/Nobody here/i);
    expect(errors).toEqual([]);
  });

  test("the shortcuts overlay documents the map's own keys", async ({
    page,
  }) => {
    // A shortcut nobody can find does not exist. The overlay renders these
    // from the registry, so they cannot drift out of sync with the handler.
    const errors = trackPageErrors(page);
    await openApp(page);
    await views.show(page, "face-map");

    const overlay = await views.shortcuts(page);
    await expect(
      overlay.getByRole("heading", { name: "Face Map" })
    ).toBeVisible();
    await expect(
      overlay.getByText("Clear the lasso and empty the tray")
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
});
