# Burst Stacks Grid Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the `detectBursts` grouping (Part 1, already merged) into the grid — a burst collapses to one tile with a cover + count badge, click/Enter expands it inline, and every existing interaction (keyboard nav, rating, Loupe) keeps working against the resulting display list.

**Architecture:** A new pure module `ui/src/lib/displayEntries.js` merges raw items, detected stacks, and expand state into the grid's display list. `App.svelte` is rewired so `boxes`/virtualization/rating/Loupe/keyboard-nav all key off this display list instead of raw `items`. `Thumb.svelte` gains two optional presentational props for the count badge and the expanded-member marker.

**Tech Stack:** Svelte 4 (no runes), vitest, plain JS + JSDoc (no TypeScript).

## Global Constraints

- ESM everywhere (`"type": "module"`); no TypeScript — plain JS + JSDoc types.
- Svelte 4 (no runes) — `$:` reactive statements throughout `App.svelte`.
- Tests: vitest, colocated as `*.test.js` next to the source file.
- Do **not** run automated browser/Playwright verification — John verifies visually himself at `localhost:5173`. Run unit tests, then stop and report tersely (working agreement in `docs/ROADMAP.md`).
- Commit after each task; do not batch multiple tasks into one commit.
- Full spec: `docs/superpowers/specs/2026-07-06-burst-stacks-grid-integration-design.md`.

---

### Task 1: `displayEntries.js` pure module

**Files:**

- Create: `ui/src/lib/displayEntries.js`
- Test: `ui/src/lib/displayEntries.test.js`

**Interfaces:**

- Consumes: `detectBursts` output shape from Part 1 — `Array<{id: string, memberIds: Array<number|string>, coverId: number|string, count: number}>` (`ui/src/lib/bursts.js`).
- Produces, all exported from `ui/src/lib/displayEntries.js`:
  - `buildDisplayEntries(items, stacks, expandedStackIds) → entries[]`, where each entry is `{kind: 'photo', item, stackId: string|null}` or `{kind: 'stack', stack, coverItem}`.
  - `entryDomId(entry) → string`
  - `resolvePhoto(entry) → item`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/lib/displayEntries.test.js`:

```js
import { describe, it, expect } from "vitest";
import {
  buildDisplayEntries,
  entryDomId,
  resolvePhoto,
} from "./displayEntries.js";

const items = [
  { id: 1, name: "solo.jpg", mtimeMs: 0 },
  { id: 2, name: "burst-a.jpg", mtimeMs: 100 },
  { id: 3, name: "burst-b.jpg", mtimeMs: 200 },
  { id: 4, name: "burst-c.jpg", mtimeMs: 300 },
];
const stack = { id: "burst-3", memberIds: [2, 3, 4], coverId: 3, count: 3 };

describe("buildDisplayEntries", () => {
  it("passes ungrouped photos through unchanged", () => {
    const entries = buildDisplayEntries(items, [stack], new Set());
    const solo = entries.find((e) => e.kind === "photo" && e.item.id === 1);
    expect(solo).toEqual({ kind: "photo", item: items[0], stackId: null });
  });

  it("collapses a stack to one entry, at its first member's position, using the cover photo", () => {
    const entries = buildDisplayEntries(items, [stack], new Set());
    expect(entries).toHaveLength(2); // solo + one collapsed stack entry
    expect(entries[0].item.id).toBe(1); // solo stays first
    expect(entries[1]).toEqual({
      kind: "stack",
      stack,
      coverItem: items[2], // id 3, the cover
    });
  });

  it("expands every member of an expanded stack individually, tagged with stackId", () => {
    const entries = buildDisplayEntries(items, [stack], new Set(["burst-3"]));
    expect(entries).toHaveLength(4); // solo + 3 expanded members
    const members = entries.filter(
      (e) => e.kind === "photo" && e.stackId === "burst-3"
    );
    expect(members.map((e) => e.item.id)).toEqual([2, 3, 4]);
  });

  it("does not duplicate a collapsed stack's later members", () => {
    const entries = buildDisplayEntries(items, [stack], new Set());
    const stackEntries = entries.filter((e) => e.kind === "stack");
    expect(stackEntries).toHaveLength(1);
  });
});

describe("entryDomId", () => {
  it("returns the stack id for a collapsed stack entry", () => {
    expect(entryDomId({ kind: "stack", stack, coverItem: items[2] })).toBe(
      "burst-3"
    );
  });

  it("returns the photo id for a photo entry", () => {
    expect(entryDomId({ kind: "photo", item: items[0], stackId: null })).toBe(
      "1"
    );
  });
});

describe("resolvePhoto", () => {
  it("returns the cover item for a collapsed stack entry", () => {
    expect(resolvePhoto({ kind: "stack", stack, coverItem: items[2] })).toBe(
      items[2]
    );
  });

  it("returns the item itself for a photo entry", () => {
    expect(resolvePhoto({ kind: "photo", item: items[0], stackId: null })).toBe(
      items[0]
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run ui/src/lib/displayEntries.test.js`
Expected: FAIL — `displayEntries.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `ui/src/lib/displayEntries.js`:

```js
/**
 * Merges raw items with detected bursts (from ui/src/lib/bursts.js) into
 * the grid's display list: a burst collapses to one entry (shown as its
 * cover) unless the stack's id is in `expandedStackIds`, in which case
 * every member appears as its own entry, tagged with the stack it
 * belongs to.
 *
 * A stack's entry/entries appear at the position of its first-occurring
 * member in `items` order — unrelated photos are never reordered.
 *
 * Pure — no DOM, no Svelte. See
 * docs/superpowers/specs/2026-07-06-burst-stacks-grid-integration-design.md.
 *
 * @param {Array<{id: number|string}>} items
 * @param {Array<{id: string, memberIds: Array<number|string>, coverId: number|string, count: number}>} stacks
 * @param {Set<string>} expandedStackIds
 * @returns {Array<
 *   | { kind: 'photo', item: object, stackId: string|null }
 *   | { kind: 'stack', stack: object, coverItem: object }
 * >}
 */
export function buildDisplayEntries(items, stacks, expandedStackIds) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const stackByMemberId = new Map();
  for (const stack of stacks) {
    for (const id of stack.memberIds) stackByMemberId.set(id, stack);
  }

  const emittedStackIds = new Set();
  const entries = [];
  for (const item of items) {
    const stack = stackByMemberId.get(item.id);
    if (!stack) {
      entries.push({ kind: "photo", item, stackId: null });
    } else if (expandedStackIds.has(stack.id)) {
      entries.push({ kind: "photo", item, stackId: stack.id });
    } else if (!emittedStackIds.has(stack.id)) {
      emittedStackIds.add(stack.id);
      entries.push({
        kind: "stack",
        stack,
        coverItem: byId.get(stack.coverId),
      });
    }
    // else: a later member of an already-emitted collapsed stack — skip.
  }
  return entries;
}

/** Stable DOM/data-id for a display entry. */
export function entryDomId(entry) {
  return String(entry.kind === "stack" ? entry.stack.id : entry.item.id);
}

/** The underlying photo a display entry represents (a stack's cover, or the photo itself). */
export function resolvePhoto(entry) {
  return entry.kind === "stack" ? entry.coverItem : entry.item;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run ui/src/lib/displayEntries.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS — all existing suites plus the new `displayEntries.test.js` are green.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/displayEntries.js ui/src/lib/displayEntries.test.js
git commit -m "$(cat <<'EOF'
feat: add buildDisplayEntries pure module for burst-stack grid display

Merges raw items, detected bursts, and expand state into the grid's
display list — a collapsed stack becomes one entry (shown as its
cover); an expanded stack's members each appear individually, tagged
with the stack they belong to. A stack's entry/entries appear at its
first-occurring member's position; unrelated photos are never
reordered. Pure and unit-tested, following the same no-DOM module
pattern as bursts.js/justified.js/windowing.js.
EOF
)"
```

---

### Task 2: Wire display entries into `App.svelte`'s data flow

**Files:**

- Modify: `ui/src/App.svelte`

**Interfaces:**

- Consumes: `detectBursts(items, {gapMs}) → stacks[]` (`ui/src/lib/bursts.js`, Part 1); `buildDisplayEntries(items, stacks, expandedStackIds) → entries[]`, `entryDomId(entry) → string`, `resolvePhoto(entry) → item` (Task 1, `ui/src/lib/displayEntries.js`).
- Produces: `App.svelte`'s `boxes`, `visibleItems`, `selected`, and Loupe binding all now key off `displayEntries` instead of raw `items`. Later tasks (Task 3) consume the new `stackCount`/`inExpandedStack` values this task computes per entry.

This task is data-flow only — no visual change yet (no count badge, no expanded-member marker; those are Task 3). A collapsed stack will render as an ordinary-looking tile showing its cover photo, indistinguishable from a normal photo until Task 3 adds the badge. Verify via the full test suite and by confirming the grid still renders/navigates/rates/opens correctly (no visual stack indicator expected yet).

- [ ] **Step 1: Add the import and new state**

In `ui/src/App.svelte`, add to the import block after the existing `visibleRange` import (currently line 4):

```js
import { detectBursts } from "./lib/bursts.js";
import {
  buildDisplayEntries,
  entryDomId,
  resolvePhoto,
} from "./lib/displayEntries.js";
```

Add new constants near the existing `LS_ZOOM` constant (currently line 14):

```js
const LS_BURST_GAP = "autogallery.burstGapMs";
const DEFAULT_BURST_GAP_MS = 3000;
```

Add new persisted state right after the existing zoom-restoration block (currently ends at line 28, `$: rowHeight = ZOOM_LEVELS[zoom];`):

```js
const storedBurstGap = Number.parseInt(
  localStorage.getItem(LS_BURST_GAP) ?? "",
  10
);
let burstGapMs =
  Number.isFinite(storedBurstGap) && storedBurstGap >= 0
    ? storedBurstGap
    : DEFAULT_BURST_GAP_MS;
$: localStorage.setItem(LS_BURST_GAP, String(burstGapMs));
```

Add new non-persisted state right after the existing `let focusPending = false;` line (currently line 55):

```js
let expandedStackIds = new Set(); // stack ids currently expanded inline in the grid
```

- [ ] **Step 2: Add the stacks/displayEntries/resolvedPhotos reactive chain**

Immediately before the existing `$: boxes = ...` block (currently starting at line 107), add:

```js
$: stacks = detectBursts(items, { gapMs: burstGapMs });
$: displayEntries = buildDisplayEntries(items, stacks, expandedStackIds);
$: resolvedPhotos = displayEntries.map(resolvePhoto); // passed to Loupe
```

- [ ] **Step 3: Change `boxes` to compute from `displayEntries`**

Replace the existing `$: boxes = ...` block (currently lines 107-121):

```js
$: boxes =
  items.length && gridWidth > 2 * PAD
    ? justifiedLayout(
        items.map((it) => ({
          id: it.id,
          aspectRatio:
            it.width && it.height ? it.width / it.height : DEFAULT_RATIO,
        })),
        {
          containerWidth: gridWidth - 2 * PAD,
          gap: 8,
          targetRowHeight: rowHeight,
        }
      )
    : null;
```

with:

```js
$: boxes =
  displayEntries.length && gridWidth > 2 * PAD
    ? justifiedLayout(
        displayEntries.map((e) => {
          const photo = resolvePhoto(e);
          return {
            id: entryDomId(e),
            aspectRatio:
              photo.width && photo.height
                ? photo.width / photo.height
                : DEFAULT_RATIO,
          };
        }),
        {
          containerWidth: gridWidth - 2 * PAD,
          gap: 8,
          targetRowHeight: rowHeight,
        }
      )
    : null;
```

- [ ] **Step 4: Change `visibleItems` to iterate `displayEntries`**

Replace the existing line (currently line 124):

```js
$: visibleItems = buildVisibleItems(items, renderStart, renderEnd, selected);
```

with:

```js
$: visibleItems = buildVisibleItems(
  displayEntries,
  renderStart,
  renderEnd,
  selected
);
```

Update `buildVisibleItems`'s own definition (currently lines 190-199) to rename its parameter and returned key from `item` to `entry` (purely a naming change — the logic is unchanged):

```js
/**
 * Indices to mount: the virtualized window, plus `selected` so keyboard
 * jumps (Home/End, arrow past the window) mount their target and Thumb's
 * own scrollIntoView reactive block (Thumb.svelte:42) brings it into view.
 */
function buildVisibleItems(entries, start, end, selected) {
  const indices = [];
  for (let i = start; i <= end; i++) indices.push(i);
  if (selected < entries.length && !indices.includes(selected)) {
    const insertAt = indices.findIndex((i) => i > selected);
    if (insertAt === -1) indices.push(selected);
    else indices.splice(insertAt, 0, selected);
  }
  return indices.map((i) => ({ i, entry: entries[i] }));
}
```

- [ ] **Step 5: Update `rate`, `closeLoupe`, and the `focusPending` block to resolve through `displayEntries`**

Replace the existing `rate` function (currently lines 139-145):

```js
function rate(index, rating) {
  const it = items[index];
  if (!it) return;
  it.rating = rating;
  items = items; // trigger reactivity
  apiSetRating(it.id, rating).catch((e) => (error = e.message));
}
```

with:

```js
function rate(index, rating) {
  const entry = displayEntries[index];
  if (!entry) return;
  const it = resolvePhoto(entry);
  if (!it) return;
  it.rating = rating;
  items = items; // trigger reactivity
  apiSetRating(it.id, rating).catch((e) => (error = e.message));
}
```

Replace the existing `closeLoupe` function (currently lines 152-157):

```js
async function closeLoupe() {
  loupeOpen = false;
  await tick();
  // Return focus to the grid, scrolled to the current item.
  gridEl?.querySelector(`[data-id="${items[selected]?.id}"]`)?.focus();
}
```

with:

```js
async function closeLoupe() {
  loupeOpen = false;
  await tick();
  // Return focus to the grid, scrolled to the current item.
  const entry = displayEntries[selected];
  gridEl
    ?.querySelector(`[data-id="${entry ? entryDomId(entry) : ""}"]`)
    ?.focus();
}
```

Replace the existing `focusPending` reactive block (currently lines 132-137):

```js
$: if (focusPending && boxes) {
  focusPending = false;
  tick().then(() => {
    gridEl?.querySelector(`[data-id="${items[selected]?.id}"]`)?.focus();
  });
}
```

with:

```js
$: if (focusPending && boxes) {
  focusPending = false;
  tick().then(() => {
    const entry = displayEntries[selected];
    gridEl
      ?.querySelector(`[data-id="${entry ? entryDomId(entry) : ""}"]`)
      ?.focus();
  });
}
```

- [ ] **Step 6: Add `toggleExpand`/`collapseStack`, and update `onKeydown`**

Add two new functions right after `closeLoupe` (which now ends where Step 5 placed it, immediately before the `updateVisibleRange` function):

```js
/** Re-collapse a stack: remove it from expandedStackIds, then re-select
 * and re-focus its now-collapsed tile once displayEntries recomputes. */
async function collapseStack(stackId) {
  expandedStackIds.delete(stackId);
  expandedStackIds = expandedStackIds; // trigger reactivity
  await tick();
  const newIndex = displayEntries.findIndex(
    (e) => e.kind === "stack" && e.stack.id === stackId
  );
  if (newIndex !== -1) {
    selected = newIndex;
    await tick();
    gridEl
      ?.querySelector(`[data-id="${stackId}"]`)
      ?.focus({ preventScroll: true });
  }
}

/** Expand a stack: every member appears individually, tagged with the
 * stack id, until collapseStack() is called (Escape, in onKeydown). */
async function toggleExpand(stack) {
  if (expandedStackIds.has(stack.id)) {
    await collapseStack(stack.id);
    return;
  }
  expandedStackIds.add(stack.id);
  expandedStackIds = expandedStackIds; // trigger reactivity
  await tick();
  const newIndex = displayEntries.findIndex(
    (e) => e.kind === "photo" && e.item.id === stack.coverId
  );
  if (newIndex !== -1) {
    selected = newIndex;
    await tick();
    gridEl
      ?.querySelector(`[data-id="${stack.coverId}"]`)
      ?.focus({ preventScroll: true });
  }
}
```

Now update `onKeydown` (currently lines 239-302). Change every `items.length` reference to `displayEntries.length` — this is the full function with all changes applied:

```js
async function onKeydown(e) {
  // Never steal keystrokes from a focused input (e.g. typing a folder path
  // with digits in it must not rate photos).
  const tag = e.target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable)
    return;
  if (e.metaKey || e.ctrlKey || e.altKey) return; // browser shortcuts

  if (!displayEntries.length) return;
  const key = e.key;

  // Grid zoom: +/- steps through the justified row heights.
  if (!loupeOpen && (key === "+" || key === "=" || key === "-")) {
    e.preventDefault();
    zoom = Math.max(
      0,
      Math.min(ZOOM_LEVELS.length - 1, zoom + (key === "-" ? -1 : 1))
    );
    return;
  }

  // Star rating: 1-5 set stars, 0 clears. Works in both grid and loupe.
  if (/^[0-5]$/.test(key)) {
    e.preventDefault();
    rate(selected, Number(key));
    if (loupeOpen && selected < displayEntries.length - 1) selected += 1; // auto-advance
    return;
  }

  if (loupeOpen) {
    if (key === "Escape") {
      e.preventDefault();
      closeLoupe();
    } else if (key === "ArrowRight" || key === "ArrowDown") {
      e.preventDefault();
      if (selected < displayEntries.length - 1) selected += 1;
    } else if (key === "ArrowLeft" || key === "ArrowUp") {
      e.preventDefault();
      if (selected > 0) selected -= 1;
    }
    return;
  }

  // Escape in the grid: collapse an expanded stack if the selection is
  // currently inside one.
  if (key === "Escape") {
    const entry = displayEntries[selected];
    if (entry?.stackId) {
      e.preventDefault();
      await collapseStack(entry.stackId);
    }
    return;
  }

  // Grid navigation.
  let next = selected;
  if (key === "ArrowRight")
    next = Math.min(displayEntries.length - 1, selected + 1);
  else if (key === "ArrowLeft") next = Math.max(0, selected - 1);
  else if (key === "ArrowDown") next = navVertical(1);
  else if (key === "ArrowUp") next = navVertical(-1);
  else if (key === "Enter" || key === " ") {
    e.preventDefault();
    const entry = displayEntries[selected];
    if (entry?.kind === "stack") {
      toggleExpand(entry.stack);
    } else {
      openLoupe(selected);
    }
    return;
  } else if (key === "Home") next = 0;
  else if (key === "End") next = displayEntries.length - 1;
  else return;

  e.preventDefault();
  selected = next;
  await tick();
  const entry = displayEntries[selected];
  gridEl
    ?.querySelector(`[data-id="${entry ? entryDomId(entry) : ""}"]`)
    ?.focus({ preventScroll: true });
}
```

- [ ] **Step 7: Update the template's grid loop and Loupe binding**

Replace the existing `{#each}` block (currently lines 348-359):

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

with:

```svelte
{#if boxes}
  {#each visibleItems as { i, entry } (entryDomId(entry))}
    <Thumb
      item={resolvePhoto(entry)}
      box={boxes[i]}
      pad={PAD}
      size={thumbSize}
      selected={i === selected}
      on:click={() =>
        entry.kind === "stack" ? toggleExpand(entry.stack) : openLoupe(i)}
    />
  {/each}
{/if}
```

Replace the existing Loupe binding (currently line 367):

```svelte
<Loupe {items} bind:index={selected} />
```

with:

```svelte
<Loupe items={resolvedPhotos} bind:index={selected} />
```

- [ ] **Step 8: Run the full test suite to check for regressions**

Run: `npm test`
Expected: PASS — no existing suite regresses (this task adds no new automated tests to `App.svelte` itself, consistent with the rest of the codebase; `displayEntries.test.js` from Task 1 stays green).

- [ ] **Step 9: Commit**

```bash
git add ui/src/App.svelte
git commit -m "$(cat <<'EOF'
feat: rewire App.svelte's grid data flow through burst display entries

boxes, virtualization, rating, keyboard nav, and the Loupe binding now
all key off displayEntries (raw items merged with detected bursts and
expand state) instead of raw items directly. Adds toggleExpand/
collapseStack: Enter/click on a collapsed stack tile expands it inline;
Escape while selection is inside an expanded stack collapses it back.
Digit-rating a collapsed stack rates its cover directly, since rate()
now resolves through resolvePhoto(). The Loupe now navigates the same
collapsed/expanded sequence as the grid, so it skips buried burst
duplicates exactly like the grid does.

No visual change yet — a collapsed stack renders as an ordinary tile
showing its cover, indistinguishable from a normal photo until the
count badge and expanded-member marker land in the next task.
EOF
)"
```

---

### Task 3: Stack visuals in `Thumb.svelte`, and the `gapMs` control

**Files:**

- Modify: `ui/src/lib/Thumb.svelte`
- Modify: `ui/src/App.svelte`

**Interfaces:**

- Consumes: `entry.kind`, `entry.stack.count`, `entry.stackId` from Task 2's `displayEntries`/template loop.

- [ ] **Step 1: Add the two new props and their markup to `Thumb.svelte`**

In `ui/src/lib/Thumb.svelte`, add two new props after the existing `export let selected = false;` line:

```js
export let stackCount = undefined; // set when this tile is a collapsed stack's cover
export let inExpandedStack = false; // true when this photo is a member of a currently-expanded stack
```

Add the new badge/marker markup inside the `<button>`, after the existing rating badge block (`{#if item.rating > 0}...{/if}`):

```svelte
{#if stackCount}
  <span class="stack-badge">×{stackCount}</span>
{/if}
{#if inExpandedStack}
  <span class="stack-marker" title="Part of a burst — press Escape to collapse"
    >⚏</span
  >
{/if}
```

Add the corresponding CSS at the end of the `<style>` block (existing `.badge` rule stays; these are new, distinct corners so they don't overlap):

```css
.stack-badge {
  position: absolute;
  right: 5px;
  bottom: 5px;
  padding: 1px 5px;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  font-size: 0.7rem;
  border-radius: 3px;
  pointer-events: none;
}
.stack-marker {
  position: absolute;
  left: 5px;
  top: 5px;
  padding: 1px 4px;
  background: rgba(76, 154, 255, 0.75);
  color: #06121f;
  font-size: 0.7rem;
  border-radius: 3px;
  pointer-events: none;
}
```

- [ ] **Step 2: Pass the new props from `App.svelte`'s template**

In `ui/src/App.svelte`, update the `<Thumb>` invocation from Task 2's template loop to also pass the two new props:

```svelte
{#if boxes}
  {#each visibleItems as { i, entry } (entryDomId(entry))}
    <Thumb
      item={resolvePhoto(entry)}
      box={boxes[i]}
      pad={PAD}
      size={thumbSize}
      selected={i === selected}
      stackCount={entry.kind === "stack" ? entry.stack.count : undefined}
      inExpandedStack={entry.kind === "photo" && entry.stackId !== null}
      on:click={() =>
        entry.kind === "stack" ? toggleExpand(entry.stack) : openLoupe(i)}
    />
  {/each}
{/if}
```

- [ ] **Step 3: Add the `burstGapMs` slider to the topbar**

In `ui/src/App.svelte`, add a new control after the existing `.zoom` `<label>` block in the topbar (right before the `<span class="status" ...>` element):

```svelte
<label
  class="burst-gap"
  title="Group photos taken within this many seconds as a burst"
>
  <span class="burst-gap-icon">⧉</span>
  <input type="range" min="0" max="10000" step="500" bind:value={burstGapMs} />
  <span class="burst-gap-value">{(burstGapMs / 1000).toFixed(1)}s</span>
</label>
```

Add matching CSS after the existing `.zoom-icon.small` rule:

```css
.burst-gap {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #777;
}
.burst-gap input[type="range"] {
  width: 90px;
  accent-color: #4c9aff;
}
.burst-gap-icon {
  font-size: 1rem;
  line-height: 1;
}
.burst-gap-value {
  font-size: 0.75rem;
  min-width: 2.5em;
}
```

- [ ] **Step 4: Run the full test suite to check for regressions**

Run: `npm test`
Expected: PASS — no existing suite regresses. This task adds no new automated tests (`Thumb.svelte`/`App.svelte` have no component test harness, consistent with the rest of the codebase).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/Thumb.svelte ui/src/App.svelte
git commit -m "$(cat <<'EOF'
feat: add burst stack count badge, expanded-member marker, and gap slider

Thumb.svelte gains two optional presentational props: stackCount (a
"×N" badge, bottom-right, on a collapsed stack's cover tile) and
inExpandedStack (a small non-interactive marker, top-left, on photos
that are members of a currently-expanded stack — Escape is the
collapse mechanism, so this is a visual cue only, not a click target).

Adds a burstGapMs slider to the topbar (0-10s, 500ms steps, persisted
to localStorage like the zoom control) so the burst-detection
threshold from Part 1 is user-adjustable.
EOF
)"
```

- [ ] **Step 6: Stop for manual verification**

Per the working agreement in `docs/ROADMAP.md`, do **not** run automated browser/Playwright verification. Report tersely that unit tests pass, and ask John to verify at `localhost:5173` against both test folders — particularly the 10,172-photo Pixel folder, which has 4 real burst-filename groups of 3. Confirm: bursts collapse to a badged cover tile; click/Enter expands inline; Escape while inside an expanded stack collapses it back; digit-rating a collapsed stack rates its cover; the Loupe skips buried burst duplicates; the gap slider changes grouping live.

---

## Self-Review Notes

- **Spec coverage:** `buildDisplayEntries`/`entryDomId`/`resolvePhoto` pure module (Task 1) ✓; `boxes`/virtualization/rating/Loupe rewired through `displayEntries` (Task 2) ✓; toggleExpand/collapseStack mechanics, Escape-to-collapse, Enter/click branching (Task 2) ✓; count badge, expanded-member marker, `gapMs` slider (Task 3) ✓; out-of-scope items (automated quality scoring, `detectBursts` changes) untouched ✓.
- **No placeholders:** every step contains complete, runnable code.
- **Type/name consistency:** `buildDisplayEntries(items, stacks, expandedStackIds)` signature matches between Task 1's export and Task 2's call site; `entry.kind`/`entry.stack`/`entry.item`/`entry.stackId`/`entry.coverItem` field names are used identically across Task 1's module, Task 2's `App.svelte` wiring, and Task 3's template/props; `resolvePhoto`/`entryDomId` imported and used consistently everywhere `items[...]`/`item.id` used to appear.
