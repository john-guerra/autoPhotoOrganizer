# Autonomous session decision log — 2026-07-06

Goal (via `/goal`): finish issue #2 (Burst stacks), then the folder
selection widget, then continue through the rest of the `v0.2` milestone.
This log records decisions made without stopping to ask, so they can be
reviewed on return. Newest entries at the bottom.

## Burst stacks (issue #2)

- **Split into two sub-projects.** Part 1 = pure `detectBursts` detection
  algorithm (spec + plan already approved before this autonomous run
  started). Part 2 = grid/UI integration (cover tile, count badge,
  expand/compare, keyboard/rating, Loupe navigation) — **not yet
  designed**. I'll brainstorm Part 2 quickly using the decisions already
  made earlier in this conversation (inline-grid expand, click/Enter
  toggles expand on a collapsed stack, digit-rating a collapsed stack
  rates its cover, cover selection priority) as the starting point, but
  will flag here if I have to make a judgment call the earlier
  conversation didn't settle.
- **Detection algorithm (Part 1):** implementing exactly per
  `docs/superpowers/specs/2026-07-06-burst-detection-design.md` and
  `docs/superpowers/plans/2026-07-06-burst-detection.md`, both already
  written and effectively approved (user said "start implementing").
  **Task-scoped review clean, but the final whole-branch review caught a
  real bug the task review missed:** `detectBursts` did numeric
  arithmetic on `item.takenAt` assuming it was already milliseconds, but
  the real app produces `takenAt` as an **ISO-8601 string**
  (`server/api.js:109`, `ui/src/lib/api.js:26`) — `string - string` is
  `NaN` in JS, so time-gap grouping (the primary mechanism, per the
  spec) would have silently produced nothing against real EXIF data;
  only the ~0.1% filename-matched bursts would have grouped. All 9 tests
  passed because every fixture used a numeric `takenAt`, not the real
  shape. Fixed with a `toMs()` coercion helper + a realistic ISO-string
  test. This is exactly the kind of integration bug a task-scoped review
  can't see (it never reads the item-shape contract from other files)
  and the final whole-branch review exists to catch — worth noting since
  it's the second time in this session a final review has caught
  something a task review approved (the first was the post-scan-focus
  async-`clientWidth` bug).
- **Part 2 (grid/UI integration) — designed and approved autonomously**
  during this run (spec:
  `docs/superpowers/specs/2026-07-06-burst-stacks-grid-integration-design.md`,
  plan: `docs/superpowers/plans/2026-07-06-burst-stacks-grid-integration.md`).
  Three judgment calls flagged in the spec that were **not** explicitly
  confirmed interactively and deserve a look on return:
  1. **Loupe now navigates the same collapsed/expanded sequence as the
     grid** (skips buried burst duplicates), rather than always walking
     every raw photo. Chosen for consistency — flag if you wanted the
     Loupe to see every photo regardless of grid collapse state.
  2. **Escape (while selection is inside an expanded stack) is the only
     way to re-collapse it** — no dedicated click target. Chosen to avoid
     a second hit-area competing with "click opens the Loupe" on expanded
     members. A small non-interactive visual marker indicates stack
     membership.
  3. **New pure module `ui/src/lib/displayEntries.js`** (tested) rather
     than inlining the merge logic into `App.svelte` the way
     virtualization's `buildVisibleItems` glue function is (untested,
     inline) — this function has more branching/risk than that precedent,
     so it got its own module + tests instead.
  Also chose reasonable-but-arbitrary visual details (badge corners, gap
  slider range 0-10s/500ms steps, default 3000ms) — cheap to tweak after
  you look at it.
- **Part 2, Task 1 (`displayEntries.js`) — one Important review finding
  deliberately not fixed.** The reviewer flagged that
  `buildDisplayEntries` doesn't guard against `stack.coverId` missing
  from the `items`-derived `byId` map (would produce an `undefined`
  `coverItem`). I judged this structurally unreachable given the
  documented calling contract: `stacks` is always
  `detectBursts(items, ...)`'s direct output, computed from the *same*
  `items` array immediately before `buildDisplayEntries(items, stacks, ...)`
  runs (both are `$:` reactive statements in `App.svelte`, same reactive
  pass) — so `coverId` can never point outside `items`. Chose not to
  spend a fix round-trip on defensive code for an unreachable path,
  given the time cost of another implementer+reviewer cycle. **Flag for
  review:** if this reasoning is wrong, or you want defensive code
  anyway (e.g. in case the module is ever called from a new site that
  doesn't uphold the invariant), it's a one-line fallback
  (`byId.get(stack.coverId) ?? byId.get(stack.memberIds[0])`) in
  `ui/src/lib/displayEntries.js`.
