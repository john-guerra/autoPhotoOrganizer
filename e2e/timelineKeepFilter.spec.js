import { test, expect } from "@playwright/test";
import {
  trackPageErrors,
  openApp,
  enrichAll,
  menu,
  statusBar,
  timelineFilter,
  clearScope,
} from "./helpers.js";

/**
 * The toolbar timeline (TimelineFilter.svelte) plots the density/domain of the
 * CURRENT working set — it must narrow the moment "Keep only" scopes the app
 * down to one group, the same way the feed/tree/counts already do (#194).
 *
 * Scoped to the "Party" folder (Feb 20-21 2024, no video): the fixture's OTHER
 * two folders each carry a video whose date comes from file mtime rather than
 * embedded EXIF (see fixture.mjs — the HEVC clip's mtime is pinned to Jan 8
 * 2024, and the unplayable .avi is left at its real build-time mtime). Picking
 * Party keeps the expected before/after ranges deterministic instead of
 * depending on either of those.
 */

/** Right-click a feed section header on its label (mirrors headerMenu.spec.js). */
async function rightClickHeader(page, name) {
  const label = page
    .locator(".section-header", { hasText: name })
    .first()
    .locator(".section-label");
  await label.scrollIntoViewIfNeeded();
  await label.click({ button: "right" });
}

test.describe("@p1 timeline keep-only filter", () => {
  /**
   * The working set is GLOBAL, SERVER-SIDE state, and since #212 it survives a
   * reload by design — the server is the one source of truth and the UI
   * restores it on boot.
   *
   * That turned this file from harmless into a suite-wide hazard. It clicks
   * "Keep only" three times and used to clean up after none of them; before
   * #212 the next `openApp` forgot the scope on its own, so nothing noticed.
   * Afterwards the scope persisted, every later spec ran against a two-photo
   * library, and 36 tests went red across files this one has never heard of —
   * plus its own third test, which is what makes the leak self-evident once
   * you look.
   *
   * Same rule as `clearFaces` for `seedFaces` (docs/AGENT-NOTES.md): a spec
   * that seeds global state cleans it up. `beforeEach` as well as `afterAll`,
   * so a failure part-way through one test cannot leak into the next.
   */
  test.beforeEach(async ({ page }) => await clearScope(page));
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await clearScope(page);
    await page.close();
  });

  test("toolbar timeline narrows to the kept group's date range (#194)", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    // enrichAll BEFORE openApp: taken_at falls back to file mtime (today) until
    // metadata is read, and the feed's first request would otherwise race that
    // read (see enrichAll's doc comment in helpers.js).
    await enrichAll(page);
    await openApp(page, { groupBy: ["folder"] });

    // Full-library domain includes Jan (the HEVC clip's pinned mtime) and today
    // (the .avi's real build-time mtime) — Feb is present but not yet the whole
    // story.
    await expect(timelineFilter.root(page)).toBeVisible();
    const fullRangeTexts = (await timelineFilter.badgeTexts(page)).join("|");
    expect(fullRangeTexts).toMatch(/Jan/);

    // Keep only the "Party" folder's photos (Feb 20-21 2024, no video).
    await rightClickHeader(page, "Party");
    await menu.item(page, "Keep only these photos").click();

    // The working set is now just Party's photos — the timeline must narrow to
    // Feb 2024 and drop both the Jan date (HEVC clip) and today's date (the
    // .avi's real mtime) it was showing before. Not pinning the exact day here:
    // that depends on how the fixture's EXIF timestamp lands in the machine's
    // local timezone (a separate, already-tracked concern — #177), and isn't
    // what this test exists to check.
    await expect(async () => {
      const texts = (await timelineFilter.badgeTexts(page)).join("|");
      expect(texts).not.toMatch(/Jan/);
      expect(texts).not.toMatch(/, 2026/);
      expect(texts).toMatch(/Feb \d+, 2024/);
    }).toPass({ timeout: 5000 });

    expect(errors).toEqual([]);
  });

  test("also narrows via the status-bar Keep only button (select then click, #194)", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await enrichAll(page);
    await openApp(page, { groupBy: ["folder"] });

    await expect(timelineFilter.root(page)).toBeVisible();

    // Select Party's photos via the group menu's "Select all" (not Keep only),
    // then drive the visible status-bar button — the exact toolbar path a user
    // clicks, as opposed to the header's own "Keep only these photos" shortcut.
    await rightClickHeader(page, "Party");
    await menu.item(page, "Select all photos in this group").click();
    await statusBar.keepOnly(page).click();

    await expect(async () => {
      const texts = (await timelineFilter.badgeTexts(page)).join("|");
      expect(texts).not.toMatch(/Jan/);
      expect(texts).not.toMatch(/, 2026/);
      expect(texts).toMatch(/Feb \d+, 2024/);
    }).toPass({ timeout: 5000 });

    expect(errors).toEqual([]);
  });

  test("keep only a selection made BEFORE brushing the timeline away from it (#194)", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await enrichAll(page);
    await openApp(page, { groupBy: ["folder"] });

    // Select Trip's photos (Jan 10-11 2024) while the whole library is in view.
    await page.keyboard.press("Meta+a");
    await expect(statusBar.root(page)).toContainText(/selected/);

    // Now brush the timeline's LOWER bound out to March — well past Trip's own
    // dates. `selectedIds` is independent of what the filter currently shows,
    // so the selection survives even though Trip has now scrolled out of the
    // (filtered) feed entirely. This is the ordinary "filter around while you
    // still have something selected" flow, not a contrived edge case.
    const loBadge = page.locator(".time-filter .za-value").nth(0);
    await loBadge.dblclick();
    const loInput = loBadge.locator("input");
    await expect(loInput).toBeVisible();
    await loInput.fill("2024-03-01T00:00");
    await expect(timelineFilter.root(page)).toContainText("Mar 1, 2024");

    // Keep only the earlier (Jan) selection while the stale Mar brush is live.
    await statusBar.keepOnly(page).click();

    // The kept scope is Trip (Jan 2024) — the timeline must show Jan, not
    // stay stuck on the stale "Mar 1, 2024" lower bound, and the feed must not
    // silently end up empty because the old dateFrom outlives the new scope.
    await expect(async () => {
      const showing = await statusBar.showingCount(page);
      expect(showing).toBeGreaterThan(0);
    }).toPass({ timeout: 5000 });

    await expect(async () => {
      const texts = (await timelineFilter.badgeTexts(page)).join("|");
      expect(texts).not.toMatch(/Mar/);
      expect(texts).toMatch(/Jan/);
    }).toPass({ timeout: 5000 });

    expect(errors).toEqual([]);
  });
});
