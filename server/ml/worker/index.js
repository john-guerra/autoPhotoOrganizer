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
// The EP candidate order — its own module because it encodes a MEASURED
// result and this file cannot be imported by a test (top-level stdout
// redirect, dynamic native import, stdin listener). See devices.js.
import { candidateDevices } from "./devices.js";

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
// means "auto-select" — see devices.js's candidateDevices() and
// loadWithBestDevice() below.
let config = { modelId: null, threads: 1, device: null };

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
 * relocated one layer down. The measured numbers (including this exact
 * failure) are in devices.js's own doc and in the spec's "Superseded
 * 2026-07-25" section — both of which SHIP, unlike the
 * .superpowers/ working notes an earlier version of this comment cited,
 * which are gitignored and vanish with the worktree.
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
 * `cpu` is ALWAYS somewhere in every platform's candidate list
 * (candidateDevices(), server/ml/worker/devices.js — first on darwin per its
 * measured order, last elsewhere; devices.test.js pins that) and never has anywhere further to fall back to itself, so if it
 * ALSO fails this throws for real rather than swallowing it.
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
/**
 * Import transformers.js once and point it at the app's model cache.
 *
 * Extracted from ensureModel when the text tower (#164) became a second
 * caller. It must stay ONE place: the `AUTOGALLERY_MODELS_DIR` guard below is
 * the only thing standing between a 94 MB download and transformers' own
 * default cache ('./.cache', relative to CWD — i.e. into the repo or the
 * user's home, invisible to cacheStats). A second copy of this block is a
 * second chance to omit that guard.
 */
async function ensureTransformers() {
  if (transformers) return transformers;
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
  return transformers;
}

/**
 * The TEXT tower (#164), loaded on first query and kept beside the vision
 * model rather than replacing it — a text search runs WHILE a backfill is
 * embedding images, and evicting the vision model to answer a search would
 * turn a 10 ms query into a multi-second reload of the thing the sweep is
 * using.
 *
 * Always CPU, deliberately, and not for lack of ambition: encoding a handful
 * of prompts measured 29 ms on CPU (2026-07-26), so the entire
 * candidate-device dance loadWithBestDevice performs for images — build a
 * session per EP, run a real forward pass, keep the winner — would cost more
 * than every text query this feature will ever run. The image path earns that
 * machinery across 16,797 photos; this one never would.
 */
let loadedText = null;
let textLoadingPromise = null;

async function ensureTextModel(modelId) {
  if (loadedText?.id === modelId) return loadedText;
  if (textLoadingPromise) return textLoadingPromise;

  textLoadingPromise = (async () => {
    const spec = modelById(modelId);
    if (!spec.text) {
      throw new Error(`model ${modelId} has no text encoder registered`);
    }
    const t = await ensureTransformers();
    const progress_callback = (p) => reply({ type: "progress", modelId, ...p });
    const tokenizer = await t.AutoTokenizer.from_pretrained(spec.id, {
      progress_callback,
    });
    const model = await t[spec.text.loader].from_pretrained(spec.id, {
      dtype: spec.dtype,
      device: "cpu",
      progress_callback,
    });
    loadedText = {
      id: modelId,
      model,
      tokenizer,
      outputKey: spec.text.outputKey,
      tokenize: spec.text.tokenize,
      dim: spec.dim,
    };
    return loadedText;
  })();

  try {
    return await textLoadingPromise;
  } finally {
    textLoadingPromise = null;
  }
}

async function ensureModel(modelId, imagesB64) {
  if (loaded?.id === modelId) return loaded;
  if (loadingPromise && loadingModelId === modelId) return loadingPromise;

  loadingModelId = modelId;
  loadingPromise = (async () => {
    const spec = modelById(modelId);

    await ensureTransformers();

    // Unsolicited progress frames — no `id`, so the parent's #onData routes
    // them to its "progress" event instead of a pending-request waiter.
    // kickEmbedSweep (server/api.js) subscribes and relays them into the
    // embed job's phase ("downloading onnx/model.onnx 37%"), filtered to
    // real download chunks and throttled to one update per whole percent —
    // so a 100 MB first fetch is visible instead of a job frozen at 0 of 0.
    const progress_callback = (p) => reply({ type: "progress", modelId, ...p });

    // Built once, before the candidate loop: the processor (resize/normalize/
    // tensor-ify) is device-independent, and loadWithBestDevice needs it
    // to run each candidate's real smoke-test forward pass.
    const processor = await transformers.AutoProcessor.from_pretrained(
      spec.id,
      { progress_callback }
    );

    // `config.device` is set only by the ML_INTEGRATION benchmark forcing a
    // single EP with no fallthrough (see devices.js's own doc); the
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

    if (req.op === "embedText") {
      const { model, tokenizer, outputKey, tokenize, dim } =
        await ensureTextModel(req.modelId);
      // `tokenize` comes from the registry, per model. SigLIP needs every
      // caption padded to a fixed 64 tokens because its export has that
      // length baked in, and getting it wrong returns a DIFFERENT vector
      // rather than an error — see models.js.
      const inputs = tokenizer(req.texts, tokenize);
      const out = await model(inputs);
      // Same validator the image path uses, for the same reason: a wrong
      // outputKey (say a bare CLIPTextModel's pooler_output where the joint
      // space needs text_embeds) yields plausible numbers of the right width
      // and a meaningless cosine. Checking batch size too catches
      // mis-attribution a width check alone would miss.
      const vectors = extractVectors(out[outputKey], {
        modelId: req.modelId,
        outputKey,
        dim,
        batchSize: req.texts.length,
      });
      return reply({ id: req.id, vectors, dim });
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
