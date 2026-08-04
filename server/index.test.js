import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import { listenOnOpenPort } from "./index.js";

// Track opened servers so each test tears its listeners down.
const opened = [];
const track = (r) => (opened.push(r.server), r);
afterEach(() => {
  for (const s of opened) s.close();
  opened.length = 0;
});

describe("listenOnOpenPort (issue #64)", () => {
  it("binds an OS-assigned free port when the preferred port is available", async () => {
    const { port } = track(
      await listenOnOpenPort(express(), { preferredPort: 0 })
    );
    expect(port).toBeGreaterThan(0);
  });

  it("falls back to a different free port when the preferred one is taken", async () => {
    // Occupy a real port first.
    const first = track(
      await listenOnOpenPort(express(), { preferredPort: 0 })
    );
    const taken = first.port;
    // Asking for that same (now-occupied) port must not throw EADDRINUSE —
    // it should transparently land on a different free port.
    const second = track(
      await listenOnOpenPort(express(), { preferredPort: taken })
    );
    expect(second.port).toBeGreaterThan(0);
    expect(second.port).not.toBe(taken);
  });
});

describe("/api/health says WHAT it is doing (#282)", () => {
  /**
   * The client cannot tell "alive and busy" from "dead" by silence alone —
   * both are a request that never answers. So the distinction has to be
   * something the server said BEFORE it went quiet, which makes this the load-
   * bearing half of the fix: without it the watchdog has no evidence to
   * reason from and correctly falls back to reporting the connection lost.
   */
  it("reports busy with the running labels, and idle when nothing runs", async () => {
    const { createApp } = await import("./index.js");
    const { registry } = await import("./jobs/registry.js");
    const { port, server } = track(
      await listenOnOpenPort(createApp(), { preferredPort: 0 })
    );
    opened.push(server);
    const health = async () =>
      (await fetch(`http://127.0.0.1:${port}/api/health`)).json();

    const idle = await health();
    expect(idle.status).toBe("ok");
    expect(idle.busy).toBe(false);
    expect(idle.running).toEqual([]);

    const job = registry.create("library-reset", {
      label: "Resetting the library",
    });
    try {
      const busy = await health();
      expect(busy.busy).toBe(true);
      // The label, not just a count: the banner names the work.
      expect(busy.running).toContain("Resetting the library");
      // Still cheap and still honest about identity.
      expect(busy.pid).toBe(process.pid);
    } finally {
      registry.finish(job.id, {});
      registry.dismiss(job.id);
    }

    // A PAUSED job counts too — it is work in flight, waiting its turn, and a
    // server holding one is not idle from the user's point of view.
    const parked = registry.create("pipeline", { label: "Scanning" });
    try {
      registry.pause(parked.id, "waiting its turn", { parked: true });
      const stillBusy = await health();
      expect(stillBusy.busy).toBe(true);
      expect(stillBusy.running).toContain("Scanning");
    } finally {
      registry.cancel(parked.id);
      registry.fail(parked.id, new Error("test cleanup"));
      registry.resume(parked.id);
      registry.dismiss(parked.id);
    }
  });
});
