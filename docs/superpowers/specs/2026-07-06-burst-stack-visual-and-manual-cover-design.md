# Burst stack visual redesign & manual cover selection — Design

Status: Approved, ready for implementation plan
Date: 2026-07-06

## Scope

A follow-up to GitHub issue #2 (Burst stacks), covering two related pieces
requested after using the merged feature:

1. **Visual redesign of a collapsed stack's tile** — instead of a flat
   cover photo with a text badge, show a physical "pile of photos" look:
   the cover in front, with every other member's real thumbnail peeking
   out from behind, split left and right.
2. **Manual cover selection** — a way to explicitly choose which photo in
   a stack is the "representative" one, overriding the automatic
   priority (rating → `.COVER.` filename → chronologically-first) that
   exists today.

## Part 1: Manual cover selection

### Persistence

New module `server/coverChoices.js`, a structural mirror of the existing
`server/ratings.js`: an in-memory map (`Record<string, true>`) keyed by
**absolute file path** (survives rescans, same reasoning as ratings),
persisted to a new `~/.autogallery/coverChoices.json` via the same
debounced atomic-write pattern (temp file + rename, 150ms debounce).
`server/lib/cachePaths.js` gets a matching `coverChoicesFile()` alongside
the existing `ratingsFile()`.

API surface, mirroring the existing `/api/rating` route:
- `POST /api/cover` — body `{id, isCover: boolean}`. Resolves `id` to its
  session path (same `itemById` helper `/api/rating` already uses),
  calls `setCoverChoice(path, isCover)`, responds `{id, preferredCover: isCover}`.
- `/api/scan`'s response gains a `preferredCover: boolean` field per item
  (alongside the existing `rating` field), sourced from
  `getAllCoverChoices()` the same way `rating` is sourced from
  `getAllRatings()`.

`ui/src/lib/api.js` gets a matching `setCover(id, isCover)` client
function, mirroring `setRating`.

### Priority tier in `pickCover`

`ui/src/lib/bursts.js`'s `pickCover` gains a **new top-priority tier**,
above the existing three:

1. **Manual override** — a member with `item.preferredCover === true`
   (if more than one is somehow flagged, take the first in chronological
   cluster order — deterministic, though the client is responsible for
   never actually creating that state, see below).
2. Highest-rated member (existing).
3. `.COVER.`-marked filename (existing).
4. Chronologically-first member (existing).

This only changes `coverId`'s derivation — it does **not** affect
`stack.id`, which is already anchored to the chronologically-first
member (`cluster[0].item.id`, fixed during the earlier whole-branch
review) specifically *because* it needed to be stable across cover
changes. A manual pick is just one more thing that can change `coverId`,
exactly like a rating already could — the earlier fix already covers
this case, no new stability work needed.

### Trigger and interaction

A new key, **`C`**, toggles the manual cover choice for the currently
selected photo — but only when that photo is a member of a *currently
expanded* stack (`displayEntries[selected]?.stackId` is set). It's a
no-op otherwise (a collapsed stack tile, or an ungrouped photo). Works
identically whether the grid or the Loupe is focused, since both share
the same `selected` index into the same `displayEntries` list — the
handler is added in `App.svelte`'s `onKeydown`, in the same place the
existing digit-rating check lives (before the `loupeOpen` branch splits
handling), so it fires uniformly in both contexts.

Toggle semantics:
- Pressing `C` on a photo that is **not** the current manual pick for its
  stack: clears `preferredCover` on any *other* member of that same
  stack that currently has it set (at most one, by construction — see
  below), then sets `preferredCover = true` on the target photo. Local
  `items` mutation + `items = items` reactivity trigger, matching the
  existing `rate()` pattern; the `POST /api/cover` calls (one clear, one
  set) are fire-and-forget, same as rating's `apiSetRating(...).catch(...)`.
- Pressing `C` again on the **same** photo (already the manual pick):
  clears it, reverting that stack to automatic selection (rating →
  filename → chronological).

Because every "set" is paired with clearing any prior manual pick within
the same stack, at most one member of a given stack can ever have
`preferredCover === true` at a time — the "if more than one is flagged"
case in `pickCover` above is defensive, not something the app's own UI
can produce.

### Visual feedback while expanded

`Thumb.svelte`'s existing `inExpandedStack` marker (the small "part of a
burst" indicator) gains a second visual state: for whichever expanded
member currently resolves as its stack's cover, the marker renders in a
distinct, "highlighted" style (same glyph, a warmer/accent background
instead of the current blue) — so browsing an expanded stack shows you
at a glance which photo is currently the cover, both before and
immediately after pressing `C`.

This needs `App.svelte` to resolve, per expanded member, "is this the
current cover of its stack" — done via the already-reactive `stacks`
array: `stacks.find((s) => s.id === entry.stackId)?.coverId === entry.item.id`.
Stack counts are small (a handful per folder in practice), so this
per-tile lookup is cheap; no new indexing structure needed.

## Part 2: Stacked-photos visual

### What it looks like

A collapsed stack's tile shows its cover photo in front, with **every
other member** (`count - 1`, uncapped) rendered as a real thumbnail
behind it, split as evenly as possible between the left and right
edges — chronologically-first non-cover member closest to the cover on
the right, second-closest on the left, third on the right again
(further out), and so on, alternating. Each layer is offset purely
**horizontally** (no vertical shift) by a fixed 2px step per position,
so a burst of `count` photos produces slivers reaching up to
`ceil((count-1)/2) × 2px` outward on each side. This is a deliberate
simplification (clean horizontal offset, not a diagonal/rotated fan) —
easy to retune visually once it's actually running.

The existing `×N` count badge is **kept** (same position, bottom-right)
as a fast exact-count readout — counting individual slivers at a glance
gets harder as a burst grows, especially once slivers compress toward
the small pixel budget available in the grid's 8px inter-tile gap.

### Data: `displayEntries.js` gains `peekItems`

`buildDisplayEntries`'s `kind: 'stack'` entry gains a new field,
`peekItems`: the stack's other members (`memberIds` minus `coverId`),
resolved to their item objects via the same `byId` map the function
already builds internally, in their original (chronological)
`memberIds` order. This keeps the "resolve ids to items" responsibility
where it already lives, rather than duplicating a lookup in `App.svelte`
or `Thumb.svelte`.

### Rendering: `Thumb.svelte`

New prop `stackPeekItems` (array, default `[]`). Reactive:
```js
$: peekSrcs = visible ? stackPeekItems.map((it) => thumbUrl(it.id, size, it.mtimeMs)) : [];
```
— gated on the same `visible` (IntersectionObserver) flag as the cover
image, so peek thumbnails don't load until the tile is actually near the
viewport, same lazy-loading discipline as everything else in this
component.

Split alternately into two groups (index 0, 2, 4… → right; 1, 3, 5… →
left), each rendered as its own `<img>` layer, `object-fit: cover`
matching the cover image, offset via `transform: translateX(...)` (2px
per position, increasing outward), `filter: brightness(0.75)` to read as
slightly receded/behind the sharp cover in front, `alt=""` (decorative —
screen readers skip), and the same `loading="lazy"` attribute the cover
already uses.

**z-index scheme (important, easy to get wrong):** peek layers get a
small explicit z-index (1..N, closest-to-cover highest among peeks); the
cover image gets a fixed z-index of 50 (comfortably above any realistic
peek count); the rating badge, count badge, and expanded-stack marker
all need an explicit z-index of 100 (**this is a required change to
existing CSS, not just new rules** — those elements currently rely on
`z-index: auto`, which the CSS spec treats as effectively `0` once *any*
sibling has an explicit z-index, so without this bump the badges would
silently render **behind** the newly z-indexed cover/peek images instead
of on top of them).

## Testing

- `ui/src/lib/bursts.test.js`: new tests for the manual-override priority
  tier — a `preferredCover: true` member wins even over a higher-rated
  or `.COVER.`-marked member; confirm `stack.id` is unaffected by a
  manual-cover change (same invariant already proven for rating
  changes, now also exercised for this new tier).
- `ui/src/lib/displayEntries.test.js`: new tests for `peekItems` —
  correctly excludes the cover, preserves `memberIds` order, resolves to
  the right item objects.
- `server/coverChoices.js`: no dedicated unit-test file, matching
  `server/ratings.js` (confirmed: none exists). Instead, add a
  `server/api.test.js` integration test for the new `/api/cover` route,
  mirroring the existing `describe("ratings round-trip", ...)` block —
  set a manual cover via `POST /api/cover`, rescan, confirm it reattaches
  by path via the `preferredCover` field in the `/api/scan` response;
  also a reject-invalid-input test mirroring the existing
  "rejects an out-of-range rating" case.
- `App.svelte`/`Thumb.svelte` changes: no new automated tests (no
  component test harness exists in this repo) — verified via the full
  suite (regression) plus John's manual check at `localhost:5173`.

## Out of scope

- Any change to the automatic-selection tiers below manual override
  (rating, `.COVER.` marker, chronological-first) — unchanged.
- Retuning the exact visual parameters (2px step, 0.75 brightness, alt
  direction of left/right assignment) beyond a first reasonable pass —
  expected to need visual iteration once running, not something to
  over-specify now.
- Any change to how stacks are detected or grouped (`detectBursts`'s
  clustering logic itself, untouched).
