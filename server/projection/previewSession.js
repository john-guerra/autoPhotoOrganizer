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

const WORKER_URL = new URL("./previewWorker.js", import.meta.url);

/**
 * The k the neighbour graph is built at.
 *
 * `nNeighbors` maxes at 200 in the schema, but k dominates both build time and
 * memory, and a preview exists to FIND a value rather than to explore the
 * extremes — John's own picks across five photo scopes landed between 15 and 36
 * (#326). 60 covers that with headroom. A request above the cap is clamped in
 * the worker; Apply runs cold and honours the real number.
 */
export const MAX_PREVIEW_K = 60;

/** How long an idle session keeps its graph resident. */
export const IDLE_MS = 120_000;

/**
 * @typedef {{
 *   key: string, worker: Worker, n: number,
 *   pending: Map<number, {resolve: (v: Float32Array) => void, reject: (e: Error) => void}>,
 *   ready: Promise<unknown>, timer: NodeJS.Timeout|null
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
  };

  s.ready = new Promise((resolve, reject) => {
    const onFirst = (m) => {
      if (m?.type === "ready") resolve(m);
    };
    worker.on("message", onFirst);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      reject(new Error(`preview worker exited with code ${code}`));
    });
  });

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
 *   interleaved x,y. `warm` is false when this call had to build the graph —
 *   its timing is then graph-build + layout, not the steady-state cost.
 */
export async function previewProjection({ key, data, dim, n, params }) {
  // umap-js throws "Not enough data points" below nNeighbors, and a map of four
  // people is not a map. Refuse specifically rather than return a blob.
  if (!Number.isFinite(n) || n < 5) {
    throw new Error(
      `too few people to preview a map (${n}) — lower the minimum faces`
    );
  }

  // Whether this request PAID for the graph decides what its timing means: a
  // cold call is graph-build + layout, a warm one is the steady-state cost the
  // live boundary actually cares about (#327).
  const warm = !!session && session.key === key;
  if (!warm) {
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
