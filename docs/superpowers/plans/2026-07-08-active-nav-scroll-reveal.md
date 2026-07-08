# Active-navigation scroll reveal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the grid from force-scrolling the selected tile back to center on every layout reflow; instead reveal the selection only in response to active navigation (arrow keys, Home/End, group-jump), using a minimal, App-owned scroll.

**Architecture:** Extract a pure `revealScrollTop()` geometry helper (unit-tested). App gains a `revealSelected()` that calls it against `boxes[selected]` and scrolls `mainColumnEl` the minimum needed — invoked only from the keyboard-nav choke point and, once, after a group-jump's metadata settles. `Thumb.svelte` loses its reactive `scrollIntoView` entirely.

**Tech Stack:** Svelte 4, Vite, vitest. Plain ESM JS with JSDoc types. No TypeScript.

## Global Constraints

- ESM everywhere; no TypeScript (JSDoc types only).
- Tests: vitest, colocated as `*.test.js` next to sources.
- Prettier for formatting.
- App.svelte scroll/selection behavior MUST be live-verified in the running app (not just unit tests) — project convention for anything touching feed-window/scroll state.
- Never re-center: reveals bring a tile *just* into view, never to center.
- Reveal is called ONLY from active-navigation code paths — never from reflow, `loadMore`'s re-anchor, `onGroupByChange`, or initial load.

---

### Task 1: Pure `revealScrollTop` geometry helper

**Files:**
- Create: `ui/src/lib/scroll.js`
- Test: `ui/src/lib/scroll.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `revealScrollTop(box, viewTop, viewHeight, margin) → number|null`
  where `box` is `{top:number, height:number}` (position within the scroll
  content). Returns the new `scrollTop` that brings the box minimally into the
  viewport, or `null` if it is already fully visible.

- [ ] **Step 1: Write the failing tests**

Create `ui/src/lib/scroll.test.js`:

```js
import { describe, it, expect } from "vitest";
import { revealScrollTop } from "./scroll.js";

describe("revealScrollTop", () => {
  // viewport is [viewTop, viewTop + viewHeight); margin reserves top space.
  it("returns null when the box is already fully visible", () => {
    // box 200..300 inside view 0..600, clear of the 32px header margin
    expect(revealScrollTop({ top: 200, height: 100 }, 0, 600, 32)).toBeNull();
  });

  it("scrolls down the minimum needed when the box is below the fold", () => {
    // box 700..800, view 0..600 → bottom(800) - viewHeight(600) = 200
    expect(revealScrollTop({ top: 700, height: 100 }, 0, 600, 32)).toBe(200);
  });

  it("scrolls up to the header-adjusted top when the box is above the fold", () => {
    // box 100..200, view 400..1000 → top(100) - margin(32) = 68
    expect(revealScrollTop({ top: 100, height: 100 }, 400, 600, 32)).toBe(68);
  });

  it("nudges up when the box sits under the sticky-header band", () => {
    // box top 410 is within view 400..1000 but the 32px header covers 400..432;
    // reveal so the tile clears it: 410 - 32 = 378
    expect(revealScrollTop({ top: 410, height: 100 }, 400, 600, 32)).toBe(378);
  });

  it("prefers showing the top for a box taller than the viewport", () => {
    // box 100..1100 (height 1000) with view 400..1000 → show top: 100 - 32 = 68
    expect(revealScrollTop({ top: 100, height: 1000 }, 400, 600, 32)).toBe(68);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run ui/src/lib/scroll.test.js`
Expected: FAIL — `revealScrollTop` is not exported / module not found.

- [ ] **Step 3: Write the minimal implementation**

Create `ui/src/lib/scroll.js`:

```js
/**
 * Minimal scroll geometry: the scrollTop that brings a box just into a
 * viewport, or null if it's already fully visible. Pure — no DOM. Mirrors a
 * roving-focus "scroll into view (nearest)" but with a `margin` that reserves
 * space at the top for the grid's stacked sticky headers, so a revealed tile
 * near a section boundary isn't left hidden behind them.
 * @param {{top:number, height:number}} box  position within the scroll content
 * @param {number} viewTop     current scrollTop
 * @param {number} viewHeight  visible height of the scroll container (clientHeight)
 * @param {number} margin      top inset to keep clear (sticky-header stack)
 * @returns {number|null} new scrollTop, or null if no scroll is needed
 */
export function revealScrollTop(box, viewTop, viewHeight, margin) {
  const headerAdjustedTop = box.top - margin;
  const bottom = box.top + box.height;
  if (headerAdjustedTop < viewTop) return headerAdjustedTop; // above the fold (or under headers)
  if (bottom > viewTop + viewHeight) return bottom - viewHeight; // below the fold
  return null; // fully visible
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run ui/src/lib/scroll.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/scroll.js ui/src/lib/scroll.test.js
git commit -m "feat: add pure revealScrollTop scroll-geometry helper"
```

---

### Task 2: App-owned `revealSelected`; remove Thumb's reactive scroll

**Files:**
- Modify: `ui/src/App.svelte` (import; new `revealSelected`; call at nav choke point ~line 1207)
- Modify: `ui/src/lib/Thumb.svelte` (remove reactive `scrollIntoView` block ~lines 135–144)

**Interfaces:**
- Consumes: `revealScrollTop` from Task 1; App globals `gridEl`, `mainColumnEl`,
  `boxes` (`= layoutResult.boxes`, one box per display entry — full layout, so
  `boxes[selected]` exists even for an unmounted tile), `selected`, `groupBy`,
  constants `HEADER_HEIGHT = 32` and `PAD`.
- Produces: `revealSelected()` — scrolls `mainColumnEl` so `boxes[selected]` is
  visible; no-op if geometry isn't ready or the tile is already visible.

- [ ] **Step 1: Add the `revealScrollTop` import**

In `ui/src/App.svelte`, extend the existing scroll/layout import group near the
top of the `<script>`. Add this line alongside the other `./lib/...` imports
(e.g. right after the `windowing.js` import):

```js
  import { revealScrollTop } from "./lib/scroll.js";
```

- [ ] **Step 2: Add the `revealSelected` function**

In `ui/src/App.svelte`, add this function directly ABOVE `scrollToSection`
(which begins `function scrollToSection(pos) {`). It mirrors scrollToSection's
content-offset math (`gridEl.getBoundingClientRect().top + mainColumnEl.scrollTop`,
plus the `PAD` grid inset that `thumb-wrap` applies via `top:box.y+pad`):

```js
  /** Scroll mainColumnEl the minimum needed so the currently-selected tile is
   * visible — called ONLY from active navigation (keyboard, group-jump), never
   * from a reflow or a programmatic re-anchor. Uses box geometry, so it works
   * even when the target tile isn't mounted yet. No-op if the layout isn't
   * ready or the tile is already fully visible. Never re-centers. */
  function revealSelected() {
    if (!gridEl || !mainColumnEl || !boxes) return;
    const box = boxes[selected];
    if (!box) return;
    const gridTop = gridEl.getBoundingClientRect().top + mainColumnEl.scrollTop;
    const boxTop = gridTop + box.y + PAD;
    // Reserve the worst-case sticky-header stack (one band per grouping level)
    // so a tile at a section boundary isn't revealed underneath the headers.
    const margin = HEADER_HEIGHT * groupBy.length;
    const target = revealScrollTop(
      { top: boxTop, height: box.height },
      mainColumnEl.scrollTop,
      mainColumnEl.clientHeight,
      margin
    );
    if (target != null) {
      mainColumnEl.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    }
  }
```

- [ ] **Step 3: Call `revealSelected` at the keyboard-nav choke point**

In `ui/src/App.svelte`, the arrow/Home/End branches all converge on one block
(currently ~lines 1206–1213):

```js
    e.preventDefault();
    selected = next;
    await tick();
    const entry = displayEntries[selected];
    gridEl
      ?.querySelector(`[data-id="${entry ? resolvePhoto(entry).id : ""}"]`)
      ?.focus({ preventScroll: true });
```

Add a `revealSelected()` call immediately after the `.focus(...)` line, so it
becomes:

```js
    e.preventDefault();
    selected = next;
    await tick();
    const entry = displayEntries[selected];
    gridEl
      ?.querySelector(`[data-id="${entry ? resolvePhoto(entry).id : ""}"]`)
      ?.focus({ preventScroll: true });
    revealSelected();
```

Note: `.focus({ preventScroll: true })` already stops the browser's native
focus-scroll, so `revealSelected` is the sole, deliberate scroll here.

- [ ] **Step 4: Remove Thumb's reactive scroll block**

In `ui/src/lib/Thumb.svelte`, DELETE this entire block (the comment and the
reactive statement, ~lines 135–144):

```js
  // Keep the selected tile centered for roving keyboard focus — re-runs
  // whenever this tile's own position changes too (not just when it first
  // becomes selected), since a metadata-driven justified-layout reflow can
  // move the selected tile after the initial scroll; referencing box.x/y
  // here is what makes Svelte re-fire this block on that reflow.
  $: if (selected && el) {
    void box.x;
    void box.y;
    el.scrollIntoView({ block: "center" });
  }
```

Leave everything else (the `el` binding, the resize `observer.observe(el)`,
`onDestroy`) untouched — `el` is still used by the observer.

- [ ] **Step 5: Verify unit tests and build still pass**

Run: `npx vitest run`
Expected: PASS (all existing tests, unchanged count + the 5 from Task 1).

Run: `npx vite build ui`
Expected: builds successfully (pre-existing a11y warnings in ManageLibrary.svelte are fine; no errors).

- [ ] **Step 6: Live-verify the core behavior**

With dev servers running (`:4321` API, `:5173` Vite), in the app:
1. Select a tile, then scroll the grid away from it while thumbnails are still
   streaming in. **Expected:** the view stays where you scrolled; the selection
   is allowed to sit off-screen. (This is the bug being fixed — previously it
   snapped back to center.)
2. Arrow within the visible area. **Expected:** no page scroll.
3. Arrow (or Down) past the visible edge. **Expected:** the view follows just
   enough to bring the newly-selected tile into view, not centered.

Verify via DOM if helpful:
```js
// selection index and whether its tile is within the scroll viewport
const c = document.querySelector('[role="listbox"]')?.closest('[class*="column"]') || document.scrollingElement;
```
(Prefer the visual check; the three behaviors above are the acceptance criteria.)

- [ ] **Step 7: Commit**

```bash
git add ui/src/App.svelte ui/src/lib/Thumb.svelte
git commit -m "fix: reveal selection on active nav only, not on every reflow (#40)

Removes Thumb.svelte's reflow-triggered scrollIntoView (which re-centered
the selected tile on every metadata reflow, hijacking the user's scroll)
and replaces it with an App-owned, geometry-based revealSelected() called
only from the keyboard-nav choke point. Manual scrolling and passive
reflows no longer move the view."
```

---

### Task 3: One-shot re-reveal after a group-jump's metadata settles

**Files:**
- Modify: `ui/src/App.svelte` (the `enrichMeta(...)` call inside `jumpGroupBoundaryInner`, ~line 1327)

**Interfaces:**
- Consumes: `revealSelected` (Task 2); `enrichMeta(ids) → Promise` (resolves
  after the batch nearest the selection settles); the jump's `epoch` local
  (`const epoch = ++feedEpoch;`, ~line 1265) and the module `feedEpoch`.
- Produces: no new exports — hardens the jump so the landing photo stays visible
  after its freshly-loaded metadata reflows the layout.

- [ ] **Step 1: Attach an epoch-guarded re-reveal to the jump's enrichMeta**

In `ui/src/App.svelte`, inside `jumpGroupBoundaryInner`, find this line (~1327):

```js
      enrichMeta(items.map((i) => i.id));
```

Replace it with:

```js
      // The near-selection metadata batch reflows the layout a beat after the
      // jump's scrollToSection lands — which can drift the landing photo out
      // of view. Re-reveal once when that batch settles (guarded so a newer
      // jump/load that bumped feedEpoch doesn't yank the view). revealSelected
      // is a no-op if the photo is still visible, so this only corrects drift.
      enrichMeta(items.map((i) => i.id)).then(() => {
        if (epoch === feedEpoch) revealSelected();
      });
```

- [ ] **Step 2: Verify unit tests and build still pass**

Run: `npx vitest run`
Expected: PASS (same count as end of Task 2).

Run: `npx vite build ui`
Expected: builds successfully.

- [ ] **Step 3: Live-verify the jump behavior**

In the running app:
1. From the first photo of a group, press Option+Right to jump to the next
   group. **Expected:** the landing photo is in view immediately, AND remains
   in view after its thumbnails finish loading (no drift off-screen).
2. After landing, scroll freely past the group. **Expected:** the view is not
   pulled back to the selection.
3. Fire several Option+Right presses quickly. **Expected:** no scroll snap-back
   to a superseded landing; the final landing is visible.

- [ ] **Step 4: Commit**

```bash
git add ui/src/App.svelte
git commit -m "fix: keep a group-jump's landing photo visible after its metadata reflow

A jump loads new photos whose metadata reflows the layout just after
scrollToSection lands; re-reveal the selection once when that near-batch
settles (epoch-guarded) so the landing photo can't drift out of view."
```

---

## Self-Review

**Spec coverage:**
- Pure `revealScrollTop` + tests → Task 1. ✓
- App-owned `revealSelected`, geometry-based, called only from active nav → Task 2 (import, function, choke-point call). ✓
- Remove Thumb reactive scroll → Task 2 Step 4. ✓
- Minimal reveal, never re-center, header margin → `revealScrollTop` (Task 1) + margin in `revealSelected` (Task 2). ✓
- Group-jump keeps `scrollToSection` + one-shot re-reveal after metadata → Task 3 (scrollToSection untouched; `.then` re-reveal added). ✓
- Not called from loadMore/onGroupByChange/initial load → enforced by only wiring the choke point + jump; no reactive trigger added. ✓
- Live-verify required → Task 2 Step 6, Task 3 Step 3. ✓

**Placeholder scan:** none — every code step shows complete code and exact commands.

**Type consistency:** `revealScrollTop(box, viewTop, viewHeight, margin)` used identically in Task 1 (definition) and Task 2 (call). `revealSelected()` defined in Task 2, called in Task 2 and Task 3. `boxes[selected]` shape (`{x,y,width,height}`) matches the layout. ✓
