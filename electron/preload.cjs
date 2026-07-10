"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("autogallery", {
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  // Auto-update bridge. `onStatus` returns an unsubscribe fn; check/install
  // trigger a manual check and apply-on-quit respectively. Absent in the web
  // build (no window.autogallery), so the renderer must feature-detect.
  updates: {
    onStatus: (cb) => {
      const listener = (_event, status) => cb(status);
      ipcRenderer.on("update:status", listener);
      return () => ipcRenderer.removeListener("update:status", listener);
    },
    check: () => ipcRenderer.invoke("update:check"),
    install: () => ipcRenderer.invoke("update:install"),
  },
});
