import { join } from "node:path";
import { whenIdle } from "../lib/interactive.js";
import { runSweep } from "./sweep.js";
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
 * @returns {Promise<{embedded: number, failed: number, paused: boolean, alreadyRunning?: boolean}>}
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
  }
) {
  if (embedInFlight)
    return { embedded: 0, failed: 0, paused: false, alreadyRunning: true };
  embedInFlight = true;

  try {
    const spec = modelById(model);
    await ml.configure({ modelId: model, threads });

    const { done, failed, paused } = await runSweep(job, {
      nextBatch: () => pendingEmbedRows(db, model, limit),
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
        const vectors = await ml.embedImages(buffers);
        // Structural, not per-implementation: models.js names "a model whose
        // output shape we have not checked writes plausible vectors of the
        // wrong dimension, which nothing downstream can detect" as the exact
        // hazard the model allowlist exists to avoid. Today's only host (the
        // ONNX worker) happens to validate shape worker-side, but Task 11
        // adds a second host (WebGPU) with its own extraction path and no
        // guarantee of the same check — so a bad-shape vector must fail HERE,
        // not silently quantize and poison every future ranking.
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
      onProgress: onProgress ?? undefined,
      idle,
    });

    return { embedded: done - failed, failed, paused };
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
export function embedProgress({ done, failed }) {
  const embedded = done - failed;
  const phase =
    failed > 0
      ? `${embedded.toLocaleString()} embedded · ${failed} failed`
      : `${embedded.toLocaleString()} embedded`;
  return { done: embedded, phase };
}
