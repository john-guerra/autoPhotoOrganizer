# Burst detection — Design

Status: Approved, ready for implementation plan
Date: 2026-07-06

## Scope

This is the first of two sub-projects under GitHub issue #2 ("Burst
stacks"). This spec covers **only** the detection algorithm: a pure
function that groups a folder's photos into bursts. Grid/UI integration
(collapsing a stack to one tile with a cover + count badge, expand-to-
compare, keyboard/rating interaction, Loupe navigation) is a **separate,
not-yet-designed follow-up** — do not build any of that here. That
follow-up needs its own brainstorming pass before it's implemented.

## Context

Issue #2 originally described two grouping signals: exact Pixel burst
filenames (`PXL_..._BURST-01.COVER.jpg`, `BURST-02`, ...) and a time-gap
fallback for everything else. In review, John clarified that manually
firing off several shots in a row (not using the camera's burst mode) is
his common case — so time-gap grouping must not be a secondary "leftovers"
pass; it needs to be the primary, broad mechanism. Filename matching
becomes a supporting signal within a single unified pass, not a competing
gate that determines which items are even eligible for time-gap grouping.

Real data from John's test folders (surveyed 2026-07-06): the 10,172-photo
Pixel folder has exactly 12 files (4 groups of 3) matching the Pixel burst
filename pattern — about 0.1% of files. The small demo folder (200
JPEGs, older camera exports) has zero burst-named files. So time-gap
detection is the mechanism that actually matters for the large majority of
real bursts; filename matching is a small correctness refinement on top.

## Algorithm

**New pure module `ui/src/lib/bursts.js`** — no DOM, no Svelte, following
the same pattern as `justified.js`/`windowing.js`:

```js
/**
 * @param {Array<{id, name, rating?, mtimeMs, takenAt?}>} items
 * @param {{ gapMs: number }} opts
 * @returns {Array<{ id, memberIds: Array<number|string>, coverId, count }>}
 */
export function detectBursts(items, { gapMs }) { ... }
```

1. **Sort** all items chronologically by effective capture time:
   `takenAt` if present, else `mtimeMs` (mirrors the rest of the app's
   existing pattern of falling back to `mtimeMs` when EXIF hasn't
   resolved yet or is absent).
2. **Walk consecutive photos**, merging into a running cluster whenever
   _either_:
   - the gap between consecutive effective-capture-times is `≤ gapMs`, or
   - both photos share the same Pixel burst filename prefix (see below) —
     a hard-link override, so a genuine burst-mode sequence always stays
     grouped even in the rare case its recorded timestamps land wider
     apart than `gapMs`. Burst-mode shots are typically well under a
     second apart, so in practice this override rarely fires and is
     mostly a correctness guarantee, not the primary mechanism.
3. **Minimum cluster size 2.** A cluster of exactly one photo is not a
   burst; it's excluded from the returned array entirely (the caller
   treats any item not appearing in any stack's `memberIds` as a normal,
   ungrouped photo).
4. **Cover selection**, in priority order:
   1. The highest-rated member, if any member has `rating > 0`.
   2. Else, the member whose filename matches the Pixel `.COVER.` marker,
      if the cluster contains one.
   3. Else, the chronologically-first member (by the same effective
      capture time used for sorting).
5. `gapMs` has no default baked into this module — it's a required
   parameter. (The caller, when this is wired into the UI later, is
   expected to default it to 3000ms and make it configurable — that's
   part of the UI follow-up, out of scope here.)

**Pixel burst filename matching:** `PXL_..._BURST-NN[.COVER].ext`. Regex:
match `^(.*)\.BURST-\d+(?:\.COVER)?\.[^.]+$` (case-insensitive); capture
group 1 is the burst key used to group same-burst files; presence of
`.COVER.` in the filename marks that file as the cover candidate for
step 4.2 above.

## Interface contract

- `items` is the same shape already flowing through `ui/src/App.svelte`
  (`{id, name, size, mtimeMs, rating, width?, height?, takenAt?}`) — no
  new fields required from the server; this module works entirely off
  data already available client-side.
- Output stacks reference items **by id only** (`memberIds`, `coverId`) —
  this module returns no item objects, so it stays decoupled from
  whatever the UI later does with that grouping (consistent with
  `justifiedLayout` returning boxes keyed by id rather than embedding
  item data).
- Order of the returned `stacks` array is unspecified (callers needing a
  particular order — e.g. by first-appearance in `items` — sort it
  themselves; this keeps the module's job narrowly "group and pick a
  cover," not "decide a UI display order").

## Testing

`ui/src/lib/bursts.test.js`, colocated per project convention, covering:

- Pure time-gap grouping (no burst filenames involved): consecutive items
  within `gapMs` group; a gap wider than `gapMs` splits into separate
  runs (or drops to ungrouped if the run is length 1).
- Pixel filename hard-link override: two same-burst-prefix files whose
  timestamps are _farther apart_ than `gapMs` still group together.
- Cover selection priority: a rated member wins even when a `.COVER.`
  marker is also present in the same cluster; `.COVER.` wins when no
  member is rated; chronologically-first wins when neither applies.
- `takenAt`-missing fallback to `mtimeMs` for sorting/gap computation.
- Minimum size 2: a single photo with no time-adjacent neighbors and no
  burst-filename partner produces no stack.
- Mixed folder: a realistic small mix of ungrouped photos, one time-gap
  cluster, and one filename-matched cluster, asserting the correct
  partition and that ungrouped items don't appear in any `memberIds`.

## Out of scope (this spec)

- Any change to `App.svelte`, `Thumb.svelte`, or `Loupe.svelte`.
- The `gapMs` UI control (slider, persistence, default value).
- Cover-photo rendering, count badges, expand/collapse interaction,
  keyboard-nav changes, or Loupe navigation changes.
- Automated quality scoring for winner-picking (explicitly deferred to
  the existing Phase 2 ML plan per an earlier decision in this same
  conversation — manual rating is how a "winner" gets picked, once the
  UI follow-up exists).

These are covered by the not-yet-designed grid/UI integration follow-up
under issue #2.
