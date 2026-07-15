import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, statusBar } from "./helpers.js";
import { FOLDERS, TOTAL_PHOTOS, itemsIn } from "./fixture.mjs";

/**
 * P1 — SELECTION. Select-all, clear, and undo. The selection is what every
 * destructive-ish action (export, move, keep-only) operates on, so losing it —
 * or being unable to take a clear back — costs the user real work.
 */

test.describe("@p1 selection", () => {
  test("⌘A selects the whole library, and it doesn't freeze the UI (#97)", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);

    // ⌘A is a two-step (2.10.10): the first press takes the group you're in, and
    // says so; a second press escalates to the whole working set. Asserting only
    // the end state would let the confirmation step vanish unnoticed.
    await page.keyboard.press("Meta+a");
    await expect(statusBar.root(page)).toContainText(
      new RegExp(`${itemsIn(FOLDERS[0])} selected`)
    );
    await expect(statusBar.root(page)).toContainText(/again for all/);

    // The second press ASKS rather than acting — taking the whole library is not
    // something a stray keystroke should do.
    await page.keyboard.press("Meta+a");
    await statusBar.confirmSelectAll(page).click();

    // The whole working set, not just the loaded feed window.
    await expect(statusBar.root(page)).toContainText(
      new RegExp(`${TOTAL_PHOTOS} selected`)
    );

    // Still responsive: a long block here is the #97 stall regressing.
    const t0 = Date.now();
    await page.locator(".thumb").first().hover();
    expect(Date.now() - t0).toBeLessThan(2000);

    expect(errors).toEqual([]);
  });

  test("Clear empties the selection without a blocking modal, and Undo restores it (#97)", async ({
    page,
  }) => {
    // clearSelection() used to pop a native confirm(), which freezes the UI
    // thread — for an action that was ALREADY undoable. If the modal ever comes
    // back, this test hangs on the click and fails, which is exactly right.
    const errors = trackPageErrors(page);
    await openApp(page);

    await page.keyboard.press("Meta+a");
    await page.keyboard.press("Meta+a"); // escalate...
    await statusBar.confirmSelectAll(page).click(); // ...and confirm
    await expect(statusBar.root(page)).toContainText(
      new RegExp(`${TOTAL_PHOTOS} selected`)
    );

    await statusBar.clear(page).click();
    await expect(statusBar.root(page)).toContainText(/0 selected/);

    // The clear is recoverable — that's what earns the right to skip the modal.
    const undo = page.locator(".sel-btn", { hasText: /^Undo$/ });
    await expect(undo).toBeVisible();
    await undo.click();
    await expect(statusBar.root(page)).toContainText(
      new RegExp(`${TOTAL_PHOTOS} selected`)
    );

    expect(errors).toEqual([]);
  });

  test("the Export panel opens fully above the feed, not clipped by the status bar", async ({
    page,
  }) => {
    // Regression: a status-bar overflow:hidden (added to stop a long message
    // widening the app) clipped the Export popover — an absolutely-positioned
    // child lifted up over the feed — to the thin status-bar row, so it vanished.
    // A clipped element keeps its layout box (so toBeVisible / toBeInViewport /
    // getBoundingClientRect all still pass), which is why this hit-tests with
    // elementFromPoint: that DOES respect ancestor overflow-clipping, so a clipped
    // panel returns the feed element painted behind it, not the panel.
    const errors = trackPageErrors(page);
    await openApp(page);

    await page.keyboard.press("Meta+a"); // select the current group → Export shows
    const exportBtn = statusBar.exportBtn(page);
    await expect(exportBtn).toBeVisible();
    await exportBtn.click();

    const panel = page.locator(".export-panel");
    await expect(panel).toBeVisible();

    // The panel must actually be PAINTED where it sits — hit-test its centre.
    const panelOnTop = await page.evaluate(() => {
      const p = document.querySelector(".export-panel");
      if (!p) return false;
      const r = p.getBoundingClientRect();
      const el = document.elementFromPoint(
        Math.round(r.left + r.width / 2),
        Math.round(r.top + r.height / 2)
      );
      return !!el && p.contains(el);
    });
    expect(panelOnTop).toBe(true);

    expect(errors).toEqual([]);
  });
});
