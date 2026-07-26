import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "../db/connection.js";
import { upsertScan } from "../db/photos.js";
import {
  embedCounts,
  pendingEmbedRows,
  getEmbedding,
} from "../db/embeddings.js";
import {
  embedAllPending,
  embedProgress,
  _resetEmbedSweepForTest,
} from "./embedSweep.js";

const MODEL = "Xenova/clip-vit-base-patch32";
let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-sweep-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
  _resetEmbedSweepForTest();
  // better-sqlite3 enforces foreign keys by default (PRAGMA foreign_keys=1),
  // so folders.volume_id = 1 needs a real volumes row to point at — the same
  // seed embeddings.test.js / hashing.test.js use ahead of their own
  // upsertScan calls with volumeId 1.
  const db = getDb();
  db.prepare(
    `INSERT INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
     VALUES (1, 'test-volume', 'test-uuid-1', '/test', ?)`
  ).run(Date.now());
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

function seed(db, n, folder = "/vol/Trip") {
  return upsertScan(
    db,
    folder,
    1,
    Array.from({ length: n }, (_, i) => ({
      name: `IMG_${i}.jpg`,
      size: 1000 + i,
      mtimeMs: 1700000000000 + i,
      kind: "image",
    }))
  ).map((r) => r.id);
}

/**
 * A stub MLService. The suite NEVER loads a model or spawns anything.
 * `zeroFor(buffer)` lets one test target a specific photo's OUTPUT with an
 * all-zero-magnitude vector — quantize() throws on that shape (see
 * server/ml/quantize.js) — without touching the others in the same batch.
 */
function stubMl({ zeroFor = () => false, dim = 512 } = {}) {
  const seen = [];
  return {
    seen,
    configure: vi.fn().mockResolvedValue({ ok: true }),
    embedImages: vi.fn(async (buffers) => {
      seen.push(buffers.length);
      return buffers.map((b) =>
        zeroFor(b)
          ? new Float32Array(dim) // all zero -> quantize() throws
          : Float32Array.from({ length: dim }, (_, i) => Math.sin(b[0] + i))
      );
    }),
  };
}

/** A stub ProcessingService whose thumbnails are one identifying byte. */
function stubProcessing({ failFor = () => null } = {}) {
  return {
    thumbnail: vi.fn(async (path) => {
      const err = failFor(path);
      if (err) throw err;
      return { data: Buffer.from([path.length % 251]) };
    }),
    videoThumb: vi.fn(async () => ({ data: Buffer.from([7]) })),
  };
}

/**
 * A stub ProcessingService whose thumbnail byte is the file's own numeric
 * index (decoded from its `IMG_<n>.jpg` name), not its path length.
 * stubProcessing's path-length byte can't distinguish IMG_0..IMG_9 in this
 * file — the paths are all the same length — so tests that need to target
 * ONE specific photo's buffer content (the zero-vector and wrong-dimension
 * cases below) use this instead.
 */
function stubIndexedProcessing() {
  return {
    thumbnail: vi.fn(async (path) => {
      const m = /IMG_(\d+)\.jpg$/.exec(path);
      return { data: Buffer.from([Number(m[1])]) };
    }),
    videoThumb: vi.fn(async () => ({ data: Buffer.from([7]) })),
  };
}

describe("embedAllPending", () => {
  it("drains the whole library to zero pending", async () => {
    const db = getDb();
    seed(db, 7);

    const r = await embedAllPending(db, {
      ml: stubMl(),
      processing: stubProcessing(),
      model: MODEL,
      limit: 3,
      idle: async () => {},
    });

    expect(r).toMatchObject({ embedded: 7, failed: 0, paused: false });
    expect(pendingEmbedRows(db, MODEL, 10)).toEqual([]);
    expect(embedCounts(db, MODEL)).toEqual({
      total: 7,
      embedded: 7,
      failed: 0,
    });
  });

  it("writes vectors of the model's dimension", async () => {
    const db = getDb();
    const [id] = seed(db, 1);
    await embedAllPending(db, {
      ml: stubMl(),
      processing: stubProcessing(),
      model: MODEL,
      idle: async () => {},
    });

    const got = getEmbedding(db, id, MODEL);
    expect(got.dim).toBe(512);
    expect(got.bytes).toHaveLength(512);
  });

  it("batches rather than embedding one photo at a time", async () => {
    const db = getDb();
    seed(db, 6);
    const ml = stubMl();
    await embedAllPending(db, {
      ml,
      processing: stubProcessing(),
      model: MODEL,
      limit: 3,
      idle: async () => {},
    });
    expect(ml.seen).toEqual([3, 3]);
  });

  it("isolates a poison photo, sentinels it, and still drains", async () => {
    const db = getDb();
    // runSweep's failure classifier checks reachable(folderOf(row)) BEFORE
    // anything else (server/ml/sweep.js) — a fictional folder path like
    // "/vol/Trip" fails that stat and every per-file error would be
    // misread as "the whole drive went away" (a false #169 pause). A REAL
    // folder is required here so the failure genuinely isolates to the one
    // poisoned file, the way hashing.test.js's equivalent case does.
    const dir = await mkdtemp(join(tmpdir(), "ag-poison-"));
    try {
      const ids = seed(db, 4, dir);
      const bad = join(dir, "IMG_2.jpg");

      const r = await embedAllPending(db, {
        ml: stubMl(),
        processing: stubProcessing({
          failFor: (p) => (p === bad ? new Error("corrupt jpeg") : null),
        }),
        model: MODEL,
        limit: 4,
        idle: async () => {},
      });

      expect(r.embedded).toBe(3);
      expect(r.failed).toBe(1);
      expect(pendingEmbedRows(db, MODEL, 10)).toEqual([]);
      expect(embedCounts(db, MODEL).failed).toBe(1);
      expect(ids).toHaveLength(4);
    } finally {
      // try/finally, not a trailing statement: a failed assertion above must
      // not leave ag-poison-* dirs behind in tmpdir on every red run.
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("routes a zero-magnitude vector to the failure sentinel, not a crash", async () => {
    const db = getDb();
    const dir = await mkdtemp(join(tmpdir(), "ag-zero-"));
    try {
      seed(db, 4, dir);
      // IMG_2's thumbnail byte is 2 (stubIndexedProcessing) — the stub ml
      // returns an all-zero vector only for that one image, so quantize()
      // throws for exactly this row (server/ml/quantize.js) and nothing
      // else. This is a DIFFERENT failure path than the poison-photo test
      // above: there the read fails (thumbBytes throws), here the read
      // succeeds and the MODEL's output is what's unusable.
      const ml = stubMl({ zeroFor: (b) => b[0] === 2 });

      const r = await embedAllPending(db, {
        ml,
        processing: stubIndexedProcessing(),
        model: MODEL,
        limit: 4,
        idle: async () => {},
      });

      expect(r.embedded).toBe(3);
      expect(r.failed).toBe(1);
      expect(pendingEmbedRows(db, MODEL, 10)).toEqual([]);
      expect(embedCounts(db, MODEL).failed).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sentinels a photo whose model returned the wrong vector dimension", async () => {
    const db = getDb();
    const dir = await mkdtemp(join(tmpdir(), "ag-dim-"));
    try {
      seed(db, 3, dir); // IMG_0, IMG_1, IMG_2 -> thumbnail bytes 0, 1, 2
      const ml = stubMl();
      const realEmbedImages = ml.embedImages;
      // Corrupt only IMG_1's vector length, by BUFFER CONTENT so the
      // corruption still targets IMG_1 however runSweep re-batches it on
      // retry (a full batch, then a singleton). Simulates a host with no
      // shape validation of its own — today's ONNX worker happens to
      // validate (extractVectors in worker/embedOutput.js), but this test's
      // job is to prove embedSweep/quantize catch it independently, so a
      // different host implementation (or a future model swap) can't
      // silently regress this (models.js names this exact hazard: "a model
      // whose output shape we have not checked writes plausible vectors of
      // the wrong dimension").
      ml.embedImages = vi.fn(async (buffers) => {
        const vectors = await realEmbedImages(buffers);
        return vectors.map((v, i) =>
          buffers[i][0] === 1 ? v.slice(0, 10) : v
        );
      });

      const r = await embedAllPending(db, {
        ml,
        processing: stubIndexedProcessing(),
        model: MODEL,
        limit: 3,
        idle: async () => {},
      });

      expect(r.embedded).toBe(2);
      expect(r.failed).toBe(1);
      expect(embedCounts(db, MODEL).failed).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("PAUSES and marks NOTHING when the folder is unreachable", async () => {
    const db = getDb();
    seed(db, 3, "/vol/Gone");
    const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });

    const r = await embedAllPending(db, {
      ml: stubMl(),
      processing: stubProcessing({ failFor: () => enoent }),
      model: MODEL,
      idle: async () => {},
    });

    // #169's lesson: an unmount is a property of the MOMENT. Marking here is
    // what excluded a whole drive from hashing forever.
    expect(r.paused).toBe(true);
    expect(embedCounts(db, MODEL).failed).toBe(0);
    expect(pendingEmbedRows(db, MODEL, 10)).toHaveLength(3);
  });

  it("is single-flight — a second scan must not start a second sweep", async () => {
    const db = getDb();
    seed(db, 2);
    const ml = stubMl();
    const opts = {
      ml,
      processing: stubProcessing(),
      model: MODEL,
      idle: async () => {},
    };
    const [first, second] = await Promise.all([
      embedAllPending(db, opts),
      embedAllPending(db, opts),
    ]);
    expect([first.alreadyRunning, second.alreadyRunning]).toContain(true);
    // 2 photos at the default limit (16) is exactly one batch. Without this,
    // the test above passes as long as EITHER call short-circuits — it
    // can't tell "the loser did no work" from "the loser did the work
    // twice". One call proves the loser touched the encoder zero times.
    expect(ml.embedImages).toHaveBeenCalledTimes(1);
  });

  it("releases the single-flight latch even when ml.configure rejects", async () => {
    const db = getDb();
    seed(db, 1);
    const brokenMl = stubMl();
    brokenMl.configure = vi.fn().mockRejectedValue(new Error("worker died"));

    await expect(
      embedAllPending(db, {
        ml: brokenMl,
        processing: stubProcessing(),
        model: MODEL,
        idle: async () => {},
      })
    ).rejects.toThrow("worker died");

    // Deliberately NOT calling _resetEmbedSweepForTest() here — that is
    // exactly the property under test. embedAllPending's own `finally` is
    // what has to release the latch; if a refactor ever hoists it out (an
    // easy slip — see hashing.js's two statements between its latch set and
    // its try), this second call would return { alreadyRunning: true }
    // forever and wedge embedding for the rest of the app session with no
    // error anywhere.
    const workingMl = stubMl();
    const r = await embedAllPending(db, {
      ml: workingMl,
      processing: stubProcessing(),
      model: MODEL,
      idle: async () => {},
    });
    expect(r.alreadyRunning).toBeUndefined();
    expect(r.embedded).toBeGreaterThan(0);
  });

  it("configures the service with the active model before embedding", async () => {
    const db = getDb();
    seed(db, 1);
    const ml = stubMl();
    await embedAllPending(db, {
      ml,
      processing: stubProcessing(),
      model: MODEL,
      threads: 4,
      idle: async () => {},
    });
    expect(ml.configure).toHaveBeenCalledWith({ modelId: MODEL, threads: 4 });
  });

  it("stops when the job is canceled", async () => {
    const db = getDb();
    seed(db, 20);
    const controller = new AbortController();
    const job = { controller };

    const p = embedAllPending(db, {
      ml: stubMl(),
      processing: stubProcessing(),
      model: MODEL,
      limit: 2,
      job,
      idle: async () => controller.abort(),
    });

    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("embedProgress", () => {
  it("reports embedded separately from failed", () => {
    expect(embedProgress({ done: 100, failed: 3 })).toEqual({
      done: 97,
      phase: "97 embedded · 3 failed",
    });
  });

  it("omits the failure clause when there are none", () => {
    expect(embedProgress({ done: 5, failed: 0 }).phase).toBe("5 embedded");
  });
});
