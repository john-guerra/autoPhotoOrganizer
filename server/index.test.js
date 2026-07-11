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
