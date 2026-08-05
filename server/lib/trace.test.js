import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  trace,
  startTrace,
  flushTrace,
  traceEntries,
  tracePath,
  traceEnabled,
  ingestClientTrace,
  _resetTraceForTest,
} from "./trace.js";

/**
 * The flight recorder (#314).
 *
 * Tracing is OFF under vitest by default, so every case here opts in
 * explicitly — which is also the assertion that the default holds.
 */

let dir;

beforeEach(async () => {
  _resetTraceForTest();
  dir = await mkdtemp(join(tmpdir(), "ag-trace-"));
  process.env.AUTOGALLERY_TRACE = "1";
});

afterEach(async () => {
  _resetTraceForTest();
  delete process.env.AUTOGALLERY_TRACE;
  await rm(dir, { recursive: true, force: true });
});

describe("trace", () => {
  it("is OFF under vitest unless asked for", async () => {
    // The default matters: a unit suite that writes a log file per run leaves
    // rubbish in the user's cache root, and `cacheRoot()` refuses to resolve
    // under vitest anyway (#293).
    delete process.env.AUTOGALLERY_TRACE;
    await startTrace({ dir });
    expect(traceEnabled()).toBe(false);
    expect(trace("http", "done", { s: 200 })).toBe(null);
    expect(traceEntries()).toEqual([]);
  });

  it("keeps events in order and returns them oldest first", async () => {
    await startTrace({ dir });
    trace("http", "done", { s: 200 });
    trace("job", "create", { id: "job-1" });
    const got = traceEntries();
    expect(got.map((e) => e.ev)).toEqual(["done", "create"]);
    expect(got[0].seq).toBe(1);
    expect(got[0].t).toBeGreaterThan(0);
  });

  it("`since` filters by SEQUENCE, not by time", async () => {
    // Two events routinely land in the same millisecond, so a timestamp cursor
    // either re-delivers or skips. This is what a poller uses.
    await startTrace({ dir });
    trace("http", "a");
    trace("http", "b");
    const first = traceEntries();
    trace("http", "c");
    const fresh = traceEntries({ since: first.at(-1).seq });
    expect(fresh.map((e) => e.ev)).toEqual(["c"]);
  });

  it("filters by channel", async () => {
    await startTrace({ dir });
    trace("http", "done");
    trace("loop", "stall", { maxMs: 900 });
    expect(traceEntries({ ch: "loop" }).map((e) => e.ev)).toEqual(["stall"]);
  });

  it("writes NDJSON to disk, one object per line", async () => {
    await startTrace({ dir });
    trace("loop", "stall", { maxMs: 1200 });
    await flushTrace();
    const text = await readFile(tracePath(), "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      ch: "loop",
      ev: "stall",
      maxMs: 1200,
    });
  });

  it("keeps only the most recent runs' logs", async () => {
    // Rotation is by FILE, not by size: one file per run is what makes "the
    // log from the session that broke" a thing you can point at.
    for (const n of ["1", "2", "3", "4", "5", "6", "7"]) {
      await writeFile(join(dir, `trace-2026010${n}-000000.ndjson`), "{}\n");
    }
    await startTrace({ dir });
    trace("app", "start");
    await flushTrace();
    const files = (await readdir(dir)).sort();
    // Five in total, and THIS run's is one of them — so four of the seven
    // survive, not five. Getting that off by one leaves the oldest log alive
    // forever on a machine that is restarted often.
    expect(files).toHaveLength(5);
    expect(files).toContain(tracePath().split("/").pop());
    // The OLDEST are the ones that went.
    expect(files[0]).toBe("trace-20260104-000000.ndjson");
  });

  it("truncates a huge string instead of letting it dominate the log", async () => {
    await startTrace({ dir });
    trace("http", "done", { u: "x".repeat(5000) });
    expect(traceEntries()[0].u.length).toBe(500);
  });

  it("survives a disk it cannot write to, and keeps the ring", async () => {
    // A diagnostic that throws into a request handler is a self-inflicted
    // outage. This is the whole reason the file sink is allowed to fail.
    await startTrace({ dir: join(dir, "nope", "\0bad") });
    trace("http", "done", { s: 200 });
    await expect(flushTrace()).resolves.not.toThrow();
    expect(traceEntries()).toHaveLength(1);
  });

  describe("client events", () => {
    it("keeps the browser's clock separately from the server's", async () => {
      // Skew between the two is exactly what makes an interleaved log lie. The
      // server's receipt time orders the file; the client's own time stays
      // available to compare against it.
      await startTrace({ dir });
      const clientTime = 1000;
      ingestClientTrace([{ ev: "health-timeout", t: clientTime, ms: 4000 }]);
      const [e] = traceEntries();
      expect(e.ch).toBe("ui");
      expect(e.ev).toBe("health-timeout");
      expect(e.ct).toBe(clientTime);
      expect(e.t).toBeGreaterThan(clientTime);
    });

    it("refuses an oversized batch rather than accepting it whole", async () => {
      await startTrace({ dir });
      const many = Array.from({ length: 500 }, (_, i) => ({ ev: `e${i}` }));
      expect(ingestClientTrace(many)).toBe(200);
    });

    it("ignores junk without throwing", async () => {
      await startTrace({ dir });
      expect(ingestClientTrace(null)).toBe(0);
      expect(ingestClientTrace("nope")).toBe(0);
      expect(ingestClientTrace([null, 7, { ev: "ok" }])).toBe(1);
    });

    it("namespaces a client channel so ui and server lines never collide", async () => {
      await startTrace({ dir });
      ingestClientTrace([{ ev: "play", ch: "video", id: 3 }]);
      expect(traceEntries()[0].ch).toBe("ui:video");
    });
  });
});
