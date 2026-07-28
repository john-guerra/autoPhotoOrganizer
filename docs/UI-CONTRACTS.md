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

The three scopes, always in this order, always with a live count:

| Scope        | Means                                    | Server shape         |
| ------------ | ---------------------------------------- | -------------------- |
| **All**      | everything the operation still has to do | no `ids` — the sweep |
| **Visible**  | what the current filter/view is showing  | `ids: visibleIds`    |
| **Selected** | the user's selection                     | `ids: selectedIds`   |

The reference implementation is `ui/src/lib/MlSettings.svelte` (`scopes`,
`scopeIds`, and the `data-testid="ml-scope"` fieldset), shipped as #215/#206.
Read it before writing a second one.

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
the library. That is #221.

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
one. `POST /api/ml/faces` has the right shape; `POST /api/ml/faces/cluster` does
not (#222).

---

## 3. Views — browsing is the main area's job, panels are for settings

**If a feature shows you your photos, or acts on them, it belongs in the main
area.** The settings panel holds settings: what model, download it, the licence,
forget everything.

The dividing question is not "is it about ML" — it is **"would the user expect
to select, rate, or open a photo from here?"** If yes, it is a view.

| Belongs in the main area                    | Belongs in a settings panel        |
| ------------------------------------------- | ---------------------------------- |
| Browsing and naming people                  | Which face model, and download it  |
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

- **Every view gets the same callbacks** — `onOpen`, `onSelect`, `onRate` — so
  rating, selection and the loupe keep working everywhere. A view that cannot
  support one **declares** it rather than silently swallowing the keystroke.
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

### Three scales of pluggability

Only the middle one exists. Naming them separately keeps the work from
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
