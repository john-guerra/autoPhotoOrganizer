# Svelte 5 migration + dependency modernization

Living reference for moving AutoGallery from Svelte 4 to Svelte 5 (runes) and
bringing **every** dependency up to its latest stable version. Written before any
code changed; keep it current as the migration lands.

**Baseline:** `main` @ v2.15.0 (`6c1566e`). Branch: `worktree-svelte-5-migration`.

## Status

**Stage 1 DONE** — the Svelte toolchain is on latest (svelte 5.56, vite-plugin-svelte
7.2, vite 8.1, vitest 4.1, prettier 3.9 + plugin 4.1), Node floor raised to 22.12
(CI pinned), `ui/svelte.config.js` stub deleted. **No component was converted to
runes** — all 41 still compile in Svelte-4 legacy mode. Gate green: build (dev +
prod), 865 unit, 60 e2e, plus a live pass on the 114k library (grid + loupe render
correctly, no `:where()` regression).

Four things broke and had to be fixed even without touching component syntax — the
"zero syntax change" stage is not "zero change":

1. **`new App({ target })` → `mount(App, …)`** in `ui/src/main.js`. The removed
   Svelte-4 client API is the ONE `new Component()` in the repo — in the entry
   point, which the component survey didn't cover. Symptom: blank page,
   `component_api_invalid_new`.
2. **`sortablejs` interop under Vite 8** (`ui/vite.config.js` alias). `multi-auto-select`'s
   UMD build calls `Sortable.create(...)`, expecting sortablejs's default export to
   BE the class; Vite 8/esbuild now resolves sortablejs via its ESM `module` field
   and hands the factory the ESM _namespace_, so `.create` is missing → `e.create is
not a function`, blank app. Aliased sortablejs to its CJS/UMD build. **We control
   `multi-auto-select`**, so the cleaner long-term fix is to correct its sortablejs
   import upstream (import the class, or `Sortable.create` off the right member) and
   drop the alias.
3. **Nested `<button>` in `Thumb.svelte`** — the `.select-circle` and `.thumb-retry`
   buttons sat inside the `.thumb` button. Svelte 5's stricter HTML validation
   rejects it (the browser silently repairs such markup). Converted the two inner
   controls to `role="button"` spans (valid nesting; class-based CSS and the
   `.thumb:hover` reveal untouched; keyboard handlers restored).
4. **Benign ResizeObserver warning** now trips the e2e page-error guard.
   "ResizeObserver loop completed with undelivered notifications" is a spec-sanctioned
   quirk Chrome dispatches as an uncaught error; Svelte 5's render timing surfaces it
   (ToolbarRow's overflow fold). Swallowed ONLY that exact message in `ui/src/main.js`.

**Runtime + dev tooling DONE** (Stage 1b) — express 4→**5.2.1**, concurrently 8→**10**,
cross-env 7→**10**, wait-on 8→**9**. Two Express-5 breaks, both already covered by
red tests (the migration's own regression guard):

1. **`req.query` is now getter-only** — `bodyAsQuery` did `req.query = {…}`, which
   throws in Express 5. Shadowed it with an own data property via
   `Object.defineProperty` (`server/api.js`). Caught by `api.test.js`'s "POST body as
   query" test.
2. **`app.listen`'s callback is now `once()`-wrapped onto BOTH 'listening' and
   'error'** — on EADDRINUSE the success callback fires Node-style with an Error and a
   null `address()`, so `listenOnOpenPort` crashed reading `.port` off null. Honor the
   `err` param (`server/index.js`). Caught by `index.test.js`'s port-fallback test.

Gate green after this group: 865 unit + 60 e2e + prod build.

Still open (warnings, not blockers): Svelte 5 warns on self-closing non-void tags
(`<div … />`). `sv migrate` fixes these mechanically; fold into Stage 2.

**Electron stack DONE** (Stage 1c) — electron 33→**43.1.1**, electron-builder
25→**26.15.3**, @electron/rebuild 3→**4.2.0**, electron-updater 6.3→**6.8.9**. One
config break:

- **electron-builder 26 removed `win.publisherName`** (`additionalProperties:false`
  now; it moved under the Windows _signing_ config). This app builds unsigned NSIS
  with no certificate, so the field no longer applies — dropped it from
  `build.win`.

Verified: `npm run rebuild:electron` rebuilds better-sqlite3 against Electron 43's
ABI; a headless Electron smoke boot loads the native module and answers
`/api/health`; `npm run electron:build:mac` packages a valid (ad-hoc-signed) .app +
dmg with electron-builder 26; and launching the packaged .app boots the full process
tree with the embedded Express 5 server on :4331 reporting version 2.15.0 (proving
better-sqlite3 loads from its `asarUnpack` slot). The build script's trailing
`rebuild:node` restores the Node ABI so local vitest stays green (865 unit + 60 e2e
after the bump). Side note: the 11 npm high-severity advisories were all in the old
electron-builder 25 tree — now **0 vulnerabilities**.

**All dependency modernization (Stage 1a/1b/1c) is complete.**

**Stage 2 DONE — all 41 components are on runes.** 898 unit + 60 e2e green; build
compiles with zero warnings; App.svelte live-verified on the 114k library (scroll/
fling, fold → snapshot render, optimistic rating, filter + feed-narrow + header
counts). The one App.svelte review bug and the two #124 pre-extractions are written
up below. Converted & gated in batches (865→898 unit + 60 e2e green after each):

- **Independent leaves:** FolderIcon, GroupStateIcon (pure `$props`), GridControls,
  SidebarModeToggle (`$bindable` — bridges legacy parents' `bind:`), ServerBanner
  (DOM `on:`→`on`), UpdateBanner (`onMount`/`onDestroy`→`$effect` + cleanup;
  `$:`→`$derived`; transition-reset kept as an `$effect` over a plain untracked
  `prevState`), SnapshotThumb (`<script context="module">`→`<script module>`;
  render-only state → `$state`; restart/cleanup → `$effect`).
- **Modal + consumers:** Modal → runes (`$bindable`, `$effect` over the `bind:this`
  dialog, dispatch→`onclose`, slots→snippets). Fixed a real interop trap — a legacy
  parent's named `<svelte:fragment slot="footer">` does NOT bridge to a runes child's
  `footer` snippet (default content does, via `children`); consumers must pass
  `{#snippet footer()}`. See §6.
- **Loupe cluster:** Stars, LoupeDetails, LoupeFilmstrip, Loupe — the Stars `rate`
  event is now a callback prop forwarded straight through the chain to App; `index`
  is `$bindable`; the `|stopPropagation` modifier (removed in 5) is inlined.
- **Tree cluster:** TreeNode (recursive), TreeSidebar. All 8 `dispatch()` calls
  across the pair became callback props (`ontoggleexpand`/`ontogglecollapse`/
  `onjump`/`oncontextmenu` on TreeNode, `ontoggle`/`onjump`/`oncontextmenu` on
  TreeSidebar); TreeSidebar's handlers dropped `.detail` since callback props
  hand back the payload directly. `revealPath` stayed an `export async function`
  (App still calls it via `bind:this`). New gotcha found here, not yet in §6:
  **`<svelte:self>` compiles clean in Svelte-4-legacy components but warns
  `svelte_self_deprecated` once the component is runes** — converted both
  recursion sites in `TreeNode.svelte` to a self-import
  (`import TreeNode from "./TreeNode.svelte"`) instead, which is silent and
  behaves identically. Both recursion sites thread all 4 callback props;
  missing either reproduces the "only the top level fires" bug this file is
  famous for. The `$:` reseed `resetAndLoad()` trigger became an `$effect`
  that explicitly reads `groupBy`/`filter`/`sort`/`refreshToken` — the first
  three are also read implicitly (via `loadRoot`, synchronously before its
  first `await`), but `refreshToken` is a pure "bump to reload" signal nothing
  else reads, so it needed an explicit read to stay tracked.
- **ContextMenu:** `onclose` callback; the clamp `$: left/top` → `$derived` (w/h
  `$state` for `bind:clientWidth`); the capture-phase scroll listener's
  onMount/onDestroy → one `$effect`.
- **SnapshotStrip** (shared feed + albums node): `onselect` callback; the two
  client-sample / server-fetch `$: if` blocks → `$effect`s; one-shot `count` seed
  wrapped in `untrack()`. Consumers updated: App's feed `<svelte:component>` and
  AlbumsView's per-album strip.
- **JobsPanel:** self-contained; `$jobs`-store derivations → `$derived`; the
  popover auto-close stays an `$effect`.
- **Albums cluster:** AlbumTimeline, AlbumsSetupModal, AlbumsView. `$:`-closures
  (`pxOf`/`timeAt`) became plain functions (a `$derived` only tracks synchronous
  reads, so a closure body never registers deps); AlbumsSetupModal's open-reseed
  collapsed to a single `$effect` + plain untracked `lastOpen`. Two traps caught on
  review (now in §6): AlbumTimeline's view-reseed `$effect` read AND wrote `view`
  → `effect_update_depth_exceeded`; `bind:this={arr[i]}` needs `$state([])`.
- **4 independent App.svelte-only leaves:** ShortcutsOverlay (`dispatch("close")`
  → `onclose?.()`; the Modal `footer` snippet was already done). FisheyeSidebar
  (5 `export let` → `$props()`, no bindables; the hierarchy-reload `$:` → an
  `$effect` with explicit `void filter/sort/refreshToken` reads, same pattern as
  TreeSidebar's `resetAndLoad`; the inner `<FisheyeNav on:select>` stays `on:` —
  that child ships Svelte-4 source and is out of scope). GroupLabelActions (3
  `export let`, 5 `dispatch` → callback props `ontoggleselect`/`onjumpprev`/
  `onjumpnext`/`onkeeponly`/`onremove`; all 5 `on:click|stopPropagation` inlined
  to `onclick={(e) => { e.stopPropagation(); on...?.(); }}`). StatusBar (7
  `export let` → `$props()`; its 3 named slots `scope`/`jobs`/`selection` became
  snippet props rendered as `{#if x}{@render x()}{/if}`, preserving the
  `sb-right` wrapper around `jobs`). App.svelte's 4 usage sites updated in
  lockstep: `<FisheyeSidebar on:jump>`→`onjump`; `<GroupLabelActions on:*>`→the
  5 callback props (`e.detail` dropped — the callback now hands back the raw
  click event directly); the `<StatusBar>` block's
  `<svelte:fragment slot="scope">`→`{#snippet scope()}`,
  `<JobsPanel slot="jobs">`→`{#snippet jobs()}<JobsPanel />{/snippet}`,
  `<SelectionBar slot="selection" …>`→`{#snippet selection()}<SelectionBar
…>{/snippet}` (SelectionBar itself stays legacy, untouched inside);
  `<ShortcutsOverlay on:close>`→`onclose`.
- **SelectionBar, ManageLibrary, Thumb:** SelectionBar (13 props, 4 `$bindable`:
  `exportOpen`/`exportDest`/`exportName`/`exportMove`; 10 payload-less dispatches →
  `on*` callbacks). ManageLibrary (dispatches → `onclose`/`onsweep`/
  `onfolderRemoved`/`onlibraryReset`; the Modal's `onclose` already wired). Thumb
  (the hot-path feed tile: `<script module>`; IntersectionObserver
  `onMount`/`onDestroy` → one `$effect`; `src`/peek lists → `$derived`; prop-seeded
  `$state` via `untrack`). **Thumb hit the callback-in-effect re-entrancy loop**
  (see §6) — the load `$effect` now tracks only `src` and runs `armAttempt`
  untracked. App's `<Thumb>` + `<SelectionBar>` (inside the StatusBar `selection`
  snippet) usage moved to callback props; `bind:export*` kept.

- **Toolbar cluster (one atomic unit, 13 components):** Toolbar, ToolbarRow,
  ToolGroup, ViewControls, GroupByControl, SortControl, FilterControls + the 4
  filter leaves (RatingFilter, OrientationFilter, KindFilter, SearchFilter),
  TimelineFilter, SourceControls. Converted together because the `bind:`/forward/
  named-slot chains span App→Toolbar→{Source,Filter,View,Group,Sort}Controls. The
  whole zoom/burst/albumMode/sidebarMode/add-folder two-way chain became
  `$bindable()` (still bound from legacy App); 15 `createEventDispatcher` forwards
  became callback props (App's `<Toolbar>` block drops the old `.detail` unwrap —
  `onfilterchange={onFilterChange}`); `use:` actions call their callback directly.
  Trap 1 (nested named-slot forwarding): Toolbar's `timeline` slot now forwards a
  snippet **value** straight into FilterControls (`{timeline}`), and App passes
  `{#snippet timeline()}` / `{#snippet manageLibrary()}` because a legacy parent's
  `<svelte:fragment slot=x>` does NOT bridge to a runes snippet prop (§6). Trap 2:
  `bind:this` refs in ToolGroup made `$state` (`non_reactive_update`). SearchFilter's
  outside-sync `$: if` became an `$effect` that reads+writes `value` but converges
  in one pass (a string reassignment is a no-op once equal — unlike the array
  reproxy that looped in AlbumTimeline); debounced emits fire from `setTimeout`,
  never inside an `$effect`, so no callback-in-effect loop.

**App.svelte (the last one, 5,170 lines) — DONE.** Converted as its own careful
pass. 72 `$:` → 48 `$derived` + 24 `$effect` (13 localStorage persists + the
side-effecting `$: if` blocks); no `$:`-closures existed. `let`→`$state`; Set/Map
states are `$state` (deeply reactive — the `x = x` self-reassigns are now harmless
no-ops, left in place). `<svelte:window on:*>` → `on*` event props;
`<svelte:component this={renderer.component}>` → `{@const Renderer =
renderer.component}` + `<Renderer/>` (the element is deprecated in 5). `items` kept
deep `$state` (it is mutated IN PLACE by `rate`/`toggleCover`, so `$state.raw` — for
wholesale reassignment — would break it). The feed-window transactions
(`withFeedTransaction`/`loadMore`/`feedEpoch`) and the `fetchingBefore`/`fetchingAfter`
guards were preserved verbatim, every `await tick()` intact.

- **The one review bug — `$effect` vs `$effect.pre` timing (7 e2e failures → 0).**
  The visible-range trigger `$: if (boxes) { updateVisibleRange(); … }` was first
  converted to a plain `$effect`, which runs AFTER the DOM updates. A `$effect`
  WRITES `renderStart`/`renderEnd`, which `visibleItems` (`$derived`) reads and the
  grid `{#each visibleItems}` indexes into `boxes[i]`. So a fold/filter that
  shortened `boxes` rendered the OLD range against the NEW, shorter `boxes` →
  `boxes[i]` undefined → `Cannot read properties of undefined (reading 'y'/'kind')`,
  crashing every snapshot/fold path. Fix: `$effect.pre`, which runs BEFORE the DOM
  update — matching the Svelte-4 `$:`'s topological pre-render ordering, so the
  range is refreshed before `visibleItems` is pulled. **General rule (now in §6):
  a `$: `/side-effect that WRITES state a template reads synchronously in the SAME
  flush must become `$effect.pre`, not `$effect`; a plain `$effect` (post-DOM) is
  only safe when its writes feed the NEXT frame (e.g. bodies that `tick().then(…)`
  or schedule an rAF).**
- **Live-verified on the 114k library:** hard scroll/fling (the `$effect.pre`
  region) — no crash; `Snapshot all` fold → strips render; optimistic rating
  (★ appears instantly — the in-place `items` mutation); rating filter → feed
  narrows to the matches with correct header counts. A transient `Failed to fetch`
  seen only with the WHOLE 114k tree expanded is a pre-existing load-saturation
  issue (the group tri-state indicator fires 1,000+ `/api/photos/ids` fetches, one
  per expanded header, past Chrome's ~6-connection cap) — NOT a runes regression:
  it vanishes with the tree collapsed, and the fetch logic was preserved verbatim.

**App.svelte-vs-#124: chose (a) — decompose first, then convert.** Per §7's lean,
we extract App.svelte's self-contained logic clusters into pure, unit-tested modules
BEFORE the runes pass, shrinking the file so the eventual conversion is small and
safe. Done **incrementally, safest-first** — each extraction is a pure module in the
existing `groupSelection.js`/`bulkSelection.js` style (NOT a store rewrite, which
would touch ~360 `selectedIds` sites and risk the silent-reactivity breakage this
file is known for), gated (build + unit + e2e) and committed on its own.

- **#124 extraction 1 — Selection set-algebra (`selectionOps.js`).** Pulled the
  localStorage parse + the clone-to-reassign set algebra (`parseStoredSelection`,
  `toggleId`, `withIds`, `withoutIds`, `rangeIds`) out of App's ~8 hand-inlined
  mutation sites into one tested module (+21 unit tests). `selectedIds` stays App
  reactive state, so the reactivity model is unchanged; the runes pass later drops
  the reassign ritual in one place. The fetch/status/scope orchestrators
  (`selectMatching`, `selectAllInView`, `bulk*`, group select) stay in App and call
  the helpers.
- **#124 extraction 2 — fold subtree predicates (`foldPaths.js`).** `isPathUnder` /
  `isKeyUnder` — the "is X at or beneath this group?" test the THREE fold writers
  (`setGroupRenderer`, `cycleLeafPaths`, `cycleGroupLeaves`) all rely on to stay
  consistent — moved into one tested module (+12 unit tests: the dimension+value
  match, the JSON-key parse, the malformed-key guard). Pure, no reactivity change.
  The remaining #124 clusters (loupe, stacks, scanning, albums, feed-window) already
  have their pure logic in `snapshot.js`/`groupRenderers.js`/`folderTree.js` + the
  consolidated feed-transaction guards, so the pure-extraction well was dry after
  these two — the rest of the shrink is App's own runes conversion above.

**Working rule that's held:** convert each cluster atomically (leaf child + every
parent usage site in the same commit) so the app compiles and all 60 e2e stay green
at every commit; App.svelte stays legacy throughout, its child-usage syntax updated
incrementally (`on:x`→`onx`, `bind:` unchanged for `$bindable` children).

**Scope (set by the user):** not just Svelte — **all libraries and technologies to
their latest stable, recommended versions**, with the Svelte 4→5 runes migration as
the largest single piece.

---

## 1. Why now

- Svelte 4's implicit reactivity (`let` + `$:`) and Svelte 5's runes are two
  different reactivity systems. Staying on 4 keeps us on the deprecated one; every
  new component has to be written in the old idiom to match.
- Runes fix a class of bug this codebase has already been bitten by. The one now
  recorded in `CLAUDE.md` ("Three traps") — **a `$:` statement that depends on a
  `bind:this` element re-fires forever because `safe_not_equal` treats every object
  as changed** — simply does not exist under runes: `$derived`/`$effect` track the
  values you read, not a whole reactive block, and `$state` proxies compare
  structurally. Migrating retires the footgun instead of documenting it.
- The tooling has moved on. `@sveltejs/vite-plugin-svelte@3` (what we pin) is
  **Svelte-4-only** and is the hard blocker below; everything downstream of it
  (Vite, Vitest) is a major version behind.

## 2. This repo's migration surface (measured)

Two full passes over `ui/src/`, July 2026:

- **41 components, 14,209 lines.** `App.svelte` alone is **5,170 (36%)** and
  concentrates the hard cases: **72 of 180 `$:`** statements, **8 of 33**
  side-effecting `$: if` blocks, **all 13** localStorage-persist reactives, **26 of
  30 `tick()`** calls, the single transition, `<svelte:window>`,
  `<svelte:component>`, and most bindable props.
- **194 `export let`** (169 with defaults, 25 required) → `$props()` / `$bindable()`.
- **~16 two-way `bind:` prop chains** threaded App → Toolbar →
  SourceControls/FilterControls (add-folder, scan, zoom, burst, export state). Each
  target `export let` becomes `$bindable()`, and every forwarding component in the
  chain must change in lockstep.
- **28 components use `createEventDispatcher`** (79 dispatches). **271 `on:`
  directives, ~25 handler-less forwards.** Choke points: `Toolbar.svelte` (14
  forwards) and the **recursive `TreeNode.svelte`** (8 forwards across two
  `<svelte:self>` — miss one recursion site and only the top level of the tree
  works, the classic bug here).
- **Slots** in 6 components; **`$$slots` once** (`Modal.svelte`'s `footer`); ~9
  named-slot / `<svelte:fragment slot=…>` sites.
- **Stores:** `writable` only — `serverHealth.js`, `jobs.js`, and one context-shared
  local in `ToolbarRow.svelte`. No `derived`/`readable`. Stores keep working
  unchanged in Svelte 5; they can migrate to `.svelte.js` rune modules later, not
  now.
- **The dominant idiom to plan for:** `$:` derivations over **`Set`/`Map` reassigned
  to trigger reactivity** — `x = new Set(x).add(...)` — for `selectedIds`,
  `expandedKeys`, `snapshotGroupKeys`, `collapsedKeys`, `loadingKeys`, and more
  (`TreeSidebar.svelte`, `TreeNode.svelte:29`, throughout `App.svelte`). Under runes
  these become `$state` (which is _deeply reactive_ for objects, so you can mutate in
  place — `set.add(x)` works and notifies) plus `$derived`. The clone-to-reassign
  ritual is no longer required and should be removed as each file is converted, not
  mechanically preserved.

**Genuinely easy here (the hardest hooks are absent):** no `beforeUpdate` /
`afterUpdate`, no imperative `new Component()`, no `$$props` / `$$restProps`, exactly
one transition (`App.svelte` `in:scale|global`), one `setContext` pair.

**Safety net:** there are **no component-render unit tests** — all 865 vitest tests
are pure logic. Components are exercised **only by the 60 Playwright e2e**, which are
**Svelte-version-agnostic** (they drive the built app in a browser). That suite,
plus the live-verification discipline in `CLAUDE.md`, is what makes a gradual
component-by-component migration safe.

## 3. Dependency modernization map

Latest stable as verified on npm, July 2026. Order matters: the Svelte toolchain
first (it's the blocker and unblocks the build), native/Electron as its own step
(ABI rebuild), the rest opportunistically. **Gate after every group:** `npm run
build` compiles, `npm test` (865) green, `npm run test:e2e` (60) green.

### Svelte toolchain — do first, together

| package                        | current | target      | notes                                                                                   |
| ------------------------------ | ------- | ----------- | --------------------------------------------------------------------------------------- |
| `svelte`                       | ^4.2.19 | **^5.56.5** | the migration                                                                           |
| `@sveltejs/vite-plugin-svelte` | ^3.1.2  | **^7.2.0**  | the blocker; peers `svelte ^5.46.4`, `vite ^8`                                          |
| `vite`                         | ^5.4.8  | **^8.1.4**  | pulled up by the plugin's peer; Node floor 20.19+ / 22.12+                              |
| `vitest`                       | ^2.1.2  | **^4.1.10** | supports Vite 6/7/8; coupled to the svelte plugin via `vitest.config.js` — bump with it |
| `prettier-plugin-svelte`       | ^3.5.2  | **^4.1.1**  | peers `prettier ^3`, `svelte ^5` (rune-aware)                                           |
| `prettier`                     | ^3.3.3  | **^3.9.5**  |                                                                                         |

Also: **delete `ui/svelte.config.js`** — it's an editor-only stub whose own comment
says to remove it once vite-plugin-svelte v5+ lands.

### Build/test tooling

| package            | current | target  | notes                                              |
| ------------------ | ------- | ------- | -------------------------------------------------- |
| `@playwright/test` | ^1.61.1 | ^1.61.1 | already latest; run `npx playwright install` after |
| `concurrently`     | ^8.2.2  | ^10.0.3 | dev-only; low risk                                 |
| `cross-env`        | ^7.0.3  | ^10.1.0 | dev-only                                           |
| `wait-on`          | ^8.0.1  | ^9.0.10 | dev-only                                           |

### Runtime / server — watch the majors

| package                            | current         | target     | notes                                                                                                                                                                                                    |
| ---------------------------------- | --------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `express`                          | ^4.19.2         | **^5.2.1** | **MAJOR.** Express 5 uses path-to-regexp v8 — no bare `*` wildcards, `:param?` optional syntax changed, some removed methods. Review every route in `server/api.js`; the API + e2e suites are the check. |
| `better-sqlite3`                   | ^12.11.1        | ^12.11.1   | already latest; **must be rebuilt** against the new Electron ABI                                                                                                                                         |
| `sharp`                            | ^0.35.3         | ^0.35.3    | already latest (native/libvips)                                                                                                                                                                          |
| `exifr`                            | ^7.1.3          | ^7.1.3     | already latest                                                                                                                                                                                           |
| `d3`                               | ^7.9.0          | ^7.9.0     | already latest                                                                                                                                                                                           |
| `@floating-ui/dom`                 | ^1.8.0          | ^1.8.0     | already latest                                                                                                                                                                                           |
| `sortablejs`                       | ^1.15.7         | ^1.15.7    | already latest                                                                                                                                                                                           |
| `ffmpeg-static` / `ffprobe-static` | ^5.3.0 / ^3.1.0 | same       | already latest                                                                                                                                                                                           |

### Electron — its own step (native ABI rebuild)

| package             | current | target       | notes                                            |
| ------------------- | ------- | ------------ | ------------------------------------------------ |
| `electron`          | ^33.0.0 | **^43.1.1**  | 10 majors; bundles newer Node/V8                 |
| `electron-builder`  | ^25.1.8 | **^26.15.3** |                                                  |
| `@electron/rebuild` | ^3.6.1  | **^4.2.0**   | rebuilds `better-sqlite3` against Electron's ABI |
| `electron-updater`  | ^6.3.0  | ^6.8.9       |                                                  |

After the Electron bump: `npm run electron:build:mac` (or the CI leg) must produce a
launchable app — `better-sqlite3` loading is the thing that breaks if the rebuild is
wrong.

### Node floor (raised by Vite 8)

Vite 8 requires Node **`^20.19 || >=22.12`**. Today `package.json` says
`engines: >=22` and CI/release pin `node-version: 22`. Bump **`engines` to `>=22.12`**
(or `>=24`) and CI's `node-version` to **`22.12`** or **`24`** so the runners satisfy
the floor. Local dev is already on Node 24.

### Interop verdict (no blocker from the linked packages)

- `multi-auto-select`, `@john-guerra/d3-zoomable-axis` — vanilla JS, framework-neutral.
- `@john-guerra/fisheye-nav/svelte` — ships a **Svelte-4-source** component
  (`createEventDispatcher`/`export let`/`$:`, zero runes), compiled by _our_ plugin.
  Svelte 5 compiles Svelte-4 syntax in legacy mode, so it keeps working; the
  consumer (`FisheyeSidebar.svelte`) uses `on:select`/`dispatch`, which stay valid.
  None are `npm link`ed.

## 4. Runes cheat-sheet, with this repo's cases

`export let` → `$props()`; bindable ones → `$bindable()`:

```svelte
<!-- was -->
export let sort; export let zoom = 2; // bound by parent
<!-- now -->
let {(sort, (zoom = $bindable(2)))} = $props();
```

Every `bind:zoom`/`bind:sidebarMode`/… target (the ~16 chain props) needs
`$bindable()`, and the forwarding hub (`Toolbar.svelte`) re-declares them via
`$props()` and passes them down.

`$:` derivation → `$derived` / `$derived.by`:

```svelte
$: collapsedKeys = new Set(collapsedPaths.map(pathKey));   // was
let collapsedKeys = $derived(new Set(collapsedPaths.map(pathKey)));  // now
// multi-statement → $derived.by(() => { ... return v })
```

`$: if (...)` side effect → `$effect` (and the 13 localStorage lines):

```svelte
$: if (browser) localStorage.setItem("k", JSON.stringify(v)); // was $effect(()
=> localStorage.setItem("k", JSON.stringify(v))); // now
```

But first ask: is it really a side effect? If the block just assigns another piece
of state, it's a `$derived`, not an `$effect` (see §5).

`createEventDispatcher` → callback props:

```svelte
<!-- child, was -->
const dispatch = createEventDispatcher(); dispatch("jump", path);
<!-- child, now -->
let {onjump} = $props(); onjump?.(path);
<!-- parent -->
<TreeNode onjump={handleJump} />
<!-- was on:jump={...} -->
```

The recursive `TreeNode.svelte` forwards through **both** `<svelte:self>` sites —
convert both, or only the top tree level fires (the shipped bug this file is famous
for).

DOM events `on:click` → `onclick`; forwarding `on:click` (no handler) → accept and
pass the callback prop. Event **modifiers are gone** — `on:click|preventDefault`
becomes an inline wrapper or a `svelte/legacy` helper.

Slots → snippets. `Modal.svelte`'s `$$slots.footer`:

```svelte
<!-- was -->
{#if $$slots.footer}<footer><slot name="footer" /></footer>{/if}
<!-- now -->
{#if footer}<footer>{@render footer()}</footer>{/if}
<!-- with --> let {(children, footer)} = $props();
```

Named slots (`<svelte:fragment slot="timeline">`) become snippet props +
`{@render ...}`. `<svelte:component this={x}>` → just `<x>` (components are dynamic
by default in 5).

## 5. Best-practice rules (from the official docs)

- **Reach for `$derived` before `$effect`.** If an effect body ends by assigning
  `$state`, it should have been `$derived`. Syncing one piece of state from another
  inside an effect is the most common misuse.
- **`$effect` is for genuine side effects only** — DOM work, subscriptions,
  intervals, persistence, logging — with an optional cleanup return.
- **`$state.raw` for large objects/arrays that are _reassigned wholesale_, not
  mutated** — the feed window `items`, the layout `boxes`, big API responses. Deep
  `$state` proxies every element; `$state.raw` skips that overhead when you only ever
  swap the whole value.
- **One component at a time.** Svelte 5 runs Svelte-4 syntax per-component, so a
  half-migrated app is valid at every commit. Do **not** flip a component
  half-way — a single component is all-runes or all-legacy.
- Prefer event handlers / function bindings over effects for responding to user
  input.

## 6. Gotchas specific to this app

- **CSS specificity changed — the loud one.** Svelte 5 scopes styles with `:where()`,
  which has **zero specificity**. This app is pixel-precise and leans on `:global()`
  and scoped overrides (the justified grid, sticky headers, the dendrogram trunk,
  the loupe). A rule that used to win by scoped-class specificity may now lose. **Every
  converted component needs a live visual pass**, not just green tests — the e2e
  geometry assertions catch a lot, but color/z-index/hover regressions need eyes.
- **Whitespace is trimmed more aggressively** — inline layouts that relied on a
  literal space may need `{' '}` or `preserveWhitespace`.
- **`null`/`undefined` now render as an empty string**, not the text "null".
- **An `$effect` that both READS and WRITES the same `$state` self-fires forever —
  `effect_update_depth_exceeded` (this bit AlbumTimeline).** The Svelte-4 reseed
  `$: if (full && (view == null || !zoomed)) view = full` translated literally to an
  `$effect` reads `view` (via `view == null`) and writes `view` — and because `$state`
  re-proxies an array to a fresh reference on assignment, the write always looks like a
  change, so the effect retriggers without end. Fix: don't read what you write — drop
  the `view == null` read (`if (full && !zoomed) view = full`), or guard on a PLAIN
  untracked local (the UpdateBanner/AlbumsSetupModal reseed pattern). This is the most
  likely failure when converting a side-effecting `$: if` that touches its own target.
- **`bind:this={arr[i]}` into a plain array warns `binding_property_non_reactive`.**
  Binding element refs into a collection (AlbumsView's `dividerEls`, `nameInputs`)
  needs the container to be `$state([])`, even when the array is only ever read
  imperatively (in handlers). Plain `let` compiles but warns at runtime.
- **A `$state` Set/Map is NOT deeply reactive — mutating it in place (`.add()` /
  `.delete()` / `.set()`) does nothing, and `x = x` self-assign is a no-op (this
  bit burst-expand, live only).** `$state` deeply proxies plain objects and arrays
  (so `items[k].rating = r` IS reactive, which is why rating worked), but it does
  NOT proxy `Map`/`Set` — their mutator methods aren't instrumented. The Svelte-4
  idiom `set.add(x); set = set` therefore silently stops working: `.add()` isn't
  tracked and `set = set` assigns the same reference (no change → no trigger), so a
  derived reading the set never recomputes. Symptom: clicking a burst did nothing;
  no error, no e2e (the fixture avoids bursts). **Fix: reassign a NEW collection
  (`set = new Set(set).add(x)`; for delete, clone → delete → assign) OR use
  `SvelteSet`/`SvelteMap` from `svelte/reactivity`.** Watch for this on EVERY
  `$state(new Set())`/`$state(new Map())` that is mutated in place — grep the old
  `x = x` self-assigns. (A `$state(0)` companion counter bumped on each mutation,
  like `thumbStatusTick`, is the other escape hatch and is load-bearing where used,
  not "harmless redundancy".) Arrays reassigned wholesale or objects mutated by
  property are fine — this trap is specific to Set/Map.
- **`$effect` runs AFTER the DOM; `$effect.pre` runs BEFORE it — a side-effecting
  `$:` that writes state the template reads IN THE SAME FLUSH must become
  `$effect.pre` (this bit App.svelte, 7 e2e failures).** Svelte-4 `$:` blocks run in
  dependency order BEFORE render. App's `$: if (boxes) { updateVisibleRange() }`
  writes `renderStart`/`renderEnd`, which the `$derived` `visibleItems` reads and the
  grid `{#each}` indexes into `boxes[i]`. Converted to a plain `$effect` (post-DOM),
  a fold/filter that shortened `boxes` rendered the OLD range against the NEW,
  shorter `boxes` → `boxes[i]` undefined → `reading 'y'/'kind'` crash. `$effect.pre`
  restores the pre-render timing. **Rule: `$effect` (post-DOM) is only safe when its
  writes feed the NEXT frame — a body that `tick().then(…)` / schedules an rAF
  (App's `focusPending`, jump/expand-pin reseeds are all fine as plain `$effect`).
  If the write feeds a `$derived`/template read in the current render, use
  `$effect.pre`.**
- **A callback prop fired inside an `$effect` re-enters SYNCHRONOUSLY — Svelte 4's
  `dispatch` did not. This bit Thumb (the hot-path feed tile) and hung the whole
  feed.** Thumb's load effect read `src` AND, via `armAttempt`, called
  `onattempt?.({id: item.id})`. In Svelte 4 that was `dispatch("attempt")` — a
  scheduled event. As a callback prop it runs App's handler right now, which mutates
  `thumbStatus` and re-renders, re-passing a fresh `item` object; because the effect
  also read `item` (identity), the re-render retriggered it → `onattempt` →
  re-render → `effect_update_depth_exceeded`. Fix: track only the stable value the
  effect actually keys on (`src`, a string that already encodes id+mtime+size+retry)
  and run the notifying body untracked — `const url = src; if (url) untrack(() =>
armAttempt(url));`. **Rule: when an effect both reads reactive state and calls a
  parent callback that can write reactive state, untrack the callback path or you
  risk a synchronous loop the Svelte-4 code never had.**
- **No multiple handlers on one event**, and **event modifiers are removed** (wrap
  manually).
- `bind:clientWidth`/`bind:this`/`<svelte:window>`/`<svelte:self>`/transitions/
  `|global` all **still exist** and are unchanged — the `SnapshotStrip`/`TimelineFilter`
  width binds and the `in:scale|global` fold keep working.
- **Named slots do NOT auto-bridge legacy→runes — this one bit us (Modal).** When you
  convert a child to runes and its slots become snippet props, a legacy parent's
  DEFAULT slot content still bridges (it feeds the child's `children` snippet), but a
  legacy `<svelte:fragment slot="footer">` does **NOT** populate the child's `footer`
  snippet — it silently renders nothing. Symptom: the `<dialog>` opened correctly but
  its footer (Cancel/Preview buttons) was empty, so the e2e click timed out with no
  error. Fix: convert each named-slot call site to `{#snippet footer()}…{/snippet}`
  (snippets are valid inside a still-legacy parent). This applies to every remaining
  named-slot consumer — `StatusBar` (3, done), `Toolbar` (2), `ToolGroup` (2),
  `FilterControls` (1), `ToolbarRow` (1): convert the parent's slot syntax in the same
  commit as the child.

## 7. Recommended strategy

**Gradual, e2e-guarded, in two stages.** (The user chose "decide after research" for
the final call and for how the App.svelte refactor #124 sequences in — the
recommendation below is the starting proposal, not a locked decision.)

- **Stage 1 — lift the toolchain, change zero syntax.** Bump the Svelte toolchain
  group (§3) and the Node floor. `sv migrate svelte-5` will offer to bump deps; take
  the dep bump but **not** the codemod yet. Delete the `svelte.config.js` stub. The
  app compiles and runs on Svelte 5 in legacy mode with all 41 components still in
  Svelte-4 syntax. **Gate:** build + 865 unit + 60 e2e green, live smoke test. Commit.
  This is a real, shippable checkpoint that de-risks everything after it.
- **Stage 2 — convert to runes, leaf-first.** Start with the 18 small filter/control
  widgets (< 130 lines), then the mid components, then the choke-point chains
  (`Toolbar` forwards, `TreeNode` recursion, the bindable chain) as coherent units,
  then `App.svelte` **last**. Per component: run the codemod where safe, hand-fix
  dispatchers/lifecycle/slots, remove the `Set`/`Map` clone-to-reassign ritual, gate
  (build + unit + e2e + visual), commit. One PR per few components.
- **App.svelte vs #124.** Two live options, to decide when Stage 2 reaches it:
  (a) extract the logic modules from `App.svelte` first (#124), then migrate small
  focused pieces; or (b) migrate it whole, refactor later. (a) is safer given its
  size; (b) is fewer moving parts. Recommendation: lean (a).

Big-bang (one branch, `sv migrate` everything, hand-fix all, verify at the end) is
faster to "fully modern" but a large un-bisectable change in the file this project
keeps shipping layout bugs from. Not recommended here — the e2e net is per-commit,
so gradual costs little and buys a lot.

## 8. Verification protocol

After **every** dependency bump and **every** component conversion:

1. `npm run build` — the Svelte 5 compiler must accept the file.
2. `npm test` — 865 unit tests green.
3. `npm run test:e2e` — 60 Playwright specs green (the real safety net).
4. **Live visual pass** for anything touching layout/CSS — the `:where()` specificity
   change is invisible to tests that assert geometry but not paint. Drive the real
   app on the 114k library per `CLAUDE.md`'s live-verification rule.
5. After the Electron bump: launch the packaged build; confirm `better-sqlite3`
   loaded (the ABI-rebuild failure mode).

Commit at every green checkpoint — small, focused, reversible — per `CLAUDE.md`.
