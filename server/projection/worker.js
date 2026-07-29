/**
 * The projection worker (#232).
 *
 * WHY A WORKER THREAD, since a comment is cheaper than rediscovering it:
 * umap-js's `initializeFit` is a SINGLE 14.1-second call with no callback at
 * 25,758 points, peaking at 1,825 MB. There is no yield point inside it, so
 * #231's "budget the yield in comparisons" fix does not apply, and a 14-second
 * event-loop block is exactly the disconnect #231 was filed for. A worker
 * gives three things by construction rather than by discipline:
 *
 *   1. a separate heap, so the peak lives and dies here;
 *   2. a cancel that works DURING the unyieldable phase (`terminate()`);
 *   3. `resourceLimits`, which turns an OOM from a silent process crash into a
 *      catchable, reportable job failure.
 *
 * INVARIANT: this file never touches SQLite and imports nothing native. The
 * parent reads centroids, transfers one buffer, this returns coordinates, the
 * parent writes. So better-sqlite3's ABI trap (AGENT-NOTES, "a one-way
 * switch") stays entirely outside it, there is nothing to electron-rebuild,
 * and the whole native surface is zero.
 */
import { parentPort, workerData } from "node:worker_threads";
import { UMAP } from "umap-js";
import { TSNE } from "@keckelt/tsne";
import { PCA } from "ml-pca";
import { mulberry32, gaussianFrom } from "./seededRandom.js";

const post = (msg, transfer) => parentPort.postMessage(msg, transfer);

/** The nested `number[][]` every one of these libraries wants. */
function toRows(buf, n, dim) {
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    rows[i] = Array.from(buf.subarray(i * dim, (i + 1) * dim));
  }
  return rows;
}

function flatten(pairs, n) {
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    // A non-finite coordinate is a dot that cannot be drawn, cannot be
    // hit-tested, and poisons fitExtent for the WHOLE map — one NaN and every
    // other point collapses to a corner. Fail loudly here instead.
    const x = pairs[i][0];
    const y = pairs[i][1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(
        `projection produced a non-finite coordinate at point ${i} (${x}, ${y})`
      );
    }
    out[i * 2] = x;
    out[i * 2 + 1] = y;
  }
  return out;
}

const ALGO = {
  /**
   * Approximate kNN (random-projection trees + NN-descent), which is why this
   * is ~20x faster than an exact-kNN implementation in 512 dimensions, where a
   * BallTree degenerates to linear scan.
   */
  umap(rows, n, params) {
    post({ type: "phase", phase: "Building the neighbour graph" });
    const umap = new UMAP({
      nComponents: 2,
      nNeighbors: Math.min(params.nNeighbors, Math.max(2, n - 1)),
      minDist: params.minDist,
      nEpochs: params.nEpochs,
      random: mulberry32(params.seed),
    });
    umap.initializeFit(rows);

    post({ type: "phase", phase: "Laying out" });
    // Epochs are UNIFORM work, unlike clusterFaces' upper triangle, so an
    // epoch-index bar is honest here and the "progress is work, not items"
    // rule does not bite. Said out loud so nobody "fixes" it.
    for (let i = 0; i < params.nEpochs; i++) {
      umap.step();
      if (i % 8 === 0)
        post({ type: "progress", done: i, total: params.nEpochs });
    }
    return umap.getEmbedding();
  },

  /**
   * O(n^2) per step. Gated to small member counts by `algorithms.js`, which is
   * the only thing standing between the user and a 47-minute layout.
   */
  tsne(rows, n, params) {
    post({ type: "phase", phase: "Measuring distances" });
    const t = new TSNE({
      epsilon: 10,
      // Perplexity above n/3 makes the conditional distributions degenerate.
      perplexity: Math.max(2, Math.min(30, Math.floor(n / 3))),
      dim: 2,
    });
    // The ONLY source of randomness in tsnejs, and it calls Math.random.
    // Overriding it is what makes a cached t-SNE map honest — there is no seed
    // option. See seededRandom.js.
    t.gaussRandom = gaussianFrom(mulberry32(params.seed));
    t.initDataRaw(rows);

    post({ type: "phase", phase: "Laying out" });
    for (let i = 0; i < params.nEpochs; i++) {
      t.step();
      if (i % 8 === 0)
        post({ type: "progress", done: i, total: params.nEpochs });
    }
    return t.getSolution();
  },

  /**
   * Deterministic by construction. Kept in the menu as a fast, honestly-labelled
   * baseline: it separates people about as well as chance (7% top-5 measured),
   * which makes it useful for telling "the map is wrong" from "the data is
   * wrong", and useless for merging from.
   */
  pca(rows, n, params) {
    post({ type: "phase", phase: "Projecting" });
    const p = new PCA(rows);
    post({ type: "progress", done: params.nEpochs, total: params.nEpochs });
    return p.predict(rows, { nComponents: 2 }).to2DArray();
  },
};

async function main() {
  const { buffer, n, dim, algorithm, params } = workerData;

  const run = ALGO[algorithm];
  if (!run) throw new Error(`unknown algorithm: ${algorithm}`);
  if (!n) throw new Error("nothing to project");

  let flat = new Float32Array(buffer);
  const rows = toRows(flat, n, dim);
  // Drop the flat view before the graph phase peaks. 52.8 MB at production
  // size, and V8 cannot reclaim it while this binding is alive.
  flat = null;

  const pairs = run(rows, n, params);
  post({ type: "progress", done: params.nEpochs, total: params.nEpochs });

  const xy = flatten(pairs, n);
  post({ type: "done", xy }, [xy.buffer]);
}

main().catch((e) => {
  // Rethrow OUT of the promise so the parent's 'error' event carries a real
  // Error with a real stack. Structured clone preserves message and stack but
  // not custom properties, so the parent tags rather than reads.
  setTimeout(() => {
    throw e;
  });
});
