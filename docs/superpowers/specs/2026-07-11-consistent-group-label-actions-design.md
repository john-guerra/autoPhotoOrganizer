# Consistent group-label actions + tri-state select icon

**Issue:** #88 · **Date:** 2026-07-11 · **Status:** approved, pre-implementation

## Problem

A group/album label offers **different actions depending on its display state**:

| Action             | Expanded header | Snapshot header | Collapsed pill |
| ------------------ | --------------- | --------------- | -------------- |
| Select             | ✅              | ✅              | ❌             |
| Keep only          | ✅              | ✅              | ❌             |
| Remove (folders)   | ✅              | ✅              | ✅             |
| Rename (dbl-click) | ✅              | ❌              | ❌             |

The actions should be identical regardless of collapse state (Google-Photos-style
consistent header). Additionally, no group-level selection indicator exists today:
the user cannot see or toggle whether a whole album is selected.

## Goals

1. **Consistent actions** — every group label offers the same action buttons
   whether expanded, shown as a snapshot strip, or collapsed to a pill.
2. **Tri-state select icon** on each group label:
   - **none** selected → `☐`
   - **some** selected → `⊟` (indeterminate)
   - **all** selected → `☑` (green check, matching the per-photo `✓`)
   - Clicking toggles select-all / deselect-all for that group.

## Non-goals (deliberate scope cuts)

- **Rename stays on the expanded header only.** It is an inline-edit interaction,
  not a button; adding editable inputs to the thin collapsed pill is
  disproportionate. Rename-everywhere is a small follow-up if wanted.
- The burst-aware selection (#84) and Shift+jump range-select (#83) are separate
  issues; this design does not touch them.

## Approach

### Part 1 — Consistent actions via a shared component

Extract a small **presentational** component
`ui/src/lib/GroupLabelActions.svelte` rendering, left to right:

```
[tri-state select icon] · Select · Keep only · Remove (folder-gated)
```

- Props: `path`, `selectState` (`'none'|'some'|'all'|'loading'`), `isFolder`,
  `removeArmed`.
- Events (Svelte `dispatch`, mirroring `SnapshotStrip`): `toggleselect`,
  `select`, `keeponly`, `remove`.
- All three header blocks in `App.svelte` render this component, so their action
  sets are identical **by construction** (matches CLAUDE.md's "no Nth copy" rule
  and issue #63's "groups as containers with a swappable body").
- `App` wires the dispatched events to the existing handlers `selectGroup`,
  `keepOnlyGroup`, `removeAlbum`, plus the new `toggleGroupSelectAll`.

The expanded header keeps its chevron + rename affordance around the shared
actions cluster; the snapshot header keeps its `◐` cycle button; the collapsed
pill keeps its `▸` disclosure. Only the **actions cluster** is shared.

### Part 2 — Tri-state select state

Pure module `ui/src/lib/groupSelection.js`:

```js
// selectedInGroup: count of a group's photo ids that are in the selection
// groupSize: total photo ids in the group (filter-consistent)
export function selectState(selectedInGroup, groupSize) {
  if (groupSize <= 0 || selectedInGroup <= 0) return "none";
  if (selectedInGroup >= groupSize) return "all";
  return "some";
}

// count of ids present in the selection set
export function intersectionCount(ids, selectedSet) { ... }
```

`App.svelte` state:

- `groupIdCache: Map<pathKey, { ids: number[], sig: string }>` where `sig`
  encodes the current filter + sort (so a stale entry is detected/ignored).
- A visible group header lazily populates the cache once via the existing
  `fetchPhotoIds(displayFilter, path, sort)` (the same call `selectGroup` uses).
- Reactive derivation per header:
  `state = cached ? selectState(intersectionCount(ids, selectedIds), ids.length) : 'loading'`,
  recomputed whenever `selectedIds` changes or the cache version bumps.
- `toggleGroupSelectAll(path)`: ensure ids cached (fetch if missing), then
  - if `state !== 'all'` → `selectedIds = new Set([...selectedIds, ...ids])`
  - else → subtract: `ids.forEach(id => selectedIds.delete(id)); selectedIds = selectedIds`.

### Cache invalidation

Clear `groupIdCache` (bump a `groupIdCacheVersion`) wherever `headerCounts` /
`fetchedParents` already reset — filter change, sort change, groupBy change, and
rescan/library reset. No new invalidation seam is introduced; the cache rides the
existing reset points. The `sig` tag is a belt-and-suspenders guard against a
missed reset.

## Error handling

A failed `fetchPhotoIds` on toggle surfaces through the existing inline `error`
(never silent), exactly like `selectGroup`'s `catch`. While a header's ids are
still loading, the icon shows a neutral `'loading'` state and the click awaits
the fetch before toggling.

## Testing

- **Unit (vitest, colocated):** `groupSelection.test.js` — `selectState`
  boundaries (empty group → none, 0 selected → none, partial → some, exactly all
  → all, over-count clamps to all) and `intersectionCount`.
- **Live verification** on the isolated dev stack:
  1. All three states (expanded / snapshot / collapsed) show identical action
     buttons + the select icon.
  2. The icon tracks `none → some → all` as individual photos are selected.
  3. Clicking the icon selects all of a collapsed group; clicking again clears
     it; the flat `selectedIds` count changes accordingly.
  4. Changing the filter/sort invalidates the cache (state stays correct).

## Files

- **New:** `ui/src/lib/GroupLabelActions.svelte`, `ui/src/lib/groupSelection.js`,
  `ui/src/lib/groupSelection.test.js`.
- **Modified:** `ui/src/App.svelte` (cache + helpers + wire the shared component
  into all three header blocks), `package.json` (version bump), `CHANGELOG.md`.
