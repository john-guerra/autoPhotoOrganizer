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
 * @param {() => Promise<void>} [opts.idle]
 * @param {(row: any) => (number|string)} [opts.idOf] identity for the
 *   stall guard below. Defaults to `(row) => row.id` — every row in this
 *   codebase's sweeps has a numeric `id`. Override only if a caller's rows
 *   key on something else.
 * @returns {Promise<{done: number, failed: number, paused: boolean}>} `done`
 *   counts BOTH successfully-written rows and permanently-failed
 *   (sentinel-marked) rows — it is "rows classified", not "rows written".
 */
export async function runSweep(
  job,
  {
    nextBatch,
    process,
    markFailed,
    folderOf,
    onProgress,
    idle = whenIdle,
    idOf = (row) => row.id,
  }
) {
  let done = 0;
  let failed = 0;
  // Every id we have called markFailed on this sweep. Both real callers of
  // runSweep are SQL-backed (`nextBatch` re-queries), and better-sqlite3
  // hands back a FRESH row object on every `.all()` — never the same
  // reference twice, even for the identical row. So the stall guard below
  // cannot compare by object identity; it has to compare by id.
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
            "it again — markFailed must remove the row from the worklist, " +
            "or the sweep cannot terminate"
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
            return { done, failed, paused: true };
          }
          // The folder is present, but the error itself may still be a
          // property of the moment (EMFILE storm, a flaky external/network
          // volume) rather than of the file — see TRANSIENT_CODES above. Same
          // response as the unreachable-folder case: stand the whole sweep
          // down and mark nothing, rather than writing a permanent sentinel
          // for a file that was never really examined.
          if (TRANSIENT_CODES.has(err?.code)) {
            onProgress?.({ done, failed });
            return { done, failed, paused: true };
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
