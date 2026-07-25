import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MLService } from "./MLService.js";
import { modelsDir } from "../lib/cachePaths.js";

const HERE = dirname(fileURLToPath(import.meta.url));

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

  constructor({ spawn = nodeSpawn, workerPath } = {}) {
    super();
    this.#spawn = spawn;
    this.#workerPath = workerPath ?? join(HERE, "worker", "index.js");
  }

  #ensureChild() {
    if (this.#child) return this.#child;
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
      const waiter = this.#pending.get(msg.id);
      if (!waiter) continue;
      this.#pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error));
      else waiter.resolve(msg);
    }
  }

  /** One request, one reply. @param {object} req @returns {Promise<any>} */
  #request(req) {
    const child = this.#ensureChild();
    const id = `r${++this.#seq}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
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
   * drops any loaded model when this is called.
   * @param {{modelId: string, threads: number}} opts */
  async configure({ modelId, threads }) {
    this.#modelId = modelId;
    return this.#request({ op: "configure", modelId, threads });
  }

  /**
   * @param {Buffer[]} buffers JPEG bytes, one per image
   * @returns {Promise<Float32Array[]>} raw (un-normalized) model vectors
   */
  async embedImages(buffers) {
    if (!this.#modelId) throw new Error("OnnxMLService: configure() first");
    const { vectors } = await this.#request({
      op: "embed",
      modelId: this.#modelId,
      images: buffers.map((b) => b.toString("base64")),
    });
    return vectors.map((v) => Float32Array.from(v));
  }

  /** Kill the child. Any later request respawns it. */
  stop() {
    if (!this.#child) return;
    this.#child.kill();
    this.#child = null;
  }
}
