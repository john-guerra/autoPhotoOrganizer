/**
 * The ML child process.
 *
 * JSON-lines over stdio, one request at a time. Loads onnxruntime-node and
 * reports what it found (`health`), loads a vetted vision encoder on demand
 * and runs real inference (`configure`, `embed`).
 *
 * Nothing here may write to stdout except a reply line — stdout IS the
 * protocol. Diagnostics go to stderr. transformers.js can print progress bars
 * for in-flight downloads; that output is routed to stderr below (see
 * `transformers.env` / console redirection) precisely so it can never land on
 * stdout and corrupt the JSON-lines stream.
 */
import { modelById } from "../models.js";

let ort = null;
let loadError = null;
try {
  ort = (await import("onnxruntime-node")).default;
} catch (e) {
  loadError = e;
}

// transformers.js logs load/download progress via console.log, and console.log
// writes to stdout by default — which would corrupt the JSON-lines protocol
// with non-JSON lines. Stdout must carry ONLY reply() lines, so redirect every
// console method to stderr for the lifetime of this process. This runs before
// the dynamic `import("@huggingface/transformers")` in ensureModel() below, so
// there is no window where its module-load side effects could reach stdout.
for (const level of ["log", "info", "warn", "error", "debug"]) {
  console[level] = (...args) => process.stderr.write(args.join(" ") + "\n");
}

let transformers = null;
let loaded = null; // { id, model, processor, outputKey, dim }
let unloadTimer = null;
let config = { modelId: null, threads: 1 };

/** Models return their RAM after this long idle. A 114k backfill runs for
 *  hours; holding ~400 MB resident afterwards for nothing is not acceptable
 *  on a machine the user is also editing photos on. */
const UNLOAD_AFTER_MS = 120_000;

async function ensureModel(modelId) {
  if (loaded?.id === modelId) return loaded;
  const spec = modelById(modelId);

  if (!transformers) {
    transformers = await import("@huggingface/transformers");
    // Models are a rebuildable cache on the INTERNAL disk, like every other
    // derived artifact this app writes. NOT under cache/thumbs/ —
    // pruneOrphanedCache deletes anything there that isn't a known thumb key,
    // regardless of extension, and would eat the model on the next prune.
    transformers.env.cacheDir = process.env.AUTOGALLERY_MODELS_DIR;
    // Cap the intra-op pool. A separate PROCESS is not a separate CPU: left
    // uncapped, ORT grabs every core and starves the libvips pool that
    // server/index.js:19 reserves for thumbnails — measured at 15ms -> 90ms
    // with tiles abandoned mid-scroll (lib/interactive.js).
    transformers.env.backends.onnx.wasm.numThreads = config.threads;
  }

  const Loader = transformers[spec.loader];
  const model = await Loader.from_pretrained(spec.id, {
    dtype: spec.dtype,
    device: "cpu",
    session_options: { intraOpNumThreads: config.threads },
  });
  const processor = await transformers.AutoProcessor.from_pretrained(spec.id);
  loaded = {
    id: spec.id,
    model,
    processor,
    outputKey: spec.outputKey,
    dim: spec.dim,
  };
  return loaded;
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
      const { model, processor, outputKey } = await ensureModel(req.modelId);
      const { RawImage } = transformers;
      const images = await Promise.all(
        req.images.map((b64) =>
          RawImage.fromBlob(new Blob([Buffer.from(b64, "base64")]))
        )
      );
      const inputs = await processor(images);
      const out = await model(inputs);
      const tensor = out[outputKey];
      const [n, dim] = tensor.dims;
      // One tensor holds the whole batch; slice per image and send FLOATS.
      // Quantization happens in the parent so the worker stays a pure encoder.
      const vectors = [];
      for (let i = 0; i < n; i++) {
        vectors.push(Array.from(tensor.data.slice(i * dim, (i + 1) * dim)));
      }
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
  process.stdout.write(JSON.stringify(obj) + "\n");
}
