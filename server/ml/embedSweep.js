import { join } from "node:path";
import { whenIdle } from "../lib/interactive.js";
import { runSweep, isTransientCode } from "./sweep.js";
import { markHostFailure, isHostFailure } from "./MLService.js";
import { thumbBytes } from "./thumbSource.js";
import { quantize } from "./quantize.js";
import { modelById } from "./models.js";
import {
  pendingEmbedRows,
  putEmbeddings,
  markEmbedFailed,
} from "../db/embeddings.js";

let embedInFlight = false;

/**
 * Whether a sweep is currently running, checked synchronously — the same
 * flag `embedAllPending` sets as its own first statement, before any
 * `await`. A caller that wants to distinguish "I kicked it" from "something
 * else already has the single-flight latch" (the explicit `/api/ml/embed`
 * route — see api.js's kickEmbedSweep) can check this INSTEAD of calling
 * embedAllPending and discovering `alreadyRunning` only after a job row was
 * created and immediately self-cleared, which a caller has no way to read
 * back (#161 fix round 1, Important 2).
 * @returns {boolean}
 */
export function isEmbedInFlight() {
  return embedInFlight;
}

/**
 * Embed the whole library's pending photos in the background, to completion.
 *
 * The drain, the idle gating, cancellation, poison-file isolation and — most
 * importantly — the permanent/transient CLASSIFICATION all live in runSweep.
 * What stays here is what is genuinely embedding's own: the worklist query, the
 * thumbnail read, the encoder call, and the sentinel WRITE.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ml: object, processing: object, model: string, threads?: number,
 *          limit?: number, idle?: () => Promise<void>, job?: object|null,
 *          onProgress?: (c: {done: number, failed: number}) => void|null}} opts
 * @returns {Promise<{embedded: number, failed: number, paused: boolean,
 *   pauseReason?: string, alreadyRunning?: boolean}>}
 */
export async function embedAllPending(
  db,
  {
    ml,
    processing,
    model,
    threads = 1,
    limit = 16,
    idle = whenIdle,
    job = null,
    onProgress = null,
    scopeIds = null,
    device = "auto",
  }
) {
  if (embedInFlight)
    return { embedded: 0, failed: 0, paused: false, alreadyRunning: true };
  embedInFlight = true;

  try {
    const spec = modelById(model);
    // "auto" is the ABSENCE of a pin, not a device name: the worker branches
    // on `config.device ? [device] : candidateDevices()`, so sending the
    // string "auto" through would have it try to build a session on an
    // execution provider that does not exist (#209).
    await ml.configure({
      modelId: model,
      threads,
      device: device === "auto" ? null : device,
    });

    const { done, failed, paused, pauseReason } = await runSweep(job, {
      nextBatch: () => pendingEmbedRows(db, model, limit, scopeIds),
      process: async (rows) => {
        const buffers = [];
        for (const row of rows) {
          buffers.push(
            await thumbBytes(
              {
                path: join(row.folder_abs_path, row.filename),
                mtime: row.mtime,
                size: row.size,
                kind: row.kind,
              },
              processing
            )
          );
        }
        // Anything the ENCODER itself rejects with is a fact about the
        // encoder, not about these photos: a model that would not download,
        // a worker that died, an execution provider that throws on every
        // batch (measured, and not hypothetical — CoreML does exactly that
        // above batch=1 on this machine; see worker/devices.js). Tagged HERE
        // rather than only inside OnnxMLService so the property holds for
        // ANY host the app is handed — a test double, a future Python
        // sidecar — instead of depending on each one to cooperate.
        // OnnxMLService tags at its own boundary too, so a caller other than
        // this sweep gets the same information.
        let vectors;
        try {
          vectors = await ml.embedImages(buffers);
        } catch (err) {
          // Coerced to an Error first: markHostFailure can only tag an
          // OBJECT, so a host rejecting with a string, `null`, or
          // `undefined` (a hand-written `reject("boom")`, or a future host
          // relaying a foreign runtime's error) would come back untagged —
          // and an untagged host failure is C1 again, through a narrow door.
          throw markHostFailure(
            err instanceof Error ? err : new Error(String(err))
          );
        }
        // Structural, not per-implementation: models.js names "a model whose
        // output shape we have not checked writes plausible vectors of the
        // wrong dimension, which nothing downstream can detect" as the exact
        // hazard the model allowlist exists to avoid. The only host that
        // exists today (the ONNX worker) happens to validate shape
        // worker-side, in extractVectors (worker/embedOutput.js) — but that
        // is ITS choice, not part of the MLService contract, so nothing
        // obliges the next host to make it. Whatever crosses this boundary
        // gets checked HERE, by the side that knows what it asked for,
        // rather than silently quantizing and poisoning every future
        // ranking. (An earlier version of this comment justified the check
        // by a WebGPU host "Task 11 adds"; that host was built and then
        // deleted in 36d8b8b — the check outlived its original reason and
        // earns its keep on the contract argument alone.)
        rows.forEach((row, i) => {
          if (vectors[i]?.length !== spec.dim)
            throw new Error(
              `photo ${row.id}: model returned a ${vectors[i]?.length}-dim vector, expected ${spec.dim}`
            );
        });
        putEmbeddings(
          db,
          rows.map((row, i) => ({
            photoId: row.id,
            model,
            dim: spec.dim,
            ...quantize(vectors[i]),
          }))
        );
        return rows.length;
      },
      markFailed: (row, err) => markEmbedFailed(db, row.id, model, err),
      folderOf: (row) => row.folder_abs_path,
      // A sentinel says "this photo cannot be embedded", and only a failure
      // that is genuinely about the PHOTO earns one. Two things are not:
      // the moment (the errno set runSweep already knows about — an EMFILE
      // storm, a flaky external volume), and the HOST (the encoder, the
      // model download, the worker process). The second is what this adds,
      // and it is the more dangerous of the two here, because a host failure
      // is not per-photo at all: it fails EVERY row of EVERY batch, so
      // marking would write "tried, and could not be read" against the whole
      // library from one failed download (#161 final review, Critical 1).
      // Pausing costs one resumed pass; marking costs the truth about the
      // user's photos — and until POST /api/ml/retry-failed existed there
      // was no control anywhere in the app that could take it back.
      isTransient: (err) => isHostFailure(err) || isTransientCode(err),
      onProgress: onProgress ?? undefined,
      idle,
    });

    return { embedded: done - failed, failed, paused, pauseReason };
  } finally {
    embedInFlight = false;
  }
}

/** Test-only: clear the single-flight latch between cases. */
export function _resetEmbedSweepForTest() {
  embedInFlight = false;
}

/**
 * runSweep's `done` counts rows CLASSIFIED (written or sentinel-marked). The
 * user needs those separated: "not computed yet" and "cannot be computed" are
 * different answers, and collapsing them is how pre-2.17.14 backupCoverage
 * misled.
 * @param {{done: number, failed: number}} counters
 * @returns {{done: number, phase: string}}
 */
export function embedProgress({ done, failed }, total = undefined) {
  const embedded = done - failed;
  const phase =
    failed > 0
      ? `${embedded.toLocaleString()} embedded · ${failed} failed`
      : `${embedded.toLocaleString()} embedded`;
  // `total` makes the JobsPanel bar FILL instead of dancing (#208). It was
  // omitted originally, which left a 34,807-photo sweep rendering as an
  // indeterminate bar for ~20 minutes — the "frozen control" this project's
  // usability contract exists to prevent. Passed in rather than counted here
  // so this stays a pure formatter, and so the count is taken ONCE at the
  // start of a sweep rather than re-queried on every batch.
  return total === undefined
    ? { done: embedded, phase }
    : { done: embedded, total, phase };
}
