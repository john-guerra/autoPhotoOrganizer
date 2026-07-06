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
- **Part 2, Task 2 — my own plan brief had a real bug, caught and fixed
  by the implementer, then independently re-verified by the reviewer.**
  The brief's literal focus-restoration code used `entryDomId(entry)` at
  4 `querySelector('[data-id="..."]')` call sites, but `Thumb.svelte`
  only ever renders `data-id={item.id}` (the resolved photo's id, never
  a stack's synthetic id) — so those focus calls would have silently
  found nothing for a collapsed-stack target. Fixed within scope to
  `resolvePhoto(entry).id`, keeping `entryDomId` only where it's actually
  needed (the `{#each}` key, and the `justifiedLayout` input's `id`
  field, both of which do need to treat a collapsed stack as one
  distinct element). Worth noting since it means my own design docs
  aren't infallible — the subagent pipeline caught this one before it
  reached you, but it's a reminder to actually run the app rather than
  trust the plan looks right on paper.
- **Part 2 — final whole-branch review caught a genuine Critical bug
  that no task-scoped review could have seen** (this is the third time
  this session a final review has caught something task reviews missed —
  see the `takenAt` bug above and the async-`clientWidth` focus bug from
  the earlier post-scan-focus-fix work). `stack.id` was derived from
  `coverId` (`` `burst-${coverId}` ``, in the already-merged Part 1
  `bursts.js`), but `coverId` changes whenever a rating makes a
  different member the highest-rated. Since `App.svelte` (Part 2) tracks
  expand state in a `Set` keyed by `stack.id`, **rating a photo inside an
  expanded stack silently collapsed it and lost the selection** — the
  exact "expand a burst, star the best frame" motion the whole feature
  exists to support. Fixed by anchoring `id` to the chronologically-first
  member (`cluster[0]`, stable under rating changes) instead of the
  cover, plus a regression test asserting id stability across a rating
  change. This is a cross-module bug (root cause in Part 1's `bursts.js`,
  symptom only visible once Part 2's `expandedStackIds` existed) —
  exactly the class of defect the whole-branch review step exists for.
- **Judgment call: deferred, not fixed** — the same review flagged that
  burst grouping (and therefore stack ids) can also shift while a scan's
  metadata streams in progressively (`enrichMeta` populates `takenAt` in
  chunks, each chunk re-running `detectBursts`), which could visibly
  reflow/regroup stacks — including ones a user has already expanded —
  while a scan is still settling. The id-stability fix above narrows
  this to only matter if cluster **membership** itself shifts (not just
  the cover), which is rarer than the original bug (which fired on
  nearly every rating). Given the added scope of a "freeze grouping
  until a run's metadata settles" mechanism, I'm accepting this as a
  documented reflow-while-scanning limitation for this pass rather than
  building that mechanism now. **Flag for review** if you want that
  handled properly — it would need its own small design pass.
- **Minor findings, recorded not fixed** (per subagent-driven-development
  process — Minor items aren't bundled into a Critical/Important fix
  dispatch): (1) `toggleExpand`'s collapse branch is dead code (a
  `kind:'stack'` entry, the only thing that calls `toggleExpand`, only
  ever exists while collapsed — collapsing only ever happens via
  Escape); (2) every rating keystroke re-runs `detectBursts`
  (O(n log n) sort) and reallocates `resolvedPhotos` (full array) even
  when the Loupe is closed and nothing consumes it — likely fine at 10k
  scale (a few ms) but worth gating `resolvedPhotos` on `loupeOpen` if
  it's ever felt.

## Follow-up: burst stack visual redesign + manual cover selection

New spec/plan brainstormed and approved in the same session:
`docs/superpowers/specs/2026-07-06-burst-stack-visual-and-manual-cover-design.md`
/ `...plan.md`. All 5 tasks implemented and task-reviewed clean via the
usual subagent pipeline (manual cover persistence+API, priority tier,
keyboard trigger, `peekItems` data, peek rendering).

**The peek-rendering visual (Task 5) required five additional rounds of
fixing after task review passed clean** — every one of them a pure
CSS/layout bug invisible to `npm test` (no component test harness exists
in this repo) and, critically, **invisible to two rounds of careful
static code review that traced the CSS by hand and declared it correct**.
Only live browser testing (screenshots from John, then direct
`claude-in-chrome` DOM measurement) surfaced the real bugs:

1. `.thumb`'s pre-existing `overflow: hidden` clipped the peek layers
   entirely (task review caught this one, static reasoning was right).
2. Even after a non-clipping wrapper fix, peeks were still imperceptible
   live — added diagonal offset + a margin that scaled with stack size.
3. Screenshot showed large stacks overlapping/too-wide — clamped the
   *visual* depth to a fixed `MAX_PEEK_DEPTH=2` (data/count stays
   uncapped).
4. Screenshot showed stacks still touching — a review pass traced the
   CSS **by hand** and declared the containment fix correct (`inset: 0
   Mpx` on the peek layer should shrink its box to match the reserved
   margin). **This reasoning was wrong**, and the review didn't catch
   it: `<img>` is a CSS "replaced element," and per spec, an
   absolutely-positioned replaced element with `width: auto` sizes to
   its *intrinsic* dimensions, ignoring `inset`-implied width entirely —
   unlike a `<div>`/`<button>` (non-replaced), which is why the cover
   button sized correctly under the identical-looking rule but the peek
   `<img>` didn't. Only live DOM measurement (`getBoundingClientRect()`
   via `claude-in-chrome`) revealed the peek's actual rendered width was
   full-wrapper-width, overshooting ~18-30px past the tile. Fixed with
   an explicit `left` + `width: calc(...)` instead of relying on
   `inset` shorthand.
5. Fixing #4 (moving peek layers to be siblings of the button, outside
   its `overflow:hidden`, back in fix #1) had two more knock-on
   consequences neither prior review caught: `border-radius: inherit`
   on the peek layers now inherited from the new wrapper parent (no
   radius set) instead of the button — square corners instead of
   rounded; and the button's own selection border/box-shadow (no
   z-index of its own) got promoted into the wrapper's shared stacking
   context *below* the peek layers' explicit z-index, so the blue
   selection highlight was invisible specifically on stack tiles. Both
   fixed (explicit `border-radius` on peeks; explicit `z-index: 10` on
   the button so it owns its own stacking context).

**Takeaway for future visual/CSS work in this repo:** given there's no
component test harness, static code review of CSS geometry is
*insufficient* — verify pixel-level rendering claims (containment,
z-index/stacking, inherited properties) via live DOM measurement
(`claude-in-chrome` + `getBoundingClientRect()`/`getComputedStyle()`),
not by tracing the cascade by hand. Two independent review passes both
traced the same wrong conclusion by hand in this session.

**Also logged mid-testing, not yet acted on:**
- John noted while testing: "I think this is the first burst
  `PXL_20240822_165336928.MP.jpg`" — a filename he expects to be the
  chronological start of a real burst in the test folder. Attempted to
  verify live but the tile wasn't currently mounted (virtualized out of
  the visible window in the 10k-photo grid) and John didn't flag an
  actual discrepancy — just an observation. Not independently
  cross-checked against `detectBursts`'s actual output; worth revisiting
  if burst grouping in this folder is ever in question again.
- John also reported "when I click in the thumb, I see a different
  photo in the details [Loupe]" — **investigated live and resolved as
  NOT a burst-stack bug.** Traced end-to-end via `claude-in-chrome`:
  opened the Loupe on the exact reported photo/index, closed it, and
  compared the grid tile at that same selection directly against the
  Loupe — the tile's `data-id`, `title`, and even its `<img src>`
  attribute all correctly pointed to the right photo, but the
  *rendered pixels* showed a different photo entirely. A direct
  `fetch()` of the same `/api/thumb/:id` URL (bypassing the existing
  `<img>` element) returned the CORRECT image, and John independently
  confirmed switching to a different browser also showed the correct
  image — so the server's id→path mapping and thumbnail cache are
  provably correct; the staleness was scoped entirely to that one
  browser tab's own cache/rendered state, almost certainly from the
  unusually large number of rapid rescans/reloads done during this
  testing session (not standard usage). Filed as GitHub issue #29 (a
  general thumbnail-caching question, not burst-stack-specific) rather
  than fixed on this branch — orthogonal to the feature this branch
  implements, and not reproduced under normal single-scan usage.
