import GridView from "./GridView.svelte";
import AlbumsView from "../AlbumsView.svelte";

/**
 * WHAT CAN OCCUPY THE MAIN AREA. One registry, so adding a view is one entry
 * here plus one component — never another branch inside App.svelte.
 *
 * Before this, swapping the main area was a boolean (`albumMode`) with `{#if}`
 * branches in the markup, the toolbar, the keyboard handler and the loupe's
 * escape path. A third view would have been a second boolean, and the fourth
 * would have made the combinations unreadable. `App.svelte` was already ~6,900
 * lines; #155 is the seam that stops it growing by a view at a time.
 *
 * Contract: `docs/UI-CONTRACTS.md` §3. The rule that makes it safe is that
 * **App stays the data owner** — a view renders and interacts, it never touches
 * `items` or its two feed-window transactions. Six hand-copied copies of that
 * guard caused #35, #36 and #39; a seventh living inside a view would be the
 * same bug wearing a new name.
 *
 * @typedef {object} ViewCapabilities
 *   What the SHARED photo interactions do in this view. Every field is
 *   REQUIRED and must be written out even when false — see the note on
 *   `ALBUMS` below. A view that cannot support one declares it here so the
 *   keystroke can be answered honestly, instead of being silently swallowed.
 * @property {boolean} open    Enter/Space/click opens the loupe on a photo.
 * @property {boolean} select  photos can be selected (and join `selectedIds`).
 * @property {boolean} rate    1–5 / 0 set a rating from inside the view.
 *
 * @typedef {object} View
 * @property {string} id                     stable; persisted, so never rename
 * @property {string} label                  human name (button, tooltip, a11y)
 * @property {string} icon                   glyph for the switcher
 * @property {"scroll"|"zoom"} navigation
 *   Who owns the viewport. `scroll` rides the existing virtualized scroller in
 *   App's `.main-column`; `zoom` owns its own pan/zoom model and must not
 *   assume the column scrolls.
 * @property {"feed"|"working-set"} dataSource
 *   `feed` reads the live feed window App already owns. `working-set` needs
 *   whole-library data and gets its own bounded, capped fetch WITH A
 *   `truncated` FLAG — App performs it on entry (see `switchView` in
 *   App.svelte). A working-set view must never widen `items` to get it.
 * @property {ViewCapabilities} capabilities
 * @property {import("svelte").Component} component
 */

/** The capability keys, so the conformance test and any future capability
 *  check enumerate them from one place rather than hand-listing three
 *  strings that drift. */
export const CAPABILITIES = ["open", "select", "rate"];

export const NAVIGATIONS = ["scroll", "zoom"];
export const DATA_SOURCES = ["feed", "working-set"];

/**
 * The justified grid — the app's home view, and the registry's first client.
 * Extracted from App.svelte unchanged: same markup, same CSS, same DOM ids
 * (`#feed-grid`), so every existing e2e spec passes UNMODIFIED. That was the
 * acceptance bar for the extraction, and a spec needing an edit would have
 * meant the extraction changed behaviour.
 * @type {View}
 */
export const GRID = {
  id: "grid",
  label: "Grid",
  icon: "▦",
  navigation: "scroll",
  dataSource: "feed",
  capabilities: { open: true, select: true, rate: true },
  component: GridView,
};

/**
 * Auto Albums — the review surface for gap-clustered albums.
 *
 * The honest capability declaration is the point of this entry: it shows you
 * photos and opens them in the loupe, but it has no selection model and no
 * rating affordance. Writing `select: false, rate: false` is what lets App
 * answer an `X` or a `3` keystroke here instead of dropping it on the floor —
 * the exact "silently swallowing the keystroke" failure §3 names.
 *
 * `dataSource: "working-set"` is load-bearing, not decorative: entering this
 * view pulls a bounded, filter-respecting album timeline (`fetchAlbumTimeline`,
 * capped server-side, with a `truncated` flag) rather than reading `items`.
 * People (#223) is the same shape, which is why albums is registered now — a
 * registry with only a feed view would not have proven this half of the
 * contract carries.
 * @type {View}
 */
export const ALBUMS = {
  id: "albums",
  label: "Auto Albums",
  icon: "▤",
  navigation: "scroll",
  dataSource: "working-set",
  capabilities: { open: true, select: false, rate: false },
  component: AlbumsView,
};

/** Every registered view, in switcher order. Append a new view here. */
export const VIEWS = [GRID, ALBUMS];

export const DEFAULT_VIEW_ID = GRID.id;

/**
 * Resolve a view id. Falls back to the grid rather than throwing: the id is
 * persisted, so a build that drops a view must not leave a returning user
 * staring at a blank main area with no way back.
 * @param {string|undefined} id
 * @returns {View}
 */
export function getView(id) {
  return VIEWS.find((v) => v.id === id) ?? GRID;
}

/**
 * Does this view support one of the shared photo interactions?
 * @param {string|undefined} id
 * @param {"open"|"select"|"rate"} capability
 */
export function supports(id, capability) {
  return getView(id).capabilities[capability] === true;
}

/**
 * Next view in the switcher cycle (wraps).
 *
 * An unknown id resolves to the DEFAULT's position, then advances from there.
 * Taking `findIndex`'s -1 at face value would compute `-1 + 1 === 0` and
 * re-select the default itself — so pressing the switcher on a stale persisted
 * id would appear to do nothing at all. (`nextRendererId` documents the same
 * trap.)
 * @param {string|undefined} id
 */
export function nextViewId(id) {
  const found = VIEWS.findIndex((v) => v.id === id);
  const i =
    found === -1 ? VIEWS.findIndex((v) => v.id === DEFAULT_VIEW_ID) : found;
  return VIEWS[(i + 1) % VIEWS.length].id;
}
