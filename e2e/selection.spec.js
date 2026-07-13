import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, statusBar } from "./helpers.js";
import { FOLDERS, TOTAL_PHOTOS } from "./fixture.mjs";

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
      new RegExp(`${FOLDERS[0].count} selected`)
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
});
