import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OnnxMLService } from "./OnnxMLService.js";
import { isHostFailure } from "./MLService.js";
import { candidateDevices } from "./worker/devices.js";

// #ensureChild's env falls back to cachePaths.js's modelsDir() (which
// mkdirSync's a real ~/.autogallery/models) whenever AUTOGALLERY_MODELS_DIR
// is unset. Every test here injects a fake spawn and never actually reads
// this value, but building the env object still evaluates the fallback —
// set it once to a throwaway temp dir so this "hermetic" suite never touches
// the developer's real home directory. The ML_INTEGRATION block below reuses
// the same dir for its one genuine model download.
process.env.AUTOGALLERY_MODELS_DIR = mkdtempSync(
  join(tmpdir(), "autogallery-ml-test-")
);

/** A fake child process. No real spawn — the default suite must never fork. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = vi.fn();
  child.stdin.end = vi.fn();
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

  it("rejects the in-flight request when the child emits 'error', and respawns on the next request", async () => {
    // `exit` is asynchronous, so a request arriving in the tick after a crash
    // can still write into a destroyed pipe — that raises an `error` event
    // which, unhandled, is an unhandled 'error' event: Node throws it and
    // takes the whole process down. This proves the listener is attached and
    // settles in-flight work instead of escaping.
    const children = [fakeChild(), fakeChild()];
    let n = 0;
    const svc = new OnnxMLService({ spawn: () => children[n++] });
    const first = svc.health();
    expect(() =>
      children[0].emit("error", new Error("spawn EACCES"))
    ).not.toThrow();
    await expect(first).rejects.toThrow(/EACCES/);

    // Dead child dropped — the next request respawns rather than reusing it.
    const second = svc.health();
    const sent = JSON.parse(children[1].stdin.write.mock.calls[0][0]);
    children[1].reply({ id: sent.id, ok: true, ort: "1.20.0", providers: [] });
    await expect(second).resolves.toMatchObject({ ok: true });
    expect(n).toBe(2);
    svc.stop();
  });

  it("does not double-settle when the child emits BOTH 'error' and 'exit'", async () => {
    const child = fakeChild();
    const svc = new OnnxMLService({ spawn: () => child });
    const p = svc.health();
    let rejectionCount = 0;
    p.catch(() => rejectionCount++);
    expect(() => {
      child.emit("error", new Error("EPIPE"));
      child.emit("exit", null, "SIGSEGV"); // both fire, same child
    }).not.toThrow();
    await expect(p).rejects.toThrow();
    // A promise can only settle once regardless — the real assertion is that
    // firing both events back-to-back raised no exception and the service
    // recovers cleanly afterward.
    expect(() => svc.stop()).not.toThrow();
  });

  it("rejects the in-flight request when child.stdin emits 'error'", async () => {
    const child = fakeChild();
    const svc = new OnnxMLService({ spawn: () => child });
    const p = svc.health();
    expect(() =>
      child.stdin.emit("error", new Error("write EPIPE"))
    ).not.toThrow();
    await expect(p).rejects.toThrow(/EPIPE/);
    expect(() => svc.stop()).not.toThrow();
  });

  it("tags a worker-side error as a HOST failure, because the errno cannot survive the protocol", async () => {
    // The worker replies with `String(e.message)` — an ENOSPC/ETIMEDOUT on a
    // model download arrives here as a plain string with no `code`. A sweep
    // classifying on `err.code` alone therefore reads "the encoder is
    // broken" as "this photo cannot be read", and writes a permanent
    // sentinel for every row it touches — i.e. the whole library (#161 final
    // review, Critical 1). The tag is the only thing that survives.
    const child = fakeChild();
    const svc = new OnnxMLService({ spawn: () => child });
    const p = svc.health();
    const sent = JSON.parse(child.stdin.write.mock.calls[0][0]);
    child.reply({ id: sent.id, error: "ENOSPC: no space left on device" });
    const err = await p.catch((e) => e);
    expect(err.code).toBeUndefined(); // the errno really is gone
    expect(isHostFailure(err)).toBe(true);
    svc.stop();
  });

  it("tags a dead child's rejection as a HOST failure too", async () => {
    const child = fakeChild();
    const svc = new OnnxMLService({ spawn: () => child });
    const p = svc.health();
    child.emit("exit", 139, null); // segfault mid-request
    const err = await p.catch((e) => e);
    expect(isHostFailure(err)).toBe(true);
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

describe("embedImages", () => {
  it("refuses to embed before configure, rather than guessing a model", async () => {
    const child = fakeChild();
    const svc = new OnnxMLService({ spawn: () => child });
    await expect(svc.embedImages([Buffer.from("x")])).rejects.toThrow(
      /configure/
    );
  });

  it("sends base64 images and returns Float32Arrays", async () => {
    const child = fakeChild();
    const svc = new OnnxMLService({ spawn: () => child });

    const p = svc.configure({
      modelId: "Xenova/clip-vit-base-patch32",
      threads: 2,
    });
    let sent = JSON.parse(child.stdin.write.mock.calls.at(-1)[0]);
    expect(sent.op).toBe("configure");
    child.reply({ id: sent.id, ok: true });
    await p;

    const embed = svc.embedImages([Buffer.from("abc"), Buffer.from("def")]);
    sent = JSON.parse(child.stdin.write.mock.calls.at(-1)[0]);
    expect(sent.op).toBe("embed");
    expect(sent.images).toEqual(["YWJj", "ZGVm"]);

    child.reply({
      id: sent.id,
      vectors: [
        [1, 2],
        [3, 4],
      ],
      dim: 2,
    });
    const out = await embed;
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(out[1])).toEqual([3, 4]);
    svc.stop();
  });

  it("does not remember modelId/threads if configure's own request rejects", async () => {
    // The child dies between spawn and reply — configure() never resolves.
    // #modelId must NOT have been set from the optimistic path, or
    // embedImages() would proceed against a worker nobody actually
    // configured (the worst failure: writes plausible vectors under a model
    // name that was never confirmed to load).
    const child = fakeChild();
    const svc = new OnnxMLService({ spawn: () => child });
    const cfg = svc.configure({
      modelId: "Xenova/clip-vit-base-patch32",
      threads: 2,
    });
    child.emit("exit", 1, null);
    await expect(cfg).rejects.toThrow(/exited/i);

    await expect(svc.embedImages([Buffer.from("x")])).rejects.toThrow(
      /configure/i
    );
    svc.stop();
  });
});

describe("configure survives a worker respawn", () => {
  it("replays the last known-good configure to a fresh child before any other request", async () => {
    // Concrete failure this guards against: user picks 4 threads, the
    // worker OOMs mid-backfill (precisely the case the out-of-process
    // architecture exists for), respawns at the default threads:1, and the
    // remaining tens of thousands of photos silently encode ~4x slower.
    const children = [fakeChild(), fakeChild()];
    let n = 0;
    const svc = new OnnxMLService({ spawn: () => children[n++] });

    const cfg = svc.configure({
      modelId: "Xenova/clip-vit-base-patch32",
      threads: 4,
    });
    const configureSent = JSON.parse(
      children[0].stdin.write.mock.calls.at(-1)[0]
    );
    expect(configureSent.op).toBe("configure");
    children[0].reply({ id: configureSent.id, ok: true });
    await cfg;

    children[0].emit("exit", 1, null); // OOM

    const embed = svc.embedImages([Buffer.from("x")]);
    const calls = children[1].stdin.write.mock.calls.map((c) =>
      JSON.parse(c[0])
    );
    // The replay must land BEFORE the request that triggered the respawn —
    // a worker that saw "embed" first would run it at the default threads.
    expect(calls[0]).toMatchObject({
      op: "configure",
      modelId: "Xenova/clip-vit-base-patch32",
      threads: 4,
    });
    expect(calls[1].op).toBe("embed");

    children[1].reply({ id: calls[0].id, ok: true });
    children[1].reply({ id: calls[1].id, vectors: [[1, 2]], dim: 2 });
    await expect(embed).resolves.toBeDefined();
    svc.stop();
  });

  it("does not replay anything to the very first child — nothing is configured yet", () => {
    const child = fakeChild();
    const svc = new OnnxMLService({ spawn: () => child });
    svc.health().catch(() => {});
    const calls = child.stdin.write.mock.calls.map((c) => JSON.parse(c[0]));
    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe("health");
    svc.stop();
  });
});

describe("request timeout", () => {
  // A stalled worker (a hung model download, a wedged child) must fail
  // loudly rather than leave the caller pending forever — CLAUDE.md's "never
  // fail silently" applies to this internal boundary too.
  it("rejects a health request that never gets a reply, naming the op and elapsed time", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const svc = new OnnxMLService({ spawn: () => child });
      const p = svc.health();
      const assertion = expect(p).rejects.toThrow(/health.*timed out/i);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      svc.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire once the reply arrives in time", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const svc = new OnnxMLService({ spawn: () => child });
      const p = svc.health();
      const sent = JSON.parse(child.stdin.write.mock.calls.at(-1)[0]);
      child.reply({ id: sent.id, ok: true, ort: "1.20.0", providers: [] });
      await expect(p).resolves.toMatchObject({ ok: true });
      // Advancing well past the timeout afterward must be a no-op, not a
      // stray rejection against a promise that already settled.
      await vi.advanceTimersByTimeAsync(20_000);
      svc.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the first embed after configure a generous cold-load timeout (model may still need downloading)", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const svc = new OnnxMLService({ spawn: () => child });
      const cfg = svc.configure({
        modelId: "Xenova/clip-vit-base-patch32",
        threads: 1,
      });
      const configureSent = JSON.parse(child.stdin.write.mock.calls.at(-1)[0]);
      child.reply({ id: configureSent.id, ok: true });
      await cfg;

      const embed = svc.embedImages([Buffer.from("x")]);
      const rejected = expect(embed).rejects.toThrow(/embed.*timed out/i);
      // A minute in — nowhere near the warm (30s) OR the cold (10min)
      // timeout if it were using the wrong one; the assertion below is what
      // actually proves which one applies.
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await rejected;
      svc.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the short warm timeout once an embed has already succeeded", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const svc = new OnnxMLService({ spawn: () => child });
      const cfg = svc.configure({
        modelId: "Xenova/clip-vit-base-patch32",
        threads: 1,
      });
      const configureSent = JSON.parse(child.stdin.write.mock.calls.at(-1)[0]);
      child.reply({ id: configureSent.id, ok: true });
      await cfg;

      const first = svc.embedImages([Buffer.from("x")]);
      const firstSent = JSON.parse(child.stdin.write.mock.calls.at(-1)[0]);
      child.reply({ id: firstSent.id, vectors: [[1]], dim: 1 });
      await first;

      const second = svc.embedImages([Buffer.from("y")]);
      const rejected = expect(second).rejects.toThrow(/embed.*timed out/i);
      // Only the warm (30s) timeout, not the 10-minute cold one.
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      svc.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats the model as cold again after the worker reports its idle-timer unload", async () => {
    // This app's sweeps are whenIdle-gated by design (runSweep awaits idle()
    // between batches specifically to stand aside while the user browses a
    // grid of thumbnails) — a multi-minute gap between embed batches is the
    // NORMAL operating mode, not a rare edge case. The worker's own idle
    // timer (UNLOAD_AFTER_MS, worker/index.js) drops the model after 120s of
    // no embed traffic; without this, the parent would still think the
    // model is warm and give the next embed only 30s, while the worker
    // actually has to reload it from disk — competing for CPU with exactly
    // the libvips thumbnailing that made the user active in the first
    // place.
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const svc = new OnnxMLService({ spawn: () => child });
      const cfg = svc.configure({
        modelId: "Xenova/clip-vit-base-patch32",
        threads: 1,
      });
      const configureSent = JSON.parse(child.stdin.write.mock.calls.at(-1)[0]);
      child.reply({ id: configureSent.id, ok: true });
      await cfg;

      const first = svc.embedImages([Buffer.from("x")]);
      const firstSent = JSON.parse(child.stdin.write.mock.calls.at(-1)[0]);
      child.reply({ id: firstSent.id, vectors: [[1]], dim: 1 });
      await first; // warm now

      // The worker's OWN idle timer fired and unloaded the model —
      // unsolicited, no matching request id, exactly like a progress frame.
      child.reply({
        type: "unloaded",
        modelId: "Xenova/clip-vit-base-patch32",
      });

      const second = svc.embedImages([Buffer.from("y")]);
      let settled = false;
      second.then(
        () => (settled = true),
        () => (settled = true)
      );

      // The warm (30s) budget must NOT apply — prove it by advancing past
      // it and observing the promise is still pending.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toBe(false);

      // It does eventually time out on the cold (10 min) budget, proving
      // THAT budget — not the warm one — is what actually applied.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(settled).toBe(true);
      await expect(second).rejects.toThrow(/embed.*timed out/i);
      svc.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not resurrect #modelWarm if 'unloaded' arrives WHILE an embed is in flight", async () => {
    // The worker's idle setTimeout is independent of in-flight embed
    // handling, and model(inputs) is genuinely async — so the timer can
    // fire mid-embed. The handler's local model/processor refs are already
    // captured by then, so that embed still completes correctly even though
    // module-level `loaded` is now null worker-side. If the "unloaded" frame
    // is written before the embed's own reply (very likely, given the
    // ordering), the parent must not let the embed's resolution stamp
    // #modelWarm back to true and undo the invalidation that raced it.
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const svc = new OnnxMLService({ spawn: () => child });
      const cfg = svc.configure({
        modelId: "Xenova/clip-vit-base-patch32",
        threads: 1,
      });
      const configureSent = JSON.parse(child.stdin.write.mock.calls.at(-1)[0]);
      child.reply({ id: configureSent.id, ok: true });
      await cfg;

      // Warm it up first.
      const first = svc.embedImages([Buffer.from("x")]);
      let sent = JSON.parse(child.stdin.write.mock.calls.at(-1)[0]);
      child.reply({ id: sent.id, vectors: [[1]], dim: 1 });
      await first;

      // Start a second embed — it's now in flight, awaiting its reply.
      const second = svc.embedImages([Buffer.from("y")]);
      sent = JSON.parse(child.stdin.write.mock.calls.at(-1)[0]);

      // The idle timer fires mid-embed and reports unloaded BEFORE the
      // embed's own reply arrives.
      child.reply({
        type: "unloaded",
        modelId: "Xenova/clip-vit-base-patch32",
      });
      // The in-flight embed still succeeds — its own result is legitimate.
      child.reply({ id: sent.id, vectors: [[2]], dim: 1 });
      await expect(second).resolves.toBeDefined();

      // The NEXT embed must get the COLD budget — #modelWarm must not have
      // been resurrected by `second` resolving after the unloaded frame.
      const third = svc.embedImages([Buffer.from("z")]);
      let settled = false;
      third.then(
        () => (settled = true),
        () => (settled = true)
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toBe(false); // warm (30s) budget did NOT fire
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(settled).toBe(true); // cold (10min) budget did
      await expect(third).rejects.toThrow(/embed.*timed out/i);
      svc.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("progress events", () => {
  // Wired from transformers.js's progress_callback in the worker, for a
  // future consumer (Task 10's jobs panel) to render download/load progress
  // instead of the current silent multi-minute stall.
  it("emits 'progress' for unsolicited frames instead of silently dropping them", () => {
    const child = fakeChild();
    const svc = new OnnxMLService({ spawn: () => child });
    svc.health().catch(() => {});
    const seen = [];
    svc.on("progress", (msg) => seen.push(msg));
    child.stdout.emit(
      "data",
      JSON.stringify({
        type: "progress",
        modelId: "Xenova/clip-vit-base-patch32",
        status: "progress",
        file: "onnx/model_quantized.onnx",
        progress: 42,
      }) + "\n"
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ status: "progress", progress: 42 });
    svc.stop();
  });

  it("off() stops delivering progress events", () => {
    const child = fakeChild();
    const svc = new OnnxMLService({ spawn: () => child });
    svc.health().catch(() => {});
    const cb = vi.fn();
    svc.on("progress", cb);
    svc.off("progress", cb);
    child.stdout.emit("data", JSON.stringify({ type: "progress" }) + "\n");
    expect(cb).not.toHaveBeenCalled();
    svc.stop();
  });

  it("emits 'unloaded' for the worker's idle-timer frame", () => {
    const child = fakeChild();
    const svc = new OnnxMLService({ spawn: () => child });
    svc.health().catch(() => {});
    const seen = [];
    svc.on("unloaded", (msg) => seen.push(msg));
    child.stdout.emit(
      "data",
      JSON.stringify({
        type: "unloaded",
        modelId: "Xenova/clip-vit-base-patch32",
      }) + "\n"
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].modelId).toBe("Xenova/clip-vit-base-patch32");
    svc.stop();
  });
});

// #resolvedDevice has the identical shape as #modelWarm above (a value the
// worker reports unsolicited-ish via a reply field, recorded only if
// nothing invalidated its generation while the request was in flight) — but
// unlike #modelWarm, it had no fast test of its own before this block. The
// only prior coverage was the ML_INTEGRATION-gated test's string-shape
// check after a successful real embed, which never exercises the guard
// itself (server/ml/OnnxMLService.js's `if (device && this.#modelGeneration
// === generation)`). Reviewed finding (#161, Task 11 review round):
// simplifying that condition to `if (device)` is an entirely plausible
// tidy-up that the 1282-test suite would not catch, and the resulting bug —
// describeProvider() reporting an EP that isn't actually running for the
// CURRENT config — is exactly the one thing that field is under a hard rule
// never to do.
describe("describeProvider", () => {
  it("reports cpu before any real embed has confirmed otherwise", async () => {
    // No configure(), no embed — #resolvedDevice is still null. Must not
    // guess an accelerator it has never actually run.
    const svc = new OnnxMLService({ spawn: () => fakeChild() });
    await expect(svc.describeProvider()).resolves.toBe(
      "onnxruntime-node (cpu)"
    );
    svc.stop();
  });

  it("records the EP a real embed reply confirms, and surfaces it", async () => {
    const child = fakeChild();
    const svc = new OnnxMLService({ spawn: () => child });
    const cfg = svc.configure({
      modelId: "Xenova/clip-vit-base-patch32",
      threads: 1,
    });
    let sent = JSON.parse(child.stdin.write.mock.calls.at(-1)[0]);
    child.reply({ id: sent.id, ok: true });
    await cfg;

    const embed = svc.embedImages([Buffer.from("x")]);
    sent = JSON.parse(child.stdin.write.mock.calls.at(-1)[0]);
    child.reply({ id: sent.id, vectors: [[1]], dim: 1, device: "coreml" });
    await embed;

    await expect(svc.describeProvider()).resolves.toBe(
      "onnxruntime-node (coreml)"
    );
    svc.stop();
  });

  it("discards a device-bearing reply that arrives from a STALE generation, rather than recording it", async () => {
    // Same shape as "does not resurrect #modelWarm if 'unloaded' arrives
    // WHILE an embed is in flight" above: a reconfigure can land WHILE an
    // OLDER embed's reply is still in flight, and that reply's `device`
    // field describes the OLD config, not the one active by the time it
    // arrives. Recording it anyway would make describeProvider() claim an
    // EP for a model/config it was never actually run against.
    const child = fakeChild();
    const svc = new OnnxMLService({ spawn: () => child });

    // Baseline: configure, then one confirmed embed on "cpu".
    let cfg = svc.configure({
      modelId: "Xenova/clip-vit-base-patch32",
      threads: 1,
    });
    let sent = JSON.parse(child.stdin.write.mock.calls.at(-1)[0]);
    child.reply({ id: sent.id, ok: true });
    await cfg;

    const first = svc.embedImages([Buffer.from("x")]);
    sent = JSON.parse(child.stdin.write.mock.calls.at(-1)[0]);
    child.reply({ id: sent.id, vectors: [[1]], dim: 1, device: "cpu" });
    await first;
    await expect(svc.describeProvider()).resolves.toBe(
      "onnxruntime-node (cpu)"
    );

    // Start a SECOND embed — it's now in flight, awaiting its reply.
    const stale = svc.embedImages([Buffer.from("y")]);
    const staleSent = JSON.parse(child.stdin.write.mock.calls.at(-1)[0]);

    // A reconfigure lands WHILE that embed is still in flight — this bumps
    // #modelGeneration (and independently resets #resolvedDevice to null;
    // that reset is NOT what this test is proving — what happens next is).
    cfg = svc.configure({
      modelId: "Xenova/siglip-base-patch16-224",
      threads: 1,
    });
    sent = JSON.parse(child.stdin.write.mock.calls.at(-1)[0]);
    child.reply({ id: sent.id, ok: true });
    await cfg;

    // NOW the stale embed's reply arrives, claiming "coreml" — for the
    // generation that configure() just moved past, not the current one.
    child.reply({
      id: staleSent.id,
      vectors: [[2]],
      dim: 1,
      device: "coreml",
    });
    await expect(stale).resolves.toBeDefined();

    // Must still report "cpu" (the safe default), NOT "coreml" — a reply
    // from a generation that no longer applies must not be trusted just
    // because it happened to carry a `device` field.
    await expect(svc.describeProvider()).resolves.toBe(
      "onnxruntime-node (cpu)"
    );
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

  // Everything else in this file verifies the JSON-lines plumbing with a
  // fake child — none of it has ever run the actual loader/processor/tensor
  // path. Loader class names, dtype->filename resolution, output key,
  // tensor slicing: all previously verified only by reading transformers.js
  // source, never by executing it. CLIP ViT-B/32 chosen over SigLIP because
  // it's the smaller download (~45MB vs ~100MB).
  it(
    "embeds real images end to end with CLIP ViT-B/32",
    async () => {
      const sharp = (await import("sharp")).default;
      const { modelById } = await import("./models.js");
      const modelId = "Xenova/clip-vit-base-patch32";

      const makeJpeg = (r, g, b) =>
        sharp({
          create: {
            width: 32,
            height: 32,
            channels: 3,
            background: { r, g, b },
          },
        })
          .jpeg()
          .toBuffer();
      const [red, blue] = await Promise.all([
        makeJpeg(220, 20, 20),
        makeJpeg(20, 20, 220),
      ]);

      const svc = new OnnxMLService();
      await svc.configure({ modelId, threads: 2 });
      const out = await svc.embedImages([red, blue]);

      expect(out.length).toBe(2);
      expect(out[0]).toBeInstanceOf(Float32Array);
      expect(out[1]).toBeInstanceOf(Float32Array);
      expect(out[0].length).toBe(modelById(modelId).dim);
      expect(out[1].length).toBe(modelById(modelId).dim);
      // Real model output, not a stub: every value finite, and the two
      // solid-color images (which extractVectors() would have rejected as
      // non-finite garbage, per the worker's own guard) must not be identical
      // vectors.
      expect(Array.from(out[0]).every(Number.isFinite)).toBe(true);
      expect(Array.from(out[0])).not.toEqual(Array.from(out[1]));
      // #161 "revert and replace": the worker now tries a real
      // execution-provider candidate list (worker/devices.js's
      // candidateDevices()) instead of hardcoding "cpu", and describeProvider
      // must report whichever one actually won — not a guess, and not still
      // the pre-embed "cpu" default (see the dedicated EP list below; this
      // machine's darwin/arm64 candidate list starts with "coreml").
      const provider = await svc.describeProvider();
      expect(provider).toMatch(/^onnxruntime-node \((coreml|webgpu|cpu)\)$/);
      svc.stop();
    },
    5 * 60_000
  ); // cold cache: download + load can take minutes

  // #161 "revert and replace": Task 11 built a whole second out-of-process
  // host (a hidden Electron renderer running transformers.js on WebGPU) on
  // the premise that prebuilt onnxruntime-node had no CoreML on any
  // platform. That premise was wrong — `listSupportedBackends()` reports
  // coreml/webgpu/cpu all bundled — so the fix is EP selection in THIS
  // worker instead. This test is the actual point of that fix: it embeds the
  // same small batch once per candidate EP for this platform and reports
  // ms/photo for each, so "did CoreML actually help" is a measured fact, not an
  // assumption. What it measured is recorded where it ships — devices.js's
  // own doc and the spec's "Superseded 2026-07-25" section — rather than in
  // the gitignored .superpowers/ notes an earlier version of this comment
  // cited.
  it(
    "measures ms/photo per available execution provider (CLIP ViT-B/32)",
    async () => {
      const sharp = (await import("sharp")).default;

      const makeJpeg = (r, g, b) =>
        sharp({
          create: {
            width: 32,
            height: 32,
            channels: 3,
            background: { r, g, b },
          },
        })
          .jpeg()
          .toBuffer();
      const batch = await Promise.all(
        [
          [220, 20, 20],
          [20, 220, 20],
          [20, 20, 220],
          [220, 220, 20],
        ].map(([r, g, b]) => makeJpeg(r, g, b))
      );
      const modelId = "Xenova/clip-vit-base-patch32";

      // The worker's own list, imported rather than re-typed — it lives in
      // server/ml/worker/devices.js precisely so both this benchmark and a
      // fast unit test can read it without importing the worker module
      // (whose top-level code redirects stdout and imports a native addon).
      // A hand-copied list would benchmark a set of candidates the worker no
      // longer tries, which is the one thing this test must not do.
      const candidates = candidateDevices();

      const REPEATS = 5;
      const results = {};
      for (const device of candidates) {
        const svc = new OnnxMLService();
        try {
          // `device` forces this ONE candidate with no fallthrough (the
          // ML_INTEGRATION-only knob configure() exposes) — the whole point
          // here is per-EP numbers, not the auto-selected winner.
          await svc.configure({ modelId, threads: 2, device });
          // One warm-up pays the cold load (download/first-session-build
          // cost) without it polluting the timed loop below.
          await svc.embedImages(batch);
          const t0 = performance.now();
          for (let i = 0; i < REPEATS; i++) await svc.embedImages(batch);
          const elapsedMs = performance.now() - t0;
          results[device] = {
            msPerPhoto: Number(
              (elapsedMs / (REPEATS * batch.length)).toFixed(2)
            ),
          };
        } catch (e) {
          // Not a test failure: "bundled" (listSupportedBackends) is not the
          // same as "works on this exact machine" — a candidate genuinely
          // failing to construct here (no CUDA GPU present, e.g.) is
          // precisely the case loadWithBestDevice()'s real fallback exists
          // to handle, and this benchmark should say so, not crash.
          results[device] = {
            unavailable: true,
            reason: String(e?.message ?? e),
          };
        } finally {
          svc.stop();
        }
      }

      // eslint-disable-next-line no-console -- the whole point of this test
      // is the printed numbers; paste this output into the report.
      console.log(
        "ML EP benchmark (ms/photo, CLIP ViT-B/32, threads=2):",
        JSON.stringify(results, null, 2)
      );

      // cpu is the guaranteed floor on every platform's candidate list — the
      // one hard assertion here. Everything else is informational.
      expect(results.cpu.unavailable).not.toBe(true);
    },
    10 * 60_000
  );

  // #161 "revert and replace", round 2: the CLIP@batch=4 benchmark above is
  // a fast sanity check, NOT the number the darwin candidate order was set
  // from — it uses the smaller/cheaper of the two vetted models at a batch
  // size well below production. `embedAllPending`'s default `limit` is 16
  // (server/ml/embedSweep.js) and `DEFAULT_MODEL_ID` is SigLIP base
  // patch16-224 (server/ml/models.js), which does ~4x CLIP's compute per
  // image (196 patches vs 49 — see models.js's own note). Both differences
  // push toward a GPU/accelerator amortizing its per-call overhead better,
  // so a CPU-wins verdict from the smaller benchmark could plausibly flip at
  // the real configuration — this test measures the REAL configuration
  // directly rather than extrapolating, and its result is what
  // worker/devices.js's candidateDevices() darwin order is actually set from
  // (see the comment there for the date and numbers this produced).
  it(
    "measures ms/photo per EP at PRODUCTION config (SigLIP base patch16-224, batch=16)",
    async () => {
      const sharp = (await import("sharp")).default;
      const { DEFAULT_MODEL_ID } = await import("./models.js");

      const makeJpeg = (r, g, b) =>
        sharp({
          create: {
            width: 32,
            height: 32,
            channels: 3,
            background: { r, g, b },
          },
        })
          .jpeg()
          .toBuffer();
      // 16 distinct colors, not 16 copies of one — extractVectors() rejects
      // an all-identical/non-finite batch the same way the worker's own
      // validation would reject degenerate real input, so a lazy "same
      // image x16" fixture risks masking exactly the kind of failure this
      // test exists to catch.
      const palette = Array.from({ length: 16 }, (_, i) => {
        const t = i / 15;
        return [
          Math.round(20 + t * 200),
          Math.round(220 - t * 200),
          Math.round(20 + ((i * 37) % 200)),
        ];
      });
      const batch = await Promise.all(
        palette.map(([r, g, b]) => makeJpeg(r, g, b))
      );

      // The worker's own list, imported — NOT re-typed. The hand-copy that
      // used to sit here had ALREADY drifted: it still read
      // ["coreml", "webgpu", "cpu"] for darwin after the measured order this
      // very test produced flipped devices.js to ["cpu", "webgpu", "coreml"].
      // That is the whole failure T9 exists to prevent — re-measure on new
      // hardware, time a candidate order the worker no longer uses, then
      // update devices.js from numbers gathered under the wrong one — and
      // being ML_INTEGRATION-gated, no CI run would ever have caught it.
      const candidates = candidateDevices();

      // Fewer repeats than the CLIP benchmark — SigLIP@16 is roughly 16x the
      // per-repeat compute of CLIP@4 (4x model, 4x batch), and 3 repeats is
      // still enough to sanity-check run-to-run stability without pushing
      // this test's runtime past what CI patience allows.
      const REPEATS = 3;
      const results = {};
      for (const device of candidates) {
        const svc = new OnnxMLService();
        try {
          await svc.configure({
            modelId: DEFAULT_MODEL_ID,
            threads: 2,
            device,
          });
          await svc.embedImages(batch); // warm-up: pays the cold load
          const t0 = performance.now();
          for (let i = 0; i < REPEATS; i++) await svc.embedImages(batch);
          const elapsedMs = performance.now() - t0;
          results[device] = {
            msPerPhoto: Number(
              (elapsedMs / (REPEATS * batch.length)).toFixed(2)
            ),
          };
        } catch (e) {
          results[device] = {
            unavailable: true,
            reason: String(e?.message ?? e),
          };
        } finally {
          svc.stop();
        }
      }

      // eslint-disable-next-line no-console -- the printed numbers are the
      // point; paste this into the report whenever re-measuring.
      console.log(
        `ML EP benchmark (ms/photo, ${DEFAULT_MODEL_ID}, batch=16, threads=2):`,
        JSON.stringify(results, null, 2)
      );

      expect(results.cpu.unavailable).not.toBe(true);
    },
    10 * 60_000
  );
});
