import { expect } from "@playwright/test";

/**
 * Shared page objects for the UI tests.
 *
 * Specs should read as BEHAVIOUR ("rate the focused photo 3, reload, it's still
 * 3"), not as selectors. Keeping every selector in this one file means a markup
 * change is a one-line fix here instead of a hunt through every spec — and the
 * CSS classes are exactly what kept breaking during the 2.9.x batch.
 */

/**
 * Fail the test if the page logged an uncaught error.
 *
 * This single assertion would have caught three of the five bugs that shipped to
 * a user in the 2.9.x round while 619 unit tests stayed green. Call it in EVERY
 * spec; it costs nothing.
 */
export function trackPageErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message ?? e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

/**
 * Load the app with no carried-over state from a previous spec.
 *
 * `groupBy` seeds the grouping dimensions (e.g. `["folder", "day"]` for a nested
 * feed) via the same localStorage key the app reads on boot. Seeding beats
 * driving the Group-by combobox: that's a third-party widget, so a spec about
 * *folding* would otherwise break whenever the widget's markup changed — a test
 * should fail for the thing it actually tests.
 */
export async function openApp(page, { groupBy } = {}) {
  await page.addInitScript((dims) => {
    window.localStorage.clear();
    if (dims) {
      window.localStorage.setItem("autogallery.groupBy", JSON.stringify(dims));
    }
  }, groupBy);
  await page.goto("/");
  await expect(page.locator(".section-header").first()).toBeVisible();
  await expect(page.locator(".thumb").first()).toBeVisible();
  // Let the first thumbnails settle so geometry assertions are stable.
  await page.waitForTimeout(400);
}

/**
 * Wipe every rating in the e2e database.
 *
 * Ratings live in SQLite, on purpose — that's the whole point of the culling
 * tests, and it's what makes them meaningful. But it also means they are GLOBAL
 * state that outlives a spec: without this, a photo rated 3 by the first test is
 * still rated 3 when a later test asserts it's unrated, and you get a failure
 * that looks like a product bug and isn't. Call it in beforeEach for any spec
 * that writes ratings.
 *
 * Safe by construction: playwright.config.js points AUTOGALLERY_HOME at
 * e2e/.tmp/home over generated fixture photos, so this can never reach a real
 * library.
 */
export async function resetRatings(page) {
  const res = await page.request.get("/api/photos/ids");
  const { ids = [] } = await res.json();
  for (const id of ids) {
    await page.request.post("/api/rating", { data: { id, rating: 0 } });
  }
}

/** Reload WITHOUT clearing storage — for "does it persist?" assertions. */
export async function reload(page) {
  await page.reload();
  await expect(page.locator(".thumb").first()).toBeVisible();
  await page.waitForTimeout(400);
}

// --- the grid ---------------------------------------------------------------

export const grid = {
  tile: (page, i = 0) => page.locator(".thumb").nth(i),
  tileCount: (page) => page.locator(".thumb").count(),
  /** The star badge on a tile; absent entirely when unrated.
   *  Keyed on the accessible label ("3 stars"), not on .badge — Thumb wraps a
   *  .badge span around Stars, which renders its own .badge, so that class
   *  matches twice. Asserting on the label is both unambiguous and the thing a
   *  screen-reader user actually gets. */
  ratingBadge: (page, i = 0) =>
    page.locator(".thumb").nth(i).locator('[aria-label*="star"]'),
  selectCircle: (page, i = 0) =>
    page.locator(".thumb").nth(i).locator(".select-circle"),
  /**
   * Leave tile `i` focused in the GRID, with the loupe closed.
   *
   * Clicking a tile that is ALREADY focused opens the loupe (App.svelte's
   * `selected === i ? openLoupe(i) : selected = i`), and `selected` defaults to
   * 0 — so a plain click on the first tile opens the loupe on a fresh load. If a
   * spec doesn't notice, it ends up typing into the loupe, where rating
   * auto-advances, and every keystroke silently lands on the NEXT photo.
   */
  focus: async (page, i = 0) => {
    await page.locator(".thumb").nth(i).click();
    const lp = page.locator(".loupe");
    if (await lp.isVisible().catch(() => false)) {
      await page.keyboard.press("Escape");
      await expect(lp).toHaveCount(0);
    }
  },
};

// --- the status bar (counts + selection actions) -----------------------------

export const statusBar = {
  root: (page) => page.locator(".statusbar"),
  selectedCount: async (page) => {
    const text = await page.locator(".statusbar .counts").innerText();
    const m = text.match(/([\d,]+)\s+selected/);
    return m ? Number(m[1].replace(/,/g, "")) : 0;
  },
  clear: (page) => page.locator(".statusbar .sel-btn", { hasText: /^Clear$/ }),
  keepOnly: (page) =>
    page.locator(".statusbar .sel-btn", { hasText: /^Keep only$/ }),
  exportBtn: (page) => page.locator(".statusbar .sel-btn.export"),
  /** ⌘A is a two-step (2.10.10): the first press takes the group you're in, the
   * second ASKS before taking everything shown. This is the "yes" — in the status
   * bar, deliberately not a modal. */
  confirmSelectAll: (page) =>
    page.locator(".statusbar button", { hasText: /^Select all$/ }),
};

// --- the loupe --------------------------------------------------------------

export const loupe = {
  root: (page) => page.locator(".loupe"),
  close: (page) => page.locator(".loupe .loupe-close"),
  selectCircle: (page) => page.locator(".loupe .loupe-select"),
  /** The interactive 5-star row in the details panel. */
  star: (page, n) => page.locator(".loupe .star-btn").nth(n - 1),
  filename: (page) => page.locator(".loupe .name"),
  /**
   * Open the loupe on a tile.
   *
   * A click focuses an unfocused tile and opens the loupe on an already-focused
   * one — so this needs one click or two depending on where `selected` happens
   * to be (it starts at 0). Check between clicks rather than blindly clicking
   * twice: on the first tile, the second click would land on the open loupe.
   */
  open: async (page, i = 0) => {
    const tile = grid.tile(page, i);
    const lp = page.locator(".loupe");
    await tile.click();
    if (!(await lp.isVisible().catch(() => false))) await tile.click();
    await expect(lp).toBeVisible();
  },
};

// --- groups (feed headers) --------------------------------------------------

export const group = {
  header: (page, i = 0) => page.locator(".section-header").nth(i),
  lastHeader: (page) => page.locator(".section-header").last(),
  toggle: (header) => header.locator(".section-toggle-icon"),
  bands: (page) => page.locator(".group-band"),
  /** "amber" = this group is not showing its photos in full. */
  isFolded: async (header) =>
    (
      await header.locator(".section-toggle-icon").getAttribute("class")
    ).includes("not-grid"),
};

// --- the tree sidebar -------------------------------------------------------

export const tree = {
  root: (page) => page.locator(".tree-sidebar"),
  node: (page, name) =>
    page.locator(".tree-node-row", { hasText: name }).first(),
  label: (page, name) =>
    page
      .locator(".tree-node-row", { hasText: name })
      .first()
      .locator(".tree-label"),
  expandAll: (page) => page.locator(".tree-action", { hasText: "Expand all" }),
  collapseAll: (page) =>
    page.locator(".tree-action", { hasText: "Collapse all" }),
};
