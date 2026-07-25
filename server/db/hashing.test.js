import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getDb, _resetDbForTest } from "./connection.js";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import { upsertScan, getPhotoById } from "./photos.js";
import { hashFile, hashAllPending, _resetHashingForTest } from "./hashing.js";

let cacheDir;
let photosDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-db-"));
  photosDir = await mkdtemp(join(tmpdir(), "ag-photos-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
  const db = getDb();
  db.prepare(
    `INSERT INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
     VALUES (1, 'test-volume', 'test-uuid-1', '/test', ?)`
  ).run(Date.now());
});

afterEach(async () => {
  _resetHashingForTest();
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  await rm(photosDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

describe("hashFile", () => {
  it("computes the SHA1 of the file's bytes", async () => {
    const path = join(photosDir, "a.txt");
    await writeFile(path, "hello world");
    const expected = createHash("sha1").update("hello world").digest("hex");
    expect(await hashFile(path)).toBe(expected);
  });
});

describe("hashAllPending", () => {
  it("hashes the WHOLE library across batches and TERMINATES past an unreadable file", async () => {
    _resetHashingForTest();
    const db = new Database(":memory:");
    applySchema(db);
    const dir = mkdtempSync(join(tmpdir(), "hash-all-"));
    const entries = [];
    for (let i = 0; i < 5; i++) {
      const name = `IMG_${i}.JPG`;
      writeFileSync(join(dir, name), `bytes ${i}`);
      const st = statSync(join(dir, name));
      entries.push({
        name,
        size: st.size,
        mtimeMs: st.mtimeMs,
        btimeMs: st.birthtimeMs,
        kind: "image",
      });
    }
    // A row for a file that does not exist, in a folder that DOES: permanently
    // unreadable, so it must leave the pending set via the sentinel.
    entries.push({
      name: "GONE.JPG",
      size: 10,
      mtimeMs: Date.now(),
      btimeMs: Date.now(),
      kind: "image",
    });
    upsertScan(db, dir, null, entries);

    const r = await hashAllPending(db, {
      limit: 2,
      idle: () => Promise.resolve(),
    });
    expect(r.hashed).toBe(5);
    expect(r.failed).toBe(1);
    expect(r.paused).toBe(false);

    const pending = db
      .prepare(
        `SELECT COUNT(*) AS n FROM photos
          WHERE content_hash IS NULL AND hash_attempted = 0 AND stale = 0`
      )
      .get().n;
    expect(pending).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("is single-flight: a concurrent call is a no-op", async () => {
    _resetHashingForTest();
    const db = new Database(":memory:");
    applySchema(db);
    let release;
    const gate = new Promise((r) => (release = r));
    const first = hashAllPending(db, { idle: () => gate });
    const second = await hashAllPending(db, { idle: () => Promise.resolve() });
    expect(second.alreadyRunning).toBe(true);
    release();
    await first;
  });

  it("PAUSES without marking when the drive goes away mid-sweep (#169)", async () => {
    // The #169 regression test. NOTE the trap recorded in the issue: do NOT
    // re-stat() the restored file and feed those values to upsertScan.
    // writeFileSync + utimesSync round-trips mtimeMs at sub-millisecond
    // precision, so the rescan would see a CHANGED file, hash_attempted would
    // reset, and the test would pass for the wrong reason. A real unmount does
    // not touch mtime — passing the ORIGINAL entry is the faithful model.
    _resetHashingForTest();
    const db = new Database(":memory:");
    applySchema(db);
    const dir = mkdtempSync(join(tmpdir(), "unmount-"));
    const file = join(dir, "IMG_0001.JPG");
    writeFileSync(file, "the original bytes");
    const st = statSync(file);
    const entry = {
      name: "IMG_0001.JPG",
      size: st.size,
      mtimeMs: st.mtimeMs,
      btimeMs: st.birthtimeMs,
      kind: "image",
    };
    upsertScan(db, dir, null, [entry]); // indexed while mounted

    rmSync(dir, { recursive: true, force: true }); // the DRIVE goes away

    const first = await hashAllPending(db, { idle: () => Promise.resolve() });
    expect(first.paused).toBe(true);
    expect(
      db.prepare(`SELECT hash_attempted FROM photos`).get().hash_attempted
    ).toBe(0); // NOTHING marked

    // Drive returns. File never modified -> the rescan reports the IDENTICAL stat.
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "the original bytes");
    _resetHashingForTest();
    upsertScan(db, dir, null, [entry]); // same size, same mtimeMs

    const second = await hashAllPending(db, { idle: () => Promise.resolve() });
    expect(second.hashed).toBe(1);
    expect(
      db.prepare(`SELECT content_hash FROM photos`).get().content_hash
    ).not.toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("upsertScan + hashing", () => {
  it("re-hashes a file whose bytes changed (resets hash + attempted)", async () => {
    const db = getDb();
    await writeFile(join(photosDir, "a.jpg"), "v1");
    const [row] = upsertScan(db, photosDir, 1, [
      { name: "a.jpg", size: 2, mtimeMs: 1, kind: "image" },
    ]);
    await hashAllPending(db);
    const h1 = getPhotoById(db, row.id).content_hash;
    expect(h1).not.toBeNull();

    // Same path, different bytes (new size + mtime) → the upsert must null the
    // hash AND clear hash_attempted so the changed file is re-hashed.
    await writeFile(join(photosDir, "a.jpg"), "v2-longer");
    upsertScan(db, photosDir, 1, [
      { name: "a.jpg", size: 9, mtimeMs: 2, kind: "image" },
    ]);
    const mid = db
      .prepare(`SELECT content_hash, hash_attempted FROM photos WHERE id = ?`)
      .get(row.id);
    expect(mid.content_hash).toBeNull();
    expect(mid.hash_attempted).toBe(0);

    await hashAllPending(db);
    const h2 = getPhotoById(db, row.id).content_hash;
    expect(h2).not.toBeNull();
    expect(h2).not.toBe(h1);
  });
});
