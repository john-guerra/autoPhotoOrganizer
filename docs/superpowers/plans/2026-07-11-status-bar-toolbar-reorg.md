# Status bar + toolbar reorg (#82) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move ambient read-only state (counts, status/progress, zoom, burst, sort) out of the top toolbar into a new bottom status bar, and give the group-by widget a compact single-row layout so the toolbar stops wrapping.

**Architecture:** A new presentational `StatusBar.svelte` footer receives state as props from `App.svelte` (no logic moves — markup and scoped CSS are _lifted verbatim_ from `ViewControls`/`OrganizeControls`/the topbar). The group-by widget gains a backward-compatible `layout:"inline"` option in the separate `multi-auto-select` repo, opted into from `OrganizeControls`.

**Tech Stack:** Svelte 4 (`export let` / `$:` / `createEventDispatcher`, no runes), Vite, vitest, prettier; `multi-auto-select` (htl + sortablejs, built with rollup).

## Global Constraints

- **ESM everywhere**, no TypeScript (plain JS + JSDoc). — CLAUDE.md
- **Svelte 4 idioms only** (`export let`, `$:`, `dispatch`) — repo is pinned to Svelte 4. — [[svelte-4-not-5]]
- **Prettier-clean**: run `npm run format` before each commit; CI gates it. — [[prettier-repo-drift]]
- **Never fail silently**: the relocated status/error + thumb-progress text must keep surfacing failures verbatim (their `err` styling preserved). — CLAUDE.md
- **Version + CHANGELOG per part**: two patch bumps in `package.json` (Part A, Part B), each with a user-facing `CHANGELOG.md` line referencing #82, keeping the `-alpha` suffix. — CLAUDE.md
- **Branch**: `feat/82-status-bar-toolbar-reorg` (already created, off `main`).
- **Two repos**: AutoGallery at `/Users/aguerra/workspace/autogallery`; the widget at `/Users/aguerra/workspace/multi-auto-select` (John owns it; AutoGallery depends on `multi-auto-select@^0.0.11` in `ui/package.json`).
- **No merge with a linked/`file:` dependency** — the dep must point at a published version before the branch merges (Task 6, may be a fast-follow).
- **Verification is browser-based** for this chrome/CSS work (project convention for `App.svelte`/CSS — [[live-verify-ui-beyond-review]]); each task also keeps `npm test` green as a regression guard. There are no new pure-logic units, so no new `*.test.js`.

---

## File Structure

**AutoGallery (`ui/src/`):**

- Create: `lib/StatusBar.svelte` — bottom footer; renders counts + status/progress (left) and zoom + burst + sort (right). Presentational.
- Modify: `App.svelte` — render `<StatusBar>` after `.app-body`; remove `.counts`, `.status`, `.thumb-progress` from the topbar; stop passing zoom/burst to `ViewControls` and sort to `OrganizeControls`; add footer to layout.
- Modify: `lib/ViewControls.svelte` — remove the zoom + burst `.view-cell` and its CSS + the four props.
- Modify: `lib/OrganizeControls.svelte` — remove the `.sort-control` markup + CSS + `sort` prop; add `layout:"inline"` to the `MultiAutoSelect(...)` call (Task 5).
- Modify: `package.json`, `CHANGELOG.md` — version bumps + changelog lines.

**Widget (`multi-auto-select/`):**

- Modify: `src/index.js` — add `layout` option (`"stacked"` default | `"inline"`); inline template branch + CSS.
- Modify: `package.json` — version `0.0.11 → 0.0.12`.
- Rebuild: `dist/` via `npm run build`.
- Modify: `example/index.html` — point at the local `dist` build to verify inline layout.

---

## Task 1: StatusBar footer — left region (counts + status + thumb-progress)

Create the footer and move the read-only text block out of the topbar. The right region (zoom/burst/sort) is added in Task 2; for now `.sb-right` is empty.

**Files:**

- Create: `ui/src/lib/StatusBar.svelte`
- Modify: `ui/src/App.svelte` — import + render `<StatusBar>` after `.app-body` close (before `.app` close, ~L3197); remove the `.counts` block (~L2801-2810) and the `.status`/`.thumb-progress` spans (~L2850-2855); remove their now-unused CSS (`.counts*` ~L3294-3312, `.status*` ~L3386-3395, `.thumb-progress*` ~L3396-3403).

**Interfaces:**

- Produces (`StatusBar.svelte` props): `libraryTotal:number`, `showingCount:number`, `selectedCount:number`, `status:string`, `error:string`, `thumbProgress:string`, `thumbCounts:{error:number}`. (Zoom/burst/sort props + `sortchange` event added in Task 2.)
- Consumes: existing `App.svelte` state vars `libraryTotal`, `showingCount`, `selectedCount`, `status`, `error`, `thumbProgress`, `thumbCounts`.

- [ ] **Step 1: Create `ui/src/lib/StatusBar.svelte` with the left region**

```svelte
<script>
  /**
   * Bottom status bar (#82): read-only ambient state, separated from the
   * top toolbar's actions. Left region = counts + transient status/error +
   * thumb-progress. Right region (zoom / burst / sort) is added in the next
   * step of the reorg. Presentational — App owns the state.
   */
  export let libraryTotal = 0;
  export let showingCount = 0;
  export let selectedCount = 0;
  export let status = "";
  export let error = "";
  export let thumbProgress = "";
  export let thumbCounts = { error: 0 };
</script>

<footer class="statusbar">
  <div class="sb-left">
    <div
      class="counts"
      title="Photos in the whole library · shown under the current filter/focus · currently selected"
    >
      <span>{libraryTotal.toLocaleString()} <em>library</em></span>
      <span>{showingCount.toLocaleString()} <em>showing</em></span>
      <span class:has-sel={selectedCount > 0}
        >{selectedCount.toLocaleString()} <em>selected</em></span
      >
    </div>
    {#if error || status}
      <span class="status" class:err={!!error}>{error || status}</span>
    {/if}
    {#if thumbProgress}
      <span class="thumb-progress" class:err={thumbCounts.error > 0}>
        {thumbProgress}
      </span>
    {/if}
  </div>

  <div class="sb-right"></div>
</footer>

<style>
  .statusbar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.3rem 1rem;
    background: #1c1c1c;
    border-top: 1px solid #2a2a2a;
    flex-shrink: 0;
  }
  .sb-left {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
  }
  .sb-right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-left: auto;
    flex-shrink: 0;
  }
  /* Three-level counts: library / showing / selected (lifted from topbar). */
  .counts {
    display: flex;
    gap: 10px;
    font-size: 0.8rem;
    color: #cfcfcf;
    white-space: nowrap;
  }
  .counts em {
    font-style: normal;
    color: #808080;
  }
  .counts .has-sel {
    color: #ffd24c;
    font-weight: 600;
  }
  .counts .has-sel em {
    color: #b9932f;
  }
  .status {
    color: #9a9a9a;
    font-size: 0.85rem;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .status.err {
    color: #ff6b6b;
  }
  .thumb-progress {
    color: #9a9a9a;
    font-size: 0.8rem;
    white-space: nowrap;
  }
  .thumb-progress.err {
    color: #ff8a80;
  }
</style>
```

- [ ] **Step 2: Import `StatusBar` in `App.svelte`**

Add to the component-import block near the other lib imports (next to `import SelectionBar from "./lib/SelectionBar.svelte";` ~L74):

```js
import StatusBar from "./lib/StatusBar.svelte";
```

- [ ] **Step 3: Render `<StatusBar>` as the last child of `.app`**

In the markup, immediately AFTER the `.app-body` closing `</div>` and BEFORE the `.app` closing `</div>` (~L3197), insert:

```svelte
<StatusBar
  {libraryTotal}
  {showingCount}
  {selectedCount}
  {status}
  {error}
  {thumbProgress}
  {thumbCounts}
/>
```

- [ ] **Step 4: Remove the `.counts` block from the topbar**

Delete these lines from the `<header class="topbar">` (~L2801-2810):

```svelte
<div
  class="counts"
  title="Photos in the whole library · shown under the current filter/focus · currently selected"
>
  <span>{libraryTotal.toLocaleString()} <em>library</em></span>
  <span>{showingCount.toLocaleString()} <em>showing</em></span>
  <span class:has-sel={selectedCount > 0}
    >{selectedCount.toLocaleString()} <em>selected</em></span
  >
</div>
```

- [ ] **Step 5: Remove the `.status`/`.thumb-progress` spans from the topbar**

Delete these lines (~L2850-2855):

```svelte
<span class="status" class:err={!!error}>{error || status}</span>
{#if thumbProgress}
  <span class="thumb-progress" class:err={thumbCounts.error > 0}>
    {thumbProgress}
  </span>
{/if}
```

- [ ] **Step 6: Remove the now-orphaned CSS from `App.svelte`**

Delete the `.counts`, `.counts em`, `.counts .has-sel`, `.counts .has-sel em` rules (~L3294-3312), the `.status` + `.status.err` rules (~L3386-3395), and the `.thumb-progress` + `.thumb-progress.err` rules (~L3396-3403). (They now live in `StatusBar.svelte`.)

- [ ] **Step 7: Format, test, build**

Run:

```bash
cd /Users/aguerra/workspace/autogallery && npm run format && npm test && npm run build
```

Expected: prettier writes no complaints, vitest run PASSES (unchanged suite — regression guard), Vite build succeeds.

- [ ] **Step 8: Browser-verify (project convention for App.svelte/CSS)**

Run `npm run dev`, open the UI, scan a test folder ([[test-photo-folders]], read-only). Confirm:

- A bottom status bar appears with `N library · N showing · N selected`.
- Selecting photos updates `selected` live (yellow emphasis when > 0).
- The counts and status text are GONE from the top toolbar.
- During a scan, status/error + thumb-progress text appear in the status bar's left region.

- [ ] **Step 9: Commit**

```bash
cd /Users/aguerra/workspace/autogallery && git add ui/src/lib/StatusBar.svelte ui/src/App.svelte
git commit -m "feat(ui): bottom status bar — move counts/status/progress out of toolbar (#82)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HSaVUT2ojBQQZxqYN4h7YV"
```

---

## Task 2: StatusBar right region — move zoom + burst + sort

Lift the zoom + burst `.view-cell` out of `ViewControls` and the `.sort-control` out of `OrganizeControls` into `StatusBar`'s `.sb-right`, sort rightmost. After this, Part A is complete → version bump + CHANGELOG.

**Files:**

- Modify: `ui/src/lib/StatusBar.svelte` — add zoom/burst/sort props + `sortchange` event; fill `.sb-right`; add lifted CSS.
- Modify: `ui/src/lib/ViewControls.svelte` — remove `zoom`, `zoomMax`, `burstEnabled`, `burstGapMs` props; remove the `.view-cell` block (~L84-104) and its CSS (`.view-cell`, `.zoom*`, `.burst*` ~L155-193).
- Modify: `ui/src/lib/OrganizeControls.svelte` — remove `sort` prop; remove the `.sort-control` block (~L53-75) + `sortchange` dispatch; remove `SORT_ATTRS`/`SORT_LABELS` from the `dimensions.js` import (keep `ALL_DIMENSIONS`); remove `.sort-control`/`.sort-by`/`.sort-dir` CSS (~L182-212).
- Modify: `ui/src/App.svelte` — move the `bind:zoom`, `zoomMax`, `bind:burstEnabled`, `bind:burstGapMs` bindings off `<ViewControls>` and the `{sort}` + `on:sortchange` off `<OrganizeControls>`, onto `<StatusBar>`.
- Modify: `ui/package.json` (version bump), `CHANGELOG.md`.

**Interfaces:**

- Produces (`StatusBar.svelte` adds): props `zoom:number` (bindable), `zoomMax:number`, `burstEnabled:boolean` (bindable), `burstGapMs:number` (bindable), `sort:{by,dir}`; event `sortchange` with `{by,dir}` detail (identical shape to OrganizeControls' current `sortchange`).
- Consumes: `dimensions.js` exports `SORT_ATTRS:string[]`, `SORT_LABELS:Record<string,string>` (already used by OrganizeControls today); App's `onSortChange(detail)` handler (unchanged).

- [ ] **Step 1: Add zoom/burst/sort to `StatusBar.svelte`**

Add to the `<script>` (after the existing props):

```js
import { createEventDispatcher } from "svelte";
import { SORT_ATTRS, SORT_LABELS } from "./dimensions.js";

export let zoom = 2;
export let zoomMax = 4;
export let burstEnabled = true;
export let burstGapMs = 3000;
export let sort = { by: "date_taken", dir: "asc" };

const dispatch = createEventDispatcher();
```

Replace `<div class="sb-right"></div>` with:

```svelte
<div class="sb-right">
  <label class="zoom" title="Grid zoom (also + / - keys)">
    <span class="zoom-icon small">▦</span>
    <input type="range" min="0" max={zoomMax} step="1" bind:value={zoom} />
    <span class="zoom-icon">▦</span>
  </label>
  <label class="burst" title="Group photos taken close in time as a burst">
    <input type="checkbox" bind:checked={burstEnabled} />
    <span class="burst-label">Burst</span>
    <input
      type="range"
      min="0"
      max="10000"
      step="500"
      bind:value={burstGapMs}
      disabled={!burstEnabled}
    />
    <span class="burst-value" class:off={!burstEnabled}
      >{(burstGapMs / 1000).toFixed(1)}s</span
    >
  </label>
  <div class="sort-control" title="Sort photos">
    <select
      class="sort-by"
      value={sort.by}
      on:change={(e) => dispatch("sortchange", { ...sort, by: e.target.value })}
    >
      {#each SORT_ATTRS as key}
        <option value={key}>{SORT_LABELS[key]}</option>
      {/each}
    </select>
    <button
      class="sort-dir"
      title="Toggle ascending / descending"
      aria-label="Toggle sort direction"
      on:click={() =>
        dispatch("sortchange", {
          ...sort,
          dir: sort.dir === "asc" ? "desc" : "asc",
        })}
    >
      {sort.dir === "asc" ? "↑" : "↓"}
    </button>
  </div>
</div>
```

Add the lifted CSS inside `StatusBar.svelte`'s `<style>` (verbatim from ViewControls `.zoom*`/`.burst*` and OrganizeControls `.sort-control`/`.sort-by`/`.sort-dir`):

```css
.zoom {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #777;
}
.zoom input[type="range"] {
  width: 90px;
  accent-color: #4c9aff;
}
.zoom-icon {
  font-size: 1rem;
  line-height: 1;
}
.zoom-icon.small {
  font-size: 0.7rem;
}
.burst {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.78rem;
  color: #9a9a9a;
}
.burst input[type="range"] {
  width: 90px;
  accent-color: #4c9aff;
}
.burst input[type="range"]:disabled {
  opacity: 0.4;
}
.burst-value.off {
  opacity: 0.4;
}
.sort-control {
  display: flex;
  align-items: center;
  gap: 2px;
  background: #101010;
  border: 1px solid #333;
  border-radius: 6px;
  padding: 2px;
}
.sort-by {
  background: transparent;
  border: none;
  color: #cfcfcf;
  font-size: 0.8rem;
  padding: 3px 4px;
  cursor: pointer;
}
.sort-dir {
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #9a9a9a;
  font-size: 0.9rem;
  line-height: 1;
  padding: 3px 7px;
  cursor: pointer;
}
.sort-dir:hover {
  background: #222;
  color: #e8e8e8;
}
```

- [ ] **Step 2: Remove zoom/burst from `ViewControls.svelte`**

Delete the four props `zoom`, `zoomMax`, `burstEnabled`, `burstGapMs` from `<script>`. Delete the entire `<div class="view-cell"> … </div>` block (the zoom + burst labels). Delete the `.view-cell`, `.zoom`, `.zoom input[type="range"]`, `.zoom-icon`, `.zoom-icon.small`, `.burst`, `.burst input[type="range"]`, `.burst input[type="range"]:disabled`, `.burst-value.off` CSS rules. Update the component's top JSDoc comment to drop the "zoom + burst sliders" mention.

- [ ] **Step 3: Remove sort from `OrganizeControls.svelte`**

Delete the `sort` prop. Delete the `<div class="sort-control"> … </div>` block (~L53-75). Change the dimensions import from `import { ALL_DIMENSIONS, SORT_ATTRS, SORT_LABELS } from "./dimensions.js";` to `import { ALL_DIMENSIONS } from "./dimensions.js";`. Delete the `.sort-control`, `.sort-by`, `.sort-dir`, `.sort-dir:hover` CSS. Update the top JSDoc to drop the "feed sort" mention.

- [ ] **Step 4: Rewire the bindings in `App.svelte`**

On `<ViewControls>` (~L2786-2799), remove the four lines `bind:zoom`, `zoomMax={ZOOM_LEVELS.length - 1}`, `bind:burstEnabled`, `bind:burstGapMs`.

On `<OrganizeControls>` (~L2768-2781), remove `{sort}` and the `on:sortchange={(e) => onSortChange(e.detail)}` line.

On `<StatusBar>` (added in Task 1), add:

```svelte
bind:zoom zoomMax={ZOOM_LEVELS.length - 1}
bind:burstEnabled bind:burstGapMs
{sort}
on:sortchange={(e) => onSortChange(e.detail)}
```

- [ ] **Step 5: Format, test, build**

Run:

```bash
cd /Users/aguerra/workspace/autogallery && npm run format && npm test && npm run build
```

Expected: prettier clean, vitest PASS, build succeeds.

- [ ] **Step 6: Browser-verify**

`npm run dev`, scan a read-only test folder. Confirm:

- Status bar right side shows `[zoom] [burst] [sort]`, sort rightmost.
- Dragging zoom resizes the grid exactly as before; toggling burst + moving its gap reclusters; changing sort attr/direction reorders the feed — all identical to pre-change behavior.
- Those controls are GONE from the top toolbar; the top toolbar no longer wraps to a second row at normal width (or wraps noticeably less — the widget's own height is addressed in Part B).

- [ ] **Step 7: Bump version + CHANGELOG (Part A complete)**

In `package.json`, bump the patch number (e.g. `2.8.12-alpha → 2.8.13-alpha`; use the actual current value). In `CHANGELOG.md`, add a new top entry:

```markdown
## <new-version>

- New bottom status bar shows library/showing/selected counts, scan status, zoom, burst, and sort — freeing the top toolbar for actions (#82).
```

- [ ] **Step 8: Format + commit**

```bash
cd /Users/aguerra/workspace/autogallery && npm run format
git add ui/src/lib/StatusBar.svelte ui/src/lib/ViewControls.svelte ui/src/lib/OrganizeControls.svelte ui/src/App.svelte package.json CHANGELOG.md
git commit -m "feat(ui): move zoom/burst/sort into the status bar (#82)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HSaVUT2ojBQQZxqYN4h7YV"
```

---

## Task 3: Compact `layout:"inline"` option in `multi-auto-select`

Add a backward-compatible inline layout to the widget so pills sit beside the input (not stacked below) and empty title/description rows are omitted. Default behavior is unchanged.

**Files:**

- Modify: `/Users/aguerra/workspace/multi-auto-select/src/index.js`
- Modify: `/Users/aguerra/workspace/multi-auto-select/package.json` (version `0.0.11 → 0.0.12`)
- Modify: `/Users/aguerra/workspace/multi-auto-select/example/index.html` (verify against local dist)
- Rebuild: `dist/`

**Interfaces:**

- Produces: `MultiAutoSelect(options, { layout: "inline" | "stacked", … })` — new `layout` option, default `"stacked"` (current behavior). Consumed by AutoGallery in Task 5.

> **Note on tests:** the widget repo has no wired test harness (mocha/jsdom are unused devDeps, no `test` script, no specs). Standing one up (htl + sortablejs under jsdom) is disproportionate to a one-option DOM change, so this task verifies via the `example/` page and the AutoGallery integration in Task 5. Flag in the PR that the widget lacks automated tests.

- [ ] **Step 1: Add the `layout` option + inline template branch in `src/index.js`**

In the destructuring of config options (after `sortable = true,` ~L30), add:

```js
    layout = "stacked", // "stacked" (default) | "inline" — inline puts pills beside the input and omits empty title/description
```

Replace the `ReactiveWidget(html\`…\`)` form template (~L117-195) so title/description are conditional and an inline branch flexes the input row and pills together:

```js
const inline = layout === "inline";

const form = ReactiveWidget(
  html`
    <form
      style="min-height: 2.5em"
      class="multi-auto-select ${inline ? "inline" : ""}"
    >
      <style>
        .sortable-ghost {
          opacity: 0.3;
        }
        .pill {
          display: inline-block;
          margin: 7px 2px;
          border: solid 1px #ccc;
          border-radius: 5px;
          padding: 3px 6px;
          cursor: move;
          box-shadow: 1px 1px 1px #777;
          background: white;
        }
        .title {
          font: 700 0.9rem sans-serif;
          margin-bottom: 3px;
        }
        .description {
          font-size: 0.85rem;
          font-style: italic;
          margin-top: 3px;
        }
        input {
          font-size: 1em;
        }
        .selected-options {
          font:
            14px Menlo,
            Consolas,
            monospace;
          margin-left: 0px;
        }
        button.remove {
          margin: 0px;
          padding: 3px;
        }
        .options #remove-area {
          display: none;
          border: 2px dashed #f60;
          height: 100%;
        }
        .options:focus #remove-area, .options:focus-within #remove-area {
          display: inline-block;
        }
        #remove-area::before {
          color: #ccc;
          font-size: 1.2em;
          content: 'Remove';
          text-align: center;
          padding-top: 15px;
        }
        button.clearAll {
          font-size: 0.8em;
          margin-left: 5px;
          padding: 2px 5px;
          border: 1px solid #ccc;
          border-radius: 5px;
          background: white;
          cursor: pointer;
        }
        /* Inline layout: input row and pills share one flexible row; pills
           sit beside the input instead of stacking below it, and empty
           title/description rows are omitted by the template. */
        .multi-auto-select.inline .mas-row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 6px;
        }
        .multi-auto-select.inline .pill {
          margin: 2px;
        }

        ${style}
      </style>
      ${title ? html`<div class="title">${title}</div>` : ""}
      ${
        inline
          ? html`<div class="mas-row">
              <span class="input-row"
                >${label ? html`<label>${label}</label>` : ""}
                ${fmInput}${fmDatalist}${btnClearAll}</span
              >
              <div class="options">
                ${fmOutput} ${sortable ? removeArea : ""}
              </div>
            </div>`
          : html`
              <div>
                ${label ? html`<label>${label}</label>` : ""}
                ${fmInput}${fmDatalist}${btnClearAll}
              </div>
              <div class="options">
                ${fmOutput} ${sortable ? removeArea : ""}
              </div>
            `
      }
      ${description ? html`<div class="description">${description}</div>` : ""}
    </form>
  `,
  { value, showValue: renderSelection }
);
```

(The `.options` class is retained in both branches so the drag-to-remove-area CSS and sortablejs targeting are unchanged.)

- [ ] **Step 2: Build the dist bundle**

Run:

```bash
cd /Users/aguerra/workspace/multi-auto-select && npm run build
```

Expected: rollup writes `dist/MultiAutoSelect.js`, `.esm.js`, `.min.js` with no errors.

- [ ] **Step 3: Point the example page at the local dist + inline layout**

In `example/index.html`, comment out the CDN `multi-auto-select@0.0.8` script and enable the local build, and pass `layout: "inline"`:

```html
<!-- <script src="https://cdn.jsdelivr.net/npm/multi-auto-select@0.0.8"></script> -->
<script src="../dist/MultiAutoSelect.js"></script>
```

and add `layout: "inline",` to the options object in the example's inline `<script>` (alongside `sortable: true,`). **Revert this example edit before committing** (or keep it commented) so the example still works standalone — but use it now to verify.

- [ ] **Step 4: Browser-verify the widget in isolation**

Open `example/index.html` in Chrome. Confirm with `layout:"inline"`:

- Pills render on the SAME row as the text input, not stacked below.
- No empty title/description gap when those are omitted.
- Add (type + pick from datalist), reorder (drag), and remove (drag to the "Remove" area, and the × button) all still work.
- Temporarily set `layout:"stacked"` (or remove it) and confirm the original stacked layout is unchanged.

- [ ] **Step 5: Bump the widget version + revert the example**

In `multi-auto-select/package.json`, set `"version": "0.0.12"`. Revert the `example/index.html` script/`layout` edits (back to the committed CDN reference) so the example isn't left pointing at an uncommitted dist state.

- [ ] **Step 6: Commit the widget change**

```bash
cd /Users/aguerra/workspace/multi-auto-select && git add src/index.js package.json dist
git commit -m "feat: add layout:\"inline\" compact option (pills beside input)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HSaVUT2ojBQQZxqYN4h7YV"
```

---

## Task 4: Opt AutoGallery into the compact group-by (via npm link)

Link the local widget into AutoGallery, opt into `layout:"inline"`, and verify the toolbar no longer wraps. This completes Part B's functional change (publish + dep bump is Task 6).

**Files:**

- Modify: `ui/src/lib/OrganizeControls.svelte` — pass `layout:"inline"` in the `MultiAutoSelect(...)` call.
- Modify: `ui/package.json`, `CHANGELOG.md` — version bump + changelog line.
- Link: `multi-auto-select` into `ui/node_modules` (no committed manifest change).

**Interfaces:**

- Consumes: `MultiAutoSelect(options, { value, placeholder, sortable, layout })` from Task 3.

- [ ] **Step 1: Link the local widget into AutoGallery's `ui/`**

Run:

```bash
cd /Users/aguerra/workspace/multi-auto-select && npm link
cd /Users/aguerra/workspace/autogallery/ui && npm link multi-auto-select
```

Expected: `ui/node_modules/multi-auto-select` becomes a symlink to the local repo (verify with `ls -l node_modules/multi-auto-select`).

- [ ] **Step 2: Pass `layout:"inline"` from `OrganizeControls.svelte`**

In the `groupBySelector` action (~L33-42), update the `MultiAutoSelect` call:

```js
const widget = MultiAutoSelect(ALL_DIMENSIONS, {
  value: initialValue,
  placeholder: "Add a grouping level…",
  sortable: true,
  layout: "inline",
});
```

- [ ] **Step 3: Build + browser-verify no wrap**

Run:

```bash
cd /Users/aguerra/workspace/autogallery && npm run dev
```

Scan a read-only test folder. Confirm:

- The group-by pills sit beside the "Add a grouping level…" input on one row (not stacked).
- The top toolbar no longer wraps onto a second row at normal window width.
- Group-by still works end-to-end: add a level (e.g. Date), reorder pills by dragging, remove a pill — the feed regroups correctly each time.

- [ ] **Step 4: Bump version + CHANGELOG (Part B)**

Bump `package.json` patch (e.g. `→ 2.8.14-alpha`; use the actual current value). Add to `CHANGELOG.md` top:

```markdown
## <new-version>

- Compact single-row group-by control keeps the top toolbar to one row (#82).
```

- [ ] **Step 5: Format + commit the AutoGallery opt-in**

```bash
cd /Users/aguerra/workspace/autogallery && npm run format
git add ui/src/lib/OrganizeControls.svelte package.json CHANGELOG.md
git commit -m "feat(ui): compact single-row group-by via multi-auto-select inline layout (#82)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HSaVUT2ojBQQZxqYN4h7YV"
```

---

## Task 5: Finalize the dependency (publish 0.0.12, unlink) — may be a fast-follow

The branch must not merge while `multi-auto-select` is linked. Publish the widget and pin the real version.

**Files:**

- Modify: `ui/package.json` — dependency `^0.0.11 → ^0.0.12`.

- [ ] **Step 1: Publish the widget (requires npm auth — confirm with John before publishing)**

```bash
cd /Users/aguerra/workspace/multi-auto-select && git push && npm publish
```

Expected: `multi-auto-select@0.0.12` published. (If John prefers not to publish yet, STOP here and leave the branch marked "do not merge — linked dep"; this task is the fast-follow.)

- [ ] **Step 2: Unlink and install the published version**

```bash
cd /Users/aguerra/workspace/autogallery/ui && npm unlink --no-save multi-auto-select
```

Edit `ui/package.json`: set `"multi-auto-select": "^0.0.12"`. Then:

```bash
cd /Users/aguerra/workspace/autogallery/ui && npm install
```

Expected: `node_modules/multi-auto-select` is the published `0.0.12` (no longer a symlink); `package-lock.json` updated.

- [ ] **Step 3: Build + smoke-verify**

```bash
cd /Users/aguerra/workspace/autogallery && npm test && npm run build && npm run dev
```

Confirm the compact group-by still renders (now from the published package) and the toolbar stays one row.

- [ ] **Step 4: Commit the dependency pin**

```bash
cd /Users/aguerra/workspace/autogallery
git add ui/package.json ui/package-lock.json
git commit -m "chore(deps): pin multi-auto-select ^0.0.12 (compact group-by) (#82)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HSaVUT2ojBQQZxqYN4h7YV"
```

---

## Self-Review

**Spec coverage:**

- Bottom status bar with counts/status/thumbs left, zoom/burst/sort right (sort rightmost) → Tasks 1-2. ✓
- Group-by stays in top toolbar, gets compact layout → Tasks 3-4. ✓
- Transient status/error + thumb-progress move to status bar (chosen option) → Task 1. ✓
- JobsPanel untouched → not modified in any task. ✓
- Two patch bumps + CHANGELOG (per part) → Task 2 Step 7, Task 4 Step 4. ✓
- Widget as npm-link-now/publish-later → Task 4 (link) + Task 5 (publish/pin). ✓
- Backward-compatible widget option (default stacked) → Task 3 Step 1 (`layout = "stacked"` default). ✓
- No merge with linked dep → Global Constraints + Task 5. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; version numbers say "use the actual current value" because the live `package.json` value must be read at execution (not a placeholder for _what_ to do). ✓

**Type consistency:** `StatusBar` props (`libraryTotal`, `showingCount`, `selectedCount`, `status`, `error`, `thumbProgress`, `thumbCounts`, `zoom`, `zoomMax`, `burstEnabled`, `burstGapMs`, `sort`) match App's existing var names and the `sortchange` `{by,dir}` detail matches `onSortChange`. Widget `layout` values `"inline"`/`"stacked"` consistent across Tasks 3-4. ✓
