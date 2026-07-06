# Grid Virtualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only mount `Thumb` components for boxes near the viewport, so the justified grid's DOM node count stays roughly flat regardless of folder size, while every existing interaction (keyboard nav, roving focus, rating, zoom, loupe) keeps working unchanged.

**Architecture:** A new pure function `visibleRange(boxes, viewport)` in `ui/src/lib/layouts/windowing.js` binary-searches the y-sorted box array from `justifiedLayout` to find which boxes intersect the current scroll viewport (+ overscan). `App.svelte` calls it on scroll/resize/layout-change, and renders only that index range **plus the currently-selected index** (so keyboard jumps still mount their target and trigger `Thumb`'s existing `scrollIntoView`).

**Tech Stack:** Svelte 4 (no runes), vitest, plain JS + JSDoc (no TypeScript).

## Global Constraints

- ESM everywhere (`"type": "module"`); no TypeScript — plain JS + JSDoc types.
- Tests: vitest, colocated as `*.test.js` next to the source file.
- Do **not** run automated browser/Playwright verification — John verifies visually himself at `localhost:5173`. Run unit tests, then stop and report tersely (working agreement in `docs/ROADMAP.md`).
- Test photo folders (see `docs/TEST_FOLDERS.local.md`, gitignored) are strictly read-only reference for manual verification only — this plan does not write code that touches them directly.
- Commit after each task; do not batch multiple tasks into one commit.
- Full spec: `docs/superpowers/specs/2026-07-06-grid-virtualization-design.md`.

---

### Task 1: `visibleRange` pure windowing function

**Files:**

- Create: `ui/src/lib/layouts/windowing.js`
- Test: `ui/src/lib/layouts/windowing.test.js`

**Interfaces:**

- Produces: `visibleRange(boxes, { scrollTop, viewportHeight, overscanPx = 800 }) → { start: number, end: number }`, exported from `ui/src/lib/layouts/windowing.js`. `boxes` is `Array<{id, x, y, width, height}>` sorted ascending by `y` (guaranteed by `justifiedLayout`). Returns inclusive indices into `boxes`; `{ start: 0, end: -1 }` means nothing is in range.

- [ ] **Step 1: Write the failing tests**

Create `ui/src/lib/layouts/windowing.test.js`:

```js
import { describe, it, expect } from "vitest";
import { visibleRange } from "./windowing.js";

/** N rows of `perRow` boxes each, height `rowHeight`, stacked with `gap`. */
function buildRows(rowCount, { perRow = 2, rowHeight = 100, gap = 8 } = {}) {
  const boxes = [];
  let id = 0;
  for (let r = 0; r < rowCount; r++) {
    const y = r * (rowHeight + gap);
    for (let c = 0; c < perRow; c++) {
      boxes.push({ id: id++, x: c * 100, y, width: 100, height: rowHeight });
    }
  }
  return boxes;
}

describe("visibleRange", () => {
  it("returns an empty range for no boxes", () => {
    expect(visibleRange([], { scrollTop: 0, viewportHeight: 800 })).toEqual({
      start: 0,
      end: -1,
    });
  });

  it("includes only rows intersecting the viewport, no overscan", () => {
    // 5 rows, each 100px + 8px gap: y = 0, 108, 216, 324, 432 (2 boxes/row).
    const boxes = buildRows(5);
    const { start, end } = visibleRange(boxes, {
      scrollTop: 100,
      viewportHeight: 200,
      overscanPx: 0,
    });
    // Viewport [100, 300] overlaps rows 0 (0-100), 1 (108-208), 2 (216-316).
    expect(start).toBe(0);
    expect(end).toBe(5); // rows 0-2, 2 boxes each -> indices 0..5
  });

  it("expands the range with overscanPx", () => {
    const boxes = buildRows(5);
    const tight = visibleRange(boxes, {
      scrollTop: 216,
      viewportHeight: 100,
      overscanPx: 0,
    });
    const overscanned = visibleRange(boxes, {
      scrollTop: 216,
      viewportHeight: 100,
      overscanPx: 200,
    });
    expect(overscanned.end).toBeGreaterThan(tight.end);
    expect(overscanned.start).toBeLessThanOrEqual(tight.start);
  });

  it("returns an empty range when scrolled past all content", () => {
    const boxes = buildRows(5);
    const { start, end } = visibleRange(boxes, {
      scrollTop: 10000,
      viewportHeight: 800,
      overscanPx: 0,
    });
    expect(end).toBeLessThan(start);
  });

  it("includes the first row when the viewport approaches it from above", () => {
    const boxes = buildRows(5);
    const { start, end } = visibleRange(boxes, {
      scrollTop: -50,
      viewportHeight: 100,
      overscanPx: 0,
    });
    expect(start).toBe(0);
    expect(end).toBe(1); // row 0 only (2 boxes)
  });

  it("stays small relative to a large total row count", () => {
    const boxes = buildRows(5000); // 10,000 boxes total
    const { start, end } = visibleRange(boxes, {
      scrollTop: 50000,
      viewportHeight: 800,
    });
    expect(end - start + 1).toBeLessThan(50); // a handful of rows, not 10k
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run ui/src/lib/layouts/windowing.test.js`
Expected: FAIL — `windowing.js` does not exist / `visibleRange` is not exported.

- [ ] **Step 3: Write the implementation**

Create `ui/src/lib/layouts/windowing.js`:

```js
/**
 * Given absolute-positioned boxes sorted by ascending y (as produced by
 * justifiedLayout — rows are emitted in row order, and every box in a row
 * shares the same y), return the inclusive index range of boxes that
 * intersect the current viewport, expanded by `overscanPx` on each side.
 *
 * Pure — no DOM. Both y and y+height are non-decreasing across the array
 * (each new row starts at least the previous row's height+gap further
 * down), so both predicates below are monotonic and a binary search is
 * valid. A future non-row-based layout (e.g. an embedding scatter) would
 * need its own visibility query — this one assumes row-monotonic y.
 *
 * @param {Array<{id: number|string, x: number, y: number, width: number, height: number}>} boxes
 * @param {{ scrollTop: number, viewportHeight: number, overscanPx?: number }} opts
 * @returns {{ start: number, end: number }} inclusive index range into `boxes`;
 *   `{ start: 0, end: -1 }` means nothing is in range.
 */
export function visibleRange(
  boxes,
  { scrollTop, viewportHeight, overscanPx = 800 }
) {
  if (!boxes.length) return { start: 0, end: -1 };

  const lo = scrollTop - overscanPx;
  const hi = scrollTop + viewportHeight + overscanPx;

  const start = firstIndexWhere(boxes, (b) => b.y + b.height >= lo);
  const afterEnd = firstIndexWhere(boxes, (b) => b.y > hi);
  const end = afterEnd - 1;

  return start > end ? { start: 0, end: -1 } : { start, end };
}

/**
 * Binary search: predicate(boxes[i]) is false for a prefix and true for the
 * rest. Returns the first true index, or boxes.length if never true.
 */
function firstIndexWhere(boxes, predicate) {
  let lo = 0;
  let hi = boxes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (predicate(boxes[mid])) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run ui/src/lib/layouts/windowing.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS — all existing suites (`justified.test.js`, `safeResolve.test.js`, `api.test.js`, `ProcessingService.test.js`) plus the new `windowing.test.js` are green.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/layouts/windowing.js ui/src/lib/layouts/windowing.test.js
git commit -m "$(cat <<'EOF'
feat: add visibleRange pure windowing function for grid virtualization

Binary-searches justifiedLayout's y-sorted boxes to find which indices
intersect the current viewport (+ overscan). No DOM, no Svelte — same
pure-function pattern as justified.js, unit-tested in isolation before
wiring into App.svelte.
EOF
)"
```

---

### Task 2: Wire virtualization into `App.svelte`

**Files:**

- Modify: `ui/src/App.svelte`

**Interfaces:**

- Consumes: `visibleRange(boxes, { scrollTop, viewportHeight, overscanPx? }) → { start, end }` from Task 1.
- Uses existing: `boxes` (reactive var, `App.svelte:98-112`), `gridEl` (`App.svelte:46`), `selected` (`App.svelte:44`), `items` (`App.svelte:38`).

- [ ] **Step 1: Import `visibleRange`**

In `ui/src/App.svelte`, add to the existing import block near the top of `<script>` (after the `justifiedLayout, layoutHeight` import):

```js
import { visibleRange } from "./lib/layouts/windowing.js";
```

- [ ] **Step 2: Add virtualization state**

Immediately after the existing `let gridWidth = 0;` line, add:

```js
// Virtualization: only Thumbs in [renderStart, renderEnd] (plus the
// selected index) are mounted. Recomputed on scroll/resize/layout change.
let renderStart = 0;
let renderEnd = -1;
let rafPending = false;
```

- [ ] **Step 3: Add the recompute functions**

Add this after the `closeLoupe` function (right before the `navVertical` function):

```js
/** Recompute [renderStart, renderEnd] from the grid's current position. */
function updateVisibleRange() {
  if (!gridEl || !boxes) {
    renderStart = 0;
    renderEnd = -1;
    return;
  }
  const rect = gridEl.getBoundingClientRect();
  const range = visibleRange(boxes, {
    scrollTop: -rect.top,
    viewportHeight: window.innerHeight,
  });
  renderStart = range.start;
  renderEnd = range.end;
}

/** Collapse a burst of scroll/resize events to one recompute per frame. */
function scheduleVisibleRangeUpdate() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    updateVisibleRange();
  });
}

/**
 * Indices to mount: the virtualized window, plus `selected` so keyboard
 * jumps (Home/End, arrow past the window) mount their target and Thumb's
 * own scrollIntoView reactive block (Thumb.svelte:42) brings it into view.
 */
function buildVisibleItems(items, start, end, selected) {
  const indices = [];
  for (let i = start; i <= end; i++) indices.push(i);
  if (selected < items.length && !indices.includes(selected)) {
    const insertAt = indices.findIndex((i) => i > selected);
    if (insertAt === -1) indices.push(selected);
    else indices.splice(insertAt, 0, selected);
  }
  return indices.map((i) => ({ i, item: items[i] }));
}
```

- [ ] **Step 4: Recompute when the layout changes, and derive the render list**

Add this right after the existing `$: gridHeight = boxes ? layoutHeight(boxes) + 2 * PAD : 0;` line:

```js
$: if (boxes) updateVisibleRange(); // zoom change, meta enrichment, rescan
$: visibleItems = buildVisibleItems(items, renderStart, renderEnd, selected);
```

- [ ] **Step 5: Listen for scroll and resize**

Modify the `<svelte:window on:keydown={onKeydown} />` line to:

```svelte
<svelte:window
  on:keydown={onKeydown}
  on:scroll={scheduleVisibleRangeUpdate}
  on:resize={scheduleVisibleRangeUpdate}
/>
```

- [ ] **Step 6: Render only `visibleItems`**

Replace the grid's `{#each}` block:

```svelte
      {#if boxes}
        {#each items as item, i (item.id)}
          <Thumb
            {item}
            box={boxes[i]}
            pad={PAD}
            size={thumbSize}
            selected={i === selected}
            on:click={() => openLoupe(i)}
          />
        {/each}
      {/if}
```

with:

```svelte
      {#if boxes}
        {#each visibleItems as { i, item } (item.id)}
          <Thumb
            {item}
            box={boxes[i]}
            pad={PAD}
            size={thumbSize}
            selected={i === selected}
            on:click={() => openLoupe(i)}
          />
        {/each}
      {/if}
```

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: PASS — no existing suite regresses (this task adds no new automated tests; `App.svelte` has no existing component test harness, consistent with the rest of the codebase).

- [ ] **Step 8: Commit**

```bash
git add ui/src/App.svelte
git commit -m "$(cat <<'EOF'
feat: virtualize the justified grid to a scroll-windowed render set

Only mounts Thumb components for boxes near the viewport (+ overscan),
using visibleRange() over the justified layout's y-sorted boxes. The
selected index is always force-included so keyboard jumps (Home/End,
arrow past the window) still mount their target and trigger Thumb's
existing scrollIntoView behavior — no new focus-management code needed.
EOF
)"
```

- [ ] **Step 9: Stop for manual verification**

Per the working agreement in `docs/ROADMAP.md`, do **not** run automated browser/Playwright verification. Report tersely that unit tests pass, and ask John to verify at `localhost:5173` against the two test folders:

- the small demo folder (198 photos — sanity check nothing broke at small scale; see `docs/TEST_FOLDERS.local.md`).
- the scale-test folder (10,172 photos — confirm scroll stays smooth and keyboard nav, including Home/End, still works; see `docs/TEST_FOLDERS.local.md`).

---

## Self-Review Notes

- **Spec coverage:** windowing algorithm (Task 1) ✓; scroll-model via `getBoundingClientRect` (Task 2 Step 3) ✓; rAF throttle (Task 2 Step 3) ✓; recompute on boxes change (Task 2 Step 4) ✓; selected always rendered (Task 2 Step 3/6) ✓; overscan default 800px (Task 1) ✓; out-of-scope items (loupe, non-row layouts, GPU) untouched by this plan ✓.
- **No placeholders:** all steps contain complete, runnable code.
- **Type/name consistency checked:** `visibleRange` signature matches between Task 1's export and Task 2's call site; `buildVisibleItems` params (`items, start, end, selected`) match the call in Task 2 Step 4; `renderStart`/`renderEnd` names consistent across Steps 2–4.
