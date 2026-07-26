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

/** A stub MLService. The suite NEVER loads a model or spawns anything. */
function stubMl({ failOn = () => false, dim = 512 } = {}) {
  const seen = [];
  return {
    seen,
    configure: vi.fn().mockResolvedValue({ ok: true }),
    embedImages: vi.fn(async (buffers) => {
      seen.push(buffers.length);
      return buffers.map((b) => {
        if (failOn(b)) throw new Error("model refused this image");
        return Float32Array.from({ length: dim }, (_, i) => Math.sin(b[0] + i));
      });
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
    await rm(dir, { recursive: true, force: true });
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
    const opts = {
      ml: stubMl(),
      processing: stubProcessing(),
      model: MODEL,
      idle: async () => {},
    };
    const [first, second] = await Promise.all([
      embedAllPending(db, opts),
      embedAllPending(db, opts),
    ]);
    expect([first.alreadyRunning, second.alreadyRunning]).toContain(true);
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
