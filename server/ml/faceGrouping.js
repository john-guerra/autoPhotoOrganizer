/**
 * Grouping the faces that still need a person — progressively (#235).
 *
 * ## Why this exists beside `clusterFaces`
 *
 * `clusterFaces` computes a whole partition: it is O(n^2) over every face, and
 * `saveClusters` clears and rewrites the lot in one transaction. That is right
 * for "regroup everything from scratch", and it has a property the user paid
 * for without being offered anything in return — a cancelled pass writes
 * NOTHING, so on a 118,371-face library there was no way to make progress in
 * chunks and no way to stop. Running it again started from zero.
 *
 * This pass answers the ordinary question instead: *these faces have no person
 * yet — file them.* It is:
 *
 * - **incremental**: each batch is committed, so stopping keeps what is done;
 * - **resumable**: the worklist is "faces with no person", so the next run
 *   simply finds fewer. There is no checkpoint to corrupt, because the
 *   DATABASE is the checkpoint;
 * - **scoped**: it takes the same photo-id scope every other long operation
 *   takes, so All / Visible / Selected mean something here too (contract 1);
 * - **cheaper**: comparing each face against one centroid per person is
 *   roughly 1.8 billion comparisons on a real library where a full re-cluster
 *   is 7 billion.
 *
 * ## Centroids are fixed for the whole run
 *
 * A face joining a person shifts that person's centroid slightly. Feeding it
 * back would let a run of borderline faces walk a centroid onto somebody else
 * — drift with nothing to stop it, which is exactly the trap `assignNewFaces`
 * documents. So every face in a run is scored against the same definition of
 * each person, and a person created DURING the run gets a centroid that is
 * likewise frozen once made.
 */
import { dot } from "./quantize.js";
import { SAME_PERSON_COSINE } from "./faceClusters.js";
import { ungroupedFaceRows, ungroupedFaceCount } from "../db/faces.js";

/** Faces per committed batch. Small enough that stopping loses little, big
 *  enough that the transaction overhead disappears. */
export const GROUP_BATCH = 500;

/** Yield to the event loop every this many comparisons. Same reasoning, and
 *  the same units, as #231: comparisons, never rows. */
/**
 * Comparisons between yields.
 *
 * **Measured, not guessed** (`docs/ARCHITECTURE-REVIEW-2026-08-04.md` §2 M1/M5):
 * the previous value of 200,000 cost **64–91 ms of unyieldable CPU** between
 * yields, which took `/api/health` from 5 ms to 210 ms while grouping ran. At
 * 2,000 the same request answers in 5 ms. The exchange rate is real and worth
 * stating: this costs about **35% of grouping throughput** while the user is
 * browsing, and buys roughly **40× better latency**. Idle, it costs nothing —
 * the yield itself is free (M6); what it gives up is the chance to hog.
 *
 * Do not tune this without a test that fails when it is wrong. The test written
 * for #231 injected its own budget and would have passed if this were a hundred
 * million — see `expectNoBlockOver` in the test file.
 */
export const YIELD_COMPARISONS = 2_000;

/**
 * Centroids compared before the loop is willing to yield MID-FACE.
 *
 * Without this the budget above is unreachable. `bestPerson` compares one face
 * against EVERY centroid in a single synchronous call, so the old accounting
 * (`sinceYield += centroids.length`) could only yield between faces — a
 * granularity of one face. On John's library that is ~25,758 people ≈ 12 ms
 * per face **whatever the budget says**, so lowering the constant alone looks
 * right on a small library and does nothing on a real one.
 */
export const CENTROID_CHUNK = 512;

const breathe = () => new Promise((r) => setImmediate(r));

/**
 * Every person's centroid, as int8 plus a scale, so the fast `dot` path works.
 *
 * Int8 rather than float because `dot` is the same primitive the clustering
 * pass uses, and re-quantizing a unit-norm mean loses nothing that matters at
 * a 0.8 cosine threshold.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @returns {Array<{personId:number, bytes:Int8Array, scale:number}>}
 */
export function personCentroidVectors(db, model) {
  const rows = db
    .prepare(
      `SELECT person_id AS pid, dim, scale, vec
         FROM photo_faces
        WHERE model = ? AND person_id IS NOT NULL
        ORDER BY person_id`
    )
    .all(model);
  if (!rows.length) return [];

  const dim = rows[0].dim;
  /** @type {Map<number, Float64Array>} */
  const sums = new Map();
  for (const r of rows) {
    if (r.dim !== dim) continue; // a mixed-width model is faceVectors' problem
    let v = sums.get(r.pid);
    if (!v) sums.set(r.pid, (v = new Float64Array(dim)));
    const b = new Int8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength);
    for (let i = 0; i < dim; i++) v[i] += b[i] * r.scale;
  }

  const out = [];
  for (const [pid, v] of sums) {
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm);
    if (!(norm > 0)) continue; // a cancelled-out centroid has no direction
    let maxAbs = 0;
    for (let i = 0; i < dim; i++) {
      const a = Math.abs(v[i] / norm);
      if (a > maxAbs) maxAbs = a;
    }
    const scale = maxAbs / 127 || 1;
    const bytes = new Int8Array(dim);
    for (let i = 0; i < dim; i++) bytes[i] = Math.round(v[i] / norm / scale);
    out.push({ personId: pid, bytes, scale });
  }
  return out;
}

/**
 * The best-matching person for a face, or null.
 * @returns {{personId:number, score:number}|null}
 */
export function bestPerson(face, centroids, threshold) {
  let best = null;
  for (const c of centroids) {
    const score = dot(face.bytes, c.bytes) * face.scale * c.scale;
    if (score >= threshold && (!best || score > best.score)) {
      best = { personId: c.personId, score };
    }
  }
  return best;
}

/**
 * `bestPerson`, but able to stand aside part-way through a face.
 *
 * Identical arithmetic and identical result — the only difference is that it
 * calls `onChunk` every `chunk` centroids, giving the caller somewhere to
 * yield. That is what makes a comparison budget mean anything: the synchronous
 * version's smallest unit is one whole face, which at 25,758 people is ~12 ms
 * no matter what budget the caller asked for.
 *
 * Indices rather than `slice()`: a slice per chunk would allocate ~50 arrays
 * per face on a real library, for nothing.
 *
 * @param {{bytes:Int8Array, scale:number}} face
 * @param {Array<{personId:number, bytes:Int8Array, scale:number}>} centroids
 * @param {number} threshold
 * @param {{chunk?:number, onChunk?:(compared:number)=>Promise<void>}} [opts]
 * @returns {Promise<{personId:number, score:number}|null>}
 */
export async function bestPersonYielding(
  face,
  centroids,
  threshold,
  { chunk = CENTROID_CHUNK, onChunk } = {}
) {
  let best = null;
  for (let i = 0; i < centroids.length; i += chunk) {
    const end = Math.min(i + chunk, centroids.length);
    for (let j = i; j < end; j++) {
      const c = centroids[j];
      const score = dot(face.bytes, c.bytes) * face.scale * c.scale;
      if (score >= threshold && (!best || score > best.score)) {
        best = { personId: c.personId, score };
      }
    }
    await onChunk?.(end - i);
  }
  return best;
}

/**
 * File every ungrouped face in scope, in committed batches.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @param {object} [opts]
 * @param {number[]|null} [opts.scopeIds] photo ids; `null` = the whole
 *   library, `[]` = nothing (refused by the caller, never widened here).
 * @param {number} [opts.threshold]
 * @param {number} [opts.batchSize]
 * @param {AbortSignal} [opts.signal]
 * @param {(p: {done:number,total:number}) => void} [opts.onProgress] called as
 *   each FACE is decided, not once per batch — see the note at the call site.
 * @param {(phase: string) => void} [opts.onPhase]
 * @returns {Promise<{assigned:number, created:number, examined:number,
 *   remaining:number, removedEmpty:number}>}
 */
export async function groupRemaining(
  db,
  model,
  {
    scopeIds = null,
    threshold = SAME_PERSON_COSINE,
    batchSize = GROUP_BATCH,
    signal,
    onProgress,
    onPhase,
    /**
     * Preemption (#257). Awaited at the SAME yield point the abort check uses
     * — the one place this O(n²) loop is not mid-comparison — so parking here
     * costs at most the comparisons since the last yield, and every batch
     * already committed stays committed.
     *
     * A no-op by default, so this module still runs with no scheduler at all.
     */
    checkpoint = async () => {},
    /**
     * How many comparisons between yields. Injectable ONLY so a test can reach
     * the yield point without seeding ~6,000 faces: the real threshold is
     * tuned for a 125k-photo library, and a unit test that had to build one
     * would be a unit test nobody runs.
     */
    yieldEvery = YIELD_COMPARISONS,
  } = {}
) {
  const total = ungroupedFaceCount(db, model, scopeIds);
  if (!total) {
    return {
      assigned: 0,
      created: 0,
      examined: 0,
      removedEmpty: 0,
      remaining: 0,
    };
  }

  onPhase?.("Reading the people you already have");
  // Frozen for the whole run — see the note at the top on drift.
  const centroids = personCentroidVectors(db, model);

  const insertPerson = db.prepare(
    `INSERT INTO persons (name, cover_face_id, created_at) VALUES (NULL, ?, ?)`
  );
  const attach = db.prepare(
    // `person_id IS NULL` is what makes a re-run safe: a face committed by an
    // earlier batch is never touched again, so the same work is never done
    // twice even if the caller replays a range.
    `UPDATE photo_faces SET person_id = ?, person_source = 'model'
      WHERE id = ? AND person_id IS NULL`
  );

  let assigned = 0;
  let created = 0;
  let examined = 0;
  let sinceYield = 0;
  /** Faces this pass has decided, including ones not yet committed. */
  let decided = 0;
  /** The `done` value last handed to `onProgress`, so repeats are cheap. */
  let lastReported = -1;

  /**
   * Emit progress at most ~200 times over the whole run.
   *
   * Per-face reporting is what makes the bar move at all, but every call
   * reaches `registry.update`, which emits to every SSE subscriber. On a
   * 125,000-face library that is 125,000 pushes down the wire to redraw a bar
   * that is 400 pixels wide. A step of `total/200` keeps the bar visibly
   * smooth (a pixel or two per update) and bounds the traffic regardless of
   * library size. Small jobs get `step = 1` and report every face.
   */
  const step = Math.max(1, Math.floor(total / 200));
  const reportProgress = () => {
    const done = Math.min(decided, total);
    if (done !== total && done - lastReported < step) return;
    lastReported = done;
    onProgress?.({ done, total });
  };

  onPhase?.("Filing faces");
  for (;;) {
    const batch = ungroupedFaceRows(db, model, {
      limit: batchSize,
      scopeIds,
    });
    if (!batch.length) break;

    /** @type {Array<{faceId:number, personId:number}>} */
    const pairs = [];
    /** @type {Array<{id:number, bytes:Int8Array, scale:number}>} */
    const leftovers = [];

    /**
     * The yield point, now reachable MID-FACE.
     *
     * `compared` is the real number of dot products just done, so the budget
     * is honoured in comparisons rather than in faces. The old accounting
     * added `centroids.length` after a whole face had already been compared —
     * it counted work that had finished, so the loop could overshoot by an
     * entire face (~12 ms at 25,758 people) before it noticed.
     */
    const maybeYield = async (compared) => {
      sinceYield += compared;
      if (sinceYield < yieldEvery) return;
      sinceYield = 0;
      await breathe();
      // Stand aside for anything higher-priority, at the same point and for
      // the same reason the abort check is here (#257).
      await checkpoint();
      // Checked at the yield point, the one place the loop is not
      // mid-comparison. A cancellation here keeps every committed batch —
      // which is the whole point of this pass existing.
      if (signal?.aborted) {
        const e = new Error("canceled");
        e.name = "AbortError";
        throw e;
      }
    };

    for (const face of batch) {
      const hit = await bestPersonYielding(face, centroids, threshold, {
        onChunk: maybeYield,
      });
      if (hit) pairs.push({ faceId: face.id, personId: hit.personId });
      else leftovers.push(face);
      // PER FACE, not per batch (#293). `onProgress` used to fire once the
      // whole batch had been decided, and GROUP_BATCH is 500 — so John's
      // 327-face job reported progress exactly ONCE, at the end. The bar sat
      // at zero through ~344,000 comparisons and then jumped to done, which
      // is indistinguishable from a hang and is the "no progressive task"
      // half of his report.
      //
      // `decided` counts faces this pass has made a decision about; the
      // commit still happens per batch, so a cancellation mid-batch loses
      // those decisions and the bar is very slightly ahead of what is durable.
      // That is the right way round: a bar that lags what has been decided
      // reads as stuck, which is the bug being fixed.
      decided += 1;
      reportProgress();
    }

    // The leftovers matched nobody. Group them among THEMSELVES so a face seen
    // for the first time still becomes a person rather than being left
    // homeless — the state the user is already drowning in.
    const fresh = await clusterLeftovers(leftovers, threshold, {
      onChunk: maybeYield,
    });

    db.transaction(() => {
      for (const p of pairs)
        assigned += attach.run(p.personId, p.faceId).changes;
      for (const group of fresh) {
        const cover = group[0];
        const id = Number(
          insertPerson.run(cover.id, Date.now()).lastInsertRowid
        );
        created++;
        for (const f of group) assigned += attach.run(id, f.id).changes;
        // A person made during this run joins the fixed set, so the rest of
        // the batch can file into it. Its centroid is the first face's — good
        // enough for a group of one or two, and frozen like every other.
        centroids.push({
          personId: id,
          bytes: cover.bytes,
          scale: cover.scale,
        });
      }
    })();

    examined += batch.length;
    // `decided` and `examined` agree here (every face in the batch was decided
    // above); this keeps them from drifting if a future batch short-circuits.
    decided = examined;
    reportProgress();

    await breathe();
    if (signal?.aborted) {
      const e = new Error("canceled");
      e.name = "AbortError";
      throw e;
    }
  }

  // Sweep the people who have no faces left (#293).
  //
  // John's library held 1,053 persons of which 974 were EMPTY and unnamed —
  // 92% of the People view was rows with nothing in them, which is most of
  // why face grouping read as not working. They accumulate because
  // `photo_faces` cascades away when a photo is deleted or re-scanned while
  // `persons` is left behind, and nothing ever collected them.
  //
  // `saveClusters` has done exactly this on Regroup since faces shipped; the
  // incremental pass never did, so the only way to clean up was the
  // destructive button. Same predicate, deliberately: a NAMED person survives
  // even with no faces, because naming is an assertion by the user and
  // deleting it would throw away their work rather than the model's.
  const removedEmpty = db
    .prepare(
      `DELETE FROM persons
        WHERE (name IS NULL OR name = '')
          AND id NOT IN (
            SELECT DISTINCT person_id FROM photo_faces
             WHERE person_id IS NOT NULL
          )`
    )
    .run().changes;

  return {
    assigned,
    created,
    examined,
    removedEmpty,
    remaining: ungroupedFaceCount(db, model, scopeIds),
  };
}

/**
 * Single-link grouping WITHIN one batch, for the faces that matched nobody.
 *
 * Deliberately not the full `clusterFaces`: this runs on a few hundred faces,
 * the union-find there is built for the whole library, and importing its
 * yield/abort machinery for a 500-item loop would be more moving parts than
 * the job needs.
 *
 * @param {Array<{id:number, bytes:Int8Array, scale:number}>} faces
 * @param {number} threshold
 * @returns {Array<Array<{id:number, bytes:Int8Array, scale:number}>>}
 */
export async function clusterLeftovers(faces, threshold, { onChunk } = {}) {
  // ASYNC, and it yields per outer row (#231 / architecture review §2 M10).
  //
  // This sits INSIDE the function that advertises itself as yielding, and did
  // not yield at all. It is O(n^2) over a batch of up to GROUP_BATCH faces —
  // 500 leftovers is 124,750 comparisons in one unyieldable block, which on
  // its own exceeds the entire per-yield budget the caller is trying to keep.
  //
  // Per outer row rather than per comparison: `i` bounds the inner loop at
  // `faces.length`, so one row is at most a few hundred dot products, and the
  // check costs one `await` per row instead of one per pair.
  const parent = faces.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) parent[i] = parent[(i = parent[i])];
    return i;
  };
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      const s =
        dot(faces[i].bytes, faces[j].bytes) * faces[i].scale * faces[j].scale;
      if (s >= threshold) {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[a] = b;
      }
    }
    if (faces.length - i - 1 > 0) await onChunk?.(faces.length - i - 1);
  }
  /** @type {Map<number, Array>} */
  const groups = new Map();
  for (let i = 0; i < faces.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(faces[i]);
  }
  return [...groups.values()];
}
