import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan, setPhotoRating } from "./photos.js";
import { sameFileCandidates } from "./missing.js";
import { classifyMissing, classifyRow, relocateMissing } from "./missing.js";

let cacheDir;
beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-missing-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
  const db = getDb();
  db.prepare(
    `INSERT INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
     VALUES (1, 'vol-a', 'uuid-a', '/a', ?)`
  ).run(Date.now());
  db.prepare(
    `INSERT INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
     VALUES (2, 'vol-b', 'uuid-b', '/b', ?)`
  ).run(Date.now());
});
afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

const F = { name: "IMG_1.jpg", size: 100, mtimeMs: 1000, kind: "image" };

function rowFor(db, id) {
  return db
    .prepare(
      "SELECT id, content_hash, filename, size, mtime FROM photos WHERE id = ?"
    )
    .get(id);
}

describe("sameFileCandidates", () => {
  it("matches an identical file in another folder by (filename,size,mtime)", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/a/trip", 1, [F]);
    const [b] = upsertScan(db, "/b/backup", 2, [F]);
    const cands = sameFileCandidates(db, rowFor(db, a.id));
    expect(cands.map((c) => c.id)).toEqual([b.id]);
    expect(cands[0]).toMatchObject({ absPath: "/b/backup", volumeId: 2 });
  });

  it("does not match a different file", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/a/trip", 1, [F]);
    upsertScan(db, "/b/other", 2, [{ ...F, name: "OTHER.jpg" }]);
    expect(sameFileCandidates(db, rowFor(db, a.id))).toEqual([]);
  });
});

function staleRow(db, id) {
  return db
    .prepare(
      `SELECT id, content_hash, filename, size, mtime, first_seen_at AS firstSeenAt
         FROM photos WHERE id = ?`
    )
    .get(id);
}
function markStale(db, id) {
  db.prepare("UPDATE photos SET stale = 1 WHERE id = ?").run(id);
}

describe("classify + relocate", () => {
  it("relocateMissing keeps the row id and its rating, removing the dest duplicate", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/a/trip", 1, [F]);
    setPhotoRating(db, a.id, 4);
    markStale(db, a.id); // A vanished from /a/trip
    const [b] = upsertScan(db, "/a/moved", 1, [F]); // reappeared in /a/moved
    const { relocatedId } = relocateMissing(db, a.id, "/a/moved/IMG_1.jpg");
    expect(relocatedId).toBe(a.id); // id stable → FKs/rating survive
    const row = db
      .prepare(
        "SELECT folder_id, filename, stale, rating FROM photos WHERE id = ?"
      )
      .get(a.id);
    const movedFolderId = db
      .prepare("SELECT id FROM folders WHERE abs_path = '/a/moved'")
      .get().id;
    expect(row).toMatchObject({
      folder_id: movedFolderId,
      filename: "IMG_1.jpg",
      stale: 0,
      rating: 4,
    });
    // The freshly-scanned duplicate B is gone (its slot was taken by A).
    expect(
      db.prepare("SELECT id FROM photos WHERE id = ?").get(b.id)
    ).toBeUndefined();
  });

  it("classifies a clean move and auto-relocates it", () => {
    const db = getDb();
    const scanStart = 5000;
    const [a] = upsertScan(db, "/a/trip", 1, [F]);
    markStale(db, a.id);
    // Destination scanned "after" scanStart → new-this-scan.
    const [b] = upsertScan(db, "/a/moved", 1, [F]);
    db.prepare("UPDATE photos SET first_seen_at = ? WHERE id = ?").run(
      6000,
      b.id
    );
    expect(classifyRow(db, staleRow(db, a.id), scanStart).kind).toBe("moved");
    const res = classifyMissing(db, scanStart);
    expect(res).toMatchObject({ autoRelocated: 1, toReview: 0 });
    expect(
      db.prepare("SELECT stale FROM photos WHERE id = ?").get(a.id).stale
    ).toBe(0);
  });

  it("does NOT auto-relocate when a pre-existing backup survives (still covered)", () => {
    const db = getDb();
    const scanStart = 5000;
    const [a] = upsertScan(db, "/a/trip", 1, [F]);
    const [b] = upsertScan(db, "/b/backup", 2, [F]); // pre-existing backup
    db.prepare("UPDATE photos SET first_seen_at = ? WHERE id = ?").run(
      100,
      b.id
    );
    // A ALSO looks like it moved to /a/moved this scan — without the
    // preExisting guard this would be misread as a clean "moved" and
    // auto-relocated, even though B is a standing backup that survives.
    const [c] = upsertScan(db, "/a/moved", 1, [F]);
    db.prepare("UPDATE photos SET first_seen_at = ? WHERE id = ?").run(
      6000,
      c.id
    );
    markStale(db, a.id); // A's copy deleted; B still there
    expect(classifyRow(db, staleRow(db, a.id), scanStart).kind).toBe("covered");
    const res = classifyMissing(db, scanStart);
    expect(res).toMatchObject({ autoRelocated: 0, toReview: 1 });
    expect(
      db.prepare("SELECT stale FROM photos WHERE id = ?").get(a.id).stale
    ).toBe(1);
  });

  it("classifies a truly-gone file (no surviving copy)", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/a/trip", 1, [F]);
    markStale(db, a.id);
    expect(classifyRow(db, staleRow(db, a.id), 0).kind).toBe("gone");
  });

  it("classifies ambiguous when two new-this-scan candidates appear", () => {
    const db = getDb();
    const scanStart = 5000;
    const [a] = upsertScan(db, "/a/trip", 1, [F]);
    markStale(db, a.id);
    const [b] = upsertScan(db, "/a/m1", 1, [F]);
    const [c] = upsertScan(db, "/a/m2", 1, [F]);
    db.prepare("UPDATE photos SET first_seen_at = 6000 WHERE id IN (?, ?)").run(
      b.id,
      c.id
    );
    expect(classifyRow(db, staleRow(db, a.id), scanStart).kind).toBe(
      "ambiguous"
    );
  });
});
