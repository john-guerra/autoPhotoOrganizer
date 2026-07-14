import { test, expect } from "@playwright/test";
import {
  openApp,
  trackPageErrors,
  grid,
  loupe,
  video,
  jobs,
  tree,
  menu,
} from "./helpers.js";
import { VIDEO } from "./fixture.mjs";

/**
 * Background jobs must not get between the user and their photos.
 *
 * The report: "the notifications for instance for loading videos start
 * accumulating and occluding the photos". Both halves of that are real, and they
 * have different causes, so they need different tests:
 *
 *  - ACCUMULATING. Nothing ever removed a finished transcode row. Play three
 *    videos, keep three "Converting…" notices forever. A successful transcode now
 *    clears its own row (server-side; see SELF_CLEARING), which is what the first
 *    test checks — end to end, because the only proof that matters is that the row
 *    is gone after a real conversion.
 *  - OCCLUDING. The panel was an in-flow strip up to 40vh tall, so the grid
 *    genuinely shrank to make room for the notices. The second test measures the
 *    grid: a finished job must cost it nothing.
 *
 * And what's left has to be dismissible in one go, which is the third.
 */

// The fixture's "Cam 10" is a real folder in the index, so it can be rescanned —
// and a scan job, unlike a transcode, is one whose result the user wants to keep
// and dismiss for themselves. That makes it the way to get a durable row.
const REAL_LEAF = "Cam 10";

/** Rescan a folder from the tree's menu and wait for the job to finish. */
async function rescanAndSettle(page) {
  await tree.node(page, REAL_LEAF).click({ button: "right" });
  await menu.item(page, "Rescan this folder").click();
  await expect(jobs.pill(page)).toBeVisible();
  // Settled = the pill has stopped saying "running". Waiting on the pill's own
  // text (not a timeout) means this tracks the job, not the clock.
  await expect(jobs.pill(page)).not.toHaveClass(/busy/, { timeout: 30000 });
}

test.describe("@p1 background jobs", () => {
  test("a converted video leaves no notice behind", async ({ page }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: "folder" });

    // Convert one for real: the AVI Chromium cannot decode.
    const index = await grid.tileMatching(page, (n) => n.includes(VIDEO.name));
    await loupe.open(page, index);
    await expect(video.player(page)).toBeVisible({ timeout: 60000 });
    await expect
      .poll(() => video.player(page).evaluate((v) => v.videoWidth), {
        timeout: 30000,
        message: "the converted video should decode frames",
      })
      .toBeGreaterThan(0);
    await loupe.close(page).click();

    // The video played, so the job succeeded, so there is nothing left to say —
    // and its row is gone. (The widget itself stays: the startup scan leaves a
    // row of its own, which is exactly the kind of job that SHOULD wait to be
    // read. Asserting the widget is empty would be asserting the wrong thing.)
    //
    // The retry matters: the loupe converts the NEXT clip before you reach it, so
    // a second transcode is usually still running when this one finishes. Wait
    // for the conversions to drain, then check that none of them left a notice.
    await expect
      .poll(
        async () => {
          if (!(await jobs.widget(page).count())) return 0;
          const labels = await jobs.pill(page).innerText();
          if (/Converting/.test(labels)) return 1; // still working
          await jobs.pill(page).click();
          const rows = await jobs.rows(page).allInnerTexts();
          await jobs.pill(page).click();
          return rows.filter((t) => /Converting/.test(t)).length;
        },
        {
          timeout: 60000,
          message: "a finished conversion should leave no row behind",
        }
      )
      .toBe(0);

    expect(errors).toEqual([]);
  });

  test("a finished job costs the grid no height", async ({ page }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    const gridHeight = () =>
      page.locator(".main-column").evaluate((el) => el.clientHeight);
    const before = await gridHeight();

    await rescanAndSettle(page);
    await expect(jobs.pill(page)).toBeVisible(); // a scan row PERSISTS: it has news

    // This is the occlusion complaint, measured. The old panel was an in-flow
    // strip (flex-shrink: 0, up to 40vh), so every row it held came straight out
    // of the grid's height — the photos were pushed off screen by the notices
    // about the photos. The widget is in the status bar now and costs nothing.
    expect(await gridHeight()).toBe(before);

    expect(errors).toEqual([]);
  });

  test("Dismiss all clears the finished rows in one go", async ({ page }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    await rescanAndSettle(page);

    const rows = await jobs.open(page);
    const scanRows = rows.filter({ hasText: /Scan/ });
    expect(await scanRows.count()).toBeGreaterThan(0);

    await jobs.dismissAll(page).click();

    // Every finished row is gone in one click. Deliberately NOT "the widget is
    // gone": a scan kicks off a metadata read behind it, and a job that is still
    // RUNNING must survive a dismiss — "Dismiss all" is not "Cancel all", and
    // silently killing work the user started would be the worse surprise.
    await expect(scanRows).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});
