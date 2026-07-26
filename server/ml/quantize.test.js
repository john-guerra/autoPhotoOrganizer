import { describe, it, expect } from "vitest";
import { quantize, dequantize, dot } from "./quantize.js";

/** Cosine similarity on plain floats, the reference the int8 path must match. */
function cosine(a, b) {
  let ab = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return ab / Math.sqrt(aa * bb);
}

function randomVec(n, seed) {
  // Deterministic LCG — a flaky quantization test is worse than none.
  let s = seed;
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    v[i] = s / 2147483648 - 0.5;
  }
  return v;
}

describe("quantize", () => {
  it("round-trips to a UNIT vector within int8 resolution", () => {
    const { scale, bytes } = quantize(randomVec(768, 7));
    const back = dequantize(bytes, scale);

    let norm = 0;
    for (const x of back) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 2);
  });

  it("produces int8 values that use the range", () => {
    const { bytes } = quantize(randomVec(768, 11));
    expect(bytes).toBeInstanceOf(Int8Array);
    expect(Math.max(...bytes)).toBeGreaterThan(100);
    expect(Math.min(...bytes)).toBeLessThan(-100);
  });

  it("normalizes, so a scaled vector quantizes identically", () => {
    const v = randomVec(768, 13);
    const scaled = Float32Array.from(v, (x) => x * 17.5);
    expect(Array.from(quantize(scaled).bytes)).toEqual(
      Array.from(quantize(v).bytes)
    );
  });

  it("makes the int8 dot product track true cosine similarity", () => {
    const a = randomVec(768, 3);
    const b = randomVec(768, 5);
    const qa = quantize(a);
    const qb = quantize(b);

    // Because both stored vectors are unit-length, cosine IS the dot product
    // of the reconstructed floats — the whole reason we normalize BEFORE
    // quantizing. No per-comparison division in the hot scan.
    const approx = dot(qa.bytes, qb.bytes) * qa.scale * qb.scale;
    expect(approx).toBeCloseTo(cosine(a, b), 2);
  });

  it("scores a vector against itself at ~1.0", () => {
    const { scale, bytes } = quantize(randomVec(768, 17));
    expect(dot(bytes, bytes) * scale * scale).toBeCloseTo(1, 2);
  });

  it("rejects a zero vector rather than emitting NaNs", () => {
    expect(() => quantize(new Float32Array(768))).toThrow(/zero/i);
  });

  it("rejects a length mismatch in dot rather than reading past the end", () => {
    expect(() => dot(new Int8Array(4), new Int8Array(8))).toThrow(/length/i);
  });
});
