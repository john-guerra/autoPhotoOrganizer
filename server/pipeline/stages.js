/**
 * One source of truth for "which photos still need stage X".
 *
 * Phase 0 of the unified scan pipeline
 * (`docs/superpowers/specs/2026-07-31-unified-scan-pipeline-design.md` §1.4).
 * Ships alone, changes nothing a user can see, and exists because the pipeline
 * needs THREE consumers of each predicate — the worklist that fetches rows, the
 * count that drives a live scope control, and the cohort query that picks the
 * next slab — and a hand-copied second copy of a pending predicate is how one
 * copy silently drifts.
 *
 * That is not hypothetical here. `schema.js:444` already records a partial
 * index built against the metadata predicate, and the note beside it says what
 * happened when the two diverged: nothing failed loudly, the query just fell
 * back to a full table scan. The fix was one shared string, which is exactly
 * what this module generalises to the other three stages.
 *
 * ## Every predicate below is lifted VERBATIM
 *
 * Deliberately. Phase 0's whole value is that it can be reviewed as a
 * no-op: if a predicate is re-worded here, the guarantee "the scoped and
 * unscoped worklists can never disagree about what pending means" is being
 * re-established by argument rather than by construction. Improve them in a
 * later phase, one at a time, with a test that goes red.
 *
 * ## Named parameters, on purpose
 *
 * `@model` and `@faceModel` rather than `?`: the worklists bind named
 * parameters, and better-sqlite3 refuses a statement that mixes named and
 * positional. That constraint is why `resolveScope` turns a filter into ids
 * rather than splicing `buildFilter`'s SQL (#245), and it applies here too —
 * anything composing these fragments into a bigger query inherits it.
 */

/** Every kind of photo needs its metadata read. */
export const ELIGIBLE_META = "1";
/** Hashing likewise: it is bytes, not pixels. */
export const ELIGIBLE_HASH = "1";
/** RAW is skipped rather than failed — there is no decoder for it here. */
export const ELIGIBLE_EMBED = "photos.kind != 'raw'";
/** Faces are looked for in still images only, not video. */
export const ELIGIBLE_FACES = "photos.kind = 'image'";

/**
 * Metadata has never been read.
 *
 * Verbatim from `db/enrich.js`'s `PENDING_CONDITION`, minus its leading
 * `photos.stale = 0` — staleness is a property of the PHOTO, not of any one
 * stage, so every consumer here applies it once rather than four times.
 */
export const PENDING_META = `photos.width IS NULL
         OR (photos.kind = 'video' AND photos.video_codec IS NULL)
         OR photos.gps_checked = 0`;

/** No content hash, and we have not already tried and failed to read one. */
export const PENDING_HASH = `photos.content_hash IS NULL AND photos.hash_attempted = 0`;

/**
 * No vector for this model, and not a recorded failure for it.
 *
 * The second clause is what stops a poison file being retried on every sweep
 * forever; `clearEmbedFailures` is its escape hatch.
 */
export const PENDING_EMBED = `NOT EXISTS (
                SELECT 1 FROM photo_embeddings e
                 WHERE e.photo_id = photos.id AND e.model = @model)
          AND NOT EXISTS (
                SELECT 1 FROM ml_status s
                 WHERE s.photo_id = photos.id
                   AND s.stage = 'embed' AND s.model = @model
                   AND s.state = 'failed')`;

/**
 * This face model has never looked at this photo.
 *
 * Note it does NOT exclude failures the way embed does: any `ml_status` row for
 * the stage counts as "looked at", success or not. That asymmetry is real
 * shipped behaviour and is preserved rather than tidied — see the module note
 * about lifting verbatim.
 */
export const PENDING_FACES = `NOT EXISTS (
                SELECT 1 FROM ml_status s
                 WHERE s.photo_id = photos.id
                   AND s.stage = 'faces' AND s.model = @faceModel)`;

/**
 * The stages a photo is carried through, in pipeline order.
 *
 * `meta` and `hash` first because they need no model downloaded at all, and
 * dates are what make the grid usable. `embed` before `faces` only because it
 * is roughly an order of magnitude cheaper per photo — they are SIBLINGS, not
 * a dependency: `createFaceEngine` reads the original file with sharp and never
 * touches `photo_embeddings` (design §1.2, which corrects the intuitive
 * ordering).
 *
 * @type {ReadonlyArray<{id: string, label: string, eligible: string, pending: string}>}
 */
export const STAGES = Object.freeze([
  {
    id: "meta",
    label: "Reading metadata",
    eligible: ELIGIBLE_META,
    pending: PENDING_META,
  },
  {
    id: "hash",
    label: "Hashing",
    eligible: ELIGIBLE_HASH,
    pending: PENDING_HASH,
  },
  {
    id: "embed",
    label: "Embedding",
    eligible: ELIGIBLE_EMBED,
    pending: PENDING_EMBED,
  },
  {
    id: "faces",
    label: "Finding faces",
    eligible: ELIGIBLE_FACES,
    pending: PENDING_FACES,
  },
]);

/** @param {string} id */
export function stageById(id) {
  return STAGES.find((s) => s.id === id);
}

/**
 * `WHERE` body for "this photo still needs `stage`", staleness included.
 *
 * The one place the three consumers agree. A caller adds its own scope clause
 * and `LIMIT`; the eligibility and the pending test come from here so a
 * worklist and a count can never disagree about what they are talking about.
 *
 * @param {{eligible: string, pending: string}} stage
 * @returns {string}
 */
export function pendingWhere(stage) {
  // A trivially-true eligibility is OMITTED, not emitted as `AND (1)`, and
  // that is load-bearing rather than tidiness.
  //
  // `idx_photos_pending_meta` is a PARTIAL index whose WHERE is built from this
  // very string (schema.js), and SQLite only uses a partial index when it can
  // PROVE the query's WHERE is covered by the index's predicate. An extra
  // `AND (1)` defeated that proof: `queryPlan.test.js` went from an index
  // search to `SCAN photos` — 100k+ rows re-scanned on each of the ~2,000
  // batches a full sweep takes, with nothing failing and no error anywhere.
  // That is the exact trap schema.js's comment describes, reproduced by this
  // refactor and caught by that test.
  //
  // So the emitted text must stay byte-compatible with what the index was
  // built from. Run `queryPlan.test.js` after touching this — it is the only
  // thing that notices.
  const parts = ["photos.stale = 0"];
  if (stage.eligible !== "1") parts.push(`(${stage.eligible})`);
  parts.push(`(${stage.pending})`);
  return parts.join("\n    AND ");
}

/**
 * `WHERE` body for "pending in ANY of these stages" — the cohort query (§1.4).
 *
 * **Measured, and it is a full scan.** `scripts/benchmark.mjs` against 125,000
 * rows: 0.01 ms for the first cohort and **7.5 ms for the last**, plan
 * `SCAN photos`, exactly as `schema.js:453` predicted for an OR of this shape.
 * The two differ by 750× because `LIMIT` short-circuits while everything is
 * still pending — only the second number is the real cost. Projected over a
 * full run at ~57-photo cohorts (~2,200 of them) that is ≈16 s of query
 * overhead against hours of inference, which is why Phase 3 does not need a
 * composite index. Re-measure if the cohort size shrinks: the overhead is
 * linear in the number of cohorts.
 *
 * @param {ReadonlyArray<{eligible: string, pending: string}>} stages
 * @returns {string}
 */
export function pendingAnyWhere(stages) {
  if (!stages.length) return "0";
  const ors = stages
    .map((s) => `((${s.eligible}) AND (${s.pending}))`)
    .join("\n            OR ");
  return `photos.stale = 0
          AND ( ${ors} )`;
}
