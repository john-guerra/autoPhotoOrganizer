import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MLService } from "./MLService.js";

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
 * This slice ships supervision and one op (`health`). Model loading and real
 * inference arrive with #161, which has a cost to measure them against.
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
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    child.stdout.on("data", (chunk) => this.#onData(String(chunk)));
    child.on("exit", (code, signal) => {
      this.#child = null;
      // Fail every in-flight request rather than leaving a caller hanging: a
      // sweep waiting forever on a dead child is worse than a failed batch.
      const err = new Error(
        `ML worker exited (code ${code ?? "null"}, signal ${signal ?? "null"})`
      );
      for (const { reject } of this.#pending.values()) reject(err);
      this.#pending.clear();
    });
    this.#child = child;
    return child;
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

  /** Kill the child. Any later request respawns it. */
  stop() {
    if (!this.#child) return;
    this.#child.kill();
    this.#child = null;
  }
}
