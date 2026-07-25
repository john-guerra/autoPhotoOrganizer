/**
 * The embeddings data layer (#161).
 *
 * Everything here is keyed by MODEL as well as photo. Vectors from different
 * models are not comparable — different dimensionality, different space — so
 * "how many are embedded" is only ever a question about one model, and mixing
 * them in a similarity scan would produce confident nonsense.
 */

/** The sweep stage name recorded in ml_status. Faces (#166) will add its own. */
export const EMBED_STAGE = "embed";

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{photoId: number, model: string, dim: number, scale: number, bytes: Int8Array}} row
 */
export function putEmbedding(db, row) {
  stmtPut(db).run({
    photoId: row.photoId,
    model: row.model,
    dim: row.dim,
    scale: row.scale,
    // Int8Array -> Buffer WITHOUT copying the underlying bytes. Note the
    // byteOffset/byteLength arguments: a typed array can be a VIEW into a
    // larger buffer (transformers.js hands back exactly that, one big tensor
    // sliced per image), and Buffer.from(view.buffer) alone would store the
    // WHOLE tensor for every photo.
    vec: Buffer.from(
      row.bytes.buffer,
      row.bytes.byteOffset,
      row.bytes.byteLength
    ),
    createdAt: Date.now(),
  });
}

/**
 * One transaction for a whole batch. better-sqlite3 transactions are
 * synchronous by contract, which is exactly what makes them crash-safe: a
 * half-written batch is impossible.
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
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @param {number} limit
 * @returns {Array<{id: number, folder_abs_path: string, filename: string, mtime: number, size: number, kind: string}>}
 */
export function pendingEmbedRows(db, model, limit) {
  return db
    .prepare(
      `SELECT photos.id, photos.filename, photos.mtime, photos.size, photos.kind,
              folders.abs_path AS folder_abs_path
         FROM photos
         JOIN folders ON folders.id = photos.folder_id
        WHERE photos.stale = 0
          AND NOT EXISTS (
                SELECT 1 FROM photo_embeddings e
                 WHERE e.photo_id = photos.id AND e.model = @model)
          AND NOT EXISTS (
                SELECT 1 FROM ml_status s
                 WHERE s.photo_id = photos.id
                   AND s.stage = @stage AND s.model = @model)
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
 */
export function embedCounts(db, model) {
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM photos WHERE stale = 0`)
    .get().n;
  const embedded = db
    .prepare(
      `SELECT COUNT(*) AS n FROM photo_embeddings e
         JOIN photos p ON p.id = e.photo_id
        WHERE e.model = ? AND p.stale = 0`
    )
    .get(model).n;
  const failed = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ml_status s
         JOIN photos p ON p.id = s.photo_id
        WHERE s.stage = ? AND s.model = ? AND p.stale = 0`
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
 * @param {import("better-sqlite3").Database} db
 * @param {number} photoId
 * @param {string} model
 * @param {Error} error
 */
export function markEmbedFailed(db, photoId, model, error) {
  db.prepare(
    `INSERT INTO ml_status (photo_id, stage, model, state, attempts, error, updated_at)
     VALUES (@photoId, @stage, @model, 'failed', 1, @error, @now)
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
 * Drop every ML artifact for these photos, across ALL models.
 *
 * Called from upsertScan when a file's size or mtime changed. Without it an
 * edited photo keeps a stale vector forever: nothing else would ever notice,
 * because the worklist only asks whether a vector EXISTS, not whether it still
 * describes the current bytes.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {number[]} photoIds
 */
export function clearEmbeddingsFor(db, photoIds) {
  if (!photoIds.length) return;
  // Chunked: SQLite's default SQLITE_MAX_VARIABLE_NUMBER is 32766, and a rescan
  // of a large folder where every file changed would blow straight past it.
  const CHUNK = 500;
  for (let i = 0; i < photoIds.length; i += CHUNK) {
    const chunk = photoIds.slice(i, i + CHUNK);
    const holes = chunk.map(() => "?").join(",");
    db.prepare(`DELETE FROM photo_embeddings WHERE photo_id IN (${holes})`).run(
      ...chunk
    );
    db.prepare(`DELETE FROM ml_status WHERE photo_id IN (${holes})`).run(
      ...chunk
    );
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
