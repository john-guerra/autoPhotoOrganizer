/**
 * The ML child process.
 *
 * JSON-lines over stdio, one request at a time. Loads onnxruntime-node and
 * reports what it found (`health`), loads a vetted vision encoder on demand
 * and runs real inference (`configure`, `embed`).
 *
 * Nothing here may write to stdout except a reply line — stdout IS the
 * protocol. Diagnostics go to stderr. Both `console.*` and the underlying
 * `process.stdout.write` are redirected to stderr below, before any dynamic
 * import that might log during its own module initialization (onnxruntime-node,
 * then later @huggingface/transformers) — `reply()` alone keeps a bound
 * reference to the real stdout stream, captured before the redirect.
 */
import { format } from "node:util";
import { modelById } from "../models.js";
import { extractVectors } from "./embedOutput.js";

// Must run before any dynamic import below — a module's own top-level code
// can log during initialization, and that has to land on stderr too, not
// just calls made after this point.
const realStdoutWrite = process.stdout.write.bind(process.stdout);
for (const level of ["log", "info", "warn", "error", "debug"]) {
  // node:util's `format` handles %s/%d specifiers and renders objects/Errors
  // properly (util.inspect under the hood) — stderr is this process's ONLY
  // diagnostic channel, so a `[object Object]` or a stack-less Error here is
  // a failure nobody can debug.
  console[level] = (...args) => process.stderr.write(format(...args) + "\n");
}
// Belt and suspenders: nothing legitimately calls process.stdout.write
// directly except reply() (which uses the saved realStdoutWrite reference
// above) — redirect the raw stream too, so a stray write from a future
// dependency bump degrades to a stderr line instead of corrupting the
// JSON-lines protocol every reply() line depends on.
process.stdout.write = (chunk, ...rest) => process.stderr.write(chunk, ...rest);

let ort = null;
let loadError = null;
try {
  ort = (await import("onnxruntime-node")).default;
} catch (e) {
  loadError = e;
}

let transformers = null;
let loaded = null; // { id, model, processor, outputKey, dim, device }
let unloadTimer = null;
// `device`: an explicit EP override, used only by the ML_INTEGRATION
// benchmark (OnnxMLService.test.js) to force a single candidate with no
// fallthrough so it can time each EP individually. `null` (the normal path)
// means "auto-select" — see candidateDevices()/loadWithBestDevice() below.
let config = { modelId: null, threads: 1, device: null };

/**
 * Execution-provider candidates to try, in order, for this machine — cheapest
 * real accelerator first, `cpu` always last as the guaranteed floor (every
 * platform's onnxruntime-node build has it). Mirrors transformers.js's own
 * `supportedDevices` table (dist/transformers.node.mjs) for the Node
 * environment, which is what this worker actually runs — the OLDER version
 * of this comment (Task 11) claimed prebuilt onnxruntime-node had NO CoreML
 * on any platform; that was wrong (verified directly:
 * `onnxruntime-node`'s `listSupportedBackends()` reports `coreml` as bundled
 * on this darwin/arm64 machine) and the fix is this file, not a second
 * out-of-process host — see task-11-report.md's "Revert and replace" section.
 *
 * Deliberately NOT `device: "auto"`: that hands ORT the whole candidate list
 * itself and gives this process no way to learn which EP actually ran, and
 * `describeProvider()` (OnnxMLService.js) is rendered to the user under a
 * rule that it must never claim an accelerator that isn't really running.
 * Trying candidates explicitly, one at a time, is what makes the winner
 * observable.
 * @returns {string[]}
 */
function candidateDevices() {
  if (process.platform === "darwin") return ["coreml", "webgpu", "cpu"];
  if (process.platform === "win32") return ["dml", "webgpu", "cpu"];
  if (process.platform === "linux") {
    // CUDA in onnxruntime-node's prebuilt is x64-only (no aarch64 CUDA
    // build) — falling straight to webgpu/cpu on e.g. a Linux arm64 box
    // rather than attempting (and always failing) a "cuda" load first.
    return process.arch === "x64"
      ? ["cuda", "webgpu", "cpu"]
      : ["webgpu", "cpu"];
  }
  return ["cpu"]; // unknown platform: don't guess at an accelerator name
}

/**
 * Try each candidate EP in order; the first that both CONSTRUCTS a session
 * AND completes one real forward pass, AT THE REAL REQUEST'S BATCH SIZE,
 * wins.
 *
 * Construction succeeding is NOT sufficient, and — this was found the hard
 * way while writing this, twice — neither is a single-image smoke test.
 * Measured directly on real darwin/arm64 hardware: `from_pretrained(...,
 * {device: "coreml"})` for Xenova/clip-vit-base-patch32 (int8) returns
 * cleanly, a batch-of-1 forward pass through it SUCCEEDS, and a batch-of-2
 * forward pass through the SAME session then throws ("Non-zero status code
 * returned ... Unable to compute the prediction using a neural network
 * model"). This app's real batches are 16 (embedSweep.js's default `limit`)
 * with singleton retries mixed in, so validating with only a synthetic
 * single image would have kept reporting `describeProvider() -> "coreml"`
 * while every real 16-photo batch failed — precisely the "every embed
 * fails, runSweep writes a permanent sentinel for the whole library"
 * failure mode the deleted WebGPU-renderer host was found to have, just
 * relocated one layer down. See task-11-report.md's "Revert and replace"
 * section for the measured numbers (including this exact failure).
 *
 * `imagesB64` is the REAL request's own images (not a synthetic dummy, not
 * a truncated probe) — whatever batch size actually triggered this cold
 * load is what gets validated, which is the batch size that matters most:
 * the one this session will immediately be asked to run for real right
 * after ensureModel() returns. The validation forward pass is discarded
 * (the embed handler computes its own copy right after) rather than reused,
 * deliberately: two DIFFERENT `embed` requests can race the same cold load
 * (see the in-flight load memo below) and get back the SAME resolved
 * candidate — reusing a precomputed tensor here would risk handing a racing
 * caller's own batch someone else's output. One extra forward pass, only on
 * a cold load, is a small price for never getting that wrong.
 *
 * `cpu` is always the last candidate on every platform (candidateDevices()
 * above) and has no further EP to fall back to, so if it ALSO fails this
 * throws for real rather than swallowing it.
 * @param {object} spec model registry entry (models.js)
 * @param {string[]} candidates
 * @param {object} processor already-loaded AutoProcessor (device-independent)
 * @param {string[]|undefined} imagesB64 the real request's images (base64)
 * @param {(p: object) => void} progress_callback
 * @returns {Promise<{model: object, device: string}>}
 */
async function loadWithBestDevice(
  spec,
  candidates,
  processor,
  imagesB64,
  progress_callback
) {
  let lastErr = null;
  for (const device of candidates) {
    try {
      const model = await transformers[spec.loader].from_pretrained(spec.id, {
        dtype: spec.dtype,
        device,
        // intraOpNumThreads caps CPU-side ops. Meaningful in every case, not
        // just the "cpu" candidate: it's also the floor for a GPU/NPU EP's
        // own CPU-side fallback ops (whatever the EP doesn't implement runs
        // on CPU within the same session), and it's the only knob this app
        // exposes to the user (the threads slider), so it must apply
        // uniformly regardless of which device wins.
        session_options: { intraOpNumThreads: config.threads },
        progress_callback,
      });
      if (imagesB64 && imagesB64.length) {
        const { RawImage } = transformers;
        const probeImages = await Promise.all(
          imagesB64.map((b64) =>
            RawImage.fromBlob(new Blob([Buffer.from(b64, "base64")]))
          )
        );
        const probeInputs = await processor(probeImages);
        await model(probeInputs); // the real test — see doc above
      }
      return { model, device };
    } catch (e) {
      lastErr = e;
      // A silent downgrade from GPU to CPU is exactly the invisible-failure
      // shape this app keeps hitting (CLAUDE.md, "Usability") — this is the
      // worker's ONLY diagnostic channel (stdout is the JSON-lines protocol),
      // so the reason a candidate was skipped is not lost, even though
      // nothing in the UI surfaces it today.
      console.error(
        `ML worker: "${device}" execution provider failed for ${spec.id} (${e?.message ?? e}); trying the next candidate`
      );
    }
  }
  throw lastErr ?? new Error("no execution provider candidates configured");
}

// In-flight load memo, keyed by the model id being loaded. `handle()` is
// async and stdin delivers one line per microtask turn with no queueing, so
// two `embed` requests arriving in the same chunk can both observe
// `loaded === null` before either finishes loading. Without this, both call
// `from_pretrained` concurrently: two ~100 MB downloads racing to write the
// same cache files (a truncated .onnx from the loser can leave the model
// permanently unloadable, with no checksum to catch it), two sessions
// resident at once (~800 MB), and `loaded` clobbered by whichever finishes
// last.
let loadingPromise = null;
let loadingModelId = null;

/** Models return their RAM after this long idle. A 114k backfill runs for
 *  hours; holding ~400 MB resident afterwards for nothing is not acceptable
 *  on a machine the user is also editing photos on. */
const UNLOAD_AFTER_MS = 120_000;

/**
 * @param {string} modelId
 * @param {string[]} [imagesB64] the real request's images (base64) that
 *   triggered this load — used to run a genuine validation forward pass, AT
 *   THIS REQUEST'S OWN BATCH SIZE, per EP candidate (see loadWithBestDevice's
 *   doc for why session construction alone, or a batch-of-1 smoke test, is
 *   not enough evidence a candidate actually works). Only ever consulted on
 *   a COLD load (loaded === null); a warm call ignores it, so passing it
 *   costs nothing once a model is resident.
 */
async function ensureModel(modelId, imagesB64) {
  if (loaded?.id === modelId) return loaded;
  if (loadingPromise && loadingModelId === modelId) return loadingPromise;

  loadingModelId = modelId;
  loadingPromise = (async () => {
    const spec = modelById(modelId);

    if (!transformers) {
      transformers = await import("@huggingface/transformers");
      // Models are a rebuildable cache on the INTERNAL disk, like every other
      // derived artifact this app writes. NOT under cache/thumbs/ —
      // pruneOrphanedCache deletes anything there that isn't a known thumb
      // key, regardless of extension, and would eat the model on the next
      // prune. Refuse to guess: an unset/empty var would otherwise fall back
      // to transformers' own default ('./.cache', relative to CWD) — an
      // invisible-to-cacheStats download into the repo or the user's home.
      const modelsDir = process.env.AUTOGALLERY_MODELS_DIR;
      if (!modelsDir) {
        throw new Error(
          "AUTOGALLERY_MODELS_DIR is not set — refusing to let transformers.js " +
            "fall back to its default cache location"
        );
      }
      transformers.env.cacheDir = modelsDir;
      // Cap the intra-op pool. A separate PROCESS is not a separate CPU: left
      // uncapped, ORT grabs every core and starves the libvips pool that
      // server/index.js:19 reserves for thumbnails — measured at 15ms -> 90ms
      // with tiles abandoned mid-scroll (lib/interactive.js).
      transformers.env.backends.onnx.wasm.numThreads = config.threads;
    }

    // Unsolicited progress frames — no `id`, so the parent's #onData routes
    // them to its "progress" event instead of a pending-request waiter. Not
    // wired to any UI yet; Task 10's jobs panel is the intended consumer.
    const progress_callback = (p) => reply({ type: "progress", modelId, ...p });

    // Built once, before the candidate loop: the processor (resize/normalize/
    // tensor-ify) is device-independent, and loadWithBestDevice needs it
    // to run each candidate's real smoke-test forward pass.
    const processor = await transformers.AutoProcessor.from_pretrained(
      spec.id,
      { progress_callback }
    );

    // `config.device` is set only by the ML_INTEGRATION benchmark forcing a
    // single EP with no fallthrough (see candidateDevices()'s doc); the
    // normal path is auto-select across the whole platform candidate list.
    const candidates = config.device ? [config.device] : candidateDevices();
    const { model, device } = await loadWithBestDevice(
      spec,
      candidates,
      processor,
      imagesB64,
      progress_callback
    );
    loaded = {
      id: spec.id,
      model,
      processor,
      outputKey: spec.outputKey,
      dim: spec.dim,
      device,
    };
    return loaded;
  })();

  try {
    return await loadingPromise;
  } finally {
    loadingPromise = null;
    loadingModelId = null;
  }
}

function touchUnloadTimer() {
  clearTimeout(unloadTimer);
  unloadTimer = setTimeout(() => {
    const modelId = loaded?.id;
    loaded = null;
    // Tell the parent — this reuses the unsolicited-frame transport
    // `progress` already established (no `id`, so #onData routes it past
    // the pending-request map). Without this the parent's `#modelWarm` has
    // no way to learn the model went away: this app's sweeps are
    // `whenIdle`-gated by design (runSweep awaits idle() between batches
    // specifically to stand aside while the user browses), so a >2-minute
    // gap between embed batches is the NORMAL case, not an edge case, and
    // the next embed would otherwise be timed as "warm" (30s) while the
    // worker actually has to reload the model from disk.
    if (modelId) reply({ type: "unloaded", modelId });
  }, UNLOAD_AFTER_MS);
  unloadTimer.unref?.();
}

process.stdin.setEncoding("utf8");
let buf = "";

process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim()) handle(line);
  }
});

/** @param {string} line */
async function handle(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return; // unparseable input is the parent's bug; stay alive
  }
  try {
    if (req.op === "health") {
      if (loadError) {
        return reply({
          id: req.id,
          error: `onnxruntime-node: ${loadError.message}`,
        });
      }
      return reply({
        id: req.id,
        ok: true,
        ort: ort.env?.versions?.node ?? "unknown",
        providers: ort.listSupportedBackends?.().map((b) => b.name) ?? ["cpu"],
        pid: process.pid,
      });
    }

    if (req.op === "configure") {
      config = {
        modelId: req.modelId,
        threads: Math.max(1, req.threads | 0),
        // `device` is undefined on every real caller (OnnxMLService.configure
        // never sends it) — `?? null` normalizes that to "auto-select" so
        // ensureModel()'s `config.device ? [device] : candidateDevices()`
        // check works whether the field was omitted or explicitly cleared.
        // Only the ML_INTEGRATION benchmark (OnnxMLService.test.js) sets a
        // real value, to force one EP at a time with no fallthrough.
        device: req.device ?? null,
      };
      // A thread-count (or device) change only takes effect on a fresh
      // session.
      loaded = null;
      return reply({ id: req.id, ok: true });
    }

    if (req.op === "embed") {
      // req.images: on a cold load only, ensureModel() runs each EP
      // candidate against THIS request's own real batch before trusting it
      // — see loadWithBestDevice's doc for why batch size turned out to
      // matter here.
      const { model, processor, outputKey, dim, device } = await ensureModel(
        req.modelId,
        req.images
      );
      const { RawImage } = transformers;
      const images = await Promise.all(
        req.images.map((b64) =>
          RawImage.fromBlob(new Blob([Buffer.from(b64, "base64")]))
        )
      );
      const inputs = await processor(images);
      const out = await model(inputs);
      const tensor = out[outputKey];
      // One tensor holds the whole batch; slice per image and send FLOATS.
      // Quantization happens in the parent so the worker stays a pure
      // encoder. extractVectors() validates shape and batch size against the
      // registry and rejects non-finite values — see embedOutput.js for why.
      const vectors = extractVectors(tensor, {
        modelId: req.modelId,
        outputKey,
        dim,
        batchSize: req.images.length,
      });
      touchUnloadTimer();
      // `device` is the EP that actually won (loadWithBestDevice above) —
      // the parent (OnnxMLService) records it so describeProvider() reports
      // the truth instead of a hardcoded "cpu".
      return reply({ id: req.id, vectors, dim, device });
    }

    reply({ id: req.id, error: `unknown op: ${req.op}` });
  } catch (e) {
    reply({ id: req.id, error: String(e?.message ?? e) });
  }
}

/** @param {object} obj */
function reply(obj) {
  realStdoutWrite(JSON.stringify(obj) + "\n");
}
