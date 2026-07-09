import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtemp, rm, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import sharp from "sharp";
import { createApp } from "./index.js";
import { getDb, _resetDbForTest } from "./db/connection.js";
import { NodeProcessingService } from "./processing/NodeProcessingService.js";

/** Start the app on an ephemeral port; return { base, close }. */
async function startServer() {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

async function scan(base, dir) {
  const res = await fetch(`${base}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir }),
  });
  return res.json();
}

let photosDir;
let cacheDir;
let srv;

beforeAll(async () => {
  photosDir = await mkdtemp(join(tmpdir(), "ag-photos-"));
  cacheDir = await mkdtemp(join(tmpdir(), "ag-cache-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();

  // Three tiny distinct JPEGs + a non-image that must be ignored.
  const colors = [
    { r: 200, g: 30, b: 30 },
    { r: 30, g: 200, b: 30 },
    { r: 30, g: 30, b: 200 },
  ];
  for (let i = 0; i < colors.length; i++) {
    await sharp({
      create: { width: 48, height: 32, channels: 3, background: colors[i] },
    })
      .jpeg()
      .toFile(join(photosDir, `img_${i}.jpg`));
  }
  await mkdir(join(photosDir, "subdir")); // must be skipped (non-recursive)
  await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .png()
    .toFile(join(photosDir, "note.txt.png")); // a 4th image (png)

  srv = await startServer();
});

afterAll(async () => {
  await srv?.close();
  await rm(photosDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

describe("POST /api/scan", () => {
  it("returns sorted image items with stable ids and ignores dirs", async () => {
    const body = await scan(srv.base, photosDir);
    expect(body.count).toBe(4); // 3 jpg + 1 png, subdir excluded
    const names = body.items.map((i) => i.name);
    expect(names).toEqual([...names].sort()); // sorted by name
    expect(body.items.every((i) => Number.isInteger(i.id))).toBe(true);
    expect(body.items[0]).toHaveProperty("size");
    expect(body.items[0]).toHaveProperty("mtimeMs");
    expect(typeof body.elapsedMs).toBe("number");
  });

  it("returns the same ids across a rescan of the same folder", async () => {
    const first = await scan(srv.base, photosDir);
    const second = await scan(srv.base, photosDir);
    expect(second.items.map((i) => i.id)).toEqual(first.items.map((i) => i.id));
  });

  it("404s a missing dir and 400s a file/empty dir", async () => {
    const missing = await fetch(`${srv.base}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: join(photosDir, "nope") }),
    });
    expect(missing.status).toBe(404);
    const empty = await fetch(`${srv.base}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: "" }),
    });
    expect(empty.status).toBe(400);
  });
});

describe("GET /api/meta", () => {
  it("returns dimensions and takenAt for the requested ids", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const ids = scanBody.items.slice(0, 2).map((i) => i.id);
    const res = await fetch(`${srv.base}/api/meta?ids=${ids.join(",")}`);
    expect(res.status).toBe(200);
    const metas = await res.json();
    expect(metas).toHaveLength(2);
    // Fixture JPEGs are 48x32.
    expect(metas[0]).toMatchObject({ id: ids[0], width: 48, height: 32 });
    expect(metas[0]).toHaveProperty("takenAt"); // null: fixtures carry no EXIF
  });

  it("persists extracted metadata and reuses it on a later request", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const id = scanBody.items[0].id;
    await fetch(`${srv.base}/api/meta?ids=${id}`);

    const db = getDb();
    const row = db
      .prepare("SELECT width, height FROM photos WHERE id = ?")
      .get(id);
    expect(row).toMatchObject({ width: 48, height: 32 });

    const again = await (await fetch(`${srv.base}/api/meta?ids=${id}`)).json();
    expect(again[0]).toMatchObject({ id, width: 48, height: 32 });
  });

  it("stores width 0 (not null) for a RAW file, so a second request does not re-extract", async () => {
    // A plain invalid-but-.cr2-named file makes sharp fail its header read
    // exactly like a genuine RAW file does — see NodeProcessingService.test.js.
    await writeFile(join(photosDir, "shot.cr2"), Buffer.from([0]));
    const scanBody = await scan(srv.base, photosDir);
    const raw = scanBody.items.find((i) => i.name === "shot.cr2");
    expect(raw).toBeTruthy();

    const first = await (
      await fetch(`${srv.base}/api/meta?ids=${raw.id}`)
    ).json();
    expect(first[0]).toMatchObject({ id: raw.id, width: 0, height: 0 });

    const db = getDb();
    const row = db
      .prepare("SELECT width, height FROM photos WHERE id = ?")
      .get(raw.id);
    expect(row).toMatchObject({ width: 0, height: 0 }); // not null

    // A second request must not re-attempt extraction: spy on the shared
    // NodeProcessingService's metadata() and confirm it's not called again.
    const spy = vi
      .spyOn(NodeProcessingService.prototype, "metadata")
      .mockRejectedValue(
        new Error("must not re-attempt metadata for an already-tried RAW photo")
      );
    try {
      const second = await (
        await fetch(`${srv.base}/api/meta?ids=${raw.id}`)
      ).json();
      expect(second[0]).toMatchObject({ id: raw.id, width: 0, height: 0 });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("persists camera as '' (tried, none) for a photo with no EXIF Make/Model, and does not re-enrich on a later request", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const id = scanBody.items[0].id;
    // Synthetic sharp-created fixtures carry no EXIF Make/Model.
    await fetch(`${srv.base}/api/meta?ids=${id}`);

    const db = getDb();
    const row = db.prepare("SELECT camera FROM photos WHERE id = ?").get(id);
    expect(row.camera).toBe(""); // not null — "tried, no camera EXIF"

    const spy = vi
      .spyOn(NodeProcessingService.prototype, "metadata")
      .mockRejectedValue(
        new Error("must not re-attempt metadata for an already-enriched photo")
      );
    try {
      const res = await fetch(`${srv.base}/api/meta?ids=${id}`);
      expect(res.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("GET /api/thumb/:id", () => {
  it("generates a JPEG, then serves from cache on the second request", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const id = scanBody.items[0].id;

    const first = await fetch(`${srv.base}/api/thumb/${id}?size=64`);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("image/jpeg");
    expect(first.headers.get("x-cache")).toBe("miss");
    const bytes = Buffer.from(await first.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes[0]).toBe(0xff); // JPEG magic number
    expect(bytes[1]).toBe(0xd8);

    const cached = await readdir(join(cacheDir, "cache", "thumbs"));
    expect(cached.some((f) => f.endsWith(".jpg"))).toBe(true);

    const second = await fetch(`${srv.base}/api/thumb/${id}?size=64`);
    expect(second.status).toBe(200);
    expect(second.headers.get("x-cache")).toBe("hit");
  });

  it("404s an unknown id", async () => {
    const res = await fetch(`${srv.base}/api/thumb/999999?size=64`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/preview/:id", () => {
  it("404s for an unknown id", async () => {
    const res = await fetch(`${srv.base}/api/preview/999999`);
    expect(res.status).toBe(404);
  });

  it("404s when the photo has no embedded EXIF thumbnail", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const id = scanBody.items[0].id;
    // The fixtures under photosDir are synthetically created (no EXIF
    // segment) — see NodeProcessingService.test.js's own note on why a
    // genuine embedded-thumbnail extraction isn't unit-tested here.
    const res = await fetch(`${srv.base}/api/preview/${id}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/image/:id", () => {
  it("streams the original bytes", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const id = scanBody.items[0].id;
    const res = await fetch(`${srv.base}/api/image/${id}`);
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
  });
});

describe("rating round-trip", () => {
  it("persists a rating on the photo row across a rescan", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const id = scanBody.items[0].id;

    const set = await fetch(`${srv.base}/api/rating`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, rating: 4 }),
    });
    expect(set.status).toBe(200);

    const rescan = await scan(srv.base, photosDir);
    expect(rescan.items.find((i) => i.id === id).rating).toBe(4);

    await fetch(`${srv.base}/api/rating`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, rating: 0 }),
    });
    const after = await scan(srv.base, photosDir);
    expect(after.items.find((i) => i.id === id).rating).toBe(0);
  });

  it("rejects an out-of-range rating", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const id = scanBody.items[0].id;
    const res = await fetch(`${srv.base}/api/rating`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, rating: 9 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("manual cover choice round-trip", () => {
  it("persists a manual cover choice across a rescan", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const id = scanBody.items[1].id;

    const set = await fetch(`${srv.base}/api/cover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, isCover: true }),
    });
    expect(set.status).toBe(200);

    const rescan = await scan(srv.base, photosDir);
    expect(rescan.items.find((i) => i.id === id).preferredCover).toBe(true);

    await fetch(`${srv.base}/api/cover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, isCover: false }),
    });
    const after = await scan(srv.base, photosDir);
    expect(after.items.find((i) => i.id === id).preferredCover).toBe(false);
  });

  it("rejects a non-boolean isCover", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const id = scanBody.items[0].id;
    const res = await fetch(`${srv.base}/api/cover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, isCover: "yes" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/library", () => {
  it("records the scanned folder and reports it as mounted", async () => {
    await scan(srv.base, photosDir);
    const res = await fetch(`${srv.base}/api/library`);
    expect(res.status).toBe(200);
    const entries = await res.json();
    const entry = entries.find((e) => e.path === photosDir);
    expect(entry).toBeDefined();
    expect(entry.mounted).toBe(true);
    expect(entry.name).toBe(basename(photosDir));
  });

  it("reports a since-removed folder as not mounted", async () => {
    const goneDir = join(photosDir, "does-not-exist-anymore");
    getDb()
      .prepare(
        `INSERT INTO folders (abs_path, last_scanned_at) VALUES (?, ?)
         ON CONFLICT(abs_path) DO NOTHING`
      )
      .run(goneDir, Date.now());
    const res = await fetch(`${srv.base}/api/library`);
    const entries = await res.json();
    const entry = entries.find((e) => e.path === goneDir);
    expect(entry).toBeDefined();
    expect(entry.mounted).toBe(false);
  });

  it("reports a deleted internal-disk folder as not mounted after a real scan", async () => {
    const removedDir = await mkdtemp(join(tmpdir(), "ag-removed-"));
    await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 1, g: 2, b: 3 },
      },
    })
      .jpeg()
      .toFile(join(removedDir, "img.jpg"));

    await scan(srv.base, removedDir);
    await rm(removedDir, { recursive: true, force: true });

    const res = await fetch(`${srv.base}/api/library`);
    const entries = await res.json();
    const entry = entries.find((e) => e.path === removedDir);
    expect(entry).toBeDefined();
    expect(entry.mounted).toBe(false);
  });

  it("stays fast when many folders share one volume (dedupes diskutil calls per volume)", async () => {
    const db = getDb();
    const volumeId = db
      .prepare(
        `INSERT INTO volumes (label, uuid, last_mount_path, last_seen_at)
         VALUES ('shared-volume', 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', '/Volumes/SharedTestVolume', ?)`
      )
      .run(Date.now()).lastInsertRowid;
    const insertFolder = db.prepare(
      `INSERT INTO folders (abs_path, last_scanned_at, volume_id) VALUES (?, ?, ?)
       ON CONFLICT(abs_path) DO NOTHING`
    );
    const insertManyFolders = db.transaction((count) => {
      for (let i = 0; i < count; i++) {
        insertFolder.run(
          join(photosDir, `shared-volume-folder-${i}`),
          Date.now(),
          volumeId
        );
      }
    });
    // 300 folders on one volume: at ~15-25ms/diskutil call on this machine, the
    // buggy (per-folder) path takes several seconds while the deduped (one
    // call per volume) path stays under ~100ms — a wide, non-flaky margin.
    insertManyFolders(300);

    const start = Date.now();
    const res = await fetch(`${srv.base}/api/library`);
    const elapsedMs = Date.now() - start;
    expect(res.status).toBe(200);
    expect(elapsedMs).toBeLessThan(500);
  });

  it("reports a folder as not mounted when its no-uuid volume's mount path is gone", async () => {
    const db = getDb();
    const missingMountPath = join(photosDir, "no-uuid-volume-does-not-exist");
    const volumeId = db
      .prepare(
        `INSERT INTO volumes (label, uuid, last_mount_path, last_seen_at)
         VALUES ('no-uuid-volume', NULL, ?, ?)`
      )
      .run(missingMountPath, Date.now()).lastInsertRowid;
    const folderPath = join(photosDir, "no-uuid-volume-folder");
    await mkdir(folderPath, { recursive: true });
    db.prepare(
      `INSERT INTO folders (abs_path, last_scanned_at, volume_id) VALUES (?, ?, ?)
       ON CONFLICT(abs_path) DO NOTHING`
    ).run(folderPath, Date.now(), volumeId);

    const res = await fetch(`${srv.base}/api/library`);
    const entries = await res.json();
    const entry = entries.find((e) => e.path === folderPath);
    expect(entry).toBeDefined();
    expect(entry.mounted).toBe(false);
  });
});

describe("GET /api/library id field", () => {
  it("includes each folder's id", async () => {
    await scan(srv.base, photosDir);
    const res = await fetch(`${srv.base}/api/library`);
    const body = await res.json();
    const entry = body.find((e) => e.path === photosDir);
    expect(entry).toBeDefined();
    expect(typeof entry.id).toBe("number");
  });
});

describe("DELETE /api/folders/:id", () => {
  it("404s for an unknown id", async () => {
    const res = await fetch(`${srv.base}/api/folders/999999`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("removes the folder and its photos; real files on disk are untouched", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ag-removeme-"));
    await sharp({
      create: { width: 40, height: 30, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toFile(join(tempDir, "x.jpg"));

    await scan(srv.base, tempDir);
    const libRes = await fetch(`${srv.base}/api/library`);
    const lib = await libRes.json();
    const entry = lib.find((e) => e.path === tempDir);
    expect(entry).toBeDefined();

    const del = await fetch(`${srv.base}/api/folders/${entry.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);

    const libRes2 = await fetch(`${srv.base}/api/library`);
    const lib2 = await libRes2.json();
    expect(lib2.some((e) => e.path === tempDir)).toBe(false);

    const stillOnDisk = await readdir(tempDir);
    expect(stillOnDisk).toEqual(["x.jpg"]);

    await rm(tempDir, { recursive: true, force: true });
  });
});

describe("cache management routes", () => {
  it("GET /api/cache/stats reflects real cache dir contents", async () => {
    await fetch(`${srv.base}/api/cache/clear`, { method: "POST" });
    const before = await (await fetch(`${srv.base}/api/cache/stats`)).json();
    expect(before).toEqual({ totalBytes: 0, totalFiles: 0 });

    const scanBody = await scan(srv.base, photosDir);
    const id = scanBody.items[0].id;
    await fetch(`${srv.base}/api/thumb/${id}?size=64`);

    const after = await (await fetch(`${srv.base}/api/cache/stats`)).json();
    expect(after.totalFiles).toBe(1);
    expect(after.totalBytes).toBeGreaterThan(0);
  });

  it("GET /api/cache/breakdown attributes the cached thumbnail to its folder", async () => {
    await fetch(`${srv.base}/api/cache/clear`, { method: "POST" });
    const scanBody = await scan(srv.base, photosDir);
    const id = scanBody.items[0].id;
    await fetch(`${srv.base}/api/thumb/${id}?size=320`);

    const breakdown = await (
      await fetch(`${srv.base}/api/cache/breakdown`)
    ).json();
    const entry = breakdown.folders.find((f) => f.path === photosDir);
    expect(entry).toBeDefined();
    expect(entry.cachedFiles).toBeGreaterThanOrEqual(1);
    expect(entry.cachedBytes).toBeGreaterThan(0);
  });

  it("POST /api/cache/clear empties the cache", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const id = scanBody.items[0].id;
    await fetch(`${srv.base}/api/thumb/${id}?size=160`);
    expect((await (await fetch(`${srv.base}/api/cache/stats`)).json()).totalFiles).toBeGreaterThan(0);

    const result = await (
      await fetch(`${srv.base}/api/cache/clear`, { method: "POST" })
    ).json();
    expect(result.freedFiles).toBeGreaterThan(0);

    expect(await (await fetch(`${srv.base}/api/cache/stats`)).json()).toEqual({
      totalBytes: 0,
      totalFiles: 0,
    });
  });

  it("POST /api/cache/prune removes an orphaned file left after folder removal", async () => {
    await fetch(`${srv.base}/api/cache/clear`, { method: "POST" });
    const tempDir = await mkdtemp(join(tmpdir(), "ag-prunetest-"));
    await sharp({
      create: { width: 40, height: 30, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .jpeg()
      .toFile(join(tempDir, "z.jpg"));

    const scanBody = await scan(srv.base, tempDir);
    const id = scanBody.items[0].id;
    await fetch(`${srv.base}/api/thumb/${id}?size=160`);
    expect((await (await fetch(`${srv.base}/api/cache/stats`)).json()).totalFiles).toBe(1);

    const lib = await (await fetch(`${srv.base}/api/library`)).json();
    const entry = lib.find((e) => e.path === tempDir);
    await fetch(`${srv.base}/api/folders/${entry.id}`, { method: "DELETE" });

    const pruneResult = await (
      await fetch(`${srv.base}/api/cache/prune`, { method: "POST" })
    ).json();
    expect(pruneResult.freedFiles).toBe(1);
    expect(await (await fetch(`${srv.base}/api/cache/stats`)).json()).toEqual({
      totalBytes: 0,
      totalFiles: 0,
    });

    await rm(tempDir, { recursive: true, force: true });
  });
});

describe("GET /api/feed", () => {
  beforeEach(async () => {
    const db = getDb();
    db.prepare("DELETE FROM photos").run();
    db.prepare("DELETE FROM folders").run();
  });

  it("returns items grouped by folder by default order, with group values", async () => {
    await scan(srv.base, photosDir);
    const res = await fetch(`${srv.base}/api/feed?groupBy=folder&after=50`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]).toHaveProperty("groupValues.folder");
  });

  it("supports focusId + before/after keyset pagination", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const ids = scanBody.items.map((i) => i.id).sort((a, b) => a - b);
    const midId = ids[Math.floor(ids.length / 2)];
    const res = await fetch(
      `${srv.base}/api/feed?groupBy=folder&focusId=${midId}&before=1&after=1`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i) => i.id !== midId)).toBe(true);
  });

  it("folds a collapsed folder into one in-place placeholder item", async () => {
    await scan(srv.base, photosDir);
    const collapsed = encodeURIComponent(
      JSON.stringify([[{ dimension: "folder", value: photosDir }]])
    );
    const res = await fetch(
      `${srv.base}/api/feed?groupBy=folder&collapsed=${collapsed}&after=50`
    );
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].collapsed).toBe(true);
    expect(body.items[0].count).toBeGreaterThan(0);
  });

  it("400s on an unknown groupBy dimension", async () => {
    const res = await fetch(`${srv.base}/api/feed?groupBy=bogus&after=10`);
    expect(res.status).toBe(400);
  });

  it("400s when groupBy is missing", async () => {
    const res = await fetch(`${srv.base}/api/feed`);
    expect(res.status).toBe(400);
  });

  it("respects an explicit after=0 instead of silently defaulting it to 50", async () => {
    // Regression test: `Number(req.query.after) || 50` treated an
    // explicitly-passed "0" (falsy in JS) the same as a missing param,
    // silently injecting 50 unrelated "after" items into what a caller
    // asked to be a pure before-page — this corrupted the client's
    // assembled feed order after a group-jump (see issues #36, #39).
    const scanBody = await scan(srv.base, photosDir);
    const ids = scanBody.items.map((i) => i.id).sort((a, b) => a - b);
    const midId = ids[Math.floor(ids.length / 2)];
    const res = await fetch(
      `${srv.base}/api/feed?groupBy=folder&focusId=${midId}&before=1&after=0`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBe(1);
  });

  it("respects an explicit before=0 alongside a real after count", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const ids = scanBody.items.map((i) => i.id).sort((a, b) => a - b);
    const midId = ids[Math.floor(ids.length / 2)];
    const res = await fetch(
      `${srv.base}/api/feed?groupBy=folder&focusId=${midId}&before=0&after=1`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBe(1);
  });

  it("supports startPath to jump to an arbitrary hierarchy path", async () => {
    await scan(srv.base, photosDir);
    const startPath = encodeURIComponent(
      JSON.stringify([{ dimension: "folder", value: photosDir }])
    );
    const res = await fetch(
      `${srv.base}/api/feed?groupBy=folder&startPath=${startPath}&after=50`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThan(0);
  });
});

describe("/api/feed filter param", () => {
  beforeEach(async () => {
    const db = getDb();
    db.prepare("DELETE FROM photos").run();
    db.prepare("DELETE FROM folders").run();
  });

  it("400s on non-JSON filter", async () => {
    await scan(srv.base, photosDir);
    const res = await fetch(
      `${srv.base}/api/feed?groupBy=folder&filter=not-json&after=50`
    );
    expect(res.status).toBe(400);
  });

  it("400s on out-of-range minRating", async () => {
    await scan(srv.base, photosDir);
    const filter = encodeURIComponent(JSON.stringify({ minRating: 9 }));
    const res = await fetch(
      `${srv.base}/api/feed?groupBy=folder&filter=${filter}&after=50`
    );
    expect(res.status).toBe(400);
  });

  it("400s on unknown orientation", async () => {
    await scan(srv.base, photosDir);
    const filter = encodeURIComponent(
      JSON.stringify({ orientations: ["diagonal"] })
    );
    const res = await fetch(
      `${srv.base}/api/feed?groupBy=folder&filter=${filter}&after=50`
    );
    expect(res.status).toBe(400);
  });

  it("returns only photos meeting minRating once one photo is rated", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const ratedId = scanBody.items[0].id;

    const set = await fetch(`${srv.base}/api/rating`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: ratedId, rating: 4 }),
    });
    expect(set.status).toBe(200);

    const filter = encodeURIComponent(JSON.stringify({ minRating: 4 }));
    const res = await fetch(
      `${srv.base}/api/feed?groupBy=folder&filter=${filter}&after=50`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i) => i.id === ratedId)).toBe(true);
  });
});

describe("GET /api/feed/boundary", () => {
  it("finds the next group boundary", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const firstId = scanBody.items[0].id;
    const res = await fetch(
      `${srv.base}/api/feed/boundary?groupBy=folder&focusId=${firstId}&direction=next`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("id");
  });

  it("returns { id: null } at the true end of the library", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const lastId = scanBody.items[scanBody.items.length - 1].id;
    const res = await fetch(
      `${srv.base}/api/feed/boundary?groupBy=folder&focusId=${lastId}&direction=next`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: null });
  });

  it("400s for a missing groupBy", async () => {
    const res = await fetch(
      `${srv.base}/api/feed/boundary?focusId=1&direction=next`
    );
    expect(res.status).toBe(400);
  });

  it("400s for an invalid direction", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const firstId = scanBody.items[0].id;
    const res = await fetch(
      `${srv.base}/api/feed/boundary?groupBy=folder&focusId=${firstId}&direction=sideways`
    );
    expect(res.status).toBe(400);
  });

  it("404s for an unknown focusId", async () => {
    const res = await fetch(
      `${srv.base}/api/feed/boundary?groupBy=folder&focusId=999999&direction=next`
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/tree", () => {
  beforeEach(async () => {
    const db = getDb();
    db.prepare("DELETE FROM photos").run();
    db.prepare("DELETE FROM folders").run();
  });

  it("returns the library total and root-level nodes", async () => {
    await scan(srv.base, photosDir);
    const res = await fetch(`${srv.base}/api/tree?groupBy=folder,year`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBeGreaterThan(0);
    expect(body.nodes.length).toBeGreaterThan(0);
    expect(body.nodes[0]).toHaveProperty("value");
    expect(body.nodes[0]).toHaveProperty("count");
    expect(body.nodes[0].hasChildren).toBe(true);
  });

  it("scopes to a given path prefix", async () => {
    await scan(srv.base, photosDir);
    const path = encodeURIComponent(
      JSON.stringify([{ dimension: "folder", value: photosDir }])
    );
    const res = await fetch(
      `${srv.base}/api/tree?groupBy=folder,year&path=${path}`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes.length).toBeGreaterThan(0);
    expect(body.nodes[0].hasChildren).toBe(false);
  });

  it("400s on an unknown groupBy dimension", async () => {
    const res = await fetch(`${srv.base}/api/tree?groupBy=bogus`);
    expect(res.status).toBe(400);
  });

  it("400s when groupBy is missing", async () => {
    const res = await fetch(`${srv.base}/api/tree`);
    expect(res.status).toBe(400);
  });

  it("400s on malformed path JSON", async () => {
    const res = await fetch(
      `${srv.base}/api/tree?groupBy=folder&path=not-json`
    );
    expect(res.status).toBe(400);
  });

  it("400s when path is already at the deepest grouping level", async () => {
    await scan(srv.base, photosDir);
    const path = encodeURIComponent(
      JSON.stringify([{ dimension: "folder", value: photosDir }])
    );
    const res = await fetch(`${srv.base}/api/tree?groupBy=folder&path=${path}`);
    expect(res.status).toBe(400);
  });
});
