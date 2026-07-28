import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "../db/connection.js";
import { upsertScan } from "../db/photos.js";
import { facesFor, faceCounts, pendingFaceRows } from "../db/faces.js";
import { sweepFaces, isTransient } from "./faceSweep.js";

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
