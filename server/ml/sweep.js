import { whenIdle } from "../lib/interactive.js";
import { reachable } from "../lib/reachable.js";

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
 * @param {(row: any, err: Error) => void} opts.markFailed the sentinel write
 * @param {(row: any) => string} opts.folderOf folder abs_path, for the probe
 * @param {(p: {done: number, failed: number}) => void} [opts.onProgress]
 * @param {() => Promise<void>} [opts.idle]
 * @returns {Promise<{done: number, failed: number, paused: boolean}>}
 */
export async function runSweep(
  job,
  { nextBatch, process, markFailed, folderOf, onProgress, idle = whenIdle }
) {
  let done = 0;
  let failed = 0;

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
          // Folder is there and the file still failed: the file is genuinely
          // gone or genuinely unreadable. That IS a permanent property of the
          // photo, so the caller writes its sentinel and the row leaves the
          // worklist.
          markFailed(row, err);
          done += 1;
          failed += 1;
        }
      }
    }
    onProgress?.({ done, failed });
  }
  return { done, failed, paused: false };
}
