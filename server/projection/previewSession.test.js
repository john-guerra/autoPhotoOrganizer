/**
 * The live preview session (#327).
 *
 * What matters here is not "does it project" — `runProjection.test.js` covers
 * that — but that a SECOND parameter set reuses the neighbour graph the first
 * one built. That reuse is the entire reason a slider can drive the map: on the
 * real library the graph is 151 ms of a 203 ms projection.
 *
 * The reuse assertion counts BUILDS rather than timing anything. A timing
 * assertion on a loaded CI box is a flake generator, and "it was faster" would
 * pass even if the graph were rebuilt from a warm cache somewhere else.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  previewProjection,
  previewStats,
  _resetPreviewForTest,
  MAX_PREVIEW_K,
} from "./previewSession.js";
import { MAX_N_NEIGHBORS } from "./algorithms.js";

afterEach(async () => {
  await _resetPreviewForTest();
});

/** `n` points on five separated blobs, so the graph has real structure. */
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
  it("returns one coordinate pair per point, all finite", async () => {
    const { data, dim, n } = blobs(60);
    const { xy } = await previewProjection({
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
    // Determinism is what lets Apply reproduce exactly what the preview
    // showed, so committing does not move the map under the user.
    const { data, dim, n } = blobs(60);
    const p = { nNeighbors: 10, minDist: 0.1, nEpochs: 30, seed: 7 };
    const { xy: a } = await previewProjection({
      key: "a",
      data,
      dim,
      n,
      params: p,
    });
    const { xy: b } = await previewProjection({
      key: "a",
      data,
      dim,
      n,
      params: p,
    });
    expect([...b]).toEqual([...a]);
  });

  it("answers a SECOND parameter set without rebuilding the neighbour graph", async () => {
    const { data, dim, n } = blobs(80);
    await previewProjection({
      key: "a",
      data,
      dim,
      n,
      params: { nNeighbors: 10, minDist: 0.1, nEpochs: 20, seed: 1 },
    });
    const { xy: second } = await previewProjection({
      key: "a",
      data,
      dim,
      n,
      params: { nNeighbors: 12, minDist: 0.4, nEpochs: 20, seed: 1 },
    });
    expect(second.length).toBe(2 * n);
    expect(previewStats().builds).toBe(1);
  });

  it("a different nNeighbors still changes the map, sliced from the one graph", async () => {
    // Reuse must not become "ignore the parameter". The rows are sliced to k
    // per request; if that slicing were dropped, every value would return the
    // same layout and the slider would do nothing.
    const { data, dim, n } = blobs(80);
    const p = { minDist: 0.1, nEpochs: 40, seed: 3 };
    const { xy: a } = await previewProjection({
      key: "a",
      data,
      dim,
      n,
      params: { ...p, nNeighbors: 5 },
    });
    const { xy: b } = await previewProjection({
      key: "a",
      data,
      dim,
      n,
      params: { ...p, nNeighbors: 40 },
    });
    expect([...b]).not.toEqual([...a]);
    expect(previewStats().builds).toBe(1);
  });

  it("rebuilds when the key changes, because the members changed", async () => {
    const a = blobs(60);
    const b = blobs(70);
    const p = { nNeighbors: 10, minDist: 0.1, nEpochs: 20, seed: 1 };
    await previewProjection({ key: "a", ...a, params: p });
    const { xy } = await previewProjection({ key: "b", ...b, params: p });
    expect(xy.length).toBe(2 * b.n);
    expect(previewStats().builds).toBe(2);
  });

  it("reports whether the call had to build the graph", async () => {
    // The client thresholds its live/Apply decision on `ms`, and a cold call's
    // ms is graph-build + layout — a cost that never recurs. Measured on the
    // real library: 438ms cold, 127ms warm. Without this flag the first
    // preview would disqualify live mode permanently.
    const { data, dim, n } = blobs(60);
    const p = { nNeighbors: 10, minDist: 0.1, nEpochs: 20, seed: 1 };
    const first = await previewProjection({
      key: "a",
      data,
      dim,
      n,
      params: p,
    });
    expect(first.warm).toBe(false);
    const again = await previewProjection({
      key: "a",
      data,
      dim,
      n,
      params: p,
    });
    expect(again.warm).toBe(true);
  });

  it("a second call DURING a cold build is not warm (#345)", async () => {
    // `warm` decided "is there a session object for this key", and `start()`
    // installs the session synchronously — before the graph exists. So a second
    // preview arriving inside the ~200-450ms cold round trip (a pause-then-drag
    // while judging the map) reported warm:true for a call whose latency is
    // graph-build + BOTH layouts, queued behind the first on a single-threaded
    // worker. `App.svelte` writes only warm timings into `mapLastMs`, so that
    // one inflated number is exactly the one `canGoLive`'s 400ms threshold
    // reads — and live mode turns itself off seconds after Apply.
    //
    // No timing anywhere: the two calls are started without awaiting the first,
    // which is the interleaving itself rather than a race against the clock.
    const { data, dim, n } = blobs(60);
    const p = { nNeighbors: 10, minDist: 0.1, nEpochs: 20, seed: 1 };
    const first = previewProjection({ key: "a", data, dim, n, params: p });
    const second = previewProjection({ key: "a", data, dim, n, params: p });
    const [a, b] = await Promise.all([first, second]);

    expect(a.warm).toBe(false);
    expect(b.warm).toBe(false);
    // Still ONE build: not-warm must not be confused with "rebuild the graph".
    expect(previewStats().builds).toBe(1);
    // And a call after the build really is warm, or the flag is just always
    // false and the test above passes for nothing.
    const third = await previewProjection({
      key: "a",
      data,
      dim,
      n,
      params: p,
    });
    expect(third.warm).toBe(true);
    expect(previewStats().builds).toBe(1);
  });

  it("a cold build replaced mid-flight says so, rather than reporting a worker exit code", async () => {
    // `destroy()` rejects `pending`, which is still empty while the graph is
    // building — so the first caller fell through to the worker's `exit`
    // handler and got "preview worker exited with code 1" for something that is
    // not an error at all: the user moved on to a different member set.
    const a = blobs(60);
    const b = blobs(70);
    const p = { nNeighbors: 10, minDist: 0.1, nEpochs: 20, seed: 1 };
    const first = previewProjection({ key: "a", ...a, params: p });
    const second = previewProjection({ key: "b", ...b, params: p });

    await expect(first).rejects.toThrow(/replaced/);
    const { xy } = await second;
    expect(xy.length).toBe(2 * b.n);
  });

  it("refuses a library too small to graph, rather than returning a blob", async () => {
    // TWO, not three. umap-js needs nNeighbors >= 2 and the worker clamps k to
    // n - 1, so this is where the machinery genuinely stops.
    const { data, dim } = blobs(2);
    await expect(
      previewProjection({
        key: "tiny",
        data,
        dim,
        n: 2,
        params: { nNeighbors: 10, minDist: 0.1, nEpochs: 5, seed: 1 },
      })
    ).rejects.toThrow(/too few/i);
  });

  it("previews anything Apply would accept — three people included (#345)", async () => {
    // The preview refused below 5 while `POST /api/projections` refused below
    // 3, so a 3-4 person library could commit a map it could never preview:
    // the slider 400'd every time, at the one size where looking before
    // committing matters most. A preview that refuses what Apply accepts is
    // the one thing a preview must not do, so the boundary is Apply's.
    const { data, dim, n } = blobs(3);
    const { xy } = await previewProjection({
      key: "three",
      data,
      dim,
      n,
      params: { nNeighbors: 10, minDist: 0.1, nEpochs: 20, seed: 1 },
    });
    expect(xy.length).toBe(2 * n);
    expect([...xy].every(Number.isFinite)).toBe(true);
  });

  it("builds the graph at the SLIDER'S ceiling, so one build serves all of it", () => {
    // Not "at least 60". A cap below the schema's max means dragging past it
    // changes nothing on screen and the map jumps when you press Apply — a
    // preview that is not the thing it previews (#325's family).
    expect(MAX_PREVIEW_K).toBe(MAX_N_NEIGHBORS);
  });
});
