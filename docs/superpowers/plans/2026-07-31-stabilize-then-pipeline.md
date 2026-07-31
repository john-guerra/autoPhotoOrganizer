# Stabilize, checkpoint, then build the pipeline

**Goal:** fix the bugs that make the app lie to the user, capture a benchmarked
known-good state, and only then start the unified scan pipeline (#258).

**Why this order** is decision **D4** in
`docs/superpowers/specs/2026-07-31-unified-scan-pipeline-design.md`: the pipeline's
acceptance criterion (**D2** — "at least as fast as today") is unenforceable without a
baseline, and a baseline measured on a buggy build measures the bugs. There must be a
state we can return to and compare against.

Status legend: ☐ not started · ◐ in flight · ☑ merged to `testing`

---

## Stage 1 — the bugs that make the app lie

Ordered **cheap-and-certain first, expensive-and-risky last**. Every one of these
reports a number or a state that is wrong; none of them is cosmetic.

Each is its own PR against `testing`, its own claimed version, and — per CLAUDE.md —
each ships with a test at the tier that would have caught it, verified by reverting the
fix and watching the test go red.

### ☐ 1.1 · #246 · Timeline goes stale when the keep-only set changes

**Root cause is known**, which is why it goes first. `ui/src/lib/scope.js:41` projects an
id scope onto the filter as `{ keepScope: true }` — a constant. The timeline refetches only
when its signature changes:

```js
let timesKey = $derived(JSON.stringify(timesFilter) + "|" + libraryVersion);
```

Working set A and working set B stringify identically, the guard suppresses the refetch,
and the KDE keeps plotting the previous set.

**The fix must not be "add the ids to the key."** That reintroduces the unbounded-list
problem `keep_scope` exists to avoid. The scope needs a cheap **version/generation counter**
that changes whenever the working set is replaced — the same idea as `libraryVersion`, which
is already in that key for exactly this reason.

**Audit while here:** any other consumer keyed on `JSON.stringify(displayFilter)` is blind
to the same change. Grep for it; fix or document each.

**Test:** vitest on the key derivation — two different id scopes must produce different
keys. The seam is pure, so this does not need a browser.

### ☐ 1.2 · #253 · Shift-click no longer range-selects (regression of #141)

The handler **exists** (`App.svelte:2383` → `selectRange`), so this is conditional failure,
not absence. Two hypotheses, in order of suspicion — test both before fixing:

1. **An invisible confirmation.** `selectRange` (`App.svelte:2087`) routes large ranges to
   `pendingGroupSelect` and returns. If that prompt renders in the status bar — which is
   currently overflowing and truncating mid-word — the user sees nothing happen.
2. **Mismatched index spaces.** `onTileClick` passes indices into `displayEntries` (the
   context-menu code says so explicitly), but `selectRange` resolves them against
   `resolvedPhotos`. With bursts collapsed those arrays have different lengths, so the same
   integer means different photos.

**Test:** e2e. #141 shipped and regressed, and the failure mode is a _silent no-op_ — only a
test that asserts the selection count changed can see it.

### ☐ 1.3 · #248 · Returning to the feed from another view renders nothing until you scroll

**Danger zone.** This is the feed window (`items`) and landing behaviour — #35, #36, #39,
#180, #189 all lived here.

- Do **not** hand-roll another `fetchingBefore`/`fetchingAfter`/`feedEpoch` guard. A
  _replace_ goes through `withFeedTransaction`, an _extend_ through `loadMore`. If this fits
  neither, extend one — do not open a third.
- Do **not** break jump-to. #189 consolidated jump/landing specifically to end a recurring
  drift class. Re-verify group jump and tree jump **live** afterwards, not just in the suite.

Likely a remount/measure problem: App owns the grid's element and measured width, so a
`ResizeObserver` that never re-fires on remount produces exactly this. Remember the rule —
never re-lay-out from inside a `ResizeObserver` callback; defer a frame.

**Test:** e2e, leave to People/Face Map/Auto Albums and return, assert tiles visible with no
scroll, `trackPageErrors` throughout.

### ☐ 1.4 · #245 · "Visible" is the feed buffer, not the filter's result set

The largest of the five, and the **prerequisite for the pipeline** — every coverage count
#258 quotes is meaningless until scope means something well-defined.

Implements decision **D3**: four nesting scopes, **All ⊇ Keep only ⊇ Filtered ⊇ Selected**,
with "Visible" renamed **"Filtered"** (the ambiguity of "visible" is the direct cause of this
bug — it was read as "on screen" and meant "matching the view").

**The shape change is the work.** Three of the four scopes can be arbitrarily large, so none
of them can travel as an id list:

| Scope     | Sent as           | Already exists?                     |
| --------- | ----------------- | ----------------------------------- |
| All       | nothing           | —                                   |
| Keep only | `keepScope: true` | yes, in `buildFilter`               |
| Filtered  | the filter spec   | yes, it is what the feed query uses |
| Selected  | an id list        | yes, with the 413 guard             |

Preserve the `null` vs `[]` distinction all the way into the SQL (`server/db/scopeIds.js`) —
collapsing them is how an empty selection becomes an hour of inference.

**Also in this commit, and only in this commit:** the `docs/UI-CONTRACTS.md` §1 amendment.
That file is `@`-imported as binding instruction, so it must never describe behaviour that
does not exist yet.

**Open question to settle here:** does a selection _intersect_ the filter or _survive_ it?
A selection outlives a filter change, so "Selected" can contain photos "Filtered" excludes —
the nesting is not automatic. Either disclose it ("20 selected, 14 in the current filter") or
define selecting to intersect.

### ☐ 1.5 · #247 · Timeline range-select count contradicts the density plot

**Deliberately last of the five**, because 1.1 may well be its cause: brushing against a
plot computed for a _different_ working set gives a count that is right for the data and
wrong for the picture. Re-test against a current timeline before diagnosing further.

Not yet reproduced. Needs a live repro, not screenshot reasoning.

---

## Stage 2 — make the checkpoint mean something

### ☐ 2.1 · The benchmark harness

Without this, **D2 is unenforceable** and "the pipeline must be at least as fast" is a
feeling. Deliverable: a script that measures and records, on a real library,

- photos/sec for `meta`, `hash`, `embed`, `faces`
- faces/sec for `group`, **and the per-call overhead** — how much of grouping's cost is fixed
  per invocation versus proportional to faces

That second number is not decoration: it is the evidence that settles the design's open
question about whether grouping runs per cohort or once per run. D1 made cohorts _smaller_
(~57 photos with all stages on), which multiplies any per-call overhead by ~2,200 for a
full-library run.

Also measure **the §1.4 cohort query** — the disjunction of four pending predicates that
will not use the partial index. It is the design's largest unquantified risk, and D1 made it
run ~9× more often than originally assumed.

Constraints: hermetic where it can be (it must not touch John's photo folders except to
read), skips loudly rather than silently when the library or models are absent, and writes
its numbers to a committed file so before/after is a diff rather than a memory.

### ☐ 2.2 · The checkpoint

All of Stage 1 merged, John validates, merges forward, tags. Baseline recorded from 2.1 and
committed. **This is the state we return to and compare against.**

---

## Stage 3 — the pipeline, only after the checkpoint

Per `docs/superpowers/specs/2026-07-31-unified-scan-pipeline-design.md` §5. Each phase ships
alone and is independently valuable; nothing is deleted from the server.

- ☐ **Phase 0** — one source of truth for the pending predicates (`server/pipeline/stages.js`).
  No user-visible change. Fixes #261's counting bugs on the way through.
- ☐ **Phase 1** — coverage (`POST /api/pipeline/coverage`) and the four-scope control.
  Answers "how many am I missing" on its own, without any pipeline.
- ☐ **Phase 2** — the scheduler and preemption (#257), with today's jobs as its clients.
  Needs #260 first (a paused job that cannot be cancelled fails contract 2 outright).
- ☐ **Phase 3** — the runner and the one "Scan my photos" button. **Gated on D2**: measure
  against the 2.1 baseline; a slower pipeline does not merge.
- ☐ **Phase 4** — demote the per-stage routes to advanced affordances. Delete nothing.

---

## Not in this plan, deliberately

Filed, prioritized, and waiting — they do not block the checkpoint or the pipeline:

- **#250** faces imply grouping · **#256** grouping provenance — both want #258's design
  decisions settled first, or they will be built twice.
- **#251** responsive toolbar · **#252** People/Face Map scope headers · **#254** scrubber
  gear · **#255** Face Map minimum group size — enhancements, no wrong numbers.
- **#259** reactive-widget-helper alignment — needs publishes in sibling repos first, and
  touches the timeline widget, which is under active investigation in 1.1/1.5.
- **Remaining GitHub Actions bumps** — `setup-node` v4→v7, `upload-artifact` v4→v7,
  `download-artifact` v4→v8. CI is now emitting a **deprecation annotation** for
  `setup-node@v4` ("Node.js 20 is deprecated... being forced to run on Node.js 24"), so this
  has an expiry date. Small, separate, low risk.
- **better-sqlite3 12→13** — a native major bump, the ABI landmine in `docs/AGENT-NOTES.md`.
  Its own change, with a rebuild verification. Never a drive-by.
