# Folder Controls & Selective Add Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the two folder controls into one Add panel, unify folder-focus and keep-only into a single scope concept, and let the user choose which subfolders a recursive add pulls in.

**Architecture:** Three independent PRs, in order. (1) A pure `scope.js` module collapses `focusPath`/`keepIds` into one discriminated union with one `applyScope()` rebuild path and one UI chip — behavior-identical refactor. (2) `SourceControls.svelte` loses the `Folders ▾` dropdown; "Open a folder…" becomes a "Focus on this folder only" checkbox in the Add panel. (3) A new `GET /api/fs/subdirs` endpoint plus an optional `dirs[]` on `POST /api/scan` back a depth-indented subfolder checklist.

**Tech Stack:** Node 20 + Express (server), Svelte 4 + Vite (ui), vitest, better-sqlite3, ESM everywhere, JSDoc types (no TypeScript), Prettier.

**Spec:** `docs/superpowers/specs/2026-07-13-folder-controls-and-selective-add-design.md`

## Global Constraints

- **Svelte 4, not 5.** Use `export let`, `$:`, `createEventDispatcher`. No runes.
- **ESM only.** No `require`.
- **No TypeScript.** Plain JS with JSDoc types.
- **Tests are vitest**, colocated as `*.test.js` next to the source.
- **Prettier** must pass: run `npm run format` before every commit. CI gates it.
- **Every PR bumps the patch version** in `package.json` AND adds a `## <version>` entry to `CHANGELOG.md` **in the same commit** that closes the work. Current version: `2.10.3` → PRs take `2.10.4`, `2.10.5`, `2.10.6`.
- **Never silently fail.** Every user-triggerable failure renders a specific, actionable message in the UI (CLAUDE.md § Usability). A `console.error` is not user feedback.
- **The server dev process has no watch.** After changing anything under `server/`, restart `npm run dev` or verify against a throwaway server on another port. Editing server code and re-curling the old process will show stale behavior.
- **Never touch the user's real photo folders.** All fs tests use `mkdtemp` fixtures under `tmpdir()`.
- **Do NOT hand-roll another copy** of the `fetchingBefore`/`fetchingAfter`/`feedEpoch` guard. Route feed-window rebuilds through the existing `onGroupByChange(groupBy)` path, as `setFocus`/`applyKeepOnly` already do.

---

# PR 1 — Scope unification

Behavior-identical refactor. No new features. Ships first because it touches the feed-window rebuild path — the riskiest surface in the codebase — and must not ride along with new UI.

## File Structure

- **Create** `ui/src/lib/scope.js` — the pure scope module: constructors, the filter-key projection, the chip label, and localStorage persistence.
- **Create** `ui/src/lib/scope.test.js` — unit tests for the above.
- **Modify** `ui/src/App.svelte` — replace the `focusPath` + `keepIds` state pair with one `scope`; collapse `setFocus`/`applyKeepOnly` into one `applyScope`; render one chip.

### Task 1: The pure `scope` module

**Files:**

- Create: `ui/src/lib/scope.js`
- Test: `ui/src/lib/scope.test.js`

**Interfaces:**

- Consumes: nothing.
- Produces (App.svelte and later tasks rely on these exact names):
  - `folderScope(path) -> {kind:"folder", path:string}`
  - `idsScope(ids) -> {kind:"ids", ids:number[]} | null` (null when `ids` is empty/nullish — an empty scope is no scope)
  - `scopeFilterKeys(scope) -> {} | {folderPath:string} | {keepScope:true}`
  - `scopeChip(scope) -> null | {icon:string, text:string, title:string}`
  - `loadScope() -> scope|null` (folder kind only; ids never persist)
  - `persistScope(scope) -> void`
  - `LS_SCOPE_PATH = "autogallery.focusPath"` (**reuse the existing key** so a user who is currently focused stays focused across the upgrade)

- [ ] **Step 1: Write the failing test**

Create `ui/src/lib/scope.test.js`:

```js
import { describe, it, expect, beforeEach } from "vitest";
import {
  folderScope,
  idsScope,
  scopeFilterKeys,
  scopeChip,
  loadScope,
  persistScope,
  LS_SCOPE_PATH,
} from "./scope.js";

describe("scope constructors", () => {
  it("builds a folder scope", () => {
    expect(folderScope("/photos/trip")).toEqual({
      kind: "folder",
      path: "/photos/trip",
    });
  });

  it("builds an ids scope", () => {
    expect(idsScope([3, 1, 2])).toEqual({ kind: "ids", ids: [3, 1, 2] });
  });

  it("treats an empty id list as no scope", () => {
    expect(idsScope([])).toBeNull();
    expect(idsScope(null)).toBeNull();
  });
});

describe("scopeFilterKeys", () => {
  it("is empty for no scope", () => {
    expect(scopeFilterKeys(null)).toEqual({});
  });

  it("projects a folder scope to the live folderPath predicate", () => {
    expect(scopeFilterKeys(folderScope("/photos/trip"))).toEqual({
      folderPath: "/photos/trip",
    });
  });

  it("projects an ids scope to the keepScope flag, never the ids themselves", () => {
    // The ids live server-side in keep_scope; the filter carries only a flag,
    // so the scope stays unbounded in size.
    expect(scopeFilterKeys(idsScope([1, 2, 3]))).toEqual({ keepScope: true });
  });
});

describe("scopeChip", () => {
  it("is null when unscoped", () => {
    expect(scopeChip(null)).toBeNull();
  });

  it("names the folder by its basename", () => {
    const chip = scopeChip(folderScope("/photos/2026-07-04 Trip"));
    expect(chip.text).toBe("2026-07-04 Trip");
    expect(chip.title).toContain("/photos/2026-07-04 Trip");
  });

  it("counts the photos for an ids scope", () => {
    const chip = scopeChip(idsScope([1, 2, 3]));
    expect(chip.text).toBe("3 photos");
  });
});

describe("persistence", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips a folder scope", () => {
    persistScope(folderScope("/photos/trip"));
    expect(loadScope()).toEqual({ kind: "folder", path: "/photos/trip" });
  });

  it("never persists an ids scope (session-only, as keepIds was)", () => {
    persistScope(idsScope([1, 2]));
    expect(loadScope()).toBeNull();
    expect(localStorage.getItem(LS_SCOPE_PATH)).toBeNull();
  });

  it("clears the stored scope when unscoped", () => {
    persistScope(folderScope("/photos/trip"));
    persistScope(null);
    expect(loadScope()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run ui/src/lib/scope.test.js`
Expected: FAIL — `Failed to resolve import "./scope.js"`.

- [ ] **Step 3: Write the implementation**

Create `ui/src/lib/scope.js`:

```js
/**
 * The app's working scope: "show me only this". Two kinds, deliberately kept
 * distinct underneath one UI concept.
 *
 * - `folder`: a live path predicate (one string). Stays correct across rescans
 *   — photos scanned into the folder later appear inside the scope — costs one
 *   WHERE over folders.abs_path, and survives a reload.
 * - `ids`: an explicit, frozen photo-id set, stored server-side in the
 *   keep_scope table (the filter carries only a flag, so it can be any size).
 *   Scoping a whole folder this way would mean materializing every id in it,
 *   so the two kinds are NOT interchangeable — see the design doc.
 *
 * They are mutually exclusive by construction: a scope is one kind or neither.
 *
 * @typedef {{kind:"folder", path:string}} FolderScope
 * @typedef {{kind:"ids", ids:number[]}} IdsScope
 * @typedef {FolderScope|IdsScope|null} Scope
 */

/** Same key folder-focus already used, so an active focus survives the upgrade. */
export const LS_SCOPE_PATH = "autogallery.focusPath";

/** @returns {FolderScope} */
export function folderScope(path) {
  return { kind: "folder", path };
}

/** @returns {IdsScope|null} — an empty set is no scope, not an empty scope. */
export function idsScope(ids) {
  return ids && ids.length ? { kind: "ids", ids: [...ids] } : null;
}

/**
 * Project a scope onto the filter keys the feed/tree/counts understand.
 * @param {Scope} scope
 */
export function scopeFilterKeys(scope) {
  if (!scope) return {};
  if (scope.kind === "folder") return { folderPath: scope.path };
  return { keepScope: true };
}

/**
 * What the single scope chip renders. One chip, one exit — the two kinds differ
 * only in what they say.
 * @param {Scope} scope
 */
export function scopeChip(scope) {
  if (!scope) return null;
  if (scope.kind === "folder") {
    const name = scope.path.split("/").filter(Boolean).pop() || scope.path;
    return {
      icon: "▣",
      text: name,
      title: `Exit folder scope — back to the whole library (${scope.path})`,
    };
  }
  return {
    icon: "●",
    text: `${scope.ids.length.toLocaleString()} photos`,
    title: "Exit keep-only scope (back to the whole library)",
  };
}

/**
 * Folder scope persists across a reload; an ids scope deliberately does not
 * (it never did — keepIds reset to null on load even though the server-side
 * keep_scope row outlives the page).
 * @param {Scope} scope
 */
export function persistScope(scope) {
  if (scope?.kind === "folder") localStorage.setItem(LS_SCOPE_PATH, scope.path);
  else localStorage.removeItem(LS_SCOPE_PATH);
}

/** @returns {Scope} */
export function loadScope() {
  const path = localStorage.getItem(LS_SCOPE_PATH);
  return path ? folderScope(path) : null;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run ui/src/lib/scope.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
npm run format
git add ui/src/lib/scope.js ui/src/lib/scope.test.js
git commit -m "refactor(scope): pure module for the folder/ids scope union"
```

### Task 2: Wire App.svelte to the scope union

**Files:**

- Modify: `ui/src/App.svelte` — state (~lines 265–282), `displayFilter` (~lines 318–330), `applyKeepOnly`/`setFocus`/`exitFocus`/`exitKeepOnly` (~lines 995–1080), the two chips (~lines 3408–3428), `openFolderFocus` (~line 2516).

**Interfaces:**

- Consumes: everything Task 1 produces.
- Produces: `applyScope(scope)` — the single rebuild path. `scope` — the single state variable. Derived read-only aliases `focusPath` and `keepIds` (see Step 1's note) that every other reader in the file keeps using unchanged.

- [ ] **Step 1: Replace the state pair with one `scope`**

The blast radius matters here: `focusPath` and `keepIds` are read in ~15 places (albums, export, the empty state, `activeFilterNames`, the loupe). Rather than rewriting every reader, keep them as **derived read-only aliases**. That makes this a genuine refactor — one writer, one chip, many unchanged readers.

In `ui/src/App.svelte`, delete the `keepIds` declaration (~line 268) and the whole `LS_FOCUS_PATH`/`focusPath`/`focusName` block (~lines 275–282), and replace with:

```js
import {
  folderScope,
  idsScope,
  scopeFilterKeys,
  scopeChip,
  loadScope,
  persistScope,
} from "./lib/scope.js";

// The app's one working scope: "show me only this." Either a live folder path
// predicate or an explicit id set — never both (see lib/scope.js). Folder scope
// survives a reload; an ids scope is session-only.
let scope = loadScope();
$: persistScope(scope);
$: chip = scopeChip(scope);

// Read-only aliases so every existing reader (albums, export, empty state,
// activeFilterNames, loupe) keeps working unchanged. Write via applyScope only.
$: focusPath = scope?.kind === "folder" ? scope.path : null;
$: keepIds = scope?.kind === "ids" ? scope.ids : null;
$: focusName = chip && scope?.kind === "folder" ? chip.text : "";
```

- [ ] **Step 2: Project the scope into `displayFilter`**

Replace the two spread lines in `displayFilter` (~lines 321–329) — the `keepScope` spread and the `folderPath` spread — with one call:

```js
$: displayFilter = {
  ...(filterMode === "select" ? DEFAULT_FILTER : filter),
  // One scope, projected onto the filter keys the feed/tree/counts speak:
  // a folder scope becomes the live folderPath predicate, an ids scope
  // becomes the keepScope flag (the ids themselves live server-side).
  ...scopeFilterKeys(scope),
  dateAttr: filter.dateAttr,
};
```

- [ ] **Step 3: Collapse the two apply functions into one**

Delete `applyKeepOnly`, `exitKeepOnly`, `setFocus`, and `exitFocus`. Replace with the single rebuild path. Note it preserves each old behavior exactly: the server scope is pushed **before** any feed/tree/count query reads it; `libraryVersion` bumps only when a folder scope is involved (as `setFocus` did, to force the sidebars to refetch); the `await tick()` flush before `onGroupByChange` is what keeps the rebuild from reading a stale `displayFilter` (#75).

```js
/**
 * Enter, replace, or leave the working scope (null = whole library). The one
 * rebuild path for both scope kinds — routes through onGroupByChange (the
 * shared feed-window guard) rather than hand-rolling a window reset.
 * @param {import("./lib/scope.js").Scope} next
 */
async function applyScope(next) {
  const wasIds = scope?.kind === "ids";
  const touchesFolder = next?.kind === "folder" || scope?.kind === "folder";
  try {
    // Push the id set to the server BEFORE any feed/tree/count query reads
    // it; clear it when leaving an ids scope so a stale keep_scope row can't
    // narrow the next query.
    if (next?.kind === "ids") await setScope(next.ids);
    else if (wasIds) await setScope([]);
  } catch (e) {
    error = e.message;
    return; // scope unchanged — the UI still matches what the server holds
  }
  scope = next;
  countsEpoch++;
  headerCounts = {};
  fetchedParents = new Set();
  inFlightParents = new Set();
  // displayFilter is a `$:` derived value keyed on `scope`; it hasn't
  // recomputed yet. Flush before rebuilding so the feed loader reads the new
  // filter — otherwise the rebuild fetches unscoped and the focus window's
  // "before" half bleeds in the previous group's photos (#75).
  await tick();
  await onGroupByChange(groupBy);
  refreshCounts();
  if (touchesFolder) libraryVersion++; // TreeSidebar/Fisheye refetch
}

/** Keep only the current selection as the working set. */
function keepOnlySelection() {
  if (selectedIds.size === 0) return;
  applyScope(idsScope([...selectedIds]));
}

/** Keep only one group/section (all its photos) as the working set. */
async function keepOnlyGroup(path) {
  if (!path || !path.length) return;
  try {
    const ids = await fetchPhotoIds(null, path, sort);
    if (!ids.length) return;
    await applyScope(idsScope(ids));
  } catch (e) {
    error = e.message;
  }
}

/** Leave whatever scope is active, back to the whole library. */
function exitScope() {
  applyScope(null);
}
```

- [ ] **Step 4: Update the remaining writers**

In `openFolderFocus` (~line 2516), replace `setFocus(p);` with `await applyScope(folderScope(p));`.

Search for every other `setFocus(`, `exitFocus(`, `exitKeepOnly(`, `applyKeepOnly(` and update:

```bash
grep -n "setFocus(\|exitFocus(\|exitKeepOnly(\|applyKeepOnly(" ui/src/App.svelte
```

Expected remaining call sites to fix: the "Clear all filters" reset (~line 748, `if (focusPath) exitFocus();` → `if (scope) exitScope();`) and the folder-removal reset (~line 1376, which sets `keepIds = null` directly → `scope = null;` is wrong here because it skips the server clear; use `applyScope(null)`). Verify each with the grep — **there must be zero hits left**.

- [ ] **Step 5: Render one chip**

Replace both the `{#if keepIds}` and `{#if focusPath}` blocks (~lines 3408–3428) with:

```svelte
{#if chip}
  <button class="scope-chip" on:click={exitScope} title={chip.title}>
    {chip.icon}
    {chip.text} ✕
  </button>
{/if}
```

In the `<style>` block, replace the `.keep-chip` and `.focus-chip` rules with a single `.scope-chip` rule carrying the same visual treatment (keep the existing colors; the chip is one control now).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. Nothing should regress — this is behavior-identical.

- [ ] **Step 7: Live-verify (required — see CLAUDE.md)**

Run `npm run dev`. In the browser:

1. Select a few photos → **Keep only** → the chip reads `● N photos`. Click ✕ → back to the whole library.
2. Keep-only a group from its header → same chip.
3. Add/open a folder with focus → the chip reads `▣ <folder>`. **Reload the page** → the chip is still there (folder scope persists).
4. With a folder scope active, run Keep-only → the chip switches to the ids form (the two never stack).
5. Reload with an ids scope active → the scope is gone (session-only, as before).

- [ ] **Step 8: Bump version, changelog, commit**

Bump `package.json` to `2.10.4`. Add to `CHANGELOG.md`:

```markdown
## 2.10.4

- **One scope, one chip.** "Folder focus" and "Keep only" were two chips and two
  mental models for the same idea — showing you a subset. They're now a single
  scope with a single ✕ to leave it. Behavior is unchanged: scoping to a folder
  still tracks new photos scanned into it and still survives a reload, and
  keeping a hand-picked set still doesn't.
```

```bash
npm run format && npm test
git add -A
git commit -m "refactor: one scope concept for folder-focus and keep-only (2.10.4)"
```

---

# PR 2 — The Add panel absorbs "Open a folder"

## File Structure

- **Modify** `ui/src/lib/SourceControls.svelte` — delete the `Folders ▾` dropdown and the open-folder popover; add the focus checkbox to the Add panel; `＋` icon + `Folders` text button.
- **Modify** `ui/src/App.svelte` — collapse `requestOpenFolder`/`openFolderFocus`/`doScan` into one submit path; drop the now-dead `libraryOpen`/`openFolderOpen`/`openFolderDir` state.

### Task 3: Rebuild SourceControls

**Files:**

- Modify: `ui/src/lib/SourceControls.svelte` (whole file)
- Modify: `ui/src/App.svelte` (~lines 2440–2546, ~line 3361)

**Interfaces:**

- Consumes: `applyScope`, `folderScope` (PR 1).
- Produces: `SourceControls` now emits exactly three events — `choosefolder` (open the native picker), `submit` (do the add/open/rescan), `managelibrary` (open the modal). It no longer emits `openfolder`, `openfolderfocus`, or `scan`. New two-way props: `focusAfterAdd` (bool). Dropped props: `libraryOpen`, `openFolderOpen`, `openFolderDir`.

- [ ] **Step 1: Rewrite the component**

Replace `ui/src/lib/SourceControls.svelte` entirely:

```svelte
<script>
  /**
   * Toolbar cluster ①: the add-a-folder popover (the single door — adding,
   * opening, and rescanning a folder are all the same act with different
   * options) plus a button that opens Manage folders. Purely presentational: it
   * owns the popover's open/close state and the form fields (two-way bound to
   * App, which owns the scan/scope logic) and emits `submit` when the user
   * commits.
   *
   * The primary button's verb adapts to the path: "Add & scan" for a new
   * folder, "Open" when the folder is already indexed and the user wants to
   * scope to it (no scan — that's what makes this work with the drive
   * unmounted), "Rescan" when it's already indexed and they don't.
   */
  import { createEventDispatcher } from "svelte";
  import { clickOutside, onEscape } from "./actions.js";

  export let scanning = false;
  export let hasNativePicker = false;

  export let addFolderOpen = false;
  export let dir = "";
  export let recursiveScan = true;
  export let focusAfterAdd = false;
  /** True when `dir` is already a library member (App computes it). */
  export let alreadyIndexed = false;

  const dispatch = createEventDispatcher();

  $: verb = !alreadyIndexed ? "Add & scan" : focusAfterAdd ? "Open" : "Rescan";
  $: busyVerb = verb === "Open" ? "Opening…" : "Scanning…";
</script>

<div class="cluster source">
  <div
    class="add-folder"
    use:clickOutside={() => (addFolderOpen = false)}
    use:onEscape={() => (addFolderOpen = false)}
  >
    <button
      class="add-toggle"
      on:click={() => (addFolderOpen = !addFolderOpen)}
      title="Add a folder — scan it in, and optionally focus on it"
      aria-label="Add a folder"
    >
      ＋
    </button>
    {#if addFolderOpen}
      <div class="add-panel">
        <button
          class="popover-close"
          title="Close"
          aria-label="Close add folder"
          on:click={() => (addFolderOpen = false)}>✕</button
        >
        {#if hasNativePicker}
          <button
            class="choose-folder primary"
            on:click={() => dispatch("choosefolder")}
            disabled={scanning}
          >
            Choose folder…
          </button>
          <div class="add-or">or type a path</div>
        {/if}
        <div class="add-row">
          <input
            class="dir"
            type="text"
            placeholder="/path/to/photos"
            bind:value={dir}
            on:keydown={(e) => e.key === "Enter" && dispatch("submit")}
            spellcheck="false"
          />
          <button
            class="scan"
            on:click={() => dispatch("submit")}
            disabled={scanning || !dir.trim()}
          >
            {scanning ? busyVerb : verb}
          </button>
        </div>
        <label class="opt" title="Scan this folder and all folders inside it">
          <input type="checkbox" bind:checked={recursiveScan} />
          <span>Include subfolders</span>
        </label>
        <label
          class="opt"
          title="Show only this folder — the rest of the library stays indexed, just out of view"
        >
          <input type="checkbox" bind:checked={focusAfterAdd} />
          <span>Focus on this folder only</span>
        </label>
        {#if alreadyIndexed && dir.trim()}
          <p class="hint">Already in your library.</p>
        {/if}
      </div>
    {/if}
  </div>
  <button
    class="library-toggle"
    on:click={() => dispatch("managelibrary")}
    title="Your scanned folders — rename, remove, or rescan them"
  >
    Folders
  </button>
</div>

<style>
  .cluster {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-width: 0;
    flex-shrink: 0;
  }
  .library-toggle {
    padding: 0.45rem 1rem;
    background: #4c9aff;
    color: #06121f;
    border: none;
    border-radius: 6px;
    font-weight: 600;
    cursor: pointer;
  }
  .library-toggle:hover {
    background: #5ba8ff;
  }
  .add-folder {
    position: relative;
  }
  .add-toggle {
    background: #101010;
    border: 1px solid #333;
    color: #cfcfcf;
    border-radius: 6px;
    padding: 3px 9px;
    font-size: 0.95rem;
    line-height: 1;
    cursor: pointer;
  }
  .add-panel {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 50;
    background: #0d0d0d;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 30px 10px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 280px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }
  .popover-close {
    position: absolute;
    top: 6px;
    right: 8px;
    width: 22px;
    height: 22px;
    padding: 0;
    line-height: 1;
    background: transparent;
    border: 1px solid #444;
    color: #cfcfcf;
    border-radius: 50%;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .popover-close:hover {
    background: #2c2c2c;
  }
  .add-row {
    display: flex;
    gap: 8px;
  }
  .choose-folder.primary {
    width: 100%;
    padding: 0.5rem 1rem;
  }
  .add-or {
    font-size: 0.72rem;
    color: #8a8a8a;
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .opt {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8rem;
    color: #b8b8b8;
    cursor: pointer;
  }
  .hint {
    margin: 0;
    font-size: 0.75rem;
    color: #8a8a8a;
  }
  .dir {
    flex: 1;
    max-width: 40rem;
    padding: 0.45rem 0.6rem;
    background: #101010;
    border: 1px solid #333;
    border-radius: 6px;
    color: #eee;
    font-size: 0.9rem;
    font-family: ui-monospace, monospace;
  }
  .dir:focus {
    outline: none;
    border-color: #4c9aff;
  }
  .scan,
  .choose-folder {
    padding: 0.45rem 1rem;
    background: #4c9aff;
    color: #06121f;
    border: none;
    border-radius: 6px;
    font-weight: 600;
    cursor: pointer;
  }
  .scan:disabled,
  .choose-folder:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
```

- [ ] **Step 2: Collapse the App-side handlers**

In `ui/src/App.svelte`, delete `requestOpenFolder` and `openFolderFocus`, and the `libraryOpen` / `openFolderOpen` / `openFolderDir` state declarations. Add `focusAfterAdd` state and one submit path.

The old `doScan` keeps doing the scanning; what's new is that submit decides between three outcomes. This is the table from the spec, in code:

```js
let focusAfterAdd = false;
// "Already in your library" — the same predicate the old openFolderFocus used:
// the path itself, or any subtree of it, is a scanned folder.
$: alreadyIndexed =
  !!dir.trim() &&
  library.some(
    (e) => e.path === dir.trim() || e.path.startsWith(dir.trim() + "/")
  );

/**
 * The Add panel's one submit. Three outcomes (see the design doc's table):
 * already-indexed + focus  -> scope to it, NO scan (this is what lets you
 *                             open a folder with the drive unmounted — the
 *                             SQLite index is an offline mirror)
 * already-indexed, no focus-> incremental rescan, catch up with disk
 * new folder               -> scan it in, then scope to it if asked
 */
async function submitAddFolder() {
  const p = dir.trim();
  if (!p) return;
  addFolderOpen = false;
  error = "";
  if (alreadyIndexed && focusAfterAdd) {
    await applyScope(folderScope(p));
    return;
  }
  const ok = await doScan(); // false on failure/cancel; renders its own error
  if (ok && focusAfterAdd) await applyScope(folderScope(p));
}

async function chooseFolder() {
  const path = await window.autogallery?.pickFolder();
  if (path) {
    dir = path;
    await submitAddFolder();
  }
}
```

- [ ] **Step 3: Make `doScan` report success**

`doScan` currently returns nothing, so `submitAddFolder` can't tell whether to scope afterwards. Add explicit returns: `return false` on the cancel path, on the failed-job path, and in the `catch`; `return true` after `refreshLibrary()` succeeds. Do not change anything else about it — it already renders `error` on failure.

- [ ] **Step 4: Update the component usage**

Replace the `<SourceControls .../>` block (~line 3361):

```svelte
<SourceControls
  {scanning}
  {hasNativePicker}
  {alreadyIndexed}
  bind:addFolderOpen
  bind:dir
  bind:recursiveScan
  bind:focusAfterAdd
  on:choosefolder={chooseFolder}
  on:submit={submitAddFolder}
  on:managelibrary={() => (manageLibraryOpen = true)}
/>
```

- [ ] **Step 5: Verify nothing dangles**

```bash
grep -n "libraryOpen\|openFolderOpen\|openFolderDir\|requestOpenFolder\|openFolderFocus" ui/src/App.svelte ui/src/lib/SourceControls.svelte
```

Expected: **zero hits.** (`manageLibraryOpen` is a different variable and must survive — don't let the grep fool you; it does not match `libraryOpen` as a whole word, but it does substring-match, so read the hits before deleting.)

- [ ] **Step 6: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Live-verify (required)**

`npm run dev`, then in the browser:

1. `＋` → type a **new** folder path → button reads **Add & scan** → it scans and the photos appear, no scope.
2. `＋` → same folder again → button now reads **Rescan**, and the hint says "Already in your library."
3. Tick **Focus on this folder only** with that indexed path → button reads **Open** → clicking it scopes instantly with **no scan job** in the Jobs panel. This is the offline path; confirm no job appears.
4. New folder + focus ticked → scans, then lands scoped.
5. **Folders** button opens Manage folders directly (no dropdown).

- [ ] **Step 8: Bump, changelog, commit**

Bump `package.json` to `2.10.5`. Add to `CHANGELOG.md`:

```markdown
## 2.10.5

- **One door for folders.** Adding a folder and opening one were two different
  controls doing nearly the same thing. Now there's one `＋` panel: pick a
  folder, choose whether to include subfolders, and tick "Focus on this folder
  only" if you want the app to show just that folder. The button says what it
  will do — **Add & scan** for a new folder, **Rescan** for one you already have,
  **Open** to jump straight into a folder you've already scanned (still works
  with the drive unmounted).
```

```bash
npm run format && npm test
git add -A
git commit -m "feat: one Add panel for adding, opening, and rescanning a folder (2.10.5)"
```

---

# PR 3 — Selective recursive add

## File Structure

- **Create** `server/lib/insideDir.js` + test — the containment guard (a security boundary: user-supplied paths over HTTP).
- **Create** `server/lib/subdirs.js` + test — `listSubdirsWithCounts(root, processing)`.
- **Modify** `server/api.js` — new `GET /api/fs/subdirs`; `POST /api/scan` accepts optional `dirs[]`.
- **Modify** `ui/src/lib/api.js` — `fetchSubdirs(dir)`; `startScan(dir, {recursive, dirs})`.
- **Create** `ui/src/lib/subfolderSelection.js` + test — pure selection state.
- **Modify** `ui/src/lib/SourceControls.svelte` — the checklist expander.
- **Modify** `ui/src/App.svelte` — fetch the candidates, pass the selection to the scan.

### Task 4: The containment guard

**Files:**

- Create: `server/lib/insideDir.js`
- Test: `server/lib/insideDir.test.js`

**Interfaces:**

- Produces: `isInsideDir(parent, child) -> boolean` — true when `child` is `parent` itself or a descendant of it, after resolving both.

- [ ] **Step 1: Write the failing test**

Create `server/lib/insideDir.test.js`:

```js
import { describe, it, expect } from "vitest";
import { isInsideDir } from "./insideDir.js";

describe("isInsideDir", () => {
  it("accepts the directory itself", () => {
    expect(isInsideDir("/photos/trip", "/photos/trip")).toBe(true);
  });

  it("accepts a descendant", () => {
    expect(isInsideDir("/photos/trip", "/photos/trip/raw")).toBe(true);
    expect(isInsideDir("/photos/trip", "/photos/trip/a/b/c")).toBe(true);
  });

  it("rejects a sibling with a shared name prefix", () => {
    // The classic hole: a naive startsWith("/photos/trip") lets /photos/tripX
    // through. It is NOT inside /photos/trip.
    expect(isInsideDir("/photos/trip", "/photos/tripX")).toBe(false);
    expect(isInsideDir("/a/b", "/a/bc")).toBe(false);
  });

  it("rejects an ancestor and an unrelated path", () => {
    expect(isInsideDir("/photos/trip", "/photos")).toBe(false);
    expect(isInsideDir("/photos/trip", "/etc/passwd")).toBe(false);
  });

  it("rejects a traversal that escapes the parent", () => {
    expect(isInsideDir("/photos/trip", "/photos/trip/../../etc")).toBe(false);
    expect(isInsideDir("/photos/trip", "/photos/trip/./../other")).toBe(false);
  });

  it("normalizes a trailing slash on the parent", () => {
    expect(isInsideDir("/photos/trip/", "/photos/trip/raw")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run server/lib/insideDir.test.js`
Expected: FAIL — cannot resolve `./insideDir.js`.

- [ ] **Step 3: Implement**

Create `server/lib/insideDir.js`:

```js
import { resolve, relative, isAbsolute } from "node:path";

/**
 * Is `child` the directory `parent` itself, or a descendant of it?
 *
 * A containment check on user-supplied paths arriving over HTTP, so this is a
 * security boundary, not a sanity check. A naive `child.startsWith(parent)`
 * has two holes this closes: a sibling sharing a name prefix (`/a/bc` is not
 * inside `/a/b`) and a `..` traversal that escapes (`/a/b/../../etc`). Both
 * are handled by resolving each side first and then asking whether the
 * relative path from parent to child stays put — a relative path that starts
 * with `..` (or is absolute, on a different Windows drive) has left the tree.
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isInsideDir(parent, child) {
  const p = resolve(parent);
  const c = resolve(child);
  if (p === c) return true;
  const rel = relative(p, c);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run server/lib/insideDir.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
npm run format
git add server/lib/insideDir.js server/lib/insideDir.test.js
git commit -m "feat(server): path-containment guard for user-supplied subdir lists"
```

### Task 5: List subdirectories with media counts

**Files:**

- Create: `server/lib/subdirs.js`
- Test: `server/lib/subdirs.test.js`

**Interfaces:**

- Consumes: `listDirsRecursive` from `server/lib/walkDirs.js`; a `ProcessingService` (its `.scan(dir)` returns the media files in one directory — this is the ONE place that knows what counts as a photo, so counting reuses it rather than re-listing extensions).
- Produces: `listSubdirsWithCounts(root, processing) -> Promise<Array<{path, relPath, depth, mediaCount}>>`. Directories with no media are omitted. The root itself is included when it holds media, with `relPath: ""` and `depth: 0`.

- [ ] **Step 1: Write the failing test**

Create `server/lib/subdirs.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSubdirsWithCounts } from "./subdirs.js";

// A stand-in for ProcessingService: the real one classifies by extension, so
// the fake just counts .jpg files. What matters is that subdirs.js delegates
// "what counts as media" rather than re-implementing it.
const fakeProcessing = {
  async scan(dir) {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".jpg"))
      .map((e) => ({ name: e.name }));
  },
};

let root;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "subdirs-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("listSubdirsWithCounts", () => {
  it("returns each directory with media, its depth, and its count", async () => {
    await mkdir(join(root, "trip"), { recursive: true });
    await mkdir(join(root, "trip", "raw"), { recursive: true });
    await writeFile(join(root, "trip", "a.jpg"), "x");
    await writeFile(join(root, "trip", "b.jpg"), "x");
    await writeFile(join(root, "trip", "raw", "c.jpg"), "x");

    const dirs = await listSubdirsWithCounts(root, fakeProcessing);

    expect(dirs).toEqual([
      { path: join(root, "trip"), relPath: "trip", depth: 1, mediaCount: 2 },
      {
        path: join(root, "trip", "raw"),
        relPath: join("trip", "raw"),
        depth: 2,
        mediaCount: 1,
      },
    ]);
  });

  it("omits directories with no media (they'd produce no folders row)", async () => {
    await mkdir(join(root, "empty"), { recursive: true });
    await mkdir(join(root, "has"), { recursive: true });
    await writeFile(join(root, "has", "a.jpg"), "x");

    const dirs = await listSubdirsWithCounts(root, fakeProcessing);

    expect(dirs.map((d) => d.relPath)).toEqual(["has"]);
  });

  it("includes the root itself when it holds media, at depth 0", async () => {
    await writeFile(join(root, "a.jpg"), "x");

    const dirs = await listSubdirsWithCounts(root, fakeProcessing);

    expect(dirs).toEqual([
      { path: root, relPath: "", depth: 0, mediaCount: 1 },
    ]);
  });

  it("is empty for a tree with no media at all", async () => {
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "notes.txt"), "x");

    expect(await listSubdirsWithCounts(root, fakeProcessing)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run server/lib/subdirs.test.js`
Expected: FAIL — cannot resolve `./subdirs.js`.

- [ ] **Step 3: Implement**

Create `server/lib/subdirs.js`:

```js
import { relative, sep } from "node:path";
import { listDirsRecursive } from "./walkDirs.js";

/**
 * The candidate directories a recursive scan of `root` would import, each with
 * the number of media files in it — the input to the Add panel's subfolder
 * checklist. One entry here == one `folders` row the scan would create, so what
 * the user checks maps 1:1 onto what they get.
 *
 * Counting delegates to ProcessingService.scan, which is the single place that
 * knows which extensions count as photos/video (see walkDirs.js's note). A dir
 * with no media is omitted: a recursive scan already skips creating a row for
 * it, so offering it as a checkbox would be a lie.
 *
 * @param {string} root absolute directory path
 * @param {{scan: (dir:string) => Promise<unknown[]>}} processing
 * @returns {Promise<Array<{path:string, relPath:string, depth:number, mediaCount:number}>>}
 */
export async function listSubdirsWithCounts(root, processing) {
  const dirs = await listDirsRecursive(root);
  const out = [];
  for (const dir of dirs) {
    const files = await processing.scan(dir);
    if (!files.length) continue;
    const relPath = relative(root, dir);
    out.push({
      path: dir,
      relPath,
      depth: relPath === "" ? 0 : relPath.split(sep).length,
      mediaCount: files.length,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run server/lib/subdirs.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
npm run format
git add server/lib/subdirs.js server/lib/subdirs.test.js
git commit -m "feat(server): list a folder's scannable subdirs with media counts"
```

### Task 6: The endpoint and the `dirs[]` scan parameter

**Files:**

- Modify: `server/api.js` (imports at ~line 29; `POST /api/scan` at ~line 440; add `GET /api/fs/subdirs` next to it)
- Test: `server/api.test.js`

**Interfaces:**

- Consumes: `isInsideDir` (Task 4), `listSubdirsWithCounts` (Task 5).
- Produces: `GET /api/fs/subdirs?dir=…` → `200` with the array from Task 5; `400` when `dir` is missing or not a directory; `404` when it doesn't exist. `POST /api/scan` accepts optional `dirs: string[]`, honored only when `recursive` is true; every entry must be an existing directory inside `dir` or the whole request is rejected `400`.

- [ ] **Step 1: Write the failing tests**

Add to `server/api.test.js` (follow the file's existing fixture/`request` patterns — reuse whatever helper it already uses to build the app and hit routes):

```js
describe("GET /api/fs/subdirs", () => {
  it("lists the scannable subdirs with counts", async () => {
    // fixture: <tmp>/card/DCIM/{a.jpg,b.jpg}, <tmp>/card/DCIM/raw/c.jpg,
    //          <tmp>/card/docs/notes.txt  (no media -> omitted)
    const res = await request(app).get("/api/fs/subdirs").query({ dir: card });

    expect(res.status).toBe(200);
    expect(res.body.map((d) => d.relPath).sort()).toEqual([
      "DCIM",
      join("DCIM", "raw"),
    ]);
    expect(res.body.find((d) => d.relPath === "DCIM").mediaCount).toBe(2);
  });

  it("404s on a path that does not exist", async () => {
    const res = await request(app)
      .get("/api/fs/subdirs")
      .query({ dir: join(card, "nope") });
    expect(res.status).toBe(404);
  });

  it("400s on a file", async () => {
    const res = await request(app)
      .get("/api/fs/subdirs")
      .query({ dir: join(card, "DCIM", "a.jpg") });
    expect(res.status).toBe(400);
  });

  it("400s when dir is missing", async () => {
    const res = await request(app).get("/api/fs/subdirs");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/scan with a dirs subset", () => {
  it("scans only the selected subdirs", async () => {
    const res = await request(app)
      .post("/api/scan")
      .send({
        dir: card,
        recursive: true,
        dirs: [join(card, "DCIM")], // deliberately excludes DCIM/raw
      });
    expect(res.status).toBe(202);
    await waitForJob(res.body.jobId);

    const lib = await request(app).get("/api/library");
    const paths = lib.body.map((e) => e.path);
    expect(paths).toContain(join(card, "DCIM"));
    expect(paths).not.toContain(join(card, "DCIM", "raw"));
  });

  it("rejects a dirs entry outside dir", async () => {
    const res = await request(app)
      .post("/api/scan")
      .send({ dir: card, recursive: true, dirs: ["/etc"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/outside/i);
  });

  it("rejects a sibling that merely shares a name prefix", async () => {
    const res = await request(app)
      .post("/api/scan")
      .send({ dir: card, recursive: true, dirs: [card + "X"] });
    expect(res.status).toBe(400);
  });

  it("without dirs, scans the whole tree as before", async () => {
    const res = await request(app)
      .post("/api/scan")
      .send({ dir: card, recursive: true });
    expect(res.status).toBe(202);
    await waitForJob(res.body.jobId);

    const lib = await request(app).get("/api/library");
    const paths = lib.body.map((e) => e.path);
    expect(paths).toContain(join(card, "DCIM"));
    expect(paths).toContain(join(card, "DCIM", "raw"));
  });
});
```

- [ ] **Step 2: Run them, verify they fail**

Run: `npx vitest run server/api.test.js -t "subdirs"`
Expected: FAIL — 404 (no such route) / the subset test imports the whole tree.

- [ ] **Step 3: Add the endpoint**

In `server/api.js`, extend the imports (~line 29):

```js
import { listDirsRecursive } from "./lib/walkDirs.js";
import { listSubdirsWithCounts } from "./lib/subdirs.js";
import { isInsideDir } from "./lib/insideDir.js";
```

Add the route immediately before `app.post("/api/scan", …)`:

```js
// The candidate directories a recursive scan of `dir` would import, with
// media counts — the Add panel's subfolder checklist reads this so the user
// can uncheck an Exports/ or Selects/ folder before importing.
app.get("/api/fs/subdirs", async (req, res) => {
  const dir = req.query?.dir;
  if (typeof dir !== "string" || dir.length === 0) {
    return res.status(400).json({ error: "dir is required" });
  }
  let st;
  try {
    st = statSync(dir);
  } catch {
    return res.status(404).json({ error: `not found: ${dir}` });
  }
  if (!st.isDirectory()) {
    return res.status(400).json({ error: `not a directory: ${dir}` });
  }
  try {
    res.json(await listSubdirsWithCounts(dir, processing));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 4: Accept `dirs[]` on the scan**

In `POST /api/scan`, after the existing `recursive` line, add the validation. It must run **before** `res.status(202)` — a rejected subset is a synchronous `400`, not a failed job.

```js
const recursive = req.body?.recursive === true;
// Optional subset: scan exactly these directories instead of the whole
// recursive walk. User-supplied paths over HTTP, so each is validated to be
// a real directory INSIDE `dir` (isInsideDir closes both the name-prefix
// and the `..`-traversal holes). One bad entry rejects the request — we
// never silently drop a folder the user asked for.
const dirsSubset = req.body?.dirs;
if (dirsSubset !== undefined) {
  if (
    !Array.isArray(dirsSubset) ||
    dirsSubset.some((d) => typeof d !== "string")
  ) {
    return res.status(400).json({ error: "dirs must be an array of strings" });
  }
  for (const d of dirsSubset) {
    if (!isInsideDir(dir, d)) {
      return res
        .status(400)
        .json({ error: `outside the scanned folder: ${d}` });
    }
    let sub;
    try {
      sub = statSync(d);
    } catch {
      return res.status(400).json({ error: `not found: ${d}` });
    }
    if (!sub.isDirectory()) {
      return res.status(400).json({ error: `not a directory: ${d}` });
    }
  }
}
```

Then in the `if (recursive)` branch, replace the walk with the subset when one was given:

```js
    if (recursive) {
      const dirs =
        dirsSubset && dirsSubset.length
          ? dirsSubset
          : await listDirsRecursive(dir);
```

Everything downstream (the job, the loop, `upsertScan`, the `folders`/`count` tallies) is unchanged — each scanned dir still becomes its own `folders` row.

- [ ] **Step 5: Run the tests, verify they pass**

Run: `npx vitest run server/api.test.js`
Expected: PASS — the new tests plus every pre-existing one.

- [ ] **Step 6: Commit**

```bash
npm run format
git add server/api.js server/api.test.js
git commit -m "feat(server): GET /api/fs/subdirs; scan an explicit subdir subset"
```

### Task 7: The selection module

**Files:**

- Create: `ui/src/lib/subfolderSelection.js`
- Test: `ui/src/lib/subfolderSelection.test.js`

**Interfaces:**

- Produces: `selectAll(dirs) -> Set<string>` (of `path`), `selectNone() -> Set<string>`, `toggle(selected, path) -> Set<string>` (returns a NEW Set — Svelte 4 needs the reassignment to react), `selectedDirs(selected, dirs) -> string[]` (the paths to send to `/api/scan`, in `dirs` order).

- [ ] **Step 1: Write the failing test**

Create `ui/src/lib/subfolderSelection.test.js`:

```js
import { describe, it, expect } from "vitest";
import {
  selectAll,
  selectNone,
  toggle,
  selectedDirs,
} from "./subfolderSelection.js";

const DIRS = [
  { path: "/c/trip", relPath: "trip", depth: 1, mediaCount: 4 },
  { path: "/c/trip/raw", relPath: "trip/raw", depth: 2, mediaCount: 2 },
  { path: "/c/trip/exports", relPath: "trip/exports", depth: 2, mediaCount: 1 },
];

describe("subfolder selection", () => {
  it("starts with everything checked — opting out is the deliberate act", () => {
    expect(selectAll(DIRS)).toEqual(
      new Set(["/c/trip", "/c/trip/raw", "/c/trip/exports"])
    );
  });

  it("selects none", () => {
    expect(selectNone()).toEqual(new Set());
  });

  it("toggles one path off and back on, returning a new Set each time", () => {
    const all = selectAll(DIRS);
    const off = toggle(all, "/c/trip/exports");
    expect(off.has("/c/trip/exports")).toBe(false);
    expect(off).not.toBe(all); // new reference: Svelte 4 reacts to reassignment
    expect(toggle(off, "/c/trip/exports").has("/c/trip/exports")).toBe(true);
  });

  it("returns the checked paths in list order, ready for /api/scan", () => {
    const sel = toggle(selectAll(DIRS), "/c/trip/exports");
    expect(selectedDirs(sel, DIRS)).toEqual(["/c/trip", "/c/trip/raw"]);
  });

  it("returns nothing when nothing is checked", () => {
    expect(selectedDirs(selectNone(), DIRS)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run ui/src/lib/subfolderSelection.test.js`
Expected: FAIL — cannot resolve the import.

- [ ] **Step 3: Implement**

Create `ui/src/lib/subfolderSelection.js`:

```js
/**
 * Which subfolders a recursive add will actually import. The checklist is a
 * flat, depth-indented list (one row per directory the scan would turn into a
 * `folders` row), so the selection is just a Set of absolute paths.
 *
 * Every toggle returns a NEW Set: Svelte 4 reacts to reassignment, not to
 * mutation, so `selected = toggle(selected, p)` is the only thing that updates
 * the UI.
 *
 * @typedef {{path:string, relPath:string, depth:number, mediaCount:number}} SubdirRow
 */

/** @param {SubdirRow[]} dirs @returns {Set<string>} */
export function selectAll(dirs) {
  return new Set(dirs.map((d) => d.path));
}

/** @returns {Set<string>} */
export function selectNone() {
  return new Set();
}

/** @param {Set<string>} selected @param {string} path @returns {Set<string>} */
export function toggle(selected, path) {
  const next = new Set(selected);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

/**
 * The checked paths, in list order — exactly what POST /api/scan's `dirs` wants.
 * @param {Set<string>} selected @param {SubdirRow[]} dirs @returns {string[]}
 */
export function selectedDirs(selected, dirs) {
  return dirs.filter((d) => selected.has(d.path)).map((d) => d.path);
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run ui/src/lib/subfolderSelection.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
npm run format
git add ui/src/lib/subfolderSelection.js ui/src/lib/subfolderSelection.test.js
git commit -m "feat(ui): pure selection state for the subfolder checklist"
```

### Task 8: The checklist in the Add panel

**Files:**

- Modify: `ui/src/lib/api.js` (`startScan` ~line 547; add `fetchSubdirs`)
- Modify: `ui/src/lib/SourceControls.svelte`
- Modify: `ui/src/App.svelte`

**Interfaces:**

- Consumes: `selectAll`/`selectNone`/`toggle`/`selectedDirs` (Task 7), `GET /api/fs/subdirs` (Task 6).
- Produces: `fetchSubdirs(dir) -> Promise<SubdirRow[]>`; `startScan(dir, {recursive, dirs})`.

- [ ] **Step 1: Extend the client API**

In `ui/src/lib/api.js`, add `fetchSubdirs` and thread `dirs` through `startScan`:

```js
/** The scannable subdirs of `dir`, with media counts (the Add panel checklist). */
export async function fetchSubdirs(dir) {
  const res = await fetch(`/api/fs/subdirs?dir=${encodeURIComponent(dir)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `couldn't read ${dir} (${res.status})`);
  }
  return res.json();
}

export async function startScan(dir, { recursive = true, dirs = null } = {}) {
  const res = await fetch("/api/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir, recursive, ...(dirs ? { dirs } : {}) }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `scan failed (${res.status})`);
  }
  return res.json();
}
```

Leave the rest of `startScan` as it is.

- [ ] **Step 2: App-side state and the fetch**

In `ui/src/App.svelte`, add:

```js
import { fetchSubdirs } from "./lib/api.js";
import {
  selectAll,
  selectNone,
  toggle as toggleSubdir,
  selectedDirs,
} from "./lib/subfolderSelection.js";

// The subfolder checklist. Collapsed by default: the common case (add
// everything) must stay one click and never wait on a directory walk of a
// big card. Expanding is the deliberate act of curating the import.
let subdirsOpen = false;
let subdirs = [];
let subdirsLoading = false;
let subdirsError = "";
let subdirSelection = new Set();

async function loadSubdirs() {
  const p = dir.trim();
  if (!p) return;
  subdirsLoading = true;
  subdirsError = "";
  try {
    subdirs = await fetchSubdirs(p);
    subdirSelection = selectAll(subdirs);
  } catch (e) {
    // Never a silent empty list: permission denied / unmounted / vanished all
    // land here and must say so, in the panel, naming the path.
    subdirsError = e.message;
    subdirs = [];
    subdirSelection = selectNone();
  } finally {
    subdirsLoading = false;
  }
}

// Editing the path invalidates a checklist built for the previous folder.
$: if (dir !== undefined) {
  subdirsOpen = false;
  subdirs = [];
  subdirsError = "";
}
```

- [ ] **Step 3: Pass the subset to the scan**

`doScan` currently calls `startScan(dir, { recursive: recursiveScan })`. Pass the subset when — and only when — the user actually curated one:

```js
const chosen =
  recursiveScan && subdirsOpen && subdirs.length
    ? selectedDirs(subdirSelection, subdirs)
    : null;
const { jobId } = await startScan(p, {
  recursive: recursiveScan,
  dirs: chosen,
});
```

- [ ] **Step 4: Render the checklist**

In `SourceControls.svelte`, add the props and the expander. New props (all two-way where App owns the state): `subdirsOpen`, `subdirs`, `subdirsLoading`, `subdirsError`, `subdirSelection`; new events: `loadsubdirs`, `toggledir` (detail: path), `selectalldirs`, `selectnodirs`.

Insert after the "Include subfolders" label:

```svelte
{#if recursiveScan}
  {#if !subdirsOpen}
    <button
      class="link"
      disabled={!dir.trim()}
      on:click={() => {
        subdirsOpen = true;
        dispatch("loadsubdirs");
      }}
    >
      Choose subfolders…
    </button>
  {:else if subdirsLoading}
    <p class="hint">Reading folders…</p>
  {:else if subdirsError}
    <p class="err">{subdirsError}</p>
  {:else}
    <ul class="subdirs">
      {#each subdirs as d (d.path)}
        <li style="padding-left: {d.depth * 14}px">
          <label>
            <input
              type="checkbox"
              checked={subdirSelection.has(d.path)}
              on:change={() => dispatch("toggledir", { path: d.path })}
            />
            <span class="name"
              >{d.relPath.split("/").pop() || "(this folder)"}</span
            >
            <span class="count">{d.mediaCount.toLocaleString()}</span>
          </label>
        </li>
      {/each}
    </ul>
    <div class="subdir-actions">
      <button class="link" on:click={() => dispatch("selectalldirs")}
        >All</button
      >
      <button class="link" on:click={() => dispatch("selectnodirs")}
        >None</button
      >
    </div>
  {/if}
{/if}
```

And make the primary button reflect the curated count and refuse an empty import **with the reason visible** — a disabled button with no explanation is exactly the dead control CLAUDE.md forbids:

```svelte
$: chosenCount = subdirsOpen ? subdirSelection.size : null; $: emptySelection =
chosenCount === 0; $: verb = !alreadyIndexed ? chosenCount === null ? "Add &
scan" : `Add & scan ${chosenCount} folder${chosenCount === 1 ? "" : "s"}` :
focusAfterAdd ? "Open" : "Rescan";
```

with the button `disabled={scanning || !dir.trim() || emptySelection}` and, right below it:

```svelte
{#if emptySelection}
  <p class="err">Nothing selected — check at least one folder.</p>
{/if}
```

Style `.subdirs` as a scrollable list (`max-height: 220px; overflow-y: auto;`), `.link` as a borderless text button, `.err` in the app's error red, `.count` muted and right-aligned.

- [ ] **Step 5: Wire the events in App**

```svelte
bind:subdirsOpen
{subdirs}
{subdirsLoading}
{subdirsError}
{subdirSelection}
on:loadsubdirs={loadSubdirs}
on:toggledir={(e) =>
  (subdirSelection = toggleSubdir(subdirSelection, e.detail.path))}
on:selectalldirs={() => (subdirSelection = selectAll(subdirs))}
on:selectnodirs={() => (subdirSelection = selectNone())}
```

- [ ] **Step 6: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Live-verify (required)**

**Restart `npm run dev`** — the server has no watch, and this PR changed `server/api.js`.

Against a real multi-folder tree (use a **copy** in `$CLAUDE_JOB_DIR/tmp`, never the user's real photo folders):

1. `＋` → pick the parent → **Choose subfolders…** → the checklist lists each media folder with its count, all checked.
2. Uncheck one → the button reads **Add & scan N folders** with N one lower.
3. Add → only the checked folders appear as sections in the grid. The unchecked one is absent.
4. **None** → the button is disabled and says why.
5. Point at an unreadable folder → the panel shows the error, naming the path.
6. Collapse the picker and add normally → still one click, still scans everything.

- [ ] **Step 8: Bump, changelog, commit**

Bump `package.json` to `2.10.6`. Add to `CHANGELOG.md`:

```markdown
## 2.10.6

- **Choose which subfolders to import.** Adding a folder with "Include
  subfolders" used to be all-or-nothing. Now "Choose subfolders…" in the ＋ panel
  lists every folder it found, with photo counts, so you can leave out the
  `Exports/` and `Selects/` folders you don't want in the library. Untouched by
  default — a plain add still imports everything in one click.
```

```bash
npm run format && npm test
git add -A
git commit -m "feat: choose which subfolders a recursive add imports (2.10.6)"
```

---

## Self-review notes

- **Spec coverage:** §1 toolbar → Task 3. §2 Add panel + the verb table → Task 3. §3 checklist → Tasks 7–8. §4 server → Tasks 4–6. §5 scope → Tasks 1–2. §6 failure modes → Task 8 Steps 2/4 (listing error, empty selection) and Task 6 Step 4 (400s surface via the existing `result.error` path). Testing §→ every task's tests. Delivery § → the three PR groupings above.
- **No new keyboard shortcuts** are introduced, so `ShortcutsOverlay.svelte` needs no change (CLAUDE.md § Keyboard shortcuts applies only to added/changed/removed shortcuts).
- **Naming is consistent across tasks:** `applyScope`, `folderScope`, `idsScope`, `scopeFilterKeys`, `scopeChip`, `isInsideDir`, `listSubdirsWithCounts`, `selectAll`/`selectNone`/`toggle`/`selectedDirs`, `fetchSubdirs`. Each is defined once and referenced by that exact name everywhere else.
