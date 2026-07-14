import { test, expect } from "@playwright/test";
import { loupe as loupeHelper, openApp, statusBar } from "./helpers.js";

/**
 * These cover the interactions that actually regressed during the 2.9.x usability
 * batch. Each one maps to a real bug that shipped:
 *
 *  - "cycles a group ... without throwing"  -> 2.9.24 (collapse threw TypeError:
 *    _collapsedKeys.has is not a function — a Set/Array mixup no unit test saw)
 *  - "hovering a header does not resize it" -> 2.9.19 (a mangled CSS selector list
 *    gave the action buttons padding:4rem; the header grew 31px -> 155px)
 *  - "the toggle icon stays icon-sized"     -> 2.9.18 (renderer id "grid" collided
 *    with the .grid photo-container rule and flex-grew the button to 1193px)
 *  - "a folded group keeps its own header"  -> 2.9.18 (the group's header used to
 *    be deleted and replaced by a row with a duplicate label)
 *  - "clicking a tile's circle selects"     -> 2.9.3 (must NOT open the loupe)
 *
 * The assertions are deliberately about OBSERVABLE behaviour, not internals.
 */

/** Fail a test if the page logged an uncaught error — the class of bug that kept
 *  reaching users while 619 green unit tests said nothing. */
function trackPageErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message ?? e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

async function gotoFeed(page) {
  // A clean slate: no carried-over selection/collapse/sort from a previous spec.
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await expect(page.locator(".section-header").first()).toBeVisible();
  // Let the first thumbnails settle so layout numbers are stable.
  await page.waitForTimeout(500);
}

test("loads the library and renders group headers", async ({ page }) => {
  const errors = trackPageErrors(page);
  await gotoFeed(page);

  await expect(page.locator(".section-header")).not.toHaveCount(0);
  await expect(page.locator(".thumb").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("cycles a group grid -> snapshot -> collapsed -> grid without throwing", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await gotoFeed(page);

  const header = page.locator(".section-header").last();
  const icon = header.locator(".section-toggle-icon");

  // The feed is VIRTUALIZED: a group below the fold has no band in the DOM, so
  // the band assertions below would read 0 whatever the click did. This spec used
  // to pass only because the fixture happened to fit on one screen — it doesn't
  // any more, and "it fits" was never what this test is about.
  await header.scrollIntoViewIfNeeded();

  // grid: no band, icon not amber
  await expect(page.locator(".group-band")).toHaveCount(0);
  await expect(icon).not.toHaveClass(/not-grid/);

  // -> snapshot: exactly one band appears, icon goes amber
  await icon.click();
  await expect(page.locator(".group-band")).toHaveCount(1);
  await expect(icon).toHaveClass(/not-grid/);

  // -> collapsed: band goes away, but the HEADER REMAINS (invariant 1 of the
  // group-renderers contract: a group always has exactly one label)
  await icon.click();
  await expect(page.locator(".group-band")).toHaveCount(0);
  await expect(header).toBeVisible();
  await expect(icon).toHaveClass(/not-grid/);

  // -> back to grid
  await icon.click();
  await expect(icon).not.toHaveClass(/not-grid/);

  expect(errors).toEqual([]);
});

test("hovering a header reveals its actions without resizing it", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await gotoFeed(page);

  const header = page.locator(".section-header").last();
  const before = await header.boundingBox();

  await header.hover();
  await expect(
    header.getByRole("button", { name: /keep only/i })
  ).toBeVisible();

  const after = await header.boundingBox();
  // 2.9.19: this grew 31 -> 155px and shoved the photos down.
  expect(Math.round(after.height)).toBe(Math.round(before.height));

  expect(errors).toEqual([]);
});

test("the group toggle stays icon-sized (no CSS class collision)", async ({
  page,
}) => {
  await gotoFeed(page);
  const icon = page.locator(".section-toggle-icon").first();
  const box = await icon.boundingBox();
  // 2.9.18: the "grid" renderer id collided with the .grid container rule and
  // flex-grew this button to ~1193px, shoving the label off to the right.
  expect(box.width).toBeLessThan(60);
});

test("a single click on the FIRST tile focuses it — it does not open the loupe (#104)", async ({
  page,
}) => {
  // `selected` starts at 0 so the keyboard has an anchor, and clicking an
  // ALREADY-focused tile opens the loupe — which used to mean one click on photo
  // #1 jumped straight into the loupe, while every other tile needed two. Worse:
  // rating auto-advances in the loupe, so a user who landed there by accident
  // rated a different photo with every keystroke.
  const errors = trackPageErrors(page);
  await gotoFeed(page);

  const tile = page.locator(".thumb").first();
  await tile.click();
  await expect(page.locator(".loupe")).toHaveCount(0); // focused, not opened

  await tile.click(); // now it IS explicitly focused, so this opens it
  await expect(page.locator(".loupe")).toBeVisible();

  expect(errors).toEqual([]);
});

test("clicking a tile's circle selects it and does NOT open the loupe", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await gotoFeed(page);

  const tile = page.locator(".thumb").first();
  await tile.hover();
  await tile.locator(".select-circle").click();

  await expect(page.locator(".statusbar")).toContainText(/1 selected/);
  // The loupe must not have opened — that was the whole point of the circle.
  await expect(page.locator(".loupe")).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("the loupe opens on a tile click and closes with its ✕", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await gotoFeed(page);

  // Via the helper: a click opens the loupe on an ALREADY-focused tile, and the
  // first tile is focused by default — so a blind double-click would open the
  // loupe and then click straight into it.
  await loupeHelper.open(page, 0);

  const loupe = page.locator(".loupe");
  await loupe.locator(".loupe-close").click();
  await expect(loupe).toHaveCount(0);

  expect(errors).toEqual([]);
});

test.describe("@p1 loupe filmstrip", () => {
  test("reuses the grid's cached thumbnails instead of a cold 64px size (#90 again)", async ({
    page,
  }) => {
    // The thumb cache is keyed by exact pixel size. The filmstrip used to ask for
    // `size=64` — a size no other view requests — so opening the loupe generated
    // up to 81 brand-new thumbnails at the exact moment the user was waiting for
    // the full-size photo and its ±3 prefetch. Issue #90 was this same mistake in
    // the snapshot strip; the fix there (follow the grid's bucket) is the fix here.
    const errors = trackPageErrors(page);
    await openApp(page);

    const thumbRequests = [];
    page.on("request", (r) => {
      const u = new URL(r.url(), "http://localhost");
      if (u.pathname.startsWith("/api/thumb/")) {
        thumbRequests.push(Number(u.searchParams.get("size")));
      }
    });

    await loupeHelper.open(page, 0);
    await expect(loupeHelper.filmstripImgs(page).first()).toBeVisible();

    const src = await loupeHelper
      .filmstripImgs(page)
      .first()
      .getAttribute("src");
    const size = Number(
      new URL(src, "http://localhost").searchParams.get("size")
    );

    // A real grid bucket, not the bespoke 64 nothing else populates.
    expect([160, 320, 480, 640, 1024]).toContain(size);
    expect(thumbRequests.some((s) => s === 64)).toBe(false);

    expect(errors).toEqual([]);
  });
});

test.describe("@p1 search", () => {
  test("narrows the feed by folder name, and clears back", async ({ page }) => {
    // A filter facet only works if ALL THREE layers agree: the client spec, the
    // SQL, and the API's allowlist — a facet missing from the allowlist is
    // silently dropped and the app just shows everything, cheerfully.
    const errors = trackPageErrors(page);
    await openApp(page);

    // The status bar's "showing" count is the working set. The grid is
    // VIRTUALIZED, so counting rendered tiles or headers would measure the
    // viewport instead — and pass or fail on where the feed happened to scroll.
    const allPhotos = await statusBar.showingCount(page);
    expect(allPhotos).toBeGreaterThan(1);

    // "/" is the shortcut; typing goes to the box it focuses.
    await page.keyboard.press("/");
    await page.keyboard.type("Party");

    // The feed is now only the Party folder — matched on its FOLDER, not on any
    // filename (no photo is called "party"). Fewer photos, and every group left
    // standing is that folder.
    await expect
      .poll(() => statusBar.showingCount(page))
      .toBeLessThan(allPhotos);
    await expect(page.locator(".section-header")).toHaveCount(1);
    await expect(page.locator(".section-header").first()).toContainText(
      "Party"
    );

    // ...and the caret is STILL in the search box. Every feed reload ends by
    // refocusing the selected tile, and a keystroke here IS a feed reload: the
    // refocus used to fire mid-word and hand the rest of your query to the grid,
    // where a digit rates the focused photo. Searching "2024" would have put two
    // stars on someone's photo.
    await expect(page.locator(".search-input")).toBeFocused();

    // Esc clears it and the whole library comes back.
    await page.keyboard.press("Escape");
    await expect.poll(() => statusBar.showingCount(page)).toBe(allPhotos);
    await expect(page.locator(".search-input")).toHaveValue("");

    expect(errors).toEqual([]);
  });

  test("a search that lands while the library is STILL LOADING still filters the grid", async ({
    page,
  }) => {
    // Reported as "it says 1 showing and the grid is empty". The status bar had
    // the right number and the grid had the wrong photos — or none.
    //
    // `displayFilter` is a `$:` derived value, so it does not exist yet in the
    // handler that sets `filter`: Svelte recomputes it at the end of the tick. A
    // feed rebuild started in that same handler therefore fetched with the
    // PREVIOUS filter. Most rebuilds fetch twice (a seek before and after the
    // focused photo) and the second fetch — after an await, so post-flush — quietly
    // corrected it. The path with NO focused photo fetches once, and that one lost:
    // the window was replaced with the whole unfiltered library.
    //
    // No focused photo is exactly what "the first load hasn't landed yet" means, so
    // this only bit a search typed into a library still loading — a 17-photo fixture
    // loads too fast to ever be in that state. Holding the first feed response is
    // what puts the app in it, deterministically, on any machine.
    const errors = trackPageErrors(page);

    let held = 0;
    await page.route("**/api/feed*", async (route) => {
      if (held++ === 0) await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });

    await page.addInitScript(() => window.localStorage.clear());
    await page.goto("/");

    // Type into the search box the moment it exists — while the feed is still out.
    await page.locator(".search-input").fill("Party");

    // The grid must show the Party folder and NOTHING else. Before the fix this
    // rendered the entire library (every folder), while the count said otherwise.
    await expect(page.locator(".section-header")).toHaveCount(1, {
      timeout: 15000,
    });
    await expect(page.locator(".section-header").first()).toContainText(
      "Party"
    );

    // And the two numbers agree: what the status bar counts is what you can see.
    const showing = await statusBar.showingCount(page);
    const rendered = await page.locator(".thumb").count();
    expect(rendered).toBe(showing);

    expect(errors).toEqual([]);
  });
});
