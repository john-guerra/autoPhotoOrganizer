# Toolbar redesign (inline stateful filters + clusters) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the filter popover with inline, always-visible star + orientation widgets and reorganize the menu bar into Source / Organize+Filter / View clusters.

**Architecture:** Keep the click→spec logic pure in `filterSpec.js` (unit-tested); `RatingFilter.svelte` / `OrientationFilter.svelte` are thin presentational wrappers emitting the same `change` event the popover did. Filter semantics unchanged. Toolbar markup stays inline in App.svelte (binds to too much App state to extract).

**Tech Stack:** Svelte + Vite, vitest. Design doc: `docs/superpowers/specs/2026-07-08-toolbar-redesign-design.md`.

## Global Constraints

- ESM, plain JS + JSDoc. Tests colocated `*.test.js`.
- **Filter semantics unchanged**: `minRating` 0 = Any; orientations all-3-or-0 = off. Reuse `filterSpec.js` (`ORIENTATIONS`, `DEFAULT_FILTER`, `isActive`).
- **Star visual reuses `Stars.svelte`**: glyph `★`, on `#ffc93c`, off `#4a4a4a`.
- Accent color already used in the bar: `#4c9aff` (active) / dark text `#06121f`.
- App.svelte/CSS changes REQUIRE live browser verification (CLAUDE.md; memory "live-verify-ui-beyond-review").

---

### Task 1: pure filter-mutation helpers (`ui/src/lib/filterSpec.js`)

**Files:** Modify `ui/src/lib/filterSpec.js`; Test `ui/src/lib/filterSpec.test.js`.

**Interfaces — Produces:**
- `applyRatingClick(spec, k) → newSpec` — clicking star `k` (1..5): sets `minRating=k`, unless it already equals `k`, then clears to `0`.
- `toggleOrientation(spec, o) → newSpec` — add/remove orientation `o`, result in canonical `ORIENTATIONS` order.

- [ ] **Step 1: Write failing tests** — add to `ui/src/lib/filterSpec.test.js`:

```js
import { applyRatingClick, toggleOrientation } from "./filterSpec.js";

describe("applyRatingClick", () => {
  it("sets the threshold to the clicked star", () => {
    expect(applyRatingClick({ minRating: 0, orientations: ORIENTATIONS }, 4).minRating).toBe(4);
  });
  it("clicking the current threshold star clears to Any (0)", () => {
    expect(applyRatingClick({ minRating: 4, orientations: ORIENTATIONS }, 4).minRating).toBe(0);
  });
  it("preserves orientations untouched", () => {
    const out = applyRatingClick({ minRating: 0, orientations: ["portrait"] }, 2);
    expect(out.orientations).toEqual(["portrait"]);
  });
});

describe("toggleOrientation", () => {
  it("removes an included orientation", () => {
    expect(toggleOrientation({ minRating: 0, orientations: ORIENTATIONS }, "landscape").orientations)
      .toEqual(["portrait", "square"]);
  });
  it("adds an excluded orientation back in canonical order", () => {
    expect(toggleOrientation({ minRating: 0, orientations: ["square"] }, "landscape").orientations)
      .toEqual(["landscape", "square"]);
  });
  it("preserves minRating untouched", () => {
    expect(toggleOrientation({ minRating: 3, orientations: ORIENTATIONS }, "portrait").minRating).toBe(3);
  });
});
```

- [ ] **Step 2: Run to confirm fail** — `npx vitest run ui/src/lib/filterSpec.test.js` → FAIL (functions undefined).

- [ ] **Step 3: Implement** — append to `ui/src/lib/filterSpec.js`:

```js
/** Click star k (1..5): set the threshold to k, or clear to 0 if k is already
 * the current threshold (click-again-to-clear). @returns a new spec. */
export function applyRatingClick(spec, k) {
  const current = spec?.minRating ?? 0;
  return { ...spec, minRating: current === k ? 0 : k };
}

/** Toggle orientation `o` in/out of the included set, result in canonical
 * ORIENTATIONS order. @returns a new spec. */
export function toggleOrientation(spec, o) {
  const set = new Set(spec?.orientations ?? []);
  set.has(o) ? set.delete(o) : set.add(o);
  return { ...spec, orientations: ORIENTATIONS.filter((x) => set.has(x)) };
}
```

- [ ] **Step 4: Run to confirm pass** — `npx vitest run ui/src/lib/filterSpec.test.js` → PASS.

- [ ] **Step 5: Commit** — `git add ui/src/lib/filterSpec.js ui/src/lib/filterSpec.test.js && git commit -m "feat: pure rating-click and orientation-toggle helpers"`

---

### Task 2: RatingFilter component (`ui/src/lib/RatingFilter.svelte`)

**Files:** Create `ui/src/lib/RatingFilter.svelte`.
**Interfaces — Consumes:** `applyRatingClick` (Task 1). **Produces:** `export let filter`; emits `change` with the new spec.

- [ ] **Step 1: Create the component**

```svelte
<script>
  import { createEventDispatcher } from "svelte";
  import { applyRatingClick } from "./filterSpec.js";

  export let filter;
  const dispatch = createEventDispatcher();
  let hover = 0;
  $: min = filter?.minRating ?? 0;
  const STARS = [1, 2, 3, 4, 5];

  function click(k) {
    dispatch("change", applyRatingClick(filter, k));
  }
</script>

<div class="rating" role="group" aria-label="Filter by minimum rating">
  <span class="ge" class:active={min > 0} aria-hidden="true">≥</span>
  <div class="stars" on:mouseleave={() => (hover = 0)}>
    {#each STARS as k}
      <button
        type="button"
        class="star"
        class:on={(hover || min) >= k}
        class:preview={hover >= k && hover !== min}
        on:mouseenter={() => (hover = k)}
        on:click={() => click(k)}
        aria-label={`filter: ${k} star${k > 1 ? "s" : ""} or more`}
        aria-pressed={min >= k}
      >★</button>
    {/each}
  </div>
</div>

<style>
  .rating { display: inline-flex; align-items: center; gap: 4px; }
  .ge { font-size: 0.85rem; color: #6a6a6a; font-weight: 600; }
  .ge.active { color: #ffc93c; }
  .stars { display: inline-flex; gap: 1px; }
  .star {
    background: none; border: none; padding: 0 1px; cursor: pointer;
    font-size: 1.15rem; line-height: 1; color: #4a4a4a; transition: color 0.08s;
  }
  .star.on { color: #ffc93c; }
  .star.preview { color: #7a6a2c; } /* dim amber while hovering a higher slot */
</style>
```

- [ ] **Step 2: Build** — `npm run build` → succeeds.
- [ ] **Step 3: Commit** — `git add ui/src/lib/RatingFilter.svelte && git commit -m "feat: inline RatingFilter star-threshold widget"`

---

### Task 3: OrientationFilter component (`ui/src/lib/OrientationFilter.svelte`)

**Files:** Create `ui/src/lib/OrientationFilter.svelte`.
**Interfaces — Consumes:** `toggleOrientation`, `ORIENTATIONS` (Task 1). **Produces:** `export let filter`; emits `change`.

- [ ] **Step 1: Create the component** (CSS-drawn shapes, not glyphs)

```svelte
<script>
  import { createEventDispatcher } from "svelte";
  import { ORIENTATIONS, toggleOrientation } from "./filterSpec.js";

  export let filter;
  const dispatch = createEventDispatcher();
  const LABELS = { landscape: "Landscape", portrait: "Portrait", square: "Square" };
  $: on = new Set(filter?.orientations ?? []);

  function toggle(o) {
    dispatch("change", toggleOrientation(filter, o));
  }
</script>

<div class="orient" role="group" aria-label="Filter by orientation">
  {#each ORIENTATIONS as o}
    <button
      type="button"
      class="shape {o}"
      class:on={on.has(o)}
      on:click={() => toggle(o)}
      title={LABELS[o]}
      aria-label={LABELS[o]}
      aria-pressed={on.has(o)}
    ><span class="glyph"></span></button>
  {/each}
</div>

<style>
  .orient { display: inline-flex; gap: 4px; align-items: center; }
  .shape {
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; padding: 0; cursor: pointer;
    background: transparent; border: 1px solid #333; border-radius: 5px;
  }
  .shape .glyph { border: 1.5px solid #6a6a6a; border-radius: 1px; }
  .shape.landscape .glyph { width: 15px; height: 10px; }
  .shape.portrait .glyph { width: 10px; height: 15px; }
  .shape.square .glyph { width: 12px; height: 12px; }
  .shape.on { border-color: #4c9aff; background: rgba(76, 154, 255, 0.14); }
  .shape.on .glyph { border-color: #4c9aff; }
</style>
```

- [ ] **Step 2: Build** — `npm run build` → succeeds.
- [ ] **Step 3: Commit** — `git add ui/src/lib/OrientationFilter.svelte && git commit -m "feat: inline OrientationFilter shape-toggle widget"`

---

### Task 4: App.svelte — clusters, inline filters, add-folder popover, view cell, burst toggle

**Files:** Modify `ui/src/App.svelte`; delete `ui/src/lib/FilterPanel.svelte` and `ui/src/lib/FilterPanel.test.js` (if the latter exists).

**Read first:** the `<header class="topbar">` block (~L1534-1660), the `.topbar`/`.dir`/`.scan`/`.zoom`/`.burst-gap`/`.status`/`.library` CSS (~L1836-2010), and the burst/zoom state (`burstGapMs` ~L63-69, `ZOOM_LEVELS`/`zoom`, `$: stacks = detectBurstsByGroup(...)` ~L953).

- [ ] **Step 1: Swap FilterPanel import for the two widgets + Clear helper**

Replace `import FilterPanel from "./lib/FilterPanel.svelte";` with:
```js
  import RatingFilter from "./lib/RatingFilter.svelte";
  import OrientationFilter from "./lib/OrientationFilter.svelte";
```
Ensure `isActive` is imported from `./lib/filterSpec.js` (it already is, as `filterIsActive`). Add `DEFAULT_FILTER` to that import if not present.

- [ ] **Step 2: Add `burstEnabled` state and gate burst detection**

Near the burst-gap state (~L63):
```js
  const LS_BURST_ENABLED = "autogallery.burstEnabled";
  let burstEnabled = localStorage.getItem(LS_BURST_ENABLED) !== "false"; // default on
  $: localStorage.setItem(LS_BURST_ENABLED, String(burstEnabled));
```
Change the stacks reactive (~L953):
```js
  $: stacks = detectBurstsByGroup(items, groupBy, {
    gapMs: burstEnabled ? burstGapMs : 0,
  });
```

- [ ] **Step 3: Restructure the topbar markup into three clusters**

Replace the flat topbar children with this structure (keeping existing handlers/bindings: `dir`, `doScan`, `chooseFolder`, `hasNativePicker`, `libraryOpen`, `library`, `selectFromLibrary`, `manageLibraryOpen`, `groupBySelector`, `sidebarMode`, `revealCurrentLocation`, `zoom`, `ZOOM_LEVELS`, `burstGapMs`, `status`, `error`, `thumbProgress`, `thumbCounts`). Concretely:

```svelte
  <header class="topbar">
    <h1>AutoGallery</h1>

    <!-- ① SOURCE -->
    <div class="cluster source">
      <div class="library">
        <button class="library-toggle" on:click={() => (libraryOpen = !libraryOpen)} title="Recently scanned folders">Library ▾</button>
        {#if libraryOpen}
          <ul class="library-panel"><!-- KEEP the existing library-panel <li> contents verbatim --></ul>
        {/if}
      </div>
      <div class="add-folder">
        <button class="add-toggle" on:click={() => (addFolderOpen = !addFolderOpen)} title="Add / scan a folder" aria-label="Add folder">＋</button>
        {#if addFolderOpen}
          <div class="add-panel">
            <input class="dir" type="text" placeholder="/path/to/photos" bind:value={dir}
              on:keydown={(e) => e.key === "Enter" && doScan()} spellcheck="false" />
            <div class="add-actions">
              <button class="scan" on:click={doScan} disabled={scanning}>{scanning ? "Scanning…" : "Scan"}</button>
              {#if hasNativePicker}
                <button class="choose-folder" on:click={chooseFolder} disabled={scanning}>Choose Folder…</button>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    </div>

    <div class="divider"></div>

    <!-- ② ORGANIZE & FILTER -->
    <div class="cluster organize">
      <div class="group-by" use:groupBySelector={groupBy}></div>
      <RatingFilter {filter} on:change={(e) => onFilterChange(e.detail)} />
      <OrientationFilter {filter} on:change={(e) => onFilterChange(e.detail)} />
      {#if filterIsActive(filter)}
        <button class="clear-filter" title="Clear filters" aria-label="Clear filters"
          on:click={() => onFilterChange({ ...DEFAULT_FILTER })}>✕</button>
      {/if}
    </div>

    <div class="divider"></div>

    <!-- ③ VIEW -->
    <div class="cluster view">
      <div class="sidebar-toggle" role="group" aria-label="Sidebar view"><!-- KEEP existing Tree/Fisheye buttons --></div>
      <button class="reveal-btn" on:click={revealCurrentLocation} title="Reveal the current photo's location in the tree">⌖ Locate</button>
      <div class="view-cell">
        <label class="zoom" title="Grid zoom (also + / - keys)">
          <span class="zoom-icon small">▦</span>
          <input type="range" min="0" max={ZOOM_LEVELS.length - 1} step="1" bind:value={zoom} />
          <span class="zoom-icon">▦</span>
        </label>
        <label class="burst" title="Group photos taken close in time as a burst">
          <input type="checkbox" bind:checked={burstEnabled} />
          <span class="burst-label">Burst</span>
          <input type="range" min="0" max="10000" step="500" bind:value={burstGapMs} disabled={!burstEnabled} />
          <span class="burst-value" class:off={!burstEnabled}>{(burstGapMs / 1000).toFixed(1)}s</span>
        </label>
      </div>
    </div>

    <span class="status" class:err={!!error}>{error || status}</span>
    {#if thumbProgress}
      <span class="thumb-progress" class:err={thumbCounts.error > 0}>{thumbProgress}</span>
    {/if}
    {#if manageLibraryOpen}
      <ManageLibrary {library} on:close={() => (manageLibraryOpen = false)} on:folderRemoved={onFolderRemoved} />
    {/if}
  </header>
```

Add the `addFolderOpen` state near `libraryOpen`:
```js
  let addFolderOpen = false;
```

- [ ] **Step 4: CSS — clusters, dividers, add-folder popover, view cell, status-right**

Add/adjust in the `<style>` block:
```css
  .cluster { display: flex; align-items: center; gap: 0.6rem; min-width: 0; }
  .cluster.organize { flex-wrap: wrap; } /* pills wrap WITHIN the cluster, not pushing siblings */
  .divider { width: 1px; align-self: stretch; background: #2a2a2a; margin: 2px 0; }
  .status { margin-left: auto; } /* push status + progress to the far right */

  .add-folder { position: relative; }
  .add-toggle {
    background: #101010; border: 1px solid #333; color: #cfcfcf;
    border-radius: 6px; padding: 3px 9px; font-size: 0.95rem; line-height: 1; cursor: pointer;
  }
  .add-panel {
    position: absolute; top: calc(100% + 6px); left: 0; z-index: 50;
    background: #0d0d0d; border: 1px solid #333; border-radius: 8px; padding: 10px;
    display: flex; flex-direction: column; gap: 8px; min-width: 260px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  }
  .add-actions { display: flex; gap: 8px; }

  .view-cell {
    display: flex; align-items: center; gap: 10px;
    background: #141414; border: 1px solid #2f2f2f; border-radius: 6px; padding: 3px 8px;
  }
  .burst { display: inline-flex; align-items: center; gap: 5px; font-size: 0.78rem; color: #9a9a9a; }
  .burst input[type="range"]:disabled { opacity: 0.4; }
  .burst-value.off { opacity: 0.4; }
  .clear-filter {
    background: transparent; border: 1px solid #444; color: #cfcfcf;
    border-radius: 50%; width: 20px; height: 20px; line-height: 1; font-size: 0.7rem; cursor: pointer;
  }
```
Keep the existing `.dir`, `.scan`, `.zoom`, `.zoom-icon`, `.library*`, `.sidebar-toggle`, `.reveal-btn` rules (they still apply inside the popover/clusters). Remove the old `.burst-gap*` rules if now unused, or leave them harmless.

- [ ] **Step 5: Delete the popover component**
```bash
git rm ui/src/lib/FilterPanel.svelte
[ -f ui/src/lib/FilterPanel.test.js ] && git rm ui/src/lib/FilterPanel.test.js || true
```

- [ ] **Step 6: Build + full suite**
Run `npm run build` (no Svelte errors; no dangling FilterPanel import) and `npm test` (all green — no test depended on FilterPanel).

- [ ] **Step 7: Commit**
```bash
git add ui/src/App.svelte
git commit -m "feat: clustered toolbar with inline filters, add-folder popover, burst toggle"
```

---

### Task 5: Live browser verification

**Files:** none. Required — App.svelte + CSS.

- [ ] **Step 1:** Ensure `npm run dev` is running (restart if server code changed; UI hot-reloads). Open `http://localhost:5173`.
- [ ] **Step 2: Rating widget** — click the 3rd star → grid + Library total drop to the ≥3 set; the `≥` and stars 1–3 show amber; hovering star 5 previews; click the 3rd star again → clears to Any (all empty, total restored).
- [ ] **Step 3: Orientation** — toggle Landscape off → only portrait/square remain (shape unlit); confirm the total matches; toggle back.
- [ ] **Step 4: Clear** — with a filter active, the `✕` appears; click → filter clears, `✕` disappears.
- [ ] **Step 5: Source** — the bare path/Scan are gone from the bar; `＋` opens the add-folder popover; paste a path + Enter scans; Library ▾ still lists folders.
- [ ] **Step 6: Burst** — uncheck Burst → burst stacks disappear in the grid and the gap slider dims; re-check → stacks return with the remembered gap.
- [ ] **Step 7: Layout** — at the normal window width, one row, three clusters with dividers, no overflow, no pill-wrapping pushing the title; status sits at the far right, muted. Take a screenshot to confirm.
- [ ] **Step 8:** If anything is off, fix via superpowers:systematic-debugging (check localStorage state + the `/api/feed?...&filter=` response before client theories).

---

## Self-Review notes
- Spec coverage: inline rating (T1/T2), inline orientation (T1/T3), clear ✕ (T4), clusters+dividers (T4), add-folder popover folding Scan/path/Choose (T4), view cell + burst checkbox (T2-state + T4), status-right (T4), remove FilterPanel (T4), live verify (T5). All mapped.
- Pure logic (`applyRatingClick`/`toggleOrientation`) is unit-tested; components are thin wrappers (build-verified + live-verified) — no component-test framework introduced.
- No filter-semantics change; `onFilterChange` reused as-is.
