import { describe, it, expect } from "vitest";
import { normalize, rankByVector, scoreQuantiles } from "./textSearch.js";
import { quantize } from "./quantize.js";

/** A stored row, built the way the real pipeline builds one: quantize()
 *  normalizes before quantizing, which is what lets cosine collapse to a
 *  rescaled dot product. */
function row(photoId, vec) {
  const { scale, bytes } = quantize(Float32Array.from(vec));
  return {
    photoId,
    dim: vec.length,
    scale,
    vec: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  };
}

describe("normalize", () => {
  it("makes a vector unit length", () => {
    const n = normalize([3, 4]);
    expect(Math.hypot(...n)).toBeCloseTo(1, 6);
    expect(n[0]).toBeCloseTo(0.6, 6);
  });

  it("returns a zero vector untouched instead of a vector of NaNs", () => {
    // NaNs would score every photo NaN, sort arbitrarily, and look exactly
    // like a working search returning bad results.
    const n = normalize([0, 0, 0]);
    expect([...n]).toEqual([0, 0, 0]);
    expect([...n].every(Number.isFinite)).toBe(true);
  });
});

describe("rankByVector (#164)", () => {
  it("puts the closest vector first and the opposite one last", () => {
    const rows = [
      row(1, [0, 1, 0]), // orthogonal
      row(2, [1, 0, 0]), // identical to the query
      row(3, [-1, 0, 0]), // opposite
    ];
    const ranked = rankByVector(rows, normalize([1, 0, 0]));

    expect(ranked.map((r) => r.photoId)).toEqual([2, 1, 3]);
    expect(ranked[0].score).toBeCloseTo(1, 2);
    expect(ranked[2].score).toBeCloseTo(-1, 2);
  });

  it("returns the WHOLE library, not a page", () => {
    // The caller slices. scoreQuantiles needs the full distribution to put
    // the "results get weak here" marker in the right place — the top 500 of
    // this library is already its top 3%.
    const rows = Array.from({ length: 700 }, (_, i) => row(i + 1, [1, i, 0]));
    expect(rankByVector(rows, normalize([1, 0, 0]))).toHaveLength(700);
  });

  it("breaks ties by id so the order does not wobble between calls", () => {
    // Two frames of a burst routinely score identically; a list that
    // reshuffles on each keystroke reads as a flickering bug.
    const rows = [row(9, [1, 0, 0]), row(2, [1, 0, 0]), row(5, [1, 0, 0])];
    const a = rankByVector(rows, normalize([1, 0, 0])).map((r) => r.photoId);
    const b = rankByVector([...rows].reverse(), normalize([1, 0, 0])).map(
      (r) => r.photoId
    );
    expect(a).toEqual([2, 5, 9]);
    expect(b).toEqual(a);
  });

  it("skips a row of the wrong width rather than scoring it", () => {
    // Only possible if two models' rows coexist under one model name. A
    // missing answer beats a wrong one, and it must not throw — one stale row
    // cannot take the whole search down.
    const rows = [row(1, [1, 0, 0]), row(2, [1, 0, 0, 0, 0])];
    const ranked = rankByVector(rows, normalize([1, 0, 0]));
    expect(ranked.map((r) => r.photoId)).toEqual([1]);
  });

  it("answers an empty library with an empty list", () => {
    expect(rankByVector([], normalize([1, 0, 0]))).toEqual([]);
  });
});

describe("scoreQuantiles", () => {
  it("describes the distribution the scores actually have", () => {
    const scored = Array.from({ length: 100 }, (_, i) => ({ score: i / 100 }));
    const q = scoreQuantiles(scored);
    expect(q.p50).toBeCloseTo(0.49, 2);
    expect(q.p90).toBeCloseTo(0.89, 2);
    expect(q.p99).toBeCloseTo(0.98, 2);
  });

  it("is null for no results, so the UI shows no scale rather than a fake one", () => {
    expect(scoreQuantiles([])).toBeNull();
  });
});
