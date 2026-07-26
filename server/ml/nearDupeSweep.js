import { whenIdle } from "../lib/interactive.js";
import { dot } from "./quantize.js";
import { modelById } from "./models.js";
import {
  embeddedPhotosInTimeOrder,
  replaceNearDupeGroups,
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
    const uf = new UnionFind();
    let cancelled = false;

    // Sliding window over the time-ordered rows. `lo` is the first row still
    // within `windowMs` of row i, so the inner loop only ever visits genuine
    // time-neighbours — the cost is bounded by the window's density, not by
    // the library size, which is what keeps this ~O(n) over 114k photos.
    let lo = 0;
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
      while (rows[lo].time < cur.time - windowMs) lo++;

      // Compare against every earlier photo still in the window, not merely
      // the immediately preceding one. A burst with a single intruding frame
      // (someone walks through shot 3 of 5) would otherwise break the chain
      // and split one group into two.
      for (let j = lo; j < i; j++) {
        const other = rows[j];
        // Vectors of different length cannot be compared and must never be
        // silently skipped as "not similar": that would be a wrong ANSWER
        // rather than a missing one. It can only happen if two models' rows
        // coexist under one model name, which is a bug, so it is loud.
        if (other.dim !== cur.dim)
          throw new Error(
            `photos ${other.id} and ${cur.id} have ${other.dim}- and ` +
              `${cur.dim}-dim vectors under model ${model}`
          );
        if (cosine(other, cur) >= threshold) uf.union(other.id, cur.id);
      }
    }

    // Only components with a partner are worth storing. A photo that matched
    // nothing is the overwhelmingly common case, and writing a singleton row
    // for each would make the table as large as the library to say nothing.
    const members = new Map();
    for (const row of rows) {
      const root = uf.find(row.id);
      if (!members.has(root)) members.set(root, []);
      members.get(root).push(row.id);
    }
    const out = [];
    let groupId = 0;
    for (const ids of members.values()) {
      if (ids.length < 2) continue;
      groupId++;
      for (const id of ids) out.push({ photoId: id, groupId });
    }

    // A cancelled pass must not replace the stored grouping with its partial
    // work: half a grouping is not a smaller grouping, it is a WRONG one —
    // every group whose members lie beyond the cancellation point silently
    // loses them, and nothing downstream could tell that from a real answer.
    if (cancelled)
      return { photos: 0, groups: 0, scanned: total, cancelled: true };

    const written = replaceNearDupeGroups(db, model, out);
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

/** Union-find with path compression. Groups are transitive by construction:
 *  if A~B and B~C, then A, B and C are one group even when A and C never
 *  scored above the threshold themselves — which is what makes a burst that
 *  drifts across its own span hold together as a single stack. */
class UnionFind {
  #parent = new Map();

  find(x) {
    let root = x;
    while (this.#parent.has(root)) root = this.#parent.get(root);
    // Path compression: re-point everything on the way to the root, so a long
    // burst does not degrade into a linked-list walk per comparison.
    let cur = x;
    while (this.#parent.has(cur)) {
      const next = this.#parent.get(cur);
      this.#parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.#parent.set(rb, ra);
  }
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
