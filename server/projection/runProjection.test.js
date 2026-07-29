import { describe, it, expect } from "vitest";
import { runProjection } from "./runProjection.js";
import { defaultParams } from "./algorithms.js";

const DIM = 8;

/**
 * Three well-separated clusters, built without Math.random so the FIXTURE
 * cannot be the reason a determinism test passes or fails.
 */
function threeClusters(perCluster = 30) {
  const n = perCluster * 3;
  const data = new Float32Array(n * DIM);
  const label = new Int32Array(n);
  let row = 0;
  for (let c = 0; c < 3; c++) {
    for (let k = 0; k < perCluster; k++) {
      for (let i = 0; i < DIM; i++) {
        // a tiny deterministic wobble, so points are near but not identical
        data[row * DIM + i] =
          (i === c ? 1 : 0) + (((k * 7 + i * 13) % 11) - 5) / 500;
      }
      label[row] = c;
      row++;
    }
  }
  return { data, label, n, dim: DIM };
}

const dist = (xy, a, b) =>
  Math.hypot(xy[a * 2] - xy[b * 2], xy[a * 2 + 1] - xy[b * 2 + 1]);

/** Mean within-cluster distance must beat mean between-cluster distance. */
function separates(xy, label, n) {
  let within = 0,
    wn = 0,
    between = 0,
    bn = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = dist(xy, i, j);
      if (label[i] === label[j]) {
        within += d;
        wn++;
      } else {
        between += d;
        bn++;
      }
    }
  }
  return within / wn < between / bn;
}

describe("runProjection (#232)", () => {
  it("separates three clusters with UMAP", async () => {
    // Asserting exact coordinates would pin an implementation detail. This
    // asserts the only property the map actually needs: alike things land
    // together.
    const { data, label, n, dim } = threeClusters();
    const xy = await runProjection({
      data,
      dim,
      n,
      algorithm: "umap",
      params: defaultParams({ nNeighbors: 8, nEpochs: 200, seed: 42 }),
    });
    expect(xy).toBeInstanceOf(Float32Array);
    expect(xy.length).toBe(n * 2);
    expect(Array.from(xy).every(Number.isFinite)).toBe(true);
    expect(separates(xy, label, n)).toBe(true);
  }, 60_000);

  it("separates three clusters with t-SNE", async () => {
    const { data, label, n, dim } = threeClusters(20);
    const xy = await runProjection({
      data,
      dim,
      n,
      algorithm: "tsne",
      params: defaultParams({ nEpochs: 200, seed: 42 }),
    });
    expect(separates(xy, label, n)).toBe(true);
  }, 60_000);

  it("returns finite coordinates from PCA", async () => {
    const { data, n, dim } = threeClusters(20);
    const xy = await runProjection({
      data,
      dim,
      n,
      algorithm: "pca",
      params: defaultParams({ seed: 42 }),
    });
    expect(xy.length).toBe(n * 2);
    expect(Array.from(xy).every(Number.isFinite)).toBe(true);
  }, 60_000);

  it.each(["umap", "tsne", "pca"])(
    "%s is DETERMINISTIC for a given seed — this is what makes the cache honest",
    async (algorithm) => {
      // A cached map is served on the promise that re-running the same
      // parameters produces the same map. With Math.random that promise is
      // false and NOTHING would ever report the difference: the user sees a
      // map, merges from it, and a re-run silently disagrees.
      const a = await runProjection({
        ...threeClusters(20),
        algorithm,
        params: defaultParams({ nNeighbors: 8, nEpochs: 120, seed: 7 }),
      });
      const b = await runProjection({
        ...threeClusters(20),
        algorithm,
        params: defaultParams({ nNeighbors: 8, nEpochs: 120, seed: 7 }),
      });
      expect(Array.from(a)).toEqual(Array.from(b));
    },
    120_000
  );

  it("a different seed gives a different map", async () => {
    // Otherwise the determinism test above would pass against a constant.
    const a = await runProjection({
      ...threeClusters(20),
      algorithm: "umap",
      params: defaultParams({ nNeighbors: 8, nEpochs: 120, seed: 1 }),
    });
    const b = await runProjection({
      ...threeClusters(20),
      algorithm: "umap",
      params: defaultParams({ nNeighbors: 8, nEpochs: 120, seed: 2 }),
    });
    expect(Array.from(a)).not.toEqual(Array.from(b));
  }, 120_000);

  it("reports named phases and proportional epoch progress", async () => {
    const phases = [];
    const progress = [];
    const params = defaultParams({ nNeighbors: 8, nEpochs: 120, seed: 1 });
    await runProjection({
      ...threeClusters(20),
      algorithm: "umap",
      params,
      onPhase: (p) => phases.push(p),
      onProgress: (p) => progress.push(p),
    });

    // Two phases, because the first is genuinely unreportable (one opaque
    // call) and the label is the only proof of life the user gets.
    expect(phases.length).toBeGreaterThanOrEqual(2);
    expect(phases[0]).toMatch(/neighbour graph/i);

    expect(progress.length).toBeGreaterThan(0);
    // The total is known up front — it is `nEpochs`, an explicit parameter
    // rather than umap-js's internal size heuristic, precisely so the job's
    // bar is never indeterminate against a knowable total (#208).
    expect(progress.every((p) => p.total === params.nEpochs)).toBe(true);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i].done).toBeGreaterThanOrEqual(progress[i - 1].done);
    }
    expect(progress.at(-1).done).toBe(params.nEpochs);
  }, 60_000);

  it("cancels via AbortSignal and rejects as an AbortError", async () => {
    // Cancel must work DURING the unyieldable phase, which is the whole reason
    // this runs in a worker rather than on the event loop.
    const ac = new AbortController();
    const p = runProjection({
      ...threeClusters(400),
      algorithm: "umap",
      params: defaultParams({ nEpochs: 500, seed: 1 }),
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 40);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  }, 60_000);

  it("rejects immediately when the signal is ALREADY aborted", async () => {
    // Otherwise a cancel that lands between the job being created and the
    // worker starting is ignored, and the user's Stop does nothing.
    const ac = new AbortController();
    ac.abort();
    await expect(
      runProjection({
        ...threeClusters(10),
        algorithm: "umap",
        params: defaultParams(),
        signal: ac.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
  }, 30_000);

  it("surfaces an unknown algorithm as a real Error rather than hanging", async () => {
    await expect(
      runProjection({
        ...threeClusters(5),
        algorithm: "no-such-algorithm",
        params: defaultParams(),
      })
    ).rejects.toThrow(/unknown algorithm/i);
  }, 30_000);

  it("rejects an empty member set rather than producing an empty map", async () => {
    await expect(
      runProjection({
        data: new Float32Array(0),
        dim: 0,
        n: 0,
        algorithm: "umap",
        params: defaultParams(),
      })
    ).rejects.toThrow(/nothing to project/i);
  }, 30_000);

  it("leaves the caller's buffer usable rather than detaching it", async () => {
    // personCentroids hands back one buffer the route may still read. A
    // transferred (rather than copied) buffer is detached, and every later
    // read throws — a failure that would only appear once a second consumer
    // existed.
    const fx = threeClusters(10);
    await runProjection({
      ...fx,
      algorithm: "pca",
      params: defaultParams({ seed: 1 }),
    });
    expect(fx.data.length).toBe(fx.n * DIM);
    expect(Number.isFinite(fx.data[0])).toBe(true);
  }, 30_000);
});
