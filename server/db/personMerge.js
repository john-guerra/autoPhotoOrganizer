/**
 * Merging many people into one, undoably (#232).
 *
 * Kept out of `faces.js`, which is already 750 lines and owns detection
 * storage rather than corrections.
 *
 * WHY NOT JUST LOOP `mergePersons`: it re-marks the TARGET's entire face set
 * on every call (`UPDATE photo_faces SET person_source='manual' WHERE
 * person_id = into`), which is correct for one merge and quadratic for a
 * lasso. A 500-person selection onto this library's 3,512-face person is on
 * the order of a million redundant row updates in a single transaction. It
 * also chains `into.name || from.name` in loop order, never revisits the cover
 * face, and rolls back 499 good merges if one source vanished mid-flight.
 */
import { randomUUID } from "node:crypto";

/** Keep the newest N undo records. A count-based bound, like the job
 *  registry's RECENT_MAX — it does not depend on the clock. */
export const UNDO_KEEP = 10;

/**
 * Refuse a merge larger than this rather than write an undo record we cannot
 * honour. ~250k faces is far beyond any real lasso and still cheap to store.
 */
export const MAX_MERGE_FACES = 250_000;

/**
 * Merge `fromIds` into `intoId`, in one transaction.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {number} intoId
 * @param {number[]} fromIds
 * @param {{name?: string|null, maxFaces?: number}} [opts]
 *   `name` is EXPLICIT and required to be decided by the caller. The
 *   `into.name || from.name` heuristic is deliberately not applied here: in a
 *   lasso there is no row the user pointed at, so silently keeping one of two
 *   names is invisible data loss they discover weeks later. The route refuses
 *   an ambiguous merge and asks.
 * @returns {{id:number, moved:number, name:string|null, mergedCount:number,
 *            missing:number[], token:string|null}}
 */
export function mergePersonsBulk(
  db,
  intoId,
  fromIds,
  // `maxFaces` is injectable so the refusal can be tested without building a
  // quarter of a million rows. A guard no test can reach is a guard nobody
  // knows is broken.
  { name, maxFaces = MAX_MERGE_FACES } = {}
) {
  const into = Number(intoId);
  // Filtering rather than throwing: `intoId` inside the lasso is the normal
  // case, not a caller error.
  const sources = [
    ...new Set(
      (fromIds ?? [])
        .map((v) => Number(v))
        .filter((v) => Number.isSafeInteger(v) && v !== into)
    ),
  ];

  return db.transaction(() => {
    const target = db
      .prepare(`SELECT id, name FROM persons WHERE id = ?`)
      .get(into);
    if (!target) throw new Error("no such person");

    const live = sources.filter(
      (id) => db.prepare(`SELECT 1 FROM persons WHERE id = ?`).get(id) != null
    );
    // A person deleted between the lasso and the submit is REPORTED, not
    // fatal. Failing the whole merge over one stale row would throw away 499
    // good ones.
    const missing = sources.filter((id) => !live.includes(id));

    if (!live.length) {
      return {
        id: into,
        moved: 0,
        name: target.name,
        mergedCount: 0,
        missing,
        token: null,
      };
    }

    const inList = live.join(",");
    const faceCount = db
      .prepare(
        `SELECT COUNT(*) n FROM photo_faces
          WHERE person_id = ? OR person_id IN (${inList})`
      )
      .get(into).n;
    if (faceCount > maxFaces) {
      throw new Error(
        `That selection covers ${faceCount.toLocaleString("en-US")} faces, which is too many to merge in one step (the limit is ${maxFaces.toLocaleString("en-US")}). Split it into smaller lassos.`
      );
    }

    // --- the undo record, captured BEFORE anything changes -----------------
    //
    // The field everyone forgets is per-face `person_source`. The merge marks
    // every moved face AND every one of the target's own faces 'manual'. An
    // undo that restores `person_id` alone leaves them frozen as human
    // decisions, which no future grouping pass can ever revise — a silent,
    // permanent change to data the user asked to put back.
    const payload = [];
    for (const id of [...live, into]) {
      const p = db
        .prepare(
          `SELECT id, name, cover_face_id, created_at FROM persons WHERE id = ?`
        )
        .get(id);
      const faces = db
        .prepare(
          `SELECT id, person_source FROM photo_faces WHERE person_id = ?`
        )
        .all(id)
        .map((f) => [f.id, f.person_source]);
      payload.push({
        personId: p.id,
        name: p.name,
        coverFaceId: p.cover_face_id,
        createdAt: p.created_at,
        // The target is recorded too, but only its faces are restored — the
        // row itself is never deleted.
        isTarget: p.id === into,
        faces,
      });
    }

    // --- the merge ---------------------------------------------------------
    const moved = db
      .prepare(
        `UPDATE photo_faces SET person_id = ?, person_source = 'manual'
          WHERE person_id IN (${inList})`
      )
      .run(into).changes;

    // BOTH sides, exactly as mergePersons does and for the reason its comment
    // records: the user's assertion is "these are all one person", which is as
    // much a claim about the target's own faces. Marking only the movers lets
    // the next grouping pass clear the target's, and the merged person
    // silently loses half their photos.
    db.prepare(
      `UPDATE photo_faces SET person_source = 'manual' WHERE person_id = ?`
    ).run(into);

    // Best cover across the WHOLE merged set — the same rule saveClusters
    // uses. Without this the merged person keeps the target's cover even when
    // a much better face just arrived.
    const best = db
      .prepare(
        `SELECT id FROM photo_faces WHERE person_id = ?
          ORDER BY det_score DESC, id ASC LIMIT 1`
      )
      .get(into);
    if (best) {
      db.prepare(`UPDATE persons SET cover_face_id = ? WHERE id = ?`).run(
        best.id,
        into
      );
    }

    const finalName = name === undefined ? target.name : (name ?? null);
    db.prepare(`UPDATE persons SET name = ? WHERE id = ?`).run(finalName, into);
    db.prepare(`DELETE FROM persons WHERE id IN (${inList})`).run();

    // --- store the undo record --------------------------------------------
    const token = randomUUID();
    db.prepare(
      `INSERT INTO person_merge_undo
         (token, created_at, into_id, into_name_before, payload)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      token,
      Date.now(),
      into,
      target.name,
      Buffer.from(JSON.stringify(payload), "utf8")
    );
    // Prune inside the same transaction that inserts, so the table cannot grow
    // between the two.
    db.prepare(
      `DELETE FROM person_merge_undo WHERE token NOT IN (
         SELECT token FROM person_merge_undo
          ORDER BY created_at DESC, rowid DESC LIMIT ?)`
    ).run(UNDO_KEEP);

    return {
      id: into,
      moved,
      name: finalName,
      mergedCount: live.length,
      missing,
      token,
    };
  })();
}

/**
 * Reverse a bulk merge.
 *
 * Not a job: ~100k row updates in one SQLite transaction is well under a
 * second, and the existing `undo-move` is a job only because it touches the
 * filesystem.
 *
 * @returns {{restored:number, faces:number}}
 */
export function undoMerge(db, token) {
  return db.transaction(() => {
    const row = db
      .prepare(`SELECT * FROM person_merge_undo WHERE token = ?`)
      .get(String(token));
    // "No longer undoable" rather than "not found": the cap is why it is gone,
    // and the user should be told which of those two happened.
    if (!row) {
      throw new Error(
        "That merge is no longer undoable — only the last few merges are kept."
      );
    }

    const payload = JSON.parse(Buffer.from(row.payload).toString("utf8"));
    let restored = 0;
    let faces = 0;

    for (const p of payload) {
      if (!p.isTarget) {
        // Re-create the person at its ORIGINAL id, so any cached projection
        // point for it starts resolving again and the dot reappears in place.
        // (This is why projection_point deliberately has no cascading FK.)
        db.prepare(
          `INSERT OR REPLACE INTO persons (id, name, cover_face_id, created_at)
           VALUES (?, ?, ?, ?)`
        ).run(p.personId, p.name, p.coverFaceId, p.createdAt ?? Date.now());
        restored++;
      } else {
        db.prepare(`UPDATE persons SET name = ? WHERE id = ?`).run(
          row.into_name_before,
          p.personId
        );
        db.prepare(`UPDATE persons SET cover_face_id = ? WHERE id = ?`).run(
          p.coverFaceId,
          p.personId
        );
      }
      for (const [faceId, source] of p.faces) {
        db.prepare(
          `UPDATE photo_faces SET person_id = ?, person_source = ? WHERE id = ?`
        ).run(p.personId, source, faceId);
        faces++;
      }
    }

    db.prepare(`DELETE FROM person_merge_undo WHERE token = ?`).run(row.token);
    return { restored, faces };
  })();
}

/**
 * The distinct non-empty names among these people.
 *
 * The route uses this to refuse an ambiguous merge. Merging two DIFFERENTLY
 * named people asserts they are the same human and destroys one name — which
 * is invisible until someone goes looking for it weeks later.
 *
 * @returns {string[]}
 */
export function distinctNames(db, ids) {
  const clean = (ids ?? [])
    .map((v) => Number(v))
    .filter((v) => Number.isSafeInteger(v));
  if (!clean.length) return [];
  return db
    .prepare(
      `SELECT DISTINCT name FROM persons
        WHERE id IN (${clean.join(",")})
          AND name IS NOT NULL AND TRIM(name) <> ''
        ORDER BY name`
    )
    .all()
    .map((r) => r.name);
}
