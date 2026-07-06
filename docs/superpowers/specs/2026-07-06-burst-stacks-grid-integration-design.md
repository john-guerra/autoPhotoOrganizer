# Burst stacks — grid/UI integration — Design

Status: Approved (autonomous session — see note below), ready for
implementation plan
Date: 2026-07-06

> **Note on approval:** this spec was written and approved during an
> autonomous run under an active `/goal` directive ("continue until you
> finish implementing issue #2... then continue until you finish v0.2")
> while John was away. It builds directly on decisions he made
> interactively earlier in the same conversation (inline-grid expansion,
> click/Enter toggles expand on a collapsed stack, digit-rating a
> collapsed stack rates its cover, cover-selection priority). Judgment
> calls made autonomously beyond those decisions are flagged inline below
> and logged in `docs/superpowers/decisions-log-2026-07-06.md` for review.

## Scope

Part 2 of GitHub issue #2 ("Burst stacks"). Part 1 (`detectBursts`, the
pure detection algorithm) is done — see
`docs/superpowers/specs/2026-07-06-burst-detection-design.md`. This spec
wires that detection into the grid: a burst collapses to one tile (cover
+ count badge), click/Enter expands it inline, and every existing
interaction (keyboard nav, rating, Loupe) keeps working against the
resulting display list.

## Recap of decisions already made (interactively, earlier this session)

- Compare UI is **inline in the grid** — a collapsed stack's members
  appear as normal-sized thumbnails in place when expanded, not a Loupe
  multi-pane mode.
- **Click/Enter on a collapsed stack tile toggles expand**, instead of
  opening the Loupe. Normal (non-stack) photos are unaffected.
- **Digit-rating a collapsed stack tile rates its cover directly** — no
  need to expand for the common case of starring the obvious best shot.
- **Cover selection** (from the Part 1 spec): highest-rated member → else
  `.COVER.`-marked file → else chronologically-first.
- **Winner-picking is manual only** for this pass (no automated quality
  scoring — that conflicts with the MVP's explicit ML-ranking exclusion;
  filed as future work under the existing Phase 2 ML plan).

## New judgment calls made in this spec (flagged for review)

1. **Loupe navigates the same collapsed/expanded state as the grid.**
   Opening the Loupe walks a list where each collapsed stack contributes
   only its cover photo, and each expanded stack contributes all its
   members individually — i.e., one navigable "slot" per grid tile, not
   one per raw photo. This means arrowing through the Loupe skips buried
   burst duplicates exactly like the grid does. Alternative considered:
   Loupe always walks every raw photo regardless of collapse state — not
   chosen, because it would mean two different orderings/counts a user
   has to reason about (grid position ≠ Loupe position), for a feature
   whose whole point is reducing clutter from near-duplicates.
2. **Re-collapsing an expanded stack: Escape**, while the current
   selection is a member of that expanded stack. Chosen for consistency
   with the app's existing keyboard-first ethos (Escape already closes
   the Loupe) and because a dedicated click target would need a separate
   hit-area from "click opens the Loupe" (which expanded members keep,
   unchanged, like any normal photo). A small non-interactive visual
   marker on expanded members indicates they're part of a stack (so the
   user knows Escape does something there); no separate click-to-collapse
   control in this pass.
3. **`buildDisplayEntries` (merging raw items + detected stacks + expand
   state into the grid's display list) is a new pure, unit-tested module**
   (`ui/src/lib/displayEntries.js`), not inlined into `App.svelte` the way
   virtualization's `buildVisibleItems` glue function is. Grid
   virtualization's glue function is a simple array-splice with no branchy
   logic and has no dedicated test, matching the rest of `App.svelte`
   (no component test harness exists in this repo). This function has
   real edge cases (first-occurrence-in-scan-order placement, skipping
   already-emitted collapsed-stack members, expand/collapse state
   tagging) where a subtle bug would be hard to catch by manual testing
   alone, so it gets its own tested module.

## Data model

**`ui/src/lib/displayEntries.js`** (new pure module, no DOM/Svelte):

```js
buildDisplayEntries(items, stacks, expandedStackIds) -> entries[]
// entries: { kind: 'photo', item, stackId: string|null }
//        | { kind: 'stack', stack, coverItem }

entryDomId(entry) -> string   // stable data-id: stack.id when collapsed, item.id otherwise
resolvePhoto(entry) -> item   // the underlying photo (cover, for a collapsed stack)
```

- A stack's entry (collapsed) or entries (expanded) appear at the
  position of the stack's **first-occurring member in `items` order** —
  unrelated photos are never reordered. (Real burst files are virtually
  always contiguous in scan order already, since camera filenames/mtimes
  are sequential; this rule just defines the behavior precisely for the
  rare case they aren't.)
- `stackId` on a `'photo'` entry is non-null exactly when that photo is a
  member of a **currently expanded** stack — this is what drives the
  visual marker and the Escape-to-collapse check.

## `App.svelte` integration

- **New state:** `burstGapMs` (persisted to `localStorage` like `zoom`,
  default 3000ms, a new slider in the topbar next to the zoom control),
  `expandedStackIds` (a `Set`, reset implicitly every scan since it's
  derived fresh — not persisted across sessions; YAGNI, matches how
  `selected`/`loupeOpen` already reset on scan).
- **New reactive chain**, replacing `items` as the direct driver of
  `boxes`:
  ```js
  $: stacks = detectBursts(items, { gapMs: burstGapMs });
  $: displayEntries = buildDisplayEntries(items, stacks, expandedStackIds);
  $: resolvedPhotos = displayEntries.map(resolvePhoto); // passed to Loupe
  ```
  `boxes` now computes from `displayEntries` (aspect ratio from each
  entry's resolved photo; `id` from `entryDomId`), and `visibleItems`
  (virtualization) now iterates `displayEntries` instead of raw `items`.
  Every place that previously read `items.length` for a grid-index bound
  now reads `displayEntries.length` — the two differ exactly when a
  collapsed stack has shrunk the display list.
- **`rate(index, rating)`** resolves `displayEntries[index]` to its
  underlying photo (`resolvePhoto`) before mutating `.rating` — for a
  collapsed stack this rates the cover, per the decision above.
- **`<Loupe items={resolvedPhotos} bind:index={selected}/>`** — no
  changes needed inside `Loupe.svelte` itself; it's agnostic to where its
  `items` array comes from.
- **Enter/Space in grid mode:** if `displayEntries[selected]` is a
  collapsed stack, `toggleExpand(stack)`; otherwise, `openLoupe(selected)`
  (unchanged).
- **Escape in grid mode (new):** if `displayEntries[selected].stackId` is
  set (selection is inside an expanded stack), collapse that stack and
  re-select/re-focus its now-collapsed tile.
- **`toggleExpand`/`collapseStack`** mutate `expandedStackIds`, await a
  tick for `displayEntries` to recompute, then re-resolve `selected` to
  the sensible resulting tile (the stack tile when collapsing, the
  cover's own entry when expanding) and re-focus via the same
  `querySelector('[data-id="..."]')` idiom used throughout this file.

## `Thumb.svelte` additions

Two new optional props:
- `stackCount` (number, undefined for non-stack tiles) — renders a small
  "×N" badge (new corner, since the existing rating-stars badge already
  occupies bottom-left).
- `inExpandedStack` (boolean, default false) — renders a small
  non-interactive marker indicating this tile is a member of a currently
  expanded stack (visual cue only; Escape is the collapse mechanism, per
  judgment call #2 above).

## Testing

- `ui/src/lib/displayEntries.test.js`: unit tests for `buildDisplayEntries`
  covering — ungrouped photos pass through unchanged; a collapsed stack
  appears once, at its first member's position, using the cover photo;
  an expanded stack's members all appear individually, tagged with
  `stackId`; a stack's later members are skipped (not duplicated) when
  collapsed; `entryDomId` and `resolvePhoto` behave correctly for both
  entry kinds.
- `App.svelte`/`Thumb.svelte` changes: no new automated tests (no
  component test harness exists in this repo, per established
  convention) — verified via the existing full suite (regression) plus
  John's manual check at `localhost:5173` per the working agreement.

## Out of scope

- Automated quality scoring for cover/winner selection (filed under the
  existing Phase 2 ML plan).
- Any change to `detectBursts` itself (Part 1, already implemented).
- The `gapMs` UI's exact visual styling beyond a functional slider —
  cosmetic polish is a fast follow if John wants it after using it.
