/**
 * Turning face vectors into people (#167).
 *
 * ## Why agglomerative-by-threshold and not k-means
 *
 * k-means needs k. Nobody knows how many people are in a photo archive, and
 * guessing wrong is not a quality question but a correctness one: too small a
 * k merges strangers into one person, too large splits a parent across four.
 * It also forces EVERY face into some cluster, and a real archive is full of
 * faces that belong to nobody in particular — a stranger in the background of
 * one photo, seen once.
 *
 * So: connect two faces when their cosine clears a threshold, and take the
 * connected components. That yields a natural "seen once, belongs to nobody"
 * outcome (a singleton), needs no k, and is what the threshold means in
 * ArcFace's own terms — its operating point is a cosine, published per model.
 *
 * ## The transitivity hazard, stated plainly
 *
 * Single-linkage components chain: A~B and B~C puts A, B and C together even
 * when A and C are nothing alike. For faces this is exactly how one cluster
 * swallows a family — a blurry face that is 0.5-similar to everyone is a
 * bridge between every person in the library.
 *
 * This is mitigated three ways rather than pretended away:
 *   1. The threshold is deliberately HIGH (ArcFace's own same-identity bar,
 *      not the middle of the distribution).
 *   2. Faces too small to embed meaningfully never get here at all — see
 *      MIN_FACE_PX in faceDetect.js, which drops the blurry bridges before
 *      they can connect anything.
 *   3. `maxDegree` caps how many neighbours one face may connect through, so
 *      a single promiscuous vector cannot fuse two otherwise-separate groups.
 *
 * It is NOT solved. #167's own text says clustering is never right the first
 * time and the user must be able to merge and split; this module produces a
 * starting point, and the durable corrections are the caller's job.
 */
import { dot } from "./quantize.js";

/**
 * The same-identity bar, as a cosine over L2-normalized embeddings.
 *
 * ## This number is NOT validated, and the measurement says why that matters
 *
 * Measured on 316 real faces from the library (buffalo_s, 2026-07-27), the
 * outcome is extremely threshold-sensitive and the low end is degenerate:
 *
 *   threshold   people   largest cluster   singletons
 *      0.40       77          171              52
 *      0.50       95          167              65
 *      0.60      106          159              71
 *      0.70      121          139              81
 *      0.75      135          127              92
 *      0.80      153           59              97
 *      0.85      172           30             102
 *
 * At 0.5 — the value this constant originally held, asserted from ArcFace's
 * published operating point rather than measured here — ONE cluster holds
 * 53% of every face found. That is either a partner photographed constantly
 * on a phone camera roll (entirely plausible: 167 of 939 photos is 18%) or
 * the transitivity chaining described above swallowing a family. Telling
 * those apart requires knowing who these people actually are, which is a
 * judgement about the user's own family and not one to make on their behalf.
 *
 * 0.8 is chosen as the default because it is where the giant component first
 * breaks up (171 → 59) rather than because it is known correct. It errs
 * toward SPLITTING, which is the recoverable direction: two clusters of one
 * person are one merge away, while a stranger inside someone's photo set is
 * hard to notice and harder to undo. The route accepts a `threshold` so this
 * can be tuned against a real answer once someone can supply one.
 */
export const SAME_PERSON_COSINE = 0.8;

/** How many neighbours one face may link through. See the transitivity note
 *  in the module doc — this is the cap that stops one promiscuous vector from
 *  fusing two separate people. */
export const MAX_DEGREE = 24;

/**
 * How many rows of the pairwise scan run before the event loop gets a turn.
 *
 * The scan is O(n^2) and this app's own library is ~10,700 faces, i.e. 57
 * million int8 dot products — tens of seconds. Run straight through, that is a
 * server that answers nothing: no thumbnails, no feed, no jobs panel, and no
 * way for the user to tell a wedge from a crash. CLAUDE.md's rule is that
 * heavy work never blocks the event loop, and clustering was the one place in
 * this feature that did.
 *
 * 512 is chosen so a yield lands roughly every few milliseconds at library
 * scale, which is often enough to keep the server responsive and rare enough
 * that the awaits are nowhere near the hot path.
 */
export const YIELD_EVERY = 512;

/** One turn of the event loop. `setImmediate` rather than `await null`, which
 *  resolves as a microtask and therefore never lets I/O run at all. */
const breathe = () => new Promise((r) => setImmediate(r));

/**
 * Single-flight latch for the grouping pass (#222).
 *
 * Two concurrent regroupings would each compute a full partition and then both
 * call `saveClusters`, which clears and rewrites every person assignment for
 * the model — the loser silently overwrites the winner with a partition
 * computed from an older read. Not corrupting, but the user sees people
 * shuffle for no reason. Mirrors `isFaceSweepInFlight`.
 */
let clusterInFlight = false;

/** @returns {boolean} */
export function isClusterInFlight() {
  return clusterInFlight;
}

/** Tests only — see faceSweep's equivalent. */
export function _resetClusterForTest() {
  clusterInFlight = false;
}

/**
 * Take the latch, run `fn`, release it on EVERY exit path (throw, abort, or
 * success). `finally`, not a line after the await: leaving it set makes every
 * later grouping a silent no-op for the life of the process, and the only
 * symptom is a button that does nothing.
 * @template T @param {() => Promise<T>} fn @returns {Promise<T>}
 */
export async function withClusterLatch(fn) {
  clusterInFlight = true;
  try {
    return await fn();
  } finally {
    clusterInFlight = false;
  }
}

/**
 * Cluster face vectors into people.
 *
 * @param {{ids: Int32Array|number[], scales: Float32Array|number[], dim: number, data: Int8Array}} vectors
 *   As returned by db/faces.js `faceVectors` — one flat int8 buffer.
 * @param {object} [opts]
 * @param {number} [opts.threshold]
 * @param {number} [opts.maxDegree]
 * @param {number} [opts.minSize] clusters smaller than this stay unassigned.
 *   1 by default, i.e. a face seen once is still a (singleton) person — see
 *   #167: "a person with no name should still be browsable".
 * @param {number} [opts.yieldEvery] rows between yields to the event loop.
 * @param {AbortSignal} [opts.signal] checked at the yield point (#222). Throws
 *   an `AbortError` there, so a cancelled pass stops within one `yieldEvery`
 *   block having written NOTHING — the union-find is in-memory and the caller
 *   saves in a single transaction at the end. A cancellation is an outcome,
 *   not a failure, and it must not leave half a regrouping on disk.
 * @param {(p: {done: number, total: number}) => void} [opts.onProgress]
 *   Reported in PAIRS COMPARED, not rows done. The loop is O(n^2) over the
 *   upper triangle, so row i does (n - i) comparisons: at half the rows, 75%
 *   of the work is already behind you. A bar driven by `i / n` would crawl and
 *   then leap, which is the "honest progress" half of UI-CONTRACTS §2.
 * @returns {Promise<{clusters: Array<number[]>, singletons: number[]}>}
 *   `clusters` are arrays of FACE ids, largest first — which is the order #167
 *   wants for naming, since ten minutes spent on the biggest clusters covers
 *   most of a library.
 */
export async function clusterFaces(vectors, opts = {}) {
  const {
    threshold = SAME_PERSON_COSINE,
    maxDegree = MAX_DEGREE,
    minSize = 1,
    yieldEvery = YIELD_EVERY,
    signal,
    onProgress,
  } = opts;
  const { ids, scales, dim, data } = vectors;
  const n = ids.length;
  if (!n || !dim) return { clusters: [], singletons: [] };

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const degree = new Int32Array(n);

  const find = (x) => {
    // Path halving — iterative, because a chained component in a 60,000-face
    // library is deep enough that a recursive find can blow the stack.
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // O(n^2) over the upper triangle. At 60,000 faces that is 1.8e9 int8 dot
  // products, which is too slow — but the pairwise scan is the honest simple
  // thing, and the escape hatch (an ANN index) is a change to this loop
  // alone, not to the union-find or the caller. Measure before reaching for
  // it; the near-dupe sweep taught that these scans are faster than they look.
  //
  // It yields every `yieldEvery` rows so the server keeps answering while it
  // runs — see YIELD_EVERY. That is the only reason this function is async.
  // Total WORK, not total rows — see onProgress. n*(n-1)/2 is the upper
  // triangle; `maxDegree` skips make the real count lower, so this is an upper
  // bound that the bar approaches monotonically rather than overshooting.
  const totalPairs = (n * (n - 1)) / 2;
  const pairsThrough = (row) => row * n - (row * (row + 1)) / 2;

  for (let i = 0; i < n; i++) {
    if (i > 0 && i % yieldEvery === 0) {
      await breathe();
      // The abort check belongs HERE, at the yield, and nowhere else: it is
      // the only point in an O(n^2) loop where the process is not mid-scan,
      // and checking per-pair would cost more than the comparison it guards.
      if (signal?.aborted) {
        const e = new Error("canceled");
        e.name = "AbortError";
        throw e;
      }
      onProgress?.({ done: pairsThrough(i), total: totalPairs });
    }
    if (degree[i] >= maxDegree) continue;
    const vi = data.subarray(i * dim, (i + 1) * dim);
    for (let j = i + 1; j < n; j++) {
      if (degree[j] >= maxDegree) continue;
      const vj = data.subarray(j * dim, (j + 1) * dim);
      // quantize()'s contract: the int8 dot times both scales is the cosine,
      // because it L2-normalizes BEFORE quantizing. Recomputing norms here
      // would be both slower and wrong.
      const cos = dot(vi, vj) * scales[i] * scales[j];
      if (cos >= threshold) {
        union(i, j);
        degree[i]++;
        degree[j]++;
        if (degree[i] >= maxDegree) break;
      }
    }
  }

  const byRoot = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(ids[i]);
  }

  const clusters = [];
  const singletons = [];
  for (const members of byRoot.values()) {
    if (members.length < minSize) singletons.push(...members);
    else clusters.push(members);
  }
  // Largest first: #167 wants naming ordered by size, because ten minutes on
  // the biggest clusters covers most of a library and a wall of unnamed
  // singletons is a chore rather than a feature.
  clusters.sort((a, b) => b.length - a.length || a[0] - b[0]);
  return { clusters, singletons };
}

/**
 * Assign ONE new face to an existing person without re-clustering.
 *
 * The everyday case as photos arrive: re-running the whole O(n^2) pass for
 * every import would be absurd, and #167 names this explicitly. Compares
 * against each person's members and takes the best mean similarity, so a
 * person represented by twenty photos is not decided by whichever single one
 * happens to be first.
 *
 * @param {{scale: number, bytes: Int8Array}} face
 * @param {Array<{personId: number, members: Array<{scale: number, bytes: Int8Array}>}>} people
 * @param {number} [threshold]
 * @returns {{personId: number, score: number}|null} null when it matches
 *   nobody — which is a real answer, not a failure, and must leave the face
 *   unassigned rather than forcing it into the nearest person.
 */
export function assignToPerson(face, people, threshold = SAME_PERSON_COSINE) {
  let best = null;
  for (const p of people) {
    if (!p.members.length) continue;
    let sum = 0;
    for (const m of p.members) {
      sum += dot(face.bytes, m.bytes) * face.scale * m.scale;
    }
    const score = sum / p.members.length;
    if (score >= threshold && (!best || score > best.score)) {
      best = { personId: p.personId, score };
    }
  }
  return best;
}
