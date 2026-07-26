import { app, BrowserWindow, dialog, ipcMain, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, listenOnOpenPort } from "../server/index.js";
import { initAutoUpdates } from "./updates.js";
import { WebGpuMLService } from "../server/ml/WebGpuMLService.js";
import { modelById } from "../server/ml/models.js";

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

/**
 * A hidden renderer that runs transformers.js on WebGPU. Chromium reaches the
 * GPU that prebuilt onnxruntime-node cannot (no CoreML in any prebuilt, on
 * any platform) — see WebGpuMLService's class doc (server/ml/WebGpuMLService.js)
 * for the full rationale. `modelById` runs HERE, on the Node side, so the
 * hidden renderer — nodeIntegration off, no filesystem, no way to reach the
 * model registry — never gets to choose which model loads; it only ever sees
 * the already-resolved `spec` this function hands it.
 */
async function createMlWindow() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      // Same hardened shape as the main window's preload below: no Node
      // integration, isolated context, sandboxed preload — this renderer
      // only ever needs `window.mlHost` (mlHost.js) and the one-way progress
      // bridge (mlHostPreload.cjs), never real Node/Electron access.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "mlHostPreload.cjs"),
    },
  });
  await win.loadFile(path.join(__dirname, "mlHost.html"));

  // Download/load progress is a PUSH from the renderer (mlHostPreload.cjs's
  // ipcRenderer.send), not something executeJavaScript()'s request/response
  // shape below can carry — those calls only resolve once, when the whole
  // operation finishes. Scope the listener to this window's own webContents
  // (there is only ever one ML window, but defensively) and tear it down
  // with the window so a destroyed host can't leak a listener.
  let onProgress = null;
  const relay = (event, frame) => {
    if (event.sender === win.webContents) onProgress?.(frame);
  };
  ipcMain.on("ml:progress", relay);
  win.once("closed", () => ipcMain.off("ml:progress", relay));

  return {
    async invoke(channel, payload = {}) {
      const spec = payload.modelId ? modelById(payload.modelId) : null;
      if (channel === "ml:available")
        return win.webContents.executeJavaScript("window.mlHost.available()");
      if (channel === "ml:configure")
        return win.webContents.executeJavaScript(
          `window.mlHost.configure(${JSON.stringify({ spec })})`
        );
      if (channel === "ml:embed")
        return win.webContents.executeJavaScript(
          `window.mlHost.embed(${JSON.stringify({
            spec,
            images: payload.images.map((u8) => Array.from(u8)),
          })})`
        );
      throw new Error(`unknown ml channel: ${channel}`);
    },
    onProgress(cb) {
      onProgress = cb;
    },
    destroy: () => win.destroy(),
  };
}

/**
 * Decide which ML host `createApp` gets. Probes WebGPU once at startup — the
 * probe itself (open a hidden window, ask `navigator.gpu.requestAdapter()`)
 * downloads nothing and runs no inference, so it doesn't trip the "opt-in,
 * off by default" embedding gate (server/ml/settings.js `enabled`); that gate
 * still fully applies to every actual configure()/embedImages() call,
 * unchanged (server/api.js kickEmbedSweep). Honest fallback: if this machine
 * has no adapter, hand back `undefined` so registerApi lazily builds the CPU
 * ONNX host instead — a provider label that lies is worse than no label
 * (server/ml/MLService.js#describeProvider is what makes that label truthful
 * either way).
 * @returns {Promise<import("../server/ml/MLService.js").MLService|undefined>}
 */
async function selectMlHost() {
  try {
    const webgpu = new WebGpuMLService({ createWindow: createMlWindow });
    return (await webgpu.available()) ? webgpu : undefined;
  } catch (err) {
    // available() already swallows its own probe failures and resolves
    // false — this catch is for anything earlier (e.g. BrowserWindow
    // construction itself throwing). Startup must never crash the app over
    // a GPU probe; it just means every embed runs on CPU this session.
    console.error("WebGPU host probe failed, falling back to CPU:", err);
    return undefined;
  }
}

async function startEmbeddedServer() {
  const ml = await selectMlHost();
  const expressApp = createApp({ ml });
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

ipcMain.handle("pick-folder", async (event, startIn) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    // Open where the matching input already points (export dest, album dest, the
    // folder being added) instead of $HOME. A blank/whitespace value falls back
    // to the OS default; a path that no longer exists is handled by the OS.
    defaultPath:
      typeof startIn === "string" && startIn.trim()
        ? startIn.trim()
        : undefined,
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
