import { describe, it, expect, vi } from "vitest";
import { WebGpuMLService } from "./WebGpuMLService.js";

/** A fake hidden window: records what was sent, replies on demand.
 * `supportsProgress` opts into an `onProgress` subscription hook — a real
 * window (electron/main.js's createMlWindow) offers it to relay the
 * renderer's download/load frames, but plenty of test doubles (and the
 * window contract's minimum shape) don't, so WebGpuMLService must tolerate
 * its absence rather than require it. */
function fakeWindow({ webgpu = true, supportsProgress = false } = {}) {
  const handlers = new Map();
  const win = {
    sent: [],
    async invoke(channel, payload) {
      this.sent.push({ channel, payload });
      if (channel === "ml:available") return webgpu;
      const h = handlers.get(channel);
      return h ? h(payload) : { ok: true };
    },
    on(channel, fn) {
      handlers.set(channel, fn);
    },
    destroy: vi.fn(),
  };
  if (supportsProgress) {
    let subscriber = null;
    win.onProgress = (cb) => {
      subscriber = cb;
    };
    // Test-only helper, not part of the real window contract — lets a test
    // simulate the renderer pushing a frame.
    win.emitProgress = (frame) => subscriber?.(frame);
  }
  return win;
}

describe("WebGpuMLService", () => {
  it("reports unavailable when the renderer has no WebGPU adapter", async () => {
    const win = fakeWindow({ webgpu: false });
    const svc = new WebGpuMLService({ createWindow: async () => win });
    expect(await svc.available()).toBe(false);
  });

  it("reports available when the renderer has one", async () => {
    const svc = new WebGpuMLService({ createWindow: async () => fakeWindow() });
    expect(await svc.available()).toBe(true);
  });

  it("passes image BYTES, not paths — the renderer has no filesystem", async () => {
    const win = fakeWindow();
    win.on("ml:embed", () => ({ vectors: [[1, 2, 3]], dim: 3 }));
    const svc = new WebGpuMLService({ createWindow: async () => win });

    await svc.configure({
      modelId: "Xenova/clip-vit-base-patch32",
      threads: 4,
    });
    const out = await svc.embedImages([Buffer.from([9, 8, 7])]);

    const embed = win.sent.find((s) => s.channel === "ml:embed");
    expect(embed.payload.images[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(embed.payload.images[0])).toEqual([9, 8, 7]);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(out[0])).toEqual([1, 2, 3]);
  });

  it("refuses to embed before configure", async () => {
    const svc = new WebGpuMLService({ createWindow: async () => fakeWindow() });
    await expect(svc.embedImages([Buffer.from([1])])).rejects.toThrow(
      /configure/
    );
  });

  it("creates the window once, not per batch", async () => {
    const win = fakeWindow();
    win.on("ml:embed", () => ({ vectors: [[1]], dim: 1 }));
    const createWindow = vi.fn(async () => win);
    const svc = new WebGpuMLService({ createWindow });

    await svc.configure({
      modelId: "Xenova/clip-vit-base-patch32",
      threads: 1,
    });
    await svc.embedImages([Buffer.from([1])]);
    await svc.embedImages([Buffer.from([2])]);

    expect(createWindow).toHaveBeenCalledTimes(1);
  });

  it("surfaces a renderer crash as a named error, not a hang", async () => {
    const win = fakeWindow();
    win.on("ml:embed", () => {
      throw new Error("Render frame was disposed");
    });
    const svc = new WebGpuMLService({ createWindow: async () => win });
    await svc.configure({
      modelId: "Xenova/clip-vit-base-patch32",
      threads: 1,
    });

    await expect(svc.embedImages([Buffer.from([1])])).rejects.toThrow(
      /WebGPU host/
    );
  });

  // --- provider reporting (#161, obligation carried forward from Task 10) --

  it("describeProvider reports webgpu when the adapter is available", async () => {
    const svc = new WebGpuMLService({ createWindow: async () => fakeWindow() });
    expect(await svc.describeProvider()).toMatch(/webgpu/i);
    expect(await svc.describeProvider()).not.toMatch(/unavailable/i);
  });

  it("describeProvider never claims webgpu when the adapter probe fails", async () => {
    const svc = new WebGpuMLService({
      createWindow: async () => fakeWindow({ webgpu: false }),
    });
    const provider = await svc.describeProvider();
    // The literal string is this class's own business, but it must not lie
    // about running on the GPU it doesn't have — and it must not claim CPU
    // either (this class never runs CPU inference; that's a DIFFERENT
    // MLService instance's job, selected one level up in electron/main.js).
    expect(provider).not.toBe("transformers.js (webgpu)");
    expect(provider.toLowerCase()).not.toContain("cpu");
  });

  // --- progress relay (a missing `on`/`off` would make download progress
  // silently disappear whenever WebGPU is the active host — server/api.js's
  // kickEmbedSweep only relays it when `typeof ml.on === "function"") -------

  it("relays renderer download-progress frames via on/off", async () => {
    const win = fakeWindow({ supportsProgress: true });
    win.on("ml:embed", () => ({ vectors: [[1]], dim: 1 }));
    const svc = new WebGpuMLService({ createWindow: async () => win });
    await svc.configure({
      modelId: "Xenova/clip-vit-base-patch32",
      threads: 1,
    });

    const frames = [];
    const onProgress = (frame) => frames.push(frame);
    svc.on("progress", onProgress);

    const frame = {
      type: "progress",
      modelId: "Xenova/clip-vit-base-patch32",
      status: "progress",
      file: "onnx/vision_model_int8.onnx",
      progress: 42,
    };
    win.emitProgress(frame);

    expect(frames).toEqual([frame]);

    svc.off("progress", onProgress);
    win.emitProgress({ ...frame, progress: 99 });
    expect(frames).toHaveLength(1); // off() actually unsubscribes
  });

  it("never crashes when the injected window has no progress channel", async () => {
    // The given fakeWindow() (no supportsProgress) has no onProgress at all —
    // this is the exact shape the other 6 tests above use, so this test
    // proves on()/off() stay safe no-ops rather than throwing on a window
    // that can't push events.
    const svc = new WebGpuMLService({ createWindow: async () => fakeWindow() });
    expect(() => svc.on("progress", () => {})).not.toThrow();
    await expect(svc.available()).resolves.toBe(true);
  });
});
