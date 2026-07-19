"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("autogallery", {
  // `startIn` seeds the dialog's initial directory (the path already in the
  // matching input) so the picker opens there instead of dumping the user at
  // $HOME every time. Optional — omitted callers get the OS default.
  pickFolder: (startIn) => ipcRenderer.invoke("pick-folder", startIn),
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
