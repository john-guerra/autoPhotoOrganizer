// Shared with the embed worklist (#206/#221) — see scopeIds.js on why this
// validator has its own module rather than a copy per stage.
import { normalizeScope, scopeClauseFor } from "./scopeIds.js";

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
export function pendingFaceRows(db, model, limit, scopeIds = null) {
  // #221: a scope restricts the worklist to specific photos, so you can look
  // for faces in the twenty you just selected instead of waiting out a
  // 32,000-photo library. Built as an extra WHERE clause on the SAME query
  // rather than a second one, so the scoped and unscoped worklists can never
  // disagree about what "pending" means — the kind filter and the anti-join
  // apply identically either way. Exactly how pendingEmbedRows does it (#206).
  const ids = normalizeScope(scopeIds);
  // An explicitly EMPTY scope means "these zero photos", never "all of them".
  // Falling through to the unscoped query here would turn a caller's empty
  // selection into a full-library sweep.
  if (ids !== null && ids.length === 0) return [];
  const scopeClause = scopeClauseFor(ids);
  return db
    .prepare(
      `SELECT photos.id, photos.filename, photos.mtime, photos.size,
              folders.abs_path AS folder_abs_path
         FROM photos
         JOIN folders ON folders.id = photos.folder_id
        WHERE photos.stale = 0
          AND photos.kind = 'image'
          ${scopeClause}
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
 * How much of the face library has actually been grouped into people (#232).
 *
 * Separate from `faceCounts`, whose `total` is PHOTOS rather than faces — a
 * distinction that is easy to miss and produces a banner quoting the wrong
 * denominator.
 *
 * The face map exists to fix over-split people, and it can only show faces
 * that HAVE a person. On a real library most do not: 69,786 of 118,371
 * (59%) were ungrouped when this was written, because a grouping pass had
 * never run to completion. A map that stays quiet about that lets someone
 * lasso everything, merge, and reasonably conclude they are finished.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @returns {{detected: number, grouped: number, ungrouped: number, people: number}}
 */
export function faceGroupingCoverage(db, model) {
  const r = db
    .prepare(
      `SELECT COUNT(*) detected,
              COUNT(person_id) grouped,
              COUNT(DISTINCT person_id) people
         FROM photo_faces WHERE model = ?`
    )
    .get(model);
  return {
    detected: r.detected,
    grouped: r.grouped,
    // COUNT(col) skips NULLs, so this is exactly the faces with no person.
    ungrouped: r.detected - r.grouped,
    people: r.people,
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

/**
 * Record that this photo could not be face-scanned, permanently.
 *
 * "Permanently" is the whole weight of this function, and why runSweep
 * classifies before calling it: a sentinel written for a TRANSIENT failure —
 * an unmounted drive, a model that would not download — is a false statement
 * about the user's library that outlives the condition that caused it. That
 * was #169, which excluded a whole unplugged drive from hashing forever, and
 * #161's final Critical 1. Sentinels only clear when the file's bytes change,
 * so the wrong one is close to unrecoverable.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {number} photoId
 * @param {string} model
 * @param {string} error
 */
export function markFaceFailed(db, photoId, model, error) {
  db.prepare(
    `INSERT INTO ml_status (photo_id, stage, model, state, attempts, error, updated_at)
     VALUES (?, ?, ?, 'failed', 1, ?, ?)
     ON CONFLICT(photo_id, stage, model) DO UPDATE SET
       state = 'failed',
       attempts = ml_status.attempts + 1,
       error = excluded.error,
       updated_at = excluded.updated_at`
  ).run(photoId, FACES_STAGE, model, String(error).slice(0, 500), Date.now());
}

/**
 * Forget every "cannot be scanned" verdict for this model, so the next sweep
 * tries again.
 *
 * Exists for the same reason clearEmbedFailures does: without it, a sweep that
 * failed EVERYTHING (a bad model file, a since-fixed bug) leaves sentinels
 * that only clear when a file's bytes change — i.e. never — and there is no
 * way back short of deleting index.db, which also destroys ratings, keep-scope
 * and album names. Deliberately does NOT touch `done` rows: re-scanning
 * photos that were successfully found to contain nobody is pure waste.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @returns {{cleared: number}}
 */
export function clearFaceFailures(db, model) {
  const { changes } = db
    .prepare(
      `DELETE FROM ml_status WHERE stage = ? AND model = ? AND state = 'failed'`
    )
    .run(FACES_STAGE, model);
  return { cleared: changes };
}

/**
 * Persist a clustering as people.
 *
 * REPLACES the model's automatic assignments and leaves manual ones alone —
 * the same contract saveTag has for semantic tags, and for the same reason:
 * a re-cluster is the model changing its mind, and it has no business
 * discarding a decision a person made. #167 calls this out directly ("that
 * correction must be durable — it survives the next sweep and new photos").
 *
 * A person the user has NAMED is never deleted, even when this pass finds no
 * cluster for them. Losing a name to a re-run would make naming feel unsafe,
 * which is fatal for a feature whose whole cost is ten minutes of typing.
 *
 * Scoped to ONE model, like everything else in this file. Clearing across all
 * of them would let a buffalo_s grouping wipe every buffalo_l assignment, and
 * silently — the two never appear on screen together, so nothing would look
 * wrong until the user switched packs back.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {Array<number[]>} clusters arrays of FACE ids, largest first
 * @param {{model: string, now?: number}} opts
 * @returns {{people: number, assigned: number, keptManual: number}}
 */
export function saveClusters(db, clusters, { model, now = Date.now() } = {}) {
  if (!model) throw new Error("saveClusters needs a model");
  return db.transaction(() => {
    // PROTECTED = a face the model must not take back. Two kinds, and the
    // second was missing, which broke the feature's whole point:
    //
    //   1. `person_source = 'manual'` — a merge or a split the user performed.
    //   2. Any face belonging to a NAMED person. Naming a cluster IS the
    //      assertion "these faces are Ana". Without this, renamePerson set
    //      persons.name and nothing else, so the next pass cleared every one
    //      of her faces, spared her now-empty row (it has a name), and built
    //      a fresh UNNAMED person for the same cluster. Ana survived with
    //      zero photos. Reproduced before fixing; the old test passed
    //      throughout because it only asked whether SOMEONE was still called
    //      Ana, which is true of an empty row.
    const PROTECTED = `SELECT f.id FROM photo_faces f
         LEFT JOIN persons p ON p.id = f.person_id
        WHERE f.model = @model
          AND (f.person_source = 'manual'
               OR (p.name IS NOT NULL AND p.name <> ''))`;
    const protectedIds = new Set(
      db
        .prepare(PROTECTED)
        .all({ model })
        .map((r) => r.id)
    );
    const manual = protectedIds;

    // Clear only what the model still owns, and only within THIS pack.
    db.prepare(
      `UPDATE photo_faces SET person_id = NULL
        WHERE model = @model AND id NOT IN (${PROTECTED})`
    ).run({ model });
    db.prepare(
      `DELETE FROM persons WHERE id NOT IN (
         SELECT DISTINCT person_id FROM photo_faces WHERE person_id IS NOT NULL
       ) AND (name IS NULL OR name = '')`
    ).run();

    const newPerson = db.prepare(
      `INSERT INTO persons (name, cover_face_id, created_at) VALUES (NULL, ?, ?)`
    );
    const assign = db.prepare(
      `UPDATE photo_faces SET person_id = ?, person_source = 'model' WHERE id = ?`
    );

    // The cover face is the CONFIDENT one, looked up rather than assumed. It
    // used to be `fresh[0]`, described as "the highest-scoring face" — but
    // clusterFaces returns members in faceVectors' order, which is `ORDER BY
    // id`, so the cover was really the oldest face in the cluster. A cover
    // chosen effectively at random is how a person ends up represented by the
    // back of their head.
    const scoreOf = new Map(
      db
        .prepare(`SELECT id, det_score FROM photo_faces WHERE model = ?`)
        .all(model)
        .map((r) => [r.id, r.det_score])
    );
    const bestOf = (ids) =>
      ids.reduce((a, b) =>
        (scoreOf.get(b) ?? 0) > (scoreOf.get(a) ?? 0) ? b : a
      );

    let assigned = 0;
    let people = 0;
    for (const cluster of clusters) {
      const fresh = cluster.filter((id) => !manual.has(id));
      if (!fresh.length) continue;
      const personId = newPerson.run(bestOf(fresh), now).lastInsertRowid;
      people++;
      for (const faceId of fresh) {
        assign.run(personId, faceId);
        assigned++;
      }
    }
    return {
      people,
      assigned,
      keptManual: protectedIds.size,
    };
  })();
}

/**
 * The vectors of everyone who has a NAME, for assigning newly-imported faces
 * without a full re-cluster (#167).
 *
 * Only named people, because an unnamed cluster is the model's own guess and
 * growing it silently compounds whatever it got wrong. A name is the user
 * saying "this cluster is a person", which is what makes it worth extending.
 *
 * `perPerson` caps the members loaded. Someone photographed constantly can
 * have thousands of faces, and the mean of 64 of them is the same answer as
 * the mean of 3,000 for a fraction of the memory. Highest-scoring first, so
 * the cap keeps the clearest views of them rather than an arbitrary slice.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @param {{perPerson?: number}} [opts]
 * @returns {Array<{personId: number, name: string, members: Array<{scale: number, bytes: Int8Array}>}>}
 */
export function namedPersonMembers(db, model, { perPerson = 64 } = {}) {
  const people = db
    .prepare(
      `SELECT id, name FROM persons WHERE name IS NOT NULL AND name <> ''`
    )
    .all();
  const members = db.prepare(
    `SELECT scale, vec FROM photo_faces
      WHERE model = ? AND person_id = ?
      ORDER BY det_score DESC, id LIMIT ?`
  );
  return people.map((p) => ({
    personId: p.id,
    name: p.name,
    members: members.all(model, p.id, perPerson).map((r) => ({
      scale: r.scale,
      bytes: new Int8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength),
    })),
  }));
}

/**
 * Faces this model found that belong to nobody yet.
 *
 * Excludes faces the user DETACHED. A detach is `person_id = NULL` plus
 * `person_source = 'manual'`, which is the user saying "not this person" —
 * putting it straight back on the next sweep is exactly the undo-my-undo loop
 * #167 warns about, and it would look like the button did nothing.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @returns {Array<{id: number, scale: number, bytes: Int8Array}>}
 */
export function unassignedFaces(db, model) {
  return db
    .prepare(
      `SELECT id, scale, vec FROM photo_faces
        WHERE model = ? AND person_id IS NULL
          AND (person_source IS NULL OR person_source <> 'manual')
        ORDER BY id`
    )
    .all(model)
    .map((r) => ({
      id: r.id,
      scale: r.scale,
      bytes: new Int8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength),
    }));
}

/**
 * File faces under the people they were matched to.
 *
 * `person_source = 'model'`, not 'manual': this is still the model's guess, so
 * a later re-cluster is free to revise it. Marking it manual would freeze a
 * machine decision beyond the reach of the correction that fixes it.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {Array<{faceId: number, personId: number}>} pairs
 * @returns {{assigned: number}}
 */
export function attachFaces(db, pairs) {
  const set = db.prepare(
    `UPDATE photo_faces SET person_id = ?, person_source = 'model'
      WHERE id = ? AND person_id IS NULL`
  );
  return db.transaction(() => {
    let assigned = 0;
    for (const { faceId, personId } of pairs) {
      assigned += set.run(personId, faceId).changes;
    }
    return { assigned };
  })();
}

/**
 * People, largest first — the order #167 wants for naming, because ten
 * minutes on the biggest clusters covers most of a library and a wall of
 * singletons first is a chore.
 *
 * @param {import("better-sqlite3").Database} db
 * @returns {Array<{id:number, name:string|null, faces:number, photos:number, coverFaceId:number|null}>}
 */
export function listPersons(db) {
  return db
    .prepare(
      `SELECT p.id, p.name, p.cover_face_id AS coverFaceId,
              COUNT(f.id) AS faces,
              COUNT(DISTINCT f.photo_id) AS photos
         FROM persons p
         LEFT JOIN photo_faces f ON f.person_id = p.id
        GROUP BY p.id
        ORDER BY faces DESC, p.id`
    )
    .all();
}

/**
 * The same list, BOUNDED, with the total — what the API serves (#223).
 *
 * A real library is not a fixture. Measured on a 31,976-photo library: 25,760
 * persons, of which 20,259 are SINGLETONS — a stranger in the background of
 * one photo, seen once. Handing all of them to the People view is 25,760 DOM
 * tiles and 25,760 <img> elements, and it is not browsable even when it is
 * fast. Largest-first is what makes a cap sane: ten minutes on the biggest
 * clusters covers most of a library (#167), and the singleton tail is exactly
 * the part nobody names.
 *
 * `total` and `truncated` come back so the caller can SAY what it is not
 * showing. UI-CONTRACTS §3 requires a working-set view's fetch to be "bounded,
 * capped, WITH A `truncated` FLAG"; without them this view silently pretends
 * the library has 200 people in it.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{limit?: number|null}} [opts] null = every person (tests, internals)
 * @returns {{people: ReturnType<typeof listPersons>, total: number, truncated: boolean}}
 */
export function listPersonsPage(db, { limit = null } = {}) {
  const total = db.prepare(`SELECT COUNT(*) n FROM persons`).get().n;
  if (limit === null) {
    const people = listPersons(db);
    return { people, total, truncated: false };
  }
  const people = db
    .prepare(
      `SELECT p.id, p.name, p.cover_face_id AS coverFaceId,
              COUNT(f.id) AS faces,
              COUNT(DISTINCT f.photo_id) AS photos
         FROM persons p
         LEFT JOIN photo_faces f ON f.person_id = p.id
        GROUP BY p.id
        ORDER BY faces DESC, p.id
        LIMIT @limit`
    )
    .all({ limit });
  return { people, total, truncated: people.length < total };
}

/**
 * How many photos a face sweep will ACTUALLY look at (#221).
 *
 * The number a job's `total` must use. `ids.length` is the wrong one and
 * quietly ruins the bar: the scope is whatever the user selected, but the
 * worklist excludes what is already scanned, plus videos, RAW, and rows whose
 * file has vanished. Select 20 tiles of which 5 are new and a bar built on
 * `ids.length` reaches 5/20 and stops — "done", rendered as 25%.
 *
 * Extracted from the route so it is testable: every `POST /api/ml/faces` in
 * faceRoutes.test.js fails at `loadOrt` (mocked to throw, which is what that
 * file is FOR), so nothing could reach this arithmetic in place — and a bug in
 * it shipped because of that.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @param {number[]|null|undefined} scopeIds null/undefined = the whole library
 * @returns {number}
 */
export function faceSweepPending(db, model, scopeIds) {
  if (scopeIds) {
    return pendingFaceRows(db, model, Number.MAX_SAFE_INTEGER, scopeIds).length;
  }
  const c = faceCounts(db, model);
  return Math.max(0, c.total - c.scanned - c.failed);
}

/**
 * Where a face LIVES: its box plus the photo it was found in (#223).
 *
 * The People view draws a crop per person, and nothing could serve one — the
 * box has always been stored, but there was no way to turn it into pixels.
 *
 * Box columns come back as stored (x/y/w/h in the ORIENTED original's pixel
 * space, i.e. after EXIF rotation — see faceEngine's `orientedSize`), NOT as
 * the corner pair `facesFor` hands out: the caller here is `sharp.extract`,
 * whose contract is left/top/width/height, and converting to corners just to
 * convert back is where an off-by-one gets in.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {number} faceId
 * @returns {{photoId: number, x: number, y: number, w: number, h: number}|undefined}
 */
export function faceCropSource(db, faceId) {
  const r = db
    .prepare(
      `SELECT photo_id, box_x, box_y, box_w, box_h
         FROM photo_faces WHERE id = ?`
    )
    .get(faceId);
  return r
    ? { photoId: r.photo_id, x: r.box_x, y: r.box_y, w: r.box_w, h: r.box_h }
    : undefined;
}

/**
 * Name a person, or clear the name with null/"".
 * @param {import("better-sqlite3").Database} db
 * @param {number} personId
 * @param {string|null} name
 */
export function renamePerson(db, personId, name) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  const { changes } = db
    .prepare(`UPDATE persons SET name = ? WHERE id = ?`)
    .run(trimmed || null, personId);
  if (!changes) throw new Error(`no such person: ${personId}`);
  return { id: personId, name: trimmed || null };
}

/**
 * Merge two people into one, DURABLY.
 *
 * Every moved face is marked `person_source = 'manual'`, which is what makes
 * the correction survive — `saveClusters` only clears what the model owns.
 * Without that mark the next grouping pass would undo the merge and the user
 * would do it again, and again, which is worse than not offering it.
 *
 * The name is kept from whichever side has one; if both do, `into` wins,
 * because that is the row the user pointed AT.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {number} intoId the person to keep
 * @param {number} fromId the person to absorb
 * @returns {{id:number, moved:number, name:string|null}}
 */
export function mergePersons(db, intoId, fromId) {
  if (intoId === fromId)
    throw new Error("cannot merge a person into themselves");
  return db.transaction(() => {
    const into = db
      .prepare(`SELECT id, name FROM persons WHERE id = ?`)
      .get(intoId);
    const from = db
      .prepare(`SELECT id, name FROM persons WHERE id = ?`)
      .get(fromId);
    if (!into || !from) throw new Error("no such person");

    const { changes } = db
      .prepare(
        `UPDATE photo_faces SET person_id = ?, person_source = 'manual'
          WHERE person_id = ?`
      )
      .run(intoId, fromId);
    // BOTH sides, not just the absorbed one. The user's assertion is "these
    // are all one person", which is as much a claim about the faces already
    // on `into` as about the ones arriving. Marking only the movers leaves
    // the target's own faces model-owned, so the next grouping pass clears
    // them and the merged person silently loses half its photos — which is
    // exactly what the test for this caught.
    db.prepare(
      `UPDATE photo_faces SET person_source = 'manual' WHERE person_id = ?`
    ).run(intoId);

    // Inherit a name rather than lose it: merging an unnamed cluster into a
    // named one is the common direction, but the reverse happens too and
    // silently dropping the only name would be a data loss the user cannot
    // see until much later.
    const name = into.name || from.name || null;
    db.prepare(`UPDATE persons SET name = ? WHERE id = ?`).run(name, intoId);
    db.prepare(`DELETE FROM persons WHERE id = ?`).run(fromId);
    return { id: intoId, moved: changes, name };
  })();
}

/**
 * Take one face out of the person it was put in.
 *
 * The other half of the correction #167 requires, and the one that matters
 * when clustering over-merges: a stranger inside someone's photo set. Marked
 * manual for the same durability reason as the merge — the model must not put
 * them back on the next pass.
 *
 * The face becomes unassigned rather than a new person. Its own cluster would
 * be a person of one, and a wall of those is exactly the chore #167 warns
 * about; a later pass can pick it up, or the user can merge it somewhere.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {number} faceId
 * @returns {{id:number, personId:null}}
 */
export function detachFace(db, faceId) {
  const { changes } = db
    .prepare(
      `UPDATE photo_faces SET person_id = NULL, person_source = 'manual'
        WHERE id = ?`
    )
    .run(faceId);
  if (!changes) throw new Error(`no such face: ${faceId}`);
  return { id: faceId, personId: null };
}
