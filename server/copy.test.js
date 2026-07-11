import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./db/connection.js";
import { upsertScan, getPhotoById } from "./db/photos.js";
import { copyIdsIntoFolder } from "./api.js";

// Toggle flags read by the node:fs mock below — let individual tests force
// the EXDEV (cross-volume) fallback path and a corrupted copy, without
// touching real cross-volume hardware.
let forceExdev = false;
let forceCorruptCopy = false;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    renameSync: (...args) => {
      if (forceExdev) {
        const err = new Error("cross-device link not permitted (simulated)");
        err.code = "EXDEV";
        throw err;
      }
      return actual.renameSync(...args);
    },
    copyFileSync: (src, dst, ...rest) => {
      if (forceCorruptCopy) {
        // Simulate a truncated/corrupted copy so the size-verify step fails.
        actual.writeFileSync(dst, "x");
        return;
      }
      return actual.copyFileSync(src, dst, ...rest);
    },
  };
});

let cacheDir;
let srcDir;
let destDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-copy-cache-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
  const db = getDb();
  db.prepare(
    `INSERT INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
     VALUES (1, 'test-volume', 'test-uuid-1', '/test', ?)`
  ).run(Date.now());

  srcDir = await mkdtemp(join(tmpdir(), "ag-copy-src-"));
  destDir = await mkdtemp(join(tmpdir(), "ag-copy-dest-"));
  forceExdev = false;
  forceCorruptCopy = false;
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  await rm(srcDir, { recursive: true, force: true });
  await rm(destDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
  forceExdev = false;
  forceCorruptCopy = false;
});

/** Write a real file under srcDir and seed a matching photos row. */
async function seedPhoto(name, content) {
  const path = join(srcDir, name);
  await writeFile(path, content);
  const st = statSync(path);
  const db = getDb();
  const [row] = upsertScan(db, srcDir, 1, [
    { name, size: st.size, mtimeMs: st.mtimeMs, kind: "image" },
  ]);
  return row.id;
}

describe("copyIdsIntoFolder — copy mode", () => {
  it("copies files, leaves sources in place, and returns a manifest", async () => {
    const id = await seedPhoto("a.jpg", "AAA");
    const db = getDb();

    const result = copyIdsIntoFolder(db, destDir, [id]);

    expect(result.copied).toBe(1);
    expect(result.moved).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.manifest).toEqual([
      { id, from: join(srcDir, "a.jpg"), to: join(destDir, "a.jpg") },
    ]);
    expect(existsSync(join(srcDir, "a.jpg"))).toBe(true);
    expect(existsSync(join(destDir, "a.jpg"))).toBe(true);
  });

  it("never overwrites on collision — suffixes ' (2)', existing file untouched", async () => {
    await mkdir(destDir, { recursive: true });
    await writeFile(join(destDir, "a.jpg"), "EXISTING");
    const id = await seedPhoto("a.jpg", "NEW-CONTENT");
    const db = getDb();

    const result = copyIdsIntoFolder(db, destDir, [id]);

    expect(result.manifest[0].to).toBe(join(destDir, "a (2).jpg"));
    expect(readFileSync(join(destDir, "a.jpg"), "utf8")).toBe("EXISTING");
    expect(readFileSync(join(destDir, "a (2).jpg"), "utf8")).toBe(
      "NEW-CONTENT"
    );
  });

  it("skips a photo whose source file is missing on disk, without throwing", async () => {
    const id = await seedPhoto("gone.jpg", "BYE");
    await rm(join(srcDir, "gone.jpg"));
    const db = getDb();

    const result = copyIdsIntoFolder(db, destDir, [id]);

    expect(result.skipped).toBe(1);
    expect(result.copied).toBe(0);
    expect(result.manifest).toEqual([]);
  });
});

describe("copyIdsIntoFolder — move mode (same volume)", () => {
  it("removes the source, writes the dest, and repoints the index", async () => {
    const id = await seedPhoto("a.jpg", "AAA");
    const db = getDb();

    const result = copyIdsIntoFolder(db, destDir, [id], { move: true });

    expect(result.moved).toBe(1);
    expect(result.copied).toBe(0);
    expect(result.manifest).toEqual([
      { id, from: join(srcDir, "a.jpg"), to: join(destDir, "a.jpg") },
    ]);
    expect(existsSync(join(srcDir, "a.jpg"))).toBe(false);
    expect(existsSync(join(destDir, "a.jpg"))).toBe(true);

    const photo = getPhotoById(db, id);
    expect(photo.path).toBe(join(destDir, "a.jpg"));
  });

  it("never overwrites on collision in move mode — suffixes ' (2)'", async () => {
    await mkdir(destDir, { recursive: true });
    await writeFile(join(destDir, "a.jpg"), "EXISTING");
    const id = await seedPhoto("a.jpg", "NEW-CONTENT");
    const db = getDb();

    const result = copyIdsIntoFolder(db, destDir, [id], { move: true });

    expect(result.manifest[0].to).toBe(join(destDir, "a (2).jpg"));
    expect(readFileSync(join(destDir, "a.jpg"), "utf8")).toBe("EXISTING");
    expect(readFileSync(join(destDir, "a (2).jpg"), "utf8")).toBe(
      "NEW-CONTENT"
    );
    expect(existsSync(join(srcDir, "a.jpg"))).toBe(false); // source moved away
  });
});

describe("copyIdsIntoFolder — move mode, cross-volume (EXDEV) fallback", () => {
  it("falls back to copy->fsync->verify->unlink when renameSync reports EXDEV", async () => {
    const id = await seedPhoto("a.jpg", "CROSS-VOLUME-CONTENT");
    const db = getDb();
    const srcSize = statSync(join(srcDir, "a.jpg")).size;

    forceExdev = true;
    const result = copyIdsIntoFolder(db, destDir, [id], { move: true });

    expect(result.moved).toBe(1);
    expect(existsSync(join(srcDir, "a.jpg"))).toBe(false);
    expect(existsSync(join(destDir, "a.jpg"))).toBe(true);
    expect(statSync(join(destDir, "a.jpg")).size).toBe(srcSize);
  });

  it("does NOT remove the source if the verified copy is corrupt/truncated", async () => {
    const id = await seedPhoto("a.jpg", "SOME REAL CONTENT HERE");
    const db = getDb();

    forceExdev = true;
    forceCorruptCopy = true;
    expect(() => copyIdsIntoFolder(db, destDir, [id], { move: true })).toThrow(
      /verify failed/i
    );

    // Source must survive a failed verification — never lost.
    expect(existsSync(join(srcDir, "a.jpg"))).toBe(true);
  });
});

describe("copyIdsIntoFolder — cancel via AbortSignal", () => {
  it("throws AbortError immediately when the signal is already aborted; nothing processed", async () => {
    const idA = await seedPhoto("a.jpg", "AAA");
    const idB = await seedPhoto("b.jpg", "BBB");
    const db = getDb();
    const controller = new AbortController();
    controller.abort();

    let thrown;
    try {
      copyIdsIntoFolder(db, destDir, [idA, idB], {
        signal: controller.signal,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown?.name).toBe("AbortError");
    expect(existsSync(join(destDir, "a.jpg"))).toBe(false);
    expect(existsSync(join(destDir, "b.jpg"))).toBe(false);
  });

  it("aborting partway (via onProgress) persists exactly N files; manifest length N", async () => {
    const idA = await seedPhoto("a.jpg", "AAA");
    const idB = await seedPhoto("b.jpg", "BBB");
    const idC = await seedPhoto("c.jpg", "CCC");
    const db = getDb();
    const controller = new AbortController();

    let thrown;
    try {
      copyIdsIntoFolder(db, destDir, [idA, idB, idC], {
        signal: controller.signal,
        onProgress: (done) => {
          if (done === 1) controller.abort();
        },
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown?.name).toBe("AbortError");
    expect(thrown?.manifest).toHaveLength(1);
    expect(existsSync(join(destDir, "a.jpg"))).toBe(true);
    expect(existsSync(join(destDir, "b.jpg"))).toBe(false);
    expect(existsSync(join(destDir, "c.jpg"))).toBe(false);
  });
});
