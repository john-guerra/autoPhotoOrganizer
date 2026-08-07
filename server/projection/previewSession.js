/**
 * ONE live preview session, and its lifecycle (#327).
 *
 * The parent half of `previewWorker.js`. Exactly one session is alive at a
 * time: a second library key REPLACES the first rather than running both.
 * Previews are driven by a slider in the one view a user has open, so two
 * resident graphs would be two copies of the largest thing in the process for
 * no benefit.
 *
 * Reaped after `IDLE_MS`, so a session that built a graph for 25,758 people
 * does not hold it for the rest of the process because someone opened the map
 * once and went to lunch.
 *
 * ## This is deliberately NOT a job
 *
 * `docs/UI-CONTRACTS.md` contract 2 governs work the user might walk away
 * from. A preview answers in 61-117 ms on a real library; a JobsPanel row that
 * appears and completes in that time is noise, not control. The path that CAN
 * be slow — Apply, on a large library — still goes through `runProjection` and
 * still creates a real, cancellable job. The client decides which side of the
 * line it is on from the measured latency, not from a guess.
 */
import { Worker } from "node:worker_threads";
import { MAX_OLD_GENERATION_MB } from "./runProjection.js";
import { MAX_N_NEIGHBORS } from "./algorithms.js";

const WORKER_URL = new URL("./previewWorker.js", import.meta.url);

/**
 * The k the neighbour graph is built at — the SCHEMA'S CEILING, deliberately.
 *
 * It was 60 for a while, on the reasoning that a preview exists to find a value
 * rather than to explore extremes. That was wrong for a reason worth writing
 * down: a preview capped below the slider silently shows a different map from
 * the one Apply would produce, so dragging past the cap changes nothing on
 * screen and then the map jumps when you commit. That is exactly the #325
 * failure family.
 *
 * The cost is bounded anyway. `Math.min(maxK, n - 1)` means a small library
 * never pays for 300, and a library big enough for a k=300 graph to hurt is one
 * where `canGoLive` has already refused to preview at all.
 */
export const MAX_PREVIEW_K = MAX_N_NEIGHBORS;

/** How long an idle session keeps its graph resident. */
export const IDLE_MS = 120_000;

/**
 * @typedef {{
 *   key: string, worker: Worker, n: number,
 *   pending: Map<number, {resolve: (v: Float32Array) => void, reject: (e: Error) => void}>,
 *   ready: Promise<unknown>, built: boolean,
 *   abandon: ((e: Error) => void)|null, timer: NodeJS.Timeout|null
 * }} Session
 */

/** @type {Session|null} */
let session = null;
let nextId = 1;
let builds = 0;

function destroy() {
  if (!session) return;
  const dying = session;
  session = null;
  if (dying.timer) clearTimeout(dying.timer);
  // Anything still in flight belongs to a library we are no longer holding.
  // Rejecting is the honest answer; leaving them pending hangs the caller.
  for (const p of dying.pending.values()) {
    p.reject(new Error("preview session was replaced"));
  }
  dying.pending.clear();
  // A session replaced DURING its cold build has nothing in `pending` yet — its
  // caller is still awaiting `ready` — so the loop above reached nobody, and
  // `terminate()` below then answered them through the worker's `exit` handler:
  // "preview worker exited with code 1" for something that is not an error at
  // all, just a user who moved on to a different member set (#345).
  dying.abandon?.(new Error("preview session was replaced"));
  dying.worker.terminate();
}

function touch() {
  if (!session) return;
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(destroy, IDLE_MS);
  // Never hold the process open just because a map was previewed.
  session.timer.unref?.();
}

/**
 * @param {{key: string, data: Float32Array, dim: number, n: number}} o
 * @returns {Session}
 */
function start({ key, data, dim, n }) {
  // Copy rather than transfer the caller's buffer: `personCentroids` hands back
  // a view the route may still want, and a transferred buffer is detached.
  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength
  );

  const worker = new Worker(WORKER_URL, {
    workerData: { buffer, n, dim, maxK: MAX_PREVIEW_K },
    transferList: [buffer],
    resourceLimits: { maxOldGenerationSizeMb: MAX_OLD_GENERATION_MB },
  });

  /** @type {Session} */
  const s = {
    key,
    worker,
    n,
    pending: new Map(),
    timer: null,
    ready: null,
    // "The graph EXISTS", as distinct from "a session object exists". `session`
    // is assigned synchronously below, before the worker has built anything, so
    // these two answers differ for the whole cold round trip — which is exactly
    // the window a slider drag lands in (#345).
    built: false,
    abandon: null,
  };

  s.ready = new Promise((resolve, reject) => {
    s.abandon = reject;
    const onFirst = (m) => {
      if (m?.type !== "ready") return;
      s.built = true;
      resolve(m);
    };
    worker.on("message", onFirst);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      reject(new Error(`preview worker exited with code ${code}`));
    });
  });
  // A replaced or reaped session may have nobody awaiting `ready` — the idle
  // timer reaps sessions whose callers all finished long ago. Marking it
  // handled here keeps that from surfacing as an unhandled rejection; anyone
  // who does await `ready` still sees the rejection.
  s.ready.catch(() => {});

  worker.on("message", (m) => {
    if (m?.type !== "done" && m?.type !== "failed") return;
    const p = s.pending.get(m.id);
    if (!p) return;
    s.pending.delete(m.id);
    if (m.type === "done") p.resolve(m.xy);
    else p.reject(new Error(m.message));
  });

  worker.on("error", (e) => {
    for (const p of s.pending.values()) p.reject(e);
    s.pending.clear();
    // A dead worker must not stay installed, or every later request waits on a
    // `ready` that will never resolve.
    if (session === s) session = null;
  });

  builds++;
  session = s;
  return s;
}

/**
 * Project `data` with `params`, reusing the resident graph when `key` matches.
 *
 * @param {object} o
 * @param {string} o.key identifies the MEMBER SET — model, minFaces and count.
 *   A different key is a different library, and forces a rebuild. This is the
 *   preview's answer to the same question #325 was about: a cached artefact is
 *   only valid while it still describes the data.
 * @param {Float32Array} o.data `n * dim`, row-major
 * @param {number} o.dim
 * @param {number} o.n
 * @param {{nNeighbors:number, minDist:number, nEpochs:number, seed:number}} o.params
 * @returns {Promise<{xy: Float32Array, warm: boolean}>} `xy` is `2n` floats,
 *   interleaved x,y. `warm` is false when this call had to WAIT for the graph —
 *   whether it started the build itself or arrived while one was in flight. Its
 *   timing is then graph-build + layout, not the steady-state cost, and only a
 *   warm timing may be thresholded on (#345).
 */
export async function previewProjection({ key, data, dim, n, params }) {
  // THE SAME MINIMUM AS APPLY, deliberately (#345).
  //
  // This was 5 while `POST /api/projections` refused below 3, so a 3-4 person
  // library could commit a map it was never allowed to preview — the preview
  // 400'd every time, for the one library size where you would most want to
  // look before committing. Two thresholds that had drifted apart, not a
  // technical floor: measured against the real worker, n=3 and n=4 project
  // fine and only n=2 raises umap-js's "Not enough data points" (it needs
  // nNeighbors >= 2, and `previewWorker` clamps k to n-1).
  //
  // "Too small to be a useful map" is a judgement, and it is Apply's to make —
  // it already makes it, in those words, at exactly this boundary. A preview
  // that refuses what Apply accepts is the one thing a preview must not do.
  if (!Number.isFinite(n) || n < 3) {
    throw new Error(
      `too few people to preview a map (${n}) — lower the minimum faces`
    );
  }

  // TWO QUESTIONS, and conflating them was #345.
  //
  // "May I reuse the resident session?" is about the KEY, and it is what
  // decides whether to rebuild. "Did this call skip the graph build?" is about
  // whether that graph EXISTS YET, and it is what the timing means. `start()`
  // installs `session` synchronously, so for the whole cold round trip
  // (~200-450 ms) the answers differ — and a second preview arriving in that
  // window is ordinary "wiggle the slider while judging the map" behaviour.
  //
  // Reading `warm` off mere existence made that second call report the
  // steady-state flag for a latency of graph-build + BOTH layouts (the worker
  // is single-threaded, so it queues behind the first). `App.svelte` writes
  // only warm timings into `mapLastMs` precisely to keep build cost out of the
  // decision, so that one number went straight into `canGoLive`'s 400 ms
  // threshold and turned live mode off in the first seconds after Apply.
  const reuse = !!session && session.key === key;
  const warm = reuse && session.built;
  if (!reuse) {
    destroy();
    start({ key, data, dim, n });
  }
  const s = session;
  await s.ready;
  // The session may have died while we awaited `ready`.
  if (session !== s) throw new Error("preview session was replaced");
  touch();

  const id = nextId++;
  const xy = await new Promise((resolve, reject) => {
    s.pending.set(id, { resolve, reject });
    s.worker.postMessage({ type: "run", id, params });
  });
  return { xy, warm };
}

/**
 * How many neighbour graphs have been built since the last reset.
 *
 * Exists for the test that reuse actually happens. Counting builds rather than
 * timing anything: a timing assertion on a loaded CI box is a flake, and "it
 * was faster" would pass even if the graph had been rebuilt.
 */
export function previewStats() {
  return { builds, alive: session !== null, key: session?.key ?? null };
}

/** Terminate and forget. For `afterEach`, and for a library reset. */
export async function _resetPreviewForTest() {
  destroy();
  builds = 0;
  nextId = 1;
}
