import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  interactiveRoute,
  whenIdle,
  interactiveInFlight,
  _resetInteractiveForTest,
} from "./interactive.js";

beforeEach(() => _resetInteractiveForTest());

/** A stand-in for an Express response: it emits "close" when the request ends,
 *  whether it was served or the browser walked away mid-scroll. */
function fakeReq() {
  const res = new EventEmitter();
  let nexted = false;
  interactiveRoute({}, res, () => (nexted = true));
  return { res, end: () => res.emit("close"), nexted: () => nexted };
}

describe("whenIdle", () => {
  it("resolves immediately when nothing interactive is in flight", async () => {
    await expect(whenIdle()).resolves.toBeUndefined();
  });

  it("makes the sweep wait while the user is being served, then lets it run", async () => {
    const a = fakeReq();
    const b = fakeReq();
    expect(interactiveInFlight()).toBe(2);

    let ran = false;
    const swept = whenIdle().then(() => (ran = true));

    // One request finishing is not enough — the other is still in flight.
    a.end();
    await Promise.resolve();
    expect(ran).toBe(false);
    expect(interactiveInFlight()).toBe(1);

    b.end();
    await swept;
    expect(ran).toBe(true);
  });

  it("releases a request the browser ABANDONED, not just one we answered", async () => {
    // A tile scrolled out of view mid-load: the response never "finishes", it
    // just closes. Waiting on "finish" would park the sweep forever.
    const abandoned = fakeReq();
    let ran = false;
    const swept = whenIdle().then(() => (ran = true));
    expect(ran).toBe(false);

    abandoned.end(); // "close" without a completed response
    await swept;
    expect(ran).toBe(true);
    expect(interactiveInFlight()).toBe(0);
  });

  it("wakes every waiter, and calls next() so the route still runs", async () => {
    const r = fakeReq();
    expect(r.nexted()).toBe(true);
    const all = Promise.all([whenIdle(), whenIdle(), whenIdle()]);
    r.end();
    await expect(all).resolves.toHaveLength(3);
  });
});

describe("whenIdle actually yields (#231, architecture review M11)", () => {
  it("reaches the MACROTASK queue, not just the microtask queue", async () => {
    // The bug in one assertion. `Promise.resolve()` awaits as a microtask, and
    // microtasks run to exhaustion BEFORE the loop reaches timers or I/O — so
    // a sweep whose only yield was `await idle()` handed control to nobody.
    // Measured before the fix: 10.9M awaits, 0 macrotasks.
    _resetInteractiveForTest();
    let timerFired = false;
    setTimeout(() => {
      timerFired = true;
    }, 0);

    // A tight loop of the kind a sweep runs. If `whenIdle` only yields a
    // microtask, the timer above cannot possibly fire before this finishes.
    for (let i = 0; i < 50; i++) await whenIdle();

    expect(timerFired).toBe(true);
  });
});
