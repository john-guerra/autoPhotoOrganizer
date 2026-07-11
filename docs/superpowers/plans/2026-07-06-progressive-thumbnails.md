# Progressive Thumbnails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the camera's embedded EXIF/JPEG preview instantly as a low-res "blur-up" placeholder for every grid tile, swap in the real sharp-decoded thumbnail once ready in the background, and extend file scanning to discover RAW files (via their embedded preview only — no full RAW decode).

**Architecture:** `NodeProcessingService.extractPreview` (currently an unimplemented stub) is wired via `exifr.thumbnail()` — already a project dependency, no new dependency needed — and works identically for JPEG and RAW inputs. A new `GET /api/preview/:id` route serves it, uncached (cheap enough to re-read; only matters once per photo). `Thumb.svelte` requests this fast tier only if the full thumbnail hasn't already loaded within a short delay, avoiding doubled server load on already-cached (warm) views while still delivering instant paint on a cold scan.

**Tech Stack:** Node.js + sharp + exifr (server), Svelte + Vite (client), vitest.

## Global Constraints

- ESM everywhere (`"type": "module"`), no TypeScript — plain JS with JSDoc types.
- Tests: vitest, colocated as `*.test.js` next to sources.
- No automated tests for Svelte components (`Thumb.svelte`) — manual-only verification, per this project's established convention (`docs/ROADMAP.md`'s working agreement).
- No comments describing "what" code does — only non-obvious "why" comments.
- Full RAW decoding, video, and HEIC support are explicitly out of scope — a RAW photo's only available image throughout this app remains its embedded preview.
- Read-only against real test data during manual validation (Task 6) — per `docs/TEST_FOLDERS.local.md`'s working agreement.

Full design: `docs/superpowers/specs/2026-07-06-progressive-thumbnails-design.md`.

---

### Task 1: Server — `extractPreview`, RAW file discovery, `thumbnail()`'s RAW guard

**Files:**

- Modify: `server/processing/NodeProcessingService.js`
- Modify: `server/processing/ProcessingService.test.js`
- Create: `server/processing/NodeProcessingService.test.js`

**Interfaces:**

- Consumes: `exifr.thumbnail(path)` (already a dependency) — resolves to a `Buffer` if the file has an embedded preview, `undefined` otherwise; throws on genuine I/O failure (confirmed by direct testing during design: `ENOENT` for a missing file).
- Produces: `NodeProcessingService.extractPreview(file)` returning `Promise<{data: Buffer, source: "embedded"} | null>` (null = no embedded preview, a normal outcome — not an error). `NodeProcessingService.scan(dir)` now also discovers RAW files, tagging them `kind: "raw"` (vs `kind: "image"` for the existing formats) — `MediaFile.kind`'s type already anticipated this (`"image"|"raw"|"video"` in `ProcessingService.js`), just unused until now. `NodeProcessingService.thumbnail(file, size)` now throws a new, named `RawDecodeUnavailableError` for a RAW extension instead of attempting (and failing) a sharp decode. Task 2/3/5 consume these.

- [ ] **Step 1: Write the failing tests**

Create `server/processing/NodeProcessingService.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { NodeProcessingService } from "./NodeProcessingService.js";

let dir;
let svc;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ag-processing-"));
  svc = new NodeProcessingService();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scan — RAW file discovery", () => {
  it("discovers RAW extensions with kind:'raw', existing formats with kind:'image'", async () => {
    await writeFile(join(dir, "a.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    await writeFile(join(dir, "b.cr2"), Buffer.from([0]));
    await writeFile(join(dir, "c.NEF"), Buffer.from([0])); // case-insensitive
    await writeFile(join(dir, "d.txt"), Buffer.from([0])); // not media, skipped

    const files = await svc.scan(dir);
    const byName = Object.fromEntries(files.map((f) => [f.name, f.kind]));
    expect(byName).toEqual({
      "a.jpg": "image",
      "b.cr2": "raw",
      "c.NEF": "raw",
    });
    expect(files.some((f) => f.name === "d.txt")).toBe(false);
  });
});

describe("thumbnail — RAW guard", () => {
  it("throws RawDecodeUnavailableError for a RAW extension, without attempting a sharp decode", async () => {
    const raw = join(dir, "photo.cr2");
    await writeFile(raw, Buffer.from([0])); // not valid image data — if sharp were
    // attempted, it would throw a DIFFERENT (generic decode-failure) error, not this one
    await expect(svc.thumbnail(raw, 320)).rejects.toThrow(/RAW/);
    await expect(svc.thumbnail(raw, 320)).rejects.toMatchObject({
      name: "RawDecodeUnavailableError",
    });
  });

  it("still fully decodes a real JPEG (regression check)", async () => {
    const jpg = join(dir, "photo.jpg");
    await sharp({
      create: { width: 400, height: 300, channels: 3, background: "red" },
    })
      .jpeg()
      .toFile(jpg);
    const result = await svc.thumbnail(jpg, 100);
    expect(result.source).toBe("decoded");
    expect(result.width).toBeLessThanOrEqual(100);
  });
});

describe("extractPreview", () => {
  it("returns null for a file with no embedded EXIF thumbnail", async () => {
    const jpg = join(dir, "no-exif.jpg");
    await sharp({
      create: { width: 200, height: 150, channels: 3, background: "blue" },
    })
      .jpeg()
      .toFile(jpg);
    // A synthetically-created JPEG carries no EXIF/thumbnail segment — this
    // exercises the "no embedded preview" branch. Extracting a REAL embedded
    // thumbnail needs a genuine camera-sourced fixture, which this project's
    // established testing convention defers to live manual validation
    // (Task 6) rather than constructing one by hand — see the design spec's
    // own note on this.
    const result = await svc.extractPreview(jpg);
    expect(result).toBeNull();
  });

  it("propagates a genuine I/O error for an unreadable file", async () => {
    await expect(
      svc.extractPreview(join(dir, "does-not-exist.jpg"))
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/processing/NodeProcessingService.test.js`
Expected: FAIL — `RawDecodeUnavailableError` doesn't exist yet, `scan()` doesn't recognize RAW extensions, `extractPreview` still throws `NotImplementedError` unconditionally.

- [ ] **Step 3: Implement the changes in `server/processing/NodeProcessingService.js`**

Replace the entire file with:

```js
import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import sharp from "sharp";
import exifr from "exifr";
import { ProcessingService } from "./ProcessingService.js";

class NotImplementedError extends Error {
  /** @param {string} method */
  constructor(method) {
    super(`NodeProcessingService.${method} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}

/** Thrown by thumbnail() for a RAW file — sharp can't decode most RAW
 * formats, so the full-resolution "slow tier" isn't available; a RAW
 * photo's embedded preview (see extractPreview) is its only available
 * image until a real RAW decoder is added as separate, future work. */
class RawDecodeUnavailableError extends Error {
  /** @param {string} file */
  constructor(file) {
    super(`full-resolution decode unavailable for RAW file: ${file}`);
    this.name = "RawDecodeUnavailableError";
  }
}

/**
 * Image extensions handled via the full sharp-decode path.
 */
export const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

/**
 * RAW extensions discovered by scan() and given kind:"raw" — their only
 * available image is the embedded preview (extractPreview); a full decode
 * (thumbnail()) is intentionally unavailable until a real RAW decoder is
 * added as separate, future work.
 */
export const RAW_EXTS = new Set([
  ".cr2",
  ".cr3",
  ".nef",
  ".arw",
  ".dng",
  ".orf",
  ".rw2",
  ".raf",
]);

/**
 * NodeProcessingService — the MVP implementation (sharp + exifr).
 *
 * v0.2 scope: images + RAW (embedded preview only). `videoThumb` remains
 * unimplemented until the ffmpeg engine is wired.
 */
export class NodeProcessingService extends ProcessingService {
  /**
   * Non-recursive scan: readdir the directory, keep image/RAW files, stat
   * each for the incremental-rescan key (size + mtimeMs). Sorted by name.
   * @override
   * @param {string} dir
   * @returns {Promise<import("./ProcessingService.js").MediaFile[]>}
   */
  async scan(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      const isImage = IMAGE_EXTS.has(ext);
      const isRaw = RAW_EXTS.has(ext);
      if (!isImage && !isRaw) continue;
      const path = join(dir, entry.name);
      const st = await stat(path);
      files.push({
        path,
        name: entry.name,
        size: st.size,
        mtimeMs: st.mtimeMs,
        kind: isRaw ? "raw" : "image",
      });
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    return files;
  }

  /**
   * Resize to `size` px longest edge (fit inside, no enlargement), auto-rotate
   * for EXIF orientation, encode JPEG q78. Unavailable for RAW — see
   * RawDecodeUnavailableError.
   * @override
   * @param {string} file
   * @param {number} size
   * @returns {Promise<import("./ProcessingService.js").PreviewResult>}
   */
  async thumbnail(file, size) {
    if (RAW_EXTS.has(extname(file).toLowerCase())) {
      throw new RawDecodeUnavailableError(file);
    }
    const pipeline = sharp(file)
      .rotate()
      .resize(size, size, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 78 });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, source: "decoded" };
  }

  /**
   * Embedded EXIF/JPEG preview — a few KB, read near the file header rather
   * than decoding the whole (possibly multi-megabyte, possibly RAW) source.
   * Works identically for JPEG and RAW inputs — exifr reads an embedded
   * preview the same way regardless of container format. Returns null when
   * the file has no embedded preview (some cameras/edited files strip it) —
   * a normal, expected outcome, not an error; genuine I/O failures still
   * throw.
   * @override
   * @param {string} file
   * @returns {Promise<import("./ProcessingService.js").PreviewResult|null>}
   */
  async extractPreview(file) {
    const data = await exifr.thumbnail(file);
    if (!data) return null;
    return { data, source: "embedded" };
  }

  /**
   * Video poster frames — the ffmpeg engine lands later.
   * @override
   */
  async videoThumb(_file) {
    throw new NotImplementedError("videoThumb");
  }

  /**
   * Read capture metadata for a batch of files: pixel dimensions via a sharp
   * header read (~0.2 ms/file, works for every supported format) and capture
   * date via exifr. Width/height are swapped for rotated EXIF orientations so
   * they describe the image as DISPLAYED — what the justified layout needs.
   * Best-effort: fields are omitted for files that fail to parse (this
   * already covers RAW today, since sharp can't read most RAW headers —
   * unchanged by this task).
   * @override
   * @param {string[]} files
   * @returns {Promise<import("./ProcessingService.js").MediaMetadata[]>}
   */
  async metadata(files) {
    return Promise.all(
      files.map(async (path) => {
        /** @type {import("./ProcessingService.js").MediaMetadata} */
        const meta = { path };
        try {
          const info = await sharp(path).metadata();
          // Orientations 5-8 are 90°/270° rotations: displayed dims are swapped.
          const rotated = (info.orientation ?? 1) >= 5;
          meta.width = rotated ? info.height : info.width;
          meta.height = rotated ? info.width : info.height;
        } catch {
          /* dimensions unavailable */
        }
        try {
          const exif = await exifr.parse(path, {
            pick: ["DateTimeOriginal", "CreateDate"],
          });
          const createDate = exif?.DateTimeOriginal || exif?.CreateDate;
          if (createDate) meta.createDate = createDate;
        } catch {
          /* no EXIF */
        }
        return meta;
      })
    );
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/processing/NodeProcessingService.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Update the existing `ProcessingService.test.js` smoke test**

`extractPreview` no longer always throws "not implemented" — only `videoThumb` still does. Change `server/processing/ProcessingService.test.js`'s third test from:

```js
it("NodeProcessingService still throws on the not-yet-implemented engines", async () => {
  const svc = new NodeProcessingService();
  // RAW embedded-preview extraction and video poster frames come later.
  await expect(svc.extractPreview("/tmp/x.cr2")).rejects.toThrow(
    /not implemented/i
  );
  await expect(svc.videoThumb("/tmp/x.mov")).rejects.toThrow(
    /not implemented/i
  );
});
```

to:

```js
it("NodeProcessingService still throws on the not-yet-implemented video engine", async () => {
  const svc = new NodeProcessingService();
  // Video poster frames come later; RAW/JPEG embedded-preview extraction
  // is implemented now (see NodeProcessingService.test.js).
  await expect(svc.videoThumb("/tmp/x.mov")).rejects.toThrow(
    /not implemented/i
  );
});
```

- [ ] **Step 6: Run the full server test suite to confirm no regressions**

Run: `npx vitest run server/`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/processing/NodeProcessingService.js server/processing/NodeProcessingService.test.js server/processing/ProcessingService.test.js
git commit -m "feat: implement extractPreview via exifr, discover RAW files in scan, guard thumbnail() against RAW"
```

---

### Task 2: Server — `GET /api/preview/:id` endpoint

**Files:**

- Modify: `server/api.js`
- Modify: `server/api.test.js`

**Interfaces:**

- Consumes: `processing.extractPreview(path)` from Task 1 — `Promise<{data: Buffer, source: "embedded"} | null>`.
- Produces: `GET /api/preview/:id` → the embedded preview's raw JPEG bytes (200), or 404 if the photo id is unknown or it has no embedded preview. Task 4's client wrapper consumes this.

- [ ] **Step 1: Write the failing tests**

Read the current `server/api.test.js` first (search for `describe("GET /api/feed"` to orient) and add, after whichever existing thumbnail-related test block you find (search for `"/api/thumb"` to locate it):

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/api.test.js -t "GET /api/preview"`
Expected: FAIL — both requests 404 with a generic Express "not found" (no route registered), not the route's own intentional 404 logic; distinguish by running with `-t` and observing the route doesn't exist (any assertion mismatch, or check via `curl`-equivalent manually if needed — the key signal is the route isn't registered yet).

- [ ] **Step 3: Implement the route**

In `server/api.js`, add this route immediately after the existing `GET /api/thumb/:id` route (find it by searching for `app.get("/api/thumb/:id"`):

```js
// --- Embedded preview (fast tier) ----------------------------------------
app.get("/api/preview/:id", async (req, res) => {
  const db = getDb();
  const it = getPhotoById(db, Number(req.params.id));
  if (!it) return res.status(404).end();

  res.set("Cache-Control", "public, max-age=31536000, immutable");
  res.type("image/jpeg");

  try {
    const preview = await processing.extractPreview(it.path);
    if (!preview) return res.status(404).end();
    res.send(preview.data);
  } catch (err) {
    res.status(500).json({ error: `preview failed: ${err.message}` });
  }
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/api.test.js -t "GET /api/preview"`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full server test suite**

Run: `npx vitest run server/`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/api.js server/api.test.js
git commit -m "feat: add GET /api/preview/:id endpoint for the fast embedded-preview tier"
```

---

### Task 3: Server — thread `kind` through the feed query

**Files:**

- Modify: `server/db/feed.js`
- Test: `server/db/feed.test.js`

**Interfaces:**

- Consumes: `photos.kind` (already stored by `upsertScan`, per `server/db/photos.js` and `server/db/schema.js` — this task only reads it back out, no schema change).
- Produces: every real item `getFeedPage`/`GET /api/feed` returns now includes `kind: "image"|"raw"`. Task 5's `Thumb.svelte` reads this to distinguish "no full-resolution tier available" (RAW) from a genuine transient failure.

- [ ] **Step 1: Write the failing test**

Add to `server/db/feed.test.js`, in the `describe("getFeedPage — composite ordering", ...)` block (or as its own small new `describe` right after it — read the current file to place it sensibly):

```js
describe("getFeedPage — kind", () => {
  it("includes each item's kind (image vs raw)", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/mixed", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.cr2", size: 1, mtimeMs: 1, kind: "raw" },
    ]);
    const { items } = getFeedPage(db, { groupBy: ["folder"], after: 10 });
    const byName = Object.fromEntries(items.map((i) => [i.name, i.kind]));
    expect(byName).toEqual({ "a.jpg": "image", "b.cr2": "raw" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/db/feed.test.js -t "kind"`
Expected: FAIL — `items[i].kind` is `undefined` (not yet selected/returned).

- [ ] **Step 3: Implement the changes in `server/db/feed.js`**

Change `rowToItem` (currently):

```js
function rowToItem(r, dims) {
  const groupValues = {};
  dims.forEach((d, i) => (groupValues[d.name] = r[`dim${i}`]));
  return {
    id: r.id,
    name: r.name,
    size: r.size,
    mtimeMs: r.mtimeMs,
    rating: r.rating,
    preferredCover: r.preferredCover === 1,
    width: r.width,
    height: r.height,
    takenAt: r.taken_at ? new Date(r.taken_at).toISOString() : null,
    groupValues,
  };
}
```

to:

```js
function rowToItem(r, dims) {
  const groupValues = {};
  dims.forEach((d, i) => (groupValues[d.name] = r[`dim${i}`]));
  return {
    id: r.id,
    name: r.name,
    size: r.size,
    mtimeMs: r.mtimeMs,
    rating: r.rating,
    preferredCover: r.preferredCover === 1,
    width: r.width,
    height: r.height,
    takenAt: r.taken_at ? new Date(r.taken_at).toISOString() : null,
    kind: r.kind,
    groupValues,
  };
}
```

There are two `SELECT` statements that both need `photos.kind` added — search for `photos.taken_at,` (it appears twice, once in the `focusRow` lookup, once in `fetchRealRows`). Change both occurrences of:

```js
                photos.width, photos.height, photos.taken_at,
```

to:

```js
                photos.width, photos.height, photos.taken_at, photos.kind,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/db/feed.test.js -t "kind"`
Expected: PASS.

- [ ] **Step 5: Run the full server test suite**

Run: `npx vitest run server/`
Expected: All tests pass (existing `feed.test.js` assertions that check specific item shapes via `toEqual`/`toMatchObject` on a subset of fields are unaffected by an added field; if any test uses a full-object `toEqual` that would now fail because of the new `kind` field, add `kind: expect.any(String)` or the specific expected value to that assertion — check for this and fix inline if it comes up).

- [ ] **Step 6: Commit**

```bash
git add server/db/feed.js server/db/feed.test.js
git commit -m "feat: include kind (image/raw) in feed items"
```

---

### Task 4: Client — `previewUrl` in `ui/src/lib/api.js`

**Files:**

- Modify: `ui/src/lib/api.js`

**Interfaces:**

- Consumes: nothing new.
- Produces: `previewUrl(id, v)` — same shape as the existing `thumbUrl`/`imageUrl`. Task 5 consumes this.

No dedicated test file — matches this project's existing precedent for `ui/src/lib/api.js` (thin fetch/URL wrappers, exercised via the server's own route tests and manual verification; `thumbUrl`/`imageUrl` have no tests of their own today either).

- [ ] **Step 1: Add `previewUrl`**

In `ui/src/lib/api.js`, add this function immediately after `thumbUrl` (find it by searching for `export function thumbUrl`):

```js
/** @param {number} id @param {number} [v] mtime version */
export function previewUrl(id, v = 0) {
  return `/api/preview/${id}?v=${v}`;
}
```

- [ ] **Step 2: Run the full client test suite to confirm nothing broke**

Run: `npx vitest run ui/`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/api.js
git commit -m "feat: add previewUrl client helper for the fast embedded-preview tier"
```

---

### Task 5: Client — `Thumb.svelte`'s two-tier swap

**Files:**

- Modify: `ui/src/lib/Thumb.svelte`

**Interfaces:**

- Consumes: `previewUrl` from Task 4; `item.kind` from Task 3 (already flows through automatically once Task 3 lands — `item` is passed to `Thumb` as the whole feed-item object, no new prop threading needed).
- Produces: the finished feature. No new exports.

No automated test for this file — matches this project's established convention (manual-only verification, Task 6).

- [ ] **Step 1: Read the current file**

Read `ui/src/lib/Thumb.svelte` in full before editing — this plan's code below is based on the file as it stood at the time this plan was written; confirm the surrounding code matches closely before applying (minor formatting differences are fine, structural differences are not — stop and ask if you find one you can't resolve confidently).

- [ ] **Step 2: Add the import and state**

Change the import line (currently):

```js
import { thumbUrl } from "./api.js";
```

to:

```js
import { thumbUrl, previewUrl } from "./api.js";
```

Add a new exported constant near the existing `STALL_MS` (in the `context="module"` script block):

```js
export const PREVIEW_DELAY_MS = 150; // only fetch the embedded-preview fallback if the full thumbnail hasn't already loaded by then — avoids a wasted request on every already-cached (warm) view, where the full thumbnail resolves well under this delay
```

Add new instance state near the existing `let stallTimer;`:

```js
let previewSrc = null; // the fast-tier embedded-preview URL, set only if the full thumbnail hasn't loaded within PREVIEW_DELAY_MS
let previewTimer;
```

- [ ] **Step 3: Update `armAttempt`, `settle`, and `onDestroy`**

Change `armAttempt` (currently):

```js
function armAttempt(url) {
  loaded = false; // re-fade in when the source changes
  failed = false;
  dispatch("attempt", { id: item.id });
  clearTimeout(stallTimer);
  stallTimer = setTimeout(() => {
    if (src === url) settle(false);
  }, STALL_MS);
}
```

to:

```js
function armAttempt(url) {
  loaded = false; // re-fade in when the source changes
  failed = false;
  previewSrc = null;
  dispatch("attempt", { id: item.id });
  clearTimeout(stallTimer);
  clearTimeout(previewTimer);
  stallTimer = setTimeout(() => {
    if (src === url) settle(false);
  }, STALL_MS);
  previewTimer = setTimeout(() => {
    if (src === url && !loaded) previewSrc = previewUrl(item.id, item.mtimeMs);
  }, PREVIEW_DELAY_MS);
}
```

Change `settle` (currently):

```js
function settle(ok) {
  clearTimeout(stallTimer);
  loaded = ok;
  failed = !ok;
  dispatch("settled", { id: item.id, ok });
}
```

to:

```js
function settle(ok) {
  clearTimeout(stallTimer);
  clearTimeout(previewTimer);
  loaded = ok;
  failed = !ok;
  dispatch("settled", { id: item.id, ok });
}
```

Change `onDestroy` (currently):

```js
onDestroy(() => clearTimeout(stallTimer));
```

to:

```js
onDestroy(() => {
  clearTimeout(stallTimer);
  clearTimeout(previewTimer);
});
```

- [ ] **Step 4: Render the preview image behind the cover, and suppress retry for RAW**

Inside `<button class="thumb" ...>`, immediately before the existing `{#if src}...cover...{/if}` block (search for `{#key \`${item.id}:${item.mtimeMs}\`}`), add:

```svelte
{#if src && previewSrc && !loaded}
  <img src={previewSrc} alt="" loading="lazy" class="preview" />
{/if}
```

(the `src &&` check matters even though `previewSrc` is only ever set while `src` is truthy — Svelte reuses this component across scroll/rescan, keyed by id, and `previewSrc`/`loaded` are only reset inside `armAttempt`, which itself only runs when `src` is truthy; if the tile scrolls out of view (`visible` goes false, `src` becomes `null`) neither gets reset, exactly mirroring how `loaded`/`failed` already work for the existing cover image today — without this check, a since-hidden or about-to-be-reused tile could momentarily render a stale preview image alongside no cover at all)

Change the existing retry block from:

```svelte
{#if failed}
  <button
    class="thumb-retry"
    title="Failed to load — click to retry"
    on:click|stopPropagation={retry}>⟳ Retry</button
  >
{/if}
```

to:

```svelte
{#if failed && item.kind !== "raw"}
  <button
    class="thumb-retry"
    title="Failed to load — click to retry"
    on:click|stopPropagation={retry}>⟳ Retry</button
  >
{/if}
```

(a RAW file's full-resolution decode is intentionally unavailable — `failed` still becomes true when the `/api/thumb` request 500s, correctly leaving the embedded preview visible as the final image per Step 5's CSS layering, but there's nothing to retry, so the retry affordance is suppressed specifically for this case rather than shown as if it were a transient error)

- [ ] **Step 5: Add the `.preview` CSS rule**

In the `<style>` block, add this immediately after the existing `img.cover, .stack-peek { ... }` rule (search for `object-fit: cover;` to find it — there are two occurrences; this new rule goes after the FIRST one, which is shared by `img.cover` and `.stack-peek`):

```css
.preview {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  border-radius: inherit;
  z-index: 1;
}
```

(`z-index: 1` keeps it below `img.cover`'s `z-index: 50` — confirmed by reading the existing CSS comment on `.thumb`'s stacking context before making this change — so the real thumbnail's fade-in always visually covers the placeholder once it loads, and the placeholder is only ever visible while the cover is genuinely not yet loaded)

- [ ] **Step 6: Run the full test suite and build**

Run: `npx vitest run`
Expected: All tests pass (this task touches only `Thumb.svelte`, no pure-function logic covered by existing tests).

Run: `npm run build`
Expected: Builds successfully with no compile errors.

- [ ] **Step 7: Commit**

```bash
git add ui/src/lib/Thumb.svelte
git commit -m "feat: two-tier progressive thumbnail loading in Thumb.svelte"
```

---

### Task 6: Manual validation against real SD-card/RAW test data

**Files:** none (verification only).

**Interfaces:** none — this task consumes the finished feature end-to-end.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`

- [ ] **Step 2: Verify the fast tier on a cold scan**

Scan a real, previously-unscanned folder from `docs/TEST_FOLDERS.local.md` (or any real camera-sourced JPEGs — the embedded-thumbnail extraction genuinely needs real camera files, since synthetic test fixtures don't carry one). Confirm: the grid paints low-res blur-up placeholders quickly, each tile smoothly cross-fades to its real thumbnail shortly after. Check the browser's network tab: confirm `/api/preview/:id` requests fire only for tiles whose full thumbnail took longer than ~150ms, not for every tile unconditionally.

- [ ] **Step 3: Verify the warm-cache case has no regression**

Re-scan the SAME folder (already cached from Step 2). Confirm: thumbnails appear immediately with no visible blur-up flash, and confirm via the network tab that `/api/preview/:id` requests are mostly or entirely absent this time (the full thumbnail resolves well under `PREVIEW_DELAY_MS` from a warm cache).

- [ ] **Step 4: Verify RAW handling, if RAW test files are available**

If any of the real test folders contain RAW files (`.cr2`/`.nef`/etc.), confirm: the RAW file now appears in the grid at all (previously invisible to `scan()`), shows its embedded preview with no broken-image icon, no infinite spinner, and no "Retry" button (since there's no full-resolution tier to retry into). If no RAW test files are available, note this explicitly rather than skipping silently — this path is a real, unverified gap until real RAW files can be tested against.

- [ ] **Step 5: Check for console errors**

Confirm no unexpected console errors during the above. Any real bug found here gets fixed following this project's established live-testing-driven fix pattern (fix immediately, dispatch a fresh reviewer, don't defer).

- [ ] **Step 6: Stop the dev server**

No commit for this task — it's verification only.
