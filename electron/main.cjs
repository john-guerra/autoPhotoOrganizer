"use strict";

const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const PORT = process.env.PORT ? Number(process.env.PORT) : 4321;
const HOST = "127.0.0.1";
const DEV_URL = "http://localhost:5173";
const isDev = process.env.ELECTRON_DEV === "1";

// server/index.js is an ES module; this file is CommonJS (see the plan's
// Global Constraints), so it must be loaded via dynamic import().
async function startEmbeddedServer() {
  const serverIndexUrl = pathToFileURL(
    path.join(__dirname, "..", "server", "index.js")
  ).href;
  const { createApp } = await import(serverIndexUrl);
  const expressApp = createApp();
  await new Promise((resolve) => {
    expressApp.listen(PORT, HOST, resolve);
  });
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  if (isDev) {
    await win.loadURL(DEV_URL);
  } else {
    await startEmbeddedServer();
    await win.loadURL(`http://${HOST}:${PORT}`);
  }
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
