/**
 * The LIVE preview worker (#327).
 *
 * Unlike `worker.js`, which projects once and exits, this one stays alive and
 * holds two things: the member vectors, and ONE k-nearest-neighbour graph built
 * at `maxK`. Every parameter change after that reuses the graph.
 *
 * WHY, with the measurement, since it is the whole justification: on the real
 * library (203 people) building the kNN is 151 ms of a 203 ms projection.
 * Reusing it answers a slider tick in 61-117 ms — the difference between a
 * control that follows your finger and one that does not.
 *
 * ## Slicing is the subtle part, and getting it wrong is silent
 *
 * `fuzzySimplicialSet` passes `nNeighbors` to `smoothKNNDistance` while reading
 * the rows we hand it. So setting a k=60 graph and asking for `nNeighbors=15`
 * sizes the sigmas for one k and builds the graph from another — a wrong map,
 * with nothing failing. We therefore slice each row to k OURSELVES before
 * `setPrecomputedKNN`.
 *
 * Slicing is EXACT rather than approximate: a kNN list is sorted by distance,
 * so the first k entries are precisely the k nearest. One build at the largest
 * k any request can ask for therefore serves the entire slider range.
 *
 * INVARIANT, the same one `worker.js` states and for the same reason: this file
 * never touches SQLite and imports nothing native, so better-sqlite3's ABI trap
 * stays entirely outside it.
 */
import { parentPort, workerData } from "node:worker_threads";
import { UMAP } from "umap-js";
import { mulberry32 } from "./seededRandom.js";

const { buffer, n, dim, maxK } = workerData;

const flat = new Float32Array(buffer);
/** The nested `number[][]` umap-js wants, built once and reused every request. */
const rows = new Array(n);
for (let i = 0; i < n; i++) {
  rows[i] = Array.from(flat.subarray(i * dim, (i + 1) * dim));
}

// Build the graph ONCE, at the largest k any request can ask for. nEpochs is 1
// because we only want `initializeFit`'s kNN — the layout is thrown away.
const k = Math.min(maxK, Math.max(2, n - 1));
const seed = new UMAP({
  nComponents: 2,
  nNeighbors: k,
  nEpochs: 1,
  random: mulberry32(1),
});
seed.initializeFit(rows);
const knnIndices = seed.knnIndices;
const knnDistances = seed.knnDistances;

parentPort.postMessage({ type: "ready", k });

parentPort.on("message", (msg) => {
  if (msg?.type !== "run") return;
  const { id, params } = msg;
  try {
    // Never ask for more neighbours than the graph holds. Apply — which runs
    // cold through `runProjection` — honours the user's real number; a preview
    // above the cap is a preview, and saying so is the panel's job.
    const want = Math.max(2, Math.min(params.nNeighbors, k));
    const umap = new UMAP({
      nComponents: 2,
      nNeighbors: want,
      minDist: params.minDist,
      nEpochs: params.nEpochs,
      random: mulberry32(params.seed),
    });
    umap.setPrecomputedKNN(
      knnIndices.map((r) => r.slice(0, want)),
      knnDistances.map((r) => r.slice(0, want))
    );
    umap.initializeFit(rows);
    for (let e = 0; e < params.nEpochs; e++) umap.step();

    const pairs = umap.getEmbedding();
    const xy = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const x = pairs[i][0];
      const y = pairs[i][1];
      // One non-finite coordinate poisons fitExtent for the WHOLE map and
      // collapses every other point into a corner — the same guard, and the
      // same reasoning, as `flatten` in worker.js.
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(
          `preview produced a non-finite coordinate at point ${i} (${x}, ${y})`
        );
      }
      xy[i * 2] = x;
      xy[i * 2 + 1] = y;
    }
    parentPort.postMessage({ type: "done", id, xy }, [xy.buffer]);
  } catch (e) {
    // A failed preview must not take the session down: the next parameter the
    // user tries may be perfectly fine.
    parentPort.postMessage({
      type: "failed",
      id,
      message: String(e?.message ?? e),
    });
  }
});
