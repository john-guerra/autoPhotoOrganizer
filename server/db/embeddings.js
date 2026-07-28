/**
 * The embeddings data layer (#161).
 *
 * Everything here is keyed by MODEL as well as photo. Vectors from different
 * models are not comparable — different dimensionality, different space — so
 * "how many are embedded" is only ever a question about one model, and mixing
 * them in a similarity scan would produce confident nonsense.
 */

// The id-scope validator is SHARED with the faces sweep (#221) rather than
// living here: it is what makes inlining ids into SQL safe, and a second copy
// of that is how one copy drifts.
import { normalizeScope } from "./scopeIds.js";

/** The sweep stage name recorded in ml_status. Faces (#166) will add its own. */
export const EMBED_STAGE = "embed";

/**
 * Write one vector AND clear any failure sentinel for the same photo+model, in
 * one transaction. A successful vector makes a "cannot be processed" sentinel
 * a lie — without this, a future retry-failed-embeds action would call this,
 * the sentinel would survive, and embedCounts would double-count the photo as
 * both embedded AND failed (#161 fix round 2, I2). That's the same
 * "unexplained shortfall" shape pre-2.17.14 backupCoverage shipped: a UI
 * computing pending as total - embedded - failed would go negative.
 * @param {import("better-sqlite3").Database} db
 * @param {{photoId: number, model: string, dim: number, scale: number, bytes: Int8Array}} row
 */
export function putEmbedding(db, row) {
  txPutEmbedding(db)(row);
}

/**
 * One transaction for a whole batch. better-sqlite3 transactions are
 * synchronous by contract, which is exactly what makes them crash-safe: a
 * half-written batch is impossible.
 *
 * Calls putEmbedding per row, which is ITSELF a `db.transaction()` (see
 * txPutEmbedding below) — better-sqlite3 supports this nesting via SAVEPOINTs
 * (verified empirically: an inner transaction function invoked from inside an
 * outer one participates in the outer's commit/rollback rather than starting
 * an independent one), so a failure partway through the batch still rolls
 * back everything written so far, including the sentinel clears.
 * @param {import("better-sqlite3").Database} db
 * @param {Array<{photoId: number, model: string, dim: number, scale: number, bytes: Int8Array}>} rows
 */
export function putEmbeddings(db, rows) {
  db.transaction((batch) => {
    for (const r of batch) putEmbedding(db, r);
  })(rows);
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {number} photoId
 * @param {string} model
 * @returns {{dim: number, scale: number, bytes: Int8Array}|null}
 */
export function getEmbedding(db, photoId, model) {
  const row = db
    .prepare(
      `SELECT dim, scale, vec FROM photo_embeddings
        WHERE photo_id = ? AND model = ?`
    )
    .get(photoId, model);
  if (!row) return null;
  return {
    dim: row.dim,
    scale: row.scale,
    bytes: new Int8Array(
      row.vec.buffer,
      row.vec.byteOffset,
      row.vec.byteLength
    ),
  };
}

/**
 * The embed worklist: photos with no vector for this model and no failure
 * sentinel for it. Re-queried every batch, so it is the worklist AND the resume
 * point — a crash costs one batch, not the backlog.
 *
 * `stale = 0` mirrors pendingHashRows: a row whose file vanished at the last
 * scan must not be swept.
 *
 * `kind != 'raw'` because there is no image here to embed. The sweep's input
 * is the 320px cached thumbnail (server/ml/thumbSource.js), and the only way
 * to make one is `processing.thumbnail()`, which throws
 * RawDecodeUnavailableError for RAW BY DESIGN — no RAW decoder is wired up
 * (CLAUDE.md, "Performance thesis"; the embedded-preview path was never
 * built). Offering a RAW row would therefore hand every single one of them a
 * permanent "tried, and could not be read" sentinel — and sentinels only
 * clear when the file's bytes change, so they would outlive the eventual RAW
 * decoder too. Skipping is the honest answer, and embedCounts below leaves
 * them out of `total` for the same reason, so "not computed yet" can still
 * reach zero. The day RAW gains a preview path, delete this clause and the
 * backlog embeds itself with no migration.
 *
 * `s.state = 'failed'` is deliberate rather than incidental: today `failed`
 * is the only state markEmbedFailed writes, so this changes nothing — but a
 * future non-terminal state (`queued`, say, for #169's shape) written without
 * it would silently exclude that photo from the worklist forever.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @param {number} limit
 * @returns {Array<{id: number, folder_abs_path: string, filename: string, mtime: number, size: number, kind: string}>}
 */
export function pendingEmbedRows(db, model, limit, scopeIds = null) {
  // #206: a scope restricts the worklist to specific photos, so the user can
  // embed the shoot they are culling right now instead of waiting out a
  // 34,807-photo library. Built as an extra WHERE clause on the SAME query
  // rather than a second one, so the scoped and unscoped worklists can never
  // disagree about what "pending" means — the RAW exclusion and both
  // anti-joins apply identically either way.
  //
  // Inlined as a literal id list because SQLite has no array parameter and
  // this is called once per batch. Every id is coerced through Number and
  // filtered to finite integers first: they arrive from a request body, and
  // string-concatenating an unvalidated value into SQL is the injection this
  // codebase already guards against elsewhere (safeResolve, for paths).
  const ids = normalizeScope(scopeIds);
  // An explicitly EMPTY scope means "these zero photos", never "all of them".
  // Falling through to the unscoped query here would turn a caller's empty
  // selection into a full-library sweep — the most expensive possible way to
  // misread an empty array.
  if (ids !== null && ids.length === 0) return [];
  const scopeClause = ids ? `AND photos.id IN (${ids.join(",")})` : "";
  return db
    .prepare(
      `SELECT photos.id, photos.filename, photos.mtime, photos.size, photos.kind,
              folders.abs_path AS folder_abs_path
         FROM photos
         JOIN folders ON folders.id = photos.folder_id
        WHERE photos.stale = 0
          AND photos.kind != 'raw'
          ${scopeClause}
          AND NOT EXISTS (
                SELECT 1 FROM photo_embeddings e
                 WHERE e.photo_id = photos.id AND e.model = @model)
          AND NOT EXISTS (
                SELECT 1 FROM ml_status s
                 WHERE s.photo_id = photos.id
                   AND s.stage = @stage AND s.model = @model
                   AND s.state = 'failed')
        LIMIT @limit`
    )
    .all({ model, stage: EMBED_STAGE, limit });
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @returns {{total: number, embedded: number, failed: number}} pending is
 *   total - embedded - failed, and the UI must show it as such: "not computed
 *   yet" and "cannot be computed" are different answers to the user.
 *
 * All three exclude `kind = 'raw'`, matching pendingEmbedRows — a RAW file is
 * not embeddable at all today, so counting it in `total` would leave a
 * permanent remainder in "not computed yet" that no sweep could ever close.
 * The settings panel says RAW is skipped rather than leaving the user to
 * infer it from a number that never moves.
 */
export function embedCounts(db, model) {
  const total = db
    .prepare(
      `SELECT COUNT(*) AS n FROM photos WHERE stale = 0 AND kind != 'raw'`
    )
    .get().n;
  const embedded = db
    .prepare(
      `SELECT COUNT(*) AS n FROM photo_embeddings e
         JOIN photos p ON p.id = e.photo_id
        WHERE e.model = ? AND p.stale = 0 AND p.kind != 'raw'`
    )
    .get(model).n;
  const failed = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ml_status s
         JOIN photos p ON p.id = s.photo_id
        WHERE s.stage = ? AND s.model = ? AND p.stale = 0 AND p.kind != 'raw'`
    )
    .get(EMBED_STAGE, model).n;
  return { total, embedded, failed };
}

/**
 * The sentinel WRITE. runSweep owns the CLASSIFICATION (it only calls this for
 * failures it has already judged permanent — a missing folder or a transient
 * errno pauses the sweep and marks nothing, which is #169's lesson).
 *
 * This row is what removes the photo from pendingEmbedRows, which is the only
 * reason the sweep terminates. runSweep's stall guard throws loudly if it
 * doesn't.
 *
 * MUST NOT THROW for a photo that no longer exists. `nextBatch()` runs
 * synchronously but `process()` then yields for seconds (thumbnail work plus
 * an inference round-trip), and a user can hard-delete photos in that window
 * (folder removal, deletePhotosByIds, resetLibrary, relocateMissing all
 * DELETE FROM photos, and are all user-triggered mid-sweep). The write this
 * function makes is an INSERT, unlike hashing's sentinel (an UPDATE, which
 * silently affects zero rows for a vanished parent) — an unguarded INSERT
 * referencing a photo_id that just disappeared throws
 * SQLITE_CONSTRAINT_FOREIGNKEY, and runSweep does not wrap this call in
 * try/catch (sweep.js), so that throw would escape the per-row retry loop
 * entirely and reject the whole sweep with an opaque SQLite error — exactly
 * the generic, non-actionable failure CLAUDE.md's Usability section forbids.
 * The `WHERE EXISTS` guard makes the INSERT a no-op instead: a photo that no
 * longer exists needs no sentinel, because it is already out of the worklist
 * (pendingEmbedRows joins against `photos`, so a deleted photo can never come
 * back from nextBatch() regardless of whether a sentinel was written for it).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {number} photoId
 * @param {string} model
 * @param {Error} error
 */
export function markEmbedFailed(db, photoId, model, error) {
  db.prepare(
    `INSERT INTO ml_status (photo_id, stage, model, state, attempts, error, updated_at)
     SELECT @photoId, @stage, @model, 'failed', 1, @error, @now
      WHERE EXISTS (SELECT 1 FROM photos WHERE id = @photoId)
     ON CONFLICT(photo_id, stage, model) DO UPDATE SET
       attempts = ml_status.attempts + 1,
       error = excluded.error,
       updated_at = excluded.updated_at`
  ).run({
    photoId,
    stage: EMBED_STAGE,
    model,
    error: String(error?.message ?? error).slice(0, 500),
    now: Date.now(),
  });
}

/**
 * Clear every failure sentinel for one model, putting those photos back in
 * the worklist. The vectors are NOT touched — this retries what failed, it
 * does not undo what worked.
 *
 * THE ONLY CONTROL IN THE APP THAT CAN TAKE A SENTINEL BACK when no vector
 * exists (#161 final review, Critical 1). The three other things that clear
 * one all need something else to be true first: clearMlArtifactsFor needs the
 * file's bytes to change, ON DELETE CASCADE needs the photo deleted, and
 * purgeModel is only reachable from the settings panel's Purge button, which
 * is rendered per row of `modelStorage` — a GROUP BY over photo_embeddings.
 * So in the exact case that matters most, a sweep that failed EVERYTHING and
 * wrote no vectors at all, there was no Purge button to press and no way
 * back short of deleting index.db, which also destroys ratings, keep-scope,
 * manual stacks and album names.
 *
 * MUST NOT run while a sweep is in flight: runSweep tracks the ids it marked
 * this pass and throws if one comes back from nextBatch(). The route
 * (POST /api/ml/retry-failed) refuses with a 409 in that case, and the panel
 * disables the button.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @returns {{cleared: number}}
 */
export function clearEmbedFailures(db, model) {
  const { changes } = db
    .prepare(`DELETE FROM ml_status WHERE stage = ? AND model = ?`)
    .run(EMBED_STAGE, model);
  return { cleared: changes };
}

/**
 * EVERY per-photo ML artifact table, in one list.
 *
 * It is a list rather than three inlined DELETEs so that adding a fourth
 * artifact is one obvious line in one obvious place. The alternative — a
 * caller remembering to clear each table — is the shape that produced six
 * hand-copied feed guards and two shipped bugs (#35, #36, #39). A forgotten
 * entry here fails the same way: silently, and only for photos whose bytes
 * changed, which is the case nobody tests by hand.
 */
export const ML_ARTIFACT_TABLES = Object.freeze([
  "photo_embeddings",
  "ml_status",
  // #166. Faces are per-face rows rather than one per photo, but the
  // invalidation question is identical: an edited photo that keeps its old
  // faces keeps them forever, because the worklist only asks whether faces
  // EXIST for a photo, never whether they still describe the current bytes.
  "photo_faces",
]);

/**
 * Drop every ML artifact for these photos, across ALL models.
 *
 * Called from upsertScan when a file's size or mtime changed. Without it an
 * edited photo keeps a stale vector forever: nothing else would ever notice,
 * because the worklist only asks whether a vector EXISTS, not whether it still
 * describes the current bytes.
 *
 * Named for artifacts rather than embeddings because it has cleared more than
 * embeddings since it was written — `ml_status` from the start, and faces since
 * #166. The old name said "embeddings" while the doc directly above it said
 * "every ML artifact", and a name that disagrees with its own docstring is how
 * the next person adds a table and clears nothing.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {number[]} photoIds
 */
export function clearMlArtifactsFor(db, photoIds) {
  if (!photoIds.length) return;
  // Chunked: SQLite's default SQLITE_MAX_VARIABLE_NUMBER is 32766, and a rescan
  // of a large folder where every file changed would blow straight past it.
  const CHUNK = 500;
  for (let i = 0; i < photoIds.length; i += CHUNK) {
    const chunk = photoIds.slice(i, i + CHUNK);
    const holes = chunk.map(() => "?").join(",");
    for (const table of ML_ARTIFACT_TABLES) {
      db.prepare(`DELETE FROM ${table} WHERE photo_id IN (${holes})`).run(
        ...chunk
      );
    }
  }
}

/**
 * Per-model vector storage, so the settings panel can show what each model
 * costs and offer a targeted purge. Dormant models are KEPT by design —
 * switching back after an A/B comparison is then free.
 * @param {import("better-sqlite3").Database} db
 * @returns {Array<{model: string, rows: number, bytes: number}>}
 */
export function modelStorage(db) {
  return db
    .prepare(
      `SELECT model, COUNT(*) AS rows, COALESCE(SUM(LENGTH(vec)), 0) AS bytes
         FROM photo_embeddings GROUP BY model ORDER BY model`
    )
    .all();
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @returns {{rows: number}}
 */
export function purgeModel(db, model) {
  const tx = db.transaction((m) => {
    const { changes } = db
      .prepare(`DELETE FROM photo_embeddings WHERE model = ?`)
      .run(m);
    db.prepare(`DELETE FROM ml_status WHERE stage = ? AND model = ?`).run(
      EMBED_STAGE,
      m
    );
    return changes;
  });
  return { rows: tx(model) };
}

/** Prepared once per database handle — better-sqlite3 caches the plan. */
let putCache = new WeakMap();
function stmtPut(db) {
  let s = putCache.get(db);
  if (!s) {
    s = db.prepare(
      `INSERT INTO photo_embeddings (photo_id, model, dim, scale, vec, created_at)
       VALUES (@photoId, @model, @dim, @scale, @vec, @createdAt)
       ON CONFLICT(photo_id, model) DO UPDATE SET
         dim = excluded.dim,
         scale = excluded.scale,
         vec = excluded.vec,
         created_at = excluded.created_at`
    );
    putCache.set(db, s);
  }
  return s;
}

/** Prepared once per database handle. The other half of putEmbedding's
 * transaction: drop the failure sentinel for this exact photo+model, since a
 * fresh vector just proved it is no longer "cannot be processed". */
let clearSentinelCache = new WeakMap();
function stmtClearSentinel(db) {
  let s = clearSentinelCache.get(db);
  if (!s) {
    s = db.prepare(
      `DELETE FROM ml_status WHERE photo_id = @photoId AND stage = @stage AND model = @model`
    );
    clearSentinelCache.set(db, s);
  }
  return s;
}

/** Prepared once per database handle: the transaction function itself, not
 * just a statement — db.transaction() wraps a JS function in BEGIN/COMMIT (or
 * a SAVEPOINT when nested inside another transaction, as putEmbeddings does),
 * so caching it avoids re-wrapping on every call while keeping the write and
 * the sentinel-clear atomic. */
let txPutCache = new WeakMap();
function txPutEmbedding(db) {
  let tx = txPutCache.get(db);
  if (!tx) {
    tx = db.transaction((row) => {
      stmtPut(db).run({
        photoId: row.photoId,
        model: row.model,
        dim: row.dim,
        scale: row.scale,
        // Int8Array -> Buffer WITHOUT copying the underlying bytes. The three-
        // argument form (byteOffset/byteLength) is required for correctness IF
        // a caller ever hands in a typed-array VIEW into a larger buffer —
        // Buffer.from(view.buffer) alone would then store the WHOLE backing
        // buffer instead of just this row's slice. Today's only caller is
        // quantize() (server/ml/quantize.js), which always allocates a fresh,
        // exactly-sized Int8Array per call, so byteOffset is always 0 and
        // byteLength always equals the buffer's own length — there is no view
        // to worry about yet. Kept anyway: it costs nothing here and stays
        // correct the day a caller (e.g. a batched tensor sliced per image)
        // changes that.
        vec: Buffer.from(
          row.bytes.buffer,
          row.bytes.byteOffset,
          row.bytes.byteLength
        ),
        createdAt: Date.now(),
      });
      stmtClearSentinel(db).run({
        photoId: row.photoId,
        stage: EMBED_STAGE,
        model: row.model,
      });
    });
    txPutCache.set(db, tx);
  }
  return tx;
}
