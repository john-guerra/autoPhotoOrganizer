> ⛔ **ABANDONED — do not execute.** This feature was built and then reverted:
> `loadMore` already wins and the scrollbar stayed tiny, so the skeleton/
> manifest-height approach added complexity without a payoff. The work is
> recoverable at commit `dad4746` if revisited (use a bounded reserve, not a full
> manifest height). Kept here as history only. — 2026-07-24

# Skeleton-in-Reserve Implementation Plan (closes #132)

> **For agentic workers:** execute task-by-task; each task ends green + committed.
> Steps use `- [ ]` checkboxes. This is the fleshed-out Task 6 from
> `docs/superpowers/plans/2026-07-16-feed-scrubber.md`; the scrubber (Tasks 1–5 +
> folder-landmark refinements) shipped in **2.16.8–2.16.17**.

**Goal:** Replace the fixed 3000px bottom scroll reserve with a manifest-driven
whole-library content height, and paint lightweight skeleton rows below the loaded
frontier, so a fast fling lands on structure (and a true-size scrollbar) instead of
a blank reserve that clamps at a false floor.

**Architecture:** The feed scroller (`.main-column`) sizes its scrollable area from
`gridHeight = scrollableHeight(layoutResult.totalHeight, …)`. Today, while
`hasMoreAfter`, it appends a flat `BOTTOM_RESERVE_PX = 3000` of empty runway
(`ui/src/App.svelte:3995`, `ui/src/lib/layouts/windowing.js` `scrollableHeight`).
We instead extrapolate the remaining library height from `manifest.total` and the
loaded window's measured photos-per-pixel, and render a virtualized band of
placeholder tiles + manifest-positioned group headers in that region. Real content
still streams in via `loadMore` and overwrites the skeleton for each range as it
lands.

**Tech Stack:** Svelte 5 runes, the pure `scrubber/scale.js` manifest, the pure
`layouts/windowing.js` + `layouts/sectionedJustified.js` layout.

## Global Constraints (copy verbatim from CLAUDE.md)

- Every change bumps `package.json` version + a `CHANGELOG.md` entry in the SAME commit.
- A fixed bug gets a test at the tier that would have caught it (pure → vitest;
  DOM/scroll seam → e2e/), revert-checked, same commit.
- New feed-window logic must NOT hand-roll another `fetchingBefore`/`fetchingAfter`/
  `feedEpoch` guard; extend `withFeedTransaction` (replace) or `loadMore` (extend).
  The skeleton is READ-ONLY of feed state — it must never mutate `items`/`feedEpoch`/
  the fetching flags. It only reads `manifest`, `layoutResult`, `renderStart/End`.
- Live-verify on the real 114k library (folder + camera grouping) before "done";
  the #132 repro is the acceptance gate.
- Commit at each green task.

## Key current-state facts (verified 2026-07-16)

- `gridHeight` (`App.svelte:~4010`) `= scrollableHeight(layoutResult.totalHeight,
{ pad: PAD, hasMoreAfter: adaptivePageSize && hasMoreAfter, reservePx: 3000 })`.
- `scrollableHeight(totalHeight, { pad, hasMoreAfter, reservePx })` returns
  `totalHeight + 2*pad + (hasMoreAfter ? reservePx : 0)` (`windowing.js:~210`).
- `layoutResult` (`App.svelte:3880`) = `sectionedJustifiedLayout(entries, headers, opts)`
  → `{ boxes, totalHeight }`. `boxes[i] = { id, y, x, width, height, kind, … }`.
  A `{ kind:'placeholder' }` entry is ALREADY a first-class layout concept (collapsed
  sections render a placeholder band); the layout, `deriveCurrentPath`, selection and
  `resolvePhoto` all skip `kind==='placeholder'`. Reuse this — do NOT invent a new kind.
- The grid is virtualized: `renderStart`/`renderEnd` (`$effect.pre` on `boxes`, keyed
  off `updateVisibleRange`) bound the MOUNTED rows; `visibleItems` slices them.
- The scrubber manifest (`scrubberManifest`, `App.svelte:~2240`) = `buildManifest(flat,
{groupBy})` with `{ total, landmarks:[{value,startCount,count,path}], cumStart }`,
  fetched with the current `{groupBy, sort, filter:displayFilter}`. Same object this
  plan reads for remaining-height + skeleton headers.
- `groupFraction(indexIntoGroup, groupTotal)` (`scrubber/scale.js`, added 2.16.17)
  already maps "entries into a group" → 0..1 against the group's true size.

## Open sub-problem to resolve in Task 6a (measure first, per debugging discipline)

We need `loadedCount` = photos in the library at-or-above the loaded frontier, to get
`remaining = total - loadedCount`. There is NO absolute index on feed items (verified:
items carry only id + sort keys). Options, cheapest first — spike each with a throwaway
log before committing to one:

1. **Contiguous-from-start assumption.** When the window was built from the library
   start (initial load, not a jump), `loadedCount ≈ Σ photoCount(displayEntries)` and
   the frontier is `displayEntries[last]`. Detect "started at start" via the first
   entry's coarse value === `manifest.landmarks[0].value` AND its within-group index 0.
2. **Manifest-anchored frontier.** frontier coarse value → its landmark; `loadedCount ≈
landmark.startCount + (frontierIndex − groupStartIndexInWindow)` (reuses the
   `groupFraction` gi-walk). Works even after a jump, as long as the frontier group's
   start is in the window.
3. **Server position endpoint.** Add `GET /api/feed/position?id=…` returning the count
   before a photo id under the current sort+filter. Most correct, most work; only if 1–2
   prove unreliable on the real library.

Pick the simplest that holds on the 114k library across folder + camera grouping.

---

## Task 6a: Manifest-driven content height (retire the flat reserve)

**Files:**

- Modify: `ui/src/lib/layouts/windowing.js` (new pure `estimatedContentHeight`)
- Test: `ui/src/lib/layouts/windowing.test.js`
- Modify: `ui/src/App.svelte` (`gridHeight` derived; compute `loadedCount`)

**Interfaces — Produces:**
`estimatedContentHeight({ loadedHeight, loadedCount, total, minTailPx }) → number`
— extrapolate full-library px height from the loaded window's density.

- [ ] **Step 1: Failing test** for `estimatedContentHeight`:
  ```js
  // half the library loaded in 1000px → full ≈ 2000px
  expect(
    estimatedContentHeight({ loadedHeight: 1000, loadedCount: 50, total: 100 })
  ).toBe(2000);
  // fully loaded → exactly loadedHeight (no phantom tail)
  expect(
    estimatedContentHeight({ loadedHeight: 800, loadedCount: 100, total: 100 })
  ).toBe(800);
  // guard: zero loadedCount → loadedHeight + minTailPx (can't divide)
  expect(
    estimatedContentHeight({
      loadedHeight: 500,
      loadedCount: 0,
      total: 100,
      minTailPx: 300,
    })
  ).toBe(800);
  ```
- [ ] **Step 2:** run it red.
- [ ] **Step 3:** implement:
  ```js
  export function estimatedContentHeight({
    loadedHeight,
    loadedCount,
    total,
    minTailPx = 0,
  }) {
    if (!(loadedCount > 0)) return loadedHeight + minTailPx;
    if (!(total > loadedCount)) return loadedHeight; // all loaded, no phantom tail
    const pxPerPhoto = loadedHeight / loadedCount;
    return loadedHeight + (total - loadedCount) * pxPerPhoto;
  }
  ```
- [ ] **Step 4:** green.
- [ ] **Step 5:** In `App.svelte`, derive `loadedCount` (spike options 1–2 above; log
      it against `manifest.total` while scrolling to sanity-check it climbs monotonically
      and → total at the end). Then:
  ```js
  let gridHeight = $derived(
    layoutResult
      ? estimatedContentHeight({
          loadedHeight: layoutResult.totalHeight + 2 * PAD,
          loadedCount: scrubberLoadedCount,
          total: scrubberManifest?.total ?? loadedCount,
          minTailPx: adaptivePageSize && hasMoreAfter ? 1200 : 0, // small runway if no manifest yet
        })
      : 0
  );
  ```
  Keep `scrollableHeight` for the fallback (no manifest) path.
- [ ] **Step 6:** Live-verify: scrollbar thumb size now ≈ loaded/total; the #132
      fling still does NOT freeze (retainWindow from 2.16.7 still holds); scrolling to the
      true bottom lands exactly at the last row (no giant empty gap, no clamp-short).
- [ ] **Step 7:** bump patch, CHANGELOG, commit.

## Task 6b: Skeleton rows below the frontier

**Files:**

- Create: `ui/src/lib/SkeletonRows.svelte` (presentational; diagonal-stripe tiles + headers)
- Modify: `ui/src/App.svelte` (mount it in the grid, virtualized to the viewport)
- Create: `ui/src/lib/layouts/skeletonLayout.js` (+ test) — pure: given the manifest
  remaining leaves, the frontier y, `pxPerPhoto`, `gridWidth`, and a `[yTop,yBottom]`
  viewport window, emit placeholder `{ y, x, width, height }` tiles + `{ y, label }`
  headers ONLY within the window (virtualized — never thousands of nodes).

- [ ] Pure `skeletonLayout` first (TDD): a coarse justified pass over remaining leaf
      counts using a representative aspect ratio (`DEFAULT_RATIO`), header rows at each
      manifest landmark boundary (`y = frontierY + (startCount − loadedCount) * pxPerPhoto`),
      clipped to the viewport window. Test: window clipping, header positions, empty when
      nothing remains.
- [ ] `SkeletonRows.svelte`: absolute-positioned diagonal-stripe boxes (reuse Thumb's
      2.16.3 placeholder gradient) + faint header labels from the manifest. `pointer-events:
none`; no `<img>`, no fetch.
- [ ] Mount inside `.grid` after the real tiles, fed the same `[renderStart..renderEnd]`
      → y-window. Real rows always paint over skeleton for their range (skeleton only where
      `boxes` doesn't reach).
- [ ] Live-verify: fling deep → skeleton structure + headers scroll past; releasing
      triggers `loadMore` which fills real tiles; no console errors; no grid freeze on fast
      up+down (trackPageErrors).
- [ ] bump, CHANGELOG, commit.

## Task 6c: Retire BOTTOM_RESERVE_PX + close #132

- [ ] Remove `BOTTOM_RESERVE_PX` and the `reservePx` branch usage now that height is
      manifest-driven (keep `scrollableHeight`'s param for the no-manifest fallback, or
      inline a small `minTailPx`). Grep for other `BOTTOM_RESERVE_PX` readers first.
- [ ] Full `npm test` + `npm run test:e2e` (scrubber + feed specs) green.
- [ ] Live-verify the EXACT #132 repro (aggressive fling) on folder AND camera
      grouping: mounted set never voids, no whole-page teardown, lands on skeleton.
- [ ] bump (minor only if cutting a package — otherwise patch), CHANGELOG line closing
      #132, commit. `gh issue close 132` with a summary comment.

## Self-review checklist (run before starting 6b)

- Does `loadedCount` climb monotonically to `total` on a real scroll-through? (log it.)
- Is every skeleton read of feed state read-only? (no `items`/`feedEpoch`/flag writes.)
- Is the skeleton virtualized (bounded node count) at 114k?
- Does the fallback (no manifest yet, first paint) still give a sane, non-zero runway?
