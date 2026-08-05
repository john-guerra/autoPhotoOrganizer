import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { registerApi } from "./api.js";
import { getDb } from "./db/connection.js";
import { registry } from "./jobs/registry.js";
import { interactiveInFlight } from "./lib/interactive.js";
import {
  startTrace,
  trace,
  traceEntries,
  tracePath,
  traceEnabled,
  flushTrace,
  ingestClientTrace,
} from "./lib/trace.js";
import { startEventLoopWatch, traceHttp } from "./lib/eventLoopWatch.js";
import { liveChildren } from "./lib/procTrace.js";

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

/**
 * @param {{ml?: import("./ml/MLService.js").MLService}} [opts] `ml` is
 *   injectable so tests never spawn the real ONNX child process (registerApi
 *   otherwise constructs one LAZILY on first use — see api.js). Keeping this
 *   seam abstract (MLService, not OnnxMLService) is also what leaves room for
 *   a genuinely different host later without server/ changing shape — see
 *   MLService.js's own doc for why it's kept abstract at all.
 */
export function createApp({ ml } = {}) {
  const app = express();
  // 50mb: materialize/undo POST an album's full photo-id list and the move
  // manifest ({id,from,to} per file); a big album blows the default 100kb limit
  // and the request 413s (undo silently failed — see #89).
  app.use(express.json({ limit: "50mb" }));

  // The flight recorder (#314), FIRST so it sees every request including the
  // ones that 404. It records on the socket closing, so it costs a listener
  // per request and nothing else.
  //
  // `inflight` and `procs` ride along on every line because the interesting
  // question about a slow request is never the request — it is what else was
  // happening while it was slow.
  const probes = { inflight: interactiveInFlight, procs: liveChildren };
  app.use(traceHttp(probes));

  // `startTrace` sets the enabled flag synchronously and only the FILE work is
  // async, so `traceEnabled()` is already truthful on the next line.
  startTrace().then((path) => {
    if (path) console.log(`[trace] ${path}`);
  });
  if (traceEnabled()) {
    trace("app", "start", { version, pid: process.pid, node: process.version });
    startEventLoopWatch({ probes });
  }

  // The pre-SQLite JSON stores are NO LONGER IMPORTED (#295).
  //
  // `migrateLegacyJsonIfNeeded` used to run here on every start, guarded only
  // by `SELECT COUNT(*) FROM photos == 0` and documented as "safe to call
  // unconditionally". It was, right up until a reset could actually succeed:
  // #293 fixed the FOREIGN KEY failure that had been stopping resets from
  // emptying `photos` at all, and an emptied table is byte-for-byte the state
  // a fresh install has. So John reset his library, quit, reopened, and got
  // five folders back out of `library.json` — two of them on an external
  // volume — plus the ratings and cover choices, as photo stubs.
  //
  // A row count cannot distinguish "never imported" from "just wiped", and no
  // second guard fixes that class of mistake: the next piece of state that
  // looks like a fresh install fools it the same way. The import is a one-time
  // migration from a generation superseded in 2026-07 and every live library
  // has long since been through it, so it is deleted rather than re-gated.
  //
  // The JSON files are left untouched on disk. Nothing is destroyed, and the
  // import could be reintroduced deliberately if it ever turned out to be
  // needed.
  getDb();

  // Health check — proves the dev loop end to end, AND is the liveness probe the
  // UI's connection watchdog polls (ui/src/lib/serverHealth.js). Deliberately
  // trivial (no DB work) so it still answers while a scan is hammering the index.
  // `pid` is the restart signal: if it changes between two successful polls the
  // server was replaced under us (crash, or `node --watch` reloading a server
  // edit) and the client must refetch. no-store so a cache can't fake liveness.
  //
  // It also reports WHAT IS RUNNING (#282). John reset his library, the server
  // spent up to a minute unable to answer anything, and the UI concluded
  // "Lost the connection to the AutoGallery server. Reconnecting… (attempt 4)"
  // — about a process that was alive and busy doing exactly what he asked.
  // The client cannot tell "busy" from "dead" by silence alone, so it needs to
  // have been TOLD, before the silence, that work was in flight.
  //
  // Still no DB work: the registry is an in-memory Map and `interactiveInFlight`
  // is an integer.
  app.get("/api/health", (_req, res) => {
    res.set("Cache-Control", "no-store");
    const running = registry
      .list()
      .filter((j) => j.status === "running" || j.status === "paused")
      .map((j) => j.label)
      .filter(Boolean);
    res.json({
      status: "ok",
      version,
      pid: process.pid,
      // `busy` is deliberately coarse — the client only needs to know whether
      // silence would be EXPLICABLE, not to reproduce the jobs panel.
      busy: running.length > 0 || interactiveInFlight() > 0,
      running,
    });
  });

  /**
   * The flight recorder, readable (#314).
   *
   * `since` is a SEQUENCE number, not a timestamp: a poller wants "what is new
   * since I last looked", and two events routinely share a millisecond.
   *
   * Under `/api/debug/` rather than a hidden name because there is nothing
   * secret here — it is the user's own machine, and a diagnostic you have to
   * know a magic word to reach is one nobody uses when it matters.
   */
  app.get("/api/debug/trace", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
      enabled: traceEnabled(),
      path: tracePath(),
      entries: traceEntries({
        since: Number(req.query.since) || 0,
        limit: Math.min(5000, Number(req.query.limit) || 1000),
        ch: req.query.ch ? String(req.query.ch) : undefined,
      }),
    });
  });

  /**
   * The BROWSER's half of the log, merged into the same stream.
   *
   * One file, one clock, both sides — which is the only way to see that the
   * client gave up at the same moment the server was still answering everyone
   * else. Two separate logs would leave that inference to whoever is reading
   * two sets of timestamps from two machines' clocks.
   */
  app.post("/api/debug/trace", (req, res) => {
    const n = ingestClientTrace(req.body?.entries);
    res.json({ recorded: n });
  });

  /** Force the pending batch to disk — for a user about to attach the file. */
  app.post("/api/debug/trace/flush", async (_req, res) => {
    await flushTrace();
    res.json({ path: tracePath(), enabled: traceEnabled() });
  });

  // v0.1 culling API: scan, thumbnails, full images, ratings.
  registerApi(app, { ml });

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
      // Express 5's app.listen() once()-wraps the final callback and registers
      // it as BOTH the 'listening' and 'error' handler, so on EADDRINUSE the
      // callback fires Node-style with an Error argument — and server.address()
      // is null at that point. Honor that err param (reading .port off a null
      // address is exactly the crash it otherwise causes). The separate 'error'
      // listener stays for Express-4 semantics, where only the event fires.
      const server = app.listen(port, host, (err) => {
        if (err) return reject(err);
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
