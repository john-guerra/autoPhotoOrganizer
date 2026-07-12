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

/** @type {import("svelte/store").Writable<"up"|"down">} */
export const serverStatus = writable("up");
/** Consecutive failed reconnect attempts (0 when healthy). */
export const reconnectAttempts = writable(0);
/** Bumped whenever the server comes back (or its pid changed) → callers refetch. */
export const serverRestarted = writable(0);

const HEARTBEAT_MS = 5000; // while healthy
const MAX_BACKOFF_MS = 10000;

let lastPid = null;
let timer = null;
let stopped = false;

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
  const health = await ping();
  // The endpoint (server/index.js) answers {status:"ok", version, pid}.
  if (health?.status === "ok") {
    const wasDown = get(serverStatus) === "down";
    const pidChanged = lastPid != null && health.pid !== lastPid;
    lastPid = health.pid;
    if (wasDown || pidChanged) {
      serverStatus.set("up");
      reconnectAttempts.set(0);
      // The server we're talking to is not the one we had loaded data from.
      serverRestarted.update((n) => n + 1);
    }
    schedule(HEARTBEAT_MS);
    return;
  }
  // Down: back off, but keep trying — a `node --watch` restart is back in ~1s.
  serverStatus.set("down");
  const attempt = get(reconnectAttempts) + 1;
  reconnectAttempts.set(attempt);
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
