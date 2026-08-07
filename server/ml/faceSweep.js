/**
 * Draining the face backlog (#166).
 *
 * Deliberately THIN. `runSweep` (sweep.js) already owns the batch loop, the
 * idle gate, the stall guard, and — most importantly — the transient/permanent
 * classification that decides whether a failure earns a sentinel or a pause.
 * Re-implementing any of that here would be the same mistake as the six
 * hand-copied feed guards that caused #35, #36 and #39: this file is an
 * adapter, not a second drain.
 *
 * ## Why a HOST failure pauses instead of marking photos failed
 *
 * A missing model, an unmounted drive, an out-of-memory ONNX session — none of
 * these tell us anything about the PHOTO. Marking one failed is a false
 * statement about the user's library that outlives its cause, because
 * sentinels only clear when a file's bytes change. #169 excluded a whole
 * unplugged drive from hashing forever exactly this way. So `isTransient`
 * below deliberately treats model/session errors as transient — the honest
 * answer for a host-level failure is "stand down and say why", not "these
 * 32,000 photos are unreadable".
 */
import { runSweep, isTransientCode } from "./sweep.js";
import { pendingFaceRows, putFaces, markFaceFailed } from "../db/faces.js";
import { faceModelById } from "./faceModels.js";
import { quantize } from "./quantize.js";
import { join } from "node:path";

/** Photos per batch. Small, because each one may hold a full-resolution
 *  bitmap in the worker — this library's p90 is 20 MP, i.e. 60 MB decoded. A
 *  batch of 64 would be 4 GB of RSS for no throughput gain, since inference
 *  is serial on CPU anyway. */
export const FACE_BATCH = 8;

/**
 * How many face passes are live right now.
 *
 * ## This is OBSERVATIONAL. It is no longer a latch (#279).
 *
 * It used to be both, and being both is what John reported: a boolean that
 * said "a sweep is running" AND refused the second caller. The refusal was
 * wrong, and not because refusing is rude — because of WHERE it sat. The
 * scheduler wraps every sweep (`scheduler.submit`, api.js), so when a scoped
 * request arrives the background run is correctly PARKED at its checkpoint —
 * but a parked run is still inside `drain()`, so it still held this flag, and
 * the scoped run the scheduler had just promoted was refused by the very run
 * it had just parked. Pressing the button did nothing, which is exactly the
 * report.
 *
 * Mutual exclusion now lives where it can be released at a park:
 * `resource: RESOURCE.ONNX` on the submit. `checkpoint()` drops the lease
 * BEFORE it waits, so a parked run blocks nobody, and a second sweep WAITS
 * (visibly, as a parked job) instead of being told no.
 *
 * ## Why a COUNTER and not a boolean
 *
 * Because runs now queue, two are legitimately alive at once: one executing,
 * one parked at its first checkpoint. With a boolean the finisher clears the
 * flag while the parked run is still live, and every guard below silently
 * goes blind at exactly the wrong moment. Same reason `lib/interactive.js`
 * counts.
 *
 * ## What still reads it, and why that is not the bug
 *
 * The DESTRUCTIVE routes: `faces/purge`, `faces/retry-failed`,
 * `faces/cluster` and `people/merge-bulk`. Those are not "one sweep at a
 * time" — they are "do not throw away a grouping / purge vectors out from
 * under a running scan", and a 409 is the right answer to them. They stay.
 */
let live = 0;

/** Is any face pass live (running OR parked)? See the note above: this
 *  answers the destructive routes, and no longer refuses a second sweep. */
export function isFaceSweepInFlight() {
  return live > 0;
}

/** Tests only. `finally` already decrements on any exit path, but a test
 *  that deliberately explodes mid-sweep needs a way back to a known state. */
export function _resetFaceSweepForTest() {
  live = 0;
}

/**
 * Sweep the library (or a scope) for faces.
 *
 * @param {object} args
 * @param {import("better-sqlite3").Database} args.db
 * @param {string} args.modelId
 * @param {{detect: (row: {path: string}) => Promise<{faces: Array<{box: number[], score: number, vector: Float32Array}>, skipped: number}>}} args.engine
 *   Injected so this is testable without ONNX — the real one calls the worker.
 * @param {object} [args.job] cancellation handle, as runSweep expects
 * @param {(p: {done: number, failed: number}) => void} [args.onProgress]
 * @param {(ctx: {faces: number}) => Promise<void>} [args.afterBatch] awaited
 *   after each COMMITTED batch, with the running face count. The seam exists so
 *   a caller can do cross-photo work — filing faces into people (#304) —
 *   without this module knowing that people exist. It is a safe point by
 *   construction: the batch is committed, and it is where the sweep already
 *   yields and checks for cancellation.
 * @param {number[]|null} [args.scopeIds] #221 — restrict the worklist to these
 *   photo ids (the user's selection, or what is on screen). `null` sweeps the
 *   library. An explicitly EMPTY array means "no photos" and is honoured as
 *   such by pendingFaceRows, never widened.
 * @returns {Promise<{done: number, failed: number, faces: number, paused: boolean, pauseReason?: string}>}
 */
export async function sweepFaces({
  db,
  modelId,
  engine,
  job,
  onProgress,
  afterBatch,
  scopeIds = null,
  /** Preemption (#257); a no-op by default so existing callers are unchanged. */
  checkpoint = async () => {},
}) {
  const model = faceModelById(modelId);
  let faces = 0;
  live++;
  try {
    return await drain();
  } finally {
    // `finally`, not a line after the await: a throw, a cancel, or a pause
    // must all decrement. Leaving it raised makes every destructive route
    // (purge, retry-failed, cluster) refuse for the rest of the process's
    // life, and the only symptom is a button that does nothing.
    live--;
  }

  async function drain() {
    const result = await runSweep(job, {
      checkpoint,
      nextBatch: (limit) =>
        pendingFaceRows(db, modelId, limit ?? FACE_BATCH, scopeIds),
      folderOf: (row) => row.folder_abs_path,
      onProgress,
      isTransient,
      process: async (rows) => {
        for (const row of rows) {
          const path = join(row.folder_abs_path, row.filename);
          const found = await engine.detect({ ...row, path });
          // Written even when EMPTY. "No faces" is a result, and the worklist
          // can only ask whether a marker exists — without this, every
          // landscape is pending forever. See db/faces.js.
          putFaces(db, {
            photoId: row.id,
            model: modelId,
            faces: found.faces.map((f) => {
              const { scale, bytes } = quantize(f.vector);
              return {
                box: f.box,
                score: f.score,
                dim: model.dim,
                scale,
                bytes,
              };
            }),
          });
          faces += found.faces.length;
        }
        // Cross-photo work the caller wants doing as the sweep goes, at a
        // point where the batch is durable (#304). Awaited, so it cannot
        // overlap the next batch.
        await afterBatch?.({ faces });
        // runSweep does `done += await process(batch)`, so this MUST return a
        // count. Returning undefined makes `done` NaN, every comparison against
        // it false, and the drain never terminates — silently, at full CPU.
        return rows.length;
      },
      markFailed: (row, err) =>
        markFaceFailed(db, row.id, modelId, err?.message ?? String(err)),
    });

    return { ...result, faces };
  }
}

/**
 * "Is this failure a property of the MOMENT rather than of this photo?"
 *
 * Extends the errno-only default with the host-level failures this stage can
 * hit. Each of these would otherwise write a permanent "cannot be processed"
 * sentinel onto a photo that is perfectly fine.
 *
 * @param {any} err
 * @returns {boolean}
 */
export function isTransient(err) {
  if (isTransientCode(err)) return true;
  const m = String(err?.message ?? err);
  return (
    // The weights are absent, corrupt, or still downloading.
    /checksum|incomplete|Couldn't download|no such file|ENOENT/i.test(m) ||
    // The session died or could not be built — the worker's problem, not the
    // photo's. A crashed child takes the whole batch with it.
    /worker (exited|died|not running)|onnxruntime|session|out of memory|ENOMEM/i.test(
      m
    )
  );
}
