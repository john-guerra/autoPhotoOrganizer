# Electron Packaging + Native Folder Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package AutoGallery as a distributable Electron desktop app (Mac/Windows/Linux) and replace the raw path text input with a native OS folder picker (closes GitHub issue #7), building on a persisted "library" of previously-scanned folders with removable-drive offline detection.

**Architecture:** Electron's main process wraps the existing Express server (`server/index.js`) and Svelte/Vite frontend (`ui/`) completely unchanged — no rewrite. A thin `electron/` layer adds the desktop shell, a `contextBridge`-exposed `pickFolder()` for the native dialog, and `electron-builder`/`electron-updater` for packaging and auto-update.

**Tech Stack:** Node.js/Express (existing), Svelte/Vite (existing), Electron, electron-builder, electron-updater, GitHub Actions.

**Design doc:** `docs/superpowers/specs/2026-07-06-electron-packaging-design.md`
**GitHub issue:** [#32](https://github.com/john-guerra/autoPhotoOrganizer/issues/32) (closes #7), milestone v0.2

## Global Constraints

- Server stays loopback-only (`127.0.0.1`) — never change this bind, even when embedded in Electron.
- `electron/main.js` is an ES module (`import`/`export`), consistent with the repo root `package.json`'s `"type": "module"` and with `server/`/`ui/`. `electron/preload.cjs` is the one confirmed exception: Electron's sandboxed preload loader (`sandbox: true`, required below) cannot load ESM — verified directly in this environment (Electron 33.4.11 throws `SyntaxError: Cannot use import statement outside a module` for an ESM preload script) — so it stays CommonJS (`require`/`module.exports`, `.cjs` extension). This is the standard pattern other Electron+ESM projects use, not a stopgap. Verify after any change to either file that `npm run electron:dev` still boots and `window.autogallery` is still exposed in the renderer.
- Every `BrowserWindow`'s `webPreferences` MUST set `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Never repeat `legacy/2024-electron-standalone/main.js`'s `nodeIntegration: true` / no-isolation pattern (flagged as insecure in `CLAUDE.md`). No `remote` module.
- The only renderer-exposed native API surface is `window.autogallery.pickFolder()` via `contextBridge`. Do not add other IPC surface without updating the design doc first.
- `server/` and `ui/` source are modified only where a task explicitly says so — this is an additive packaging layer, not a refactor.
- John verifies visual/interactive behavior himself. Every "manual verification" step below stops at confirming the process starts cleanly (expected log line, no stack trace) — do not attempt automated GUI driving, screenshotting, or Playwright/computer-use against the Electron window.
- Test runner: `npx vitest run <file>` for a single file, `npm test` for the full suite. Follow existing conventions in `server/api.test.js` (ephemeral port, `AUTOGALLERY_HOME` env override, `_resetForTest()` pattern) for any new server tests.

---

## File structure

New files:
- `electron/main.js` — main process: creates the `BrowserWindow`, starts the embedded Express server in production, handles the `pick-folder` IPC call.
- `electron/preload.cjs` — `contextBridge` surface exposed to the renderer (CommonJS — see Global Constraints).
- `.github/workflows/release.yml` — CI matrix build (Mac/Windows/Linux) + publish on version tags.
- `server/library.js` — persisted "recently scanned folders" store (mirrors `server/coverChoices.js`).

Modified files:
- `server/lib/cachePaths.js` — add `libraryFile()`.
- `server/api.js` — auto-record scans into the library; add `GET /api/library`.
- `server/api.test.js` — cover the above.
- `ui/src/lib/api.js` — add `fetchLibrary()`.
- `ui/src/App.svelte` — library dropdown + "Choose Folder…" button.
- `package.json` — Electron/electron-builder/electron-updater deps, `main` field, `build` config, new scripts.

---

### Task 1: Library persistence + `/api/library` endpoint + auto-record on scan

**Files:**
- Modify: `server/lib/cachePaths.js`
- Create: `server/library.js`
- Modify: `server/api.js`
- Modify: `server/api.test.js`

**Interfaces:**
- Produces: `libraryFile(): string` (in `server/lib/cachePaths.js`, same shape as existing `coverChoicesFile()`).
- Produces: `recordScan(absPath: string, scannedAt?: number): void`, `getAllLibraryEntries(): Array<{path:string, name:string, lastScannedAt:number}>`, `flushNow(): void`, `_resetForTest(): void` (all in `server/library.js`).
- Produces: `GET /api/library` → `Array<{path:string, name:string, lastScannedAt:number, mounted:boolean}>`.

- [ ] **Step 1: Write the failing tests**

Add to `server/api.test.js`. First, add these imports near the top (alongside the existing ones):

```js
import { basename } from "node:path";
import { recordScan, _resetForTest as _resetLibraryForTest } from "./library.js";
```

In `beforeAll`, alongside the other `_resetForTest()` calls, add:

```js
  _resetLibraryForTest();
```

Then add a new `describe` block (anywhere after the existing `describe("POST /api/scan", ...)` block):

```js
describe("GET /api/library", () => {
  it("records the scanned folder and reports it as mounted", async () => {
    await fetch(`${srv.base}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: photosDir }),
    });
    const res = await fetch(`${srv.base}/api/library`);
    expect(res.status).toBe(200);
    const entries = await res.json();
    const entry = entries.find((e) => e.path === photosDir);
    expect(entry).toBeDefined();
    expect(entry.mounted).toBe(true);
    expect(entry.name).toBe(basename(photosDir));
  });

  it("reports a since-removed folder as not mounted", async () => {
    const goneDir = join(photosDir, "does-not-exist-anymore");
    recordScan(goneDir);
    const res = await fetch(`${srv.base}/api/library`);
    const entries = await res.json();
    const entry = entries.find((e) => e.path === goneDir);
    expect(entry).toBeDefined();
    expect(entry.mounted).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/api.test.js`
Expected: FAIL — `Cannot find module './library.js'` (or similar), since the module doesn't exist yet.

- [ ] **Step 3: Add `libraryFile()` to `server/lib/cachePaths.js`**

Add this function after the existing `coverChoicesFile()` function:

```js
/** @returns {string} Absolute path to the library (recent-folders) JSON file. */
export function libraryFile() {
  mkdirSync(cacheRoot(), { recursive: true });
  return join(cacheRoot(), "library.json");
}
```

- [ ] **Step 4: Create `server/library.js`**

```js
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { libraryFile } from "./lib/cachePaths.js";

/**
 * Library of previously-scanned folders, keyed by ABSOLUTE path so
 * re-scanning the same folder refreshes its entry instead of duplicating
 * it. Stored as a single JSON object at ~/.autogallery/library.json — same
 * atomic-write / debounced-flush pattern as coverChoices.js and ratings.js.
 */

/** @type {Record<string, {name:string, lastScannedAt:number}> | null} */
let cache = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let flushTimer = null;
const DEBOUNCE_MS = 150;

function load() {
  if (cache) return cache;
  const file = libraryFile();
  if (existsSync(file)) {
    try {
      cache = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      cache = {};
    }
  } else {
    cache = {};
  }
  return cache;
}

function flush() {
  flushTimer = null;
  const file = libraryFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache ?? {}, null, 2));
  renameSync(tmp, file);
}

function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, DEBOUNCE_MS);
}

/**
 * Record (or refresh) a scanned folder in the library.
 * @param {string} absPath
 * @param {number} [scannedAt] defaults to Date.now(); overridable for tests
 */
export function recordScan(absPath, scannedAt = Date.now()) {
  const map = load();
  map[absPath] = { name: basename(absPath), lastScannedAt: scannedAt };
  scheduleFlush();
}

/**
 * @returns {Array<{path:string, name:string, lastScannedAt:number}>} all
 * library entries, most-recently-scanned first.
 */
export function getAllLibraryEntries() {
  const map = load();
  return Object.entries(map)
    .map(([path, v]) => ({
      path,
      name: v.name,
      lastScannedAt: v.lastScannedAt,
    }))
    .sort((a, b) => b.lastScannedAt - a.lastScannedAt);
}

/** Force a synchronous flush of any pending debounced write. */
export function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flush();
  }
}

/** Reset in-memory cache (tests only). */
export function _resetForTest() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  cache = null;
}
```

- [ ] **Step 5: Wire it into `server/api.js`**

Add to the import block at the top:

```js
import { getAllLibraryEntries, recordScan } from "./library.js";
```

In the `POST /api/scan` handler, right after the existing directory validation (after the `if (!st.isDirectory())` block, i.e. right before `const t0 = performance.now();`), add:

```js
    recordScan(dir);
```

So that section reads:

```js
    if (!st.isDirectory()) {
      return res.status(400).json({ error: `not a directory: ${dir}` });
    }
    recordScan(dir);

    const t0 = performance.now();
```

Add a new route after the existing `/api/cover` route (right before the closing `}` of `registerApi`):

```js
  // --- Library (recently-scanned folders) ----------------------------------
  app.get("/api/library", (_req, res) => {
    const entries = getAllLibraryEntries().map((e) => ({
      ...e,
      mounted: existsSync(e.path),
    }));
    res.json(entries);
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run server/api.test.js`
Expected: PASS (all tests, including the two new ones).

- [ ] **Step 7: Commit**

```bash
git add server/lib/cachePaths.js server/library.js server/api.js server/api.test.js
git commit -m "feat: persist a library of scanned folders with offline detection"
```

---

### Task 2: UI — library dropdown

**Files:**
- Modify: `ui/src/lib/api.js`
- Modify: `ui/src/App.svelte`

**Interfaces:**
- Consumes: `GET /api/library` (Task 1).
- Produces: `fetchLibrary(): Promise<Array<{path, name, lastScannedAt, mounted}>>` (`ui/src/lib/api.js`), used by `App.svelte`.

- [ ] **Step 1: Add `fetchLibrary()` to `ui/src/lib/api.js`**

Add at the end of the file:

```js
/**
 * @returns {Promise<Array<{path:string, name:string, lastScannedAt:number, mounted:boolean}>>}
 */
export async function fetchLibrary() {
  const res = await fetch("/api/library");
  if (!res.ok) throw new Error(`library failed (${res.status})`);
  return res.json();
}
```

- [ ] **Step 2: Wire it into `App.svelte`**

Change the Svelte import (line 2) from:

```js
  import { tick } from "svelte";
```

to:

```js
  import { onMount, tick } from "svelte";
```

Add `fetchLibrary` to the existing `./lib/api.js` import block (currently `scan as apiScan, setRating as apiSetRating, setCover as apiSetCover, fetchMeta`):

```js
  import {
    scan as apiScan,
    setRating as apiSetRating,
    setCover as apiSetCover,
    fetchMeta,
    fetchLibrary,
  } from "./lib/api.js";
```

Add state, right after the existing `let scanEpoch = 0;` line:

```js
  let library = [];
  let libraryOpen = false;
```

Add two functions right after the `doScan()` function definition:

```js
  async function refreshLibrary() {
    library = await fetchLibrary().catch(() => library);
  }

  function selectFromLibrary(entry) {
    if (!entry.mounted) return;
    dir = entry.path;
    libraryOpen = false;
    doScan();
  }
```

Inside `doScan()`, add a call to `refreshLibrary()` right after `localStorage.setItem(LS_KEY, res.root);`, so the success path reads:

```js
      localStorage.setItem(LS_KEY, res.root);
      refreshLibrary();
      status = `${res.count} photos · scanned in ${res.elapsedMs} ms`;
```

Add an `onMount` call to load the library on startup. Place it right after the state declarations, before `async function doScan()`:

```js
  onMount(refreshLibrary);
```

In the template, add a dropdown toggle button and panel right after the existing `<button class="scan" ...>` button (inside `<header class="topbar">`):

```svelte
    <div class="library">
      <button
        class="library-toggle"
        on:click={() => (libraryOpen = !libraryOpen)}
        title="Recently scanned folders"
      >
        Library ▾
      </button>
      {#if libraryOpen}
        <ul class="library-panel">
          {#if library.length === 0}
            <li class="library-empty">No folders scanned yet.</li>
          {/if}
          {#each library as entry (entry.path)}
            <li>
              <button
                class="library-entry"
                class:offline={!entry.mounted}
                disabled={!entry.mounted}
                on:click={() => selectFromLibrary(entry)}
                title={entry.path}
              >
                {entry.name}
                {#if !entry.mounted}<span class="offline-badge">offline</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
```

Add matching styles inside the existing `<style>` block:

```css
  .library {
    position: relative;
  }
  .library-panel {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 200;
    margin: 4px 0 0;
    padding: 4px 0;
    min-width: 220px;
    max-height: 300px;
    overflow-y: auto;
    list-style: none;
    background: #1e1e1e;
    border: 1px solid #333;
    border-radius: 4px;
  }
  .library-entry {
    display: block;
    width: 100%;
    padding: 6px 10px;
    text-align: left;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
  }
  .library-entry:hover:not(:disabled) {
    background: #2a2a2a;
  }
  .library-entry.offline {
    color: #888;
    cursor: default;
  }
  .offline-badge {
    margin-left: 6px;
    font-size: 0.7rem;
    color: #888;
  }
  .library-empty {
    padding: 6px 10px;
    color: #888;
  }
```

- [ ] **Step 3: Manual verification**

Run: `npm run dev`
Then, at `localhost:5173`: scan the "Wonders Years" test folder
(`/Users/aguerra/Pictures/fotos/Wonders Years` — read-only, do not
write/move/rename/delete anything inside it), then click "Library ▾" and
confirm the folder appears in the dropdown and re-selecting it re-scans.
This is a visual check — stop here and let John confirm it looks right;
do not attempt automated browser driving.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/api.js ui/src/App.svelte
git commit -m "feat: add a library dropdown of recently-scanned folders"
```

---

### Task 3: Electron scaffolding (shell boots, no picker yet)

**Files:**
- Modify: `package.json`
- Create: `electron/main.cjs`
- Create: `electron/preload.cjs`

**Interfaces:**
- Consumes: `createApp()` from `server/index.js` (existing, unmodified).
- Produces: `electron/main.js` (Electron entry point, referenced by `package.json`'s `"main"` field), `electron/preload.cjs` (empty `contextBridge` scaffold, filled in by Task 4).

- [ ] **Step 1: Add dependencies and scripts to `package.json`**

Add to `"devDependencies"`:

```json
    "cross-env": "^7.0.3",
    "electron": "^33.0.0",
    "wait-on": "^8.0.1"
```

Add `"main": "electron/main.cjs",` near the top of `package.json` (alongside `"version"`/`"description"`).

Add to `"scripts"`:

```json
    "electron:dev": "concurrently -n server,ui,electron -c blue,magenta,green \"npm:dev:server\" \"npm:dev:ui\" \"wait-on tcp:4321 tcp:5173 && cross-env ELECTRON_DEV=1 electron .\""
```

Run: `npm install`
Expected: installs `electron`, `cross-env`, `wait-on` with no errors.

- [ ] **Step 2: Create `electron/preload.cjs` (empty scaffold)**

```js
"use strict";

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("autogallery", {});
```

- [ ] **Step 3: Create `electron/main.cjs`**

```js
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
```

- [ ] **Step 4: Manual verification**

Run: `npm run electron:dev`
Expected terminal output: the `server` and `ui` process logs (as with
`npm run dev` today) plus an Electron window opening showing the existing
AutoGallery UI at the Vite dev server. Confirm no stack trace appears in
any of the three log streams. Stop here — John confirms the window
visually himself; do not attempt automated GUI driving.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json electron/main.cjs electron/preload.cjs
git commit -m "feat: add an Electron shell wrapping the existing server/UI unchanged"
```

**Post-implementation amendments (both applied after the steps above, before Task 4):**
1. A task review found `startEmbeddedServer()`/`createWindow()` had no error handling — a failed embedded-server startup would hang the window with no visible error. Fixed by wrapping `app.whenReady().then(createWindow)` in a try/catch that shows `dialog.showErrorBox` and calls `app.quit()` on failure.
2. Per updated guidance, `electron/main.cjs` was converted to an ES module (`electron/main.js`, `import`/`export`, plus a static `import { createApp } from "../server/index.js"` replacing the old dynamic-import workaround since both files are ESM now). `electron/preload.cjs` was also attempted as ESM but confirmed NOT to work — Electron's sandboxed preload loader throws a `SyntaxError` on `import` — so it stays CommonJS unchanged. All code shown in this task's steps above is superseded by this — Tasks 4 and 7 below already reflect the correct main.js (ESM) / preload.cjs (CommonJS) split.

---

### Task 4: Native folder picker (closes #7)

**Files:**
- Modify: `electron/main.js`
- Modify: `electron/preload.cjs` (stays CommonJS — see Global Constraints)
- Modify: `ui/src/App.svelte`

**Interfaces:**
- Produces: `window.autogallery.pickFolder(): Promise<string|null>` (renderer-facing, via `contextBridge`).
- Consumes (in `App.svelte`): the above, feature-detected.
- Consumes (in `electron/main.js`): the existing `app`, `BrowserWindow`, `createWindow`, `isDev` and the try/catch-wrapped `app.whenReady().then(...)` block added as Task 3's error-handling amendment — add to that block, don't replace it.

- [ ] **Step 1: Add the IPC handler in `electron/main.js`**

Add `dialog` and `ipcMain` to the top import:

```js
import { app, BrowserWindow, dialog, ipcMain } from "electron";
```

Add, after the `createWindow` function definition (before `app.whenReady().then(...)`):

```js
ipcMain.handle("pick-folder", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
```

- [ ] **Step 2: Expose it in `electron/preload.cjs`**

This file stays CommonJS (confirmed necessary — see Global Constraints). Replace its contents entirely with:

```js
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("autogallery", {
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
});
```

- [ ] **Step 3: Add the "Choose Folder…" button in `ui/src/App.svelte`**

Add a module-scope constant right after the existing `const DEFAULT_RATIO = 1.5;` line:

```js
  const hasNativePicker =
    typeof window !== "undefined" && !!window.autogallery?.pickFolder;
```

Add a function right after `selectFromLibrary` (added in Task 2):

```js
  async function chooseFolder() {
    const path = await window.autogallery?.pickFolder();
    if (path) {
      dir = path;
      doScan();
    }
  }
```

In the template, add the button right after the existing `<button class="scan" ...>` element:

```svelte
    {#if hasNativePicker}
      <button class="choose-folder" on:click={chooseFolder} disabled={scanning}>
        Choose Folder…
      </button>
    {/if}
```

- [ ] **Step 4: Manual verification**

Run: `npm run electron:dev`
In the Electron window, click "Choose Folder…", pick the "Wonders Years"
test folder in the native dialog
(`/Users/aguerra/Pictures/fotos/Wonders Years` — read-only), and confirm
the path field fills in and a scan runs. Cancel the dialog once too and
confirm nothing changes. Stop here for John's visual confirmation — no
automated GUI driving.

- [ ] **Step 5: Commit**

```bash
git add electron/main.js electron/preload.cjs ui/src/App.svelte
git commit -m "feat: add a native folder picker via Electron's dialog API"
```

---

### Task 5: Packaging config (electron-builder, local unsigned build)

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run electron:build` (local packaging for manual smoke-testing).

- [ ] **Step 1: Add `electron-builder` as a dev dependency**

Add to `"devDependencies"`:

```json
    "electron-builder": "^25.1.8"
```

Run: `npm install`

- [ ] **Step 2: Add the `build` config to `package.json`**

Add a top-level `"build"` key:

```json
  "build": {
    "appId": "com.johnguerra.autogallery",
    "productName": "AutoGallery",
    "files": [
      "dist/**/*",
      "server/**/*",
      "!server/**/*.test.js",
      "electron/**/*",
      "package.json"
    ],
    "asarUnpack": [
      "node_modules/sharp/**",
      "node_modules/@img/**"
    ],
    "mac": {
      "target": ["dmg", "zip"],
      "category": "public.app-category.photography"
    },
    "win": {
      "target": ["nsis"]
    },
    "linux": {
      "target": ["AppImage"],
      "category": "Graphics"
    },
    "publish": {
      "provider": "github",
      "owner": "john-guerra",
      "repo": "autoPhotoOrganizer"
    }
  }
```

`asarUnpack` matters because `sharp` ships platform-specific native `.node`
binaries (via its `@img/sharp-<platform>-<arch>` optional dependencies)
that cannot be executed from inside an `asar` archive.

- [ ] **Step 3: Add build scripts**

Add to `"scripts"`:

```json
    "electron:build": "npm run build && electron-builder --mac --win --linux",
    "electron:build:mac": "npm run build && electron-builder --mac"
```

(`electron:build` targeting all three platforms from one machine needs
Wine installed for the Windows target when run on macOS — the CI workflow
in Task 6 instead builds each platform on its own native runner, which is
the standard, more robust approach. `electron:build:mac` is for local
smoke-testing on the actual dev machine.)

- [ ] **Step 4: Manual verification**

Run: `npm run electron:build:mac`
Expected: completes without error and produces a `.dmg` and `.zip` under
`dist_electron/` (or `release/`, whichever `electron-builder`'s default
output directory resolves to on this machine — confirm by checking the
command's own log output for the actual path it wrote to). The build will
be unsigned (no Apple Developer certificate yet, per the design doc) — a
Gatekeeper warning on launch is expected and fine for this local
smoke-test; do not attempt to bypass Gatekeeper. Stop here — this step
only confirms the build succeeds structurally, not that the packaged app
runs correctly (that's John's manual check).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add electron-builder packaging config for mac/win/linux"
```

---

### Task 6: CI release workflow (GitHub Actions)

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `npm run build` (existing), `electron-builder` (Task 5's config).

- [ ] **Step 1: Create `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    tags:
      - "v*"

permissions:
  contents: write

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-latest
            flag: --mac
          - os: windows-latest
            flag: --win
          - os: ubuntu-latest
            flag: --linux
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm run build
      - run: npx electron-builder ${{ matrix.flag }} --publish always
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 2: Manual verification**

This workflow only runs on a pushed `v*` tag, which is not part of this
plan (cutting a release is John's call). Verify structurally instead: run
`npx yaml-lint .github/workflows/release.yml` if a YAML linter is
available, otherwise visually confirm the file parses as valid YAML (no
tab characters, consistent indentation) by re-reading it back.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add a tag-triggered release build for mac/win/linux"
```

---

### Task 7: Auto-update wiring

**Files:**
- Modify: `package.json`
- Modify: `electron/main.js`

**Interfaces:**
- Consumes: the `publish` config from Task 5 (`package.json`'s `"build".publish`).
- Consumes: the current shape of `electron/main.js`'s `app.whenReady()` block, which (after Task 3's error-handling amendment) is:

```js
app.whenReady().then(async () => {
  try {
    await createWindow();
  } catch (err) {
    dialog.showErrorBox("AutoGallery failed to start", String(err));
    app.quit();
  }
});
```

- [ ] **Step 1: Add the dependency**

Add to `"dependencies"` (not `devDependencies` — this runs in the packaged app):

```json
    "electron-updater": "^6.3.0"
```

Run: `npm install`

- [ ] **Step 2: Wire it into `electron/main.js`**

Add near the top imports:

```js
import { autoUpdater } from "electron-updater";
```

Replace the existing (shown in Interfaces above) with:

```js
app.whenReady().then(async () => {
  try {
    await createWindow();
    if (!isDev) autoUpdater.checkForUpdatesAndNotify();
  } catch (err) {
    dialog.showErrorBox("AutoGallery failed to start", String(err));
    app.quit();
  }
});
```

- [ ] **Step 3: Manual verification**

Run: `npm run electron:dev`
Expected: no change in dev-mode behavior (the `if (!isDev)` guard skips
the update check), and no error in the terminal log about
`electron-updater` failing to load. A real update check can only be
verified against a published release, which is out of scope here.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json electron/main.js
git commit -m "feat: wire electron-updater to check GitHub Releases for updates"
```

---

## Out of scope (see design doc)

- Removing/editing library entries, reordering, per-entry photo counts.
- Actually cutting a signed release (Apple notarization credentials, a
  Windows code-signing certificate) — account/billing decisions for John.
- The separate multi-folder "library feed view" backlog item (#16).
