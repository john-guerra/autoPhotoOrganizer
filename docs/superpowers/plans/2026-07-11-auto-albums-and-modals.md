# Auto Albums polish + native-`<dialog>` modal foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Auto Albums explainable and configurable (friendly setup modal, 1-minute default with an Auto button, strftime folder-naming with nested year folders, typed names that survive re-clustering) and put every modal on one native-`<dialog>` foundation.

**Architecture:** All new logic lives in pure, node-testable helpers in `ui/src/lib/albums.js` and a new `ui/src/lib/albumPrefs.js`; Svelte components (`Modal.svelte`, `AlbumsSetupModal.svelte`, edits to `AlbumsView.svelte`) are thin and verified live in the browser. A reusable `Modal.svelte` wraps the native `<dialog>` element and is adopted by the new setup modal first (Phase B), then retrofitted onto `ManageLibrary` and `ShortcutsOverlay` and paired with dropdown-dismissal actions (Phase A). No backend changes — nested album names already create dirs and stay path-traversal-guarded.

**Tech Stack:** Svelte 4 (`export let` / `$:` / `createEventDispatcher` — NOT runes), Vite, d3 (already a root dep; reuse `d3.timeFormat` for date tokens), vitest (node env, pure modules only), Express/better-sqlite3 backend.

## Global Constraints

- **Svelte 4 only** — components use `export let`, `$:`, `createEventDispatcher`. No runes (`$state`/`$props`).
- **ESM everywhere**; **no TypeScript** (plain JS + JSDoc).
- **UI unit tests are pure modules only** (vitest `environment: "node"`). Component/DOM behavior is verified **live in the browser**, never asserted in vitest. Put logic in pure functions.
- **d3 is already a root dependency** — `import * as d3 from "d3"` and use `d3.timeFormat`. Do NOT add a new date dependency.
- **Every file-serving path already routes through `server/lib/safeResolve.js`** — do not bypass it. No backend change is in scope.
- **Never touch real photo folders**; live-test materialize only into a scratch destination.
- **Versioning:** patch bump `package.json` (`2.8.x-alpha`) + a `CHANGELOG.md` entry in the same commit that lands each user-facing slice; user-facing wording, newest first, issue number in parens when one exists.
- **Commit often** — every task ends in a green commit.

---

## File map

| File                                 | Responsibility                                                     | Action                                             |
| ------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------- |
| `ui/src/lib/albums.js`               | pure clustering + naming helpers                                   | modify: add `renderAlbumName`, `computeAlbumNames` |
| `ui/src/lib/albums.test.js`          | tests for the above                                                | modify                                             |
| `ui/src/lib/albumPrefs.js`           | global prefs (pure merge + localStorage wrapper)                   | create                                             |
| `ui/src/lib/albumPrefs.test.js`      | tests for the pure merge                                           | create                                             |
| `ui/src/lib/Modal.svelte`            | reusable native-`<dialog>` wrapper                                 | create                                             |
| `ui/src/lib/AlbumsSetupModal.svelte` | explainer + gap + naming + dest config                             | create                                             |
| `ui/src/lib/AlbumsView.svelte`       | review view: default gap, Auto btn, name persistence, Options btns | modify                                             |
| `ui/src/lib/ViewControls.svelte`     | entry button label + tooltip                                       | modify                                             |
| `ui/src/App.svelte`                  | modal open policy + prefs pass-through                             | modify                                             |
| `ui/src/lib/actions.js`              | `clickOutside` + `onEscape` Svelte actions                         | create                                             |
| `ui/src/lib/actions.test.js`         | test for the pure parts (if any)                                   | create (optional)                                  |
| `ui/src/lib/ManageLibrary.svelte`    | retrofit onto `Modal`                                              | modify                                             |
| `ui/src/lib/ShortcutsOverlay.svelte` | retrofit onto `Modal`                                              | modify                                             |
| `ui/src/lib/SourceControls.svelte`   | dropdown dismissal                                                 | modify                                             |
| `server/db/feed.test.js`             | assert a video clusters into albums                                | modify                                             |
| `package.json`, `CHANGELOG.md`       | version + changelog                                                | modify                                             |

Run tests with `npm test` (vitest run). Run the app with `npm run dev`.

---

# Phase B — Auto Albums

### Task 1: `renderAlbumName` — strftime folder names with `%n` + nesting

**Files:**

- Modify: `ui/src/lib/albums.js`
- Test: `ui/src/lib/albums.test.js`

**Interfaces:**

- Consumes: `d3.timeFormat` (from `d3`).
- Produces: `renderAlbumName(template: string, date: Date, n: number): string` — a folder name that MAY contain `/` for nested folders; `%n` → 1-based index; leading `/` and `..` segments stripped; empty result falls back to `Album {n}`.

- [ ] **Step 1: Write the failing tests**

Add to `ui/src/lib/albums.test.js`:

```js
import { renderAlbumName } from "./albums.js";

describe("renderAlbumName", () => {
  // 2017-01-09 14:30 local. Build via components so the test is TZ-stable.
  const d = new Date(2017, 0, 9, 14, 30, 0);

  it("renders strftime date tokens", () => {
    expect(renderAlbumName("%Y-%m-%d", d, 1)).toBe("2017-01-09");
    expect(renderAlbumName("%Y_%m%b_%d", d, 1)).toBe("2017_01Jan_09");
  });

  it("renders the %n album index (1-based)", () => {
    expect(renderAlbumName("Album %n", d, 3)).toBe("Album 3");
    expect(renderAlbumName("%Y_%n", d, 12)).toBe("2017_12");
  });

  it("supports / for nested folders (year subfolder)", () => {
    expect(renderAlbumName("%Y/%Y_%m%b_%d", d, 1)).toBe("2017/2017_01Jan_09");
  });

  it("strips a leading slash and .. segments (stay relative, no traversal)", () => {
    expect(renderAlbumName("/%Y", d, 1)).toBe("2017");
    expect(renderAlbumName("../%Y", d, 1)).toBe("2017");
    expect(renderAlbumName("%Y/../x", d, 1)).toBe("2017/x");
  });

  it("falls back to Album {n} when the template renders empty", () => {
    expect(renderAlbumName("", d, 4)).toBe("Album 4");
    expect(renderAlbumName("   ", d, 4)).toBe("Album 4");
    expect(renderAlbumName("/", d, 4)).toBe("Album 4");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- albums`
Expected: FAIL — `renderAlbumName is not a function` (or import error).

- [ ] **Step 3: Implement `renderAlbumName`**

Add to the top of `ui/src/lib/albums.js`:

```js
import * as d3 from "d3";
```

Add near `defaultAlbumName`:

```js
/**
 * Render an album folder name from a strftime-style template. Date tokens are
 * delegated to d3.timeFormat; `%n` is the 1-based album index. The result MAY
 * contain "/" to create nested folders (e.g. a year subfolder). Leading "/" and
 * any ".." path segments are stripped so the name is always a safe relative
 * path (the server's safeResolve also blocks traversal, but we keep it clean).
 * An empty render falls back to `Album {n}`.
 * @param {string} template e.g. "%Y/%Y_%m%b_%d"
 * @param {Date} date album start date
 * @param {number} n 1-based album index
 * @returns {string}
 */
export function renderAlbumName(template, date, n) {
  // %n isn't a d3 token — substitute it first (escape any literal % the user
  // typed as %% so d3 doesn't choke), then run d3.timeFormat for the rest.
  const withIndex = String(template ?? "").replace(/%n/g, String(n));
  let rendered = "";
  try {
    rendered = d3.timeFormat(withIndex)(date);
  } catch {
    rendered = withIndex; // unparseable template: use it literally
  }
  const safe = rendered
    .split("/")
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0 && seg !== "..")
    .join("/");
  return safe.length ? safe : `Album ${n}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- albums`
Expected: PASS (all `renderAlbumName` cases).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/albums.js ui/src/lib/albums.test.js
git commit -m "feat(albums): strftime album-name template with %n and nested folders"
```

---

### Task 2: `computeAlbumNames` — names that survive re-clustering

**Files:**

- Modify: `ui/src/lib/albums.js`
- Test: `ui/src/lib/albums.test.js`

**Interfaces:**

- Consumes: `renderAlbumName` (Task 1).
- Produces: `computeAlbumNames(albums, editedNames, template): string[]` where `albums: Array<{startAt:number, ids:number[]}>`, `editedNames: Map<number,string>` keyed by first-photo id. For each album: return `editedNames.get(album.ids[0])` if present, else `renderAlbumName(template, new Date(album.startAt), i+1)`.

- [ ] **Step 1: Write the failing tests**

Add to `ui/src/lib/albums.test.js`:

```js
import { computeAlbumNames } from "./albums.js";

describe("computeAlbumNames", () => {
  const A = { startAt: new Date(2017, 0, 9).getTime(), ids: [10, 11, 12] };
  const B = { startAt: new Date(2017, 0, 11).getTime(), ids: [20, 21] };

  it("uses the template when no name was typed", () => {
    expect(computeAlbumNames([A, B], new Map(), "%Y-%m-%d")).toEqual([
      "2017-01-09",
      "2017-01-11",
    ]);
  });

  it("keeps a typed name keyed to the album's first photo", () => {
    const edited = new Map([[10, "Diana_VR"]]);
    expect(computeAlbumNames([A, B], edited, "%Y-%m-%d")).toEqual([
      "Diana_VR",
      "2017-01-11",
    ]);
  });

  it("drops a typed name once its album no longer starts with that photo", () => {
    const edited = new Map([[10, "Diana_VR"]]);
    // Re-clustered so the first album now starts at id 11, not 10.
    const A2 = { startAt: A.startAt, ids: [11, 12] };
    expect(computeAlbumNames([A2, B], edited, "%Y-%m-%d")).toEqual([
      "2017-01-09",
      "2017-01-11",
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- albums`
Expected: FAIL — `computeAlbumNames is not a function`.

- [ ] **Step 3: Implement `computeAlbumNames`**

Add to `ui/src/lib/albums.js`:

```js
/**
 * Display name for each album, keeping a user-typed name alive across
 * re-clustering as long as the album still starts with the same first photo.
 * @param {Array<{startAt:number, ids:number[]}>} albums
 * @param {Map<number,string>} editedNames keyed by first-photo id
 * @param {string} template strftime template for un-edited albums
 * @returns {string[]}
 */
export function computeAlbumNames(albums, editedNames, template) {
  return albums.map((a, i) => {
    const firstId = a.ids[0];
    const typed = editedNames.get(firstId);
    return typed != null && typed !== ""
      ? typed
      : renderAlbumName(template, new Date(a.startAt), i + 1);
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- albums`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/albums.js ui/src/lib/albums.test.js
git commit -m "feat(albums): first-photo-keyed album names survive re-clustering"
```

---

### Task 3: `albumPrefs` — global preferences (pure merge + localStorage)

**Files:**

- Create: `ui/src/lib/albumPrefs.js`
- Test: `ui/src/lib/albumPrefs.test.js`

**Interfaces:**

- Produces:
  - `DEFAULT_ALBUM_PREFS = { template: "%Y-%m-%d", gapMode: "fixed", fixedGapMs: 60000, k: 2, move: true }`
  - `mergeAlbumPrefs(stored: object|null): object` — defaults shallow-merged with a (possibly partial/garbage) stored object, coercing types and clamping `fixedGapMs >= 1000`, `gapMode ∈ {"fixed","auto"}`.
  - `loadAlbumPrefs(): object` — reads `localStorage["autogallery.albumPrefs"]`, JSON-parses, returns `mergeAlbumPrefs(...)`; safe when `localStorage` is absent.
  - `saveAlbumPrefs(patch: object): object` — merges patch over current, persists, returns the merged prefs.

- [ ] **Step 1: Write the failing tests**

Create `ui/src/lib/albumPrefs.test.js`:

```js
import { describe, it, expect } from "vitest";
import { DEFAULT_ALBUM_PREFS, mergeAlbumPrefs } from "./albumPrefs.js";

describe("mergeAlbumPrefs", () => {
  it("returns defaults for null / empty", () => {
    expect(mergeAlbumPrefs(null)).toEqual(DEFAULT_ALBUM_PREFS);
    expect(mergeAlbumPrefs({})).toEqual(DEFAULT_ALBUM_PREFS);
  });

  it("overrides only provided keys", () => {
    expect(mergeAlbumPrefs({ template: "%Y/%Y_%m%b_%d" })).toMatchObject({
      template: "%Y/%Y_%m%b_%d",
      gapMode: "fixed",
      fixedGapMs: 60000,
    });
  });

  it("rejects a bad gapMode and clamps a tiny gap", () => {
    expect(mergeAlbumPrefs({ gapMode: "bogus" }).gapMode).toBe("fixed");
    expect(mergeAlbumPrefs({ fixedGapMs: 5 }).fixedGapMs).toBe(1000);
  });

  it("defaults the 1-minute fixed gap", () => {
    expect(DEFAULT_ALBUM_PREFS.fixedGapMs).toBe(60000);
    expect(DEFAULT_ALBUM_PREFS.gapMode).toBe("fixed");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- albumPrefs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `albumPrefs.js`**

Create `ui/src/lib/albumPrefs.js`:

```js
// Global (not per-folder) Auto-Albums preferences, persisted in localStorage
// under one key. Pure `mergeAlbumPrefs` is unit-tested; the localStorage
// wrapper is thin and guarded so it's a no-op under SSR/tests.
const KEY = "autogallery.albumPrefs";

export const DEFAULT_ALBUM_PREFS = {
  template: "%Y-%m-%d", // generic default; user saves e.g. "%Y/%Y_%m%b_%d"
  gapMode: "fixed", // "fixed" (a concrete gap) | "auto" (mean + k·stddev)
  fixedGapMs: 60000, // 1 minute
  k: 2, // stddev multiplier for auto mode
  move: true, // materialize default is MOVE
};

/** Defaults merged with a possibly-partial/garbage stored object, type-coerced. */
export function mergeAlbumPrefs(stored) {
  const s = stored && typeof stored === "object" ? stored : {};
  const gapMode = s.gapMode === "auto" ? "auto" : "fixed";
  const fixedGapMs = Number.isFinite(s.fixedGapMs)
    ? Math.max(1000, s.fixedGapMs)
    : DEFAULT_ALBUM_PREFS.fixedGapMs;
  const k = Number.isFinite(s.k) ? s.k : DEFAULT_ALBUM_PREFS.k;
  return {
    template:
      typeof s.template === "string" && s.template.length
        ? s.template
        : DEFAULT_ALBUM_PREFS.template,
    gapMode,
    fixedGapMs,
    k,
    move: typeof s.move === "boolean" ? s.move : DEFAULT_ALBUM_PREFS.move,
  };
}

function storage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadAlbumPrefs() {
  const st = storage();
  if (!st) return { ...DEFAULT_ALBUM_PREFS };
  try {
    return mergeAlbumPrefs(JSON.parse(st.getItem(KEY) || "null"));
  } catch {
    return { ...DEFAULT_ALBUM_PREFS };
  }
}

export function saveAlbumPrefs(patch) {
  const merged = mergeAlbumPrefs({ ...loadAlbumPrefs(), ...patch });
  const st = storage();
  if (st) {
    try {
      st.setItem(KEY, JSON.stringify(merged));
    } catch {
      /* ignore quota/denied */
    }
  }
  return merged;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- albumPrefs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/albumPrefs.js ui/src/lib/albumPrefs.test.js
git commit -m "feat(albums): global album prefs store (1-min default, strftime template)"
```

---

### Task 4: `Modal.svelte` — reusable native-`<dialog>` wrapper

**Files:**

- Create: `ui/src/lib/Modal.svelte`

**Interfaces:**

- Produces a component with props `open` (two-way `bind:open`), `title` (string), `size` (`"sm"|"md"|"lg"`, default `"md"`), `dismissible` (default `true`); slots: default (body), `footer`; events: `close`. When `open` → calls `showModal()`; when false → `close()`. Emits `close` on Esc (`cancel`), backdrop click, and the ✕ button.

_(No vitest — component behavior is verified live in Task 14. Correctness here is by inspection + browser check.)_

- [ ] **Step 1: Create `ui/src/lib/Modal.svelte`**

```svelte
<script>
  // Reusable modal built on the native <dialog> element. We rely on the
  // platform for the hard parts: top-layer rendering (no z-index), ::backdrop,
  // Esc-to-close (the `cancel` event), focus trapping, and focus restoration to
  // the invoker on close. Borrows Bootstrap's header/body/footer *structure*,
  // not its CSS.
  import { createEventDispatcher } from "svelte";

  export let open = false;
  export let title = "";
  export let size = "md"; // sm | md | lg
  export let dismissible = true;

  const dispatch = createEventDispatcher();
  let dialogEl;

  // Drive the imperative dialog API from the reactive `open` prop. Guard on the
  // dialog's real .open so we never double-call showModal()/close() (which would
  // throw or loop).
  $: if (dialogEl) {
    if (open && !dialogEl.open) dialogEl.showModal();
    else if (!open && dialogEl.open) dialogEl.close();
  }

  function requestClose() {
    if (!dismissible) return;
    open = false; // keep bind:open in sync
    dispatch("close");
  }

  // Native Esc fires `cancel`; preventDefault so WE own the close path (sets
  // open=false + dispatches), keeping the parent's state authoritative.
  function onCancel(e) {
    e.preventDefault();
    requestClose();
  }

  // Backdrop click: a click whose target is the <dialog> itself (not the inner
  // content wrapper) means the user clicked the ::backdrop area.
  function onDialogClick(e) {
    if (e.target === dialogEl) requestClose();
  }
</script>

<dialog
  bind:this={dialogEl}
  class="modal size-{size}"
  on:cancel={onCancel}
  on:click={onDialogClick}
  on:close={() => {
    if (open) requestClose();
  }}
  aria-label={title}
>
  <div class="modal-content">
    <header class="modal-header">
      <h2>{title}</h2>
      {#if dismissible}
        <button class="modal-close" title="Close (Esc)" on:click={requestClose}
          >✕</button
        >
      {/if}
    </header>
    <div class="modal-body">
      <slot />
    </div>
    {#if $$slots.footer}
      <footer class="modal-footer">
        <slot name="footer" />
      </footer>
    {/if}
  </div>
</dialog>

<style>
  .modal {
    padding: 0;
    border: 1px solid #333;
    border-radius: 10px;
    background: #1e1e1e;
    color: #e8e8e8;
    max-height: 85vh;
    width: min(560px, 92vw);
  }
  .modal.size-sm {
    width: min(420px, 92vw);
  }
  .modal.size-lg {
    width: min(760px, 92vw);
  }
  .modal::backdrop {
    background: rgba(0, 0, 0, 0.55);
  }
  .modal-content {
    display: flex;
    flex-direction: column;
    max-height: 85vh;
  }
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.85rem 1.1rem;
    border-bottom: 1px solid #2a2a2a;
  }
  .modal-header h2 {
    margin: 0;
    font-size: 1.05rem;
  }
  .modal-close {
    background: none;
    border: none;
    color: #999;
    font-size: 1rem;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;
  }
  .modal-close:hover {
    background: #2c2c2c;
    color: #fff;
  }
  .modal-body {
    padding: 1rem 1.1rem;
    overflow-y: auto;
  }
  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.75rem 1.1rem;
    border-top: 1px solid #2a2a2a;
  }
</style>
```

- [ ] **Step 2: Verify it builds**

Run: `npm run build`
Expected: build succeeds (no Svelte compile errors).

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/Modal.svelte
git commit -m "feat(ui): reusable Modal built on the native <dialog> element"
```

---

### Task 5: `AlbumsSetupModal.svelte` — explainer + gap + naming + destination

**Files:**

- Create: `ui/src/lib/AlbumsSetupModal.svelte`

**Interfaces:**

- Consumes: `Modal.svelte`; `renderAlbumName` (Task 1); album prefs shape (Task 3); `parseDuration`/`fmtDur` (copy the two helpers from `AlbumsView.svelte` — they're small and self-contained — or, preferred, export them from `albums.js` and import in both; see note).
- Props: `open` (bind), `prefs` (the album prefs object), `sampleDate` (a `Date` for the live preview — the first album's start, or now), `dest` (string), `hasNativePicker` (bool).
- Events: `apply` with `detail = { template, gapMode, fixedGapMs, move, dest }`; `close`.

> **DRY note:** `parseDuration`, `fmtDur`, `threshAsInput` currently live inside `AlbumsView.svelte`. Move them into `albums.js` as exports (pure functions), update `AlbumsView.svelte` to import them, and import them here too. Do this move as Step 1 so both components share one copy.

- [ ] **Step 1: Extract shared duration helpers into `albums.js`**

Cut `parseDuration`, `fmtDur`, and `threshAsInput` from `AlbumsView.svelte` and paste them into `ui/src/lib/albums.js` as `export function`s (unchanged bodies). In `AlbumsView.svelte`, import them:

```js
import {
  computeGapStats,
  autoThresholdMs,
  clusterByGap,
  renderAlbumName,
  computeAlbumNames,
  parseDuration,
  fmtDur,
  threshAsInput,
} from "./albums.js";
```

Add a quick test in `albums.test.js` to lock the moved behavior:

```js
import { parseDuration, fmtDur } from "./albums.js";
describe("parseDuration/fmtDur (moved from AlbumsView)", () => {
  it("parses compact durations", () => {
    expect(parseDuration("90m")).toBe(90 * 60000);
    expect(parseDuration("2d")).toBe(2 * 86400000);
    expect(parseDuration("garbage")).toBeNull();
  });
  it("formats a 1-minute gap", () => {
    expect(fmtDur(60000)).toBe("1 min");
  });
});
```

Run: `npm test -- albums` → PASS. Commit:

```bash
git add ui/src/lib/albums.js ui/src/lib/albums.test.js ui/src/lib/AlbumsView.svelte
git commit -m "refactor(albums): share duration helpers from albums.js"
```

- [ ] **Step 2: Create `ui/src/lib/AlbumsSetupModal.svelte`**

```svelte
<script>
  import { createEventDispatcher } from "svelte";
  import Modal from "./Modal.svelte";
  import { renderAlbumName, parseDuration, fmtDur } from "./albums.js";

  export let open = false;
  export let prefs;
  export let sampleDate = new Date();
  export let dest = "";
  export let hasNativePicker = false;

  const dispatch = createEventDispatcher();

  // Local editable copy so Cancel discards. Re-seed when the modal (re)opens.
  let template = prefs.template;
  let gapMode = prefs.gapMode; // "fixed" | "auto"
  let fixedGapMs = prefs.fixedGapMs;
  let move = prefs.move;
  let localDest = dest;
  let gapInput = "";
  $: if (open) {
    // one-shot reseed guard
  }
  let lastOpen = false;
  $: if (open && !lastOpen) {
    template = prefs.template;
    gapMode = prefs.gapMode;
    fixedGapMs = prefs.fixedGapMs;
    move = prefs.move;
    localDest = dest;
    gapInput = fmtDur(fixedGapMs);
    lastOpen = true;
  }
  $: if (!open) lastOpen = false;

  $: preview = renderAlbumName(template, sampleDate, 1);

  const TOKENS = [
    ["%Y", "2017"],
    ["%m", "01"],
    ["%b", "Jan"],
    ["%B", "January"],
    ["%d", "09"],
    ["%H", "14"],
    ["%M", "30"],
    ["%n", "album #"],
    ["/", "subfolder"],
  ];
  function insertToken(tok) {
    template = template + tok;
  }

  function commitGap() {
    const ms = parseDuration(gapInput);
    if (ms != null) {
      fixedGapMs = ms;
      gapMode = "fixed";
    }
    gapInput = fmtDur(fixedGapMs);
  }
  function useAuto() {
    gapMode = "auto";
  }
  function useFixed() {
    gapMode = "fixed";
  }

  async function pickDest() {
    const p = await window.autogallery?.pickFolder();
    if (p) localDest = p;
  }

  function apply() {
    dispatch("apply", {
      template,
      gapMode,
      fixedGapMs,
      move,
      dest: localDest.trim(),
    });
    open = false;
  }
  function cancel() {
    open = false;
    dispatch("close");
  }
</script>

<Modal bind:open title="Auto Albums" size="lg" on:close={cancel}>
  <section class="how">
    <p>
      AutoGallery looks at <strong>when each photo and video was taken</strong>.
      When there's a long pause between shots, it starts a new album. Drag the
      split gap to make albums bigger or smaller — or let AutoGallery pick a gap
      automatically. Nothing is moved until you review and click Materialize.
    </p>
    <svg class="gap-diagram" viewBox="0 0 320 30" aria-hidden="true">
      <!-- cluster, big gap, cluster -->
      {#each [8, 16, 24, 34, 44] as x}<circle cx={x} cy="15" r="4" />{/each}
      {#each [150, 160, 172, 184] as x}<circle cx={x} cy="15" r="4" />{/each}
      {#each [286, 296, 306] as x}<circle cx={x} cy="15" r="4" />{/each}
      <text x="95" y="19" class="gap-label">↤ new album ↦</text>
    </svg>
  </section>

  <section class="field">
    <label class="lbl">Split gap</label>
    <div class="gap-row">
      <button class:active={gapMode === "fixed"} on:click={useFixed}
        >Fixed</button
      >
      <input
        class="gap-input"
        bind:value={gapInput}
        on:blur={commitGap}
        on:keydown={(e) => e.key === "Enter" && commitGap()}
        placeholder="e.g. 1m, 30m, 2h, 1d"
        disabled={gapMode !== "fixed"}
      />
      <button
        class:active={gapMode === "auto"}
        on:click={useAuto}
        title="mean + k·stddev of gaps">Auto</button
      >
    </div>
    <p class="hint">
      {gapMode === "auto"
        ? "Auto: AutoGallery picks the gap from this set's rhythm."
        : `Fixed gap: ${fmtDur(fixedGapMs)}.`}
    </p>
  </section>

  <section class="field">
    <label class="lbl">Folder naming</label>
    <input
      class="tpl"
      bind:value={template}
      spellcheck="false"
      placeholder="%Y/%Y_%m%b_%d"
    />
    <div class="tokens">
      {#each TOKENS as [tok, ex]}
        <button class="token" title={ex} on:click={() => insertToken(tok)}
          >{tok}</button
        >
      {/each}
    </div>
    <p class="preview">
      Preview: <code>{localDest || "<destination>"}/{preview}</code>
    </p>
  </section>

  <section class="field">
    <label class="lbl">Save by</label>
    <div class="move-row">
      <label><input type="radio" value={true} bind:group={move} /> Move</label>
      <label><input type="radio" value={false} bind:group={move} /> Copy</label>
    </div>
    <div class="dest-row">
      <input
        class="dest"
        bind:value={localDest}
        placeholder="/materialize/destination"
        spellcheck="false"
      />
      {#if hasNativePicker}<button on:click={pickDest}>Choose…</button>{/if}
    </div>
  </section>

  <svelte:fragment slot="footer">
    <button on:click={cancel}>Cancel</button>
    <button class="primary" on:click={apply}>Preview albums</button>
  </svelte:fragment>
</Modal>

<style>
  .how p {
    margin: 0 0 0.5rem;
    line-height: 1.5;
    color: #cfcfcf;
    font-size: 0.9rem;
  }
  .gap-diagram {
    width: 100%;
    height: 30px;
  }
  .gap-diagram circle {
    fill: #4c9aff;
  }
  .gap-diagram .gap-label {
    fill: #7a7a7a;
    font-size: 9px;
  }
  .field {
    margin-top: 1rem;
  }
  .lbl {
    display: block;
    font-size: 0.8rem;
    color: #9a9a9a;
    margin-bottom: 0.35rem;
  }
  .gap-row,
  .move-row,
  .dest-row,
  .tokens {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .gap-row button,
  .token,
  .dest-row button {
    background: #2a2a2a;
    border: 1px solid #3a3a3a;
    color: #e8e8e8;
    border-radius: 6px;
    padding: 4px 10px;
    cursor: pointer;
    font-size: 0.8rem;
  }
  .gap-row button.active {
    background: #2e8b57;
    border-color: #2e8b57;
    color: #06121f;
  }
  .gap-input,
  .tpl,
  .dest {
    background: #0d0d0d;
    border: 1px solid #333;
    border-radius: 6px;
    color: inherit;
    padding: 5px 8px;
    font: inherit;
    font-size: 0.85rem;
  }
  .tpl {
    width: 100%;
  }
  .dest {
    flex: 1;
  }
  .token {
    font-variant-numeric: tabular-nums;
  }
  .hint,
  .preview {
    font-size: 0.8rem;
    color: #9a9a9a;
    margin: 0.4rem 0 0;
  }
  .preview code {
    color: #7fe0a8;
    word-break: break-all;
  }
  .primary {
    background: #2e8b57;
    border: 1px solid #2e8b57;
    color: #06121f;
    font-weight: 600;
    border-radius: 6px;
    padding: 5px 12px;
    cursor: pointer;
  }
  button {
    background: #222;
    border: 1px solid #3a3a3a;
    color: #e8e8e8;
    border-radius: 6px;
    padding: 5px 12px;
    cursor: pointer;
  }
</style>
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/AlbumsSetupModal.svelte
git commit -m "feat(albums): setup modal — how-it-works, split gap, strftime naming, dest"
```

---

### Task 6: `AlbumsView.svelte` — default gap, Auto button, name persistence, Options

**Files:**

- Modify: `ui/src/lib/AlbumsView.svelte`

**Interfaces:**

- Consumes: prefs shape (Task 3); `computeAlbumNames`, `autoThresholdMs`, `computeGapStats`, `clusterByGap` (Tasks 1–2 + existing); `AlbumsSetupModal` (Task 5).
- New props: `prefs` (album prefs object), passed from App.
- Emits: `openoptions` (ask App to open the setup modal), plus existing `relimit`/`close`/`openphoto`.

- [ ] **Step 1: Threshold default from prefs + Auto button**

Replace the threshold state block. Remove `let k = 2;` default init in favor of prefs, and derive the threshold from `gapMode`:

```js
export let prefs;
// Working copy of the gap settings, seeded from prefs and updated live.
let gapMode = prefs.gapMode; // "fixed" | "auto"
let fixedGapMs = prefs.fixedGapMs;
let k = prefs.k;
$: stats = computeGapStats(times);
$: thresholdMs = gapMode === "auto" ? autoThresholdMs(stats, k) : fixedGapMs;
```

Keep the existing type-exact editor, but have it set `fixedGapMs` + `gapMode="fixed"`. Add an **Auto** button in the bar:

```svelte
<button
  class="mat-btn"
  class:active={gapMode === "auto"}
  on:click={() => (gapMode = "auto")}
  title="Pick the split gap automatically (mean + k·stddev)">Auto</button
>
```

And the slider, when moved, sets `gapMode="fixed"` and maps its value to `fixedGapMs` (reuse the existing slider but bind it to a fixed-ms scale; simplest: keep `k` slider for auto and add a separate fixed-gap slider shown when `gapMode==="fixed"`). Minimal approach: keep one slider that edits `fixedGapMs` on a log scale from 30s→2d and a separate `Auto` toggle button; `onSlider` sets `gapMode="fixed"`.

- [ ] **Step 2: Name persistence keyed to first photo**

Replace the `names` / `lastAlbumSig` re-seed block with an `editedNames` map + derived display names:

```js
import { computeAlbumNames } from "./albums.js";
let editedNames = new Map(); // firstPhotoId -> typed name
$: names = computeAlbumNames(albums, editedNames, prefs.template);
function onNameInput(i, value) {
  const firstId = albums[i].ids[0];
  if (value == null || value === "") editedNames.delete(firstId);
  else editedNames.set(firstId, value);
  editedNames = editedNames; // trigger Svelte reactivity
}
```

Update the album name `<input>` to `value={names[i]}` + `on:input={(e) => onNameInput(i, e.target.value)}` (no `bind:value`).

Update `namedAlbums()` to read from `names[i]` (the derived array) rather than the old `names` state — the collision-dedup stays.

- [ ] **Step 3: Options / How-it-works buttons + embed the setup modal**

Add to the bar:

```svelte
<button
  class="mat-btn"
  on:click={() => (setupOpen = true)}
  title="Naming & gap options">⚙ Options</button
>
```

Add near the top of the component:

```js
import AlbumsSetupModal from "./AlbumsSetupModal.svelte";
let setupOpen = false;
function onSetupApply(e) {
  const p = e.detail;
  gapMode = p.gapMode;
  fixedGapMs = p.fixedGapMs;
  move = p.move;
  dest = p.dest || dest;
  // Persist globally + reflect the new template into names (un-edited re-derive).
  dispatch("prefschange", p);
  setupOpen = false;
}
```

And render `<AlbumsSetupModal bind:open={setupOpen} {prefs} sampleDate={new Date(albums[0]?.startAt ?? Date.now())} {dest} {hasNativePicker} on:apply={onSetupApply} />` at the end of the markup.

Since the template lives in `prefs`, and `names` reads `prefs.template`, ensure the parent updates `prefs` on `prefschange` so `names` recompute (or keep a local `template` mirror updated in `onSetupApply` and use it in the `computeAlbumNames` call).

- [ ] **Step 4: Verify build + existing tests**

Run: `npm run build && npm test`
Expected: build ok; tests green.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/AlbumsView.svelte
git commit -m "feat(albums): 1-min default + Auto button, first-photo-keyed names, Options"
```

---

### Task 7: `ViewControls.svelte` — Auto Albums button + tooltip

**Files:**

- Modify: `ui/src/lib/ViewControls.svelte:73-82`

- [ ] **Step 1: Rename label + tooltip**

```svelte
<button
  class="reveal-btn"
  class:active={albumMode}
  on:click={() => (albumMode ? (albumMode = false) : dispatch("detectalbums"))}
  disabled={detectingAlbums}
  title="Group the photos you're viewing into albums by the pauses between shots — a long gap starts a new album. Preview, rename, then save them into folders (photos and videos)."
>
  {detectingAlbums
    ? "Detecting…"
    : albumMode
      ? "✕ Auto Albums"
      : "▤ Auto Albums"}
</button>
```

- [ ] **Step 2: Verify build**

Run: `npm run build` → succeeds.

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/ViewControls.svelte
git commit -m "feat(albums): rename entry to Auto Albums with a clearer tooltip"
```

---

### Task 8: `App.svelte` — modal open policy + prefs pass-through

**Files:**

- Modify: `ui/src/App.svelte` (around `detectAlbums` ~line 1054, the `<AlbumsView>` usage ~line 2829, and state decls ~line 261-266)

**Interfaces:**

- Consumes: `loadAlbumPrefs`, `saveAlbumPrefs` (Task 3); `AlbumsView` new `prefs` prop + `prefschange`/`openoptions` events.

- [ ] **Step 1: Load prefs + first-entry-per-session flag**

Add to the script:

```js
import { loadAlbumPrefs, saveAlbumPrefs } from "./lib/albumPrefs.js";
let albumPrefs = loadAlbumPrefs();
let albumSetupSeenThisSession = false;
```

- [ ] **Step 2: Show setup modal on first entry**

The setup modal lives inside `AlbumsView`, so "first entry" is handled by opening it automatically. Simplest: pass an `autoOpenSetup` prop to `AlbumsView` that is true when `!albumSetupSeenThisSession`, and set the flag once entered. In `detectAlbums`, after `albumMode = true;` add:

```js
if (!albumSetupSeenThisSession) {
  albumSetupSeenThisSession = true; // AlbumsView opens setup on mount when this was false
}
```

Pass `autoOpenSetup={/* computed before flip */}` — capture the pre-flip value into a local and pass it. (Alternatively hold the "should auto-open" boolean in App and bind it.)

- [ ] **Step 3: Wire prefs + prefschange**

Update the `<AlbumsView>` usage:

```svelte
<AlbumsView
  photos={albumPhotos}
  truncated={albumTruncated}
  limit={albumLimit}
  defaultDest={focusPath || ""}
  prefs={albumPrefs}
  {hasNativePicker}
  on:relimit={(e) => onAlbumRelimit(e.detail)}
  on:close={() => (albumMode = false)}
  on:openphoto={(e) => openPhotoById(e.detail.id)}
  on:prefschange={(e) => (albumPrefs = saveAlbumPrefs(e.detail))}
/>
```

- [ ] **Step 4: Verify build**

Run: `npm run build` → succeeds.

- [ ] **Step 5: Commit**

```bash
git add ui/src/App.svelte
git commit -m "feat(albums): load/persist album prefs, open setup on first entry"
```

---

### Task 9: Backend — assert videos cluster into albums

**Files:**

- Modify: `server/db/feed.test.js` (the `workingSetTimeline` describe block ~line 1098)

- [ ] **Step 1: Write the failing test**

Find how existing tests insert photos in `feed.test.js` (a helper like `insertPhoto`/seed rows). Add a test in the `workingSetTimeline` describe that seeds a **video** row (e.g. `kind: "video"` / `mime` starting `video/`, matching the schema's video marker — check `server/db/schema.js`) and asserts it appears in the returned `photos`:

```js
it("includes videos in the album timeline (user story: videos join albums)", () => {
  // seed one image + one video with taken_at timestamps, then:
  const { photos } = workingSetTimeline(db, {}, 100);
  const ids = photos.map((p) => p.id);
  expect(ids).toContain(videoId); // the seeded video row
});
```

Match the existing seeding style in this file exactly (same insert helper, same required columns). Inspect `schema.js` for how a video row is distinguished (e.g. `is_video`, `kind`, or `mime`).

- [ ] **Step 2: Run to verify it fails or passes**

Run: `npm test -- feed`
Expected: PASS if videos are already unfiltered (documents the guarantee). If it FAILS, that's a real bug — `workingSetTimeline`'s filter is excluding videos; fix `buildFilter`/the query to include them, then re-run to green.

- [ ] **Step 3: Commit**

```bash
git add server/db/feed.test.js
git commit -m "test(albums): guarantee videos are included in the album timeline"
```

---

# Phase A — Modal foundation retrofit

### Task 10: Retrofit `ManageLibrary.svelte` onto `Modal`

**Files:**

- Modify: `ui/src/lib/ManageLibrary.svelte`

- [ ] **Step 1: Replace the hand-rolled backdrop with `<Modal>`**

Import and wrap. Replace the outer `.manage-library-backdrop` / `.manage-library-panel` / `<header>` markup with:

```svelte
<script>
  import Modal from "./Modal.svelte";
  // ...existing imports & logic unchanged...
</script>

<Modal
  open={true}
  title="Manage library"
  size="md"
  on:close={() => dispatch("close")}
>
  <!-- existing {#if message}…, and all <section> blocks, unchanged -->
</Modal>
```

Delete the `.manage-library-backdrop`, `.manage-library-panel`, and now-unused `header`/`h2`/`.close-btn` CSS (Modal owns them). Keep all section-specific CSS. Keep all logic (`confirm()` calls stay — out of scope).

- [ ] **Step 2: Verify build**

Run: `npm run build` → succeeds.

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/ManageLibrary.svelte
git commit -m "refactor(ui): ManageLibrary on the native-dialog Modal (Esc/focus/restore)"
```

---

### Task 11: Retrofit `ShortcutsOverlay.svelte` onto `Modal` (reconcile Esc)

**Files:**

- Modify: `ui/src/lib/ShortcutsOverlay.svelte`
- Modify: `ui/src/App.svelte` (the `onKeydown` Esc/`?` handling for `shortcutsHelpOpen`)

**Context:** Today `App.svelte` owns Esc/`?` for the shortcuts overlay (single keyboard owner). The native `<dialog>` also closes on Esc via `cancel`. To avoid a double-toggle: let the **Modal own Esc** (it dispatches `close`), and in `App.svelte` **stop toggling `shortcutsHelpOpen` on Esc** — keep only the `?` toggle. The `?` key still opens; Esc closes via the dialog.

- [ ] **Step 1: Wrap in `<Modal>`**

```svelte
<script>
  import Modal from "./Modal.svelte";
  import { createEventDispatcher } from "svelte";
  const dispatch = createEventDispatcher();
  const close = () => dispatch("close");
  const groups = [/* unchanged */];
</script>

<Modal open={true} title="Keyboard shortcuts" size="lg" on:close={close}>
  <div class="groups"><!-- unchanged --></div>
  <svelte:fragment slot="footer">
    <span>Press <kbd>?</kbd> anytime to toggle this list.</span>
  </svelte:fragment>
</Modal>
```

Delete `.shortcuts-backdrop` / `.shortcuts-panel` / header CSS; keep `.groups`, `kbd`, etc.

- [ ] **Step 2: Remove the App-level Esc branch for shortcuts**

In `App.svelte`'s `onKeydown`, find where `Escape` closes `shortcutsHelpOpen` and remove that branch (the Modal now closes itself on Esc and dispatches `close` → App sets `shortcutsHelpOpen=false`). Leave the `?` toggle intact. Verify Esc still isn't swallowed for other contexts (loupe/stack) — only remove the shortcuts-specific branch.

- [ ] **Step 3: Verify build**

Run: `npm run build` → succeeds.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/ShortcutsOverlay.svelte ui/src/App.svelte
git commit -m "refactor(ui): ShortcutsOverlay on Modal; dialog owns Esc (no double-toggle)"
```

---

### Task 12: Dropdown dismissal — `clickOutside` / `onEscape` actions

**Files:**

- Create: `ui/src/lib/actions.js`
- Modify: `ui/src/lib/SourceControls.svelte`

**Interfaces:**

- Produces: `clickOutside(node, callback)` and `onEscape(node, callback)` Svelte actions (standard `{ destroy }` shape).

- [ ] **Step 1: Create `ui/src/lib/actions.js`**

```js
/**
 * Svelte action: call `callback` when a pointerdown lands outside `node`.
 * Used to dismiss popovers/dropdowns. Uses capture so it fires before inner
 * handlers can stopPropagation.
 */
export function clickOutside(node, callback) {
  function onPointerDown(e) {
    if (!node.contains(e.target)) callback();
  }
  document.addEventListener("pointerdown", onPointerDown, true);
  return {
    destroy() {
      document.removeEventListener("pointerdown", onPointerDown, true);
    },
  };
}

/** Svelte action: call `callback` when Escape is pressed while mounted. */
export function onEscape(node, callback) {
  function onKey(e) {
    if (e.key === "Escape") callback();
  }
  document.addEventListener("keydown", onKey);
  return {
    destroy() {
      document.removeEventListener("keydown", onKey);
    },
  };
}
```

- [ ] **Step 2: Apply to the Library + Add-folder popovers**

In `SourceControls.svelte`, import and use on the open popovers:

```svelte
<script>
  import { clickOutside, onEscape } from "./actions.js";
</script>

{#if libraryOpen}
  <ul
    class="library-panel"
    use:clickOutside={() => (libraryOpen = false)}
    use:onEscape={() => (libraryOpen = false)}
  >
    <!-- unchanged -->
  </ul>
{/if}
```

Do the same for the `{#if addFolderOpen}` `.add-panel`.

- [ ] **Step 3: Verify build**

Run: `npm run build` → succeeds.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/actions.js ui/src/lib/SourceControls.svelte
git commit -m "feat(ui): dismiss Library/Add-folder dropdowns on outside-click + Esc"
```

---

# Wrap-up

### Task 13: Version bump, CHANGELOG, file deferred issues

**Files:**

- Modify: `package.json`, `CHANGELOG.md`

- [ ] **Step 1: Bump patch + changelog**

Bump `package.json` version `2.8.2-alpha` → `2.8.3-alpha`. Add to the top of `CHANGELOG.md`:

```markdown
## 2.8.3-alpha

- Auto Albums: renamed from "Albums" with a clear tooltip, and a friendly setup
  dialog explaining how time-gap grouping works.
- Auto Albums: split gap now starts at 1 minute with an "Auto" button for the
  automatic (statistical) gap.
- Auto Albums: configurable folder naming with date tokens (e.g. %Y/%Y_%m%b_%d),
  including nested year folders; a live preview shows the resulting path.
- Auto Albums: album names you type are kept when you re-adjust the split gap.
- Modals now use the native dialog element — Esc closes them, focus is trapped
  and restored, and the Library/Add-folder menus close when you click away.
```

- [ ] **Step 2: File the two deferred GitHub issues**

```bash
gh issue create --repo john-guerra/autoPhotoOrganizer \
  --title "Auto Albums: AI-generated meaningful album names" \
  --body "Explore generating descriptive album names from photo content (e.g. 'Beach day', 'Diana's birthday'). Must keep the app free/offline — prefer a local or opt-in model, not a paid API. Deferred from the Auto Albums polish spec (docs/superpowers/specs/2026-07-11-auto-albums-and-modals-design.md)."

gh issue create --repo john-guerra/autoPhotoOrganizer \
  --title "Auto Albums: shift the capture date of a whole album" \
  --body "Let the user correct a wrong camera clock by shifting every photo's timestamp in an album by a fixed offset (and re-cluster). Common when the camera's time was set wrong on a trip. Deferred from the Auto Albums polish spec."
```

- [ ] **Step 3: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore(release): 2.8.3-alpha — Auto Albums polish + native-dialog modals"
```

---

### Task 14: Live browser verification (project convention — required)

**No file changes.** Per `docs/ROADMAP.md` + CLAUDE.md, App.svelte / CSS / modal focus behavior must be verified live, not just by tests.

- [ ] Run `npm run dev`; open the app on a test folder (read-only test folders per project convention).
- [ ] Click **Auto Albums** → the setup dialog appears; confirm the how-it-works copy + diagram, **1-minute** default gap, **Auto** button, template **live preview** showing `<dest>/2017/2017_01Jan_09` for a `%Y/%Y_%m%b_%d` template.
- [ ] Press **Esc** → dialog closes; confirm focus returns to the Auto Albums button.
- [ ] Re-open via **⚙ Options**; click **Preview albums**; in the review, **type an album name**, then **move the split slider** → the typed name is **kept** (album still starts with the same first photo).
- [ ] Toggle **Auto** in the review → boundaries recompute from the statistical gap.
- [ ] Materialize (move OR copy) into a **scratch destination** (never a real photo folder); confirm the **nested year folder** is created and photos+videos land inside.
- [ ] Open **Manage library** and **Shortcuts (?)** → both open as dialogs, Esc closes, focus is trapped/restored.
- [ ] Open **Library ▾**, click elsewhere → it dismisses; open it and press **Esc** → it dismisses.
- [ ] Reload the app, open Auto Albums again → your saved **template + gap + move/copy** are remembered.

---

## Self-review notes (author)

- **Spec coverage:** button rename (T7), setup modal (T4/T5), 1-min default + Auto (T5/T6), strftime naming + nesting (T1/T5), name persistence (T2/T6), prefs persistence (T3/T8), videos (T9), Modal + retrofits + dropdowns (T4/T10/T11/T12), deferred issues (T13), live verify (T14). All covered.
- **Type consistency:** `renderAlbumName(template,date,n)`, `computeAlbumNames(albums,editedNames,template)`, prefs shape `{template,gapMode,fixedGapMs,k,move}`, and the setup modal `apply` detail `{template,gapMode,fixedGapMs,move,dest}` are used consistently across T1–T8.
- **Known soft spots to resolve during execution (flag in review, don't guess):**
  (a) T6 Step 1 — exact slider mapping for a fixed-ms gap (log scale) vs. keeping the k-slider only for auto; pick the simplest that keeps one control authoritative. (b) T8 Step 2 — the cleanest way to pass "auto-open setup on first entry" (an `autoOpenSetup` prop captured pre-flip). (c) T9 — match the file's existing row-seeding helper and the schema's video marker exactly. These are implementation details, not open design questions.

```
---

# PLAN REVISION 1 (2026-07-11) — post architect review

This revision GOVERNS. Spec Revision 1 is the source of truth. Phase 2 (in-feed
albums, nested-path grouping, worker/SSE subsystem) is NOT in this plan — it gets
its own brainstorm/spec. Global Constraints above still apply, plus:

- **Materialize fs must be async (`fs/promises`), not sync-plus-`setImmediate`.**
  A single large file must not block. Keep same-volume `renameSync`.
- **The freeze only reproduces in a packaged/Electron build** (dev runs the
  server as a separate process). Verify #3 accordingly.

### Revised Phase-1 task order
Foundation done: **T1** `renderAlbumName` ✅, **T2** `computeAlbumNames` ✅.
Unchanged-from-original and still valid: **T3** albumPrefs, **T4** Modal, **T7**
button/tooltip, **T10** ManageLibrary retrofit, **T11** ShortcutsOverlay retrofit,
**T12** dropdown dismissal. **T5/T6/T8** (AlbumsView + setup modal wiring) proceed
but are TIME-BOXED interim; do the minimum, do NOT deep-polish the slider. **T9**
videos test = honest regression guard (they're already unfiltered — do not claim
it's likely to catch a bug). **T13** release/issues amended (below). **T14** live
verify amended (Electron build for the freeze).

New tasks **T15–T19** below. Suggested execution order: T3, T4, then T15–T17
(backend materialize) can run before or alongside the AlbumsView UI (T5/T6/T8),
T18 (grouping) is independent, T10–T12 (modal retrofits) independent, T19 test
last.

---

### Task 15: Materialize async fs — kill the beachball

**Files:** Modify `server/api.js` (`copyIdsIntoFolder` ~181-219, `moveFile`
~145-160); Test: `server/copy.test.js` (or `server/api.test.js` where copy is
tested).

**Interfaces:** `copyIdsIntoFolder` stays same signature but becomes `async`
(returns a Promise). Its caller in `/api/albums/materialize` (~1376) already runs
in an async IIFE and must `await` it. Any other caller (export path ~1249) must
`await` too — grep `copyIdsIntoFolder(` and update all call sites.

- [ ] **Step 1 (test):** Add a test that materializing/copying N files yields to
  the event loop — e.g. spy that a `setImmediate`/`await` boundary occurs between
  files, or (simpler) assert the function is async and resolves with the same
  `{copied,moved,skipped,manifest}` shape on a temp dir of small files. Use the
  existing temp-dir + AUTOGALLERY_HOME isolation pattern already in the copy test.
- [ ] **Step 2:** Run → RED (function is sync / not awaited).
- [ ] **Step 3 (impl):** Convert the per-file loop to `for...of` with
  `await fsp.copyFile(src, dst)` (import `import * as fsp from "node:fs/promises"`)
  for the copy path; in move mode keep `renameSync` for same-volume and use
  `await fsp.copyFile` in the EXDEV fallback inside `moveFile` (make `moveFile`
  async too, or extract an async `copyAcrossVolumes`). Preserve: per-file
  `signal?.aborted` check + `AbortError` with `e.manifest`, `repointPhoto` on
  move, `nextAvailablePath` collision suffix, `onProgress`. `mkdirSync(...,
  {recursive:true})` can stay sync (one call). Update all call sites to `await`.
- [ ] **Step 4:** Run → GREEN; run full `npm test`.
- [ ] **Step 5:** Commit `perf(materialize): async fs copy so large jobs don't freeze the UI`.

### Task 16: `/api/system/paths` + mode-dependent dest defaults + cross-volume warn

**Files:** Modify `server/api.js` (new route), `server/index.js` if routes are
registered there; `ui/src/lib/api.js` (client fns); the setup modal / AlbumsView
dest logic (T5/T6). Test: `server/api.test.js`.

**Interfaces:**
- `GET /api/system/paths` → `{ home, desktop }` (`os.homedir()`,
  `join(home,"Desktop")`).
- `GET /api/system/same-volume?a=<path>&b=<path>` → `{ sameVolume: boolean }`
  via `statSync(a).dev === statSync(b).dev` (guard: if either stat throws,
  return `{ sameVolume: null }`).
- Client: `fetchSystemPaths()`, `checkSameVolume(a,b)` in `ui/src/lib/api.js`.

- [ ] **Step 1 (test):** In `server/api.test.js`, assert `GET /api/system/paths`
  returns a `desktop` ending in `/Desktop` and a non-empty `home`; assert
  `same-volume` returns `true` for two paths under the same temp root.
- [ ] **Step 2:** RED.
- [ ] **Step 3 (impl):** Add the two routes (route style matches existing
  `app.get(...)` handlers). Add client fns. Wire dest defaults: Move default =
  in-place (the opened `defaultDest`/source); Copy default = `desktop` from the
  endpoint. Toggling Move↔Copy swaps the default **only while `destEdited` is
  false**. When mode is Move and `checkSameVolume(source, dest)` is false, show a
  warning line ("Different volume — this Move is a full copy, not instant").
- [ ] **Step 4:** GREEN + `npm test`.
- [ ] **Step 5:** Commit `feat(materialize): smart dest defaults (move in-place, copy→Desktop) + cross-volume warning`.

### Task 17: Post-materialize auto-rescan of the destination

**Files:** Modify the materialize completion path — client side
`AlbumsView.doMaterialize` (`ui/src/lib/AlbumsView.svelte:162-189`) and/or
`App.svelte`. Reuse existing `POST /api/scan` (client `startScan`/scan fn in
`ui/src/lib/api.js`).

**Interfaces:** After a successful materialize job, trigger a scan of the
destination parent so the created nested folders index and appear in the tree,
then refresh the library/tree (bump `libraryVersion` / the tree refresh token the
app already uses after a scan).

- [ ] **Step 1:** After `job.status === "done"`, call the scan of `dest` (the
  destParent), await it, then dispatch an event App handles to refresh the
  library/tree (follow how a normal scan refreshes today — find `startScan`
  usage in App and reuse that refresh path).
- [ ] **Step 2:** Verify live (Task 14): after Copy-materialize, the new tree
  shows in the sidebar without a manual reload. (No pure unit test — this is
  wiring; the scan endpoint itself is already tested.)
- [ ] **Step 3:** Commit `feat(materialize): auto-rescan destination so the new tree appears immediately`.

### Task 18: Group by folder name (smart-labeled, no cross-library merge)

**Files:** `server/db/feed.js` (`DIMENSIONS`), `ui/src/lib/dimensions.js`
(`ALL_DIMENSIONS`), the group-label formatter (`formatGroupValue` — find it,
frontend), plus a pure smart-label helper + test.

**Design:** The grouping KEY stays per-folder (so no library-wide merge). Add a
dimension `folderName` whose SQL `expr` is still `folders.abs_path` (unique key),
but tag it so the **label** renders as the concise leaf. Then a pure client
helper computes shortest-unique-suffix labels over the currently-loaded group
values.

**Interfaces (pure, tested):**
`smartFolderLabels(absPaths: string[], sep = "_"): Map<string,string>` — for each
path, the shortest trailing path-segment suffix that is unique among the input,
joined by `sep` (e.g. `["/a/2017/DCIM","/b/2019/DCIM"]` → `DCIM`→ambiguous →
`2017_DCIM` / `2019_DCIM`). Handles both `/` and `\` separators.

- [ ] **Step 1 (test):** `ui/src/lib/folderLabels.test.js` — leaf when unique;
  extend to parent segment on collision; three-way collisions extend further;
  Windows `\` paths; single path → its leaf.
- [ ] **Step 2:** RED.
- [ ] **Step 3 (impl):** Create `ui/src/lib/folderLabels.js` with
  `smartFolderLabels`. Add `folderName` to `DIMENSIONS` (expr `folders.abs_path`,
  ASC) and to `ALL_DIMENSIONS`. In the label formatter, when the dimension is
  `folderName`, render via `smartFolderLabels` over the visible group values
  (configurable `sep`, default `_`).
- [ ] **Step 4:** GREEN + `npm test`.
- [ ] **Step 5:** Commit `feat(feed): group by folder name with smart namesake-disambiguating labels`.

### Task 19: Nested-name collision test (materialize)

**Files:** Test only — `server/api.test.js` (or `copy.test.js`).

- [ ] **Step 1:** Test that two albums whose rendered names collide as nested
  paths are materialized into distinct, sensible folders (not silently merged).
  Assert the second gets a disambiguated target and both sets of files land
  intact. Use the existing temp-dir isolation.
- [ ] **Step 2:** If it exposes a real bug in `namedAlbums()`/`nextAvailablePath`
  for nested names, fix minimally; else it stands as a regression guard.
- [ ] **Step 3:** Commit `test(materialize): nested-name collisions stay distinct`.

### Task 13 (amended): release + issues
Bump to `2.8.3-alpha`; CHANGELOG entries for: Auto Albums rename+setup, 1-min
default+Auto, strftime naming+nesting, kept names, native-dialog modals,
**no-freeze materialize, smart dest defaults + auto-rescan, group-by-folder-name**.
File issues: AI album names; shift-album-date; **and a Phase-2 EPIC**: "In-feed
Split-into-albums + nested-path grouping + backend worker/SSE processing
subsystem" (link this spec's Revision 1).

### Task 14 (amended): live verify
All original checks PLUS: verify the **freeze fix on a packaged/Electron build**
(not `npm run dev`); after Copy-materialize the **new nested tree appears** in the
sidebar; **cross-volume Move shows the warning**; **group-by-folder-name** shows
concise labels and disambiguates two same-named folders.
```
