# Validation pass — ten ML issues awaiting sign-off

Ten issues carry `needs-validation`. That label exists because merging must not
close an issue out from under you: you check it by hand, then close it. Nobody
else can do that step, which is the point of it.

This turns ten context-switches into one sitting. **Suggested order is by
shared setup, not by issue number** — the first four share one state, the next
three share another.

```bash
git checkout testing && git pull
npm run dev          # NOT piped to head/tail — that orphans the server
```

Then check the **version in the title bar against `package.json`**. A stale Vite
server from an earlier session serves the version it was started with and will
happily show you old code with no error anywhere (`docs/AGENT-NOTES.md`).

Close what passes. For anything that fails, the issue is already open — add
what you saw.

---

## Group A — the embedding sweep (#215, #206, #208, #213)

One setup: open **gear → Machine learning** with embeddings not yet complete.

### #215 — scope selector and a time estimate, not just "Embed now"

- [ ] The panel offers a **scope** — all / selected / visible — rather than one
      library-wide button.
- [ ] It states an **estimate** before you commit ("about N minutes"), and that
      estimate is in the right ballpark when you run it.
- [ ] Switching scope changes the count and the estimate together.

**Watch for:** an estimate that is confidently wrong. It is built from a
measured ms-per-photo, and a wrong one is worse than none — you would plan
around it.

### #206 — embed a selection, the current view, or one folder

- [ ] Select ~20 photos → embed the selection → only those are processed.
- [ ] Right-click a folder → the same, scoped to that folder.
- [ ] An **empty selection** says so specifically rather than silently
      embedding the whole library. (This is the failure that would cost an
      hour of CPU.)

### #208 — progress bar was "dancing" when the total is known

- [ ] Start a sweep. The bar **fills proportionally** — it does not sit
      indeterminate while a real total exists.
- [ ] The number shown matches the scope you chose, not the whole library.

### #213 — "Find similar" in the right-click menu did not find similar photos

- [ ] Right-click a photo. Whatever the similarity entry is now called, it does
      what it says — it does **not** silently kick off an embedding sweep.
- [ ] If it cannot act yet (no embeddings), it says so and points at the fix.

---

## Group B — near-duplicates and bursts (#162, #211, #207, #216)

Setup: embeddings computed for at least one folder with real burst sequences.
The Canon SD card set is the one to use.

### #162 — near-duplicate detection → suggested burst stacks

- [ ] Running it produces stacks of genuinely near-identical frames.
- [ ] Nothing is **moved or deleted** — it suggests, never acts. (This is the
      invariant; everything else is taste.)
- [ ] Re-running replaces the grouping rather than accumulating duplicates.

### #211 — Find duplicates on a selection

- [ ] With photos selected, the result is phrased about **your selection**
      ("N groups among your 40 selected photos"), not library-wide.
- [ ] With nothing selected, it still answers library-wide.
- [ ] The message survives — it must not be overwritten a beat later by
      "N photos loaded". (That exact bug shipped twice; it is why the
      persistent notice channel exists.)

### #207 — near-duplicate and burst controls belong in the toolbar

- [ ] The controls sit **beside Burst by time**, not buried in a panel.
- [ ] Narrow the window until the toolbar folds. Nothing important disappears
      without going into the overflow popover.

**Watch for:** this toolbar folds by WIDTH. Two extra controls once pushed the
whole Group group into overflow at ordinary window sizes.

### #216 — similarity should split wrong bursts

- [ ] A time-adjacent run of genuinely different shots is **split** rather than
      stacked together.
- [ ] The refiner threshold slider changes the result live.
- [ ] ⚠️ **The badge for stacks only similarity found was never built.** Half of
      this issue shipped; the other half is unclaimed. Validate the split
      behaviour and leave the issue open for the badge, or split it in two.

---

## Group C — standalone (#164, #203)

### #164 — open-vocabulary scene tags

- [ ] gear → Machine learning → the search box at the top. Type "a photo of a
      beach". Results look like beaches.
- [ ] Drag the cut, then **Show these in the grid** — the feed narrows to them.
- [ ] **Save as tag**, close the panel, and the tag appears in the toolbar's
      Tag picker with a count.
- [ ] Delete that tag while filtered by it: the grid comes back and a message
      explains why.

**Known and not a bug:** the first search on a phrase shows ~40 blank tiles for
about 10 s while thumbnails render cold. The main grid behaves identically. It
reads as broken; say if it bothers you and it can borrow `SnapshotThumb`'s
placeholder treatment.

**Also worth deciding:** search lives only in the Machine learning _panel_, not
in the copy of MlSettings embedded in Manage library.

### #203 — ML child process spawns from a PACKAGED Electron build

This one **cannot be validated with `npm run dev`** — that is the whole point of
the issue. It needs a real packaged app, because the failure mode is ASAR
packaging, which does not exist in a dev tree.

```bash
npm run electron:build:mac
```

- [ ] Launch the packaged app (not the dev server).
- [ ] gear → Machine learning → run a short embed.
- [ ] It actually embeds. The child spawns, `onnxruntime-node` loads from
      outside the ASAR, and the panel reports real progress.

---

## After the pass

Close what passed. `testing` → `main` when you are satisfied, then tag `v*` —
that tag is what `release.yml` builds, and it is the only step that reaches a
user.

Whatever fails, comment on its issue with what you saw; the branch and the
tests are still there to work from.
