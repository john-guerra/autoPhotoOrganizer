import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "../db/connection.js";
import { upsertScan } from "../db/photos.js";
import { facesFor, faceCounts, pendingFaceRows } from "../db/faces.js";
import { sweepFaces, isTransient } from "./faceSweep.js";
import { Scheduler, PRIORITY, RESOURCE } from "../pipeline/scheduler.js";

const MODEL = "buffalo_s";
let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-fsweep-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
  getDb()
    .prepare(
      `INSERT INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
       VALUES (1, 'v', 'u', '/test', ?)`
    )
    .run(Date.now());
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

/** Seed photos in a folder that really exists, since runSweep probes
 *  reachability of the folder before deciding a failure is permanent. */
function seed(db, n) {
  const files = Array.from({ length: n }, (_, i) => ({
    name: `IMG_${i}.jpg`,
    size: 1000 + i,
    mtimeMs: 1700000000000 + i,
    kind: "image",
  }));
  return upsertScan(db, cacheDir, 1, files).map((r) => r.id);
}

function vector(seedVal) {
  const v = new Float32Array(512);
  for (let i = 0; i < 512; i++) v[i] = Math.sin(i * 0.1 + seedVal);
  return v;
}

/** An engine that returns a scripted result (or throws) per filename. */
function engineOf(script) {
  const seen = [];
  return {
    seen,
    async detect(row) {
      seen.push(row.filename);
      const r = script[row.filename] ?? { faces: [], skipped: 0 };
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

const oneFace = {
  faces: [{ box: [1, 2, 30, 40], score: 0.9, vector: vector(1) }],
  skipped: 0,
};

describe("draining the face backlog", () => {
  it("stores what it finds and empties the worklist", async () => {
    const db = getDb();
    const ids = seed(db, 3);
    const engine = engineOf({
      "IMG_0.jpg": oneFace,
      "IMG_1.jpg": { faces: [], skipped: 0 }, // a landscape
      "IMG_2.jpg": oneFace,
    });

    const r = await sweepFaces({ db, modelId: MODEL, engine });

    expect(r.paused).toBe(false);
    expect(r.done).toBe(3);
    expect(r.faces).toBe(2);
    expect(pendingFaceRows(db, MODEL, 10)).toEqual([]);
    expect(facesFor(db, ids[0], MODEL)).toHaveLength(1);
    expect(facesFor(db, ids[1], MODEL)).toHaveLength(0);
  });

  it("terminates rather than spinning when a batch reports nothing", async () => {
    // runSweep does `done += await process(batch)`. A process() that returns
    // undefined makes `done` NaN, every comparison against it false, and the
    // drain never ends -- silently, at full CPU. This is the regression guard.
    const db = getDb();
    seed(db, 12); // more than one FACE_BATCH
    const r = await sweepFaces({
      db,
      modelId: MODEL,
      engine: engineOf({}),
    });
    expect(Number.isFinite(r.done)).toBe(true);
    expect(r.done).toBe(12);
  }, 10_000);

  it("counts a scanned landscape as done, not as having a face", async () => {
    // TIMEOUT IS PART OF THE ASSERTION. Without the zero-face sentinel this
    // does not fail -- it spins forever at full CPU, because runSweep's stall
    // guard only catches rows that were marked FAILED, and these come back
    // merely unprocessed. A 10s cap turns a hang into a red test.
    const db = getDb();
    seed(db, 4);
    await sweepFaces({ db, modelId: MODEL, engine: engineOf({}) });

    const c = faceCounts(db, MODEL);
    expect(c.scanned).toBe(4);
    expect(c.withFaces).toBe(0);
    expect(c.total - c.scanned - c.failed).toBe(0); // nothing left pending
  }, 10_000);

  it("quantizes to the int8 contract storage expects", async () => {
    const db = getDb();
    const [id] = seed(db, 1);
    await sweepFaces({
      db,
      modelId: MODEL,
      engine: engineOf({ "IMG_0.jpg": oneFace }),
    });

    const [f] = facesFor(db, id, MODEL);
    expect(f.dim).toBe(512);
    expect(f.scale).toBeGreaterThan(0);
    expect(f.bytes).toBeInstanceOf(Int8Array);
    expect(f.bytes).toHaveLength(512);
  });

  it("resumes where it stopped rather than restarting", async () => {
    // The worklist IS the resume point -- a crash costs one batch, not the
    // backlog. Same property embeddings rely on.
    const db = getDb();
    seed(db, 10);
    const first = engineOf({});
    await sweepFaces({ db, modelId: MODEL, engine: first });

    const second = engineOf({});
    const r = await sweepFaces({ db, modelId: MODEL, engine: second });
    expect(r.done).toBe(0);
    expect(second.seen).toEqual([]); // nothing re-examined
  });
});

describe("scoping the sweep (#221)", () => {
  // THE SEAM. Every other scope test in this repo checks one end of the wire:
  // `scopeIds.test.js` validates ids, `faces.test.js` calls pendingFaceRows
  // directly, `faceRoutes.test.js` stops at validation (ort is mocked to
  // reject), and the e2e spec never presses the button. Delete `scopeIds` from
  // the nextBatch closure in faceSweep.js and every one of those still passes
  // while the user gets the full-library sweep #221 exists to prevent. This
  // file is the only place that can notice. Mirrors embedSweep.test.js's
  // "embeds only the scoped photos" (#206).

  it("looks at ONLY the scoped photos", async () => {
    const db = getDb();
    const ids = seed(db, 5);
    const engine = engineOf({});

    await sweepFaces({
      db,
      modelId: MODEL,
      engine,
      scopeIds: [ids[1], ids[3]],
    });

    // Asserting on what the ENGINE was asked to look at, not just on counts:
    // that is the thing the user pays for in wall-clock and CPU.
    expect(engine.seen.sort()).toEqual(["IMG_1.jpg", "IMG_3.jpg"]);
    expect(faceCounts(db, MODEL).scanned).toBe(2);
  }, 10_000);

  it("looks at NOTHING for an empty scope, rather than the whole library", async () => {
    // The expensive misreading, at the layer that actually spends the CPU.
    const db = getDb();
    seed(db, 5);
    const engine = engineOf({});

    const r = await sweepFaces({ db, modelId: MODEL, engine, scopeIds: [] });

    expect(engine.seen).toEqual([]);
    expect(r.done).toBe(0);
    expect(faceCounts(db, MODEL).scanned).toBe(0);
  }, 10_000);

  it("sweeps everything when no scope is passed", async () => {
    const db = getDb();
    seed(db, 3);
    const engine = engineOf({});

    await sweepFaces({ db, modelId: MODEL, engine });

    expect(engine.seen).toHaveLength(3);
  }, 10_000);

  it("terminates on a scope whose photos are already scanned", async () => {
    // TIMEOUT IS PART OF THE ASSERTION, as in the landscape test above: a
    // scoped worklist that never empties would spin at full CPU rather than
    // fail. Scanned rows leave the worklist via ml_status regardless of the
    // scope clause, so this must return immediately.
    const db = getDb();
    const ids = seed(db, 3);
    await sweepFaces({ db, modelId: MODEL, engine: engineOf({}) });

    const engine = engineOf({});
    const r = await sweepFaces({ db, modelId: MODEL, engine, scopeIds: ids });

    expect(engine.seen).toEqual([]);
    expect(r.done).toBe(0);
  }, 10_000);
});

describe("classifying a failure", () => {
  it("marks a genuinely unreadable photo failed, and moves on", async () => {
    const db = getDb();
    const ids = seed(db, 3);
    const engine = engineOf({
      "IMG_1.jpg": new Error("Input buffer contains unsupported image format"),
    });

    const r = await sweepFaces({ db, modelId: MODEL, engine });

    expect(r.paused).toBe(false);
    expect(r.failed).toBe(1);
    expect(r.done).toBe(3);
    // The bad file left the worklist; the good ones were still processed.
    expect(pendingFaceRows(db, MODEL, 10)).toEqual([]);
    expect(faceCounts(db, MODEL)).toMatchObject({ scanned: 2, failed: 1 });
    expect(facesFor(db, ids[2], MODEL)).toBeDefined();
  });

  it("PAUSES on a host failure instead of blaming the photos", async () => {
    // A missing model tells us nothing about the photo. Marking one failed is
    // a false statement that outlives its cause, because sentinels only clear
    // when a file's bytes change -- which is how #169 excluded a whole
    // unplugged drive from hashing forever.
    const db = getDb();
    seed(db, 3);
    const engine = engineOf({
      "IMG_0.jpg": new Error(
        "The recognizer for buffalo_s does not match its expected checksum"
      ),
    });

    const r = await sweepFaces({ db, modelId: MODEL, engine });

    expect(r.paused).toBe(true);
    expect(r.pauseReason).toMatch(/checksum/);
    expect(r.failed).toBe(0);
    // Nothing was marked -- every photo is still pending for the next attempt.
    expect(pendingFaceRows(db, MODEL, 10)).toHaveLength(3);
    expect(faceCounts(db, MODEL).failed).toBe(0);
  });

  it("treats model, session and download errors as the moment's fault", () => {
    for (const m of [
      "does not match its expected checksum",
      "arrived incomplete (4 of 8 bytes)",
      "Couldn't download the detector",
      "ENOENT: no such file or directory",
      "worker exited before replying",
      "onnxruntime: failed to create session",
      "out of memory",
    ]) {
      expect(isTransient(new Error(m)), m).toBe(true);
    }
  });

  it("treats an unreadable image as the PHOTO's fault", () => {
    // The converse matters as much: if everything were transient, a genuinely
    // corrupt file would pause the sweep forever and the backlog never drains.
    for (const m of [
      "Input buffer contains unsupported image format",
      "VipsJpeg: Premature end of JPEG file",
      "unsupported colour space",
    ]) {
      expect(isTransient(new Error(m)), m).toBe(false);
    }
  });
});

describe("a scoped request preempts the background sweep (#279)", () => {
  /** Next macrotask, so a parked checkpoint gets a chance to settle. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("runs the scoped request instead of refusing it", async () => {
    const db = getDb();
    const ids = seed(db, 40); // 5 batches at FACE_BATCH=8
    const s = new Scheduler();
    // Slow enough that the background run is genuinely mid-sweep when the
    // scoped one arrives — otherwise this passes for the wrong reason.
    const slow = {
      async detect() {
        await settle();
        return { faces: [], skipped: 0 };
      },
    };

    const bg = s.submit({
      priority: PRIORITY.BACKGROUND,
      body: ({ checkpoint }) =>
        sweepFaces({ db, modelId: MODEL, engine: slow, checkpoint }),
    });
    await settle();
    await settle();

    const scoped = s.submit({
      priority: PRIORITY.SCOPED,
      body: ({ checkpoint }) =>
        sweepFaces({
          db,
          modelId: MODEL,
          engine: slow,
          checkpoint,
          scopeIds: [ids[39]],
        }),
    });

    const [, sc] = await Promise.all([bg, scoped]);

    // The whole of #279: the scheduler promoted this run, and the sweep's own
    // single-flight latch — still held by the run the scheduler just PARKED —
    // refused it anyway. The user presses the button and nothing happens.
    expect(sc.alreadyRunning).toBeUndefined();
    expect(sc.done).toBe(1);
  });
  it("two equal-priority sweeps take turns instead of overlapping", async () => {
    // The half of the deleted latch that was RIGHT. Priority only parks a
    // strictly LOWER-priority run, so two scoped requests are invisible to it;
    // without the lease both would proceed, both read the same pending rows,
    // and the second putFaces would overwrite the first's — twice the cost of
    // the slowest thing this app does, for nothing.
    const db = getDb();
    seed(db, 24);
    const s = new Scheduler();
    let concurrent = 0;
    let peak = 0;
    const engine = {
      async detect() {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await settle();
        concurrent--;
        return { faces: [], skipped: 0 };
      },
    };
    const run = () =>
      s.submit({
        priority: PRIORITY.SCOPED,
        resource: RESOURCE.ONNX,
        body: ({ checkpoint }) =>
          sweepFaces({ db, modelId: MODEL, engine, checkpoint }),
      });

    await Promise.all([run(), run()]);

    expect(peak).toBe(1);
  });
});
