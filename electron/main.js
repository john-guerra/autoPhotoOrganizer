import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, listenOnOpenPort } from "../server/index.js";
import { initAutoUpdates } from "./updates.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// The packaged app prefers a port distinct from the dev server's 4321 so a
// running install never squats the port `npm run dev` needs (issue #65). It
// points the renderer at whatever port it actually binds, so the exact number
// is arbitrary; it still falls back to a free port if this one is taken too.
const PORT = process.env.PORT ? Number(process.env.PORT) : 4331;
const HOST = "127.0.0.1";
const DEV_URL = "http://localhost:5173";
const isDev = process.env.ELECTRON_DEV === "1";

async function startEmbeddedServer() {
  const expressApp = createApp();
  // Prefer PORT, but fall back to any free port if it's taken (a dev server, a
  // stale process, a second instance) so the app still launches (issue #64).
  const { port } = await listenOnOpenPort(expressApp, {
    preferredPort: PORT,
    host: HOST,
  });
  return port;
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
    const port = await startEmbeddedServer();
    await win.loadURL(`http://${HOST}:${port}`);
  }
}

ipcMain.handle("pick-folder", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

app.whenReady().then(async () => {
  try {
    await createWindow();
    initAutoUpdates({ isDev });
  } catch (err) {
    dialog.showErrorBox("AutoGallery failed to start", String(err));
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
