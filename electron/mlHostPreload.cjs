"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/**
 * The ML host window (electron/mlHost.html) runs with nodeIntegration off, so
 * it has no path back to the main process except what this bridge exposes.
 * It needs exactly one thing: a way to PUSH transformers.js's download/load
 * progress frames out during a long `from_pretrained()` call, so
 * WebGpuMLService (server/ml/WebGpuMLService.js) can relay them into the
 * JobsPanel the same way OnnxMLService's worker does (Task 10) — without
 * this, a ~94 MB first-time model download looks like a frozen job whenever
 * WebGPU is the active host. `invoke`/`embed`/`configure` do NOT need a
 * bridge entry: those are driven from the main-process side via
 * `webContents.executeJavaScript`, not from the renderer calling out.
 */
contextBridge.exposeInMainWorld("mlBridge", {
  reportProgress: (frame) => ipcRenderer.send("ml:progress", frame),
});
