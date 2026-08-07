# Face Map live settings panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Face Map's gear popover into a live side panel with sliders, so the neighbourhood — which #326 proved cannot be predicted — can be found by dragging in seconds.

**Architecture:** A long-lived preview worker holds one library's centroids and one kNN graph, so a parameter change costs 61–117 ms instead of 203 ms and never touches SQLite. A preview route returns coordinates without creating a run. The panel drives that route below a measured latency boundary, and falls back to the existing job-backed `POST /api/projections` above it.

**Tech Stack:** Node worker_threads (ESM), umap-js, Express, Svelte 5 runes, vitest, Playwright.

## Global Constraints

- **Branch `issue-327-face-map-live-panel`, based on `origin/testing`.** PR targets `testing`, never `main`.
- **Do NOT claim a version until Task 5.** #226 stranded 2.20.4 on #325 this week: a version claimed at design time gets passed by `testing` before the work lands.
- **ESM everywhere**, plain JS with JSDoc. No TypeScript.
- **`npm run format` before every commit.**
- **Every fix and feature gets a test at the tier that would catch it**, seen to fail first.
- **Never edit `server/` while an e2e run is in flight** — `node --watch --watch-path=server` restarts mid-suite and produces a 502 in an unrelated spec.
- **The preview worker never touches SQLite and imports nothing native** — the same invariant `worker.js` states, for the same reason (better-sqlite3's ABI trap).
- Commit messages end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File                                       | Responsibility                                         | Change |
| ------------------------------------------ | ------------------------------------------------------ | ------ |
| `server/projection/previewWorker.js`       | Holds centroids + kNN; answers parameter changes       | Create |
| `server/projection/previewSession.js`      | Parent-side lifecycle: one session, keyed, idle-reaped | Create |
| `server/projection/previewSession.test.js` | Reuse, key changes, idle reap, error paths             | Create |
| `server/api.js`                            | `POST /api/projections/preview`                        | Modify |
| `server/projectionRoutes.test.js`          | Preview writes no run; refusals                        | Modify |
| `server/projection/algorithms.js`          | Correct the "superlinear / 20s" note                   | Modify |
| `ui/src/lib/views/FaceMapView.svelte`      | Panel instead of popover; sliders                      | Modify |
| `ui/src/lib/ParamSlider.svelte`            | Slider + editable number, one control                  | Create |
| `ui/src/lib/mapSettings.js`                | Persistence + the latency boundary, pure               | Create |
| `ui/src/lib/mapSettings.test.js`           | Boundary and persistence logic                         | Create |
| `ui/src/App.svelte`                        | `previewFaceMap` alongside `runFaceMap`                | Modify |
| `e2e/face-map.spec.js`, `e2e/helpers.js`   | Panel, sliders, live drag, persistence                 | Modify |

---

## Task 1: The preview session

**Files:**

- Create: `server/projection/previewWorker.js`
- Create: `server/projection/previewSession.js`
- Create: `server/projection/previewSession.test.js`

**Interfaces:**

- Consumes: `personCentroids(db, model, {minFaces})` → `{ids, dim, data, faceCounts}`.
- Produces:
  - `previewProjection({key, data, dim, n, params}) => Promise<Float32Array>` — `2n` interleaved x,y. Reuses the live session when `key` matches; replaces it when it does not.
  - `MAX_PREVIEW_K` — the k the kNN is built at.
  - `_resetPreviewForTest()` — terminate and forget, for `afterEach`.

- [ ] **Step 1: Write the failing test**

Create `server/projection/previewSession.test.js`:

```js
import { describe, it, expect, afterEach } from "vitest";
import {
  previewProjection,
  _resetPreviewForTest,
  MAX_PREVIEW_K,
} from "./previewSession.js";

afterEach(async () => {
  await _resetPreviewForTest();
});

/** `n` points on a few well-separated blobs, so UMAP has real structure. */
function blobs(n, dim = 8) {
  const data = new Float32Array(n * dim);
  for (let i = 0; i < n; i++) {
    const blob = i % 5;
    for (let d = 0; d < dim; d++) {
      data[i * dim + d] = Math.sin(d * 0.7 + blob * 2.1) + (i % 7) * 0.01;
    }
  }
  return { data, dim, n };
}

describe("the preview session (#327)", () => {
  it("returns one coordinate pair per point", async () => {
    const { data, dim, n } = blobs(60);
    const xy = await previewProjection({
      key: "a",
      data,
      dim,
      n,
      params: { nNeighbors: 10, minDist: 0.1, nEpochs: 30, seed: 1212 },
    });
    expect(xy).toBeInstanceOf(Float32Array);
    expect(xy.length).toBe(2 * n);
    expect([...xy].every(Number.isFinite)).toBe(true);
  });

  it("is deterministic for the same key and params", async () => {
    const { data, dim, n } = blobs(60);
    const p = { nNeighbors: 10, minDist: 0.1, nEpochs: 30, seed: 7 };
    const a = await previewProjection({ key: "a", data, dim, n, params: p });
    const b = await previewProjection({ key: "a", data, dim, n, params: p });
    expect([...b]).toEqual([...a]);
  });

  it("answers a SECOND parameter set without rebuilding the neighbour graph", async () => {
    // The whole point of the session. Not timed — a timing assertion is flaky
    // on a loaded CI box. Instead: the worker reports whether it built a graph.
    const { data, dim, n } = blobs(80);
    await previewProjection({
      key: "a",
      data,
      dim,
      n,
      params: { nNeighbors: 10, minDist: 0.1, nEpochs: 20, seed: 1 },
    });
    const second = await previewProjection({
      key: "a",
      data,
      dim,
      n,
      params: { nNeighbors: 12, minDist: 0.4, nEpochs: 20, seed: 1 },
      onMeta: undefined,
    });
    expect(second.length).toBe(2 * n);
    const { builds } = await previewProjection.stats();
    expect(builds).toBe(1);
  });

  it("rebuilds when the key changes, because the members changed", async () => {
    const a = blobs(60);
    const b = blobs(70);
    const p = { nNeighbors: 10, minDist: 0.1, nEpochs: 20, seed: 1 };
    await previewProjection({ key: "a", ...a, params: p });
    const xy = await previewProjection({ key: "b", ...b, params: p });
    expect(xy.length).toBe(2 * b.n);
    const { builds } = await previewProjection.stats();
    expect(builds).toBe(2);
  });

  it("refuses a request with fewer points than it can graph", async () => {
    const { data, dim } = blobs(3);
    await expect(
      previewProjection({
        key: "tiny",
        data,
        dim,
        n: 3,
        params: { nNeighbors: 10, minDist: 0.1, nEpochs: 5, seed: 1 },
      })
    ).rejects.toThrow(/too few/i);
  });

  it("caps the graph at MAX_PREVIEW_K so one build serves the whole slider", () => {
    expect(MAX_PREVIEW_K).toBeGreaterThanOrEqual(60);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run server/projection/previewSession.test.js`
Expected: FAIL — `Cannot find module './previewSession.js'`.

- [ ] **Step 3: Write the worker**

Create `server/projection/previewWorker.js`:

```js
/**
 * The LIVE preview worker (#327).
 *
 * Unlike `worker.js`, which projects once and exits, this one stays alive and
 * holds two things: the member vectors, and ONE k-nearest-neighbour graph built
 * at `MAX_PREVIEW_K`. Every parameter change after that reuses the graph.
 *
 * Measured on the real library (203 people): building the kNN is 151 ms of a
 * 203 ms projection, so reusing it answers a slider tick in 61-117 ms.
 *
 * SLICING IS THE SUBTLE PART. `fuzzySimplicialSet` passes `nNeighbors` to
 * `smoothKNNDistance` while reading the rows we set, so handing it a k=60 graph
 * and asking for nNeighbors=15 sizes the sigmas for one k and the graph for
 * another — a wrong map, silently. We slice each row to k ourselves, which is
 * EXACT because a kNN list is sorted by distance: the first k entries are the k
 * nearest.
 *
 * INVARIANT, same as worker.js: never touches SQLite, imports nothing native.
 */
import { parentPort, workerData } from "node:worker_threads";
import { UMAP } from "umap-js";
import { mulberry32 } from "./seededRandom.js";

const { buffer, n, dim, maxK } = workerData;
const flat = new Float32Array(buffer);
const rows = new Array(n);
for (let i = 0; i < n; i++) {
  rows[i] = Array.from(flat.subarray(i * dim, (i + 1) * dim));
}

// Build the graph ONCE, at the largest k any request can ask for.
const k = Math.min(maxK, Math.max(2, n - 1));
const seedUmap = new UMAP({
  nComponents: 2,
  nNeighbors: k,
  nEpochs: 1,
  random: mulberry32(1),
});
seedUmap.initializeFit(rows);
const knnIndices = seedUmap.knnIndices;
const knnDistances = seedUmap.knnDistances;
parentPort.postMessage({ type: "ready", k });

parentPort.on("message", (msg) => {
  if (msg?.type !== "run") return;
  const { id, params } = msg;
  try {
    const want = Math.min(params.nNeighbors, k);
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
      // One NaN poisons fitExtent for the WHOLE map, so refuse rather than
      // draw a collapsed one — the same guard worker.js's `flatten` makes.
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`preview produced a non-finite coordinate at ${i}`);
      }
      xy[i * 2] = x;
      xy[i * 2 + 1] = y;
    }
    parentPort.postMessage({ type: "done", id, xy }, [xy.buffer]);
  } catch (e) {
    parentPort.postMessage({
      type: "failed",
      id,
      message: String(e?.message ?? e),
    });
  }
});
```

- [ ] **Step 4: Write the session manager**

Create `server/projection/previewSession.js`:

```js
/**
 * ONE live preview session, and its lifecycle (#327).
 *
 * Exactly one is alive at a time. A second library key replaces the first
 * rather than running both: previews are driven by a slider in the one view a
 * user has open, and two resident graphs is two copies of the biggest thing in
 * the process for no benefit.
 *
 * Reaped after `IDLE_MS` so a session that built a graph for 25,758 people does
 * not hold it forever because someone opened the map once.
 */
import { Worker } from "node:worker_threads";
import { MAX_OLD_GENERATION_MB } from "./runProjection.js";

const WORKER_URL = new URL("./previewWorker.js", import.meta.url);

/**
 * The k the graph is built at.
 *
 * `nNeighbors` maxes at 200 in the schema, but a preview is for FINDING a
 * value, not for the extremes, and k dominates both build time and memory.
 * 60 covers the range John's own picks landed in (15-36) with headroom; a
 * request above it is clamped, and Apply — which runs cold through
 * `runProjection` — honours the real number.
 */
export const MAX_PREVIEW_K = 60;

/** How long an idle session keeps its graph resident. */
export const IDLE_MS = 120_000;

/** @type {{key: string, worker: Worker, n: number, pending: Map<number, {resolve: Function, reject: Function}>, timer: NodeJS.Timeout|null}|null} */
let session = null;
let nextId = 1;
let builds = 0;

function destroy() {
  if (!session) return;
  const dying = session;
  session = null;
  if (dying.timer) clearTimeout(dying.timer);
  for (const p of dying.pending.values()) {
    p.reject(new Error("preview session was replaced"));
  }
  dying.worker.terminate();
}

function touch() {
  if (!session) return;
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(destroy, IDLE_MS);
  session.timer.unref?.();
}

function start({ key, data, dim, n }) {
  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength
  );
  const worker = new Worker(WORKER_URL, {
    workerData: { buffer, n, dim, maxK: MAX_PREVIEW_K },
    transferList: [buffer],
    resourceLimits: { maxOldGenerationSizeMb: MAX_OLD_GENERATION_MB },
  });
  const s = { key, worker, n, pending: new Map(), timer: null, ready: null };
  s.ready = new Promise((resolve, reject) => {
    worker.once("message", (m) =>
      m?.type === "ready"
        ? resolve(m)
        : reject(new Error("preview worker did not start"))
    );
    worker.once("error", reject);
  });
  worker.on("message", (m) => {
    const p = s.pending.get(m?.id);
    if (!p) return;
    s.pending.delete(m.id);
    if (m.type === "done") p.resolve(m.xy);
    else if (m.type === "failed") p.reject(new Error(m.message));
  });
  worker.on("error", (e) => {
    for (const p of s.pending.values()) p.reject(e);
    s.pending.clear();
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
 * @param {string} o.key identifies the MEMBER SET — model + minFaces + count.
 *   A different key is a different library and forces a rebuild.
 * @param {Float32Array} o.data `n * dim`, row-major
 * @param {number} o.dim @param {number} o.n
 * @param {object} o.params `nNeighbors`, `minDist`, `nEpochs`, `seed`
 * @returns {Promise<Float32Array>} `2n` interleaved x,y
 */
export async function previewProjection({ key, data, dim, n, params }) {
  if (!Number.isFinite(n) || n < 5) {
    throw new Error(
      `too few people to preview a map (${n}) — lower the minimum faces`
    );
  }
  if (!session || session.key !== key) {
    destroy();
    start({ key, data, dim, n });
  }
  const s = session;
  await s.ready;
  touch();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    s.pending.set(id, { resolve, reject });
    s.worker.postMessage({ type: "run", id, params });
  });
}

/** How many neighbour graphs have been built — the reuse assertion's evidence. */
previewProjection.stats = async () => ({ builds });

/** Terminate and forget. For `afterEach`, and for a library reset. */
export async function _resetPreviewForTest() {
  destroy();
  builds = 0;
  nextId = 1;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run server/projection/previewSession.test.js`
Expected: PASS, all six.

- [ ] **Step 6: Confirm the reuse assertion would catch a regression**

Change `previewProjection` so it calls `destroy()` before every request (i.e. never reuses). Run the suite: _"answers a SECOND parameter set without rebuilding"_ must go red with `expected 2 to be 1`. Restore.

- [ ] **Step 7: Verify both modules load under real Node**

Run: `node -e "import('./server/projection/previewSession.js').then(m => console.log('MAX_PREVIEW_K', m.MAX_PREVIEW_K))"`
Expected: prints `MAX_PREVIEW_K 60`. Vitest's SSR transform hides real `SyntaxError`s (`docs/AGENT-NOTES.md`).

- [ ] **Step 8: Format and commit**

```bash
npm run format
git add server/projection/previewWorker.js server/projection/previewSession.js server/projection/previewSession.test.js
git commit -m "feat(face-map): a live preview session that reuses one neighbour graph (#327)

Building the kNN is 151ms of a 203ms projection, so a resident session
answers a slider tick in 61-117ms. The rows are sliced to k by the caller
because fuzzySimplicialSet sizes its sigmas from nNeighbors while reading
the stored rows — a k=60 graph asked for nNeighbors=15 is silently wrong.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: The preview route

**Files:** Modify `server/api.js`, `server/projectionRoutes.test.js`.

**Interfaces:**

- Consumes: `previewProjection` from Task 1; `personCentroids`; `faceModelIdOf`; `defaultParams`.
- Produces: `POST /api/projections/preview` → `200 {points: [{personId, x, y}], members, ms}`; `400` when too few members; **never** creates a `projection_runs` row.

- [ ] **Step 1: Write the failing tests**

Add to `server/projectionRoutes.test.js`:

```js
describe("POST /api/projections/preview (#327)", () => {
  const preview = async (body) => {
    const res = await fetch(`${srv.base}/api/projections/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, ...body }),
    });
    return { status: res.status, body: await res.json() };
  };

  it("returns points and writes NO run", async () => {
    seedPeople(20);
    const before = getDb()
      .prepare(`SELECT COUNT(*) n FROM projection_runs`)
      .get().n;
    const r = await preview({ minFaces: 2, nEpochs: 20 });
    expect(r.status).toBe(200);
    expect(r.body.points).toHaveLength(20);
    expect(r.body.points[0]).toMatchObject({
      personId: expect.any(Number),
      x: expect.any(Number),
      y: expect.any(Number),
    });
    // The whole reason preview is a separate path: 40 rows during one drag
    // would let pruneRuns(keep: 3) evict the maps the user actually built.
    expect(
      getDb().prepare(`SELECT COUNT(*) n FROM projection_runs`).get().n
    ).toBe(before);
  });

  it("reports how long it took, so the client can decide to stay live", async () => {
    seedPeople(20);
    const r = await preview({ minFaces: 2, nEpochs: 20 });
    expect(r.body.ms).toBeGreaterThan(0);
  });

  it("refuses a too-small library specifically, and writes no run", async () => {
    seedPeople(3);
    const r = await preview({ minFaces: 2, nEpochs: 20 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/minimum faces|too few/i);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run server/projectionRoutes.test.js -t "#327"`
Expected: FAIL — 404, because the route does not exist.

- [ ] **Step 3: Add the route**

In `server/api.js`, after `POST /api/projections`, add:

```js
/**
 * A LIVE preview: coordinates for these parameters, and no run (#327).
 *
 * Deliberately not a job and deliberately not persisted. It exists so the
 * settings panel can follow a slider, which the measurements make possible —
 * 83 ms at 203 people with the resident graph. Two consequences are the
 * point rather than an omission:
 *
 *  - **No `projection_runs` row.** A drag would write dozens, and
 *    `pruneRuns(keep: 3)` would then evict the maps the user actually built.
 *  - **No job.** A JobsPanel row that appears and completes in 83 ms is
 *    noise; contract 2 applies to work the user might walk away from, and
 *    Apply — which does create a job — is what covers a slow library.
 *
 * Apply reproduces this exactly: runs are seeded and deterministic, so
 * committing what you previewed does not move the map.
 */
app.post("/api/projections/preview", async (req, res) => {
  const db = getDb();
  const modelId = faceModelIdOf(req.body?.model);
  const params = defaultParams({ ...req.body, algorithm: "umap" });

  let centroids;
  try {
    centroids = personCentroids(db, modelId, { minFaces: params.minFaces });
  } catch (e) {
    return res.status(500).json({ error: String(e.message ?? e) });
  }
  const members = centroids.ids.length;
  if (members < 5) {
    return res.status(400).json({
      error: `Only ${members} ${members === 1 ? "person has" : "people have"} ${params.minFaces} or more faces — lower the minimum faces.`,
    });
  }

  const t0 = Date.now();
  try {
    const xy = await previewProjection({
      // The member SET is what the graph is built from, so the key has to
      // change whenever it does.
      key: `${modelId}:${params.minFaces}:${members}`,
      data: centroids.data,
      dim: centroids.dim,
      n: members,
      params,
    });
    const points = new Array(members);
    for (let i = 0; i < members; i++) {
      points[i] = {
        personId: centroids.ids[i],
        x: xy[i * 2],
        y: xy[i * 2 + 1],
      };
    }
    res.json({ points, members, ms: Date.now() - t0 });
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});
```

Add `previewProjection` to the imports from `./projection/previewSession.js`.

- [ ] **Step 4: Run the route tests**

Run: `npx vitest run server/projectionRoutes.test.js`
Expected: PASS, including the pre-existing cache and job tests.

- [ ] **Step 5: Confirm the no-run assertion bites**

Make the route call `createRun`/`savePoints` before responding. _"returns points and writes NO run"_ must go red. Remove it again.

- [ ] **Step 6: Verify the server boots**

Run: `node -e "import('./server/api.js').then(() => console.log('api.js loads'))"`

- [ ] **Step 7: Format and commit**

```bash
npm run format
git add server/api.js server/projectionRoutes.test.js
git commit -m "feat(face-map): POST /api/projections/preview — points, no run, no job (#327)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: The panel and its sliders

**Files:** Create `ui/src/lib/ParamSlider.svelte`, `ui/src/lib/mapSettings.js`, `ui/src/lib/mapSettings.test.js`; modify `ui/src/lib/views/FaceMapView.svelte`, `e2e/helpers.js`, `e2e/face-map.spec.js`.

**Interfaces:**

- Produces: `ParamSlider` with props `{spec, value, oninput, onchange}` rendering `data-testid="map-param-{spec.key}"` (the **range** input, so existing helpers keep working) plus `data-testid="map-param-{spec.key}-num"` for the editable number.
- Produces in `mapSettings.js`: `loadSettings()`, `saveSettings(obj)`, `LIVE_MS = 400`, `canGoLive(lastMs)`.

- [ ] **Step 1: Write the pure tests**

Create `ui/src/lib/mapSettings.test.js`:

```js
import { describe, it, expect, beforeEach } from "vitest";
import {
  loadSettings,
  saveSettings,
  canGoLive,
  LIVE_MS,
} from "./mapSettings.js";

beforeEach(() => localStorage.clear());

describe("map settings persistence (#287)", () => {
  it("round-trips what was saved", () => {
    saveSettings({ nNeighbors: 42, minFaces: 3 });
    expect(loadSettings()).toMatchObject({ nNeighbors: 42, minFaces: 3 });
  });

  it("returns an empty object rather than throwing on corrupt storage", () => {
    localStorage.setItem("ag.mapSettings", "{not json");
    expect(loadSettings()).toEqual({});
  });

  it("never returns a stored value that is not a finite number", () => {
    localStorage.setItem(
      "ag.mapSettings",
      JSON.stringify({ nNeighbors: "50" })
    );
    expect(loadSettings()).toEqual({});
  });
});

describe("the live boundary (#327)", () => {
  it("goes live when the last run was fast", () => {
    expect(canGoLive(83)).toBe(true);
  });
  it("stays on Apply when the last run was slow", () => {
    expect(canGoLive(3100)).toBe(false);
  });
  it("does NOT go live before anything has been measured", () => {
    // Optimism here means a 25,758-person library locks up on the first drag.
    expect(canGoLive(null)).toBe(false);
    expect(canGoLive(undefined)).toBe(false);
  });
  it("boundary is 400ms", () => {
    expect(LIVE_MS).toBe(400);
    expect(canGoLive(LIVE_MS - 1)).toBe(true);
    expect(canGoLive(LIVE_MS)).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch it fail** — `npx vitest run ui/src/lib/mapSettings.test.js`, expect module-not-found.

- [ ] **Step 3: Write `mapSettings.js`**

```js
/**
 * The map panel's persistence and its live/Apply boundary (#327, #287).
 *
 * Pure and DOM-free apart from localStorage, so both rules are unit-testable
 * rather than something to eyeball in a panel.
 */
const KEY = "ag.mapSettings";

/**
 * The latency under which the map may follow a slider.
 *
 * Measured, not guessed: 203 people answer in 83 ms with the resident graph,
 * 5,499 in ~3.1 s, 25,758 in ~10.7 s. 400 ms puts the boundary where a drag
 * still feels attached to the control, and it is a MEASURED latency rather
 * than a member count, so it stays correct as the machine and the library
 * change.
 */
export const LIVE_MS = 400;

/**
 * @param {number|null|undefined} lastMs how long the last projection took
 * @returns {boolean}
 */
export function canGoLive(lastMs) {
  return Number.isFinite(lastMs) && lastMs < LIVE_MS;
}

/** @returns {Record<string, number>} only finite numbers survive. */
export function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const out = {};
    for (const [k, v] of Object.entries(raw ?? {})) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    // Corrupt storage is not a reason to lose the map. Start clean.
    return {};
  }
}

/** @param {Record<string, number>} obj */
export function saveSettings(obj) {
  try {
    localStorage.setItem(KEY, JSON.stringify(obj ?? {}));
  } catch {
    // Quota or private mode: settings not persisting is a papercut, not an
    // error worth interrupting the user for.
  }
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Write `ParamSlider.svelte`**

```svelte
<script>
  /**
   * One tuning control: a slider you can drag and a number you can retype.
   *
   * Both, because neither alone works here. A bare `<input type="number">` will
   * not let you get from 5 to 50 by typing a 0 after the 5 — the annoyance that
   * opened #327 — and a bare slider cannot express an exact value.
   *
   * `oninput` fires continuously (the live preview listens); `onchange` fires
   * on release and on the number field's commit (the Apply path listens).
   */
  let { spec, value, oninput, onchange } = $props();
  const clamp = (v) =>
    Math.min(
      spec.max,
      Math.max(spec.min, Number.isFinite(+v) ? +v : spec.default)
    );
</script>

<label class="tunable">
  <span class="tunable-name">{spec.label}</span>
  <span class="row">
    <input
      type="range"
      data-testid={`map-param-${spec.key}`}
      min={spec.min}
      max={spec.max}
      step={spec.step}
      {value}
      oninput={(e) => oninput?.(clamp(e.currentTarget.value))}
      onchange={(e) => onchange?.(clamp(e.currentTarget.value))}
    />
    <input
      class="num"
      type="number"
      data-testid={`map-param-${spec.key}-num`}
      min={spec.min}
      max={spec.max}
      step={spec.step}
      {value}
      onchange={(e) => onchange?.(clamp(e.currentTarget.value))}
    />
  </span>
  <span class="tunable-help">{spec.help}</span>
</label>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  input[type="range"] {
    flex: 1 1 auto;
    min-width: 0;
  }
  .num {
    width: 5.5ch;
  }
  .tunable {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .tunable-name {
    font-size: 0.85rem;
  }
  .tunable-help {
    font-size: 0.75rem;
    color: #888;
  }
</style>
```

- [ ] **Step 6: Convert the panel in `FaceMapView.svelte`**

Replace the `{#if gearOpen}<div class="gear-panel">` popover with an `<aside class="settings" data-testid="map-gear-panel">` rendered as a sibling of the scatter inside a flex row, so the map stays visible. Keep `data-testid="map-gear-panel"` — every existing spec uses it. The gear button becomes a show/hide toggle for the aside. Replace each `<input type="number">` in the tuning fieldset with `<ParamSlider …>`; leave `minFaces` as its own control above, also a `ParamSlider`.

CSS: the view is already `display: flex; flex-direction: column`. Wrap the scatter and the aside in a `.body { display: flex; flex: 1 1 auto; min-height: 0 }`, with `.settings { flex: 0 0 clamp(220px, 15%, 320px); overflow-y: auto }`.

- [ ] **Step 7: Add e2e coverage**

In `e2e/helpers.js` add to `faceMap`:

```js
  /** The editable number beside a slider. */
  paramNum: (page, key) => page.locator(`[data-testid="map-param-${key}-num"]`),
```

In `e2e/face-map.spec.js`:

```js
test("the settings are a panel beside the map, and the value can be retyped", async ({
  page,
}) => {
  // #327: the gear was a popover over the map, so you could not see what a
  // parameter did; and `<input type="number">` would not let John get from 5
  // to 50 by typing a 0 after the 5.
  const errors = trackPageErrors(page);
  await openApp(page);
  await views.show(page, "face-map");
  await faceMap.build_(page);
  await faceMap.gear(page).click();

  // The map is still on screen with the panel open — the whole point.
  await expect(faceMap.gearPanel(page)).toBeVisible();
  await expect(faceMap.scatter(page)).toBeVisible();

  await faceMap.paramNum(page, "nNeighbors").fill("50");
  await faceMap.paramNum(page, "nNeighbors").blur();
  await expect(faceMap.param(page, "nNeighbors")).toHaveValue("50");
  expect(errors).toEqual([]);
});
```

- [ ] **Step 8: Run** `npm run test:e2e -- e2e/face-map.spec.js` — all must pass, including the pre-existing gear specs.

- [ ] **Step 9: Format and commit.**

---

## Task 4: Live recompute

**Files:** Modify `ui/src/App.svelte`, `ui/src/lib/views/FaceMapView.svelte`, `e2e/face-map.spec.js`.

**Interfaces:**

- Consumes: `POST /api/projections/preview` (Task 2), `canGoLive`/`LIVE_MS` (Task 3).
- Produces: `previewFaceMap(params)` in `App.svelte`, passed to the view as `onpreview`; App keeps owning `mapPoints`.

- [ ] **Step 1: Add `previewFaceMap` to `App.svelte`**, beside `runFaceMap`:

```js
/** How long the last projection took, so the panel knows if it can stay live. */
let mapLastMs = $state(null);

/**
 * A live preview: new coordinates, no run, no job (#327).
 *
 * App still owns `mapPoints` — a view that fetched its own data is how the
 * #155 boundary rots. Requests are single-flighted rather than queued: a
 * slider produces them faster than they complete, and the user only wants
 * the newest.
 */
let previewSeq = 0;
async function previewFaceMap(params) {
  const seq = ++previewSeq;
  try {
    const res = await fetch("/api/projections/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const body = await res.json().catch(() => ({}));
    if (seq !== previewSeq) return false; // a newer drag won
    if (!res.ok) {
      mapNotice = body.error ?? `Couldn't preview the map (${res.status}).`;
      return false;
    }
    mapNotice = "";
    mapLastMs = body.ms ?? null;
    // Keep the person metadata already loaded; only positions changed.
    const by = new Map(mapPoints.map((p) => [p.personId, p]));
    mapPoints = body.points.map((p) => ({
      ...(by.get(p.personId) ?? {}),
      ...p,
    }));
    mapParams = { ...params };
    return true;
  } catch (e) {
    if (seq !== previewSeq) return false;
    mapNotice = `Couldn't preview the map: ${e.message}`;
    return false;
  }
}
```

Pass `onpreview: previewFaceMap` and `lastMs: mapLastMs` in the `FACE_MAP` case of `viewProps`. Set `mapLastMs` from `runFaceMap` too, timing the request.

- [ ] **Step 2: Wire the view** — in `FaceMapView.svelte`, a `ParamSlider`'s `oninput` calls a debounced preview when `canGoLive(lastMs)` and the key is not `minFaces`; otherwise it only updates `draft`. The debounce is a trailing 60 ms timer stored in a plain `let`, cleared on destroy. **Not a `$:`/`$effect` on a DOM node** — CLAUDE.md's first trap.

- [ ] **Step 3: e2e — the slider actually moves the map**

```js
test("dragging a slider updates the map without a job", async ({ page }) => {
  const errors = trackPageErrors(page);
  await openApp(page);
  await views.show(page, "face-map");
  await faceMap.build_(page);
  await faceMap.gear(page).click();

  const before = await faceMap.pointPositions(page);
  await faceMap.paramNum(page, "nNeighbors").fill("12");
  await faceMap.paramNum(page, "nNeighbors").blur();
  await expect
    .poll(async () => await faceMap.pointPositions(page))
    .not.toEqual(before);
  // No run was written and no job appeared: preview is neither.
  expect(errors).toEqual([]);
});
```

Add `pointPositions` to `e2e/helpers.js`, reading the scatter's current point array off the canvas component's exposed debug hook (the existing `chipIds` helper is the pattern for reaching in).

- [ ] **Step 4: Run e2e, format, commit.**

---

## Task 5: Correct the stale note, version, changelog

- [ ] **Step 1:** In `server/projection/algorithms.js`, the module note calls the projection expensive and superlinear and quotes "20s with singletons". Replace with the measured curve: `ms = 3.29 * n^0.80` (sublinear), 203 people → 201 ms, 852 → 842 ms, 25,758 → ~10.7 s extrapolated. Cite this plan's spec.
- [ ] **Step 2:** Claim the version NOW, not earlier: `VERSION=$(.claude/skills/working-issues/claim-version.sh 327)`. Set it in `package.json`.
- [ ] **Step 3:** `CHANGELOG.md` entry — what the user can now do: settings live beside the map, sliders you can retype, the map follows the slider on a library this size, settings remembered (#327, #287).
- [ ] **Step 4:** `npm test`, `npm run test:e2e -- --grep @p0`, `npm run test:e2e -- e2e/face-map.spec.js`.
- [ ] **Step 5:** Drive it by hand at `localhost:5173` — check the title bar version first (`docs/AGENT-NOTES.md`).
- [ ] **Step 6:** `gh pr create --base testing`, `Refs #327`, `Refs #287`. Then `gh pr merge --auto --merge` and end the turn — do not poll CI.

---

## Self-review

**Spec coverage.** Panel → Task 3. Sliders → Task 3. Live boundary → Tasks 3 (pure rule) and 4 (wiring). Preview-writes-no-runs → Tasks 1–2. Persistence/#287 → Task 3. Correcting the superlinear note → Task 5. "Deliberately does not do" adds no tasks.

**Placeholder scan.** Task 3 Step 6 and Task 4 Steps 2–3 describe edits to existing markup rather than quoting whole files; the components, testids and CSS values are given exactly. `pointPositions` is named and its pattern cited but not written — **the one genuine gap**, because how to read canvas point positions depends on what `ScatterCanvas` exposes, which must be checked when Task 4 starts.

**Type consistency.** `previewProjection({key, data, dim, n, params})` is defined in Task 1 and called with exactly those keys in Task 2. `canGoLive(lastMs)`/`LIVE_MS` defined in Task 3, used in Task 4. `map-param-{key}` stays the range input so existing specs keep resolving; `map-param-{key}-num` is the new number field, added to helpers in Task 3 and used in Task 4.
