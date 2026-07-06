const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("autogallery", {
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
});
