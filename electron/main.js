import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  shell,
} from "electron";
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

/**
 * Hand an http(s) URL to the OS browser, and TELL THE USER when that fails.
 *
 * `openExternal` rejects on a real failure (no handler registered for the
 * scheme, a locked-down profile). Swallowing that rejection would leave the
 * user clicking a link that does nothing — the dead control this whole path
 * exists to prevent — so the failure gets a dialog with the URL in it, which
 * they can at least copy. Non-http(s) is dropped silently and deliberately:
 * `javascript:`, `file:`, `data:` and custom schemes must never reach the OS.
 * @param {string} url Chromium's normalised absolute URL
 */
function openExternally(url) {
  if (!/^https?:\/\//i.test(url)) return;
  shell.openExternal(url).catch((err) => {
    dialog.showErrorBox(
      "Couldn't open that link",
      `AutoGallery couldn't hand this link to your browser:\n\n${url}\n\n${err?.message ?? err}`
    );
  });
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

  // An external link (the ML settings panel's model card, #161) must open in
  // the user's own browser. Electron denies window.open by default, so without
  // this the anchor is a DEAD CONTROL in the packaged app while working fine
  // under `npm run dev` — the exact class of bug no unit test sees. Only
  // http(s) is handed to the OS.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });

  // The handler above only covers window.open / target="_blank". An ordinary
  // same-tab link (or an anchor that ever loses its target) would instead
  // NAVIGATE this window to huggingface.co — no address bar, no back button,
  // no way home. Anything that isn't our own origin leaves for the OS browser.
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(DEV_URL) || url.startsWith(`http://${HOST}:`)) return;
    event.preventDefault();
    openExternally(url);
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
  // macOS convention is that closing the last window does NOT quit — the app
  // stays in the dock and `activate` reopens it. Correct for a PACKAGED app,
  // and wrong for `npm run electron:dev`: there is no dock icon to click, the
  // terminal stays occupied by concurrently, and the only way out is Ctrl-C.
  //
  // So dev quits on close and packaged keeps the convention. The window IS the
  // app when you launched it from a terminal.
  if (isDev || process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
