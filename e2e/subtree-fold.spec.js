import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, group } from "./helpers.js";
import { FOLDERS, itemsIn } from "./fixture.mjs";

/**
 * A PARENT folder's fold icon folds its whole subtree as one unit (#142).
 *
 * Before this feature, a plain click on "Cards" (the fixture's virtual
 * ancestor over "Cam 1" and "Cam 10") only ever cycled Cards' OWN group — and
 * Cards owns no photos, so the click was a no-op; the two cameras kept their
 * own independent fold state underneath it. Now:
 *
 *  - plain click  → the whole subtree collapses to ONE aggregate unit
 *    (snapshot strip, then collapsed bar, sampling/rolling up every
 *    descendant), and the per-camera headers disappear — Cards stands for
 *    all of them;
 *  - Shift-click   → VS-Code-style region fold: each camera gets its OWN
 *    strip, Cards stays expanded around them.
 *
 * A sibling top-level folder ("Party") must never react to any of this — it
 * has no descendants, so its own fold icon takes the ordinary single-group
 * path (cycleGroupState) regardless of what's happening to Cards.
 */

const CAM1 = FOLDERS.find((f) => f.name.endsWith("Cam 1"));
const CAM10 = FOLDERS.find((f) => f.name.endsWith("Cam 10"));
const CARDS_TOTAL = itemsIn(CAM1) + itemsIn(CAM10);

test.describe("@p1 subtree fold (#142)", () => {
  test("plain-click cycles the whole Cards subtree as one aggregate unit", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    const cards = group.folderHeader(page, "Cards");
    const party = group.folderHeader(page, "Party"); // clean control, untouched throughout
    await expect(cards).toBeVisible();
    await expect(party).toBeVisible();
    expect(await group.isFolded(party)).toBe(false);

    // Starting point: both cameras expanded, no bands anywhere.
    await expect(group.folderHeaderExact(page, "Cam 1")).toHaveCount(1);
    await expect(group.folderHeaderExact(page, "Cam 10")).toHaveCount(1);
    await expect(group.bands(page)).toHaveCount(0);

    // --- 1st plain click: expanded -> ONE aggregate snapshot strip ----------
    await group.toggle(cards).click();

    // The grid virtualizes PHOTO bands (not headers — those always render, see
    // helpers.js), so the strip only mounts once its row is actually scrolled
    // into view. Cards sits below the fold in a fixture this small.
    await cards.scrollIntoViewIfNeeded();
    await expect(group.bands(page)).toHaveCount(1);
    await expect(group.folderHeaderExact(page, "Cam 1")).toHaveCount(0);
    await expect(group.folderHeaderExact(page, "Cam 10")).toHaveCount(0);
    // The control folder is still a normal, unfolded grid.
    expect(await group.isFolded(party)).toBe(false);
    expect(errors).toEqual([]);

    // --- 2nd plain click: -> ONE collapsed bar, subtree total count --------
    await group.toggle(cards).click();
    await cards.scrollIntoViewIfNeeded();

    await expect(group.bands(page)).toHaveCount(0); // no strip left to render
    expect(await group.isFolded(cards)).toBe(true); // but Cards itself is folded
    await expect.poll(() => group.countOf(cards)).toBe(CARDS_TOTAL);
    await expect(group.folderHeaderExact(page, "Cam 1")).toHaveCount(0);
    await expect(group.folderHeaderExact(page, "Cam 10")).toHaveCount(0);
    expect(errors).toEqual([]);

    // --- 3rd plain click: -> back to expanded -------------------------------
    await group.toggle(cards).click();

    await expect(group.folderHeaderExact(page, "Cam 1")).toHaveCount(1);
    await expect(group.folderHeaderExact(page, "Cam 10")).toHaveCount(1);
    await expect(group.bands(page)).toHaveCount(0);
    expect(await group.isFolded(party)).toBe(false); // never touched

    expect(errors).toEqual([]);
  });

  test("shift-click fans out to one snapshot strip PER camera", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    const cards = group.folderHeader(page, "Cards");
    const party = group.folderHeader(page, "Party");

    await group.toggle(cards).click({ modifiers: ["Shift"] });
    // Bands are virtualized (see the plain-click test); scroll both cameras'
    // rows into view so their strips have actually mounted. The shift-fold
    // rebuilds the feed, so the row can DETACH mid-scroll ("Element is not
    // attached to the DOM" — seen only under CI's slower timing); retry through
    // the rebuild by re-resolving the locator each attempt.
    await expect(async () => {
      await group
        .folderHeaderExact(page, "Cam 10")
        .first()
        .scrollIntoViewIfNeeded();
    }).toPass();

    // Both cameras still have their OWN header, and their own strip — not one
    // aggregated band standing in for both.
    await expect(group.folderHeaderExact(page, "Cam 1")).toHaveCount(1);
    await expect(group.folderHeaderExact(page, "Cam 10")).toHaveCount(1);
    await expect(group.bands(page)).toHaveCount(2);

    const keys = await group
      .bands(page)
      .evaluateAll((els) => els.map((el) => el.dataset.groupKey));
    expect(new Set(keys).size).toBe(2); // two DISTINCT groups, not one repeated

    // The control folder is still an ordinary grid throughout.
    expect(await group.isFolded(party)).toBe(false);

    expect(errors).toEqual([]);
  });
});
