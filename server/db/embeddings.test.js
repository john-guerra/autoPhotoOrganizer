import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan, resetLibrary, deletePhotosByIds } from "./photos.js";
import { quantize } from "../ml/quantize.js";
import {
  putEmbedding,
  putEmbeddings,
  getEmbedding,
  pendingEmbedRows,
  embedCounts,
  markEmbedFailed,
  clearMlArtifactsFor,
  clearEmbedFailures,
  modelStorage,
  purgeModel,
} from "./embeddings.js";

const SIGLIP = "Xenova/siglip-base-patch16-224";
const CLIP = "Xenova/clip-vit-base-patch32";
let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-embed-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
  // better-sqlite3 enforces foreign keys by default (PRAGMA foreign_keys=1),
  // so folders.volume_id = 1 needs a real volumes row to point at — the same
  // seed photos.test.js / hashing.test.js use ahead of their own upsertScan
  // calls with volumeId 1.
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

/** Three photos in one folder. Returns their ids in filename order. */
function seed(db, n = 3) {
  const files = Array.from({ length: n }, (_, i) => ({
    name: `IMG_${i}.jpg`,
    size: 1000 + i,
    mtimeMs: 1700000000000 + i,
    kind: "image",
  }));
  return upsertScan(db, "/vol/Trip", 1, files).map((r) => r.id);
}

function vec(seed, n = 8) {
  return Float32Array.from({ length: n }, (_, i) => Math.sin(seed + i));
}

describe("embeddings storage", () => {
  it("round-trips a vector through the BLOB", () => {
    const db = getDb();
    const [id] = seed(db);
    const { scale, bytes } = quantize(vec(1));

    putEmbedding(db, { photoId: id, model: SIGLIP, dim: 8, scale, bytes });
    const got = getEmbedding(db, id, SIGLIP);

    expect(got.dim).toBe(8);
    expect(got.scale).toBeCloseTo(scale, 10);
    expect(Array.from(got.bytes)).toEqual(Array.from(bytes));
    expect(got.bytes).toBeInstanceOf(Int8Array);
  });

  it("keeps two models' vectors for the same photo side by side", () => {
    const db = getDb();
    const [id] = seed(db);
    const a = quantize(vec(1));
    const b = quantize(vec(2));

    putEmbedding(db, { photoId: id, model: SIGLIP, dim: 8, ...a });
    putEmbedding(db, { photoId: id, model: CLIP, dim: 8, ...b });

    expect(Array.from(getEmbedding(db, id, SIGLIP).bytes)).toEqual(
      Array.from(a.bytes)
    );
    expect(Array.from(getEmbedding(db, id, CLIP).bytes)).toEqual(
      Array.from(b.bytes)
    );
  });

  it("returns null for a photo with no embedding under that model", () => {
    const db = getDb();
    const [id] = seed(db);
    expect(getEmbedding(db, id, SIGLIP)).toBeNull();
  });

  it("re-embedding the same photo+model replaces rather than duplicating", () => {
    const db = getDb();
    const [id] = seed(db);
    putEmbedding(db, {
      photoId: id,
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });
    const second = quantize(vec(9));
    putEmbedding(db, { photoId: id, model: SIGLIP, dim: 8, ...second });

    expect(Array.from(getEmbedding(db, id, SIGLIP).bytes)).toEqual(
      Array.from(second.bytes)
    );
    expect(embedCounts(db, SIGLIP).embedded).toBe(1);
  });
});

describe("the worklist", () => {
  it("returns photos with no embedding for the active model", () => {
    const db = getDb();
    const ids = seed(db);
    expect(
      pendingEmbedRows(db, SIGLIP, 10)
        .map((r) => r.id)
        .sort()
    ).toEqual([...ids].sort());
  });

  it("drops a photo once it is embedded", () => {
    const db = getDb();
    const ids = seed(db);
    putEmbedding(db, {
      photoId: ids[0],
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });

    expect(pendingEmbedRows(db, SIGLIP, 10).map((r) => r.id)).not.toContain(
      ids[0]
    );
  });

  it("drops a photo once it is marked failed — the property runSweep needs", () => {
    const db = getDb();
    const ids = seed(db);
    markEmbedFailed(db, ids[0], SIGLIP, new Error("corrupt jpeg"));

    // runSweep's stall guard THROWS if a markFailed row comes back. This is
    // that guarantee, asserted where it is cheap to test.
    expect(pendingEmbedRows(db, SIGLIP, 10).map((r) => r.id)).not.toContain(
      ids[0]
    );
  });

  it("still offers a photo that failed under a DIFFERENT model", () => {
    const db = getDb();
    const ids = seed(db);
    markEmbedFailed(db, ids[0], CLIP, new Error("corrupt jpeg"));

    expect(pendingEmbedRows(db, SIGLIP, 10).map((r) => r.id)).toContain(ids[0]);
  });

  it("never offers a RAW file — there is no image this app can read for one", () => {
    const db = getDb();
    upsertScan(db, "/vol/Raw", 1, [
      { name: "A.jpg", size: 10, mtimeMs: 1700000000000, kind: "image" },
      { name: "B.CR3", size: 20, mtimeMs: 1700000000001, kind: "raw" },
      { name: "C.MOV", size: 30, mtimeMs: 1700000000002, kind: "video" },
    ]);

    // thumbBytes has exactly two branches (video -> videoThumb, everything
    // else -> thumbnail), and thumbnail() throws RawDecodeUnavailableError
    // for RAW BY DESIGN (NodeProcessingService). Offering one means a
    // permanent "tried, and could not be read" sentinel for every RAW file
    // in the library — which would also survive the day a real RAW decoder
    // lands, since only a byte change clears a sentinel.
    const names = pendingEmbedRows(db, SIGLIP, 10).map((r) => r.filename);
    expect(names).toEqual(expect.arrayContaining(["A.jpg", "C.MOV"]));
    expect(names).not.toContain("B.CR3");
  });

  it("leaves RAW out of the counts too, so 'not computed yet' can reach zero", () => {
    const db = getDb();
    upsertScan(db, "/vol/Raw", 1, [
      { name: "A.jpg", size: 10, mtimeMs: 1700000000000, kind: "image" },
      { name: "B.CR3", size: 20, mtimeMs: 1700000000001, kind: "raw" },
    ]);
    // If `total` counted the RAW file the panel would show a permanent
    // one-photo shortfall that no sweep can ever close — the unexplained-
    // remainder shape this layer exists to prevent.
    expect(embedCounts(db, SIGLIP).total).toBe(1);
  });

  it("excludes stale rows", () => {
    const db = getDb();
    seed(db, 3);
    // A rescan that finds only one file marks the other two stale.
    upsertScan(db, "/vol/Trip", 1, [
      { name: "IMG_0.jpg", size: 1000, mtimeMs: 1700000000000, kind: "image" },
    ]);
    expect(pendingEmbedRows(db, SIGLIP, 10)).toHaveLength(1);
  });

  it("carries everything thumbCachePath and runSweep need", () => {
    const db = getDb();
    seed(db, 1);
    const [row] = pendingEmbedRows(db, SIGLIP, 10);

    expect(row).toMatchObject({
      folder_abs_path: "/vol/Trip",
      filename: "IMG_0.jpg",
      kind: "image",
    });
    expect(typeof row.mtime).toBe("number");
    expect(typeof row.size).toBe("number");
  });

  it("honours the limit", () => {
    const db = getDb();
    seed(db, 5);
    expect(pendingEmbedRows(db, SIGLIP, 2)).toHaveLength(2);
  });
});

describe("counts and storage reporting", () => {
  it("reports embedded and failed separately from total", () => {
    const db = getDb();
    const ids = seed(db, 4);
    putEmbedding(db, {
      photoId: ids[0],
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });
    markEmbedFailed(db, ids[1], SIGLIP, new Error("nope"));

    // "12,431 of 114,125 embedded, 37 failed" must be reportable. Pending is
    // total - embedded - failed, and it must NOT read as an unexplained
    // shortfall — that is the specific way pre-2.17.14 backupCoverage misled.
    expect(embedCounts(db, SIGLIP)).toEqual({
      total: 4,
      embedded: 1,
      failed: 1,
    });
  });

  it("bumps attempts rather than duplicating on a repeat failure", () => {
    const db = getDb();
    const [id] = seed(db);
    markEmbedFailed(db, id, SIGLIP, new Error("first"));
    markEmbedFailed(db, id, SIGLIP, new Error("second"));

    expect(embedCounts(db, SIGLIP).failed).toBe(1);
    const row = db
      .prepare(`SELECT attempts, error FROM ml_status WHERE photo_id = ?`)
      .get(id);
    expect(row.attempts).toBe(2);
    expect(row.error).toBe("second");
  });

  it("clears a prior failure sentinel once the retry succeeds (#161 fix round 2, I2)", () => {
    const db = getDb();
    const [id] = seed(db, 1);
    markEmbedFailed(db, id, SIGLIP, new Error("first try"));
    putEmbedding(db, {
      photoId: id,
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });

    // A successful vector makes the old "cannot be processed" sentinel a lie.
    // Without putEmbedding clearing it, this photo would count as BOTH
    // embedded and failed, and total - embedded - failed (the UI's "pending")
    // would go negative — the same unexplained-shortfall shape pre-2.17.14
    // backupCoverage shipped.
    const counts = embedCounts(db, SIGLIP);
    expect(counts).toEqual({ total: 1, embedded: 1, failed: 0 });
    expect(
      counts.total - counts.embedded - counts.failed
    ).toBeGreaterThanOrEqual(0);
    expect(
      db.prepare(`SELECT * FROM ml_status WHERE photo_id = ?`).get(id)
    ).toBeUndefined();
  });

  it("reports per-model storage so the settings panel can offer a purge", () => {
    const db = getDb();
    const ids = seed(db, 2);
    putEmbedding(db, {
      photoId: ids[0],
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });
    putEmbedding(db, {
      photoId: ids[1],
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(2)),
    });
    putEmbedding(db, {
      photoId: ids[0],
      model: CLIP,
      dim: 8,
      ...quantize(vec(3)),
    });

    const byModel = Object.fromEntries(
      modelStorage(db).map((m) => [m.model, m])
    );
    expect(byModel[SIGLIP].rows).toBe(2);
    expect(byModel[CLIP].rows).toBe(1);
    expect(byModel[SIGLIP].bytes).toBeGreaterThan(0);
  });

  it("purges one model without touching another", () => {
    const db = getDb();
    const [id] = seed(db);
    putEmbedding(db, {
      photoId: id,
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });
    putEmbedding(db, { photoId: id, model: CLIP, dim: 8, ...quantize(vec(2)) });

    expect(purgeModel(db, CLIP)).toEqual({ rows: 1 });
    expect(getEmbedding(db, id, CLIP)).toBeNull();
    expect(getEmbedding(db, id, SIGLIP)).not.toBeNull();
  });
});

describe("clearEmbedFailures", () => {
  it("puts every failed photo back in the worklist, for that model only", () => {
    const db = getDb();
    const ids = seed(db, 3);
    markEmbedFailed(db, ids[0], SIGLIP, new Error("host down"));
    markEmbedFailed(db, ids[1], SIGLIP, new Error("host down"));
    markEmbedFailed(db, ids[2], CLIP, new Error("corrupt"));

    expect(clearEmbedFailures(db, SIGLIP)).toEqual({ cleared: 2 });
    expect(embedCounts(db, SIGLIP).failed).toBe(0);
    expect(pendingEmbedRows(db, SIGLIP, 10).map((r) => r.id)).toEqual(
      expect.arrayContaining([ids[0], ids[1]])
    );
    // The other model's record is untouched — the button says "retry the
    // failures for THIS model", and clearing more than that would silently
    // re-run work the user never asked for.
    expect(embedCounts(db, CLIP).failed).toBe(1);
  });

  it("keeps the vectors — this retries failures, it does not undo work", () => {
    const db = getDb();
    const ids = seed(db, 2);
    putEmbedding(db, {
      photoId: ids[0],
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });
    markEmbedFailed(db, ids[1], SIGLIP, new Error("host down"));

    clearEmbedFailures(db, SIGLIP);

    expect(getEmbedding(db, ids[0], SIGLIP)).not.toBeNull();
    expect(embedCounts(db, SIGLIP).embedded).toBe(1);
  });

  it("is a no-op with nothing to clear", () => {
    const db = getDb();
    seed(db, 1);
    expect(clearEmbedFailures(db, SIGLIP)).toEqual({ cleared: 0 });
  });
});

describe("putEmbeddings (batch)", () => {
  it("writes a whole batch in one transaction", () => {
    const db = getDb();
    const ids = seed(db, 3);
    putEmbeddings(
      db,
      ids.map((id, i) => ({
        photoId: id,
        model: SIGLIP,
        dim: 8,
        ...quantize(vec(i)),
      }))
    );
    expect(embedCounts(db, SIGLIP).embedded).toBe(3);
  });

  it("writes nothing if one row in the batch is invalid", () => {
    const db = getDb();
    const ids = seed(db, 2);
    expect(() =>
      putEmbeddings(db, [
        { photoId: ids[0], model: SIGLIP, dim: 8, ...quantize(vec(1)) },
        { photoId: ids[1], model: SIGLIP, dim: 8, scale: 0.1, bytes: null },
      ])
    ).toThrow();
    expect(embedCounts(db, SIGLIP).embedded).toBe(0);
  });
});

describe("clearMlArtifactsFor", () => {
  it("removes vectors AND sentinels for the given photos, across models", () => {
    const db = getDb();
    const ids = seed(db, 2);
    putEmbedding(db, {
      photoId: ids[0],
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });
    putEmbedding(db, {
      photoId: ids[0],
      model: CLIP,
      dim: 8,
      ...quantize(vec(2)),
    });
    markEmbedFailed(db, ids[0], SIGLIP, new Error("x"));
    putEmbedding(db, {
      photoId: ids[1],
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(3)),
    });

    clearMlArtifactsFor(db, [ids[0]]);

    expect(getEmbedding(db, ids[0], SIGLIP)).toBeNull();
    expect(getEmbedding(db, ids[0], CLIP)).toBeNull();
    expect(embedCounts(db, SIGLIP).failed).toBe(0);
    expect(getEmbedding(db, ids[1], SIGLIP)).not.toBeNull();
  });

  it("is a no-op for an empty list", () => {
    const db = getDb();
    const [id] = seed(db);
    putEmbedding(db, {
      photoId: id,
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });
    clearMlArtifactsFor(db, []);
    expect(getEmbedding(db, id, SIGLIP)).not.toBeNull();
  });
});

// better-sqlite3 enables PRAGMA foreign_keys by default, and both
// photo_embeddings and ml_status carry `photo_id INTEGER REFERENCES
// photos(id)`. Every existing `DELETE FROM photos` path (resetLibrary,
// deleteFolder(Subtree), deletePhotosByIds, missing.js relocateMissing) would
// throw the moment a photo had a vector or a sentinel, unless the child row
// is declared ON DELETE CASCADE (see schema.js). These tests are the tier
// that would have caught that gap; each was verified red-then-green against
// the CASCADE fix (see task-5-report.md, "Fix round 1").
describe("ON DELETE CASCADE from photos (#161 fix round 1)", () => {
  it("lets a photo with an embedding be deleted, taking the vector with it", () => {
    const db = getDb();
    const [id] = seed(db, 1);
    putEmbedding(db, {
      photoId: id,
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });

    expect(() => deletePhotosByIds(db, [id])).not.toThrow();
    expect(
      db.prepare(`SELECT * FROM photo_embeddings WHERE photo_id = ?`).get(id)
    ).toBeUndefined();
  });

  it("lets a photo with an ml_status sentinel be deleted, taking the sentinel with it", () => {
    const db = getDb();
    const [id] = seed(db, 1);
    markEmbedFailed(db, id, SIGLIP, new Error("corrupt jpeg"));

    expect(() => deletePhotosByIds(db, [id])).not.toThrow();
    expect(
      db.prepare(`SELECT * FROM ml_status WHERE photo_id = ?`).get(id)
    ).toBeUndefined();
  });

  it("resetLibrary succeeds with embeddings and sentinels present, and empties both tables", () => {
    const db = getDb();
    const ids = seed(db, 2);
    putEmbedding(db, {
      photoId: ids[0],
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });
    markEmbedFailed(db, ids[1], SIGLIP, new Error("nope"));

    expect(() => resetLibrary(db)).not.toThrow();
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM photo_embeddings`).get().n
    ).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ml_status`).get().n).toBe(0);
  });
});

// #161 embedSweep review, fix round 1: a photo can be hard-deleted (folder
// removal, resetLibrary, relocateMissing) DURING the seconds-long window
// process() spends generating thumbnails and calling the encoder. markFailed
// is called unwrapped by runSweep (sweep.js), so it must never throw for a
// vanished parent — the sibling hasher's UPDATE-based sentinel is immune to
// this by accident; this one is an INSERT and needed the WHERE EXISTS guard.
describe("markEmbedFailed tolerates a concurrently deleted photo (#161 fix round 1)", () => {
  it("does not throw and writes no sentinel when the photo is already gone", () => {
    const db = getDb();
    const [id] = seed(db, 1);
    deletePhotosByIds(db, [id]);

    expect(() =>
      markEmbedFailed(db, id, SIGLIP, new Error("model refused this image"))
    ).not.toThrow();
    expect(
      db.prepare(`SELECT * FROM ml_status WHERE photo_id = ?`).get(id)
    ).toBeUndefined();
  });
});

describe("rescan invalidation", () => {
  const file = (over = {}) => ({
    name: "IMG_0.jpg",
    size: 1000,
    mtimeMs: 1700000000000,
    kind: "image",
    ...over,
  });

  it("drops the vector when the file's mtime changed", () => {
    const db = getDb();
    const [id] = upsertScan(db, "/vol/Trip", 1, [file()]).map((r) => r.id);
    putEmbedding(db, {
      photoId: id,
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });

    upsertScan(db, "/vol/Trip", 1, [file({ mtimeMs: 1800000000000 })]);

    expect(getEmbedding(db, id, SIGLIP)).toBeNull();
  });

  it("drops the vector when the file's size changed", () => {
    const db = getDb();
    const [id] = upsertScan(db, "/vol/Trip", 1, [file()]).map((r) => r.id);
    putEmbedding(db, {
      photoId: id,
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });

    upsertScan(db, "/vol/Trip", 1, [file({ size: 2000 })]);

    expect(getEmbedding(db, id, SIGLIP)).toBeNull();
  });

  it("drops a stale failure sentinel too, so a fixed file is retried", () => {
    const db = getDb();
    const [id] = upsertScan(db, "/vol/Trip", 1, [file()]).map((r) => r.id);
    markEmbedFailed(db, id, SIGLIP, new Error("corrupt"));

    upsertScan(db, "/vol/Trip", 1, [file({ mtimeMs: 1800000000000 })]);

    // #169's shape: a sentinel nothing ever clears excludes the photo forever.
    expect(pendingEmbedRows(db, SIGLIP, 10).map((r) => r.id)).toContain(id);
  });

  it("KEEPS the vector when nothing about the file changed", () => {
    const db = getDb();
    const [id] = upsertScan(db, "/vol/Trip", 1, [file()]).map((r) => r.id);
    putEmbedding(db, {
      photoId: id,
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });

    // An ordinary rescan of an unchanged library must not throw away hours of
    // embedding work.
    upsertScan(db, "/vol/Trip", 1, [file()]);

    expect(getEmbedding(db, id, SIGLIP)).not.toBeNull();
  });

  it("keeps other photos' vectors when one file changed", () => {
    const db = getDb();
    const rows = upsertScan(db, "/vol/Trip", 1, [
      file(),
      file({ name: "IMG_1.jpg", size: 1001 }),
    ]);
    for (const r of rows) {
      putEmbedding(db, {
        photoId: r.id,
        model: SIGLIP,
        dim: 8,
        ...quantize(vec(r.id)),
      });
    }

    upsertScan(db, "/vol/Trip", 1, [
      file({ mtimeMs: 1800000000000 }),
      file({ name: "IMG_1.jpg", size: 1001 }),
    ]);

    expect(getEmbedding(db, rows[0].id, SIGLIP)).toBeNull();
    expect(getEmbedding(db, rows[1].id, SIGLIP)).not.toBeNull();
  });
});
