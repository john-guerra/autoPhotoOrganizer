/**
 * int8 vector storage, and the one arithmetic operation every consumer needs.
 *
 * 114k x 768 float32 is 350 MB; int8 it is 87 MB, which loads into one typed
 * array and brute-force scans in well under 100 ms. That measurement is why the
 * program design says "no vector database" — sqlite-vec is the escape hatch if
 * it stops being true, not the starting point.
 *
 * THE ORDER MATTERS: L2-normalize FIRST, then quantize. Because every stored
 * vector is unit-length, cosine similarity collapses to a plain dot product —
 * no per-comparison division and no norm lookups in the hot loop. Quantizing
 * first and normalizing later would put a divide back in the inner loop for
 * every one of ~114k comparisons.
 */

/**
 * @param {Float32Array} vec raw model output, any magnitude
 * @returns {{scale: number, bytes: Int8Array}} `scale` reconstructs floats:
 *   float[i] === bytes[i] * scale
 */
export function quantize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  // A zero vector has no direction, so it has no cosine similarity to anything
  // — every comparison against it would be NaN, and NaN sorts unpredictably
  // rather than failing. Throwing sends this row to the sweep's sentinel path,
  // where it is COUNTABLE, instead of poisoning every future ranking.
  if (!(norm > 0)) throw new Error("cannot quantize a zero-magnitude vector");

  let maxAbs = 0;
  for (let i = 0; i < vec.length; i++) {
    const a = Math.abs(vec[i] / norm);
    if (a > maxAbs) maxAbs = a;
  }
  const scale = maxAbs / 127;

  const bytes = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    bytes[i] = Math.round(vec[i] / norm / scale);
  }
  return { scale, bytes };
}

/**
 * @param {Int8Array} bytes
 * @param {number} scale
 * @returns {Float32Array} the reconstructed unit vector
 */
export function dequantize(bytes, scale) {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] * scale;
  return out;
}

/**
 * Raw int8 dot product. Multiply by both vectors' scales to get cosine
 * similarity — the caller does that once per pair, not per element.
 * @param {Int8Array} a
 * @param {Int8Array} b
 * @returns {number}
 */
export function dot(a, b) {
  if (a.length !== b.length) {
    throw new Error(`dot: length mismatch (${a.length} vs ${b.length})`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
