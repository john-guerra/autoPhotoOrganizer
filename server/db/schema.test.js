import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";

describe("applySchema — EXIF columns", () => {
  it("adds the EXIF columns and is idempotent", () => {
    const db = new Database(":memory:");
    applySchema(db);
    applySchema(db); // second run must not throw (idempotent ADD COLUMN)
    const cols = db
      .prepare("PRAGMA table_info(photos)")
      .all()
      .map((c) => c.name);
    for (const c of ["aperture", "shutter", "iso", "focal_length", "lens"]) {
      expect(cols).toContain(c);
    }
  });
});

/** Insert one photo row directly, bypassing upsertScan. */
function addPhoto(
  db,
  { filename, contentHash = null, attempted = 0, stale = 0 }
) {
  db.prepare(
    `INSERT INTO folders (abs_path, volume_id, last_scanned_at)
     VALUES ('/vol/photos', NULL, 0) ON CONFLICT(abs_path) DO NOTHING`
  ).run();
  const folderId = db
    .prepare(`SELECT id FROM folders WHERE abs_path = '/vol/photos'`)
    .get().id;
  db.prepare(
    `INSERT INTO photos (folder_id, filename, size, mtime, kind, stale,
                         content_hash, hash_attempted)
     VALUES (?, ?, 1, 1, 'image', ?, ?, ?)`
  ).run(folderId, filename, stale, contentHash, attempted);
}

describe("the #169 hash_attempted repair", () => {
  it("clears the marker on rows poisoned by an unmount", () => {
    const db = new Database(":memory:");
    applySchema(db);
    addPhoto(db, { filename: "POISONED.JPG", attempted: 1 });
    db.pragma("user_version = 0"); // pretend this db predates the repair
    applySchema(db);
    expect(
      db.prepare(`SELECT hash_attempted FROM photos`).get().hash_attempted
    ).toBe(0);
  });

  it("leaves an already-hashed row alone", () => {
    const db = new Database(":memory:");
    applySchema(db);
    addPhoto(db, { filename: "OK.JPG", contentHash: "abc", attempted: 1 });
    db.pragma("user_version = 0");
    applySchema(db);
    const row = db.prepare(`SELECT * FROM photos`).get();
    expect(row.content_hash).toBe("abc");
    expect(row.hash_attempted).toBe(1);
  });

  it("leaves a stale row alone", () => {
    const db = new Database(":memory:");
    applySchema(db);
    addPhoto(db, { filename: "STALE.JPG", attempted: 1, stale: 1 });
    db.pragma("user_version = 0");
    applySchema(db);
    expect(
      db.prepare(`SELECT hash_attempted FROM photos`).get().hash_attempted
    ).toBe(1);
  });

  it("runs EXACTLY ONCE — a later applySchema does not re-clear a fresh mark", () => {
    // Without the user_version gate this is the bug the repair would CREATE:
    // applySchema runs on every startup, so a genuinely corrupt file marked by
    // the FIXED code would be un-marked and re-attempted on every launch,
    // forever. That is the spin the sentinel exists to prevent.
    const db = new Database(":memory:");
    applySchema(db); // repair runs here, user_version -> 1
    addPhoto(db, { filename: "TRULY_CORRUPT.JPG", attempted: 1 });
    applySchema(db); // a later startup
    expect(
      db.prepare(`SELECT hash_attempted FROM photos`).get().hash_attempted
    ).toBe(1);
  });
});
