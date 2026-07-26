import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { MLService } from "./MLService.js";
import { modelsDir } from "../lib/cachePaths.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Per-op request timeouts. `embed` is deliberately excluded — it can mean
 * either "run inference on an already-resident model" (fast) or "download
 * and load a ~100 MB model first" (slow, and only on the first embed after a
 * configure() or a respawn), so embedImages() below picks between
 * EMBED_WARM_TIMEOUT_MS and EMBED_COLD_TIMEOUT_MS itself rather than using a
 * single value here. */
const REQUEST_TIMEOUT_MS = {
  health: 10_000,
  configure: 15_000,
};
const EMBED_WARM_TIMEOUT_MS = 30_000;
const EMBED_COLD_TIMEOUT_MS = 10 * 60_000; // cold cache: download + load

/**
 * Spawns and supervises the ML child process. Does NO inference itself.
 *
 * Out of process is not optional. In-process inference would contend for the
 * same 16-slot libuv threadpool server/index.js:19 reserves for libvips — the
 * failure already measured in lib/interactive.js (thumbnails 15ms -> 90ms under
 * a sweep, tiles abandoned mid-scroll) — and a native-addon segfault would take
 * the whole app down. The child IS the resilience requirement: hard resource
 * boundary, kill switch, crash isolation.
 *
 * Supervision plus three ops: `health`, `configure` (select a model, cap
 * threads), and `embed` (real inference — see server/ml/models.js for the
 * registry and server/ml/worker/index.js for the loader).
 *
 * Emits `"progress"` for unsolicited `{type: "progress", ...}` frames the
 * worker sends while a model is downloading/loading (wired from
 * transformers.js's `progress_callback`). No UI consumes this yet; Task 10's
 * jobs panel is the intended subscriber — `service.on("progress", (msg) =>
 * ...)`. `msg` is whatever transformers.js's callback payload was
 * (`{status, name, file, progress, loaded, total}` typically), plus
 * `modelId` and `type: "progress"`.
 *
 * Also emits `"unloaded"` for `{type: "unloaded", modelId}` — the worker's
 * own idle timer (UNLOAD_AFTER_MS in worker/index.js) dropped its resident
 * model. Handled internally to reset `#modelWarm` (see embedImages below);
 * also emitted for any interested subscriber.
 *
 * `spawn` is injectable so the default test suite never forks a real process.
 */
export class OnnxMLService extends MLService {
  #spawn;
  #workerPath;
  #child = null;
  #pending = new Map();
  #seq = 0;
  #buf = "";
  #modelId = null;
  #threads = null;
  // True once an embed has succeeded against the currently-configured model
  // in the currently-running child. Reset to false on configure() (the
  // worker drops its loaded model then), whenever a fresh child is spawned
  // (a respawned worker starts with nothing loaded), and when the worker
  // reports an idle-timer "unloaded" frame — all mean the NEXT embed may
  // have to download+load a model, so it gets the generous cold timeout
  // instead of the warm one.
  #modelWarm = false;
  // Bumped every time something above sets #modelWarm = false. The worker's
  // idle timer is independent of in-flight embed handling and model(inputs)
  // is genuinely async, so an "unloaded" frame (or a configure()/respawn)
  // can land WHILE an embed is awaiting its reply. That embed still resolves
  // correctly (its local model/processor refs were already captured
  // worker-side), but embedImages() must not then stamp #modelWarm back to
  // true and undo the invalidation that arrived mid-request — see the
  // stale-generation check in embedImages().
  #modelGeneration = 0;
  #events = new EventEmitter();

  constructor({ spawn = nodeSpawn, workerPath } = {}) {
    super();
    this.#spawn = spawn;
    this.#workerPath = workerPath ?? join(HERE, "worker", "index.js");
  }

  #ensureChild() {
    if (this.#child) return this.#child;
    this.#modelWarm = false; // fresh process, nothing loaded yet
    this.#modelGeneration++;
    // In a packaged build the child runs on ELECTRON's ABI, not Node's —
    // ELECTRON_RUN_AS_NODE makes the Electron binary behave as node. #67 is the
    // cautionary tale: a Node-ABI native addon in an Electron build crashes on
    // launch, and electron-builder's own rebuild was a silent no-op.
    const child = this.#spawn(process.execPath, [this.#workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        AUTOGALLERY_MODELS_DIR:
          process.env.AUTOGALLERY_MODELS_DIR ?? modelsDir(),
      },
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#onData(chunk));
    child.on("exit", (code, signal) => {
      this.#killChild(
        child,
        new Error(
          `ML worker exited (code ${code ?? "null"}, signal ${signal ?? "null"})`
        )
      );
    });
    // `exit` is asynchronous — a request arriving in the tick after a crash
    // can still write into a destroyed pipe. That write raises an `error`
    // event on the child (and/or child.stdin) which, with no listener
    // attached, is an UNHANDLED 'error' event: Node throws it and takes the
    // whole server process down. A child that emits both `error` and `exit`
    // must not double-settle the pending promises or throw on the second
    // cleanup — #killChild below is idempotent, keyed on identity so the
    // second event (whichever arrives second) is a no-op.
    child.on("error", (err) => this.#killChild(child, err));
    child.stdin.on("error", (err) => this.#killChild(child, err));
    this.#child = child;

    // The worker's `configure` (model choice + thread cap) lives only in
    // that process's memory. A crash-and-respawn otherwise silently drops it
    // back to threads:1 with no signal to the user — concretely, a user who
    // picked 4 threads has the worker OOM mid-backfill (precisely the case
    // this out-of-process architecture exists for), it respawns, and the
    // remaining tens of thousands of photos encode ~4x slower while the app
    // still reports "4 threads" and tells the user nothing changed. Replay
    // the last known-good configuration to the fresh child before any other
    // request reaches it. This re-enters #ensureChild via #request, but
    // `this.#child` is already assigned above so that nested call returns
    // immediately without spawning a second child.
    if (this.#modelId !== null) {
      this.#request({
        op: "configure",
        modelId: this.#modelId,
        threads: this.#threads,
      }).catch(() => {
        // The replay's own failure surfaces to nobody directly — but if the
        // child is that broken, the request that triggered this respawn
        // will fail too (same dead child), and that failure IS observed by
        // its caller. Swallow here only to avoid an unhandled rejection.
      });
    }

    return child;
  }

  /** Settle every in-flight request and drop the dead child so the next
   * request respawns. Safe to call twice for the same child (e.g. it emits
   * both `error` and `exit`) — the second call is a no-op because `#child`
   * no longer matches. */
  #killChild(child, err) {
    if (this.#child !== child) return; // already handled (error THEN exit, or vice versa)
    this.#child = null;
    for (const { reject } of this.#pending.values()) reject(err);
    this.#pending.clear();
  }

  #onData(text) {
    this.#buf += text;
    let nl;
    while ((nl = this.#buf.indexOf("\n")) !== -1) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // A garbage line is the worker's problem, not grounds to kill the app.
        continue;
      }
      if (msg.type === "progress") {
        // Unsolicited — no request `id` to match against #pending. See the
        // class doc for who's meant to subscribe.
        this.#events.emit("progress", msg);
        continue;
      }
      if (msg.type === "unloaded") {
        // The worker's OWN idle timer (independent of this class's request
        // timeouts) dropped the model. Without this, #modelWarm would stay
        // true forever and the next embedImages() would get the 30s warm
        // budget while the worker actually has to reload from disk — a
        // >2-minute gap between embed batches is the NORMAL case here
        // (sweeps are whenIdle-gated), not a rare one.
        this.#modelWarm = false;
        this.#modelGeneration++;
        this.#events.emit("unloaded", msg);
        continue;
      }
      const waiter = this.#pending.get(msg.id);
      if (!waiter) continue;
      this.#pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error));
      else waiter.resolve(msg);
    }
  }

  /** Subscribe to worker events: `"progress"` and `"unloaded"`.
   * @param {string} event @param {(msg: object) => void} listener */
  on(event, listener) {
    this.#events.on(event, listener);
    return this;
  }

  /** @param {string} event @param {(msg: object) => void} listener */
  off(event, listener) {
    this.#events.off(event, listener);
    return this;
  }

  /** One request, one reply, bounded by a timeout so a stalled worker (a
   * hung download, a wedged child) fails loudly instead of leaving the
   * caller pending forever — the CLAUDE.md "never fail silently" rule
   * applies to this internal boundary as much as to anything user-facing.
   * @param {object} req
   * @param {number} [timeoutMs] defaults per-op via REQUEST_TIMEOUT_MS
   * @returns {Promise<any>} */
  #request(
    req,
    timeoutMs = REQUEST_TIMEOUT_MS[req.op] ?? EMBED_WARM_TIMEOUT_MS
  ) {
    const child = this.#ensureChild();
    const id = `r${++this.#seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(
            `ML worker: "${req.op}" timed out after ${timeoutMs}ms with no reply`
          )
        );
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      child.stdin.write(JSON.stringify({ ...req, id }) + "\n");
    });
  }

  /** Is the runtime there, and what can it run on?
   * @returns {Promise<{ok: boolean, ort: string, providers: string[], pid: number}>} */
  health() {
    return this.#request({ op: "health" });
  }

  /** Select which model embedImages() uses and cap the worker's thread pool.
   * A thread-count change only takes effect on a fresh session, so the worker
   * drops any loaded model when this is called — the next embedImages() call
   * pays a cold load again.
   * @param {{modelId: string, threads: number}} opts */
  async configure({ modelId, threads }) {
    await this.#request({ op: "configure", modelId, threads });
    // Recorded only after the worker confirms — if the child died between
    // spawn and reply, #modelId must stay whatever it was (null, on the
    // first-ever call) so the "configure() first" guard in embedImages()
    // still fires instead of silently proceeding against an unconfigured
    // worker.
    this.#modelId = modelId;
    this.#threads = threads;
    this.#modelWarm = false;
    this.#modelGeneration++;
  }

  /**
   * @param {Buffer[]} buffers JPEG bytes, one per image
   * @returns {Promise<Float32Array[]>} raw (un-normalized) model vectors
   */
  async embedImages(buffers) {
    if (!this.#modelId) throw new Error("OnnxMLService: configure() first");
    const timeoutMs = this.#modelWarm
      ? EMBED_WARM_TIMEOUT_MS
      : EMBED_COLD_TIMEOUT_MS;
    const generation = this.#modelGeneration;
    const { vectors } = await this.#request(
      {
        op: "embed",
        modelId: this.#modelId,
        images: buffers.map((b) => b.toString("base64")),
      },
      timeoutMs
    );
    // Only mark warm if nothing invalidated it WHILE this request was in
    // flight (an idle-unload frame, a concurrent configure(), a respawn).
    // This embed's own result is still valid and returned either way — its
    // local model/processor refs were captured before any of that could
    // happen — but stamping #modelWarm = true unconditionally here would
    // silently undo a real invalidation that raced it, handing the NEXT
    // embed a 30s warm budget for what is actually a cold reload.
    if (this.#modelGeneration === generation) this.#modelWarm = true;
    return vectors.map((v) => Float32Array.from(v));
  }

  /** Always CPU: worker/index.js hardcodes `device: "cpu"` when it loads a
   * model — no CoreML/DirectML/CUDA execution provider is wired up for this
   * host (see WebGpuMLService's class doc for why prebuilt onnxruntime-node
   * can't reach a GPU on Apple Silicon at all). A static fact about this
   * class's own implementation, not a runtime probe — answering it must
   * never spawn the child just to satisfy a settings-panel GET (see the
   * comment on ML_PROVIDER_FALLBACK in server/api.js).
   * @returns {Promise<string>} */
  async describeProvider() {
    return "onnxruntime-node (cpu)";
  }

  /** Kill the child. Any later request respawns it. */
  stop() {
    if (!this.#child) return;
    this.#child.kill();
    this.#child = null;
  }
}
