import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";

/**
 * The watchdog's three states (#282).
 *
 * The bug this covers is a MESSAGE, not a crash, which is exactly the kind
 * that ships: John reset his library, the server went quiet for the better
 * part of a minute doing what he asked, and the UI announced "Lost the
 * connection to the AutoGallery server. Reconnecting… (attempt 4)". He closed
 * Electron and reopened it — reasonably, having been told the backend was
 * gone — and the reset was still incomplete.
 *
 * Module state (`lastPid`, `lastBusyAt`) is module-level and deliberately not
 * exported, so each test re-imports the module fresh rather than reaching in.
 */

/** Queue of replies for successive /api/health calls. `null` = no answer. */
let replies;
let fetchCalls;

/** Import a pristine copy of the watchdog. */
async function freshModule() {
  vi.resetModules();
  return import("./serverHealth.js");
}

function reply(body) {
  return { ok: true, json: async () => body };
}

beforeEach(() => {
  vi.useFakeTimers();
  replies = [];
  fetchCalls = 0;
  vi.stubGlobal("fetch", async () => {
    fetchCalls += 1;
    const next = replies.length > 1 ? replies.shift() : replies[0];
    // A silent server is a hung request that the caller's AbortController
    // eventually kills — from `ping`'s point of view, a throw.
    if (next === null || next === undefined) throw new Error("no answer");
    return next;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Run exactly ONE heartbeat and let its promise chain settle.
 *
 * The interval matters: `startServerWatchdog` schedules at 0 and every tick
 * re-schedules at HEARTBEAT_MS (5000). Advancing 6000 fires BOTH, so a "beat"
 * was silently two pings and the queue was one reply ahead of where the test
 * thought it was. Step just past one boundary instead.
 */
async function beat(mod, ms = 5001) {
  await vi.advanceTimersByTimeAsync(ms);
  return get(mod.serverStatus);
}
/** The immediate `schedule(0)` tick that starting the watchdog queues. */
const firstBeat = (mod) => beat(mod, 1);

describe("serverHealth — busy is not down (#282)", () => {
  it("reports BUSY, not down, when a server that said it was working goes quiet", async () => {
    const mod = await freshModule();
    replies = [
      reply({
        status: "ok",
        pid: 1,
        busy: true,
        running: ["Resetting the library"],
      }),
      null, // the long blocking stretch: no answer within the 4s timeout
    ];
    mod.startServerWatchdog();

    await firstBeat(mod); // first ping succeeds and records "busy"
    expect(get(mod.serverStatus)).toBe("up");

    expect(await beat(mod)).toBe("busy");
    // ...and it names what it is waiting on, which is the whole point.
    expect(get(mod.serverBusyWith)).toEqual(["Resetting the library"]);
    mod.stopServerWatchdog();
  });

  it("still reports DOWN when the server never said it was busy", async () => {
    // Guessing "busy" for a genuinely dead server is the same failure with the
    // sign flipped: the user waits for something that is never coming back.
    const mod = await freshModule();
    replies = [reply({ status: "ok", pid: 1, busy: false, running: [] }), null];
    mod.startServerWatchdog();

    await firstBeat(mod);
    expect(await beat(mod)).toBe("down");
    expect(get(mod.serverBusyWith)).toEqual([]);
    mod.stopServerWatchdog();
  });

  it("stops believing 'busy' once the report goes stale", async () => {
    // Otherwise a server that dies mid-job is reported as busy forever, and
    // the banner becomes a thing the user learns to ignore.
    const mod = await freshModule();
    replies = [
      reply({ status: "ok", pid: 1, busy: true, running: ["Scanning"] }),
      null,
    ];
    mod.startServerWatchdog();

    await firstBeat(mod);
    expect(await beat(mod)).toBe("busy");

    // Past BUSY_TRUST_MS (60s) with nothing but silence.
    await vi.advanceTimersByTimeAsync(70000);
    expect(get(mod.serverStatus)).toBe("down");
    mod.stopServerWatchdog();
  });

  it("does NOT announce a restart when it was only busy", async () => {
    // `serverRestarted` makes every caller refetch. Firing it each time a long
    // job stops answering for a moment would be a self-inflicted stampede on
    // the server that is already the busiest.
    const mod = await freshModule();
    replies = [
      reply({ status: "ok", pid: 1, busy: true, running: ["Scanning"] }),
      null,
      reply({ status: "ok", pid: 1, busy: false, running: [] }),
    ];
    mod.startServerWatchdog();

    await firstBeat(mod);
    const before = get(mod.serverRestarted);
    expect(await beat(mod)).toBe("busy");
    replies = [reply({ status: "ok", pid: 1, busy: false, running: [] })];
    expect(await beat(mod)).toBe("up");

    expect(get(mod.serverRestarted)).toBe(before);
    mod.stopServerWatchdog();
  });

  it("DOES announce a restart when the pid changed, busy or not", async () => {
    // A different process cannot have the data we cached, and that is true
    // whether or not the old one was busy when it died.
    const mod = await freshModule();
    replies = [
      reply({ status: "ok", pid: 1, busy: true, running: ["Scanning"] }),
    ];
    mod.startServerWatchdog();
    await firstBeat(mod);
    const before = get(mod.serverRestarted);

    replies = [reply({ status: "ok", pid: 999, busy: false, running: [] })];
    await beat(mod);

    expect(get(mod.serverRestarted)).toBe(before + 1);
    mod.stopServerWatchdog();
  });
});
