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
  // The browser's own console message for a failed request is "Failed to load
  // resource: the server responded with a status of 500" — and it does NOT say
  // WHICH resource. A CI-only flake reported that way is undebuggable: you get a
  // red build and no thread to pull. Name the request.
  page.on("response", (r) => {
    if (r.status() >= 500) {
      errors.push(`HTTP ${r.status()} from ${new URL(r.url()).pathname}`);
    }
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

/**
 * Force the metadata sweep to completion — EXIF, dimensions, and (#154)
 * GPS/place — and wait for it to finish before looking at anything
 * metadata-derived.
 *
 * Needed because enrichment is otherwise LAZY (see server/db/enrich.js):
 * the grid only reads metadata for the ids it actually renders, via
 * `/api/meta`, AFTER the initial `/api/feed` request that decided the
 * groups. A dimension with a filesystem-timestamp fallback (day/month, via
 * COALESCE(taken_at, btime, mtime)) happens to look right anyway; place has
 * no such fallback — `COALESCE(photos.place_country, '')` — so a spec that
 * groups by country right after `openApp` races that lazy read and sees
 * every photo under "Unknown" until something re-fetches the feed. Call
 * this BEFORE `openApp` in any spec that groups/filters by place.
 */
export async function enrichAll(page) {
  await page.request.post("/api/enrich", { data: {} });
  await expect
    .poll(
      async () => {
        const res = await page.request.get("/api/enrich/pending");
        return (await res.json()).pending;
      },
      { timeout: 20_000 }
    )
    .toBe(0);
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
  /**
   * Index of the first tile whose filename satisfies `pred`. The feed's order
   * depends on dates, so no spec should assume a tile is at a fixed position.
   *
   * SCROLLS, because the grid is virtualized: a tile below the fold has no DOM
   * node at all, so scanning what is rendered right now only ever searches the
   * first screenful. (One spec's first video happened to sit inside it; the
   * second one didn't, and "no tile matched" in a 19-photo library is what that
   * looks like.)
   */
  tileMatching: async (page, pred) => {
    const tiles = page.locator(".thumb");
    // The feed scrolls the COLUMN, not the grid — scrolling `.grid` is a silent
    // no-op that leaves you re-reading the same first screenful forever.
    const scroller = page.locator(".main-column");
    let lastTop = -1;
    for (;;) {
      const names = await tiles.evaluateAll((els) =>
        els.map((e) => e.getAttribute("title") ?? "")
      );
      const hit = names.findIndex(pred);
      if (hit !== -1) return hit;

      const top = await scroller.evaluate((el) => {
        el.scrollTop += el.clientHeight;
        return el.scrollTop;
      });
      if (top === lastTop)
        throw new Error("no tile matched (searched the feed)");
      lastTop = top;
      // Let the virtual window re-render before looking again — two frames, not
      // a sleep: the grid renders on rAF, so this waits for exactly the thing we
      // need and no longer.
      await page.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r))
          )
      );
    }
  },
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

// --- the view registry (#155) ------------------------------------------------

export const views = {
  /** A view's switcher button, by registry id. Every registered view except
   *  the default gets one, rendered from the registry itself. */
  switchBtn: (page, id) => page.locator(`[data-testid="view-switch-${id}"]`),
  /** The grid view's root. Unchanged through the #155 extraction on purpose —
   *  a spec needing a new selector would have meant behaviour changed. */
  grid: (page) => page.locator("#feed-grid"),
  /** Cycle to the next registered view with the keyboard (V). */
  cycle: (page) => page.keyboard.press("v"),
};

// --- the status bar (counts + selection actions) -----------------------------

export const statusBar = {
  root: (page) => page.locator(".statusbar"),
  selectedCount: async (page) => {
    const text = await page.locator(".statusbar .counts").innerText();
    const m = text.match(/([\d,]+)\s+selected/);
    return m ? Number(m[1].replace(/,/g, "")) : 0;
  },
  /** How many photos the current filters leave in play. THE number to assert a
   *  filter against: the grid is virtualized, so counting rendered `.thumb`s (or
   *  `.section-header`s) measures the viewport, not the working set. */
  showingCount: async (page) => {
    const text = await page.locator(".statusbar .counts").innerText();
    const m = text.match(/([\d,]+)\s+showing/);
    return m ? Number(m[1].replace(/,/g, "")) : null;
  },
  /** The transient line, but only when it is carrying a FAILURE (`.err`) — so a
   *  spec can't accidentally pass on an ordinary "loading…" status. */
  error: (page) => page.locator(".statusbar .status.err"),
  /** The PERSISTENT line — a confirmation that has to outlive the next
   *  background fetch (a scan result, a Find-duplicates answer). Deliberately
   *  distinct from `.status`, which every feed load overwrites. */
  notice: (page) => page.locator(".statusbar .notice"),
  /** The transient line, whatever it currently says. */
  status: (page) => page.locator(".statusbar .status"),
  clear: (page) => page.locator(".statusbar .sel-btn", { hasText: /^Clear$/ }),
  keepOnly: (page) =>
    page.locator(".statusbar .sel-btn", { hasText: /^Keep only$/ }),
  exportBtn: (page) => page.locator(".statusbar .sel-btn.export"),
  /** ⌘A is a two-step (2.10.10): the first press takes the group you're in, the
   * second ASKS before taking everything shown. This is the "yes" — now in a
   * modal dialog (the status-bar prompt was too easy to miss). */
  confirmSelectAll: (page) =>
    page.locator("dialog.modal button", { hasText: /^Select all$/ }),
  /** The scope ("keep only" / folder) chip — it lives next to the counts it
   * explains, not up in the toolbar. */
  scopeChip: (page) => page.locator(".statusbar .scope-chip"),
};

// --- the toolbar (labelled groups) -------------------------------------------

export const toolbar = {
  /** A group by its LABEL — what the user reads — rather than by whichever class
   * the markup happens to use this week. */
  group: (page, label) =>
    page
      .locator(".tool-group")
      .filter({ has: page.locator("legend", { hasText: label }) })
      .first(),
  /** Every group label, in toolbar order. textContent, not innerText: the legend
   * is uppercased with `text-transform`, and innerText returns the RENDERED text —
   * so a spec written against it would be asserting the CSS, and would break the
   * day someone changed the casing. */
  groupLabels: (page) =>
    page
      .locator(".tool-group > legend")
      .evaluateAll((els) => els.map((e) => e.textContent.trim())),
  /** The label of the last group in `rowSelector` — for "Sort is hard right". */
  lastGroupOf: async (page, rowSelector) =>
    (
      await page
        .locator(`${rowSelector} .tool-group > legend`)
        .last()
        .innerText()
    ).trim(),
  /** The ＋ menu button: add a folder, or manage the library. */
  plus: (page) => page.locator(".topbar .add-toggle"),
  /** An item in the ＋ menu. (Not `menu.item` — that one is scoped to the tree's
   * .context-menu, which this is not.) */
  menuItem: (page, label) =>
    page
      .locator(".source-menu")
      .getByRole("menuitem", { name: label, exact: true }),
  /** The button a group folds into when the row runs out of width. Absent while
   * the group is still in the toolbar. */
  foldTrigger: (page, label) =>
    page.locator(".tg-trigger").filter({ hasText: label }),
  /** Is this group's box actually being PAINTED where it sits? A folded panel is
   * `display:none` until you open it, and a group still in the row is simply
   * visible — so this answers "can the user reach these controls right now?"
   * without caring which of the two ways it is on screen. */
  groupReachable: async (page, label) => {
    const box = toolbar.group(page, label);
    if (!(await box.isVisible())) return false;
    const { width, height } = await box.boundingBox();
    return width > 0 && height > 0;
  },
};

// --- background jobs (the status-bar widget) ---------------------------------

export const jobs = {
  /** The whole widget. Absent — not merely empty — when there are no jobs. */
  widget: (page) => page.locator(".jobs-widget"),
  /** The summary pill in the status bar's corner. Click to open the list. */
  pill: (page) => page.locator(".jobs-pill"),
  popover: (page) => page.locator(".jobs-pop"),
  rows: (page) => page.locator(".jobs-pop .job-row"),
  dismissAll: (page) =>
    page.locator(".jobs-pop button", { hasText: /^Dismiss all$/ }),
  /** Open the list and return its rows. */
  open: async (page) => {
    await jobs.pill(page).click();
    await jobs.popover(page).waitFor();
    return jobs.rows(page);
  },
};

// --- the loupe --------------------------------------------------------------

export const loupe = {
  root: (page) => page.locator(".loupe"),
  filmstripImgs: (page) => page.locator(".loupe .filmstrip img"),
  close: (page) => page.locator(".loupe .loupe-close"),
  selectCircle: (page) => page.locator(".loupe .loupe-select"),
  /** The interactive 5-star row in the details panel. */
  star: (page, n) => page.locator(".loupe .star-btn").nth(n - 1),
  filename: (page) => page.locator(".loupe .name"),
  /** Country/city text and the offline minimap in the details panel's
   *  Location section (#175 follow-up) — absent entirely for a photo with no
   *  GPS, not just empty. */
  locationText: (page) => page.locator(".loupe .place"),
  miniMapSvg: (page) => page.locator(".loupe .minimap svg"),
  /** smart-labels' anchor (leader) lines in the minimap. #179: these must not
   *  exist — an anchor on a 220px map is a "leader line to nowhere". */
  miniMapAnchors: (page) =>
    page.locator(".loupe .minimap #anchors path.anchor"),
  /** A minimap label by its text (e.g. the photo's own city). */
  miniMapLabel: (page, name) =>
    page.locator(".loupe .minimap g.labels text", { hasText: name }),
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

// --- video playback ---------------------------------------------------------

export const video = {
  /** The <video> element — present only once the file is actually playable. */
  player: (page) => page.locator(".loupe video"),
  /** The "converting…" / "couldn't convert" line that stands in for it. A video
   *  the browser can't decode must SAY so, not render a silent black rectangle. */
  message: (page) => page.locator(".loupe .video-msg"),
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

  /** The group path a header stands for, as [dimension, value] pairs. */
  keyOf: (header) =>
    header.evaluate(
      (el) => el.closest(".section-wrapper")?.dataset.groupKey ?? null
    ),

  /** The header one level UP from `child` — its own path minus the last step.
   *
   * Addressed by group path, never by nth(): the feed now nests FOLDER subtrees,
   * so a group's header is preceded by one header per ancestor folder, and how
   * many of those exist depends on the fixture's directory layout. An index-based
   * "parent" silently became a different header the moment nesting landed. The
   * path is the thing that actually means "parent". */
  parentHeaderOf: async (page, child) => {
    const key = JSON.parse(await group.keyOf(child));
    const parentKey = JSON.stringify(key.slice(0, -1));
    return page
      .locator(
        `.section-wrapper[data-group-key='${parentKey}'] .section-header`
      )
      .first();
  },

  /** The deepest (most nested) header on screen — a leaf group. */
  deepestHeader: (page) =>
    page
      .locator(".section-wrapper")
      .filter({ has: page.locator(".section-header") })
      .last()
      .locator(".section-header"),

  /** The header for a folder whose path ENDS in `name` (e.g. "Cam 10"). Folder
   * groups are keyed by absolute path, which no spec should hardcode. */
  folderHeader: (page, name) =>
    page
      .locator(".section-wrapper")
      .filter({ hasText: name })
      .locator(".section-header")
      .filter({ hasText: name })
      .first(),

  /**
   * The header for a folder named EXACTLY `name` — unlike `folderHeader`,
   * which substring-matches and so cannot tell "Cam 1" from "Cam 10" (the
   * fixture's nested pair on purpose: the latter contains the former as a
   * literal prefix). Needed whenever a spec asserts one of the pair is GONE —
   * `folderHeader(page, "Cam 1")` would keep "finding" it via "Cam 10"'s own
   * markup even after the real "Cam 1" header had been removed from the DOM.
   *
   * Matched against `.section-label` only (the folder-name button), never the
   * whole header: the header also carries `.section-count` ("3 items"), whose
   * digits sit right next to the label in the concatenated text and would
   * otherwise spoil the very digit-boundary check this exists to do. The
   * regex requires the name not be followed by another digit, so "Cam 1"
   * matches only the header whose name doesn't continue past the 1.
   */
  folderHeaderExact: (page, name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return page.locator(".section-header").filter({
      has: page.locator(".section-label", {
        hasText: new RegExp(`${escaped}(?!\\d)`),
      }),
    });
  },

  /** The "N items" count on a header, as a number — the subtree roll-up for a
   *  folder (real or virtual), parsed the same way `statusBar` parses its own
   *  counts. `NaN` if the header is showing no count at all. */
  countOf: async (header) => {
    const text = await header.locator(".section-count").innerText();
    const m = text.match(/([\d,]+)\s+items/);
    return m ? Number(m[1].replace(/,/g, "")) : NaN;
  },

  /**
   * The id of a group's FIRST photo, straight from the server.
   *
   * This is the ground truth a jump has to land on, and it deliberately does not
   * come from the DOM: the grid is virtualized, so "the first tile I can see"
   * is a statement about the render window, not about the group.
   */
  firstPhotoId: async (page, path) => {
    const q = new URLSearchParams({
      path: JSON.stringify(path),
      edge: "first",
    });
    const res = await page.request.get(`/api/photos/ids?${q}`);
    const { ids = [] } = await res.json();
    if (!ids.length)
      throw new Error(`group has no photos: ${JSON.stringify(path)}`);
    return ids[0];
  },

  /**
   * Assert a jump actually LANDED on `path` — the one promise every jump method
   * makes, however it was triggered (Option+→, the scrubber, the tree, a group
   * header's › button).
   *
   * "Landed" is two separate claims, and the bugs in this app's history broke
   * them independently (#35/#36/#39): the group's first photo must be the
   * FOCUSED tile (landing on the wrong photo), and it must be ON SCREEN (landing
   * on the right photo but scrolled somewhere else). Asserting only the first
   * would pass while the user stares at an unrelated part of the feed.
   *
   * `what` names the jump method, so a failure says which one broke.
   */
  landedOnFirstPhoto: async (page, path, what, { settleMs = 400 } = {}) => {
    const id = await group.firstPhotoId(page, path);
    const tile = page.locator(`.thumb[data-id="${id}"]`);
    await expect(
      tile,
      `${what}: the group's first photo never rendered`
    ).toHaveCount(1);
    await expect(
      tile,
      `${what}: focus landed on a different photo than the group's first`
    ).toHaveClass(/\bselected\b/);
    await expect(
      tile,
      `${what}: the group's first photo is focused but scrolled off screen`
    ).toBeInViewport();

    // A jump is not finished when it first LOOKS right, and that is the whole
    // bug: landing arms an automatic loadMore("before") that prepends earlier
    // groups, and its scroll compensation lands a beat later — the same late
    // pass that was found overwriting the scan confirmation in #170. Playwright's
    // matchers auto-retry until they pass, so every assertion above is satisfied
    // by the first good frame and would never notice the feed sliding away
    // afterwards.
    //
    // So re-assert once the backfill has had time to run. This deliberately
    // waits rather than polls: polling would again stop at the first frame that
    // passes, and what is being asserted here is that the landing STAYS put.
    await page.waitForTimeout(settleMs);
    await expect(
      tile,
      `${what}: the landing did not HOLD — focus moved off the group's first photo after the jump settled`
    ).toHaveClass(/\bselected\b/);
    await expect(
      tile,
      `${what}: the landing did not HOLD — the group's first photo scrolled out of view after the jump settled`
    ).toBeInViewport();
  },

  /** The group's tri-state select checkbox. */
  selectBox: (header) => header.locator(".gla-select"),
  /** "none" | "some" | "all" | "loading" — read off the checkbox's own class,
   * which is what the user sees (empty / – / ✓). */
  selectStateOf: async (header) => {
    const cls = await header.locator(".gla-select").getAttribute("class");
    return ["all", "some", "loading", "none"].find((s) =>
      cls.split(/\s+/).includes(s)
    );
  },
};

// --- auto albums + the timeline ---------------------------------------------

export const albums = {
  /** Enter Auto Albums and dismiss the first-run explainer, leaving the review
   *  screen ready. The modal opens automatically because `openApp` clears
   *  localStorage, which is exactly the state a first-time user is in. */
  async open(page) {
    await page.locator("button", { hasText: "Auto Albums" }).click();
    // The explainer is a <dialog>, so it is MODAL: it intercepts pointer events
    // for the whole page. Waiting only for the timeline to be *visible* is not
    // enough — it is plainly visible behind the dialog while every click on it
    // silently goes to the dialog instead. Wait for the dialog to be gone.
    const modal = page.locator('dialog.modal[aria-label="Auto Albums"]');
    await modal.locator("button", { hasText: "Cancel" }).click();
    await expect(modal).toBeHidden();
    await expect(page.locator(".album-timeline")).toBeVisible();
  },
  timeline: (page) => page.locator(".album-timeline"),
  /** The editable album-folder-name field in divider `i`. */
  nameInput: (page, i) => page.locator(".album-name-edit").nth(i),
  /** The "N photos · date" meta text in divider `i` (right of the name field). */
  meta: (page, i) =>
    page.locator(".album-divider").nth(i).locator(".album-meta"),
  /** The materialize destination-folder field. */
  dest: (page) => page.locator(".albums-view .dest"),
  /** The "Materialize to folders" button. */
  materializeBtn: (page) => page.locator(".albums-view .mat-btn.primary"),
  /** One rect per album, in album order. */
  band: (page, i) => page.locator(".album-timeline .band").nth(i),
  bands: (page) => page.locator(".album-timeline .band"),
  scroll: (page) => page.locator(".albums-scroll"),
  divider: (page, i) => page.locator(".album-divider").nth(i),
  dividers: (page) => page.locator(".album-divider"),
  /** The colour chip that ties a divider to its band. */
  chip: (page, i) =>
    page.locator(".album-divider").nth(i).locator(".album-chip"),

  /** How far the album list has been scrolled, in px. */
  scrollTop: (page) =>
    page.locator(".albums-scroll").evaluate((el) => el.scrollTop),

  /**
   * Did the list actually LAND on album `i`? That is what "the timeline jumped me
   * to this album" means to a user — not that some scrolling happened, but that
   * this album is now what they are looking at.
   *
   * Landing means its divider is parked at the top — OR the list is scrolled as
   * far as it can go, which is as close as the browser can get for the last album
   * (its content is shorter than the viewport, so nothing can pull it to the top).
   * That clamp is correct behaviour, and an assertion that forbids it would be
   * failing the browser, not the app.
   */
  async landedOn(page, i) {
    const list = await albums.scroll(page).boundingBox();
    const divider = await albums.divider(page, i).boundingBox();
    if (Math.abs(divider.y - list.y) <= 2) return true;
    return albums
      .scroll(page)
      .evaluate((el) => el.scrollTop >= el.scrollHeight - el.clientHeight - 2);
  },
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
  rowCount: (page) => page.locator(".tree-node-row").count(),
  /** The disclosure triangle that shows/hides a node's sub-folders IN THE TREE
   *  (expandedKeys) — distinct from `.tree-collapse-icon`, which folds the group
   *  in the FEED. */
  foldIcon: (page, name) =>
    page
      .locator(".tree-node-row", { hasText: name })
      .first()
      .locator(".tree-fold-icon"),
};

// --- the right-edge scrubber rail --------------------------------------------

export const scrubber = {
  rail: (page) => page.locator(".scrubber"),
  labels: (page) => page.locator(".scrubber .label"),
  thumb: (page) => page.locator(".scrubber .scrubber-thumb"),
  labelTexts: (page) => page.locator(".scrubber .label-text").allInnerTexts(),
};

// --- the toolbar brushable timeline (TimelineFilter.svelte) -------------------

export const timelineFilter = {
  root: (page) => page.locator(".time-filter"),
  /** The two draggable date badges (`.za-value`, from d3-zoomable-axis). Their
   *  text is the formatted min/max of the domain until the user drags a handle —
   *  the cheapest DOM-visible proxy for "what date range is this widget plotting
   *  right now", without reaching into the widget's internal `.value`. */
  badgeTexts: (page) => page.locator(".time-filter .za-value").allInnerTexts(),
};

// --- Manage library, and the ML settings section inside it (#161) ------------

/** Open the ＋ menu's "Manage library" dialog and wait for it. */
export async function openManageLibrary(page) {
  await toolbar.plus(page).click();
  await toolbar.menuItem(page, "Manage library").click();
  await expect(
    page.locator('dialog.modal[aria-label="Manage library"]')
  ).toBeVisible();
}

/** The standalone Machine learning panel (#205) — reached from the toolbar's
 *  gear, and the only home of the semantic search (#164). Distinct from
 *  `mlSettings` above, which is the section embedded in Manage library. */
export const mlPanel = {
  /** The toolbar gear. Scoped to the toolbar: the dialogs it opens carry their
   *  own accessible names, and an unscoped "Settings" matches more than one. */
  open: async (page) => {
    await page.locator(".topbar button[aria-label='Settings']").click();
    await page.getByRole("button", { name: /Machine learning/ }).click();
  },
  /** Modal is a native <dialog>, so Esc is the real close path users take. */
  close: (page) => page.keyboard.press("Escape"),
  search: (page) => page.getByTestId("semantic-search"),
};

export const mlSettings = {
  root: (page) => page.getByTestId("ml-settings"),
  /** "N of M embedded · F failed · P not computed yet" — pending and failed
   *  are DIFFERENT answers and are rendered as separate cells on purpose. */
  counts: (page) => page.getByTestId("ml-counts"),
  /** The execution provider that actually won validation, verbatim. */
  provider: (page) => page.getByTestId("ml-provider"),
  model: (page) => page.getByTestId("ml-model"),
  enable: (page) => page.getByTestId("ml-enable"),
  /** The consent line above the toggle: what gets downloaded, how big, and
   *  under which licence — the sentence the user reads BEFORE opting in. */
  consent: (page) => page.getByTestId("ml-consent"),
  /** The inline status/error line — the panel's only feedback channel. */
  message: (page) => page.getByTestId("ml-message"),
  embedNow: (page) => page.getByTestId("ml-embed-now"),
  storageRows: (page) => page.getByTestId("ml-storage-row"),
  /** The way back from a failure record — only rendered when there ARE
   *  failures, because it is the only control in the app that can clear one
   *  when no vector exists to hang a Purge button off. */
  retryFailed: (page) => page.getByTestId("ml-retry-failed"),
  /** The line stating that RAW is skipped rather than failed. */
  rawNote: (page) => page.getByTestId("ml-raw-note"),
};

// --- the faces block inside the ML panel -------------------------------------

export const faceSettings = {
  scan: (page) => page.getByTestId("face-scan"),
  /** The shared All/Visible/Selected control — the SAME component embedding
   *  uses, which is the point of #221. `which` is a scope key from
   *  ui/src/lib/scopeControl.js. */
  scope: (page) => page.getByTestId("face-scope"),
  scopeOption: (page, which) =>
    page.getByTestId("face-scope").locator(`input[value="${which}"]`),
  /** The "up to N photos · about T" line under the control. */
  estimate: (page) => page.getByTestId("face-scope-estimate"),
};

// --- the right-click menu (shared by the grid, the loupe and the tree) --------

export const menu = {
  root: (page) => page.locator(".context-menu"),
  /** An item by its visible label.
   *
   *  getByRole, not a hasText regex: Svelte renders the label with the
   *  surrounding whitespace of the template, so the button's raw text content is
   *  "\n      Reveal in Finder\n    " and an anchored ^…$ regex never matches it.
   *  The accessible name is whitespace-normalised, and `exact` keeps "Remove from
   *  library…" from also matching a future "Remove from library and delete". */
  item: (page, label) =>
    page
      .locator(".context-menu")
      .getByRole("menuitem", { name: label, exact: true }),
};
