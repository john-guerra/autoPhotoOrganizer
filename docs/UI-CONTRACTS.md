# The three contracts every feature inherits

Three rules about how a feature meets the user. They are contracts rather than
guidelines: a feature that breaks one is incomplete in the same way a feature
with no error handling is incomplete, and reviewers should say so.

They are written down because **they were not, and it cost a whole feature.**
Faces (#166/#167) shipped with no scope selector, an uncancellable grouping
pass, and its browsing UI inside a settings panel — three mistakes this repo had
already made, diagnosed, and fixed once each (#215, #208, #207). Every one of
those fixes lived only in a closed issue. Nothing an agent reads at the start of
a session said the rule, so the rule was re-broken. That is the failure mode
this file exists to stop.

---

## 1. Scope — what set of photos does this act on?

**Every operation over photos states its scope, and the user picks it.**

The scopes, always in this order, always with a live count:

| Scope         | Means                                    | On the wire             |
| ------------- | ---------------------------------------- | ----------------------- |
| **All**       | everything the operation still has to do | nothing — the sweep     |
| **Keep only** | the working set, when one is in force    | `filter: { keepScope }` |
| **Filtered**  | everything the current filter matches    | `filter: <spec>`        |
| **Selected**  | the user's selection                     | `ids: selectedIds`      |

**"Keep only" is offered ONLY while a working set is in force.** Without one it
is the same set as All, and a duplicate option invites the user to distinguish
two identical things.

### Three of them nest. Selected does not, on purpose (#245)

    All  ⊇  Keep only  ⊇  Filtered        Selected — deliberately outside

A selection **survives a filter change**: check twenty photos, narrow the view,
and all twenty are still yours to act on. So "Selected" can contain photos
"Filtered" excludes. The set is not wrong — a UI that implies it nests is. When
the two disagree the control discloses the overlap ("Selected 20 · 14 in the
current filter") rather than showing a number that looks like a subset of the
one above it.

### Only Selected may travel as ids

This is the part that was wrong for a year, and it was wrong because of a NAME.
"Visible" was read as "what is on screen" and meant "what the filter matches",
so the count came from the loaded feed window — a few hundred rows that vary
with how far you have scrolled. Asking to find faces in 1,557 photos scanned
175 of them and reported success (#245).

The rename to **Filtered** is the fix, and the wire format follows from it:
All, Keep only and Filtered can each be **arbitrarily large** — Filtered with
no facets active IS the whole library — so they travel as a DESCRIPTION the
server resolves (`resolveScope` in `server/db/scopeIds.js`), never as an
enumeration. Only Selected is a genuine list, and it keeps its 413.

Two consequences worth stating:

- **A filter that constrains nothing collapses to the sweep** before it is
  resolved, so "Filtered" cannot materialize 125,000 ids. It is also the
  correct answer, since that IS "All".
- **`scopeIdsFor` THROWS for Filtered and Keep only.** A caller still thinking
  in ids must fail loudly, because the alternative is silently acting on a
  fraction of what the user asked for and reporting success — the shape of the
  original bug.

**There is now ONE component — use it, do not write a second.**
`ui/src/lib/ScopeControl.svelte` renders the fieldset and the estimate;
`ui/src/lib/scopeControl.js` holds the arithmetic (`buildScopes`,
`activeScope`, `scopeRequestFor`, `formatEstimate`) so a caller can ask "which ids
did they pick?" without reaching inside a component, and so it is testable
without a DOM. Embedding (#215/#206) and faces (#221) are its two clients.

Wiring a third takes five things:

1. `<ScopeControl legend name testid allCount … bind:choice />` — **`name` must
   be unique per instance.** Two radio groups sharing a name are ONE group to
   the browser, so choosing a scope in one panel silently clears the other's.
2. `allCount` is the operation's own REMAINING work, not the library total.
3. Send `scopeRequestFor(choice, { selectedIds, filterSpec })` — `{}` for the
   sweep, `{ ids: [] }` for an empty selection, `{ filter }` for the two that
   cannot be enumerated. The server keeps "no scope" and "zero photos" distinct
   all the way into the SQL (`server/db/scopeIds.js`); collapsing them is how
   an empty selection becomes an hour of inference. On the wire, **an omitted
   key and `null` both mean "no scope"** — only an actual empty array is
   refused.
4. The route resolves the scope through `scopeForRoute` (`server/api.js`),
   which both `POST /api/ml/embed` and `POST /api/ml/faces` use — empty is a
   specific 400, oversized a 413, and a filter is resolved to ids server-side.
   Do not hand-roll a fourth copy of that validation.
5. The job's `total` is the scope's **pending count** — the worklist query run
   once up front (`pendingFaceRows(db, model, MAX_SAFE_INTEGER, ids).length`)
   — **not `ids.length`**, and it is set at `registry.create`, not on the first
   progress tick. Both halves matter: the scope includes photos already done,
   so `ids.length` makes the bar finish at 25% and stop; and a total that
   arrives one batch late is an indeterminate bar at exactly the moment the
   user is deciding whether it hung (#208). If the pending count is zero, say
   so and start no job at all.

### The rules

- **Counts are live and next to the choice.** "Selected (0)" and "Visible
  (312)" are what make the choice real; a bare radio button is a guess.
- **An empty scope is offered but disabled, never silently widened.** Falling
  back to the whole library because the selection was empty is the failure that
  costs an hour of CPU and looks like the button misfired.
- **The cost estimate tracks the scope.** Changing the scope changes the count
  and the "about N minutes" together, or the estimate is worse than none —
  the user plans around it.
- **One control, not one per feature.** Three near-identical scope controls in
  three places is already Finding 4 of `ML-UX-REVIEW-2026-07-26.md`. Extract
  and reuse; do not copy.

### What a violation looks like

```
[ Find faces in 32,000 photos ]      <- no scope: the only offer is everything
```

You selected twenty photos and the app offers fourteen minutes of inference over
the library. That was #221 — **fixed in 2.18.42**, and the fix is why the shared
component above exists: the rule had been settled once already for embedding,
and faces re-broke it because there was nothing to reuse.

---

## 2. Locus of control — the user can see it, leave it, and stop it

**Anything that can run longer than a moment is a JOB.** Not an awaited fetch,
not a disabled button with a spinner on it.

A job means all four of these, not three:

1. **Visible** — it appears in the JobsPanel from the main interface, so closing
   the panel that started it does not make it disappear.
2. **Honest progress** — a proportional bar whenever the total is knowable. An
   indeterminate bar against a known total is #208, and it reads as a hang.
3. **Cancellable** — a working Cancel, and cancelling writes nothing partial
   the user did not ask for.
4. **Reported on completion** — `summarize()` in `JobsPanel.svelte` has a branch
   for the job type. A bare ✓ with no summary is an unfinished feature.

### The rules

- **A cancellation is an outcome, not a failure.** It renders as cancelled, not
  as `✗ 1 failed` (Finding 6, `ML-UX-REVIEW-2026-07-26.md`).
- **Long CPU work yields.** A synchronous O(n²) pass on the event loop is a
  server that answers nothing — no thumbnails, no feed, no jobs panel — and the
  user cannot tell a wedge from a crash. `clusterFaces` yields every 512 rows
  (`server/ml/faceClusters.js`); that yield point is also where the abort signal
  gets checked.
- **A host failure pauses and says why; it never blames the photos.** A missing
  model or an unmounted drive tells you nothing about a photo, and a permanent
  "cannot be read" sentinel outlives the condition that caused it (#169). See
  `isTransient` in `server/ml/faceSweep.js`.
- **Every permanent sentinel needs a reachable escape hatch.** "Permanent" means
  "until the file's bytes change", i.e. never. A `clearXFailures` with no route
  and no button is not an escape hatch.

### Making an awaited request into a job is not a wrapper

The route stops returning the result and returns `{jobId}` instead, and the
caller stops awaiting a result. Budget for the UI change, not just the server
one. Both `POST /api/ml/faces` and `POST /api/ml/faces/cluster` now have this
shape — the latter as of 2.18.43 (#222), and converting it took, in order:

> **#222 is REOPENED — read this list as the shape, not as a finished job.**
> Every step below did land, and the code is still the reference for _how_ the
> conversion is done. But John validated `2.19.22` and reported "the jobs panel
> doesn't show a progressive task as it does with the faces", so the contract is
> not met on his library. The leading hypothesis (recorded on #222, not yet
> confirmed) is that the server emits progress every ~11 ms and it cannot get
> out: with the pre-#231 yield budget the loop was held 64–91 ms at a stretch.
> **PR #285 landed the yield fix on 2026-08-04, so the stated blocker is
> cleared and the re-test is the next step.** Until that happens, do not cite
> #222 as a success story — cite it as the reminder that a route returning
> `{jobId}` is necessary and not sufficient, because what the contract promises
> is a bar the user can _see_ move.

1. the route returning `{jobId}` and doing its work after `res.json()`;
2. every refusal moving BEFORE `registry.create`, so a rejected request never
   leaves a row that appears and immediately fails;
3. a single-flight latch, because two passes would each compute a full
   partition and the loser would silently overwrite the winner;
4. the long loop taking the job's `AbortSignal` **at the point where it already
   yields** — the only place in an O(n²) scan where the process is not
   mid-comparison;
5. the panel dropping its `await` and reading the outcome off the finished job
   instead — including telling _cancelled_ and _failed_ apart, because saying
   "grouping failed" to someone who pressed Stop is the Finding 6 mistake;
6. a `summarize()` branch, or the finished row is a bare ✓.

**Progress is measured in WORK, not in items.** The clustering loop is O(n²)
over the upper triangle, so row _i_ does _(n − i)_ comparisons: at half the
rows, 75% of the work is behind you. A bar driven by row index crawls and then
leaps. Report pairs against `n(n−1)/2`.

---

## 3. Views — browsing is the main area's job, panels are for settings

**If a feature shows you your photos, or acts on them, it belongs in the main
area.** The settings panel holds settings: what model, download it, the licence,
forget everything.

The dividing question is not "is it about ML" — it is **"would the user expect
to select, rate, or open a photo from here?"** If yes, it is a view.

| Belongs in the main area                    | Belongs in a settings panel        |
| ------------------------------------------- | ---------------------------------- |
| Browsing and naming people ✅ 2.18.44       | Which face model, and download it  |
| Semantic search results you can act on      | The licence notice                 |
| Near-duplicate and burst controls (#207)    | "Forget all face data"             |
| Anything with a selection or a rating in it | Cache size, device, opt-in toggles |

### The contract

Specified in **#155**, and the registry is the deliverable — not any one view.
**It exists**, as of 2.18.41, with the grid and Auto Albums as its two clients:

```js
// ui/src/lib/views/registry.js
{ id, label, icon, description,
  navigation: "scroll" | "zoom",     // who owns the viewport
  dataSource: "feed" | "working-set",
  capabilities: { open, select, rate },   // all three REQUIRED, explicit booleans
  keys: [{ keys: ["Escape"], label: "Clear the lasso" }],  // optional, see below
  offerable: (ctx) => boolean,       // optional; earn a switcher slot
  component }
```

`capabilities` is the part that does work at runtime rather than documenting
intent. `App.svelte`'s `refuseUnsupported()` reads it before a rating or
selection keystroke and answers the user by name — because nothing used to,
and pressing `3` during the album review silently rated a photo in the feed
window that was not on screen.

Two things a new view needs beyond its entry here: a `viewProps` case in
`App.svelte` (its props, in one place, rather than another `{#if}` in the
markup), and — if it declares `dataSource: "working-set"` — an entry in
`WORKING_SET_LOADERS`, because **App performs the bounded fetch**, not the
view. The grid is the one view mounted explicitly rather than generically:
App computes its layout, so App needs its element and measured width, and
`bind:` cannot be passed through a spread.

### `keys` — a view declares the keys it handles itself

Added by #232, and the gap it closes is worth naming because the table above
had promised it since #155: "view-specific keys, declared" belonged to the
view, and **there was nowhere to declare them.**

`capabilities` describes what happens to PHOTOS. A view may legitimately own a
selection of something else — the Face Map selects PEOPLE — and without a
declaration `refuseUnsupported` answers every keystroke in photo terms.
Concretely, `Escape` in the Face Map was answered _"Selecting photos isn't
available in Face Map"_ while the user was looking at a selection of people.
Confidently wrong is worse than silent.

```js
keys: [
  { keys: ["Escape"], label: "Clear the lasso and empty the tray" },
  { keys: ["0"], label: "Fit the whole map back into view" },
];
```

Two consumers, and both are the point:

- **`ShortcutsOverlay.svelte` renders them**, so a view's shortcuts cannot ship
  undocumented. CLAUDE.md's "a shortcut nobody can find does not exist" now
  holds by construction rather than by remembering.
- **`refuseUnsupported` checks them before refusing**, so a declared key is the
  view's business.

**Spell the key the way `KeyboardEvent.key` reports it** — `"Escape"`, not
`"Esc"`. A display-only spelling never matches, and the view then gets the
wrong message with nothing failing. There is a test for exactly that.

**The boundary is what makes this safe. App stays the data owner.**

| Stays in `App.svelte`                         | Moves into the view            |
| --------------------------------------------- | ------------------------------ |
| `items` and its two transactions              | Layout, rendering, hit-testing |
| Filter / sort / groupBy state and persistence | Zoom, pan, hover               |
| Selection state and rating mutations          | How selection is _displayed_   |
| Keyboard dispatch                             | View-specific keys, declared   |

A view **never touches `items`**. Six hand-copied feed-window guards caused
#35, #36 and #39; a seventh living inside a view would be the same bug wearing a
new name. A view needing whole-library data declares
`dataSource: "working-set"` and gets its own bounded, capped fetch.

### The rules

- **A view that cannot support an interaction DECLARES it** rather than
  silently swallowing the keystroke — `capabilities: { open, select, rate }`,
  all three explicit booleans, read by `refuseUnsupported()` before any rating
  or selection key acts.

  #155 originally specified this as a uniform `onOpen`/`onSelect`/`onRate`
  callback trio. That is **not** what shipped and the difference is worth
  stating: views get their own props from `viewProps` in `App.svelte` (the grid
  takes `ontileclick`/`ontoggleselect`/…, albums takes `onopenphoto`, People
  takes `onpick`/`onrename`/`onmerge`), because the three views act on
  genuinely different things — photos, albums, and people. What is uniform is
  the DECLARATION, which is the part that had to be, since it is what lets App
  answer a keystroke honestly. `navigation` and `capabilities.open` are
  declared but not yet read by anything; they are forward-declarations, not
  live contracts.

- **Do the registry first and alone**, with the grid extracted as its first
  client and no user-visible change. A bespoke second view guarantees the third
  re-derives all of it (#156, #157, #165, #223). ✅ The registry exists, so a
  new view is a registry entry plus a component and re-deriving any of this is
  a review comment rather than a judgement call. Note the "and alone" half held
  for the extraction COMMIT but not for the PR: #155 also shipped the switcher,
  the `V` key and the capability refusal, because a registry with no way to
  switch cannot be exercised as a user feature. A deliberate call, not an
  oversight — but do not cite this as precedent for bundling.
- **A view switcher is a keyboard affordance** and goes in
  `ui/src/lib/ShortcutsOverlay.svelte` in the same commit — see CLAUDE.md.

### What adding the third view actually cost (#223)

The registry's claim was that a new view is an entry plus a component. People
was the first real test of it, and the bill was:

|                           |                                                      |
| ------------------------- | ---------------------------------------------------- |
| `views/registry.js`       | one `PEOPLE` descriptor                              |
| `views/PeopleView.svelte` | the component                                        |
| `App.svelte`              | a `viewProps` case and a `WORKING_SET_LOADERS` entry |
| `ShortcutsOverlay.svelte` | one word in the `V` label                            |

**No new branch in App's markup, no second switcher, no re-derived boundary**,
and the conformance test covered the new view without being edited (it iterates
`VIEWS`). The one genuinely new thing was a _server_ capability the view needed
and nothing had: `GET /api/ml/faces/:id/crop`. The box had been stored since
faces shipped, with nothing able to turn it into pixels.

Its capabilities are `open/select/rate: false` — all three — and that is a real
declaration, not a shrug: People shows you PEOPLE, and `selected` indexes a
feed window it does not render, so a `3` here would rate a photo you cannot
see. That is the same bug the capability system was built for, now caught by a
third view rather than argued about.

### What adding the FOURTH view cost (#232)

People (#223) tested the registry's claim; the Face Map tested whether it held
a second time, with a view that is unlike the other three — it owns its own
viewport, draws to a canvas, and selects people rather than photos.

|                            |                                                      |
| -------------------------- | ---------------------------------------------------- |
| `views/registry.js`        | one `FACE_MAP` descriptor                            |
| `views/FaceMapView.svelte` | the component                                        |
| `scatter/`                 | a reusable canvas + four pure modules                |
| `App.svelte`               | a `viewProps` case and a `WORKING_SET_LOADERS` entry |
| `ShortcutsOverlay.svelte`  | one word in the `V` label                            |

Still no new branch in App's markup, no second switcher, and the conformance
test covered it without being edited. **The one genuinely new thing was the
`keys` field above** — the registry's first missing capability in four views,
and it was missing because nothing had yet needed to own a key.

Two things this view paid that People did not, both worth budgeting for next
time:

- **`navigation: "zoom"` stopped being a forward-declaration.** A view that
  owns its viewport must fill the column, hide its own overflow, and
  `preventDefault()` on wheel, or App's `.main-column` scrolls underneath while
  you try to zoom. That is a task, not a CSS afterthought.
- **A working-set view can need data AFTER entry.** Building a new projection
  is not view entry, so `WORKING_SET_LOADERS` does not cover it. The view emits
  `onrun`; **App** runs the job and fetches. A view that fetched its own data
  would be the boundary rotting in a new place.

### Three scales of pluggability

Two of the three exist. Naming them separately keeps the work from
colliding (`docs/superpowers/specs/2026-07-24-ml-signals-design.md` §7):

| Scale          | What swaps                  | Registry            | Status    |
| -------------- | --------------------------- | ------------------- | --------- |
| **View**       | the entire main area        | `views/registry.js` | exists ✅ |
| **Group band** | how one group's photos draw | `groupRenderers.js` | exists ✅ |
| **Tile**       | how one photo draws         | `tileRenderers.js`  | missing   |

---

## Reviewing against these

Three questions, and a "no" to any of them is a change request:

1. **Scope** — can the user run this on their selection, and does it say how
   many photos that is?
2. **Locus of control** — can they walk away, watch it from the main interface,
   and stop it? Does it say what happened when it ends?
3. **Placement** — does this show them photos? Then why is it in a panel?
