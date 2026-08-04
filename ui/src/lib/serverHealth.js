import { writable, get } from "svelte/store";

/**
 * Connection watchdog for the local API server.
 *
 * The Express server can die or be restarted under us (a crash, or `node --watch`
 * reloading it after a server edit). Before this, the UI just started throwing
 * failed fetches into the console and quietly showed stale data — the user had no
 * idea the backend was gone. Now we notice, SAY SO, retry with backoff, and tell
 * the app to refetch once it's back.
 *
 * Detection is a heartbeat rather than wrapping every call site: one cheap
 * /api/health poll catches a dead server no matter which request would have
 * failed, and can't be forgotten when a new endpoint is added.
 *
 * `pid` identifies the server process: if it CHANGES between two successful
 * pings, the server restarted (possibly while we weren't looking) and anything we
 * cached may be stale — callers should refetch.
 */

/**
 * THREE states, not two (#282).
 *
 * `"down"` used to cover both "the process is gone" and "the process is alive
 * and too busy to answer within 4 s", and those need opposite messages. John
 * reset his library, the server spent the better part of a minute unable to
 * answer, and the UI told him the connection was lost — about a process that
 * was doing exactly what he had asked it to.
 *
 * `"busy"` is claimed only on EVIDENCE: the last successful ping said work was
 * in flight, and it was recent enough to still be believable. Absent that, a
 * silent server is still reported as down, because guessing "busy" for a
 * genuinely dead server is the same failure with the sign flipped — it would
 * leave the user waiting on something that is never coming back.
 *
 * @type {import("svelte/store").Writable<"up"|"busy"|"down">}
 */
export const serverStatus = writable("up");
/** What the server last said it was working on — the label for a "busy" state. */
export const serverBusyWith = writable(/** @type {string[]} */ ([]));
/** Consecutive failed reconnect attempts (0 when healthy). */
export const reconnectAttempts = writable(0);
/** Bumped whenever the server comes back (or its pid changed) → callers refetch. */
export const serverRestarted = writable(0);

const HEARTBEAT_MS = 5000; // while healthy
const MAX_BACKOFF_MS = 10000;
/**
 * How long a "the server told me it was busy" report stays believable.
 *
 * It has to outlast a single blocking stretch or it defeats itself, and it has
 * to expire or a server that dies mid-job is reported as busy forever. 60 s is
 * comfortably longer than any remaining unyielded stretch after #231 and #281
 * (the worst measured was 8.4 s) and short enough that a real crash surfaces
 * while the user is still looking at the screen.
 */
const BUSY_TRUST_MS = 60000;

let lastPid = null;
/** When the server last reported itself busy, 0 if not. */
let lastBusyAt = 0;
/** @type {string[]} labels from that last report. */
let lastRunning = [];
/** Did the previous non-"up" state come from BUSY rather than DOWN? */
let wasBusyNotDown = false;
let timer = null;
let stopped = false;
// "Retry now" could fire while a tick was already awaiting ping(), so both would
// land and double-count the attempt counter. One at a time.
let ticking = false;

async function ping(timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("/api/health", {
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // network error, abort, or server gone
  } finally {
    clearTimeout(t);
  }
}

function schedule(ms) {
  clearTimeout(timer);
  if (stopped) return;
  timer = setTimeout(tick, ms);
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await tickOnce();
  } finally {
    ticking = false;
  }
}

async function tickOnce() {
  const health = await ping();
  // The endpoint (server/index.js) answers
  // {status:"ok", version, pid, busy, running:[label]}.
  if (health?.status === "ok") {
    const wasDown = get(serverStatus) !== "up";
    const pidChanged = lastPid != null && health.pid !== lastPid;
    lastPid = health.pid;
    lastBusyAt = health.busy ? Date.now() : 0;
    lastRunning = health.running ?? [];
    serverBusyWith.set(lastRunning);
    if (wasDown || pidChanged) {
      reconnectAttempts.set(0);
      // The server we're talking to is not the one we had loaded data from.
      // A pid change means a genuine restart; coming back from BUSY does not,
      // and refetching the world every time a long job stops answering for a
      // moment would be a self-inflicted stampede.
      if (pidChanged || !wasBusyNotDown) serverRestarted.update((n) => n + 1);
    }
    serverStatus.set("up");
    wasBusyNotDown = false;
    schedule(HEARTBEAT_MS);
    return;
  }

  // No answer. Alive-and-busy, or gone? The distinction is what #282 is about,
  // and it is decided by what the server SAID before it went quiet.
  const attempt = get(reconnectAttempts) + 1;
  reconnectAttempts.set(attempt);
  const recentlyBusy =
    lastBusyAt > 0 && Date.now() - lastBusyAt < BUSY_TRUST_MS;
  if (recentlyBusy) {
    // Keep polling at the normal cadence rather than backing off: busy work
    // ends, and the point is to notice the moment it does.
    serverStatus.set("busy");
    wasBusyNotDown = true;
    schedule(HEARTBEAT_MS);
    return;
  }
  // Down: back off, but keep trying — a `node --watch` restart is back in ~1s.
  serverStatus.set("down");
  serverBusyWith.set([]);
  wasBusyNotDown = false;
  schedule(Math.min(MAX_BACKOFF_MS, 400 * 2 ** Math.min(attempt, 5)));
}

/** Start the heartbeat (idempotent). */
export function startServerWatchdog() {
  stopped = false;
  schedule(0);
}
export function stopServerWatchdog() {
  stopped = true;
  clearTimeout(timer);
}
/** "Retry now" — skip the backoff. */
export function retryServerNow() {
  schedule(0);
}
