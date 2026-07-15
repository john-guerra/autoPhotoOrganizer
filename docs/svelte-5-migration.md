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

**Stage 2 IN PROGRESS — runes conversion, leaf-first.** Converted & gated so far
(20 of 41 components; 865 unit + 60 e2e green after each batch):

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

**Remaining (21), by coupling cluster — all end at a choke point or App.svelte:**
Toolbar cluster (Toolbar, ToolGroup, ToolbarRow, ViewControls, GroupByControl,
SortControl, FilterControls + the 4 filter leaves RatingFilter/OrientationFilter/
KindFilter/SearchFilter, TimelineFilter, SourceControls); FisheyeSidebar;
GroupLabelActions; ShortcutsOverlay (Modal consumer — footer snippet + `onclose`
already done, still dispatches `close`); StatusBar; SelectionBar; ManageLibrary;
Thumb; and **App.svelte last** (5,170 lines — its own careful pass, sequenced
against #124).

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
  named-slot consumer — `StatusBar` (3), `Toolbar` (2), `ToolGroup` (2),
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
