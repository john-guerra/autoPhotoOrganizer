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

  it("refuses a library too small to graph, rather than returning a blob", async () => {
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

  it("builds the graph at the SLIDER'S ceiling, so one build serves all of it", () => {
    // Not "at least 60". A cap below the schema's max means dragging past it
    // changes nothing on screen and the map jumps when you press Apply — a
    // preview that is not the thing it previews (#325's family).
    expect(MAX_PREVIEW_K).toBe(MAX_N_NEIGHBORS);
  });
});
