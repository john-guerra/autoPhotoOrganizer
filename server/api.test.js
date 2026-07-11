import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from "vitest";
import { mkdtemp, rm, mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";

// Reveal-in-Finder shells out to a file manager; stub the async launcher so
// tests never actually pop Finder/Explorer, while preserving execFileSync
// (used by db/volumes.js for `diskutil` during scans).
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execFile: vi.fn((cmd, args, cb) => {
      if (typeof cb === "function") cb(null, "", "");
      return {};
    }),
  };
});
import sharp from "sharp";
import { createApp } from "./index.js";
import { getDb, _resetDbForTest } from "./db/connection.js";
import { getPhotoById } from "./db/photos.js";
import { NodeProcessingService } from "./processing/NodeProcessingService.js";
import { registry } from "./jobs/registry.js";
import { sampleOffsets } from "./db/sampleGroup.js";

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

/** Poll the in-process registry until `id` leaves "running". */
async function waitJob(id, { timeoutMs = 5000 } = {}) {
  const start = Date.now();
  for (;;) {
    const job = registry.get(id);
    if (job && job.status !== "running") return job;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`job ${id} did not finish within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
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

// Background-job tests (export/materialize/scan/undo-move) spawn real jobs
// via the shared `registry` singleton and don't dismiss them individually —
// dismiss every terminal job after each test so a later test asserting on
// `GET /api/jobs`'s full list (e.g. "returns {jobs: []} initially") isn't
// polluted by leftovers from an earlier one.
afterEach(() => {
  for (const j of registry.list()) {
    if (j.status !== "running") registry.dismiss(j.id);
  }
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

  it("recursive:true runs as a background job — 202 {jobId}, job result has folders/count", async () => {
    // Drop an image into the (otherwise-skipped) subdir.
    await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 3,
        background: { r: 10, g: 10, b: 10 },
      },
    })
      .jpeg()
      .toFile(join(photosDir, "subdir", "deep.jpg"));

    const res = await fetch(`${srv.base}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: photosDir, recursive: true }),
    });
    expect(res.status).toBe(202);
    const { jobId } = await res.json();
    expect(typeof jobId).toBe("string");

    const job = await waitJob(jobId);
    expect(job.status).toBe("done");
    expect(job.result.count).toBe(5); // 4 top-level + 1 in subdir
    expect(job.result.folders).toBe(2); // top-level + subdir
    expect(job.result.root).toBe(photosDir);
    expect(typeof job.result.elapsedMs).toBe("number");
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

describe("GET /api/meta — EXIF fields", () => {
  it("returns persisted EXIF for an already-extracted photo", async () => {
    const db = getDb();
    const folderId = db
      .prepare(`INSERT INTO folders (abs_path, last_scanned_at) VALUES (?, 0)`)
      .run("/p-exif-test").lastInsertRowid;
    // width + camera + lens all non-null → the handler must NOT re-extract.
    const photoId = db
      .prepare(
        `INSERT INTO photos
           (folder_id, filename, size, mtime, kind, width, height, camera,
            aperture, shutter, iso, focal_length, lens)
         VALUES (?, 'a.jpg', 2400000, 1, 'image', 3024, 4032, 'Canon EOS R6',
            2.8, 0.004, 400, 50, 'RF24-70mm F2.8')`
      )
      .run(folderId).lastInsertRowid;

    const { base, close } = await startServer();
    try {
      const res = await fetch(`${base}/api/meta?ids=${photoId}`);
      const [m] = await res.json();
      expect(m).toMatchObject({
        id: Number(photoId),
        camera: "Canon EOS R6",
        aperture: 2.8,
        shutter: 0.004,
        iso: 400,
        focalLength: 50,
        lens: "RF24-70mm F2.8",
        size: 2400000,
        folder: "/p-exif-test",
      });
    } finally {
      await close();
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

describe("POST /api/reveal/:id", () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    vi.mocked(execFile).mockClear();
  });
  afterEach(() => {
    // Restore the real platform after any test that faked it.
    Object.defineProperty(process, "platform", { value: realPlatform });
  });

  it("404s for an unknown id", async () => {
    const res = await fetch(`${srv.base}/api/reveal/99999999`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("404s when the file no longer exists on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ag-reveal-"));
    const f = join(dir, "gone.jpg");
    await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 1, g: 2, b: 3 },
      },
    })
      .jpeg()
      .toFile(f);
    const body = await scan(srv.base, dir);
    const id = body.items[0].id;
    await rm(f);
    const res = await fetch(`${srv.base}/api/reveal/${id}`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(execFile).not.toHaveBeenCalled();
    await rm(dir, { recursive: true, force: true });
  });

  it("spawns `open -R <path>` and returns ok on macOS", async () => {
    const body = await scan(srv.base, photosDir);
    const id = body.items[0].id;
    const raw = getPhotoById(getDb(), id);
    Object.defineProperty(process, "platform", { value: "darwin" });
    const res = await fetch(`${srv.base}/api/reveal/${id}`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(execFile).toHaveBeenCalledTimes(1);
    const [cmd, args] = vi.mocked(execFile).mock.calls[0];
    expect(cmd).toBe("open");
    expect(args).toEqual(["-R", raw.path]);
  });

  it("uses `explorer /select,` on Windows", async () => {
    const body = await scan(srv.base, photosDir);
    const id = body.items[0].id;
    const raw = getPhotoById(getDb(), id);
    Object.defineProperty(process, "platform", { value: "win32" });
    const res = await fetch(`${srv.base}/api/reveal/${id}`, { method: "POST" });
    expect(res.status).toBe(200);
    const [cmd, args] = vi.mocked(execFile).mock.calls[0];
    expect(cmd).toBe("explorer");
    expect(args).toEqual(["/select,", raw.path]);
  });

  it("opens the containing folder via `xdg-open` on Linux", async () => {
    const body = await scan(srv.base, photosDir);
    const id = body.items[0].id;
    const raw = getPhotoById(getDb(), id);
    Object.defineProperty(process, "platform", { value: "linux" });
    const res = await fetch(`${srv.base}/api/reveal/${id}`, { method: "POST" });
    expect(res.status).toBe(200);
    const [cmd, args] = vi.mocked(execFile).mock.calls[0];
    expect(cmd).toBe("xdg-open");
    expect(args).toEqual([dirname(raw.path)]);
  });

  it("501s on an unsupported platform", async () => {
    const body = await scan(srv.base, photosDir);
    const id = body.items[0].id;
    Object.defineProperty(process, "platform", { value: "sunos" });
    const res = await fetch(`${srv.base}/api/reveal/${id}`, { method: "POST" });
    expect(res.status).toBe(501);
    expect(execFile).not.toHaveBeenCalled();
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
      create: {
        width: 40,
        height: 30,
        channels: 3,
        background: { r: 1, g: 2, b: 3 },
      },
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

describe("POST /api/folders/remove", () => {
  it("removes an indexed folder by its on-disk path; files untouched", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ag-rmpath-"));
    await sharp({
      create: {
        width: 40,
        height: 30,
        channels: 3,
        background: { r: 4, g: 5, b: 6 },
      },
    })
      .jpeg()
      .toFile(join(tempDir, "y.jpg"));

    await scan(srv.base, tempDir);
    const lib = await (await fetch(`${srv.base}/api/library`)).json();
    expect(lib.some((e) => e.path === tempDir)).toBe(true);

    const res = await fetch(`${srv.base}/api/folders/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: tempDir }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).removed).toBe(true);

    const lib2 = await (await fetch(`${srv.base}/api/library`)).json();
    expect(lib2.some((e) => e.path === tempDir)).toBe(false);
    expect(await readdir(tempDir)).toEqual(["y.jpg"]);

    await rm(tempDir, { recursive: true, force: true });
  });

  it("404s for a path not in the index", async () => {
    const res = await fetch(`${srv.base}/api/folders/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/nope/not/indexed" }),
    });
    expect(res.status).toBe(404);
  });

  it("400s when path is missing", async () => {
    const res = await fetch(`${srv.base}/api/folders/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/folders/rename", () => {
  let base;
  let folderDir;

  beforeEach(async () => {
    const db = getDb();
    db.prepare("DELETE FROM photos").run();
    db.prepare("DELETE FROM folders").run();
    base = await mkdtemp(join(tmpdir(), "ag-ren-"));
    folderDir = join(base, "OldName");
    await mkdir(folderDir);
    await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 1, g: 2, b: 3 },
      },
    })
      .jpeg()
      .toFile(join(folderDir, "p.jpg"));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const rename = (path, newName) =>
    fetch(`${srv.base}/api/folders/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, newName }),
    });

  it("renames the real folder on disk and updates the index", async () => {
    const scanBody = await scan(srv.base, folderDir);
    const id = scanBody.items[0].id;

    const res = await rename(folderDir, "NewName");
    expect(res.status).toBe(200);

    const newDir = join(base, "NewName");
    expect(existsSync(folderDir)).toBe(false); // disk: old gone
    expect(existsSync(join(newDir, "p.jpg"))).toBe(true); // disk: file moved with it
    // index: the photo's path now reflects the new folder (paths derive from folder_id)
    expect(getPhotoById(getDb(), id).path).toBe(join(newDir, "p.jpg"));
    // and the photo is still found under a rescan of the new location
    const rescan = await scan(srv.base, newDir);
    expect(rescan.items.some((i) => i.id === id)).toBe(true);
  });

  it("updates scanned SUBfolders' index rows too (prefix)", async () => {
    const sub = join(folderDir, "sub");
    await mkdir(sub);
    await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 9, g: 9, b: 9 },
      },
    })
      .jpeg()
      .toFile(join(sub, "q.jpg"));
    await scan(srv.base, folderDir); // folderDir row + p.jpg
    const subScan = await scan(srv.base, sub); // sub gets its own folder row + q.jpg
    const subId = subScan.items[0].id;

    expect((await rename(folderDir, "Renamed")).status).toBe(200);
    // the subfolder photo repoints under the renamed parent (prefix update)
    expect(getPhotoById(getDb(), subId).path).toBe(
      join(base, "Renamed", "sub", "q.jpg")
    );
  });

  it("refuses a name containing a path separator", async () => {
    await scan(srv.base, folderDir);
    expect((await rename(folderDir, "a/b")).status).toBe(400);
    expect((await rename(folderDir, "..")).status).toBe(400);
  });

  it("409s when a folder with the new name already exists on disk", async () => {
    await mkdir(join(base, "Taken"));
    await scan(srv.base, folderDir);
    expect((await rename(folderDir, "Taken")).status).toBe(409);
    expect(existsSync(folderDir)).toBe(true); // not renamed
  });

  it("404s for a path not in the index", async () => {
    expect((await rename(join(base, "ghost"), "x")).status).toBe(404);
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
    expect(
      (await (await fetch(`${srv.base}/api/cache/stats`)).json()).totalFiles
    ).toBeGreaterThan(0);

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
      create: {
        width: 40,
        height: 30,
        channels: 3,
        background: { r: 9, g: 9, b: 9 },
      },
    })
      .jpeg()
      .toFile(join(tempDir, "z.jpg"));

    const scanBody = await scan(srv.base, tempDir);
    const id = scanBody.items[0].id;
    await fetch(`${srv.base}/api/thumb/${id}?size=160`);
    expect(
      (await (await fetch(`${srv.base}/api/cache/stats`)).json()).totalFiles
    ).toBe(1);

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

  it("serves a flat feed of every photo when groupBy is empty", async () => {
    await scan(srv.base, photosDir);
    const res = await fetch(`${srv.base}/api/feed?after=50`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Flat feed: real photo items, no group dimensions in play.
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]).toHaveProperty("id");
    expect(body.items.every((i) => i.kind !== "header")).toBe(true);
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

describe("GET /api/feed — sort param", () => {
  beforeEach(async () => {
    const db = getDb();
    db.prepare("DELETE FROM photos").run();
    db.prepare("DELETE FROM folders").run();
  });

  it("orders a flat feed by rating desc when sort=rating:desc", async () => {
    await scan(srv.base, photosDir);
    const db = getDb();
    const rows = db.prepare(`SELECT id FROM photos ORDER BY id`).all();
    const starredId = rows[0].id;
    db.prepare(`UPDATE photos SET rating = 5 WHERE id = ?`).run(starredId);

    const res = await fetch(
      `${srv.base}/api/feed?groupBy=folder&after=200&sort=rating:desc`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Real photo items only — collapsed group placeholders use a synthetic
    // string id, not a numeric one.
    const realItems = body.items.filter(
      (i) => typeof i.id === "number" && !i.collapsed
    );
    const starredIndex = realItems.findIndex((i) => i.id === starredId);
    const zeroRatedIndex = realItems.findIndex(
      (i) => i.id !== starredId && (i.rating ?? 0) === 0
    );
    expect(starredIndex).toBeGreaterThanOrEqual(0);
    expect(zeroRatedIndex).toBeGreaterThanOrEqual(0);
    // rating:desc must place the 5-star photo ahead of an unrated one.
    expect(starredIndex).toBeLessThan(zeroRatedIndex);
  });

  it("never 400s on a bad sort — falls back to the default", async () => {
    await scan(srv.base, photosDir);
    const res = await fetch(
      `${srv.base}/api/feed?groupBy=folder&sort=bogus:sideways`
    );
    expect(res.status).toBe(200);
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

  it("treats filter=null as no filter instead of 500", async () => {
    await scan(srv.base, photosDir);
    const res = await fetch(
      `${srv.base}/api/feed?groupBy=folder&filter=null&after=50`
    );
    expect(res.status).toBe(200);
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

describe("GET /api/photos/ids", () => {
  beforeEach(async () => {
    const db = getDb();
    db.prepare("DELETE FROM photos").run();
    db.prepare("DELETE FROM folders").run();
  });

  it("returns every non-stale photo id with no filter", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const res = await fetch(`${srv.base}/api/photos/ids`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ids.sort((a, b) => a - b)).toEqual(
      scanBody.items.map((i) => i.id).sort((a, b) => a - b)
    );
  });

  it("respects a minRating filter", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const ratedId = scanBody.items[0].id;
    await fetch(`${srv.base}/api/rating`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: ratedId, rating: 5 }),
    });

    const filter = encodeURIComponent(JSON.stringify({ minRating: 5 }));
    const res = await fetch(`${srv.base}/api/photos/ids?filter=${filter}`);
    const body = await res.json();
    expect(body.ids).toEqual([ratedId]);
  });

  it("400s on malformed filter JSON", async () => {
    const res = await fetch(`${srv.base}/api/photos/ids?filter=not-json`);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/photos/count", () => {
  beforeEach(async () => {
    const db = getDb();
    db.prepare("DELETE FROM photos").run();
    db.prepare("DELETE FROM folders").run();
  });

  it("counts every non-stale photo with no filter", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const res = await fetch(`${srv.base}/api/photos/count`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(scanBody.items.length);
  });

  it("counts only matches under a filter", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const ratedId = scanBody.items[0].id;
    await fetch(`${srv.base}/api/rating`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: ratedId, rating: 5 }),
    });
    const filter = encodeURIComponent(JSON.stringify({ minRating: 5 }));
    const res = await fetch(`${srv.base}/api/photos/count?filter=${filter}`);
    const body = await res.json();
    expect(body.count).toBe(1);
  });

  it("400s on malformed filter JSON", async () => {
    const res = await fetch(`${srv.base}/api/photos/count?filter=not-json`);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/library/reset", () => {
  beforeEach(async () => {
    const db = getDb();
    db.prepare("DELETE FROM photos").run();
    db.prepare("DELETE FROM folders").run();
  });

  it("400s without confirm: DELETE", async () => {
    const res = await fetch(`${srv.base}/api/library/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("400s with the wrong confirm value", async () => {
    const res = await fetch(`${srv.base}/api/library/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "yes" }),
    });
    expect(res.status).toBe(400);
  });

  it("clears the index and cache, and never touches source files", async () => {
    await fetch(`${srv.base}/api/cache/clear`, { method: "POST" });
    const scanBody = await scan(srv.base, photosDir);
    const id = scanBody.items[0].id;
    await fetch(`${srv.base}/api/thumb/${id}?size=64`);

    const cacheBefore = await (
      await fetch(`${srv.base}/api/cache/stats`)
    ).json();
    expect(cacheBefore.totalFiles).toBeGreaterThan(0);

    const res = await fetch(`${srv.base}/api/library/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.folders).toBeGreaterThan(0);
    expect(body.photos).toBeGreaterThan(0);
    expect(body.cacheFreedFiles).toBeGreaterThan(0);
    expect(body.cacheFreedBytes).toBeGreaterThan(0);

    const lib = await (await fetch(`${srv.base}/api/library`)).json();
    expect(lib).toEqual([]);
    const cacheAfter = await (
      await fetch(`${srv.base}/api/cache/stats`)
    ).json();
    expect(cacheAfter).toEqual({ totalBytes: 0, totalFiles: 0 });

    // Real source files on disk are untouched.
    const stillOnDisk = await readdir(photosDir);
    expect(stillOnDisk.length).toBeGreaterThan(0);
  });
});

describe("POST /api/export", () => {
  let exportSrcDir;
  let exportDestDir;

  beforeEach(async () => {
    const db = getDb();
    db.prepare("DELETE FROM photos").run();
    db.prepare("DELETE FROM folders").run();
    exportSrcDir = await mkdtemp(join(tmpdir(), "ag-export-src-"));
    exportDestDir = await mkdtemp(join(tmpdir(), "ag-export-dest-"));
    await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 5, g: 5, b: 5 },
      },
    })
      .jpeg()
      .toFile(join(exportSrcDir, "one.jpg"));
    await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 6, g: 6, b: 6 },
      },
    })
      .jpeg()
      .toFile(join(exportSrcDir, "two.jpg"));
  });

  afterEach(async () => {
    await rm(exportSrcDir, { recursive: true, force: true });
    await rm(exportDestDir, { recursive: true, force: true });
  });

  it("runs as a background job: copies photos into a new dated folder and leaves sources untouched", async () => {
    const scanBody = await scan(srv.base, exportSrcDir);
    const photoIds = scanBody.items.map((i) => i.id);

    const res = await fetch(`${srv.base}/api/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        photoIds,
        destParent: exportDestDir,
        folderName: "2026-07-09 Trip",
      }),
    });
    expect(res.status).toBe(202);
    const { jobId } = await res.json();
    expect(typeof jobId).toBe("string");

    const job = await waitJob(jobId);
    expect(job.status).toBe("done");
    expect(job.result.copied).toBe(2);
    expect(job.result.skipped).toBe(0);
    expect(job.result.target).toBe(join(exportDestDir, "2026-07-09 Trip"));

    const copiedFiles = (await readdir(job.result.target)).sort();
    expect(copiedFiles).toEqual(["one.jpg", "two.jpg"]);

    // Sources untouched.
    const sourceFiles = (await readdir(exportSrcDir)).sort();
    expect(sourceFiles).toEqual(["one.jpg", "two.jpg"]);
  });

  it("never overwrites: suffixes ' (2)' on a filename collision", async () => {
    const scanBody = await scan(srv.base, exportSrcDir);
    const oneId = scanBody.items.find((i) => i.name === "one.jpg").id;

    const firstRes = await fetch(`${srv.base}/api/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        photoIds: [oneId],
        destParent: exportDestDir,
        folderName: "collide",
      }),
    });
    const first = await waitJob((await firstRes.json()).jobId);
    expect(first.result.copied).toBe(1);

    const secondRes = await fetch(`${srv.base}/api/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        photoIds: [oneId],
        destParent: exportDestDir,
        folderName: "collide",
      }),
    });
    const second = await waitJob((await secondRes.json()).jobId);
    expect(second.result.copied).toBe(1);

    const files = (await readdir(join(exportDestDir, "collide"))).sort();
    expect(files).toEqual(["one (2).jpg", "one.jpg"]);
  });

  it("skips a photo whose source file is missing on disk", async () => {
    const scanBody = await scan(srv.base, exportSrcDir);
    const missingId = scanBody.items.find((i) => i.name === "two.jpg").id;
    await rm(join(exportSrcDir, "two.jpg"));

    const res = await fetch(`${srv.base}/api/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        photoIds: [missingId],
        destParent: exportDestDir,
        folderName: "missing-src",
      }),
    });
    expect(res.status).toBe(202);
    const job = await waitJob((await res.json()).jobId);
    expect(job.result.copied).toBe(0);
    expect(job.result.skipped).toBe(1);
  });

  it("400s on an empty photoIds array", async () => {
    const res = await fetch(`${srv.base}/api/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        photoIds: [],
        destParent: exportDestDir,
        folderName: "empty",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("400s when destParent does not exist", async () => {
    const res = await fetch(`${srv.base}/api/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        photoIds: [1],
        destParent: join(exportDestDir, "nope"),
        folderName: "x",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("400s on a folderName that attempts path traversal", async () => {
    const scanBody = await scan(srv.base, exportSrcDir);
    const res = await fetch(`${srv.base}/api/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        photoIds: [scanBody.items[0].id],
        destParent: exportDestDir,
        folderName: "../escape",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses a destParent inside the AutoGallery cache root", async () => {
    const scanBody = await scan(srv.base, exportSrcDir);
    const res = await fetch(`${srv.base}/api/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        photoIds: [scanBody.items[0].id],
        destParent: cacheDir,
        folderName: "sneaky",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses a target nested inside a scanned source folder", async () => {
    const scanBody = await scan(srv.base, exportSrcDir);
    const res = await fetch(`${srv.base}/api/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        photoIds: [scanBody.items[0].id],
        destParent: exportSrcDir,
        folderName: "nested-in-source",
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/scope + keepScope filter", () => {
  beforeEach(async () => {
    const db = getDb();
    db.prepare("DELETE FROM photos").run();
    db.prepare("DELETE FROM folders").run();
    db.prepare("DELETE FROM keep_scope").run();
  });

  it("restricts feed/count to the stored scope, any size, no URL cap", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const ids = scanBody.items.map((i) => i.id);
    // Keep only the first photo.
    const setRes = await fetch(`${srv.base}/api/scope`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [ids[0]] }),
    });
    expect(setRes.status).toBe(200);
    expect((await setRes.json()).count).toBe(1);

    const filter = encodeURIComponent(JSON.stringify({ keepScope: true }));
    const countRes = await fetch(
      `${srv.base}/api/photos/count?filter=${filter}`
    );
    expect((await countRes.json()).count).toBe(1);

    const feedRes = await fetch(
      `${srv.base}/api/feed?groupBy=folder&after=100&filter=${filter}`
    );
    const feed = await feedRes.json();
    const feedIds = feed.items
      .filter((i) => i.kind !== undefined)
      .map((i) => i.id);
    expect(feedIds).toEqual([ids[0]]);
  });

  it("accepts a scope far larger than the old 5000 cap", async () => {
    const big = Array.from({ length: 15000 }, (_, i) => i + 1);
    const res = await fetch(`${srv.base}/api/scope`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: big }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).count).toBe(15000);
  });

  it("clears the scope on an empty POST", async () => {
    await fetch(`${srv.base}/api/scope`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [1, 2, 3] }),
    });
    const res = await fetch(`${srv.base}/api/scope`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [] }),
    });
    expect((await res.json()).count).toBe(0);
  });
});

describe("folderPath focus filter (end-to-end)", () => {
  beforeEach(async () => {
    const db = getDb();
    db.prepare("DELETE FROM photos").run();
    db.prepare("DELETE FROM folders").run();
  });

  it("scopes the count to the focused folder; a bogus path matches nothing", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const total = scanBody.items.length;
    expect(total).toBeGreaterThan(0);

    const focus = encodeURIComponent(JSON.stringify({ folderPath: photosDir }));
    const scoped = await fetch(`${srv.base}/api/photos/count?filter=${focus}`);
    expect((await scoped.json()).count).toBe(total);

    const bogus = encodeURIComponent(
      JSON.stringify({ folderPath: photosDir + "-nope" })
    );
    const none = await fetch(`${srv.base}/api/photos/count?filter=${bogus}`);
    expect((await none.json()).count).toBe(0);
  });

  it("rejects a non-string/empty folderPath with 400", async () => {
    for (const bad of [123, ""]) {
      const filter = encodeURIComponent(JSON.stringify({ folderPath: bad }));
      const res = await fetch(`${srv.base}/api/photos/count?filter=${filter}`);
      expect(res.status).toBe(400);
    }
  });
});

describe("GET /api/albums/timeline", () => {
  beforeEach(async () => {
    const db = getDb();
    db.prepare("DELETE FROM photos").run();
    db.prepare("DELETE FROM folders").run();
  });

  it("returns the working set as a time-ordered timeline", async () => {
    await scan(srv.base, photosDir);
    const res = await fetch(`${srv.base}/api/albums/timeline`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.photos)).toBe(true);
    expect(body.photos.length).toBeGreaterThan(0);
    expect(body).toHaveProperty("truncated");
    const ts = body.photos.map((p) => p.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(body.photos[0]).toHaveProperty("id");
    expect(body.photos[0]).toHaveProperty("mtimeMs");
  });

  it("400s on a malformed filter param", async () => {
    const res = await fetch(`${srv.base}/api/albums/timeline?filter=not-json`);
    expect(res.status).toBe(400);
  });

  it("honors a smaller limit and echoes it back", async () => {
    await scan(srv.base, photosDir);
    const res = await fetch(`${srv.base}/api/albums/timeline?limit=2`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBe(2);
    expect(body.photos.length).toBeLessThanOrEqual(2);
  });

  it("clamps an over-large limit to the hard ceiling (200000)", async () => {
    await scan(srv.base, photosDir);
    const res = await fetch(`${srv.base}/api/albums/timeline?limit=999999999`);
    const body = await res.json();
    expect(body.limit).toBe(200000);
  });

  it("falls back to the default limit on a non-numeric value", async () => {
    await scan(srv.base, photosDir);
    const res = await fetch(`${srv.base}/api/albums/timeline?limit=abc`);
    const body = await res.json();
    expect(body.limit).toBe(2000);
  });
});

describe("POST /api/albums/materialize", () => {
  let srcDir;
  let destDir;

  beforeEach(async () => {
    const db = getDb();
    db.prepare("DELETE FROM photos").run();
    db.prepare("DELETE FROM folders").run();
    srcDir = await mkdtemp(join(tmpdir(), "ag-mat-src-"));
    destDir = await mkdtemp(join(tmpdir(), "ag-mat-dest-"));
    for (const [name, shade] of [
      ["a.jpg", 5],
      ["b.jpg", 6],
      ["c.jpg", 7],
    ]) {
      await sharp({
        create: {
          width: 20,
          height: 20,
          channels: 3,
          background: { r: shade, g: shade, b: shade },
        },
      })
        .jpeg()
        .toFile(join(srcDir, name));
    }
  });

  afterEach(async () => {
    await rm(srcDir, { recursive: true, force: true });
    await rm(destDir, { recursive: true, force: true });
  });

  it("runs as a background job; move:false copies and leaves sources untouched", async () => {
    const scanBody = await scan(srv.base, srcDir);
    const ids = scanBody.items.map((i) => i.id);
    const res = await fetch(`${srv.base}/api/albums/materialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        destParent: destDir,
        move: false,
        albums: [
          { name: "2026-01-01", photoIds: ids.slice(0, 2) },
          { name: "2026-01-05", photoIds: ids.slice(2) },
        ],
      }),
    });
    expect(res.status).toBe(202);
    const { jobId } = await res.json();
    expect(typeof jobId).toBe("string");

    const job = await waitJob(jobId);
    expect(job.status).toBe("done");
    expect(job.type).toBe("materialize");
    expect(job.result.move).toBe(false);
    expect(job.result.albums).toHaveLength(2);
    expect(job.result.albums[0].copied).toBe(2);
    expect(job.result.albums[1].copied).toBe(1);
    expect((await readdir(join(destDir, "2026-01-01"))).length).toBe(2);
    expect((await readdir(join(destDir, "2026-01-05"))).length).toBe(1);
    // Sources untouched.
    expect((await readdir(srcDir)).sort()).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
  });

  it("defaults to move: sources are removed and the index is repointed", async () => {
    const scanBody = await scan(srv.base, srcDir);
    const ids = scanBody.items.map((i) => i.id);
    const res = await fetch(`${srv.base}/api/albums/materialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        destParent: destDir,
        albums: [{ name: "2026-01-01", photoIds: ids }],
      }),
    });
    expect(res.status).toBe(202);
    const job = await waitJob((await res.json()).jobId);

    expect(job.status).toBe("done");
    expect(job.result.move).toBe(true);
    expect(job.result.albums[0].moved).toBe(3);
    expect(job.result.manifest).toHaveLength(3);
    // Sources gone; dest populated.
    expect((await readdir(srcDir)).sort()).toEqual([]);
    expect((await readdir(join(destDir, "2026-01-01"))).length).toBe(3);
  });

  it("cancel mid-run: fully-processed albums stay undoable via result.manifest", async () => {
    const scanBody = await scan(srv.base, srcDir);
    const ids = scanBody.items.map((i) => i.id);
    const res = await fetch(`${srv.base}/api/albums/materialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        destParent: destDir,
        albums: [
          { name: "album-1", photoIds: [ids[0]] },
          { name: "album-2", photoIds: [ids[1]] },
          { name: "album-3", photoIds: [ids[2]] },
        ],
      }),
    });
    expect(res.status).toBe(202);
    const { jobId } = await res.json();

    // Cancel right away — the async job hasn't necessarily processed
    // album-1 yet, but whichever albums DO land before the abort check
    // fires must be reflected, undoably, in the terminal job's result.
    await fetch(`${srv.base}/api/jobs/${jobId}/cancel`, { method: "POST" });
    const job = await waitJob(jobId);

    expect(job.status).toBe("canceled");
    // Only meaningful if at least one album had already been moved when the
    // cancel was observed — assert the invariant, not an exact count, since
    // the exact cut point is a race between the fetch and the async loop.
    if (job.result) {
      expect(job.result.move).toBe(true);
      expect(Array.isArray(job.result.manifest)).toBe(true);
      // Every manifest entry's "to" must actually exist on disk and its
      // "from" must be gone — a real, undoable move, not a phantom entry.
      for (const entry of job.result.manifest) {
        expect(existsSync(entry.to)).toBe(true);
      }
    }
  });

  it("400s on an empty albums array", async () => {
    const res = await fetch(`${srv.base}/api/albums/materialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ destParent: destDir, albums: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("400s on an album with no photos", async () => {
    const res = await fetch(`${srv.base}/api/albums/materialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        destParent: destDir,
        albums: [{ name: "empty", photoIds: [] }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses an album name that attempts path traversal", async () => {
    const scanBody = await scan(srv.base, srcDir);
    const res = await fetch(`${srv.base}/api/albums/materialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        destParent: destDir,
        albums: [{ name: "../escape", photoIds: [scanBody.items[0].id] }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("materializes IN PLACE: destParent may be a scanned source folder (move)", async () => {
    // The in-place default (Slice A): materialize into a subfolder of the
    // folder the photos already live in. /api/export still forbids this
    // (guard relaxed for materialize only, via allowInsideSource).
    const scanBody = await scan(srv.base, srcDir);
    const ids = scanBody.items.map((i) => i.id);
    const res = await fetch(`${srv.base}/api/albums/materialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        destParent: srcDir, // same folder the photos already live in
        albums: [{ name: "2026-01-01", photoIds: ids.slice(0, 2) }],
        // move defaults to true
      }),
    });
    expect(res.status).toBe(202);
    const job = await waitJob((await res.json()).jobId);
    expect(job.status).toBe("done");
    expect(job.result.move).toBe(true);
    // The two photos now live inside srcDir/2026-01-01 …
    expect(await readdir(join(srcDir, "2026-01-01"))).toHaveLength(2);
    // … and were moved out of the source root (only the third .jpg remains).
    const rootNow = await readdir(srcDir);
    expect(rootNow).toContain("2026-01-01");
    expect(rootNow.filter((n) => n.endsWith(".jpg"))).toHaveLength(1);
  });
});

describe("POST /api/albums/undo-move", () => {
  let srcDir;
  let destDir;

  beforeEach(async () => {
    const db = getDb();
    db.prepare("DELETE FROM photos").run();
    db.prepare("DELETE FROM folders").run();
    srcDir = await mkdtemp(join(tmpdir(), "ag-undo-src-"));
    destDir = await mkdtemp(join(tmpdir(), "ag-undo-dest-"));
    for (const [name, shade] of [
      ["a.jpg", 5],
      ["b.jpg", 6],
    ]) {
      await sharp({
        create: {
          width: 20,
          height: 20,
          channels: 3,
          background: { r: shade, g: shade, b: shade },
        },
      })
        .jpeg()
        .toFile(join(srcDir, name));
    }
  });

  afterEach(async () => {
    await rm(srcDir, { recursive: true, force: true });
    await rm(destDir, { recursive: true, force: true });
  });

  /** Materialize (move, default) srcDir's photos into one album; return the manifest. */
  async function moveIntoAlbum(name) {
    const scanBody = await scan(srv.base, srcDir);
    const ids = scanBody.items.map((i) => i.id);
    const res = await fetch(`${srv.base}/api/albums/materialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        destParent: destDir,
        albums: [{ name, photoIds: ids }],
      }),
    });
    const job = await waitJob((await res.json()).jobId);
    expect(job.status).toBe("done");
    return job.result.manifest;
  }

  it("restores every moved photo to its original location and repoints the index", async () => {
    const manifest = await moveIntoAlbum("2026-01-01");
    // Sanity: the move actually happened.
    expect((await readdir(srcDir)).sort()).toEqual([]);
    expect((await readdir(join(destDir, "2026-01-01"))).sort()).toEqual([
      "a.jpg",
      "b.jpg",
    ]);

    const res = await fetch(`${srv.base}/api/albums/undo-move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest }),
    });
    expect(res.status).toBe(202);
    const { jobId } = await res.json();
    const job = await waitJob(jobId);

    expect(job.status).toBe("done");
    expect(job.type).toBe("undo-move");
    expect(job.result).toEqual({ restored: 2, skipped: 0 });

    // Originals restored, dest emptied.
    expect((await readdir(srcDir)).sort()).toEqual(["a.jpg", "b.jpg"]);
    expect((await readdir(join(destDir, "2026-01-01"))).sort()).toEqual([]);

    // Index repointed back.
    const db = getDb();
    for (const entry of manifest) {
      expect(getPhotoById(db, entry.id).path).toBe(entry.from);
    }
  });

  it("skips an entry whose destination no longer exists, without throwing", async () => {
    const manifest = await moveIntoAlbum("2026-01-02");
    // Simulate the user deleting/renaming the moved file via Finder.
    await rm(manifest[0].to);

    const res = await fetch(`${srv.base}/api/albums/undo-move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest }),
    });
    const job = await waitJob((await res.json()).jobId);

    expect(job.status).toBe("done");
    expect(job.result).toEqual({ restored: 1, skipped: 1 });
  });

  it("400s on an empty manifest", async () => {
    const res = await fetch(`${srv.base}/api/albums/undo-move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("400s on a manifest entry missing id/from/to", async () => {
    const res = await fetch(`${srv.base}/api/albums/undo-move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: [{ from: "/a", to: "/b" }] }),
    });
    expect(res.status).toBe(400);
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

  it("empty groupBy: no nodes, but reports the real matching total (flat feed)", async () => {
    await scan(srv.base, photosDir);
    const res = await fetch(`${srv.base}/api/tree`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes).toEqual([]);
    // Flat feed has no hierarchy, but the sidebar header still needs a real count.
    expect(body.total).toBeGreaterThan(0);
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

describe("GET /api/group/sample", () => {
  beforeEach(async () => {
    const db = getDb();
    db.prepare("DELETE FROM photos").run();
    db.prepare("DELETE FROM folders").run();
  });

  /** Insert `count` synthetic photo rows directly into `folderId`, spread
   * one second apart starting at `baseMs` — fast (no sharp round-trip) since
   * this endpoint only reads DB rows, never pixels. */
  function insertSyntheticPhotos(db, folderId, count, baseMs) {
    const insert = db.prepare(
      `INSERT INTO photos (folder_id, filename, size, mtime, taken_at, kind, stale)
       VALUES (?, ?, 1000, ?, ?, 'photo', 0)`
    );
    const insertMany = db.transaction((n) => {
      for (let i = 0; i < n; i++) {
        const t = baseMs + i * 1000;
        insert.run(folderId, `synthetic_${i}.jpg`, t, t);
      }
    });
    insertMany(count);
  }

  it("count/samples match the same-ordered slice of GET /api/feed's group order", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const db = getDb();
    const folder = db
      .prepare("SELECT id FROM folders WHERE abs_path = ?")
      .get(photosDir);
    insertSyntheticPhotos(db, folder.id, 40, Date.UTC(2024, 0, 1));

    const path = encodeURIComponent(
      JSON.stringify([{ dimension: "folder", value: photosDir }])
    );

    // Single folder ⇒ the whole feed IS the group; pull it in full composite
    // order as the ground truth to slice against.
    const feedRes = await fetch(
      `${srv.base}/api/feed?groupBy=folder&after=1000`
    );
    const feedBody = await feedRes.json();
    const orderedIds = feedBody.items.map((i) => i.id);
    // Whatever the fixture folder holds at scan time (other describe blocks
    // may have permanently added sibling files on disk) + the 40 synthetic
    // rows just inserted.
    expect(orderedIds.length).toBe(scanBody.items.length + 40);

    const sampleRes = await fetch(
      `${srv.base}/api/group/sample?groupBy=folder&path=${path}&slots=5`
    );
    expect(sampleRes.status).toBe(200);
    const sampleBody = await sampleRes.json();
    expect(sampleBody.count).toBe(orderedIds.length);
    expect(sampleBody.samples).toHaveLength(5);

    const { offsets, gaps } = sampleOffsets(orderedIds.length, 5);
    const expectedIds = offsets.map((o) => orderedIds[o]);
    expect(sampleBody.samples.map((s) => s.id)).toEqual(expectedIds);
    sampleBody.samples.forEach((s, i) => {
      expect(s.offset).toBe(offsets[i]);
      expect(s.gapAfter).toBe(gaps.includes(i));
    });
  });

  it("returns every item with no gaps when count <= slots", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const path = encodeURIComponent(
      JSON.stringify([{ dimension: "folder", value: photosDir }])
    );
    const res = await fetch(
      `${srv.base}/api/group/sample?groupBy=folder&path=${path}&slots=50`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(scanBody.items.length);
    expect(body.samples).toHaveLength(scanBody.items.length);
    expect(body.samples.every((s) => s.gapAfter === false)).toBe(true);
  });

  it("respects filter/sort scoping like the feed does", async () => {
    await scan(srv.base, photosDir);
    const db = getDb();
    const ids = db.prepare("SELECT id FROM photos ORDER BY id").all();
    db.prepare("UPDATE photos SET rating = 5 WHERE id = ?").run(ids[0].id);
    const path = encodeURIComponent(
      JSON.stringify([{ dimension: "folder", value: photosDir }])
    );
    const filter = encodeURIComponent(JSON.stringify({ minRating: 5 }));
    const res = await fetch(
      `${srv.base}/api/group/sample?groupBy=folder&path=${path}&slots=12&filter=${filter}`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.samples.map((s) => s.id)).toEqual([ids[0].id]);
  });

  it("400s when path is missing", async () => {
    const res = await fetch(`${srv.base}/api/group/sample?groupBy=folder`);
    expect(res.status).toBe(400);
  });

  it("400s on an unknown groupBy dimension", async () => {
    const path = encodeURIComponent(
      JSON.stringify([{ dimension: "folder", value: photosDir }])
    );
    const res = await fetch(
      `${srv.base}/api/group/sample?groupBy=bogus&path=${path}`
    );
    expect(res.status).toBe(400);
  });

  it("400s on malformed path JSON", async () => {
    const res = await fetch(
      `${srv.base}/api/group/sample?groupBy=folder&path=not-json`
    );
    expect(res.status).toBe(400);
  });
});

describe("jobs endpoints", () => {
  it("GET /api/jobs returns {jobs: []} initially", async () => {
    const res = await fetch(`${srv.base}/api/jobs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ jobs: [] });
  });

  it("GET /api/jobs lists a job created via the registry, without a controller field", async () => {
    const job = registry.create("scan", { label: "Test scan", total: 3 });
    try {
      const res = await fetch(`${srv.base}/api/jobs`);
      const body = await res.json();
      const entry = body.jobs.find((j) => j.id === job.id);
      expect(entry).toBeDefined();
      expect(entry.status).toBe("running");
      expect(entry.label).toBe("Test scan");
      expect(entry.controller).toBeUndefined();
    } finally {
      registry.cancel(job.id);
      registry.fail(job.id, new Error("test cleanup"));
      registry.dismiss(job.id);
    }
  });

  it("POST /api/jobs/:id/cancel 404s for an unknown id", async () => {
    const res = await fetch(`${srv.base}/api/jobs/job-does-not-exist/cancel`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("POST /api/jobs/:id/cancel 200s for a running job", async () => {
    const job = registry.create("scan", { label: "Cancel me" });
    const res = await fetch(`${srv.base}/api/jobs/${job.id}/cancel`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(job.controller.signal.aborted).toBe(true);
    // Simulate the aborted operation reporting back, then clean up.
    registry.fail(job.id, new Error("canceled"));
    registry.dismiss(job.id);
  });

  it("POST /api/jobs/:id/dismiss 409s while the job is running", async () => {
    const job = registry.create("scan", { label: "Still running" });
    try {
      const res = await fetch(`${srv.base}/api/jobs/${job.id}/dismiss`, {
        method: "POST",
      });
      expect(res.status).toBe(409);
    } finally {
      registry.cancel(job.id);
      registry.fail(job.id, new Error("test cleanup"));
      registry.dismiss(job.id);
    }
  });

  it("POST /api/jobs/:id/dismiss 200s for a terminal job and removes it", async () => {
    const job = registry.create("scan", { label: "Done" });
    registry.finish(job.id, { count: 1 });
    const res = await fetch(`${srv.base}/api/jobs/${job.id}/dismiss`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(registry.get(job.id)).toBeUndefined();
  });

  it("POST /api/jobs/:id/dismiss 404s for an unknown id", async () => {
    const res = await fetch(`${srv.base}/api/jobs/job-does-not-exist/dismiss`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});

describe("manual burst stacks (issue #24)", () => {
  async function feedItems() {
    const res = await fetch(`${srv.base}/api/feed?groupBy=folder&after=100`);
    const { items } = await res.json();
    return items.filter((i) => typeof i.id === "number");
  }

  beforeEach(async () => {
    const db = getDb();
    db.prepare("DELETE FROM manual_stacks").run();
    db.prepare("UPDATE photos SET no_auto_stack = 0").run();
  });

  it("creates a manual stack and exposes manualStackId on the feed", async () => {
    await scan(srv.base, photosDir);
    const ids = (await feedItems()).map((i) => i.id).slice(0, 2);
    const res = await fetch(`${srv.base}/api/stacks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    expect(res.status).toBe(200);
    const { groupId, count } = await res.json();
    expect(count).toBe(2);

    const after = await feedItems();
    const grouped = after.filter((i) => ids.includes(i.id));
    expect(grouped.every((i) => i.manualStackId === groupId)).toBe(true);
  });

  it("dissolve sets keepSeparate on the feed", async () => {
    await scan(srv.base, photosDir);
    const ids = (await feedItems()).map((i) => i.id).slice(0, 2);
    const res = await fetch(`${srv.base}/api/stacks/dissolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    expect((await res.json()).count).toBe(2);
    const after = await feedItems();
    expect(
      after.filter((i) => ids.includes(i.id)).every((i) => i.keepSeparate)
    ).toBe(true);
  });

  it("rejects a manual stack of fewer than 2 photos", async () => {
    await scan(srv.base, photosDir);
    const ids = (await feedItems()).map((i) => i.id).slice(0, 1);
    const res = await fetch(`${srv.base}/api/stacks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    expect(res.status).toBe(400);
  });
});

describe("video support (ffmpeg) — scan, thumb, meta, Range", () => {
  let videoDir;
  let hasFfmpeg;

  beforeAll(async () => {
    const { default: ffmpegPath } = await import("ffmpeg-static");
    hasFfmpeg = await new Promise((resolve) => {
      if (!ffmpegPath) return resolve(false);
      const c = spawn(ffmpegPath, ["-version"], { stdio: "ignore" });
      c.on("error", () => resolve(false));
      c.on("close", (code) => resolve(code === 0));
    });
    if (!hasFfmpeg) return;
    videoDir = await mkdtemp(join(tmpdir(), "ag-video-"));
    await new Promise((resolve, reject) => {
      const c = spawn(
        ffmpegPath,
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc=duration=2:size=320x240:rate=10",
          join(videoDir, "clip.mp4"),
        ],
        { stdio: "ignore" }
      );
      c.on("error", reject);
      c.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`gen ${code}`))
      );
    });
  });

  afterAll(async () => {
    if (videoDir) await rm(videoDir, { recursive: true, force: true });
  });

  it("scans an mp4 as kind:'video', posters it, probes duration, and streams Range", async () => {
    if (!hasFfmpeg) return; // ffmpeg-static binary unavailable → skip
    const body = await scan(srv.base, videoDir);
    const id = body.items[0].id;
    expect(body.items[0].kind).toBe("video");

    // Poster-frame thumbnail is a real JPEG.
    const thumb = await fetch(`${srv.base}/api/thumb/${id}?size=120`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toContain("image/jpeg");
    const bytes = new Uint8Array(await thumb.arrayBuffer());
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);

    // ffprobe metadata: duration + dimensions populated.
    const meta = await (await fetch(`${srv.base}/api/meta?ids=${id}`)).json();
    expect(meta[0].duration).toBeGreaterThan(1.5);
    expect(meta[0].width).toBe(320);
    expect(meta[0].height).toBe(240);

    // Full-file request advertises Range support.
    const full = await fetch(`${srv.base}/api/image/${id}`);
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("content-type")).toBe("video/mp4");
    const totalSize = Number(full.headers.get("content-length"));

    // A byte-range request gets 206 with the right slice headers.
    const ranged = await fetch(`${srv.base}/api/image/${id}`, {
      headers: { Range: "bytes=0-99" },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(`bytes 0-99/${totalSize}`);
    expect(ranged.headers.get("content-length")).toBe("100");

    // An unsatisfiable range → 416.
    const bad = await fetch(`${srv.base}/api/image/${id}`, {
      headers: { Range: `bytes=${totalSize + 10}-${totalSize + 20}` },
    });
    expect(bad.status).toBe(416);
  });
});

describe("GET /api/system/paths", () => {
  it("returns a non-empty home and a desktop under it", async () => {
    const res = await fetch(`${srv.base}/api/system/paths`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.home).toBe("string");
    expect(body.home.length).toBeGreaterThan(0);
    expect(body.desktop).toMatch(/Desktop$/);
  });
});

describe("GET /api/system/same-volume", () => {
  it("returns true for two paths under the same temp root", async () => {
    const root = await mkdtemp(join(tmpdir(), "ag-samevol-"));
    const a = join(root, "a");
    const b = join(root, "b");
    await mkdir(a);
    await mkdir(b);
    const res = await fetch(
      `${srv.base}/api/system/same-volume?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sameVolume).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it("returns null when a path doesn't exist, instead of 500ing", async () => {
    const root = await mkdtemp(join(tmpdir(), "ag-samevol-"));
    const missing = join(root, "does-not-exist");
    const res = await fetch(
      `${srv.base}/api/system/same-volume?a=${encodeURIComponent(root)}&b=${encodeURIComponent(missing)}`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sameVolume).toBeNull();
    await rm(root, { recursive: true, force: true });
  });
});
