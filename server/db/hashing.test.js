import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan, getPhotoById } from "./photos.js";
import {
  hashFile,
  hashPendingPhotos,
  hashAllPending,
  _resetHashingForTest,
} from "./hashing.js";

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

describe("hashPendingPhotos", () => {
  it("hashes every photo with a NULL content_hash", async () => {
    const db = getDb();
    await writeFile(join(photosDir, "a.jpg"), "content-a");
    await writeFile(join(photosDir, "b.jpg"), "content-b");
    const rows = upsertScan(db, photosDir, 1, [
      { name: "a.jpg", size: 9, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 9, mtimeMs: 1, kind: "image" },
    ]);

    const result = await hashPendingPhotos(db);
    expect(result.hashed).toBe(2);
    expect(result.remaining).toBe(false);

    const expectedA = createHash("sha1").update("content-a").digest("hex");
    expect(getPhotoById(db, rows[0].id).content_hash).toBe(expectedA);
  });

  it("respects the limit and reports remaining work", async () => {
    const db = getDb();
    await writeFile(join(photosDir, "a.jpg"), "content-a");
    await writeFile(join(photosDir, "b.jpg"), "content-b");
    upsertScan(db, photosDir, 1, [
      { name: "a.jpg", size: 9, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 9, mtimeMs: 1, kind: "image" },
    ]);

    const result = await hashPendingPhotos(db, { limit: 1 });
    expect(result.hashed).toBe(1);
    expect(result.remaining).toBe(true);
  });

  it("marks an unreadable file attempted (hash NULL) instead of throwing", async () => {
    const db = getDb();
    const rows = upsertScan(db, photosDir, 1, [
      { name: "missing.jpg", size: 9, mtimeMs: 1, kind: "image" },
    ]);
    const result = await hashPendingPhotos(db);
    expect(result.hashed).toBe(0);
    expect(result.failed).toBe(1);
    expect(getPhotoById(db, rows[0].id).content_hash).toBeNull();
    // Marked attempted so the background sweep can't re-select it forever.
    const attempted = db
      .prepare(`SELECT hash_attempted FROM photos WHERE id = ?`)
      .get(rows[0].id).hash_attempted;
    expect(attempted).toBe(1);
    // ...and it is no longer pending.
    const again = await hashPendingPhotos(db);
    expect(again.hashed).toBe(0);
    expect(again.remaining).toBe(false);
  });
});

describe("hashAllPending", () => {
  it("hashes the WHOLE library across batches and TERMINATES past an unreadable file", async () => {
    const db = getDb();
    await writeFile(join(photosDir, "a.jpg"), "content-a");
    // b.jpg is never written to disk → unreadable. Without the hash_attempted
    // marker, LIMIT 1 would re-select it every batch and this loop would hang.
    const rows = upsertScan(db, photosDir, 1, [
      { name: "a.jpg", size: 9, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 9, mtimeMs: 1, kind: "image" },
    ]);

    const result = await hashAllPending(db, { limit: 1 });
    expect(result.hashed).toBe(1);
    expect(result.failed).toBe(1);
    expect(getPhotoById(db, rows[0].id).content_hash).not.toBeNull();

    const pending = db
      .prepare(
        `SELECT COUNT(*) AS n FROM photos
         WHERE content_hash IS NULL AND hash_attempted = 0 AND stale = 0`
      )
      .get().n;
    expect(pending).toBe(0);
  });

  it("is single-flight: a concurrent call is a no-op", async () => {
    const db = getDb();
    await writeFile(join(photosDir, "a.jpg"), "content-a");
    upsertScan(db, photosDir, 1, [
      { name: "a.jpg", size: 9, mtimeMs: 1, kind: "image" },
    ]);

    const first = hashAllPending(db, { limit: 1 });
    const second = await hashAllPending(db, { limit: 1 });
    expect(second.alreadyRunning).toBe(true);
    expect(second.hashed).toBe(0);
    await first;
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
