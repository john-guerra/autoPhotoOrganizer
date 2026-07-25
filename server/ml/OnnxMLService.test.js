import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { OnnxMLService } from "./OnnxMLService.js";

/** A fake child process. No real spawn — the default suite must never fork. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.stdout = new EventEmitter();
  // Real child.stdout is a Readable; the implementation calls setEncoding on
  // it so multi-byte UTF-8 sequences aren't split across chunk boundaries.
  child.stdout.setEncoding = vi.fn();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => child.emit("exit", null, "SIGTERM"));
  child.pid = 4242;
  /** Reply to the request just written, as the worker would. */
  child.reply = (obj) => child.stdout.emit("data", JSON.stringify(obj) + "\n");
  return child;
}

describe("OnnxMLService", () => {
  it("round-trips a health request over JSON-lines", async () => {
    const child = fakeChild();
    const svc = new OnnxMLService({ spawn: () => child });
    const p = svc.health();
    // The request went out as one line of JSON.
    const sent = JSON.parse(child.stdin.write.mock.calls[0][0]);
    expect(sent.op).toBe("health");
    child.reply({ id: sent.id, ok: true, ort: "1.20.0", providers: ["cpu"] });
    await expect(p).resolves.toMatchObject({ ok: true, ort: "1.20.0" });
    svc.stop();
  });

  it("rejects the in-flight request when the child dies, and stays usable", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const svc = new OnnxMLService({ spawn });
    const p = svc.health();
    child.emit("exit", 1, null); // segfault
    await expect(p).rejects.toThrow(/exited/i);
    // The service is not poisoned — the app stays usable without ML.
    expect(() => svc.stop()).not.toThrow();
    // No eager respawn inside the exit handler itself — only the ONE spawn
    // from the original health() call above.
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("respawns on the next request after a crash", async () => {
    const children = [fakeChild(), fakeChild()];
    let n = 0;
    const svc = new OnnxMLService({ spawn: () => children[n++] });
    const first = svc.health();
    children[0].emit("exit", 1, null);
    await expect(first).rejects.toThrow();

    const second = svc.health();
    const sent = JSON.parse(children[1].stdin.write.mock.calls[0][0]);
    children[1].reply({ id: sent.id, ok: true, ort: "1.20.0", providers: [] });
    await expect(second).resolves.toMatchObject({ ok: true });
    expect(n).toBe(2);
    svc.stop();
  });

  it("stop() kills the child and later requests respawn", () => {
    const child = fakeChild();
    const svc = new OnnxMLService({ spawn: () => child });
    svc.health().catch(() => {});
    svc.stop();
    expect(child.kill).toHaveBeenCalled();
  });

  it("surfaces a malformed line as a rejection, not a crash", async () => {
    const child = fakeChild();
    const svc = new OnnxMLService({ spawn: () => child });
    const p = svc.health();
    child.stdout.emit("data", "not json\n");
    // A garbage line must not take the process down; the request is still
    // pending, so kill the child to settle it.
    child.emit("exit", 1, null);
    await expect(p).rejects.toThrow();
    svc.stop();
  });
});

// The ONLY test that spawns a real child. Off by default so the suite stays
// fast and hermetic — but without it, "does the worker start at all" would be
// discovered by a user rather than by CI.
const integration =
  process.env.ML_INTEGRATION === "1" ? describe : describe.skip;

integration("OnnxMLService (real child)", () => {
  it("answers a health request from a genuinely spawned worker", async () => {
    const svc = new OnnxMLService();
    const h = await svc.health();
    expect(h.ok).toBe(true);
    // Version-shaped, not merely a string: "unknown" (the fallback the worker
    // reports if it reads a property that doesn't exist on the real package)
    // is a string too, so a bare typeof check passes on a broken introspection
    // path. Don't hardcode the exact version — it moves with the caret range.
    expect(h.ort).toMatch(/^\d+\.\d+\.\d+/);
    expect(h.pid).toBeGreaterThan(0);
    svc.stop();
  }, 30_000);
});
