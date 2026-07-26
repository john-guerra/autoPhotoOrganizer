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
let loaded = null; // { id, model, processor, outputKey, dim }
let unloadTimer = null;
let config = { modelId: null, threads: 1 };

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

async function ensureModel(modelId) {
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

    const Loader = transformers[spec.loader];
    const model = await Loader.from_pretrained(spec.id, {
      dtype: spec.dtype,
      device: "cpu",
      session_options: { intraOpNumThreads: config.threads },
      progress_callback,
    });
    const processor = await transformers.AutoProcessor.from_pretrained(
      spec.id,
      { progress_callback }
    );
    loaded = {
      id: spec.id,
      model,
      processor,
      outputKey: spec.outputKey,
      dim: spec.dim,
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
    loaded = null;
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
      config = { modelId: req.modelId, threads: Math.max(1, req.threads | 0) };
      // A thread-count change only takes effect on a fresh session.
      loaded = null;
      return reply({ id: req.id, ok: true });
    }

    if (req.op === "embed") {
      const { model, processor, outputKey, dim } = await ensureModel(
        req.modelId
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
