/**
 * The projection run cache (#232).
 *
 * A projection is expensive (4s at the default member count, 20s with
 * singletons), deterministic for a given seed, and worth persisting — like
 * `content_hash`. Runs are keyed by (kind, model, algorithm, params_key), so
 * flipping a parameter back to one you already computed is instant and starts
 * no job at all.
 *
 * The design decision worth stating up front: **a run is a snapshot, and its
 * points are served by INNER JOIN persons.** Merge eight people away and their
 * dots disappear from the map with no re-projection. Only their POSITIONS go
 * stale, which the view reports; who exists stays truthful for free.
 */
import { createHash } from "node:crypto";
import { buildFilter } from "./filters.js";

/**
 * A stable digest of a params object.
 *
 * Canonicalised rather than raw JSON, because the digest IS the cache key:
 * `{"a":1,"b":2}` and `{"b":2,"a":1}` are the same run, and keying on the raw
 * text would compute and store it twice while looking like it was working.
 *
 * @param {object} obj
 * @returns {string}
 */
export function paramsKey(obj) {
  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, canon(v[k])])
      );
    }
    return v;
  };
  return createHash("sha1")
    .update(JSON.stringify(canon(obj)))
    .digest("hex");
}

/**
 * The newest run matching the WHOLE key, or null.
 * @returns {{id:number,kind:string,model:string,algorithm:string,params_key:string,params:string,members:number,created_at:number}|null}
 */
export function findRun(db, { kind, model, algorithm, paramsKey: pk }) {
  return (
    db
      .prepare(
        `SELECT * FROM projection_runs
          WHERE kind = ? AND model = ? AND algorithm = ? AND params_key = ?
          ORDER BY id DESC LIMIT 1`
      )
      .get(kind, model, algorithm, pk) ?? null
  );
}

/** @returns {number} the new run's id */
export function createRun(
  db,
  {
    kind,
    model,
    algorithm,
    paramsKey: pk,
    params,
    members,
    createdAt = Date.now(),
  }
) {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO projection_runs
         (kind, model, algorithm, params_key, params, members, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      kind,
      model,
      algorithm,
      pk,
      JSON.stringify(params),
      members,
      createdAt
    );
  return Number(lastInsertRowid);
}

/**
 * @param {number} runId
 * @param {Int32Array|number[]} ids the member ids, in row order
 * @param {Float32Array} xy interleaved x,y — `xy[2i]`, `xy[2i+1]`
 */
export function savePoints(db, runId, ids, xy) {
  if (ids.length * 2 !== xy.length) {
    // A mismatch here silently shifts every point onto the wrong person, which
    // is a map that looks fine and is entirely wrong. Refuse it.
    throw new Error(
      `savePoints: ${ids.length} ids but ${xy.length / 2} coordinate pairs`
    );
  }
  const ins = db.prepare(
    `INSERT OR REPLACE INTO projection_point (run_id, ref_id, x, y)
     VALUES (?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (let i = 0; i < ids.length; i++) {
      ins.run(runId, ids[i], xy[i * 2], xy[i * 2 + 1]);
    }
  })();
}

/**
 * A run's points, joined to the LIVE persons table.
 *
 * The join is the staleness policy: a person who has been merged away has no
 * row here any more, so the map cannot show a dot for someone who no longer
 * exists. `faces` and `name` are read live too, so a rename shows up without
 * re-projecting.
 *
 * @returns {Array<{personId:number,x:number,y:number,name:string|null,coverFaceId:number|null,faces:number,photos:number}>}
 */
export function pointsForRun(db, runId) {
  return db
    .prepare(
      `SELECT pp.ref_id AS personId,
              pp.x      AS x,
              pp.y      AS y,
              p.name    AS name,
              p.cover_face_id AS coverFaceId,
              (SELECT COUNT(*) FROM photo_faces f WHERE f.person_id = p.id)
                        AS faces,
              -- PHOTOS, not faces: two faces of the same person in one frame
              -- are one photo, and "how much of my library is this person in"
              -- is what the dot size should say.
              (SELECT COUNT(DISTINCT f.photo_id) FROM photo_faces f
                WHERE f.person_id = p.id)
                        AS photos
         FROM projection_point pp
         JOIN persons p ON p.id = pp.ref_id
        WHERE pp.run_id = ?
        ORDER BY pp.ref_id`
    )
    .all(runId);
}

/**
 * Keep the newest `keep` runs for this (kind, model); delete the rest with
 * their points.
 *
 * A count-based bound rather than an age-based one — a bound that does not
 * depend on the clock, the same reasoning as the job registry's `RECENT_MAX`.
 * Three is enough to flip between two parameter choices and back without
 * recomputing.
 */
export function pruneRuns(db, { kind, model, keep = 3 }) {
  db.transaction(() => {
    const doomed = db
      .prepare(
        `SELECT id FROM projection_runs
          WHERE kind = ? AND model = ?
          ORDER BY created_at DESC, id DESC
          LIMIT -1 OFFSET ?`
      )
      .all(kind, model, Math.max(0, keep))
      .map((r) => r.id);
    for (const id of doomed) {
      db.prepare(`DELETE FROM projection_point WHERE run_id = ?`).run(id);
      db.prepare(`DELETE FROM projection_runs WHERE id = ?`).run(id);
    }
  })();
}

/**
 * Which people appear in the photos the current filter is showing (#232).
 *
 * The map is a SNAPSHOT of everyone, and filtering it hides points rather than
 * re-projecting. That is a deliberate departure from how `minFaces` works, and
 * the reason is what the two filters are FOR.
 *
 * `minFaces` removes noise that distorts the layout — a projection of a subset
 * is not a subset of the projection, so it has to be a run parameter. A
 * visibility filter is the opposite: you want to see WHERE these people sit
 * among everyone, and re-laying-out would rearrange the map you have just
 * learned and cost several seconds on every filter change. Hiding keeps the
 * positions comparable across filters, which is the whole value of a map.
 *
 * Reuses `buildFilter`, so every facet the feed supports — rating, keep-only
 * scope, folder, text, person, tags — narrows the map identically, and a new
 * facet works here the day it works there.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @param {object} filterSpec as produced by the API's filter parser
 * @returns {number[]} person ids, ascending
 */
export function personIdsMatchingFilter(db, model, filterSpec) {
  const { sql, params } = buildFilter(filterSpec ?? {});
  return db
    .prepare(
      `SELECT DISTINCT photo_faces.person_id AS id
         FROM photo_faces
         JOIN photos ON photos.id = photo_faces.photo_id
        WHERE photo_faces.model = ?
          AND photo_faces.person_id IS NOT NULL
          AND photos.stale = 0
          AND (${sql})
        ORDER BY photo_faces.person_id`
    )
    .all(model, ...params)
    .map((r) => r.id);
}

/**
 * How much a run has drifted from the library it describes.
 *
 * The view must say this: the join keeps WHO is on the map truthful, but a
 * person created since the run has no dot at all, and silently showing a map
 * that is missing people reads as "these are all the people".
 *
 * @returns {{peopleOnMap:number, peopleNow:number, missing:number}}
 */
export function runStaleness(db, runId, { minFaces = 2 } = {}) {
  const peopleOnMap = db
    .prepare(
      `SELECT COUNT(*) n FROM projection_point pp
        JOIN persons p ON p.id = pp.ref_id
       WHERE pp.run_id = ?`
    )
    .get(runId).n;
  // Compare against the population the run was DRAWN FROM, not every person
  // in the library — otherwise a map built with minFaces:2 always reports the
  // 20,259 singletons as "missing", which is true and useless.
  const peopleNow = db
    .prepare(
      `SELECT COUNT(*) n FROM (
         SELECT person_id FROM photo_faces
          WHERE person_id IS NOT NULL
          GROUP BY person_id HAVING COUNT(*) >= ?)`
    )
    .get(Math.max(1, minFaces)).n;
  return {
    peopleOnMap,
    peopleNow,
    missing: Math.max(0, peopleNow - peopleOnMap),
  };
}
