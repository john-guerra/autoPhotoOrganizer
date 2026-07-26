import { EventEmitter } from "node:events";
import { MLService } from "./MLService.js";

/**
 * Inference in a hidden Electron renderer, on the GPU.
 *
 * WHY A SECOND HOST. Prebuilt onnxruntime-node ships NO CoreML on any platform,
 * so on Apple Silicon the child process is CPU-only — DirectML (Windows) and
 * CUDA (Linux x64) are the only real EPs it has. Chromium's WebGPU is a
 * different runtime entirely and does reach the GPU. Since the app is already
 * Electron, that host is already paid for.
 *
 * It is still out-of-process, so #160's resilience argument holds unchanged: a
 * hard resource boundary, a kill switch, and crash isolation.
 *
 * `createWindow` is injected so the test suite never opens a real BrowserWindow
 * — and so server/ never imports electron. electron/main.js supplies the real
 * one.
 */
export class WebGpuMLService extends MLService {
  #createWindow;
  #win = null;
  #modelId = null;
  // Relays the renderer's transformers.js download/load progress frames, and
  // mirrors OnnxMLService's own "progress" event so server/api.js's
  // kickEmbedSweep relay (guarded with `typeof ml.on === "function"`) works
  // unmodified regardless of which host is active — without this, a ~94 MB
  // first-time model download looks like a frozen job whenever WebGPU is the
  // active host.
  #events = new EventEmitter();

  /** @param {{createWindow: () => Promise<{invoke: Function, destroy: Function, onProgress?: Function}>}} opts */
  constructor({ createWindow }) {
    super();
    this.#createWindow = createWindow;
  }

  async #window() {
    // Once, not per batch: creating a renderer and re-downloading model weights
    // for every 16 photos would be slower than the CPU path it replaces.
    if (this.#win) return this.#win;
    const win = await this.#createWindow();
    // `onProgress` is an EXTRA the window contract may offer, not part of the
    // {invoke, destroy} shape the given tests' fakeWindow implements — a
    // window that can't push progress (any test double, or a future host
    // with no out-of-process download step) simply yields no relay rather
    // than a crash, same degrade-quietly pattern server/api.js already uses
    // for `on`/`off`.
    win.onProgress?.((frame) => this.#events.emit("progress", frame));
    this.#win = win;
    return this.#win;
  }

  /** Does this machine actually have a WebGPU adapter? The answer decides
   *  which host runs, and it must be honest — the settings panel shows it. */
  async available() {
    try {
      const win = await this.#window();
      return Boolean(await win.invoke("ml:available"));
    } catch {
      return false;
    }
  }

  /** @param {{modelId: string, threads: number}} opts */
  async configure({ modelId, threads }) {
    this.#modelId = modelId;
    const win = await this.#window();
    return win.invoke("ml:configure", { modelId, threads });
  }

  /**
   * @param {Buffer[]} buffers JPEG bytes
   * @returns {Promise<Float32Array[]>}
   */
  async embedImages(buffers) {
    if (!this.#modelId) throw new Error("WebGpuMLService: configure() first");
    const win = await this.#window();
    try {
      const { vectors } = await win.invoke("ml:embed", {
        modelId: this.#modelId,
        // Uint8Array crosses the IPC boundary by structured clone. Bytes, not
        // paths: the renderer has no filesystem access, which also means
        // safeResolve gains no new surface to guard.
        images: buffers.map((b) => new Uint8Array(b)),
      });
      return vectors.map((v) => Float32Array.from(v));
    } catch (e) {
      // Drop the window so the next batch rebuilds it rather than talking to a
      // corpse — and name the stage, per the usability contract.
      this.#win = null;
      throw new Error(`WebGPU host failed: ${e?.message ?? e}`);
    }
  }

  /** Subscribe to host events. Currently just `"progress"` — download/load
   * frames relayed from the renderer's transformers.js `progress_callback`,
   * shaped like OnnxMLService's own progress frames
   * (`{type:"progress", modelId, status, file, progress, loaded, total}`) so
   * a single relay in server/api.js works no matter which host is active.
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

  /** Self-describing only — by construction this class is only ever the
   * `ml` electron/main.js injects into createApp AFTER its own startup probe
   * (`await webgpu.available()`) already succeeded, so there is no "fell
   * back to CPU" case for this class to report: that fallback happens one
   * level up, by injecting a DIFFERENT MLService (OnnxMLService, whose own
   * describeProvider() truthfully says "cpu") instead of this one. This still
   * re-checks live rather than trusting that cached startup answer forever,
   * so a WebGPU adapter lost mid-session (a GPU driver crash, e.g.) is
   * reflected on the very next poll instead of continuing to claim webgpu.
   * @returns {Promise<string>} */
  async describeProvider() {
    return (await this.available())
      ? "transformers.js (webgpu)"
      : "transformers.js (webgpu unavailable)";
  }

  stop() {
    this.#win?.destroy?.();
    this.#win = null;
  }
}
