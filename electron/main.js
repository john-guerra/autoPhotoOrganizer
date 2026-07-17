import { app, BrowserWindow, dialog, ipcMain, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, listenOnOpenPort } from "../server/index.js";
import { initAutoUpdates } from "./updates.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ICON_PATH = path.join(__dirname, "..", "build", "icon.png");

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
    // Taskbar/window icon for Windows & Linux dev runs. On macOS this is
    // ignored (the dock icon comes from the app bundle) — see the
    // app.dock.setIcon call below for the macOS dev icon.
    icon: ICON_PATH,
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
    // `createDirectory` surfaces the "New Folder" button so the user can make
    // the destination folder right in the picker — the app no longer asks for a
    // separate folder name; the chosen folder IS the export target.
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

app.whenReady().then(async () => {
  try {
    // Who made this, in the place the OS looks for it: ⌘-About on macOS reads
    // these fields, so the app names itself and its author rather than showing
    // a bare "Electron".
    app.setAboutPanelOptions({
      applicationName: "AutoGallery",
      applicationVersion: app.getVersion(),
      credits: "John Alexis Guerra Gómez — https://johnguerra.co",
      copyright: `© ${new Date().getFullYear()} John Alexis Guerra Gómez · https://johnguerra.co`,
      website: "https://johnguerra.co",
      iconPath: ICON_PATH,
    });

    // In dev the app runs from the generic Electron.app bundle, so macOS shows
    // the default Electron dock icon. Set our icon explicitly. (The packaged
    // app gets its icon from electron-builder, so this dev-only path is enough.)
    if (process.platform === "darwin" && app.dock) {
      const img = nativeImage.createFromPath(ICON_PATH);
      if (!img.isEmpty()) app.dock.setIcon(img);
    }
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
