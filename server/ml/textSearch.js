/**
 * Rank the library against a phrase (#164).
 *
 * ## Why this is a search and not a set of tags
 *
 * The obvious design — pick a vocabulary, score it once, write a tag wherever
 * the score clears a threshold — cannot be made correct with this model.
 * SigLIP is trained with a sigmoid loss whose learned scale and bias are not
 * present in the split ONNX exports, so the raw cosine is uncalibrated and the
 * whole distribution SHIFTS per phrase. Measured over the real 16,797-photo
 * library on 2026-07-26:
 *
 *   phrase                    p50       p99      max
 *   "a photo of a dog"      -0.0131   0.0526   0.0995
 *   "a photo of a beach"    -0.0219   0.0723   0.0984
 *   "a photo of a sunset"   -0.0168   0.0783   0.1028
 *   "a photo of snow"        0.0035   0.0549   0.0977
 *
 * A cutoff of 0.06 is the top 1% for "dog" and the top 3% for "sunset". There
 * is no constant that means "this is a dog", and a per-phrase PERCENTILE is no
 * better: "top 1%" asserts the library holds exactly 168 dog photos whether it
 * holds five hundred or none.
 *
 * So nothing is thresholded. The library is ranked, the user sees where the
 * results stop being dogs, and the cut is theirs. What they keep becomes a
 * real tag; what they don't costs nothing.
 *
 * ## Why scoring everything is fine
 *
 * Measured on the same library: loading all 16,797 vectors takes 12 ms and
 * scoring them against one phrase 8-17 ms — the vectors are int8 and the
 * arithmetic is a dot product per photo. There is no index to maintain, no
 * staleness to reason about, and a phrase never seen before is as fast as one
 * asked a hundred times.
 */

/**
 * Every stored vector for `model`, ready to score.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @returns {Array<{photoId: number, dim: number, scale: number, vec: Buffer}>}
 */
export function embeddedVectors(db, model) {
  return db
    .prepare(
      `SELECT photo_id AS photoId, dim, scale, vec
         FROM photo_embeddings WHERE model = ?`
    )
    .all(model);
}

/**
 * L2-normalize a raw model vector.
 *
 * The stored side is already normalized (quantize() normalizes BEFORE
 * quantizing, which is what lets cosine collapse to a rescaled dot product),
 * so normalizing the query is what makes the two comparable. A zero vector
 * cannot be normalized and is returned untouched rather than turned into NaNs
 * — the caller rejects it, because silently scoring every photo as NaN would
 * sort arbitrarily and look like a working search.
 *
 * @param {Float32Array|number[]} v
 * @returns {Float32Array}
 */
export function normalize(v) {
  let sum = 0;
  for (const x of v) sum += x * x;
  const mag = Math.sqrt(sum);
  if (!mag || !Number.isFinite(mag)) return Float32Array.from(v);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / mag;
  return out;
}

/**
 * Score EVERY row against a normalized query vector, best first.
 *
 * Returns the whole library, not a page. The caller slices, and it must:
 * `scoreQuantiles` describes where the results stop being good, and the top
 * 500 of a 16,797-photo library is already the top 3% — a distribution taken
 * from a truncated list would describe only the good end and put the "results
 * get weak here" marker in the wrong place. Scoring and sorting everything
 * costs single-digit milliseconds (see the module doc), so there is nothing
 * to save by truncating early.
 *
 * Rows whose width differs from the query's are skipped rather than scored.
 * That can only happen if two models' rows coexist under one model name; the
 * image path throws on it, but a search must still answer usefully when one
 * stale row is malformed, and a skipped row is a missing answer where a scored
 * one would be a wrong answer.
 *
 * The dot product is written out rather than reusing quantize.js's `dot`,
 * whose contract is int8-against-int8. Here the query side is float — the
 * arithmetic is identical, but borrowing a function by ignoring its declared
 * types is how the next reader concludes both sides are quantized.
 *
 * @param {Array<{photoId: number, dim: number, scale: number, vec: Buffer}>} rows
 * @param {Float32Array} query already normalized
 * @returns {Array<{photoId: number, score: number}>}
 */
export function rankByVector(rows, query) {
  const scored = [];
  for (const r of rows) {
    if (r.dim !== query.length) continue;
    const b = new Int8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength);
    let sum = 0;
    for (let i = 0; i < b.length; i++) sum += b[i] * query[i];
    scored.push({ photoId: r.photoId, score: sum * r.scale });
  }
  // Descending by score, ties broken by id so the order is stable across
  // calls: two frames of a burst routinely score identically, and a result
  // list that reshuffles on every keystroke reads as a flickering bug.
  scored.sort((a, b) => b.score - a.score || a.photoId - b.photoId);
  return scored;
}

/**
 * Percentile markers for the score distribution.
 *
 * The scores have no absolute meaning (see the module doc), so a bare "0.071"
 * tells the user nothing. Against the library's own distribution it tells them
 * everything: p99 is where the top 1% begins, and the point at which a ranked
 * list stops being worth scrolling is usually visible right there.
 *
 * @param {Array<{score: number}>} scored the FULL ranked list
 * @returns {{p50: number, p90: number, p99: number}|null}
 */
export function scoreQuantiles(scored) {
  if (!scored.length) return null;
  const s = scored.map((x) => x.score).sort((a, b) => a - b);
  const at = (f) => s[Math.floor(f * (s.length - 1))];
  return { p50: at(0.5), p90: at(0.9), p99: at(0.99) };
}
