# Near-duplicate detection → burst stacks — design (#162)

**Status:** approved 2026-07-26. Supersedes the open questions left in #162 and
in `2026-07-24-ml-signals-design.md` §6.

**Goal:** photos that are the _same shot_ — three frames apart, or re-shot from a
slightly different position — stack together even when the plain time gap would
have split them. Built on the embeddings shipped in #161.

## The shape, in one sentence

**Semantic similarity becomes a third disjunct in the existing burst walk**, not
a new kind of stack.

`ui/src/lib/bursts.js:39-41` already merges two consecutive photos when _either_
of two independent signals says so:

```js
const withinGap = cur.time - prev.time <= gapMs;
const sameBurst = prev.burstKey !== null && prev.burstKey === cur.burstKey;
if (withinGap || sameBurst) { … }
```

`sameBurst` is a filename-prefix hard link for Pixel burst sequences whose
timestamps land wider apart than `gapMs`. The burst-detection design already
frames it as "a supporting signal, not a competing gate". **Near-duplicate
similarity is a third signal of exactly that shape**, and it lands as one more
disjunct:

```js
const sameDupeGroup = prev.dupeGroup != null && prev.dupeGroup === cur.dupeGroup;
if (withinGap || sameBurst || sameDupeGroup) { … }
```

Everything downstream — cover selection, stack identity, positioning under a
non-date sort, `applyStackOverrides`, expand/collapse, the manual-stack and
`keepSeparate` overrides — is untouched and already correct.

## Three decisions, and why

### 1. Suggestions are time-windowed (ruled 2026-07-25, recorded on #162)

A group is only ever proposed among photos taken close together. The measured
data is why:

| relation                       | SigLIP    | CLIP      |
| ------------------------------ | --------- | --------- |
| burst pair (same moment)       | 0.9608    | 0.9657    |
| same scene, re-framed          | 0.9326    | 0.8854    |
| two _different_ outdoor scenes | 0.6071    | 0.6771    |
| vs. an unrelated subject       | 0.50–0.56 | 0.41–0.52 |

"Unrelated" is not one number. Two photographs that merely share a genre sit at
0.61–0.68 — far above the 0.41–0.56 of wholly different subjects. A single
global cutoff tuned on obviously-different photos therefore surfaces false
duplicates on a library full of one genre, which is what a travel archive _is_.
The time window is what keeps the cutoff honest.

**Accepted cost:** the same scene re-shot months later is not proposed.

### 2. Computed server-side, precomputed by a sweep

The alternative — shipping int8 vectors to the browser and clustering live —
buys an instant threshold slider at ~380KB of vectors per feed page, and can
only ever see the loaded window. The sweep wins on both counts, and matches the
architecture `hashAllPending` / `embedAllPending` already established.

**Consequence to accept honestly:** the threshold is a _setting_ that triggers a
re-sweep, not a live slider. The existing `burstGapMs` slider keeps working
instantly and is unaffected.

### 3. Grouping is enforced by the client, for free

The server has no idea what the user is grouping by — `groupBy` is a live client
concern. So the sweep emits links based on **time proximity and similarity
only**, with no group awareness, and `detectBurstsByGroup` (`bursts.js:99`)
partitions items by the active `groupBy` _before_ `detectBursts` ever sees them.

The within-group constraint therefore costs nothing and falls out of existing
code. It also behaves correctly when the user changes grouping: grouped by
folder, a cross-folder pair stays split; grouped by date, the same pair merges.

**This also retires the bug that forced the partitioning.** `detectBurstsByGroup`
exists because two unrelated folders with identical timestamp sequences
(`fotos_peq/2002/..._comida_peq` and `..._grado_Edwin_peq`) silently merged into
one cross-folder burst. The similarity gate rejects precisely that pair — they
score ~0.5. The partitioning stays regardless, because it is still right under a
folder grouping.

## Data model

A new table, never a column on `photos` — the feed's hot path is a keyset seek
over `SELECT photos.*`, and #161 already established that ML artifacts live
apart:

```sql
CREATE TABLE IF NOT EXISTS near_dupe_groups (
  photo_id INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL,
  model    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_near_dupe_group ON near_dupe_groups(model, group_id);
```

`ON DELETE CASCADE` is mandatory, not optional: better-sqlite3 enables
`PRAGMA foreign_keys` by default, and omitting it is what broke every
`DELETE FROM photos` path in #161 (schema.js:225). A plain `REFERENCES` here
would reproduce that bug exactly.

**Migration note:** `user_version = 2`'s `DROP TABLE` is explicitly a one-off
that must not be copied — see the comment at `schema.js:236`. This table is
created fresh with the cascade already in place, so it needs no migration.

### The dead column

`photos.perceptual_hash` (`schema.js:33`) is declared and referenced nowhere
else. The issue asks for a ruling: **drop it.** Embeddings answer the question
it was carved for, and a column that looks like a feature but holds nothing is
how `content_hash` misled for two releases.

## The sweep

`server/ml/nearDupeSweep.js`. Deliberately **not** built on `runSweep`:
`runSweep`'s worklist/poison-file/`folderOf` machinery exists to isolate a bad
_file_, and this pass never touches the filesystem — it is pure SQLite plus
arithmetic over vectors already stored. It keeps the two things it does need:
idle gating (`whenIdle`) and cancellation.

Algorithm, one pass over the library in effective-capture-time order
(`COALESCE(taken_at, …, mtime)` — the same expression the feed's generated
indexes use; **do not** hand-write a variant, see `AGENT-NOTES.md`):

1. Walk photos in time order, maintaining a window of those within
   `windowMs` of the current photo.
2. For each pair in the window, cosine via the int8 dot product already in
   `server/ml/quantize.js` (`dot(a,b) * scaleA * scaleB` — vectors are
   L2-normalized _before_ quantizing, so this is exact).
3. Union pairs scoring ≥ the model's threshold.
4. Write connected components with ≥2 members to `near_dupe_groups`.

Comparing against the whole window rather than only the next photo matters: a
burst with one intruding frame would otherwise break the chain.

Cost is bounded by the window, not the library: at a 60s window a typical
photo has a handful of neighbours, so this is ~O(n) in practice over 114k rows.

### Threshold lives per-model

In `server/ml/models.js`, beside `dim` and `dtype` — **not** as one global
constant. The measured numbers differ by ~0.05 between the two shipping models,
and a single constant would be right for at most one of them:

- `Xenova/siglip-base-patch16-224` → `0.93`
- `Xenova/clip-vit-base-patch32` → `0.88`

Both sit above the re-framed pair and far above the shared-genre band, i.e.
deliberately conservative: a missed duplicate is invisible, a false merge hides
a photo.

### Window default

`windowMs` defaults to **60_000** — twenty times the `DEFAULT_BURST_GAP_MS` of
3000, so it genuinely extends reach, while staying far short of "a different
part of the afternoon". Tunable in ML settings alongside the threshold.

## Reaching the feed

One field, following `manualStackId`'s existing pattern exactly
(`server/db/feed.js:618`) — a correlated subquery per row, no new feed path:

```sql
(SELECT group_id FROM near_dupe_groups WHERE photo_id = photos.id) AS dupeGroupId
```

and `rowToItem` (`feed.js:330`) gains `dupeGroupId: r.dupeGroupId ?? null`.

**This is the one hard constraint from `ml-signals-design.md` §5** — anything
reaching the feed must ride the existing window query rather than opening a
second path. It does.

## Failure and feedback (never fail silently)

- Embeddings absent (feature off, or sweep incomplete) → `dupeGroupId` is null
  everywhere and burst detection behaves **exactly** as it does today. This is
  the default state and must stay a no-op, not a degraded one.
- The sweep runs through the JobsPanel like every other long operation, with
  progress and a completion count.
- Changing the threshold or window invalidates and re-runs the pass, and says so
  before starting — it is not free on a large library.
- Rejecting a proposed grouping needs no new concept: `keepSeparate` already
  dissolves a photo out of any stack durably, and a manual stack already
  overrides detection. Both survive rescans today.

## Testing

- **vitest, `ui/src/lib/bursts.test.js`** — the disjunct: two photos beyond
  `gapMs` sharing a `dupeGroup` stack; beyond `gapMs` with _different_ groups do
  not; a null `dupeGroup` reproduces today's behaviour byte for byte (the
  no-op guarantee).
- **vitest, `server/ml/nearDupeSweep.test.js`** — windowing (a similar pair
  outside `windowMs` is not linked), transitivity through the window, the
  ≥2-member filter, and threshold boundaries, over synthetic vectors.
- **vitest, schema** — a `DELETE FROM photos` with a `near_dupe_groups` row
  present succeeds. This is the #161 regression, and it is the whole reason the
  cascade is specified above.
- **ML_INTEGRATION, extending `embeddingSimilarity.test.js`'s fixtures** — the
  measured thresholds actually separate the burst pair and the re-framed pair
  from the unrelated subject. The fixture set already carries all three roles.
- **e2e** — not warranted. The behaviour is pure-function grouping, provable at
  the vitest tier, and `CLAUDE.md` says not to test in the browser what a unit
  test can prove.

## Out of scope (deliberately)

- Cross-folder / cross-volume duplicate _review_ (the acceptance criterion this
  design does not meet). A stack spanning two folders cannot render in a
  folder-grouped feed; it needs its own review surface. Tracked separately —
  this remains #12/#86 territory for byte-identical copies.
- Anchored "more like this" from the loupe (#164) and semantic clusters as a
  group dimension (#163). Different shapes, different issues.
- Any new keyboard shortcut. Nothing here adds one, so `ShortcutsOverlay.svelte`
  is untouched — the acceptance criterion is met vacuously.
