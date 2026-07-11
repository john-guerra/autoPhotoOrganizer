# Manual burst-stack overrides — Design

Status: Implemented
Date: 2026-07-11
Issue: #24 (depends on the multi-select + context-menu substrate, #25)

## Scope

Auto burst detection (`ui/src/lib/bursts.js`) is unchanged. This adds two
user overrides layered on top of it:

- **Create stack from selection** — force ≥2 selected photos into one stack even
  when their time gaps wouldn't group them.
- **Dissolve stack** — break a mis-detected (false-positive) stack apart, and
  keep those photos separate on future scans.

## Decisions

- **Dissolve = "keep separate"**: dissolving marks each member with a persisted
  per-photo flag (`photos.no_auto_stack`) so it never auto-stacks again. Simple
  and predictable (not a pairwise "don't group these two" model).
- **Manual stacks are single-group only**: "Create stack" is enabled only when
  the whole selection shares one folder/date-group (identical `groupValues`
  across the active `groupBy`) — matching how auto-bursts never span groups.
- **Persistence keys on photo `id`**, consistent with `preferred_cover` / rating
  / `keep_scope`. These survive rescans of unchanged files because `upsertScan`'s
  ON CONFLICT never overwrites them. A moved/renamed file getting a new id loses
  its override — the same accepted tradeoff those features already make.

## Three-state model (mutually exclusive, enforced at write time)

A photo is in exactly one of:
1. **auto** — neither override; participates in time-gap detection.
2. **manually grouped** — a `manual_stacks(photo_id, group_id)` row; forced into
   the stack of everyone sharing its `group_id`.
3. **kept separate** — `no_auto_stack = 1`; never auto-stacks.

`server/db/manualStacks.js` keeps these from contradicting each other: creating a
manual stack clears `no_auto_stack` and removes prior `manual_stacks` rows for
those ids; dissolving sets `no_auto_stack` and removes their `manual_stacks` rows.

## Data flow / seam

The two per-photo fields (`manualStackId`, `keepSeparate`) are threaded through
the feed exactly like `preferredCover` (`server/db/feed.js` SELECTs + `rowToItem`,
and the scan-response items). On the client, a single pure pass folds them into
the detector output:

```
$: autoStacks = detectBurstsByGroup(items, groupBy, {gapMs: burstEnabled ? burstGapMs : 0});
$: stacks     = applyStackOverrides(autoStacks, items);   // ui/src/lib/stackOverrides.js
$: displayEntries = buildDisplayEntries(items, stacks, expandedStackIds);
```

`applyStackOverrides` (pure): builds `manual-${groupId}` stacks from
`manualStackId` (≥2 present members), removes overridden ids (manual members +
kept-separate) from any auto stack, and drops an auto stack that falls below 2
survivors. Because `stacks` is the single downstream input, everything (layout,
Thumb props, `toggleCover`, `toggleExpand`) propagates with no other change.

**Modularization:** all new logic lives in dedicated modules — `pickCover.js`
(shared canonical cover priority, delegated to from `bursts.js`),
`stackOverrides.js` (`applyStackOverrides` + `canCreateManualStack`),
`stackActions.js` (item transforms + persistence + `buildStackMenuItems`).
`App.svelte` gains only the reactive line above, a context-menu spread, and two
~3-line handlers that mirror `toggleCover`'s local-mutation-then-persist (no feed
reload → no copy of the feed-window guard).

## Notable behaviors

- **Manual stacks render even with burst detection off** (gapMs 0): they're built
  from `manualStackId`, independent of the time-gap walk.
- **Members outside the loaded window**: only present members render; a group with
  a single present member shows as a normal photo, and the override is never lost —
  it regroups as more of the window loads.
- **Cover** of a manual stack uses the same `pickCoverId` priority
  (`preferredCover` → rating → `.COVER.` → first); pressing **C** still works via
  the existing `toggleCover` regardless of `burst-*` vs `manual-*` id.
- `expandedStackIds` uses disjoint `manual-*` ids, so expand/collapse is independent.
