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

/**
 * Recreate photo_embeddings/ml_status exactly as they shipped in commit
 * c465228 — plain `REFERENCES photos(id)`, no `ON DELETE CASCADE` — and roll
 * user_version back to 1, the version that commit's own repair left behind.
 * This simulates a db that started the app in the window between c465228 and
 * the cascade fix (e126785): a fresh `applySchema(db)` earlier in the test
 * already created the CASCADE-correct tables, so this replaces them with the
 * pre-fix definition before the migration-under-test runs.
 * @param {import("better-sqlite3").Database} db
 */
function makePreCascadeDb(db) {
  db.exec(`DROP TABLE photo_embeddings`);
  db.exec(`DROP TABLE ml_status`);
  db.exec(`
    CREATE TABLE photo_embeddings (
      photo_id   INTEGER NOT NULL REFERENCES photos(id),
      model      TEXT    NOT NULL,
      dim        INTEGER NOT NULL,
      scale      REAL    NOT NULL,
      vec        BLOB    NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (photo_id, model)
    );
    CREATE TABLE ml_status (
      photo_id   INTEGER NOT NULL REFERENCES photos(id),
      stage      TEXT    NOT NULL,
      model      TEXT    NOT NULL,
      state      TEXT    NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 1,
      error      TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (photo_id, stage, model)
    );
  `);
  db.pragma("user_version = 1");
}

describe("the #161 fix-round-2 ML table cascade migration", () => {
  it("adds ON DELETE CASCADE to a pre-cascade db's photo_embeddings and ml_status", () => {
    const db = new Database(":memory:");
    applySchema(db);
    makePreCascadeDb(db);

    applySchema(db); // this is the migration under test: dataVersion 1 < 2

    expect(db.pragma("foreign_key_list(photo_embeddings)")[0].on_delete).toBe(
      "CASCADE"
    );
    expect(db.pragma("foreign_key_list(ml_status)")[0].on_delete).toBe(
      "CASCADE"
    );
  });

  it("lets a photo with an embedding be deleted after the migration, taking the vector with it", () => {
    // The pragma above is how the fix is BUILT; this is what the user gets —
    // "Reset library" / "Remove folder" must not throw FOREIGN KEY constraint
    // failed once a photo it's deleting has a vector.
    const db = new Database(":memory:");
    applySchema(db);
    makePreCascadeDb(db);
    applySchema(db);

    addPhoto(db, { filename: "HAS_EMBEDDING.JPG" });
    const photoId = db
      .prepare(`SELECT id FROM photos WHERE filename = ?`)
      .get("HAS_EMBEDDING.JPG").id;
    db.prepare(
      `INSERT INTO photo_embeddings (photo_id, model, dim, scale, vec, created_at)
       VALUES (?, 'm', 1, 1.0, X'00', 0)`
    ).run(photoId);

    expect(() =>
      db.prepare(`DELETE FROM photos WHERE id = ?`).run(photoId)
    ).not.toThrow();
    expect(
      db
        .prepare(`SELECT * FROM photo_embeddings WHERE photo_id = ?`)
        .get(photoId)
    ).toBeUndefined();
  });

  it("runs EXACTLY ONCE — a later applySchema does not drop a real embedding", () => {
    // The more important half: without the user_version gate, this DROP TABLE
    // would fire on every startup and destroy hours of real inference work.
    // This is the guard against that.
    const db = new Database(":memory:");
    applySchema(db); // migration already runs here on a fresh db, -> version 2

    addPhoto(db, { filename: "REAL_INFERENCE.JPG" });
    const photoId = db
      .prepare(`SELECT id FROM photos WHERE filename = ?`)
      .get("REAL_INFERENCE.JPG").id;
    db.prepare(
      `INSERT INTO photo_embeddings (photo_id, model, dim, scale, vec, created_at)
       VALUES (?, 'm', 1, 1.0, X'00', 0)`
    ).run(photoId);

    applySchema(db); // a later startup, already migrated

    expect(
      db
        .prepare(`SELECT * FROM photo_embeddings WHERE photo_id = ?`)
        .get(photoId)
    ).toBeDefined();
  });
});
