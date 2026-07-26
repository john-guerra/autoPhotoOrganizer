/**
 * Which execution provider the ML worker tries, in what order, on this
 * machine.
 *
 * Its own module for one reason: this encodes the only EMPIRICAL result in
 * #161 — darwin leads with CPU because CPU was MEASURED faster than WebGPU at
 * the real production configuration — and importing worker/index.js runs that
 * file's top-level side effects (it redirects stdout, imports
 * onnxruntime-node, and attaches a stdin listener), so the decision could not
 * be tested where it lived. A pure function of platform/arch, testable in
 * isolation, protects the measurement from being "corrected" back to an
 * accelerator-first order on principle. Same split as embedOutput.js.
 */

/**
 * Mirrors transformers.js's own `supportedDevices` table
 * (dist/transformers.node.mjs) for the Node environment, which is what this
 * worker actually runs — an OLDER version of this comment (#161, Task 11)
 * claimed prebuilt onnxruntime-node had NO CoreML on any platform; that was
 * wrong (verified directly: `onnxruntime-node`'s `listSupportedBackends()`
 * reports `coreml` as bundled on this darwin/arm64 machine) and the fix was
 * this selection logic, not a second out-of-process host. The spec records
 * the reversal and the false premise it rested on:
 * docs/superpowers/specs/2026-07-25-image-embeddings-design.md, "Superseded
 * 2026-07-25".
 *
 * Deliberately NOT `device: "auto"`: that hands ORT the whole candidate list
 * itself and gives this process no way to learn which EP actually ran, and
 * `describeProvider()` (OnnxMLService.js) is rendered to the user under a
 * rule that it must never claim an accelerator that isn't really running.
 * Trying candidates explicitly, one at a time, is what makes the winner
 * observable.
 *
 * win32/linux keep an accelerator-first order (DirectML/CUDA, then WebGPU,
 * `cpu` last as the untested-but-guaranteed floor) — nobody has measured
 * those platforms yet; that is the DEFAULT assumption an accelerator beats
 * CPU, not a measured one. darwin does NOT: see below.
 *
 * darwin's order is a MEASURED choice, not the accelerator-first default —
 * re-measure before "fixing" it back. `ML_INTEGRATION=1 npx vitest run
 * server/ml/OnnxMLService.test.js` (the two "measures ms/photo" tests) on
 * this darwin/arm64 machine, 2026-07-25:
 *
 *   CLIP ViT-B/32, batch=4, threads=2:
 *     coreml: BROKEN (constructs fine, throws on first real inference —
 *              batch-size sensitive: passes at batch=1, fails at batch>=2)
 *     webgpu: 22.79 ms/photo
 *     cpu:    12.98 ms/photo
 *
 *   SigLIP base patch16-224 (DEFAULT_MODEL_ID) @ batch=16 (embedAllPending's
 *   real production `limit`), threads=2 — the configuration that actually
 *   matters, not a cheaper stand-in:
 *     coreml: BROKEN, same failure signature as above (re-confirmed at
 *              production batch size, not assumed from the CLIP result)
 *     webgpu: 60.98 ms/photo
 *     cpu:    38.93 ms/photo
 *
 * CPU wins BOTH configurations, including the real production one, and
 * CoreML is not merely slower — it does not work at all for either vetted
 * model at any batch size above 1, on this machine. So darwin leads with
 * `cpu`, not an accelerator: attempting coreml/webgpu first would only add
 * a guaranteed-failed attempt (coreml) or a genuinely slower successful one
 * (webgpu) before falling through to what wins anyway. webgpu/coreml stay
 * in the list — never both removed — so a future model, a future
 * onnxruntime-node/CoreML fix, or different hardware still has a path to
 * being picked; only the ORDER reflects today's measurement. If you're
 * changing this back to an accelerator-first order "on principle," don't —
 * re-run the ML_INTEGRATION benchmark on the hardware in front of you first
 * and update this comment (and devices.test.js) with what it actually says.
 *
 * A caveat for whoever measures win32/linux next, where an accelerator
 * still leads: `loadWithBestDevice`'s validation pass only runs once, on
 * the COLD load, using whatever batch triggered it — but a sweep's first
 * batch can be smaller than `limit` (16) if the backlog was under 16 when
 * the sweep started, and later batches (same warm model, no new cold load)
 * can be larger. A batch-size-sensitive EP failure that only appears ABOVE
 * the batch size that happened to trigger the cold load — the exact shape
 * CoreML failed in on this machine, just at a size the first validation
 * missed — would not be re-validated once the model is warm. Moot here:
 * `cpu` leads darwin's list now and is immune to this by construction. Live
 * wherever an accelerator is still first.
 *
 * @param {string} [platform] defaults to this process's; a parameter so the
 *   table can be asserted for every platform from one machine
 * @param {string} [arch] defaults to this process's
 * @returns {string[]}
 */
export function candidateDevices(
  platform = process.platform,
  arch = process.arch
) {
  if (platform === "darwin") return ["cpu", "webgpu", "coreml"];
  if (platform === "win32") return ["dml", "webgpu", "cpu"];
  if (platform === "linux") {
    // CUDA in onnxruntime-node's prebuilt is x64-only (no aarch64 CUDA
    // build) — falling straight to webgpu/cpu on e.g. a Linux arm64 box
    // rather than attempting (and always failing) a "cuda" load first.
    return arch === "x64" ? ["cuda", "webgpu", "cpu"] : ["webgpu", "cpu"];
  }
  return ["cpu"]; // unknown platform: don't guess at an accelerator name
}
