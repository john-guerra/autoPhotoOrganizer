/**
 * The faces data layer (#166).
 *
 * Keyed by MODEL like embeddings, and for the same reason: a buffalo_l vector
 * and a buffalo_s vector describe different spaces, so "how many faces are
 * computed" is only ever a question about one model, and cosining across them
 * would produce confident nonsense rather than an error.
 *
 * ## Why a photo's faces are written WHOLESALE
 *
 * Detection returns "the faces in this photo" as one answer. Re-running it
 * later returns a new complete answer, not an increment — so `putFaces`
 * replaces a photo's rows for that model rather than appending. Appending
 * would double every face on the second run, and a duplicated face is not a
 * visible bug: it clusters perfectly with itself and quietly inflates whoever
 * it belongs to.
 *
 * ## The zero-face sentinel
 *
 * Most photos in a real archive contain no people at all — landscapes,
 * documents, screenshots. "No faces" is a RESULT, and it has to be recorded as
 * one, because the worklist can only ask whether rows exist. Without a marker
 * every faceless photo is pending forever and each sweep re-detects the entire
 * landscape half of the library. That is exactly the shape of #169 (an
 * unmounted drive excluded from hashing forever) and of the 1,171 unprobed
 * videos in db/enrich.js, so it is recorded in `ml_status` as a `done` state —
 * distinct from `failed`, which means the photo could not be read at all.
 */
/**
 * This stage's name in `ml_status`, which is keyed by (photo_id, stage, model).
 *
 * It MUST differ from EMBED_STAGE. If the two ever collided, a photo embedded
 * successfully would look already-face-scanned and vice versa — the two sweeps
 * would silently mark each other complete, with no error and nothing missing
 * from either table to notice. A test asserts they are distinct, because
 * nothing else would.
 */
export const FACES_STAGE = "faces";

/**
 * Replace every face this model found in one photo, in a single transaction.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{photoId: number, model: string, now?: number,
 *          faces: Array<{box: [number,number,number,number], score: number,
 *                        dim: number, scale: number, bytes: Int8Array}>}} row
 * @returns {{written: number}}
 */
export function putFaces(db, { photoId, model, faces, now = Date.now() }) {
  return db.transaction(() => {
    db.prepare(`DELETE FROM photo_faces WHERE photo_id = ? AND model = ?`).run(
      photoId,
      model
    );
    const insert = db.prepare(
      `INSERT INTO photo_faces
         (photo_id, model, box_x, box_y, box_w, box_h, det_score,
          dim, scale, vec, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const f of faces) {
      const [x1, y1, x2, y2] = f.box;
      insert.run(
        photoId,
        model,
        x1,
        y1,
        x2 - x1,
        y2 - y1,
        f.score,
        f.dim,
        f.scale,
        Buffer.from(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength),
        now
      );
    }
    // A photo that has now been looked at is not pending, whether or not it
    // held anyone. Written in the SAME transaction as the rows: a crash
    // between them would leave a photo marked done with no faces stored, which
    // reads identically to a landscape and is unrecoverable without a purge.
    db.prepare(
      `INSERT INTO ml_status (photo_id, stage, model, state, attempts, updated_at)
       VALUES (?, ?, ?, 'done', 1, ?)
       ON CONFLICT(photo_id, stage, model) DO UPDATE SET
         state = 'done', error = NULL, updated_at = excluded.updated_at`
    ).run(photoId, FACES_STAGE, model, now);
    return { written: faces.length };
  })();
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {number} photoId
 * @param {string} model
 * @returns {Array<{id: number, box: [number,number,number,number], score: number,
 *                  dim: number, scale: number, bytes: Int8Array, personId: number|null}>}
 */
export function facesFor(db, photoId, model) {
  return db
    .prepare(
      `SELECT id, box_x, box_y, box_w, box_h, det_score, dim, scale, vec, person_id
         FROM photo_faces WHERE photo_id = ? AND model = ?
        ORDER BY det_score DESC, id`
    )
    .all(photoId, model)
    .map(toFace);
}

function toFace(r) {
  return {
    id: r.id,
    box: [r.box_x, r.box_y, r.box_x + r.box_w, r.box_y + r.box_h],
    score: r.det_score,
    dim: r.dim,
    scale: r.scale,
    bytes: new Int8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength),
    personId: r.person_id,
  };
}

/**
 * The face worklist: photos this model has never been run against.
 *
 * Anti-joined on `ml_status` alone, NOT on photo_faces — because a photo with
 * no people in it correctly has zero face rows, and keying on "has no rows"
 * would hand every landscape back on every sweep, forever. `putFaces` writes
 * the marker even for an empty result precisely so this query can be written
 * this way.
 *
 * `stale = 0` mirrors pendingEmbedRows: a row whose file vanished at the last
 * scan must not be swept. `kind` is restricted to images for the same reason
 * embeddings exclude RAW — there is no decodable image here to detect in, and
 * offering one only earns it a permanent sentinel.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @param {number} limit
 * @returns {Array<{id: number, folder_abs_path: string, filename: string, mtime: number, size: number}>}
 */
export function pendingFaceRows(db, model, limit) {
  return db
    .prepare(
      `SELECT photos.id, photos.filename, photos.mtime, photos.size,
              folders.abs_path AS folder_abs_path
         FROM photos
         JOIN folders ON folders.id = photos.folder_id
        WHERE photos.stale = 0
          AND photos.kind = 'image'
          AND NOT EXISTS (
                SELECT 1 FROM ml_status s
                 WHERE s.photo_id = photos.id
                   AND s.stage = @stage AND s.model = @model)
        LIMIT @limit`
    )
    .all({ stage: FACES_STAGE, model, limit });
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @returns {{total: number, scanned: number, failed: number, faces: number, withFaces: number}}
 *   `pending` is total - scanned - failed and the UI must show it as such:
 *   "not looked at yet" and "could not be read" are different answers.
 *   `scanned` counts photos LOOKED AT, which is deliberately not `withFaces` —
 *   conflating them would report a library of landscapes as barely processed.
 */
export function faceCounts(db, model) {
  const total = db
    .prepare(`SELECT COUNT(*) n FROM photos WHERE stale = 0 AND kind = 'image'`)
    .get().n;
  const states = db
    .prepare(
      `SELECT state, COUNT(*) n FROM ml_status
        WHERE stage = ? AND model = ? GROUP BY state`
    )
    .all(FACES_STAGE, model);
  const byState = Object.fromEntries(states.map((r) => [r.state, r.n]));
  const f = db
    .prepare(
      `SELECT COUNT(*) faces, COUNT(DISTINCT photo_id) withFaces
         FROM photo_faces WHERE model = ?`
    )
    .get(model);
  return {
    total,
    scanned: byState.done ?? 0,
    failed: byState.failed ?? 0,
    faces: f.faces,
    withFaces: f.withFaces,
  };
}

/**
 * Every face vector for one model, for clustering (#167).
 *
 * Returned as one flat Int8Array plus per-face scales rather than an array of
 * arrays: at ~60,000 faces x 512 bytes this is 30 MB contiguous, where 60,000
 * separate typed arrays would be 60,000 allocations the GC walks on every
 * cycle. Same reasoning as embeddedVectors in server/ml/textSearch.js.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @returns {{ids: Int32Array, photoIds: Int32Array, scales: Float32Array, dim: number, data: Int8Array}}
 */
export function faceVectors(db, model) {
  const rows = db
    .prepare(
      `SELECT id, photo_id, dim, scale, vec FROM photo_faces
        WHERE model = ? ORDER BY id`
    )
    .all(model);
  const dim = rows[0]?.dim ?? 0;
  // A mixed-width result cannot be laid out flat, and silently truncating to
  // the first row's width would compare garbage. It means two models wrote
  // under one name, which is a bug worth stopping for.
  const odd = rows.find((r) => r.dim !== dim);
  if (odd) {
    throw new Error(
      `face vectors for ${model} have mixed dimensions (${dim} and ${odd.dim})`
    );
  }
  const data = new Int8Array(rows.length * dim);
  const ids = new Int32Array(rows.length);
  const photoIds = new Int32Array(rows.length);
  const scales = new Float32Array(rows.length);
  rows.forEach((r, i) => {
    ids[i] = r.id;
    photoIds[i] = r.photo_id;
    scales[i] = r.scale;
    data.set(
      new Int8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength),
      i * dim
    );
  });
  return { ids, photoIds, scales, dim, data };
}

/**
 * Delete every face this model computed, and the markers that say it was run.
 *
 * Both halves matter. Dropping rows without dropping the `done` markers leaves
 * every photo looking scanned-with-no-faces — a library that reports itself
 * fully processed and finds nobody, with no way back short of deleting
 * index.db, which also destroys ratings, keep-scope and album names. That is
 * the trap clearEmbedFailures was written to escape; this is the same trap.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @returns {{faces: number, markers: number}}
 */
export function purgeFaces(db, model) {
  return db.transaction(() => {
    const faces = db
      .prepare(`DELETE FROM photo_faces WHERE model = ?`)
      .run(model).changes;
    const markers = db
      .prepare(`DELETE FROM ml_status WHERE stage = ? AND model = ?`)
      .run(FACES_STAGE, model).changes;
    return { faces, markers };
  })();
}
