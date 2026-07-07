import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan, getPhotoById } from "./photos.js";
import { hashFile, hashPendingPhotos } from "./hashing.js";

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

  it("leaves content_hash NULL for an unreadable file instead of throwing", async () => {
    const db = getDb();
    const rows = upsertScan(db, photosDir, 1, [
      { name: "missing.jpg", size: 9, mtimeMs: 1, kind: "image" },
    ]);
    const result = await hashPendingPhotos(db);
    expect(result.hashed).toBe(0);
    expect(getPhotoById(db, rows[0].id).content_hash).toBeNull();
  });
});
