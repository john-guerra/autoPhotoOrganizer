import { describe, it, expect } from "vitest";
import {
  ALGORITHMS,
  TSNE_MAX_MEMBERS,
  offerableAlgorithms,
  isOfferable,
  defaultParams,
} from "./algorithms.js";

describe("offerableAlgorithms (#232)", () => {
  it("always offers UMAP, at every size", () => {
    // It is the only method measured that both scales to a whole library and
    // has usable neighbourhood fidelity, so it is the one that can never be
    // unavailable.
    for (const n of [10, 5_499, 25_758, 200_000]) {
      expect(isOfferable("umap", n)).toBe(true);
    }
  });

  it("offers t-SNE below the cap", () => {
    // 5,499 is the real working set (persons with >=2 faces) and t-SNE costs
    // about 2 minutes there — worth it for 93% top-5 against UMAP's 58%.
    expect(isOfferable("tsne", 5_499)).toBe(true);
    expect(isOfferable("tsne", TSNE_MAX_MEMBERS)).toBe(true);
  });

  it("refuses t-SNE above the cap WITH A REASON, rather than hiding it", () => {
    // t-SNE is O(n^2): 74s at 4,072 points measured, so ~47 minutes at
    // 25,758. Silently dropping the option would read as a missing feature;
    // offering it would wedge the app. Disabled-with-a-reason is the only
    // honest third answer.
    expect(isOfferable("tsne", TSNE_MAX_MEMBERS + 1)).toBe(false);
    const row = offerableAlgorithms(25_758).find((a) => a.id === "tsne");
    expect(row).toBeDefined();
    expect(row.enabled).toBe(false);
    expect(row.reason).toMatch(/6,000/);
    expect(row.reason).toMatch(/minimum faces/i);
  });

  it("never offers the algorithms that measured at chance", () => {
    // SQDMDS scored 0.0% twin-is-nearest with a median rank of 1822, and MDS
    // 2.8%, on the time-split test. Those are not choices, they are traps —
    // and SQDMDS scores 100% on a naive benchmark, so it WILL be re-proposed.
    for (const n of [100, 5_499, 25_758]) {
      const ids = offerableAlgorithms(n).map((a) => a.id);
      expect(ids).not.toContain("sqdmds");
      expect(ids).not.toContain("mds");
      expect(ids).not.toContain("fastmap");
    }
  });

  it("every option carries a label and a note with its measured score", () => {
    // The note is what turns a menu of three options, two of which are worse,
    // from a footgun into information.
    for (const a of offerableAlgorithms(5_499)) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.note.length).toBeGreaterThan(0);
      expect(a.note).toMatch(/\d/);
    }
    expect(ALGORITHMS.map((a) => a.id)).toEqual(["umap", "tsne", "pca"]);
  });

  it("is total: an unknown algorithm is not offerable rather than throwing", () => {
    expect(isOfferable("nope", 100)).toBe(false);
    expect(isOfferable(undefined, 100)).toBe(false);
  });

  it("handles a nonsense member count without throwing", () => {
    for (const n of [0, -1, NaN, undefined, null]) {
      expect(Array.isArray(offerableAlgorithms(n))).toBe(true);
    }
  });
});

describe("defaultParams", () => {
  it("defaults minFaces to 2 — the measured default that makes the map cheap", () => {
    // 5,499 members instead of 25,758: initializeFit 14.1s -> 2.1s and peak
    // RSS 1,825MB -> 824MB.
    expect(defaultParams().minFaces).toBe(2);
  });

  it("names nEpochs EXPLICITLY rather than leaving it to umap-js's heuristic", () => {
    // umap-js picks 500/400/300/200 by point count. Leaving it implicit would
    // mean the job's total is unknown until the worker starts, which is a bar
    // that arrives late at exactly the moment the user is deciding whether it
    // hung (#208) — and it would make the run cache key incomplete.
    expect(defaultParams().nEpochs).toBeGreaterThan(0);
    expect(Number.isInteger(defaultParams().nEpochs)).toBe(true);
  });

  it("carries a fixed seed, so a run is reproducible", () => {
    expect(defaultParams().seed).toBe(defaultParams().seed);
    expect(Number.isFinite(defaultParams().seed)).toBe(true);
  });

  it("clamps hostile input rather than passing it to the worker", () => {
    // These arrive from a JSON body. nNeighbors <= 1 or nEpochs of 0 produce
    // a degenerate or empty layout, and a huge nEpochs is a job nobody asked
    // to wait for.
    const p = defaultParams({
      minFaces: -5,
      nNeighbors: 0,
      nEpochs: 10 ** 9,
      minDist: -1,
    });
    expect(p.minFaces).toBeGreaterThanOrEqual(1);
    expect(p.nNeighbors).toBeGreaterThanOrEqual(2);
    expect(p.nEpochs).toBeLessThanOrEqual(2000);
    expect(p.minDist).toBeGreaterThanOrEqual(0);
  });

  it("keeps only known keys, so the cache key cannot be polluted", () => {
    // The params object IS the cache key. An unknown field riding along would
    // make every request a cache miss and recompute a 20-second map forever.
    const p = defaultParams({ minFaces: 3, evil: "x", __proto__: { y: 1 } });
    expect(Object.keys(p).sort()).toEqual(
      ["minDist", "minFaces", "nEpochs", "nNeighbors", "seed"].sort()
    );
  });
});
