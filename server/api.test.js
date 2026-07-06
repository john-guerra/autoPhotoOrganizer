import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createApp } from "./index.js";
import { _resetSession } from "./api.js";
import { _resetForTest } from "./ratings.js";

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

let photosDir;
let cacheDir;
let srv;

beforeAll(async () => {
  photosDir = await mkdtemp(join(tmpdir(), "ag-photos-"));
  cacheDir = await mkdtemp(join(tmpdir(), "ag-cache-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetForTest();
  _resetSession();

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
  it("returns sorted image items with ids and ignores dirs", async () => {
    const res = await fetch(`${srv.base}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: photosDir }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(4); // 3 jpg + 1 png, subdir excluded
    expect(body.items[0].id).toBe(0);
    const names = body.items.map((i) => i.name);
    expect(names).toEqual([...names].sort()); // sorted by name
    expect(body.items[0]).toHaveProperty("size");
    expect(body.items[0]).toHaveProperty("mtimeMs");
    expect(typeof body.elapsedMs).toBe("number");
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

describe("GET /api/thumb/:id", () => {
  it("generates a JPEG, then serves from cache on the second request", async () => {
    // Ensure session is populated.
    await fetch(`${srv.base}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: photosDir }),
    });

    const first = await fetch(`${srv.base}/api/thumb/0?size=64`);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("image/jpeg");
    expect(first.headers.get("x-cache")).toBe("miss");
    const bytes = Buffer.from(await first.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    // JPEG magic number.
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);

    // A thumb file now exists in the cache dir.
    const cached = await readdir(join(cacheDir, "cache", "thumbs"));
    expect(cached.some((f) => f.endsWith(".jpg"))).toBe(true);

    const second = await fetch(`${srv.base}/api/thumb/0?size=64`);
    expect(second.status).toBe(200);
    expect(second.headers.get("x-cache")).toBe("hit");
  });

  it("404s an out-of-range id", async () => {
    const res = await fetch(`${srv.base}/api/thumb/999?size=64`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/image/:id", () => {
  it("streams the original bytes", async () => {
    const res = await fetch(`${srv.base}/api/image/0`);
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
  });
});

describe("ratings round-trip", () => {
  it("persists a rating keyed by absolute path across a rescan", async () => {
    const set = await fetch(`${srv.base}/api/rating`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, rating: 4 }),
    });
    expect(set.status).toBe(200);

    // Rescan (new session) — rating must reattach by path.
    await fetch(`${srv.base}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: photosDir }),
    });
    const res = await fetch(`${srv.base}/api/ratings`);
    const body = await res.json();
    expect(body.byId["1"]).toBe(4);

    // Clearing with 0 removes it.
    await fetch(`${srv.base}/api/rating`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, rating: 0 }),
    });
    const after = await (await fetch(`${srv.base}/api/ratings`)).json();
    expect(after.byId["1"]).toBeUndefined();
  });

  it("rejects an out-of-range rating", async () => {
    const res = await fetch(`${srv.base}/api/rating`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 0, rating: 9 }),
    });
    expect(res.status).toBe(400);
  });
});
