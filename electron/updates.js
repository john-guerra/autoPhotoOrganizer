import electronUpdater from "electron-updater";
import { app, ipcMain, Menu, BrowserWindow, shell } from "electron";

const { autoUpdater } = electronUpdater;

/**
 * Auto-update wiring for the packaged app (issue: in-app update flow).
 *
 * electron-updater reads release metadata (latest*.yml) from the GitHub
 * Releases configured in package.json `build.publish`, downloads the matching
 * installer in the background, and applies it on the next quit. We surface each
 * step to the renderer over the "update:status" channel so a small banner can
 * show available → downloading → ready, and expose check/install over IPC.
 *
 * NOTE: on macOS the OS refuses to apply an update to an UNSIGNED app
 * (Squirrel.Mac requires a valid Developer ID signature + notarization). Until
 * the mac build is signed, auto-update works on Windows/Linux only; on mac the
 * updater emits an error, which we forward but don't nag about on auto-checks.
 */

/** Send a status object to every open renderer. */
function broadcast(status) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("update:status", status);
  }
}

/** True while a user explicitly asked to check (so we can report "up to date"
 * / errors that we'd otherwise swallow on the silent startup check). */
let userInitiated = false;

function wireEvents() {
  autoUpdater.on("checking-for-update", () =>
    broadcast({ state: "checking", userInitiated })
  );
  autoUpdater.on("update-available", (info) =>
    broadcast({ state: "available", version: info?.version })
  );
  autoUpdater.on("update-not-available", () => {
    broadcast({ state: "none", userInitiated });
    userInitiated = false;
  });
  autoUpdater.on("download-progress", (p) =>
    broadcast({ state: "downloading", percent: Math.round(p?.percent ?? 0) })
  );
  autoUpdater.on("update-downloaded", (info) =>
    broadcast({ state: "downloaded", version: info?.version })
  );
  autoUpdater.on("error", (err) => {
    broadcast({
      state: "error",
      userInitiated,
      message: String(err?.message || err),
    });
    userInitiated = false;
  });
}

function wireIpc() {
  ipcMain.handle("update:check", async () => {
    userInitiated = true;
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (err) {
      userInitiated = false;
      return { ok: false, message: String(err?.message || err) };
    }
  });
  ipcMain.handle("update:install", () => {
    // Quit and apply the downloaded update. No-op if nothing is downloaded yet.
    autoUpdater.quitAndInstall();
  });
}

/** A standard app menu plus a "Check for Updates…" item (which triggers the
 * same flow as the in-app banner's manual check). Building a full template is
 * required because supplying any menu replaces Electron's default. */
function buildMenu() {
  const isMac = process.platform === "darwin";
  const checkForUpdates = {
    label: "Check for Updates…",
    click: () => {
      userInitiated = true;
      autoUpdater.checkForUpdates().catch((err) =>
        broadcast({
          state: "error",
          userInitiated: true,
          message: String(err?.message || err),
        })
      );
    },
  };
  /** @type {import("electron").MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              checkForUpdates,
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        ...(isMac ? [] : [checkForUpdates, { type: "separator" }]),
        {
          label: "AutoGallery on GitHub",
          click: () =>
            shell.openExternal(
              "https://github.com/john-guerra/autoPhotoOrganizer"
            ),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Initialise auto-updates. No-op in dev (the updater only works on a packaged
 * app with a valid app-update.yml). Safe to call once after app is ready.
 * @param {{isDev: boolean}} opts
 */
export function initAutoUpdates({ isDev }) {
  buildMenu();
  if (isDev) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  wireEvents();
  wireIpc();

  // Silent check on launch; failures here stay quiet (no user-facing nag).
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
}
