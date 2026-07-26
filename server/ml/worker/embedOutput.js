/**
 * Validate a vision encoder's raw tensor output and slice it into one plain
 * number array per image.
 *
 * Deliberately a pure function — no transformers.js, no stdio, no module
 * state — so it is unit-testable without spawning the worker process.
 * Importing server/ml/worker/index.js directly into a test process would run
 * its top-level side effects (loading onnxruntime-node, redirecting
 * console/stdout for the lifetime of the process), which would corrupt the
 * test runner's own output; this module has none of that.
 *
 * The registry's `dim` (server/ml/models.js) is otherwise dead code: nothing
 * enforces the tensor that actually came back matches it. SigLIP in
 * particular also exposes `last_hidden_state` at [n, 196, 768] alongside the
 * pooled `pooler_output` this app wants — if a registry edit or an upstream
 * re-export ever put the wrong tensor behind `outputKey`, the naive
 * `const [n, dim] = tensor.dims` reads `dim = 196` and slices `n` vectors of
 * plausible-looking garbage off the front of the buffer. Well-formed JSON,
 * plausible numbers, wrong on every axis — exactly what models.js's own
 * header warns nothing downstream can detect. Checking the batch size too
 * (not just the vector width) closes mis-attribution, which a shape check
 * alone would miss.
 *
 * @param {{dims: number[], data: ArrayLike<number>}} tensor
 * @param {{modelId: string, outputKey: string, dim: number, batchSize: number}} ctx
 * @returns {number[][]}
 */
export function extractVectors(tensor, { modelId, outputKey, dim, batchSize }) {
  const shape = tensor.dims;
  if (shape.length !== 2 || shape[1] !== dim || shape[0] !== batchSize) {
    throw new Error(
      `embed: unexpected output shape for ${modelId}.${outputKey}: ` +
        `expected [${batchSize}, ${dim}], got [${shape.join(", ")}]`
    );
  }

  const vectors = [];
  for (let i = 0; i < shape[0]; i++) {
    const vec = Array.from(tensor.data.slice(i * dim, (i + 1) * dim));
    // JSON.stringify silently encodes NaN/Infinity as `null`, and the
    // parent's Float32Array.from([null, ...]) turns that into a plausible
    // `0` — a loud numerical failure would otherwise become an
    // undetectable wrong answer.
    for (const v of vec) {
      if (!Number.isFinite(v)) {
        throw new Error(
          `embed: non-finite value in ${modelId}.${outputKey} output (image ${i})`
        );
      }
    }
    vectors.push(vec);
  }
  return vectors;
}
