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
 * @returns {Promise<{done: number, failed: number, paused: boolean}>} `done`
 *   counts BOTH successfully-written rows and permanently-failed
 *   (sentinel-marked) rows — it is "rows classified", not "rows written".
 */
export async function runSweep(
  job,
  { nextBatch, process, markFailed, folderOf, onProgress, idle = whenIdle }
) {
  let done = 0;
  let failed = 0;
  // The set of row references `nextBatch` handed us last pass. If the SAME
  // rows (by reference) come back unchanged — same size, same members — a
  // full pass just ran and classified nothing that actually left the
  // caller's worklist. That is the general shape of a caller-contract bug
  // (most concretely: `markFailed` not removing its row — see below), and
  // the counters alone can't see it: `done`/`failed` are credited per
  // classification, so a row that keeps failing and keeps getting
  // `markFailed`-ed (without ever leaving the worklist) makes the counters
  // climb forever while the sweep itself never converges.
  let previousBatch = null;

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

    if (
      previousBatch &&
      batch.length === previousBatch.size &&
      batch.every((row) => previousBatch.has(row))
    ) {
      // Nothing in this project fails silently (CLAUDE.md, "Usability").
      // runSweep is the shared foundation every future sweep lands on, so a
      // caller mistake here must be loud, not a hang with no error anywhere.
      throw new Error(
        `runSweep made no progress on a batch of ${batch.length} rows: ` +
          "markFailed must remove the row from nextBatch's worklist (and " +
          "process must remove rows it successfully writes), or the sweep " +
          "cannot terminate"
      );
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
    previousBatch = new Set(batch);
  }
  return { done, failed, paused: false };
}
