import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { cacheRoot } from "./cachePaths.js";

/**
 * A flight recorder for the app.
 *
 * ## Why this exists (#314)
 *
 * #305 — "arrow through a folder of videos and the app says it lost the
 * server" — has now survived two fixes. Both were reasonable and both were
 * aimed at a cause nobody had measured, because there was no record of what
 * the app was doing at the moment it broke. The only evidence was a screenshot
 * after the fact, and a screenshot cannot tell these two apart:
 *
 * - the SERVER was wedged (CPU starvation: the event loop could not get round
 *   to answering `/api/health` inside the client's 4 s timeout), or
 * - the BROWSER stopped asking (its per-origin connection pool was full, so
 *   the health request was never sent at all).
 *
 * They produce the identical banner and want opposite fixes. One number —
 * event-loop delay during the stall — separates them, and nothing was
 * recording it.
 *
 * So: a small always-on log that both halves of the app write to, on one
 * clock, kept on the user's disk and sent nowhere.
 *
 * ## Two sinks, because they answer different questions
 *
 * The RING is what `/api/debug/trace` serves — the recent past, in memory, for
 * an agent or a user looking at a problem that is happening right now. The
 * FILE outlives the process, which is the only way to see the run that
 * crashed, and it is what a bug report can carry.
 *
 * ## Cost
 *
 * One object allocation and one array write per event; the file write is
 * batched behind a 250 ms timer, so a burst of two hundred requests is one
 * `appendFile`. That is cheap enough to leave on by default, which matters
 * more than it sounds: a diagnostic you have to switch on is never on when the
 * thing you needed it for happened. `AUTOGALLERY_TRACE=0` turns it off.
 *
 * The one thing this must never do is become the fault it is recording, so
 * every write path is fire-and-forget and a failed write disables the file
 * sink rather than throwing into a request.
 */

/** How many events the in-memory ring holds. ~5k covers several minutes. */
const RING_SIZE = 5000;
/** How long a batch of events may wait before being written. */
const FLUSH_MS = 250;
/** Flush early once this many are queued, so a burst cannot balloon. */
const FLUSH_AT = 400;
/** How many previous runs' logs to keep. */
const KEEP_FILES = 5;
/**
 * Roll to a new file past this many bytes.
 *
 * Rotation used to happen ONLY at startup, by file count — which is no bound
 * at all for the packaged app, whose whole point is being left open. Every
 * request writes a line, thumbnails included, so a session that scrolls 100k
 * tiles wrote ~20 MB into one file that nothing would ever roll. 8 MB is a few
 * hundred thousand lines: comfortably more than any one incident needs, and
 * `KEEP_FILES` then bounds the total at ~40 MB rather than at infinity.
 */
const MAX_BYTES = 8 * 1024 * 1024;
/** Truncate any single string field to this, so one huge value can't bloat the log. */
const MAX_STR = 500;

/** @typedef {{seq:number, t:number, ch:string, ev:string}} TraceEntry */

/** @type {Array<TraceEntry|undefined>} */
let ring = new Array(RING_SIZE);
let head = 0;
let filled = 0;
let seq = 0;

/** @type {TraceEntry[]} */
let pending = [];
let flushTimer = null;
/** Serializes appends, so two flushes cannot interleave inside one file. */
let writeChain = Promise.resolve();
/** @type {string|null} */
let filePath = null;
/** Bytes written to the current file, so rotation does not need to stat it. */
let bytesWritten = 0;
/** @type {string|null} */
let logDir = null;
let fileBroken = false;
let enabled = false;
let started = false;

/**
 * On by default, off under vitest.
 *
 * Tests opt IN (`AUTOGALLERY_TRACE=1`) rather than out: a unit suite that
 * writes a log file per run is a suite that leaves rubbish in
 * `~/.autogallery`, and `cacheRoot()` deliberately throws under vitest without
 * a scratch root anyway (#293).
 */
function wantEnabled() {
  if (process.env.AUTOGALLERY_TRACE === "0") return false;
  if (process.env.AUTOGALLERY_TRACE === "1") return true;
  return !process.env.VITEST;
}

/** Where this run's log lives. `null` until `startTrace` has run. */
export function tracePath() {
  return filePath;
}

export function traceEnabled() {
  return enabled;
}

/** Two digits, so a filename sorts the way a human reads it. */
const pad = (n) => String(n).padStart(2, "0");

function fileNameFor(d) {
  // Milliseconds, not seconds: `node --watch` restarts the dev server on every
  // `server/` edit, and two starts inside one second shared a filename — so
  // two runs appended into one file and `KEEP_FILES` evicted the session you
  // were actually investigating.
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return (
    `trace-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${ms}.ndjson`
  );
}

/**
 * Begin recording. Idempotent; safe to call before the cache root exists.
 *
 * Deliberately NOT automatic on import. A module that starts writing files as
 * a side effect of being imported is one that cannot be unit-tested, and it
 * would fire inside the ML worker child too, where a second process appending
 * to the same file is not what anyone wants.
 *
 * @param {{dir?: string}} [opts] override the directory (tests, and the ML worker)
 */
export async function startTrace(opts = {}) {
  enabled = wantEnabled();
  if (!enabled || started) return filePath;
  started = true;
  try {
    logDir = opts.dir ?? join(cacheRoot(), "logs");
    await mkdir(logDir, { recursive: true });
    filePath = join(logDir, fileNameFor(new Date()));
    bytesWritten = 0;
    await pruneOldLogs(logDir);
  } catch {
    // No disk sink — the ring still works, and a diagnostic that refuses to
    // start because it cannot write is worse than one that records less.
    fileBroken = true;
  }
  return filePath;
}

/** Keep the newest `KEEP_FILES - 1`, since this run is about to add one. */
async function pruneOldLogs(dir) {
  const names = (await readdir(dir))
    .filter((f) => f.startsWith("trace-") && f.endsWith(".ndjson"))
    .sort();
  for (const old of names.slice(
    0,
    Math.max(0, names.length - KEEP_FILES + 1)
  )) {
    await rm(join(dir, old), { force: true });
  }
}

/** Clamp a field so one pathological value cannot dominate the log. */
function clamp(v) {
  if (typeof v === "string")
    return v.length > MAX_STR ? v.slice(0, MAX_STR) : v;
  return v;
}

/**
 * Record one event.
 *
 * @param {string} ch channel — `http`, `loop`, `job`, `proc`, `ui`, `video`
 * @param {string} ev what happened, in the past tense where it reads better
 * @param {Record<string, unknown>} [fields] anything worth knowing, kept flat
 * @returns {TraceEntry|null} the entry, or null when tracing is off
 */
export function trace(ch, ev, fields) {
  if (!enabled) return null;
  /** @type {any} */
  const e = { seq: ++seq, t: Date.now(), ch, ev };
  if (fields) {
    for (const k of Object.keys(fields)) e[k] = clamp(fields[k]);
  }
  ring[head] = e;
  head = (head + 1) % RING_SIZE;
  if (filled < RING_SIZE) filled++;
  if (!fileBroken) {
    pending.push(e);
    if (pending.length >= FLUSH_AT) flushTrace();
    else scheduleFlush();
  }
  return e;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushTrace, FLUSH_MS);
  // Never hold the process open for a log line.
  flushTimer.unref?.();
}

/**
 * Write everything queued. Returns when THIS batch has landed.
 *
 * Awaiting it is for tests and for shutdown; the hot path calls it and walks
 * away.
 */
export function flushTrace() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (fileBroken) {
    // Nothing will ever drain this. Dropping it is the difference between a
    // diagnostic that degrades and one that leaks for the life of the process.
    pending = [];
    return writeChain;
  }
  // `filePath` is still null between `trace()` and `startTrace()` resolving.
  // Holding the batch is correct — those first events are the startup ones,
  // which are exactly the ones you want when the app is broken at launch.
  if (!pending.length || !filePath) return writeChain;
  const batch = pending;
  pending = [];
  const text = batch.map((e) => JSON.stringify(e)).join("\n") + "\n";
  bytesWritten += Buffer.byteLength(text);
  const target = filePath;
  const rolling = bytesWritten >= MAX_BYTES && logDir;
  if (rolling) {
    // Roll BEFORE the write lands, so the next batch already has the new
    // path; the current batch finishes in the file it was sized against.
    filePath = join(logDir, fileNameFor(new Date()));
    bytesWritten = 0;
  }
  writeChain = writeChain
    .then(() => appendFile(target, text))
    .then(() => (rolling ? pruneOldLogs(logDir) : undefined))
    .catch(() => {
      // A log that throws into a request handler would be a self-inflicted
      // outage. Give up on the file and keep the ring.
      fileBroken = true;
    });
  return writeChain;
}

/**
 * The recent past, oldest first.
 *
 * @param {{since?: number, limit?: number, ch?: string}} [q] `since` is a
 *   sequence number, not a timestamp — a poller wants "what is new since I
 *   last looked", and two events can share a millisecond.
 */
export function traceEntries(q = {}) {
  const { since = 0, limit = 1000, ch } = q;
  /** @type {TraceEntry[]} */
  const out = [];
  const start = filled < RING_SIZE ? 0 : head;
  for (let i = 0; i < filled; i++) {
    const e = ring[(start + i) % RING_SIZE];
    if (!e || e.seq <= since) continue;
    if (ch && e.ch !== ch) continue;
    out.push(e);
  }
  return out.slice(-limit);
}

/**
 * Accept a batch of events recorded in the BROWSER.
 *
 * The client's own timestamp is kept as `ct` and the server's receipt time
 * becomes `t`, so everything in the file is orderable on one clock while the
 * client's view of when it happened is still there to compare. Clock skew
 * between the two is exactly the sort of thing that makes an interleaved log
 * lie, and this is the cheapest way not to have to trust it.
 *
 * @param {Array<{ev?: string, t?: number, ch?: string}>} entries
 * @param {number} [max] refuse more than this many in one batch
 * @returns {number} how many were recorded
 */
export function ingestClientTrace(entries, max = 200) {
  if (!Array.isArray(entries)) return 0;
  let n = 0;
  for (const raw of entries.slice(0, max)) {
    if (!raw || typeof raw !== "object") continue;
    // `seq` is stripped, not just unused. It is the poller's cursor
    // (`?since=`), and `trace()` spreads these fields on AFTER assigning it —
    // so a client sending `seq: 999999999` would land in the ring above every
    // real entry and permanently blind anyone polling from the last seq they
    // saw. Same for `t`, which orders the file: the client's own clock is
    // kept as `ct` instead.
    const { ev, t, ch, seq: _seq, ...rest } = raw;
    trace(typeof ch === "string" ? `ui:${ch}` : "ui", String(ev ?? "event"), {
      ...rest,
      ct: typeof t === "number" ? t : undefined,
    });
    n++;
  }
  return n;
}

/** Test-only: forget everything, including which file we were writing. */
export function _resetTraceForTest() {
  bytesWritten = 0;
  logDir = null;
  ring = new Array(RING_SIZE);
  head = 0;
  filled = 0;
  seq = 0;
  pending = [];
  clearTimeout(flushTimer);
  flushTimer = null;
  writeChain = Promise.resolve();
  filePath = null;
  fileBroken = false;
  enabled = false;
  started = false;
}
