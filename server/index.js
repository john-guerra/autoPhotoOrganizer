import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { registerApi } from "./api.js";
import { getDb } from "./db/connection.js";
import { migrateLegacyJsonIfNeeded } from "./migrateLegacyJson.js";

// sharp/libvips offloads decode+resize work to libuv's threadpool, which
// defaults to just 4 threads regardless of CPU core count — a jump or
// fresh scan can request dozens of thumbnails at once, but only 4 ever
// generate concurrently, so the rest queue behind them and complete in a
// visibly staggered wave (reads as the whole grid "flickering" as images
// pop in one at a time) instead of settling together. Must be set before
// the threadpool's first use (the first actual sharp operation, not import
// — ESM hoists imports above this line, but they don't submit threadpool
// work on their own), so this has to run before any /api/thumb request.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = "16";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 4321;
// Bind loopback only — this app serves the local user's photo library and must
// never be reachable from the network.
const HOST = "127.0.0.1";

export function createApp() {
  const app = express();
  // 50mb: materialize/undo POST an album's full photo-id list and the move
  // manifest ({id,from,to} per file); a big album blows the default 100kb limit
  // and the request 413s (undo silently failed — see #89).
  app.use(express.json({ limit: "50mb" }));

  migrateLegacyJsonIfNeeded(getDb());

  // Health check — proves the dev loop end to end.
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", version });
  });

  // v0.1 culling API: scan, thumbnails, full images, ratings.
  registerApi(app);

  // In production, serve the built UI. In dev, the Vite server owns the UI
  // and proxies /api here (see ui/vite.config.js).
  //
  // NOTE: there is intentionally no user-controlled file-serving endpoint yet.
  // When one is added, every path MUST be validated with server/lib/safeResolve.js
  // to prevent the path-traversal class of bug the legacy app was flagged for.
  const distDir = join(__dirname, "..", "dist");
  if (existsSync(distDir)) {
    app.use(express.static(distDir));
  }

  return app;
}

/**
 * Start `app` on loopback, preferring `preferredPort` but falling back to an
 * OS-assigned free port if that one is already taken — e.g. a running dev
 * server, a stale process, or a second AutoGallery instance holds it. Without
 * this the packaged app's `listen()` fails with EADDRINUSE and the window has
 * nothing to load (issue #64). Resolves with the port actually bound so the
 * caller can point the renderer at it.
 *
 * The standalone dev server below intentionally does NOT use this — it must
 * stay on the fixed PORT because Vite's dev proxy targets it by number.
 *
 * @param {import("express").Express} app
 * @param {{preferredPort?: number, host?: string}} [opts]
 * @returns {Promise<{server: import("node:http").Server, port: number}>}
 */
export function listenOnOpenPort(
  app,
  { preferredPort = PORT, host = HOST } = {}
) {
  const tryPort = (port) =>
    new Promise((resolve, reject) => {
      const server = app.listen(port, host, () => {
        resolve({ server, port: server.address().port });
      });
      server.on("error", reject);
    });
  // `0` asks the OS for any free port.
  return tryPort(preferredPort).catch((err) => {
    if (err && err.code === "EADDRINUSE") return tryPort(0);
    throw err;
  });
}

// Only listen when run directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.listen(PORT, HOST, () => {
    console.log(`AutoGallery server listening on http://${HOST}:${PORT}`);
  });
}
