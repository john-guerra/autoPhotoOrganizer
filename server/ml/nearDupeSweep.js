import { whenIdle } from "../lib/interactive.js";
import { dot } from "./quantize.js";
import { modelById } from "./models.js";
import {
  embeddedPhotosInTimeOrder,
  replaceNearDupeGroups,
  replaceNeighborSim,
} from "../db/nearDupes.js";

/**
 * Group photos that are the SAME SHOT (#162), by intersecting two signals that
 * are each insufficient alone:
 *
 *   TIME    — taken within `windowMs` of each other.
 *   MEANING — cosine similarity of their embeddings at or above `threshold`.
 *
 * Why both. Similarity alone, applied across a library, merges unrelated
 * photographs that merely share a genre: measured at 0.61-0.68 against 0.41-0.56
 * for wholly different subjects (models.js). On a travel archive — which is
 * mostly one genre — a cutoff tuned by eye on obviously-different photos would
 * therefore surface confident false duplicates. Time alone is what the existing
 * burst detector already does, and it splits a burst whenever the photographer
 * paused. Intersected, each covers the other's failure.
 *
 * The accepted cost, ruled on 2026-07-25 and recorded on #162: the same scene
 * re-shot months later is never proposed. That is a real duplicate this will
 * not find, and it was chosen over the alternative of a threshold loose enough
 * to be wrong across a whole library.
 *
 * ## Why this is not built on runSweep
 *
 * `runSweep` exists to drain a per-row worklist while isolating a poison FILE
 * and classifying permanent-vs-transient I/O failures. This pass never touches
 * the filesystem — it is SQLite plus arithmetic over vectors already stored —
 * so all of that machinery would be dead weight, and its per-row failure
 * sentinel has nothing to describe. What this genuinely needs from that family
 * is idle gating and cancellation, and it keeps both.
 *
 * It is also whole-library by nature rather than incremental: adding one photo
 * can merge two previously separate groups, and removing one can split a group
 * in two, so there is no correct per-row update to drain. It recomputes and
 * replaces wholesale.
 */

let sweepInFlight = false;

/** Rows scanned between idle checks. Small enough that Cancel feels immediate
 *  and the grid never stutters, large enough that the idle check itself is not
 *  the dominant cost. */
const CHUNK = 2_000;

/** @returns {boolean} whether a grouping pass is running right now. */
export function isNearDupeSweepInFlight() {
  return sweepInFlight;
}

/**
 * Recompute the whole near-duplicate grouping and replace what is stored.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{model: string, threshold?: number, windowMs: number,
 *          idle?: () => Promise<void>, job?: object|null,
 *          onProgress?: ((c: {done: number, total: number}) => void)|null}} opts
 * @returns {Promise<{photos: number, groups: number, scanned: number,
 *   cancelled: boolean, alreadyRunning?: boolean}>}
 */
export async function groupNearDupes(
  db,
  {
    model,
    threshold = modelById(model).nearDupeThreshold,
    windowMs,
    idle = whenIdle,
    job = null,
    onProgress = null,
  }
) {
  if (sweepInFlight)
    return {
      photos: 0,
      groups: 0,
      scanned: 0,
      cancelled: false,
      alreadyRunning: true,
    };
  sweepInFlight = true;

  try {
    // Viewed as Int8Array ONCE here, not per comparison: each row is compared
    // against every neighbour in its window, so building the view inside the
    // inner loop would rebuild it a dozen times per photo for nothing. The
    // view shares the Buffer's memory rather than copying it.
    const rows = embeddedPhotosInTimeOrder(db, model).map((r) => ({
      id: r.id,
      time: r.time,
      dim: r.dim,
      scale: r.scale,
      bytes: new Int8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength),
    }));
    const total = rows.length;
    /** @type {Array<{members: Array<object>, lastTime: number}>} */
    const open = [];
    const closed = [];
    // #216: how alike each photo is to its immediate predecessor in time. Free
    // here — the rows are already loaded, time-ordered and vector-ready, so
    // this is one extra dot product per photo rather than a second pass.
    const neighbors = [];
    let cancelled = false;

    // Walk in time order, keeping a set of OPEN groups — those whose most
    // recent member is still within `windowMs`. Each photo joins at most one.
    for (let i = 0; i < total; i++) {
      if (i % CHUNK === 0) {
        if (job?.cancelled) {
          cancelled = true;
          break;
        }
        await idle();
        onProgress?.({ done: i, total });
      }

      const cur = rows[i];
      if (i > 0) {
        const prev = rows[i - 1];
        if (prev.dim === cur.dim) {
          neighbors.push({
            photoId: cur.id,
            prevId: prev.id,
            sim: cosine(prev, cur),
          });
        }
      }
      // Retire groups the window has moved past, so the search below stays
      // bounded by the window's density rather than by the library size.
      for (let k = open.length - 1; k >= 0; k--) {
        if (open[k].lastTime < cur.time - windowMs) {
          closed.push(open[k]);
          open.splice(k, 1);
        }
      }

      // COMPLETE LINKAGE, and this is the single most important line in the
      // file. The obvious implementation — union any two photos that score
      // above the threshold — is SINGLE linkage, and single linkage chains:
      // on a continuously-shot sequence every frame is similar to the next,
      // so A~B~C~…~Z transitively welds the whole window into one group even
      // though A and Z look nothing alike. That is not a hypothetical. The
      // first build did exactly this and produced a 52-photo stack out of a
      // 176-photo dance-class shoot, with 155 of 176 photos absorbed into 21
      // groups. Every unit test passed; only running it against a real
      // library showed it.
      //
      // Requiring a candidate to clear the threshold against EVERY member
      // kills the chain: a group stays as tight as its two most distant
      // members, which is what "these are the same shot" actually means.
      let best = null;
      let bestScore = -Infinity;
      for (const group of open) {
        let worst = Infinity;
        for (const m of group.members) {
          // Vectors of different length cannot be compared and must never be
          // silently treated as "not similar": that would be a wrong ANSWER
          // rather than a missing one. It can only happen if two models' rows
          // coexist under one model name, which is a bug, so it is loud.
          if (m.dim !== cur.dim)
            throw new Error(
              `photos ${m.id} and ${cur.id} have ${m.dim}- and ` +
                `${cur.dim}-dim vectors under model ${model}`
            );
          const s = cosine(m, cur);
          if (s < worst) worst = s;
          if (worst < threshold) break; // cannot qualify; stop early
        }
        // Ranked by the WEAKEST link, so when two groups both qualify the
        // photo lands in the one it fits most tightly rather than in
        // whichever happened to be created first.
        if (worst >= threshold && worst > bestScore) {
          bestScore = worst;
          best = group;
        }
      }

      if (best) {
        best.members.push(cur);
        best.lastTime = cur.time;
      } else {
        open.push({ members: [cur], lastTime: cur.time });
      }
    }
    closed.push(...open);

    // Only groups with a partner are worth storing. A photo that matched
    // nothing is the overwhelmingly common case, and writing a singleton row
    // for each would make the table as large as the library to say nothing.
    const out = [];
    let groupId = 0;
    for (const group of closed) {
      if (group.members.length < 2) continue;
      groupId++;
      for (const m of group.members) out.push({ photoId: m.id, groupId });
    }

    // A cancelled pass must not replace the stored grouping with its partial
    // work: half a grouping is not a smaller grouping, it is a WRONG one —
    // every group whose members lie beyond the cancellation point silently
    // loses them, and nothing downstream could tell that from a real answer.
    if (cancelled)
      return { photos: 0, groups: 0, scanned: total, cancelled: true };

    const written = replaceNearDupeGroups(db, model, out);
    replaceNeighborSim(db, model, neighbors);
    onProgress?.({ done: total, total });
    return { ...written, scanned: total, cancelled: false };
  } finally {
    sweepInFlight = false;
  }
}

/**
 * Cosine similarity straight from the int8 storage form.
 *
 * Exact rather than approximate, and that is a property of how they were
 * stored: quantize() L2-normalizes BEFORE quantizing, so each vector's true
 * direction is preserved and the cosine collapses to a plain dot product of
 * the bytes rescaled — no per-call normalization, no square roots.
 */
function cosine(a, b) {
  return dot(a.bytes, b.bytes) * a.scale * b.scale;
}

/** Test-only: clear the single-flight latch between cases. */
export function _resetNearDupeSweepForTest() {
  sweepInFlight = false;
}

/**
 * Progress line for the JobsPanel. Reports photos GROUPED rather than photos
 * scanned, because "1,203 scanned" tells the user nothing they can act on
 * while "18 groups found" is the actual result.
 * @param {{done: number, total: number}} counters
 * @returns {{done: number, phase: string}}
 */
export function nearDupeProgress({ done, total }) {
  return {
    done,
    phase: `${done.toLocaleString()} of ${total.toLocaleString()} photos compared`,
  };
}
