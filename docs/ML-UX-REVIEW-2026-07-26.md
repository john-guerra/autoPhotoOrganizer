# Photo similarity — UX review, 2026-07-26

Written after John used the #162 build on his real 34,807-photo library and hit
five problems in about ten minutes. Every finding here comes from that session,
not from reading the code.

**Verdict: the machinery works and the experience does not.** The grouping is
measured and conservative (608 groups over 9,349 embedded photos, mean size
2.48, 456 of them plain pairs). But a user cannot tell that from the app.

---

## The root problem: the feature has no visible payoff

Everything else in this document is downstream of one thing.

The user's path today is: **turn on a toggle → wait ~20 minutes → nothing
happens.** Embedding produces no visible change whatsoever. The result only
appears after a _separate, differently-named_ action ("Find duplicates") which
lives somewhere else, and even then it manifests as stacks quietly becoming
larger — a change you would only notice if you had memorised the grid.

That is why John asked "how can I test it works". It is not a gap in his
understanding; the app genuinely never says.

Three symptoms of the same cause:

- **`Find similar: embed 12 selected` (#213).** The name promises the payoff
  ("find similar") and delivers the prerequisite ("embed"). I wrote this label,
  and it is the worst kind of wrong: it describes what the user wants rather
  than what the button does. Anchored "more like this" is #164 and does not
  exist.
- **Two menu entries side by side.** Both intentional (selection vs. loaded),
  but two near-identical lines read as a bug.
- **Nothing reports completion in the user's terms.** "9,349 embedded" is an
  implementation counter. "18 new duplicate groups found" is a result.

**Recommendation 1 — make embedding a step inside a goal, never a goal.**
There should be no user-facing action whose outcome is "vectors exist". Fold
embedding into the thing the user actually wants:

> **Find duplicates** → _"Needs to read 1,240 photos first (~50 s). Start?"_ →
> progress → _"Found 18 groups of near-identical photos."_

Embedding becomes a precondition the app handles and explains, the way a scan
already does. The ML panel keeps the raw controls for people who want them; the
grid gets one honest verb.

---

## Finding 2 — the read-outs go stale exactly when they matter (#214)

"Running on" only corrects after the sweep ends, because the panel refreshes
stats solely when a job _disappears_. The whole point of that line is to answer
"what is it running on **right now**", during the run.

Same shape as the device picker I had disabled during a sweep: state that is
interesting _while_ something happens, frozen _until_ it stops.

**Recommendation 2 — anything describing a running job updates while it runs.**
The jobs SSE stream already pushes progress; ride it rather than adding a poll.

---

## Finding 3 — the cost is never stated before it is spent (#215)

"Embed now" reads 34,807 photos and says nothing beforehand. The consent text
covers the _download_ (94 MB, stated well) but not the _work_ (~20 minutes).

This is the one place the panel breaks its own contract. It is scrupulous about
the model download and silent about the far larger cost.

**Recommendation 3 — a scope selector with an estimate, on the button.**

> Embed: ( ) Selected · 12 &nbsp; (•) Visible · 1,240 &nbsp; ( ) All · 34,807
> **~50 s** at 38 ms/photo on CPU

Per-photo cost is already measured per model and provider (#161). Scoping the
work is the difference between a feature you try and one you defer forever.

---

## Finding 4 — three near-identical controls in three places

"Find near-duplicates now" (ML panel), the ⧉ toolbar button, and the automatic
pass after an embed sweep all do the same thing, with different names and
different feedback. A user cannot tell whether they are three actions or one.

**Recommendation 4 — one verb, one place, one name.** Keep the toolbar control
(it is a view concern, correctly beside the burst gap). The panel should show
_state_ — how many groups exist, when it last ran — not a duplicate trigger.

---

## Finding 5 — the toolbar cannot take more controls

Adding two text buttons pushed the entire Group group into an overflow popover
at ~1130 px, breaking two e2e specs. Icons fixed the test, not the pressure:
that row is saturated, and the next addition will fold something again.

**Recommendation 5 — treat toolbar width as a budget with an owner.** Before
adding a control, decide what it displaces. A `toolbarWidth.spec.js` asserting
that the Group controls stay visible at a stated minimum width would turn this
from a recurring surprise into a rule.

---

## Finding 6 — a cancelled job reports as a failure

Stopping a sweep (or restarting the server) renders `✗ 1 failed` with
"Embedding stopped: canceled." A cancellation the user asked for is not a
failure, and dressing it as one teaches people to distrust the error channel.
Pre-existing #161 behaviour, surfaced by this work.

**Recommendation 6 — cancellation is an outcome, not an error.** `registry`
already distinguishes `canceled`; the embed path should stop routing it through
`fail()`.

---

## How to test that it works today

Until the above lands, the honest answer to "how do I know it worked":

1. **ML panel → counts.** "N embedded of M" must climb. That is the only
   evidence embedding is happening.
2. **ML panel → "N groups found — covering M photos".** This is the real result.
   Zero groups with a healthy embedded count means it ran and found nothing —
   which on a library of unrelated photos is _correct_, not broken.
3. **The grid.** Stack badges (`×3`) get larger where photos are near-identical.
   Compare with Burst switched off to see the difference the signal makes.
4. **Ground truth:** `sqlite3 ~/.autogallery/index.db "SELECT group_id,
COUNT(*) FROM near_dupe_groups GROUP BY group_id ORDER BY 2 DESC LIMIT 10"`.
   Healthy output is dominated by 2s and 3s. A single huge group means the
   threshold is too low for that library.

That step 4 exists at all is the strongest argument for Recommendation 1.

---

## Priority

1. **#213** — the misleading label is actively deceiving. Cheapest fix, highest
   trust cost.
2. **#215** + **Recommendation 1** — scope, estimate, and folding embedding into
   a goal. This is the substantive redesign.
3. **#214** — live read-outs.
4. **#212** — "Keep only" lost on refresh. Unrelated to ML, but it is a working
   set the user built by hand and the app silently discards.
5. Findings 4–6 — consolidation, toolbar budget, cancellation semantics.
