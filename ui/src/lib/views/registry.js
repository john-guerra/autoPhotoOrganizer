import GridView from "./GridView.svelte";
import AlbumsView from "../AlbumsView.svelte";
import PeopleView from "./PeopleView.svelte";
import FaceMapView from "./FaceMapView.svelte";

/** The platform modifier, as a plain string. The registry is imported by
 *  node-environment tests, so it must not reach for `navigator`. */
const MOD_HINT = "\u2318 / Ctrl";

/**
 * WHAT CAN OCCUPY THE MAIN AREA. One registry, so adding a view is one entry
 * here plus one component — never another branch inside App.svelte.
 *
 * Before this, swapping the main area was a boolean (`albumMode`) with `{#if}`
 * branches in the markup and the toolbar, plus a `$bindable` threaded from App
 * through Toolbar into ViewControls. A third view would have been a second
 * boolean and a second thread, and the fourth would have made the combinations
 * unreadable. `App.svelte` was already ~6,900 lines; #155 is the seam that
 * stops it growing by a view at a time.
 *
 * (For the record, since an earlier draft of this comment claimed otherwise:
 * `albumMode` was never consulted in `onKeydown`, and `openPhotoById`
 * deliberately does NOT touch it — the loupe opens as an overlay ON TOP of the
 * album review so Esc returns you to your split/naming work intact.)
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
 * @property {string} description
 *   What this view is FOR, in the user's terms — the switcher button's tooltip
 *   and its accessible description. It lives on the descriptor so a new view
 *   arrives with its own explanation instead of inheriting a generic one, or
 *   forcing a parallel string table in the toolbar.
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
 * @property {Array<{keys: string[], label: string}>} [keys]
 *   Keys this view handles ITSELF, in `ShortcutsOverlay`'s own `{keys, label}`
 *   row shape so the overlay can render them without translation.
 *
 *   Two consumers, and both are the point. The overlay renders them, so a
 *   view's shortcuts cannot ship undocumented — CLAUDE.md's rule that "a
 *   shortcut nobody can find does not exist", enforced by the registry rather
 *   than by remembering. And `refuseUnsupported` checks them before refusing,
 *   because `capabilities` describes what happens to PHOTOS and a view may
 *   legitimately own a selection of something else entirely.
 *
 *   `UI-CONTRACTS.md` §3's table already said "view-specific keys, declared"
 *   belongs to the view; there was simply nowhere to declare them. #232 is the
 *   first view to need one, and needed it badly enough that `X` would have
 *   told the user "Selecting photos isn't available in Face Map" while the
 *   Face Map had people selected.
 * @property {(ctx: {peopleCount: number}) => boolean} [offerable]
 *   Should the SWITCHER show a button for this view right now? Default: yes.
 *
 *   This exists because the toolbar folds by WIDTH. `PersonFilter.svelte`
 *   already learned this the expensive way — it renders nothing until someone
 *   has been found, because "two extra controls in GridControls once pushed
 *   the whole Group group into an overflow popover at ordinary window sizes".
 *   Adding People as a third always-on button did exactly that again: CI was
 *   green with two buttons and red with three, with Group-by folded away at
 *   1280px.
 *
 *   So it is declarative rather than a special case in ViewControls: a view
 *   says when it is worth a permanent slot, and the treemap/time/scatter views
 *   coming next inherit the question instead of re-discovering the fold.
 *   `V` still cycles EVERY registered view — an un-offered view is reachable,
 *   just not advertised, and its empty state explains how to fill it.
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
  description:
    "The photo grid — everything the current filters and grouping leave you, newest work first.",
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
  // Verbatim from the button this replaced — the wording was tuned once and
  // there is no reason for the registry to restate it differently.
  description:
    "Group the photos you're viewing into albums by the pauses between shots — a long gap starts a new album. Preview, rename, then save them into folders (photos and videos).",
  navigation: "scroll",
  dataSource: "working-set",
  capabilities: { open: true, select: false, rate: false },
  component: AlbumsView,
};

/**
 * People — browse and name the people the face pass found (#223).
 *
 * The registry's third entry, and the one that shows it works: adding it was
 * this block, a component, a `viewProps` case and a `WORKING_SET_LOADERS`
 * entry. No new branch in App's markup, no second way to switch, and no
 * re-derived boundary. That is what #155 was for.
 *
 * Every capability is FALSE, and that is a real declaration rather than a
 * shrug: this view shows you PEOPLE, not photos. There is no photo here to
 * rate, and `selected` indexes a feed window it does not render — so `3` or
 * `X` here would act on something off-screen, which is exactly the bug the
 * capability system was built to stop. Declaring it lets App answer the
 * keystroke by name instead of swallowing it.
 *
 * It narrows the feed through the EXISTING `personId` filter (shipped in #167,
 * wired through all three facet layers) rather than inventing a second way to
 * narrow it.
 * @type {View}
 */
export const PEOPLE = {
  id: "people",
  label: "People",
  icon: "☺",
  description:
    "Browse the people found in your photos, name them, and merge the ones that got split. Click a face to see just their photos.",
  navigation: "scroll",
  dataSource: "working-set",
  capabilities: { open: false, select: false, rate: false },
  // A People button with nobody in it is as useless as a person filter with
  // nobody in it, and it costs the same toolbar width either way.
  offerable: ({ peopleCount }) => peopleCount > 0,
  component: PeopleView,
};

/**
 * The views the SWITCHER should offer right now — every registered view whose
 * `offerable` predicate passes (a view without one is always offered).
 *
 * Deliberately NOT the same as `VIEWS`: `nextViewId` cycles everything, so an
 * un-offered view is still reachable by keyboard. Hiding a button is about
 * toolbar width, not about taking a view away.
 * @param {{peopleCount: number}} ctx
 */
export function offerableViews(ctx) {
  return VIEWS.filter((v) => v.offerable?.(ctx) ?? true);
}

export const FACE_MAP = {
  id: "face-map",
  label: "Face Map",
  icon: "◌",
  description:
    "See everyone laid out by how alike their faces are, then lasso the ones who are really the same person and merge them in one go.",
  // The FIRST view to declare this. It owns its viewport: it fills the column,
  // hides overflow, and preventDefaults wheel, or App's .main-column scrolls
  // underneath while you try to zoom.
  navigation: "zoom",
  dataSource: "working-set",
  // `open` is TRUE, and this is a deliberate change from the first draft of
  // the design: you cannot judge a merge from a 160px crop, so a tray face
  // opens its photo, exactly as ALBUMS does. Declaring false while wiring
  // photo-opening would be a lie nothing currently catches, because
  // capabilities.open is read by nothing yet — and the moment something reads
  // it, the feature breaks.
  //
  // `select` and `rate` are false for PeopleView's exact reason: `selected`
  // indexes a feed window this view does not render, so a `3` here would rate
  // a photo you cannot see. This view's own selection is of PEOPLE and is
  // private to it.
  capabilities: { open: true, select: false, rate: false },
  // Keys this view handles itself (#232's Task 0). Declaring them is what
  // stops App answering Escape with "Selecting photos isn't available in Face
  // Map" while the view has a perfectly good selection of people — and the
  // shortcuts overlay renders them from here, so they cannot ship
  // undocumented.
  keys: [
    // "Escape", not "Esc": `claimsKey` matches on KeyboardEvent.key, so a
    // display-only spelling silently never matches and App answers the key
    // with a message about photos. Caught by a test, which is why this note
    // exists.
    { keys: ["Escape"], label: "Clear the lasso and empty the tray" },
    { keys: ["0"], label: "Fit the whole map back into view" },
    { keys: ["Shift", "+", "drag"], label: "Add to the selection" },
    { keys: ["Alt", "+", "drag"], label: "Remove from the selection" },
    { keys: [MOD_HINT, "+", "drag"], label: "Pan the map" },
  ],
  // The toolbar folds by WIDTH and this is the FOURTH view. PersonFilter
  // learned that once; #223 hit it again at 1280px — CI-only, with 151/151
  // green locally. A map of three people is useless anyway, so earn the slot
  // rather than taking one unconditionally. `V` still cycles here.
  // WAS `>= 100`, lowered to "any people at all" at John's explicit request
  // (#300), after he reset his library, ran a scan, and could not find either
  // face view.
  //
  // Recorded because the threshold was not arbitrary and this has bitten
  // twice: THE TOOLBAR FOLDS BY WIDTH. A fourth always-on button is exactly
  // what pushed `.group-by` and `.seg-toggle` into an overflow popover at
  // 1280px in #223 — CI-red while 151/151 passed locally. If
  // `toolbarControls.spec.js` fails at the narrowest supported width, this is
  // the cause, not a flake.
  offerable: ({ peopleCount }) => peopleCount > 0,
  component: FaceMapView,
};

/** Every registered view, in switcher order. Append a new view here. */
export const VIEWS = [GRID, ALBUMS, PEOPLE, FACE_MAP];

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
 * The keys this view handles ITSELF.
 *
 * @param {string|undefined} id
 * @returns {Array<{keys: string[], label: string}>}
 */
export function viewKeys(id) {
  return getView(id).keys ?? [];
}

/**
 * Does this view claim `key` as its own?
 *
 * Consulted by `refuseUnsupported` BEFORE it refuses on capability grounds.
 * Without it, every view is answered in terms of PHOTOS: a view whose
 * selection is of people gets told "Selecting photos isn't available here"
 * while showing the user a perfectly good selection, which is worse than
 * silence because it is confidently wrong.
 *
 * Case-insensitive, because `KeyboardEvent.key` reports `X` with shift held
 * and `x` without, and a declaration matching only one would refuse half the
 * presses.
 *
 * @param {string|undefined} id
 * @param {string} key a `KeyboardEvent.key` value
 */
export function claimsKey(id, key) {
  if (!key) return false;
  const k = String(key).toLowerCase();
  return viewKeys(id).some((row) =>
    row.keys.some((declared) => String(declared).toLowerCase() === k)
  );
}

/**
 * Which view a fresh load should open on, given whatever id was persisted.
 *
 * A `working-set` view's DATA does not survive a reload: only App can fetch
 * it, and doing that during boot would hold up first paint for a view you may
 * not even want. Restoring the id alone would drop you into the album review
 * with no albums in it — an empty shell that reads as the app having lost your
 * work. So only `feed` views are restored; anything else reopens on the
 * default, one keypress from where you were.
 *
 * Pure, and here rather than inline in App.svelte, so this rule is covered by
 * a 2ms unit test instead of only by a 15s Playwright one (docs/TESTING.md:
 * push logic down).
 *
 * @param {string|undefined} storedId
 * @returns {string}
 */
export function restorableViewId(storedId) {
  const stored = getView(storedId);
  return stored.dataSource === "feed" ? stored.id : DEFAULT_VIEW_ID;
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
