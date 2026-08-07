import { whenIdle } from "../lib/interactive.js";
import { reachable } from "../lib/reachable.js";

/**
 * Error codes that are a property of the MOMENT, not the file: out-of-fds
 * (EMFILE/ENFILE — genuinely plausible here, since full-file SHA-1 read
 * streams run concurrently with sharp/ffmpeg against a 16-slot libuv
 * threadpool), and ordinary hiccups on external/network volumes or a drive
 * that is spinning down rather than fully unmounted (EIO, EBUSY, ESTALE,
 * ENXIO, ENODEV, EAGAIN, ETIMEDOUT).
 *
 * Misclassifying any of these as PERMANENT is the #169 failure shape through
 * a different trigger — and now unrecoverable, because the one-time repair
 * migration already consumed `user_version = 1` and will not run again. So
 * this set deliberately errs toward pausing: everything in it, and only what
 * is in it, gets a pause instead of a sentinel. ENOENT is deliberately NOT
 * here — with the folder present, ENOENT means the file really is gone,
 * which IS permanent and is already the documented behaviour.
 */
const TRANSIENT_CODES = new Set([
  "EMFILE",
  "ENFILE",
  "EAGAIN",
  "EBUSY",
  "EIO",
  "ESTALE",
  "ENXIO",
  "ENODEV",
  "ETIMEDOUT",
]);

/**
 * The DEFAULT classifier: errno-based, and the only thing `enrich` and
 * `hashing` ever needed — every failure they can see comes from a filesystem
 * call, so the file's own errno is the whole story.
 *
 * A caller whose work goes through something OTHER than the filesystem (the
 * embedder, whose encoder lives in another process) must override
 * `opts.isTransient`, because that boundary loses the errno: an error crossing
 * a stdio protocol is reconstructed from a STRING and has no `code` at all, so
 * this returns false for it and the row would be sentinel-marked for a failure
 * that says nothing about the photo. See embedSweep.js's own isTransient.
 * @param {any} err
 * @returns {boolean}
 */
export function isTransientCode(err) {
  return TRANSIENT_CODES.has(err?.code);
}

/**
 * ONE background drain, reused by every sweep in the app.
 *
 * `/api/enrich` and `hashAllPending` were the same loop written twice by hand.
 * They had already diverged (enrich had a job, progress, cancellation and
 * per-file isolation; the hasher had none) and the hand-rolled copy shipped a
 * termination bug the shared version would not have — #169. This is the same
 * consolidation CLAUDE.md describes for the feed-window guard, and for the same
 * reason: six hand-copies caused two shipped bugs.
 *
 * THE SPLIT THAT MATTERS: the caller owns the sentinel WRITE, `runSweep` owns
 * the CLASSIFICATION.
 *
 * The three sentinels in this codebase are not interchangeable and must not be
 * unified — enrich overloads data columns (width=0, lens=""), hashing uses a
 * boolean (hash_attempted=1), and a future ML stage needs an explicit row
 * because a failed embedding has no natural zero value. So the write stays a
 * callback. But "is this failure the photo's fault or the moment's?" is exactly
 * what each hand-rolled copy got to answer for itself, and it is what the
 * hasher got wrong. That answer lives here, once.
 *
 * @param {{controller: AbortController}|null} job registry job, or null
 * @param {object} opts
 * @param {() => Array<any>} opts.nextBatch rows still owed work — RE-QUERIED
 *   each pass, so the worklist is SQL and a crash costs one batch, not the backlog
 * @param {(rows: Array<any>) => Promise<number>} opts.process writes; returns count
 * @param {(row: any, err: Error) => void} opts.markFailed the sentinel write.
 *   LOAD-BEARING for termination: `nextBatch` is re-queried every pass, so the
 *   only reason the loop ends is that a classified row (successfully processed
 *   OR marked) stops coming back. If `markFailed` doesn't remove its row from
 *   whatever `nextBatch` reads, that row recurs forever — `runSweep` detects
 *   the stall (the same batch coming back with nothing changed) and throws
 *   rather than hanging, but the fix is always in the caller's `markFailed`.
 * @param {(row: any) => string} opts.folderOf folder abs_path, for the probe
 * @param {(p: {done: number, failed: number}) => void} [opts.onProgress]
 * @param {(err: any) => boolean} [opts.isTransient] "is this failure a
 *   property of the MOMENT rather than of this photo?" Defaults to
 *   `isTransientCode` (errno only), which is what `enrich` and `hashing`
 *   have always used. A caller whose work can fail for reasons that are
 *   neither the file's nor the moment's — a broken ENCODER, a model that
 *   won't download — overrides this, because the honest answer for a
 *   HOST-level failure is also "pause": it teaches us nothing about the
 *   photo, and a sentinel written from it is a false statement about the
 *   user's library (#161 final review, Critical 1).
 * @param {() => Promise<void>} [opts.idle]
 * @param {(row: any) => (number|string)} [opts.idOf] identity for the
 *   stall guard below. Defaults to `(row) => row.id` — every row in this
 *   codebase's sweeps has a numeric `id`. Override only if a caller's rows
 *   key on something else.
 * @returns {Promise<{done: number, failed: number, paused: boolean,
 *   pauseReason?: string}>} `done` counts BOTH successfully-written rows and
 *   permanently-failed (sentinel-marked) rows — it is "rows classified", not
 *   "rows written". `pauseReason` is present only when `paused` is true, and
 *   exists so the caller can tell the user WHY it stood down: "drive not
 *   available" and "the model could not be downloaded" are different
 *   problems with different fixes, and reporting the first for the second is
 *   the same class of false statement this whole classification exists to
 *   avoid.
 */
export async function runSweep(
  job,
  {
    nextBatch,
    process,
    markFailed,
    folderOf,
    onProgress,
    isTransient = isTransientCode,
    idle = whenIdle,
    idOf = (row) => row.id,
    /**
     * Preemption (#257). Awaited at the TOP of the drain loop and nowhere
     * else, so a park can never interrupt a batch in flight: the worst case
     * is finishing the current one, ~2.5s for faces and well under a second
     * for the rest, with nothing thrown away.
     *
     * Defaults to a no-op so every existing caller is unchanged and this file
     * stays runnable with no scheduler at all.
     */
    checkpoint = async () => {},
  }
) {
  let done = 0;
  let failed = 0;
  // Every id we have called markFailed on this sweep. Both real callers of
  // runSweep are SQL-backed (`nextBatch` re-queries), and better-sqlite3
  // hands back a FRESH row object on every `.all()` — never the same
  // reference twice, even for the identical row. So the stall guard below
  // cannot compare by object identity; it has to compare by id.
  //
  // NOT AN ABSOLUTE INVARIANT, and the guard's error must not be read as
  // "the caller has a bug" without checking this first. A sentinel written
  // by THIS sweep can legitimately be deleted underneath it by something
  // else in the same process, which puts the row straight back in
  // `nextBatch`'s result:
  //   - purgeModel() (POST /api/ml/purge) — deletes every ml_status row for
  //     the model; the route and the settings panel's Purge button both
  //     refuse while a sweep is in flight for exactly this reason, and the
  //     new POST /api/ml/retry-failed refuses for the same one.
  //   - clearMlArtifactsFor() from upsertScan (server/db/photos.js) — a
  //     CONCURRENT SCAN of a folder whose files changed clears their
  //     sentinels. Nothing gates that, and nothing should: the scan is
  //     right, the vector really is stale.
  // Both are rare, both are user-triggered, and the cost is one aborted
  // sweep that the next scan restarts — hence a loud error rather than
  // silent looping. See the throw below for the wording the user gets.
  const failedIds = new Set();

  const abortIfCanceled = () => {
    if (job?.controller.signal.aborted) {
      const e = new Error("canceled");
      e.name = "AbortError";
      throw e;
    }
  };

  for (;;) {
    abortIfCanceled();
    // Park here if something higher-priority is waiting (#257). Deliberately
    // BEFORE `idle()`: a preempted sweep should stand aside immediately rather
    // than first waiting for the user to stop interacting.
    await checkpoint();
    // AGAIN, because the cancel may have arrived while we were parked (#344).
    // `checkpoint()` returns rather than throwing on a cancelled run — it does
    // not get to decide what stopping means — so without this the sweep would
    // fall through to a whole further batch (idle, nextBatch, process) before
    // the check at the top of the loop came round, making a parked cancel
    // unbounded where a running one costs at most the batch in flight.
    abortIfCanceled();
    // Let the user go first. A full-library sweep will happily starve the
    // thumbnails the user is actually waiting on (measured: 15ms -> 90ms, tiles
    // abandoned mid-scroll). State-driven, not timer-driven — see
    // lib/interactive.js.
    await idle();
    const batch = nextBatch();
    if (!batch.length) break;

    // THE STALL GUARD. nextBatch() is re-queried every pass with no
    // visited-set of its own — the loop only terminates because a row that
    // gets marked failed is expected to leave whatever nextBatch reads. If
    // it comes back anyway, that removal didn't happen: the caller's
    // markFailed has a bug, and looping again would just retry it forever
    // with no error anywhere. Nothing in this project fails silently
    // (CLAUDE.md, "Usability") — runSweep is the shared foundation every
    // future sweep lands on, so this has to be loud here, once.
    for (const row of batch) {
      const id = idOf(row);
      if (failedIds.has(id)) {
        throw new Error(
          `runSweep: row ${id} was marked failed but nextBatch() returned ` +
            "it again, so the sweep cannot terminate. Either something " +
            "cleared that record while the sweep was running (a purge, a " +
            "retry-failed, or a rescan of the same folder) — in which case " +
            "just start it again — or markFailed is not removing the row " +
            "from the worklist, which is a bug in the caller"
        );
      }
    }

    try {
      done += await process(batch);
    } catch {
      // One unreadable file must not kill a 100k sweep. Retry one at a time so
      // the bad file is isolated and the rest of the batch still lands.
      for (const row of batch) {
        abortIfCanceled();
        try {
          done += await process([row]);
        } catch (err) {
          // Re-check: cancel can arrive WHILE process([row]) is in flight and
          // still reject with an ordinary (non-Abort) error. Without this
          // check that race would fall through to markFailed and write a
          // sentinel for a row the sweep never actually finished looking at
          // — after the user already asked to stop.
          abortIfCanceled();
          // THE #169 CLASSIFICATION. A missing FOLDER means the volume went
          // away, and nothing in this pass is processable — so stop, and mark
          // NOTHING. Marking here is what excluded those photos forever:
          // upsertScan only clears a sentinel when size/mtime change, and an
          // unmount changes neither. Pausing costs one resumed pass; marking
          // costs the data.
          if (!reachable(folderOf(row))) {
            onProgress?.({ done, failed });
            return {
              done,
              failed,
              paused: true,
              pauseReason: "drive not available",
            };
          }
          // The folder is present, but the error itself may still be a
          // property of the moment (EMFILE storm, a flaky external/network
          // volume) rather than of the file — see TRANSIENT_CODES above — or
          // of the TOOL doing the work rather than of the photo it was
          // pointed at, which is what embedSweep's own isTransient adds. Same
          // response as the unreachable-folder case: stand the whole sweep
          // down and mark nothing, rather than writing a permanent sentinel
          // for a file that was never really examined.
          if (isTransient(err)) {
            onProgress?.({ done, failed });
            return {
              done,
              failed,
              paused: true,
              pauseReason: String(err?.message ?? err),
            };
          }
          // Folder is there and the error is not transient: the file is
          // genuinely gone or genuinely unreadable. That IS a permanent
          // property of the photo, so the caller writes its sentinel and the
          // row leaves the worklist.
          markFailed(row, err);
          failedIds.add(idOf(row));
          done += 1;
          failed += 1;
        }
      }
    }
    onProgress?.({ done, failed });
  }
  return { done, failed, paused: false };
}
