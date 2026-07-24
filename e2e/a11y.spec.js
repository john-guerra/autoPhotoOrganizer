import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, tree, menu, statusBar } from "./helpers.js";

/**
 * The status bar's "never fail silently" messages must reach ASSISTIVE TECH, not
 * only sighted users. The app funnels almost every transient message ("Path
 * copied", "Select all failed", "Removed N — Undo", "Reading metadata…") through
 * one status/error line. Before the a11y fix that line was a plain <span> with no
 * live-region semantics — grep found ZERO aria-live in the whole ui/src tree — so
 * a screen-reader user could trigger a failing action and hear nothing at all.
 *
 * This is an e2e test on purpose: the defect lives in the DOM/ARIA wiring, and no
 * unit test can see whether a RENDERED region is actually a live region.
 */

// A real leaf folder in the shared fixture (see tree-menu.spec.js), so its
// right-click menu offers "Copy path".
const REAL_LEAF = "Cam 10";

const polite = (page) =>
  statusBar.root(page).locator('[role="status"][aria-live="polite"]');
const assertive = (page) =>
  statusBar.root(page).locator('[role="alert"][aria-live="assertive"]');

test.describe("@p1 status-bar accessibility", () => {
  test("exposes persistent live regions for status and errors", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    // A polite region for ordinary status, an assertive one for errors — both in
    // the DOM on load (empty), so a later change is ANNOUNCED rather than missed
    // the way a freshly-inserted region often is.
    await expect(polite(page)).toHaveCount(1);
    await expect(assertive(page)).toHaveCount(1);
    // Attached, not display:none — display:none would mute the region for screen
    // readers, which is the whole point of keeping it.
    await expect(polite(page)).toBeAttached();
    await expect(assertive(page)).toBeAttached();

    expect(errors).toEqual([]);
  });

  test("a triggered message is announced through a live region", async ({
    page,
    context,
  }) => {
    const errors = trackPageErrors(page);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openApp(page, { groupBy: ["folder"] });

    // "Copy path" sets status="Path copied" (or, if the clipboard rejects, an
    // error). The behaviour under test is that the message REACHES the live
    // region — the clipboard itself is incidental.
    await tree.node(page, REAL_LEAF).click({ button: "right" });
    await menu.item(page, "Copy path").click();

    // With clipboard permission granted on a localhost (secure) context the happy
    // path fires, so the polite region carries the success message.
    await expect(polite(page)).toHaveText("Path copied");

    expect(errors).toEqual([]);
  });
});
