# Image Embeddings Implementation Plan (#161)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute a vision embedding for every photo in the background, over the 320 px thumbnail cache, without ever making the app feel slower.

**Architecture:** A background sweep on the existing shared `runSweep` reads (or generates) each photo's 320 px cached thumbnail and hands batches to an `MLService`. Two hosts implement that interface — a hidden Electron renderer running transformers.js on WebGPU, and a Node child process on CPU — selected at startup and injected into `createApp`, so `server/` never imports `electron`. Vectors are L2-normalized and int8-quantized into their own `photo_embeddings` table, keyed by `(photo_id, model)` so switching models is new rows rather than a migration.

**Tech Stack:** Node ESM, Express, better-sqlite3, `@huggingface/transformers` v4, `onnxruntime-node`, Electron 43, Svelte 4, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-25-image-embeddings-design.md`

## Global Constraints

- **ESM everywhere**, plain JS with JSDoc types. No TypeScript.
- **Prettier** formats every file. Run `npm run format` before each commit.
- **Version for this issue is `2.18.28`** — already claimed via `claim-version.sh`. Bump `package.json` and add the `CHANGELOG.md` entry in the final task, not as a separate chore.
- **Branch is `issue-161-embeddings`.** PR body says `Refs #161`, never `Closes #161`.
- **Tests are vitest, colocated** as `*.test.js` next to the source under `server/`.
- **The test suite must never download a model, spawn a child process, or open a BrowserWindow.** Every ML test runs against a stub `MLService`.
- **Destructive/index tests set `process.env.AUTOGALLERY_HOME` to a temp dir** and call `_resetDbForTest()`, per `server/db/queryPlan.test.js`.
- **Never write into a user photo folder.** All app writes land under `cacheRoot()` (`~/.autogallery`).
- **Models cache to `~/.autogallery/models/`** — never under `cache/thumbs/`, which `pruneOrphanedCache` deletes from indiscriminately.
- **Model ids:** `Xenova/siglip-base-patch16-224` (default, dim 768) and `Xenova/clip-vit-base-patch32` (dim 512). Both have vision-only int8 ONNX exports; the text encoder stays unloaded until #164.
- **Every user-triggerable failure renders a specific, actionable message.** A console error is not user feedback.

---

## Phase 1 — Input pipeline

### Task 1: Extract the thumbnail cache-key formula

The `sha1(path:mtime:size:bucket)` formula exists twice today, with a comment in `cacheStats.js` admitting it is "kept in sync manually". #161 requires this extracted before anything becomes the fourth copy.

**Files:**

- Modify: `server/lib/cachePaths.js` (add `thumbCachePath`)
- Modify: `server/api.js:905-909`
- Modify: `server/lib/cacheStats.js:1-31`
- Test: `server/lib/cachePaths.test.js` (create)

**Interfaces:**

- Consumes: `thumbsDir()` from `server/lib/cachePaths.js`
- Produces: `thumbCachePath(photo, size) -> string` (absolute path incl. `.jpg`), `THUMB_BUCKETS: number[]`

- [ ] **Step 1: Write the failing test**

Create `server/lib/cachePaths.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thumbCachePath, THUMB_BUCKETS, thumbsDir } from "./cachePaths.js";

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-paths-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

describe("thumbCachePath", () => {
  const photo = {
    path: "/vol/Trip/IMG_1.jpg",
    mtime: 1700000000000,
    size: 4242,
  };

  it("is the sha1 of path:mtime:size:bucket, under thumbsDir, with .jpg", () => {
    const expected = createHash("sha1")
      .update(`${photo.path}:${photo.mtime}:${photo.size}:320`)
      .digest("hex");
    expect(thumbCachePath(photo, 320)).toBe(
      join(thumbsDir(), `${expected}.jpg`)
    );
  });

  it("gives a different path per bucket", () => {
    const paths = THUMB_BUCKETS.map((b) => thumbCachePath(photo, b));
    expect(new Set(paths).size).toBe(THUMB_BUCKETS.length);
  });

  it("changes when the source file's mtime or size changes", () => {
    const base = thumbCachePath(photo, 320);
    expect(thumbCachePath({ ...photo, mtime: 1 }, 320)).not.toBe(base);
    expect(thumbCachePath({ ...photo, size: 1 }, 320)).not.toBe(base);
  });

  it("exports every bucket the client can request", () => {
    expect(THUMB_BUCKETS).toEqual([160, 320, 480, 640, 1024]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/lib/cachePaths.test.js`
Expected: FAIL — `thumbCachePath is not a function` / import error.

- [ ] **Step 3: Add `thumbCachePath` to `server/lib/cachePaths.js`**

Add `import { createHash } from "node:crypto";` to the top, then append:

```js
/**
 * Every thumbnail size the client ever requests. ui/src/App.svelte snaps the
 * displayed size to one of these five specifically so the disk cache doesn't
 * fragment per pixel.
 */
export const THUMB_BUCKETS = [160, 320, 480, 640, 1024];

/**
 * THE thumbnail cache key. One definition, because it was two — GET
 * /api/thumb/:id and cacheStats.js each carried a copy, the second admitting in
 * a comment that it was "kept in sync manually". A key formula that drifts
 * doesn't throw; it silently orphans every cached thumbnail, and
 * pruneOrphanedCache then deletes the live cache as garbage.
 *
 * Identity is path + mtime + size (+ bucket), matching the scan/feed identity
 * rule in CLAUDE.md: an edited file gets a new key, so a stale thumbnail can
 * never be served for changed bytes.
 *
 * @param {{path: string, mtime: number, size: number}} photo
 * @param {number} size one of THUMB_BUCKETS
 * @returns {string} absolute path to the cached JPEG (which may not exist yet)
 */
export function thumbCachePath(photo, size) {
  const key = createHash("sha1")
    .update(`${photo.path}:${photo.mtime}:${photo.size}:${size}`)
    .digest("hex");
  return join(thumbsDir(), `${key}.jpg`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/lib/cachePaths.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Route `server/api.js` through it**

In `server/api.js`, replace lines 905-909:

```js
const key = createHash("sha1")
  .update(`${it.path}:${it.mtime}:${it.size}:${size}`)
  .digest("hex");
const cachePath = join(thumbsDir(), `${key}.jpg`);
```

with:

```js
const cachePath = thumbCachePath(it, size);
```

Update the import on line 28 to `import { thumbCachePath, thumbsDir, cacheRoot, videoProxiesDir } from "./lib/cachePaths.js";`. Leave `createHash` imported — verify with `grep -n "createHash" server/api.js` and remove the import only if no other use remains.

- [ ] **Step 6: Route `server/lib/cacheStats.js` through it**

Replace the local `THUMB_BUCKETS` const (line 9) and the whole `cacheKeyFor` function (lines 11-23) — **including the "kept in sync manually" comment, which is now false** — with an import. `expectedCacheKeys` returns bare keys (no `.jpg`, no directory) because both call sites compare against directory-listing basenames, so derive them from the path:

```js
import { basename } from "node:path";
import { thumbsDir, thumbCachePath, THUMB_BUCKETS } from "./cachePaths.js";

/**
 * @param {{path:string, mtime:number, size:number}} photo
 * @returns {string[]} the bare cache key for every bucket this photo could have
 */
function expectedCacheKeys(photo) {
  return THUMB_BUCKETS.map((bucket) =>
    basename(thumbCachePath(photo, bucket), ".jpg")
  );
}
```

Remove the now-unused `createHash` import from `cacheStats.js`.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS, no regressions. `server/lib/cacheStats.test.js` must be green **unmodified** — if it needs changing, the extraction changed behaviour and is wrong.

- [ ] **Step 8: Commit**

```bash
npm run format
git add server/lib/cachePaths.js server/lib/cachePaths.test.js server/lib/cacheStats.js server/api.js
git commit -m "refactor(cache): one thumbnail cache-key formula, not three (#161)

The sha1(path:mtime:size:bucket) key was duplicated between the thumb
endpoint and cacheStats, with a comment conceding it was kept in sync by
hand. A drifted key formula does not throw — it orphans the whole cache,
and pruneOrphanedCache then deletes it as garbage.

Refs #161"
```

---

### Task 2: `thumbSource` — read the 320 thumb, or generate and cache it

**Files:**

- Create: `server/ml/thumbSource.js`
- Test: `server/ml/thumbSource.test.js`

**Interfaces:**

- Consumes: `thumbCachePath` (Task 1); `processing.thumbnail(path, size)` and `processing.videoThumb(path, size)` from `server/processing/`, both returning `{data: Buffer}`
- Produces: `thumbBytes(photo, processing) -> Promise<Buffer>`, `EMBED_THUMB_SIZE = 320`

- [ ] **Step 1: Write the failing test**

Create `server/ml/thumbSource.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thumbCachePath } from "../lib/cachePaths.js";
import { thumbBytes, EMBED_THUMB_SIZE } from "./thumbSource.js";

let cacheDir;
const photo = {
  path: "/vol/Trip/IMG_1.jpg",
  mtime: 1700000000000,
  size: 4242,
  kind: "image",
};
const video = {
  path: "/vol/Trip/CLIP.MOV",
  mtime: 1700000000001,
  size: 999,
  kind: "video",
};

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-thumbsrc-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

describe("thumbBytes", () => {
  it("reads the cached 320px thumb without touching the processor", async () => {
    await writeFile(
      thumbCachePath(photo, EMBED_THUMB_SIZE),
      Buffer.from("cached")
    );
    const processing = { thumbnail: vi.fn(), videoThumb: vi.fn() };

    expect(await thumbBytes(photo, processing)).toEqual(Buffer.from("cached"));
    expect(processing.thumbnail).not.toHaveBeenCalled();
  });

  it("generates AND caches on a miss, so the grid is warm afterwards", async () => {
    const processing = {
      thumbnail: vi.fn().mockResolvedValue({ data: Buffer.from("fresh") }),
      videoThumb: vi.fn(),
    };

    expect(await thumbBytes(photo, processing)).toEqual(Buffer.from("fresh"));
    expect(processing.thumbnail).toHaveBeenCalledWith(photo.path, 320);

    // Second call is served from the cache the first one wrote.
    expect(await thumbBytes(photo, processing)).toEqual(Buffer.from("fresh"));
    expect(processing.thumbnail).toHaveBeenCalledTimes(1);
  });

  it("uses videoThumb for a video's poster frame", async () => {
    const processing = {
      thumbnail: vi.fn(),
      videoThumb: vi.fn().mockResolvedValue({ data: Buffer.from("poster") }),
    };

    expect(await thumbBytes(video, processing)).toEqual(Buffer.from("poster"));
    expect(processing.videoThumb).toHaveBeenCalledWith(video.path, 320);
    expect(processing.thumbnail).not.toHaveBeenCalled();
  });

  it("leaves no .tmp file behind after a successful write", async () => {
    const processing = {
      thumbnail: vi.fn().mockResolvedValue({ data: Buffer.from("fresh") }),
      videoThumb: vi.fn(),
    };
    await thumbBytes(photo, processing);

    const files = await readdir(join(cacheDir, "cache", "thumbs"));
    expect(files.filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("propagates the processor's error so runSweep can classify it", async () => {
    const err = Object.assign(new Error("unreadable"), { code: "EIO" });
    const processing = {
      thumbnail: vi.fn().mockRejectedValue(err),
      videoThumb: vi.fn(),
    };

    await expect(thumbBytes(photo, processing)).rejects.toMatchObject({
      code: "EIO",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/ml/thumbSource.test.js`
Expected: FAIL — cannot resolve `./thumbSource.js`.

- [ ] **Step 3: Implement `server/ml/thumbSource.js`**

```js
import { existsSync } from "node:fs";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { thumbCachePath } from "../lib/cachePaths.js";

/**
 * The bucket the embedding sweep reads.
 *
 * 320, not a new 224 bucket, even though the vision encoder wants 224. 320 is
 * what the grid already requests, so the write we pay for on a miss is a write
 * the USER benefits from — after a full backfill the grid is warm across the
 * whole library. A dedicated 224 bucket would fragment the cache and warm
 * nothing. The processor downscales 320 -> 224, which is the correct direction.
 */
export const EMBED_THUMB_SIZE = 320;

/**
 * The embedding input for one photo: its 320px cached thumbnail, generated and
 * cached if it isn't there yet.
 *
 * #161 assumed this cache was already warm ("the cache already holds a 320 px
 * JPEG"). It is not: thumbsDir() is written from exactly one place, GET
 * /api/thumb/:id, so it holds only what the user has scrolled past. A sweep
 * that merely READS the cache could never drain to zero pending, which is the
 * issue's own acceptance criterion. So this is a producer, not a consumer.
 *
 * Reading the 320px thumb instead of the original is also the only workable
 * path for RAW — extractPreview throws for RAW and the full decode path was
 * never built (CLAUDE.md, "Performance thesis").
 *
 * Errors are deliberately NOT caught. runSweep owns the permanent/transient
 * classification (a missing folder pauses; EIO pauses; a genuinely unreadable
 * file gets a sentinel), and swallowing the error here would rob it of the
 * `code` it classifies on.
 *
 * @param {{path: string, mtime: number, size: number, kind: string}} photo
 * @param {{thumbnail: Function, videoThumb: Function}} processing the ProcessingService
 * @returns {Promise<Buffer>} JPEG bytes
 */
export async function thumbBytes(photo, processing) {
  const cachePath = thumbCachePath(photo, EMBED_THUMB_SIZE);
  if (existsSync(cachePath)) return readFile(cachePath);

  const { data } =
    photo.kind === "video"
      ? await processing.videoThumb(photo.path, EMBED_THUMB_SIZE)
      : await processing.thumbnail(photo.path, EMBED_THUMB_SIZE);

  // Same tmp + rename dance as the thumb endpoint: a torn file in the cache
  // would be served to the grid as a corrupt image forever after.
  const tmp = `${cachePath}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, cachePath);
  } catch {
    // A cache write failure (disk full, permissions) must not fail the
    // embedding — we already HAVE the bytes. Drop the temp file and move on.
    await unlink(tmp).catch(() => {});
  }
  return data;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/ml/thumbSource.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
npm run format
git add server/ml/thumbSource.js server/ml/thumbSource.test.js
git commit -m "feat(ml): thumbSource reads the 320px thumb, generating and caching on a miss (#161)

#161 assumed a warm thumbnail cache. thumbsDir() is written only by GET
/api/thumb/:id, so it holds just what has been scrolled past — a sweep that
only read it could never drain to zero. Generating on a miss turns the
backfill's decode cost into a permanently warm grid.

Refs #161"
```

---

## Phase 2 — Storage

### Task 3: Quantization — L2-normalize, int8, dot product

**Files:**

- Create: `server/ml/quantize.js`
- Test: `server/ml/quantize.test.js`

**Interfaces:**

- Produces: `quantize(vec: Float32Array) -> {scale: number, bytes: Int8Array}`, `dequantize(bytes: Int8Array, scale: number) -> Float32Array`, `dot(a: Int8Array, b: Int8Array) -> number`

- [ ] **Step 1: Write the failing test**

Create `server/ml/quantize.test.js`:

```js
import { describe, it, expect } from "vitest";
import { quantize, dequantize, dot } from "./quantize.js";

/** Cosine similarity on plain floats, the reference the int8 path must match. */
function cosine(a, b) {
  let ab = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return ab / Math.sqrt(aa * bb);
}

function randomVec(n, seed) {
  // Deterministic LCG — a flaky quantization test is worse than none.
  let s = seed;
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    v[i] = s / 2147483648 - 0.5;
  }
  return v;
}

describe("quantize", () => {
  it("round-trips to a UNIT vector within int8 resolution", () => {
    const { scale, bytes } = quantize(randomVec(768, 7));
    const back = dequantize(bytes, scale);

    let norm = 0;
    for (const x of back) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 2);
  });

  it("produces int8 values that use the range", () => {
    const { bytes } = quantize(randomVec(768, 11));
    expect(bytes).toBeInstanceOf(Int8Array);
    expect(Math.max(...bytes)).toBeGreaterThan(100);
    expect(Math.min(...bytes)).toBeLessThan(-100);
  });

  it("normalizes, so a scaled vector quantizes identically", () => {
    const v = randomVec(768, 13);
    const scaled = Float32Array.from(v, (x) => x * 17.5);
    expect(Array.from(quantize(scaled).bytes)).toEqual(
      Array.from(quantize(v).bytes)
    );
  });

  it("makes the int8 dot product track true cosine similarity", () => {
    const a = randomVec(768, 3);
    const b = randomVec(768, 5);
    const qa = quantize(a);
    const qb = quantize(b);

    // Because both stored vectors are unit-length, cosine IS the dot product
    // of the reconstructed floats — the whole reason we normalize BEFORE
    // quantizing. No per-comparison division in the hot scan.
    const approx = dot(qa.bytes, qb.bytes) * qa.scale * qb.scale;
    expect(approx).toBeCloseTo(cosine(a, b), 2);
  });

  it("scores a vector against itself at ~1.0", () => {
    const { scale, bytes } = quantize(randomVec(768, 17));
    expect(dot(bytes, bytes) * scale * scale).toBeCloseTo(1, 2);
  });

  it("rejects a zero vector rather than emitting NaNs", () => {
    expect(() => quantize(new Float32Array(768))).toThrow(/zero/i);
  });

  it("rejects a length mismatch in dot rather than reading past the end", () => {
    expect(() => dot(new Int8Array(4), new Int8Array(8))).toThrow(/length/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/ml/quantize.test.js`
Expected: FAIL — cannot resolve `./quantize.js`.

- [ ] **Step 3: Implement `server/ml/quantize.js`**

```js
/**
 * int8 vector storage, and the one arithmetic operation every consumer needs.
 *
 * 114k x 768 float32 is 350 MB; int8 it is 87 MB, which loads into one typed
 * array and brute-force scans in well under 100 ms. That measurement is why the
 * program design says "no vector database" — sqlite-vec is the escape hatch if
 * it stops being true, not the starting point.
 *
 * THE ORDER MATTERS: L2-normalize FIRST, then quantize. Because every stored
 * vector is unit-length, cosine similarity collapses to a plain dot product —
 * no per-comparison division and no norm lookups in the hot loop. Quantizing
 * first and normalizing later would put a divide back in the inner loop for
 * every one of ~114k comparisons.
 */

/**
 * @param {Float32Array} vec raw model output, any magnitude
 * @returns {{scale: number, bytes: Int8Array}} `scale` reconstructs floats:
 *   float[i] === bytes[i] * scale
 */
export function quantize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  // A zero vector has no direction, so it has no cosine similarity to anything
  // — every comparison against it would be NaN, and NaN sorts unpredictably
  // rather than failing. Throwing sends this row to the sweep's sentinel path,
  // where it is COUNTABLE, instead of poisoning every future ranking.
  if (!(norm > 0)) throw new Error("cannot quantize a zero-magnitude vector");

  let maxAbs = 0;
  for (let i = 0; i < vec.length; i++) {
    const a = Math.abs(vec[i] / norm);
    if (a > maxAbs) maxAbs = a;
  }
  const scale = maxAbs / 127;

  const bytes = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    bytes[i] = Math.round(vec[i] / norm / scale);
  }
  return { scale, bytes };
}

/**
 * @param {Int8Array} bytes
 * @param {number} scale
 * @returns {Float32Array} the reconstructed unit vector
 */
export function dequantize(bytes, scale) {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] * scale;
  return out;
}

/**
 * Raw int8 dot product. Multiply by both vectors' scales to get cosine
 * similarity — the caller does that once per pair, not per element.
 * @param {Int8Array} a
 * @param {Int8Array} b
 * @returns {number}
 */
export function dot(a, b) {
  if (a.length !== b.length) {
    throw new Error(`dot: length mismatch (${a.length} vs ${b.length})`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/ml/quantize.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
npm run format
git add server/ml/quantize.js server/ml/quantize.test.js
git commit -m "feat(ml): int8 vector quantization, normalized so cosine is a dot product (#161)

L2-normalize before quantizing, so every stored vector is unit-length and
cosine similarity collapses to a plain int8 dot product — no divide in a
loop that will run 114k times per query.

Refs #161"
```

---

### Task 4: Schema — `photo_embeddings`, `ml_status`, and the worklist index

`ml_status` is the sentinel table `runSweep`'s `markFailed` contract assumes. #160 shipped the sweep against it but never created it.

**Files:**

- Modify: `server/db/schema.js` (inside `applySchema`, after the `hash_attempted` block ~line 190, before the "One-shot data repairs" section)
- Test: `server/db/embeddings.test.js` (created in Task 5 — this task's schema is exercised there)

**Interfaces:**

- Produces: tables `photo_embeddings(photo_id, model, dim, scale, vec, created_at)` and `ml_status(photo_id, stage, model, state, attempts, error, updated_at)`; index `idx_photo_embeddings_model`; index `idx_ml_status_lookup`

- [ ] **Step 1: Add the tables to `applySchema`**

In `server/db/schema.js`, immediately after the `ensureColumn(db, "photos", "hash_attempted", ...)` line and **before** the `// --- One-shot data repairs ---` comment:

```js
// --- ML artifacts (#161) --------------------------------------------------
// Their OWN tables, never columns on `photos`. The feed's hot path is
// `SELECT photos.*` over a keyset seek; a ~800-byte blob per row would be
// dragged through every page fetch, every tree count and every group sample
// for no benefit whatsoever.
//
// The primary key is (photo_id, model), NOT photo_id. The entire point of the
// `model` column is that upgrading the model is NEW ROWS rather than a
// migration — so two models' vectors must be able to coexist, and a photo_id
// PK would forbid exactly that. Switching models then costs a backfill;
// switching BACK costs nothing, because the old rows are still here.
db.exec(`
    CREATE TABLE IF NOT EXISTS photo_embeddings (
      photo_id   INTEGER NOT NULL REFERENCES photos(id),
      model      TEXT    NOT NULL,
      dim        INTEGER NOT NULL,
      scale      REAL    NOT NULL,
      vec        BLOB    NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (photo_id, model)
    )
  `);
// "How many are embedded under model X", and the whole-library vector load,
// both scan by model. Without this they are full table scans of the widest
// table in the schema.
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_photo_embeddings_model
       ON photo_embeddings(model)`
);

// The failure sentinel. An explicit table rather than an overloaded data
// column, because a failed embedding has no natural zero value — enrich can
// use width=0 and hashing can use hash_attempted=1, but a vector cannot.
//
// It carries `attempts` and `error` so a sentinel can distinguish "this photo
// cannot be processed" (permanent) from "the drive was not there" (a property
// of the MOMENT, and the common case on a removable-drive library). Conflating
// those two is #169, which excluded a whole unmounted drive from hashing
// forever. runSweep already classifies; this is where the answer is recorded.
//
// Keyed by model as well as stage: a photo that fails under one model is not
// thereby failed under another.
db.exec(`
    CREATE TABLE IF NOT EXISTS ml_status (
      photo_id   INTEGER NOT NULL REFERENCES photos(id),
      stage      TEXT    NOT NULL,
      model      TEXT    NOT NULL,
      state      TEXT    NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 1,
      error      TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (photo_id, stage, model)
    )
  `);
// The embed worklist anti-joins this table by (stage, model); without an
// index on that pair SQLite scans every sentinel row per batch.
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_ml_status_lookup
       ON ml_status(stage, model, photo_id)`
);
```

- [ ] **Step 2: Verify the schema applies cleanly**

Run: `npm test -- server/db`
Expected: PASS — every existing db test still green. `CREATE TABLE IF NOT EXISTS` is idempotent by construction, so no `user_version` gate is needed (only data UPDATEs need one).

- [ ] **Step 3: Commit**

```bash
npm run format
git add server/db/schema.js
git commit -m "feat(db): photo_embeddings and ml_status tables (#161)

ml_status is the sentinel table runSweep's markFailed contract has assumed
since #160 but that was never created. Both are keyed by model, because
upgrading the model is new rows rather than a migration — which a photo_id
primary key would forbid.

Refs #161"
```

---

### Task 5: `server/db/embeddings.js` — the data layer

**Files:**

- Create: `server/db/embeddings.js`
- Test: `server/db/embeddings.test.js`

**Interfaces:**

- Consumes: `quantize`/`dequantize` (Task 3); the schema from Task 4
- Produces:
  - `putEmbedding(db, {photoId, model, dim, scale, bytes})`
  - `putEmbeddings(db, rows)` — one transaction
  - `getEmbedding(db, photoId, model) -> {dim, scale, bytes: Int8Array}|null`
  - `pendingEmbedRows(db, model, limit) -> Array<{id, folder_abs_path, filename, mtime, size, kind}>`
  - `embedCounts(db, model) -> {total: number, embedded: number, failed: number}`
  - `markEmbedFailed(db, photoId, model, error)`
  - `clearEmbeddingsFor(db, photoIds)` — used by `upsertScan` invalidation
  - `modelStorage(db) -> Array<{model: string, rows: number, bytes: number}>`
  - `purgeModel(db, model) -> {rows: number}`

- [ ] **Step 1: Write the failing test**

Create `server/db/embeddings.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan } from "./photos.js";
import { quantize } from "../ml/quantize.js";
import {
  putEmbedding,
  putEmbeddings,
  getEmbedding,
  pendingEmbedRows,
  embedCounts,
  markEmbedFailed,
  clearEmbeddingsFor,
  modelStorage,
  purgeModel,
} from "./embeddings.js";

const SIGLIP = "Xenova/siglip-base-patch16-224";
const CLIP = "Xenova/clip-vit-base-patch32";
let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-embed-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

/** Three photos in one folder. Returns their ids in filename order. */
function seed(db, n = 3) {
  const files = Array.from({ length: n }, (_, i) => ({
    name: `IMG_${i}.jpg`,
    size: 1000 + i,
    mtimeMs: 1700000000000 + i,
    kind: "image",
  }));
  return upsertScan(db, "/vol/Trip", 1, files).map((r) => r.id);
}

function vec(seed, n = 8) {
  return Float32Array.from({ length: n }, (_, i) => Math.sin(seed + i));
}

describe("embeddings storage", () => {
  it("round-trips a vector through the BLOB", () => {
    const db = getDb();
    const [id] = seed(db);
    const { scale, bytes } = quantize(vec(1));

    putEmbedding(db, { photoId: id, model: SIGLIP, dim: 8, scale, bytes });
    const got = getEmbedding(db, id, SIGLIP);

    expect(got.dim).toBe(8);
    expect(got.scale).toBeCloseTo(scale, 10);
    expect(Array.from(got.bytes)).toEqual(Array.from(bytes));
    expect(got.bytes).toBeInstanceOf(Int8Array);
  });

  it("keeps two models' vectors for the same photo side by side", () => {
    const db = getDb();
    const [id] = seed(db);
    const a = quantize(vec(1));
    const b = quantize(vec(2));

    putEmbedding(db, { photoId: id, model: SIGLIP, dim: 8, ...a });
    putEmbedding(db, { photoId: id, model: CLIP, dim: 8, ...b });

    expect(Array.from(getEmbedding(db, id, SIGLIP).bytes)).toEqual(
      Array.from(a.bytes)
    );
    expect(Array.from(getEmbedding(db, id, CLIP).bytes)).toEqual(
      Array.from(b.bytes)
    );
  });

  it("returns null for a photo with no embedding under that model", () => {
    const db = getDb();
    const [id] = seed(db);
    expect(getEmbedding(db, id, SIGLIP)).toBeNull();
  });

  it("re-embedding the same photo+model replaces rather than duplicating", () => {
    const db = getDb();
    const [id] = seed(db);
    putEmbedding(db, {
      photoId: id,
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });
    const second = quantize(vec(9));
    putEmbedding(db, { photoId: id, model: SIGLIP, dim: 8, ...second });

    expect(Array.from(getEmbedding(db, id, SIGLIP).bytes)).toEqual(
      Array.from(second.bytes)
    );
    expect(embedCounts(db, SIGLIP).embedded).toBe(1);
  });
});

describe("the worklist", () => {
  it("returns photos with no embedding for the active model", () => {
    const db = getDb();
    const ids = seed(db);
    expect(
      pendingEmbedRows(db, SIGLIP, 10)
        .map((r) => r.id)
        .sort()
    ).toEqual([...ids].sort());
  });

  it("drops a photo once it is embedded", () => {
    const db = getDb();
    const ids = seed(db);
    putEmbedding(db, {
      photoId: ids[0],
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });

    expect(pendingEmbedRows(db, SIGLIP, 10).map((r) => r.id)).not.toContain(
      ids[0]
    );
  });

  it("drops a photo once it is marked failed — the property runSweep needs", () => {
    const db = getDb();
    const ids = seed(db);
    markEmbedFailed(db, ids[0], SIGLIP, new Error("corrupt jpeg"));

    // runSweep's stall guard THROWS if a markFailed row comes back. This is
    // that guarantee, asserted where it is cheap to test.
    expect(pendingEmbedRows(db, SIGLIP, 10).map((r) => r.id)).not.toContain(
      ids[0]
    );
  });

  it("still offers a photo that failed under a DIFFERENT model", () => {
    const db = getDb();
    const ids = seed(db);
    markEmbedFailed(db, ids[0], CLIP, new Error("corrupt jpeg"));

    expect(pendingEmbedRows(db, SIGLIP, 10).map((r) => r.id)).toContain(ids[0]);
  });

  it("excludes stale rows", () => {
    const db = getDb();
    seed(db, 3);
    // A rescan that finds only one file marks the other two stale.
    upsertScan(db, "/vol/Trip", 1, [
      { name: "IMG_0.jpg", size: 1000, mtimeMs: 1700000000000, kind: "image" },
    ]);
    expect(pendingEmbedRows(db, SIGLIP, 10)).toHaveLength(1);
  });

  it("carries everything thumbCachePath and runSweep need", () => {
    const db = getDb();
    seed(db, 1);
    const [row] = pendingEmbedRows(db, SIGLIP, 10);

    expect(row).toMatchObject({
      folder_abs_path: "/vol/Trip",
      filename: "IMG_0.jpg",
      kind: "image",
    });
    expect(typeof row.mtime).toBe("number");
    expect(typeof row.size).toBe("number");
  });

  it("honours the limit", () => {
    const db = getDb();
    seed(db, 5);
    expect(pendingEmbedRows(db, SIGLIP, 2)).toHaveLength(2);
  });
});

describe("counts and storage reporting", () => {
  it("reports embedded and failed separately from total", () => {
    const db = getDb();
    const ids = seed(db, 4);
    putEmbedding(db, {
      photoId: ids[0],
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });
    markEmbedFailed(db, ids[1], SIGLIP, new Error("nope"));

    // "12,431 of 114,125 embedded, 37 failed" must be reportable. Pending is
    // total - embedded - failed, and it must NOT read as an unexplained
    // shortfall — that is the specific way pre-2.17.14 backupCoverage misled.
    expect(embedCounts(db, SIGLIP)).toEqual({
      total: 4,
      embedded: 1,
      failed: 1,
    });
  });

  it("bumps attempts rather than duplicating on a repeat failure", () => {
    const db = getDb();
    const [id] = seed(db);
    markEmbedFailed(db, id, SIGLIP, new Error("first"));
    markEmbedFailed(db, id, SIGLIP, new Error("second"));

    expect(embedCounts(db, SIGLIP).failed).toBe(1);
    const row = db
      .prepare(`SELECT attempts, error FROM ml_status WHERE photo_id = ?`)
      .get(id);
    expect(row.attempts).toBe(2);
    expect(row.error).toBe("second");
  });

  it("reports per-model storage so the settings panel can offer a purge", () => {
    const db = getDb();
    const ids = seed(db, 2);
    putEmbedding(db, {
      photoId: ids[0],
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });
    putEmbedding(db, {
      photoId: ids[1],
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(2)),
    });
    putEmbedding(db, {
      photoId: ids[0],
      model: CLIP,
      dim: 8,
      ...quantize(vec(3)),
    });

    const byModel = Object.fromEntries(
      modelStorage(db).map((m) => [m.model, m])
    );
    expect(byModel[SIGLIP].rows).toBe(2);
    expect(byModel[CLIP].rows).toBe(1);
    expect(byModel[SIGLIP].bytes).toBeGreaterThan(0);
  });

  it("purges one model without touching another", () => {
    const db = getDb();
    const [id] = seed(db);
    putEmbedding(db, {
      photoId: id,
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });
    putEmbedding(db, { photoId: id, model: CLIP, dim: 8, ...quantize(vec(2)) });

    expect(purgeModel(db, CLIP)).toEqual({ rows: 1 });
    expect(getEmbedding(db, id, CLIP)).toBeNull();
    expect(getEmbedding(db, id, SIGLIP)).not.toBeNull();
  });
});

describe("putEmbeddings (batch)", () => {
  it("writes a whole batch in one transaction", () => {
    const db = getDb();
    const ids = seed(db, 3);
    putEmbeddings(
      db,
      ids.map((id, i) => ({
        photoId: id,
        model: SIGLIP,
        dim: 8,
        ...quantize(vec(i)),
      }))
    );
    expect(embedCounts(db, SIGLIP).embedded).toBe(3);
  });

  it("writes nothing if one row in the batch is invalid", () => {
    const db = getDb();
    const ids = seed(db, 2);
    expect(() =>
      putEmbeddings(db, [
        { photoId: ids[0], model: SIGLIP, dim: 8, ...quantize(vec(1)) },
        { photoId: ids[1], model: SIGLIP, dim: 8, scale: 0.1, bytes: null },
      ])
    ).toThrow();
    expect(embedCounts(db, SIGLIP).embedded).toBe(0);
  });
});

describe("clearEmbeddingsFor", () => {
  it("removes vectors AND sentinels for the given photos, across models", () => {
    const db = getDb();
    const ids = seed(db, 2);
    putEmbedding(db, {
      photoId: ids[0],
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });
    putEmbedding(db, {
      photoId: ids[0],
      model: CLIP,
      dim: 8,
      ...quantize(vec(2)),
    });
    markEmbedFailed(db, ids[0], SIGLIP, new Error("x"));
    putEmbedding(db, {
      photoId: ids[1],
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(3)),
    });

    clearEmbeddingsFor(db, [ids[0]]);

    expect(getEmbedding(db, ids[0], SIGLIP)).toBeNull();
    expect(getEmbedding(db, ids[0], CLIP)).toBeNull();
    expect(embedCounts(db, SIGLIP).failed).toBe(0);
    expect(getEmbedding(db, ids[1], SIGLIP)).not.toBeNull();
  });

  it("is a no-op for an empty list", () => {
    const db = getDb();
    const [id] = seed(db);
    putEmbedding(db, {
      photoId: id,
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });
    clearEmbeddingsFor(db, []);
    expect(getEmbedding(db, id, SIGLIP)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/db/embeddings.test.js`
Expected: FAIL — cannot resolve `./embeddings.js`.

- [ ] **Step 3: Implement `server/db/embeddings.js`**

```js
/**
 * The embeddings data layer (#161).
 *
 * Everything here is keyed by MODEL as well as photo. Vectors from different
 * models are not comparable — different dimensionality, different space — so
 * "how many are embedded" is only ever a question about one model, and mixing
 * them in a similarity scan would produce confident nonsense.
 */

/** The sweep stage name recorded in ml_status. Faces (#166) will add its own. */
export const EMBED_STAGE = "embed";

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{photoId: number, model: string, dim: number, scale: number, bytes: Int8Array}} row
 */
export function putEmbedding(db, row) {
  stmtPut(db).run({
    photoId: row.photoId,
    model: row.model,
    dim: row.dim,
    scale: row.scale,
    // Int8Array -> Buffer WITHOUT copying the underlying bytes. Note the
    // byteOffset/byteLength arguments: a typed array can be a VIEW into a
    // larger buffer (transformers.js hands back exactly that, one big tensor
    // sliced per image), and Buffer.from(view.buffer) alone would store the
    // WHOLE tensor for every photo.
    vec: Buffer.from(
      row.bytes.buffer,
      row.bytes.byteOffset,
      row.bytes.byteLength
    ),
    createdAt: Date.now(),
  });
}

/**
 * One transaction for a whole batch. better-sqlite3 transactions are
 * synchronous by contract, which is exactly what makes them crash-safe: a
 * half-written batch is impossible.
 * @param {import("better-sqlite3").Database} db
 * @param {Array<{photoId: number, model: string, dim: number, scale: number, bytes: Int8Array}>} rows
 */
export function putEmbeddings(db, rows) {
  db.transaction((batch) => {
    for (const r of batch) putEmbedding(db, r);
  })(rows);
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {number} photoId
 * @param {string} model
 * @returns {{dim: number, scale: number, bytes: Int8Array}|null}
 */
export function getEmbedding(db, photoId, model) {
  const row = db
    .prepare(
      `SELECT dim, scale, vec FROM photo_embeddings
        WHERE photo_id = ? AND model = ?`
    )
    .get(photoId, model);
  if (!row) return null;
  return {
    dim: row.dim,
    scale: row.scale,
    bytes: new Int8Array(
      row.vec.buffer,
      row.vec.byteOffset,
      row.vec.byteLength
    ),
  };
}

/**
 * The embed worklist: photos with no vector for this model and no failure
 * sentinel for it. Re-queried every batch, so it is the worklist AND the resume
 * point — a crash costs one batch, not the backlog.
 *
 * `stale = 0` mirrors pendingHashRows: a row whose file vanished at the last
 * scan must not be swept.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @param {number} limit
 * @returns {Array<{id: number, folder_abs_path: string, filename: string, mtime: number, size: number, kind: string}>}
 */
export function pendingEmbedRows(db, model, limit) {
  return db
    .prepare(
      `SELECT photos.id, photos.filename, photos.mtime, photos.size, photos.kind,
              folders.abs_path AS folder_abs_path
         FROM photos
         JOIN folders ON folders.id = photos.folder_id
        WHERE photos.stale = 0
          AND NOT EXISTS (
                SELECT 1 FROM photo_embeddings e
                 WHERE e.photo_id = photos.id AND e.model = @model)
          AND NOT EXISTS (
                SELECT 1 FROM ml_status s
                 WHERE s.photo_id = photos.id
                   AND s.stage = @stage AND s.model = @model)
        LIMIT @limit`
    )
    .all({ model, stage: EMBED_STAGE, limit });
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @returns {{total: number, embedded: number, failed: number}} pending is
 *   total - embedded - failed, and the UI must show it as such: "not computed
 *   yet" and "cannot be computed" are different answers to the user.
 */
export function embedCounts(db, model) {
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM photos WHERE stale = 0`)
    .get().n;
  const embedded = db
    .prepare(
      `SELECT COUNT(*) AS n FROM photo_embeddings e
         JOIN photos p ON p.id = e.photo_id
        WHERE e.model = ? AND p.stale = 0`
    )
    .get(model).n;
  const failed = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ml_status s
         JOIN photos p ON p.id = s.photo_id
        WHERE s.stage = ? AND s.model = ? AND p.stale = 0`
    )
    .get(EMBED_STAGE, model).n;
  return { total, embedded, failed };
}

/**
 * The sentinel WRITE. runSweep owns the CLASSIFICATION (it only calls this for
 * failures it has already judged permanent — a missing folder or a transient
 * errno pauses the sweep and marks nothing, which is #169's lesson).
 *
 * This row is what removes the photo from pendingEmbedRows, which is the only
 * reason the sweep terminates. runSweep's stall guard throws loudly if it
 * doesn't.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {number} photoId
 * @param {string} model
 * @param {Error} error
 */
export function markEmbedFailed(db, photoId, model, error) {
  db.prepare(
    `INSERT INTO ml_status (photo_id, stage, model, state, attempts, error, updated_at)
     VALUES (@photoId, @stage, @model, 'failed', 1, @error, @now)
     ON CONFLICT(photo_id, stage, model) DO UPDATE SET
       attempts = ml_status.attempts + 1,
       error = excluded.error,
       updated_at = excluded.updated_at`
  ).run({
    photoId,
    stage: EMBED_STAGE,
    model,
    error: String(error?.message ?? error).slice(0, 500),
    now: Date.now(),
  });
}

/**
 * Drop every ML artifact for these photos, across ALL models.
 *
 * Called from upsertScan when a file's size or mtime changed. Without it an
 * edited photo keeps a stale vector forever: nothing else would ever notice,
 * because the worklist only asks whether a vector EXISTS, not whether it still
 * describes the current bytes.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {number[]} photoIds
 */
export function clearEmbeddingsFor(db, photoIds) {
  if (!photoIds.length) return;
  // Chunked: SQLite's default SQLITE_MAX_VARIABLE_NUMBER is 32766, and a rescan
  // of a large folder where every file changed would blow straight past it.
  const CHUNK = 500;
  for (let i = 0; i < photoIds.length; i += CHUNK) {
    const chunk = photoIds.slice(i, i + CHUNK);
    const holes = chunk.map(() => "?").join(",");
    db.prepare(`DELETE FROM photo_embeddings WHERE photo_id IN (${holes})`).run(
      ...chunk
    );
    db.prepare(`DELETE FROM ml_status WHERE photo_id IN (${holes})`).run(
      ...chunk
    );
  }
}

/**
 * Per-model vector storage, so the settings panel can show what each model
 * costs and offer a targeted purge. Dormant models are KEPT by design —
 * switching back after an A/B comparison is then free.
 * @param {import("better-sqlite3").Database} db
 * @returns {Array<{model: string, rows: number, bytes: number}>}
 */
export function modelStorage(db) {
  return db
    .prepare(
      `SELECT model, COUNT(*) AS rows, COALESCE(SUM(LENGTH(vec)), 0) AS bytes
         FROM photo_embeddings GROUP BY model ORDER BY model`
    )
    .all();
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @returns {{rows: number}}
 */
export function purgeModel(db, model) {
  const tx = db.transaction((m) => {
    const { changes } = db
      .prepare(`DELETE FROM photo_embeddings WHERE model = ?`)
      .run(m);
    db.prepare(`DELETE FROM ml_status WHERE stage = ? AND model = ?`).run(
      EMBED_STAGE,
      m
    );
    return changes;
  });
  return { rows: tx(model) };
}

/** Prepared once per database handle — better-sqlite3 caches the plan. */
let putCache = new WeakMap();
function stmtPut(db) {
  let s = putCache.get(db);
  if (!s) {
    s = db.prepare(
      `INSERT INTO photo_embeddings (photo_id, model, dim, scale, vec, created_at)
       VALUES (@photoId, @model, @dim, @scale, @vec, @createdAt)
       ON CONFLICT(photo_id, model) DO UPDATE SET
         dim = excluded.dim,
         scale = excluded.scale,
         vec = excluded.vec,
         created_at = excluded.created_at`
    );
    putCache.set(db, s);
  }
  return s;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/db/embeddings.test.js`
Expected: PASS (all describe blocks)

- [ ] **Step 5: Commit**

```bash
npm run format
git add server/db/embeddings.js server/db/embeddings.test.js
git commit -m "feat(db): embeddings data layer with a per-model worklist and sentinels (#161)

markEmbedFailed writing a row is what removes a photo from
pendingEmbedRows, which is the only reason the sweep terminates — asserted
directly, since runSweep's stall guard turns a violation into a throw.

Refs #161"
```

---

### Task 6: Invalidate embeddings when a file's bytes change

`upsertScan`'s `ON CONFLICT` nulls `content_hash`, `hash_attempted` and `gps_checked` on a size/mtime change. Embeddings must join that set, or an edited photo keeps a stale vector forever.

**Files:**

- Modify: `server/db/photos.js:12-89` (`upsertScan`)
- Test: `server/db/embeddings.test.js` (append a describe block)

**Interfaces:**

- Consumes: `clearEmbeddingsFor(db, photoIds)` (Task 5)

- [ ] **Step 1: Write the failing test**

Append to `server/db/embeddings.test.js`:

```js
describe("rescan invalidation", () => {
  const file = (over = {}) => ({
    name: "IMG_0.jpg",
    size: 1000,
    mtimeMs: 1700000000000,
    kind: "image",
    ...over,
  });

  it("drops the vector when the file's mtime changed", () => {
    const db = getDb();
    const [id] = upsertScan(db, "/vol/Trip", 1, [file()]).map((r) => r.id);
    putEmbedding(db, {
      photoId: id,
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });

    upsertScan(db, "/vol/Trip", 1, [file({ mtimeMs: 1800000000000 })]);

    expect(getEmbedding(db, id, SIGLIP)).toBeNull();
  });

  it("drops the vector when the file's size changed", () => {
    const db = getDb();
    const [id] = upsertScan(db, "/vol/Trip", 1, [file()]).map((r) => r.id);
    putEmbedding(db, {
      photoId: id,
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });

    upsertScan(db, "/vol/Trip", 1, [file({ size: 2000 })]);

    expect(getEmbedding(db, id, SIGLIP)).toBeNull();
  });

  it("drops a stale failure sentinel too, so a fixed file is retried", () => {
    const db = getDb();
    const [id] = upsertScan(db, "/vol/Trip", 1, [file()]).map((r) => r.id);
    markEmbedFailed(db, id, SIGLIP, new Error("corrupt"));

    upsertScan(db, "/vol/Trip", 1, [file({ mtimeMs: 1800000000000 })]);

    // #169's shape: a sentinel nothing ever clears excludes the photo forever.
    expect(pendingEmbedRows(db, SIGLIP, 10).map((r) => r.id)).toContain(id);
  });

  it("KEEPS the vector when nothing about the file changed", () => {
    const db = getDb();
    const [id] = upsertScan(db, "/vol/Trip", 1, [file()]).map((r) => r.id);
    putEmbedding(db, {
      photoId: id,
      model: SIGLIP,
      dim: 8,
      ...quantize(vec(1)),
    });

    // An ordinary rescan of an unchanged library must not throw away hours of
    // embedding work.
    upsertScan(db, "/vol/Trip", 1, [file()]);

    expect(getEmbedding(db, id, SIGLIP)).not.toBeNull();
  });

  it("keeps other photos' vectors when one file changed", () => {
    const db = getDb();
    const rows = upsertScan(db, "/vol/Trip", 1, [
      file(),
      file({ name: "IMG_1.jpg", size: 1001 }),
    ]);
    for (const r of rows) {
      putEmbedding(db, {
        photoId: r.id,
        model: SIGLIP,
        dim: 8,
        ...quantize(vec(r.id)),
      });
    }

    upsertScan(db, "/vol/Trip", 1, [
      file({ mtimeMs: 1800000000000 }),
      file({ name: "IMG_1.jpg", size: 1001 }),
    ]);

    expect(getEmbedding(db, rows[0].id, SIGLIP)).toBeNull();
    expect(getEmbedding(db, rows[1].id, SIGLIP)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/db/embeddings.test.js -t "rescan invalidation"`
Expected: FAIL — three cases fail; the vector survives the change.

- [ ] **Step 3: Modify `upsertScan`**

In `server/db/photos.js`, add the import at the top:

```js
import { clearEmbeddingsFor } from "./embeddings.js";
```

Then replace the transaction (lines 65-79) with:

```js
// Which photos' BYTES changed this scan. The ON CONFLICT clause above can
// express "keep or null a column", but embeddings live in their own table, so
// dropping them needs the id list — and it has to be captured BEFORE the
// upsert overwrites the old size/mtime we compare against.
const priorByName = new Map(
  db
    .prepare(`SELECT id, filename, size, mtime FROM photos WHERE folder_id = ?`)
    .all(folderId)
    .map((r) => [r.filename, r])
);

const tx = db.transaction((files) => {
  markAllStale.run(folderId);
  const changedIds = [];
  for (const f of files) {
    const prior = priorByName.get(f.name);
    if (prior && (prior.size !== f.size || prior.mtime !== f.mtimeMs)) {
      changedIds.push(prior.id);
    }
    upsertPhoto.run({
      folderId,
      filename: f.name,
      size: f.size,
      mtime: f.mtimeMs,
      btime: f.btimeMs ?? null,
      kind: f.kind,
      now,
    });
  }
  // An edited photo that keeps its old vector is wrong FOREVER — the worklist
  // only asks whether a vector exists, never whether it still describes the
  // current bytes. Same reasoning as content_hash above; different table, so
  // it cannot ride the ON CONFLICT CASE.
  clearEmbeddingsFor(db, changedIds);
});
tx(files);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/db/embeddings.test.js server/db/photos.test.js`
Expected: PASS — including every pre-existing `photos.test.js` case, unmodified.

- [ ] **Step 5: Commit**

```bash
npm run format
git add server/db/photos.js server/db/embeddings.test.js
git commit -m "fix(db): drop embeddings and sentinels when a file's bytes change (#161)

upsertScan already nulls content_hash, hash_attempted and gps_checked on a
size/mtime change. Embeddings live in their own table so they cannot ride
the ON CONFLICT CASE — the changed ids are captured before the upsert
overwrites the values being compared.

Refs #161"
```

---

### Task 7: Prove the worklist query does not full-scan

**Files:**

- Modify: `server/db/queryPlan.test.js` (append a describe block)

**Interfaces:**

- Consumes: `pendingEmbedRows` (Task 5), the indexes from Task 4

- [ ] **Step 1: Write the failing test**

Append to `server/db/queryPlan.test.js` (reusing that file's existing `seed`, `beforeEach`, and `afterEach`; add `import { pendingEmbedRows, markEmbedFailed } from "./embeddings.js";` at the top):

```js
describe("the embed worklist must not scan ml_status per batch", () => {
  it("uses idx_ml_status_lookup for the sentinel anti-join", () => {
    const db = getDb();
    seed(db);

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN ${`SELECT photos.id FROM photos
             JOIN folders ON folders.id = photos.folder_id
            WHERE photos.stale = 0
              AND NOT EXISTS (SELECT 1 FROM photo_embeddings e
                               WHERE e.photo_id = photos.id AND e.model = @model)
              AND NOT EXISTS (SELECT 1 FROM ml_status s
                               WHERE s.photo_id = photos.id
                                 AND s.stage = @stage AND s.model = @model)
            LIMIT @limit`}`
      )
      .all({ model: "m", stage: "embed", limit: 10 })
      .map((r) => r.detail)
      .join("\n");

    // The anti-joins must be index SEARCHES. If either degrades to a SCAN, every
    // batch of a 114k backfill re-reads a whole table — the exact silent
    // rot this file exists to catch.
    expect(plan).toMatch(/SEARCH .*ml_status USING (COVERING )?INDEX/);
    expect(plan).toMatch(/SEARCH .*photo_embeddings USING/);
    expect(plan).not.toMatch(/SCAN ml_status/);
    expect(plan).not.toMatch(/SCAN photo_embeddings/);
  });

  it("still returns the right rows, so the plan test is not testing a typo", () => {
    const db = getDb();
    const ids = seed(db).map((r) => r.id ?? r);
    markEmbedFailed(db, ids[0], "m", new Error("x"));
    expect(pendingEmbedRows(db, "m", 100).map((r) => r.id)).not.toContain(
      ids[0]
    );
  });
});
```

> **Note for the implementer:** `queryPlan.test.js`'s existing `seed(db)` helper may return rows rather than ids. Read the helper before writing the second case and adapt the id extraction to match; do not change `seed` itself, since other cases depend on it.

- [ ] **Step 2: Run the test**

Run: `npx vitest run server/db/queryPlan.test.js -t "embed worklist"`
Expected: PASS if Task 4's indexes are right. **If it fails with `SCAN ml_status`, the index is wrong — fix `idx_ml_status_lookup`, not the assertion.**

- [ ] **Step 3: Verify the assertion can fail**

Temporarily comment out the `CREATE INDEX IF NOT EXISTS idx_ml_status_lookup` line in `server/db/schema.js`, re-run the test, and confirm it goes RED. Restore the line and confirm GREEN. **A test that never failed proves nothing** (CLAUDE.md).

- [ ] **Step 4: Commit**

```bash
npm run format
git add server/db/queryPlan.test.js
git commit -m "test(db): assert the embed worklist anti-joins use their indexes (#161)

Verified red by removing idx_ml_status_lookup. Without it every batch of a
114k backfill re-scans the whole sentinel table, and nothing would fail.

Refs #161"
```

---

## Phase 3 — CPU inference and the sweep

### Task 8: Model registry and real inference in the ONNX worker

**Files:**

- Create: `server/ml/models.js`
- Modify: `server/ml/worker/index.js`
- Modify: `server/ml/OnnxMLService.js`
- Test: `server/ml/models.test.js`; extend `server/ml/OnnxMLService.test.js`

**Interfaces:**

- Produces: `MODELS` (array), `DEFAULT_MODEL_ID`, `modelById(id)`; `OnnxMLService#embedImages(buffers) -> Promise<Float32Array[]>`, `OnnxMLService#configure({modelId, threads})`
- **Contract change worth noting:** `MLService.embedImages` is documented as taking `string[]` paths. It now takes `Buffer[]` of JPEG bytes, because the WebGPU host (Task 11) lives in a renderer with no filesystem access. Update the JSDoc in `server/ml/MLService.js` in this task.

- [ ] **Step 1: Write the failing test for the registry**

Create `server/ml/models.test.js`:

```js
import { describe, it, expect } from "vitest";
import { MODELS, DEFAULT_MODEL_ID, modelById } from "./models.js";

describe("the model registry", () => {
  it("defaults to SigLIP base patch16-224", () => {
    expect(DEFAULT_MODEL_ID).toBe("Xenova/siglip-base-patch16-224");
  });

  it("carries what the loader and the storage layer each need", () => {
    for (const m of MODELS) {
      expect(m.id).toMatch(/^Xenova\//);
      expect(typeof m.label).toBe("string");
      expect(m.dim).toBeGreaterThan(0);
      // SigLIP's pooled output IS its embedding; CLIP needs its projection
      // head. Getting this wrong yields plausible vectors of the wrong shape.
      expect(["pooler_output", "image_embeds"]).toContain(m.outputKey);
      expect(["SiglipVisionModel", "CLIPVisionModelWithProjection"]).toContain(
        m.loader
      );
      expect(m.approxDownloadMB).toBeGreaterThan(0);
    }
  });

  it("offers CLIP ViT-B/32 as the fast alternative at 512 dims", () => {
    const clip = modelById("Xenova/clip-vit-base-patch32");
    expect(clip.dim).toBe(512);
    expect(clip.outputKey).toBe("image_embeds");
  });

  it("gives SigLIP 768 dims", () => {
    expect(modelById(DEFAULT_MODEL_ID).dim).toBe(768);
  });

  it("throws on an unknown id rather than silently defaulting", () => {
    // Silently falling back would write vectors under a model name that never
    // ran — the worst possible failure, since nothing downstream could detect it.
    expect(() => modelById("evil/model")).toThrow(/unknown model/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/ml/models.test.js`
Expected: FAIL — cannot resolve `./models.js`.

- [ ] **Step 3: Implement `server/ml/models.js`**

```js
/**
 * The vetted vision encoders, and everything the loader needs to drive each one.
 *
 * Deliberately a short allowlist rather than "any Hugging Face id". An arbitrary
 * id is an arbitrary download into the user's machine, and a model whose output
 * shape we have not checked writes plausible vectors of the wrong dimension —
 * which nothing downstream can detect.
 *
 * Both entries have vision-only int8 ONNX exports. The TEXT encoder is
 * deliberately not loaded here: #161 needs image vectors only, and skipping it
 * saves both the download and the resident RAM until #164 wants it.
 */
export const MODELS = [
  {
    id: "Xenova/siglip-base-patch16-224",
    label: "SigLIP base (better quality)",
    // SigLIP has no projection head — the pooled encoder output IS the
    // embedding. CLIP's is behind a projection, hence the differing key below.
    loader: "SiglipVisionModel",
    outputKey: "pooler_output",
    dim: 768,
    dtype: "int8",
    approxDownloadMB: 100,
    note: "~4x the CPU cost of CLIP per photo, clearly better zero-shot accuracy",
  },
  {
    id: "Xenova/clip-vit-base-patch32",
    label: "CLIP ViT-B/32 (faster)",
    loader: "CLIPVisionModelWithProjection",
    outputKey: "image_embeds",
    dim: 512,
    dtype: "int8",
    approxDownloadMB: 45,
    note: "49 patches instead of 196 — much cheaper, lower accuracy",
  },
];

export const DEFAULT_MODEL_ID = "Xenova/siglip-base-patch16-224";

/** @param {string} id @returns {typeof MODELS[number]} */
export function modelById(id) {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`unknown model: ${id}`);
  return m;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/ml/models.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Add `embed` and `configure` ops to the worker**

In `server/ml/worker/index.js`, add module state and the two new ops. Keep the existing `health` behaviour untouched. Because `handle` is currently synchronous and inference is not, make `handle` async and `await` the new ops:

```js
import { modelById } from "../models.js";

let transformers = null;
let loaded = null; // { id, model, processor, outputKey, dim }
let unloadTimer = null;
let config = { modelId: null, threads: 1 };

/** Models return their RAM after this long idle. A 114k backfill runs for
 *  hours; holding ~400 MB resident afterwards for nothing is not acceptable
 *  on a machine the user is also editing photos on. */
const UNLOAD_AFTER_MS = 120_000;

async function ensureModel(modelId) {
  if (loaded?.id === modelId) return loaded;
  const spec = modelById(modelId);

  if (!transformers) {
    transformers = await import("@huggingface/transformers");
    // Models are a rebuildable cache on the INTERNAL disk, like every other
    // derived artifact this app writes. NOT under cache/thumbs/ —
    // pruneOrphanedCache deletes anything there that isn't a known thumb key,
    // regardless of extension, and would eat the model on the next prune.
    transformers.env.cacheDir = process.env.AUTOGALLERY_MODELS_DIR;
    // Cap the intra-op pool. A separate PROCESS is not a separate CPU: left
    // uncapped, ORT grabs every core and starves the libvips pool that
    // server/index.js:19 reserves for thumbnails — measured at 15ms -> 90ms
    // with tiles abandoned mid-scroll (lib/interactive.js).
    transformers.env.backends.onnx.wasm.numThreads = config.threads;
  }

  const Loader = transformers[spec.loader];
  const model = await Loader.from_pretrained(spec.id, {
    dtype: spec.dtype,
    device: "cpu",
    session_options: { intraOpNumThreads: config.threads },
  });
  const processor = await transformers.AutoProcessor.from_pretrained(spec.id);
  loaded = {
    id: spec.id,
    model,
    processor,
    outputKey: spec.outputKey,
    dim: spec.dim,
  };
  return loaded;
}

function touchUnloadTimer() {
  clearTimeout(unloadTimer);
  unloadTimer = setTimeout(() => {
    loaded = null;
  }, UNLOAD_AFTER_MS);
  unloadTimer.unref?.();
}
```

Then, inside `handle`, before the `unknown op` reply:

```js
if (req.op === "configure") {
  config = { modelId: req.modelId, threads: Math.max(1, req.threads | 0) };
  // A thread-count change only takes effect on a fresh session.
  loaded = null;
  return reply({ id: req.id, ok: true });
}

if (req.op === "embed") {
  const { model, processor, outputKey } = await ensureModel(req.modelId);
  const { RawImage } = transformers;
  const images = await Promise.all(
    req.images.map((b64) =>
      RawImage.fromBlob(new Blob([Buffer.from(b64, "base64")]))
    )
  );
  const inputs = await processor(images);
  const out = await model(inputs);
  const tensor = out[outputKey];
  const [n, dim] = tensor.dims;
  // One tensor holds the whole batch; slice per image and send FLOATS.
  // Quantization happens in the parent so the worker stays a pure encoder.
  const vectors = [];
  for (let i = 0; i < n; i++) {
    vectors.push(Array.from(tensor.data.slice(i * dim, (i + 1) * dim)));
  }
  touchUnloadTimer();
  return reply({ id: req.id, vectors, dim });
}
```

Change `function handle(line)` to `async function handle(line)` and wrap its body's `try` so a rejected promise still replies with an error rather than becoming an unhandled rejection:

```js
async function handle(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return; // unparseable input is the parent's bug; stay alive
  }
  try {
    // ... existing health branch, then the configure/embed branches above ...
    reply({ id: req.id, error: `unknown op: ${req.op}` });
  } catch (e) {
    reply({ id: req.id, error: String(e?.message ?? e) });
  }
}
```

- [ ] **Step 6: Add `configure` and `embedImages` to `OnnxMLService`**

In `server/ml/OnnxMLService.js`, pass the models dir to the child and add the two methods. In `#ensureChild`, extend `env`:

```js
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        AUTOGALLERY_MODELS_DIR:
          process.env.AUTOGALLERY_MODELS_DIR ?? modelsDir(),
      },
```

with `import { modelsDir } from "../lib/cachePaths.js";` at the top, and add to `server/lib/cachePaths.js`:

```js
/** Downloaded ML model weights. Deliberately NOT under cache/thumbs/ —
 *  pruneOrphanedCache deletes anything there outside its expected key set,
 *  regardless of extension.
 *  @returns {string} Absolute path to the model cache dir (created if missing). */
export function modelsDir() {
  const dir = join(cacheRoot(), "models");
  mkdirSync(dir, { recursive: true });
  return dir;
}
```

Then add to the class:

```js
  #modelId = null;

  /** @param {{modelId: string, threads: number}} opts */
  async configure({ modelId, threads }) {
    this.#modelId = modelId;
    return this.#request({ op: "configure", modelId, threads });
  }

  /**
   * @param {Buffer[]} buffers JPEG bytes, one per image
   * @returns {Promise<Float32Array[]>} raw (un-normalized) model vectors
   */
  async embedImages(buffers) {
    if (!this.#modelId) throw new Error("OnnxMLService: configure() first");
    const { vectors } = await this.#request({
      op: "embed",
      modelId: this.#modelId,
      images: buffers.map((b) => b.toString("base64")),
    });
    return vectors.map((v) => Float32Array.from(v));
  }
```

- [ ] **Step 7: Extend `server/ml/OnnxMLService.test.js`**

Add cases using that file's existing fake-spawn helper (read it first — it already injects a fake child). The suite must never spawn a real process:

```js
describe("embedImages", () => {
  it("refuses to embed before configure, rather than guessing a model", async () => {
    const { service } = makeService(); // existing helper in this file
    await expect(service.embedImages([Buffer.from("x")])).rejects.toThrow(
      /configure/
    );
  });

  it("sends base64 images and returns Float32Arrays", async () => {
    const { service, child, sent } = makeService();
    const p = service.configure({
      modelId: "Xenova/clip-vit-base-patch32",
      threads: 2,
    });
    child.reply({ id: sent.at(-1).id, ok: true });
    await p;

    const embed = service.embedImages([Buffer.from("abc"), Buffer.from("def")]);
    const req = sent.at(-1);
    expect(req.op).toBe("embed");
    expect(req.images).toEqual(["YWJj", "ZGVm"]);

    child.reply({
      id: req.id,
      vectors: [
        [1, 2],
        [3, 4],
      ],
      dim: 2,
    });
    const out = await embed;
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(out[1])).toEqual([3, 4]);
  });
});
```

> **Note for the implementer:** `makeService`/`child.reply`/`sent` are illustrative names. Read the existing helpers in `OnnxMLService.test.js` and use whatever that file already provides; do not add a second fake-spawn harness alongside it.

- [ ] **Step 8: Add the dependency and run the tests**

```bash
npm install @huggingface/transformers
npx vitest run server/ml/
```

Expected: PASS. **Then check for the nested native addon:**

```bash
npm ls onnxruntime-node
```

If this shows two entries, Task 13 fixes it — note the output and continue.

- [ ] **Step 9: Update `MLService`'s JSDoc for the new parameter type**

In `server/ml/MLService.js`, change the `embedImages` doc to `@param {Buffer[]} _buffers JPEG bytes` and add a line explaining why: the WebGPU host runs in a renderer with no filesystem access, so bytes cross the boundary, not paths — which also means `safeResolve` gains no new surface.

- [ ] **Step 10: Commit**

```bash
npm run format
git add server/ml/ server/lib/cachePaths.js package.json package-lock.json
git commit -m "feat(ml): model registry and real image embedding in the ONNX worker (#161)

Vision encoder only — the text encoder stays unloaded until #164 needs it,
saving both the download and the resident RAM. intraOpNumThreads is capped
because a separate process is not a separate CPU: uncapped ORT starves the
libvips pool reserved for thumbnails.

Refs #161"
```

---

### Task 9: `embedAllPending` — the sweep

**Files:**

- Create: `server/ml/embedSweep.js`
- Test: `server/ml/embedSweep.test.js`

**Interfaces:**

- Consumes: `runSweep` (`server/ml/sweep.js`), `pendingEmbedRows`/`putEmbeddings`/`markEmbedFailed` (Task 5), `thumbBytes` (Task 2), `quantize` (Task 3), `modelById` (Task 8)
- Produces: `embedAllPending(db, {ml, processing, model, limit, idle, job, onProgress}) -> Promise<{embedded, failed, paused, alreadyRunning?}>`, `embedProgress({done, failed})`, `_resetEmbedSweepForTest()`

- [ ] **Step 1: Write the failing test**

Create `server/ml/embedSweep.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "../db/connection.js";
import { upsertScan } from "../db/photos.js";
import {
  embedCounts,
  pendingEmbedRows,
  getEmbedding,
} from "../db/embeddings.js";
import {
  embedAllPending,
  embedProgress,
  _resetEmbedSweepForTest,
} from "./embedSweep.js";

const MODEL = "Xenova/clip-vit-base-patch32";
let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-sweep-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
  _resetEmbedSweepForTest();
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

function seed(db, n, folder = "/vol/Trip") {
  return upsertScan(
    db,
    folder,
    1,
    Array.from({ length: n }, (_, i) => ({
      name: `IMG_${i}.jpg`,
      size: 1000 + i,
      mtimeMs: 1700000000000 + i,
      kind: "image",
    }))
  ).map((r) => r.id);
}

/** A stub MLService. The suite NEVER loads a model or spawns anything. */
function stubMl({ failOn = () => false, dim = 512 } = {}) {
  const seen = [];
  return {
    seen,
    configure: vi.fn().mockResolvedValue({ ok: true }),
    embedImages: vi.fn(async (buffers) => {
      seen.push(buffers.length);
      return buffers.map((b) => {
        if (failOn(b)) throw new Error("model refused this image");
        return Float32Array.from({ length: dim }, (_, i) => Math.sin(b[0] + i));
      });
    }),
  };
}

/** A stub ProcessingService whose thumbnails are one identifying byte. */
function stubProcessing({ failFor = () => null } = {}) {
  return {
    thumbnail: vi.fn(async (path) => {
      const err = failFor(path);
      if (err) throw err;
      return { data: Buffer.from([path.length % 251]) };
    }),
    videoThumb: vi.fn(async () => ({ data: Buffer.from([7]) })),
  };
}

describe("embedAllPending", () => {
  it("drains the whole library to zero pending", async () => {
    const db = getDb();
    seed(db, 7);

    const r = await embedAllPending(db, {
      ml: stubMl(),
      processing: stubProcessing(),
      model: MODEL,
      limit: 3,
      idle: async () => {},
    });

    expect(r).toMatchObject({ embedded: 7, failed: 0, paused: false });
    expect(pendingEmbedRows(db, MODEL, 10)).toEqual([]);
    expect(embedCounts(db, MODEL)).toEqual({
      total: 7,
      embedded: 7,
      failed: 0,
    });
  });

  it("writes vectors of the model's dimension", async () => {
    const db = getDb();
    const [id] = seed(db, 1);
    await embedAllPending(db, {
      ml: stubMl(),
      processing: stubProcessing(),
      model: MODEL,
      idle: async () => {},
    });

    const got = getEmbedding(db, id, MODEL);
    expect(got.dim).toBe(512);
    expect(got.bytes).toHaveLength(512);
  });

  it("batches rather than embedding one photo at a time", async () => {
    const db = getDb();
    seed(db, 6);
    const ml = stubMl();
    await embedAllPending(db, {
      ml,
      processing: stubProcessing(),
      model: MODEL,
      limit: 3,
      idle: async () => {},
    });
    expect(ml.seen).toEqual([3, 3]);
  });

  it("isolates a poison photo, sentinels it, and still drains", async () => {
    const db = getDb();
    const ids = seed(db, 4);
    const bad = join("/vol/Trip", "IMG_2.jpg");

    const r = await embedAllPending(db, {
      ml: stubMl(),
      processing: stubProcessing({
        failFor: (p) => (p === bad ? new Error("corrupt jpeg") : null),
      }),
      model: MODEL,
      limit: 4,
      idle: async () => {},
    });

    expect(r.embedded).toBe(3);
    expect(r.failed).toBe(1);
    expect(pendingEmbedRows(db, MODEL, 10)).toEqual([]);
    expect(embedCounts(db, MODEL).failed).toBe(1);
    expect(ids).toHaveLength(4);
  });

  it("PAUSES and marks NOTHING when the folder is unreachable", async () => {
    const db = getDb();
    seed(db, 3, "/vol/Gone");
    const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });

    const r = await embedAllPending(db, {
      ml: stubMl(),
      processing: stubProcessing({ failFor: () => enoent }),
      model: MODEL,
      idle: async () => {},
    });

    // #169's lesson: an unmount is a property of the MOMENT. Marking here is
    // what excluded a whole drive from hashing forever.
    expect(r.paused).toBe(true);
    expect(embedCounts(db, MODEL).failed).toBe(0);
    expect(pendingEmbedRows(db, MODEL, 10)).toHaveLength(3);
  });

  it("is single-flight — a second scan must not start a second sweep", async () => {
    const db = getDb();
    seed(db, 2);
    const opts = {
      ml: stubMl(),
      processing: stubProcessing(),
      model: MODEL,
      idle: async () => {},
    };
    const [first, second] = await Promise.all([
      embedAllPending(db, opts),
      embedAllPending(db, opts),
    ]);
    expect([first.alreadyRunning, second.alreadyRunning]).toContain(true);
  });

  it("configures the service with the active model before embedding", async () => {
    const db = getDb();
    seed(db, 1);
    const ml = stubMl();
    await embedAllPending(db, {
      ml,
      processing: stubProcessing(),
      model: MODEL,
      threads: 4,
      idle: async () => {},
    });
    expect(ml.configure).toHaveBeenCalledWith({ modelId: MODEL, threads: 4 });
  });

  it("stops when the job is canceled", async () => {
    const db = getDb();
    seed(db, 20);
    const controller = new AbortController();
    const job = { controller };

    const p = embedAllPending(db, {
      ml: stubMl(),
      processing: stubProcessing(),
      model: MODEL,
      limit: 2,
      job,
      idle: async () => controller.abort(),
    });

    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("embedProgress", () => {
  it("reports embedded separately from failed", () => {
    expect(embedProgress({ done: 100, failed: 3 })).toEqual({
      done: 97,
      phase: "97 embedded · 3 failed",
    });
  });

  it("omits the failure clause when there are none", () => {
    expect(embedProgress({ done: 5, failed: 0 }).phase).toBe("5 embedded");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/ml/embedSweep.test.js`
Expected: FAIL — cannot resolve `./embedSweep.js`.

- [ ] **Step 3: Implement `server/ml/embedSweep.js`**

```js
import { join } from "node:path";
import { whenIdle } from "../lib/interactive.js";
import { runSweep } from "./sweep.js";
import { thumbBytes } from "./thumbSource.js";
import { quantize } from "./quantize.js";
import { modelById } from "./models.js";
import {
  pendingEmbedRows,
  putEmbeddings,
  markEmbedFailed,
} from "../db/embeddings.js";

let embedInFlight = false;

/**
 * Embed the whole library's pending photos in the background, to completion.
 *
 * The drain, the idle gating, cancellation, poison-file isolation and — most
 * importantly — the permanent/transient CLASSIFICATION all live in runSweep.
 * What stays here is what is genuinely embedding's own: the worklist query, the
 * thumbnail read, the encoder call, and the sentinel WRITE.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ml: object, processing: object, model: string, threads?: number,
 *          limit?: number, idle?: () => Promise<void>, job?: object|null,
 *          onProgress?: (c: {done: number, failed: number}) => void|null}} opts
 * @returns {Promise<{embedded: number, failed: number, paused: boolean, alreadyRunning?: boolean}>}
 */
export async function embedAllPending(
  db,
  {
    ml,
    processing,
    model,
    threads = 1,
    limit = 16,
    idle = whenIdle,
    job = null,
    onProgress = null,
  }
) {
  if (embedInFlight)
    return { embedded: 0, failed: 0, paused: false, alreadyRunning: true };
  embedInFlight = true;

  try {
    const spec = modelById(model);
    await ml.configure({ modelId: model, threads });

    const { done, failed, paused } = await runSweep(job, {
      nextBatch: () => pendingEmbedRows(db, model, limit),
      process: async (rows) => {
        const buffers = [];
        for (const row of rows) {
          buffers.push(
            await thumbBytes(
              {
                path: join(row.folder_abs_path, row.filename),
                mtime: row.mtime,
                size: row.size,
                kind: row.kind,
              },
              processing
            )
          );
        }
        const vectors = await ml.embedImages(buffers);
        putEmbeddings(
          db,
          rows.map((row, i) => ({
            photoId: row.id,
            model,
            dim: spec.dim,
            ...quantize(vectors[i]),
          }))
        );
        return rows.length;
      },
      markFailed: (row, err) => markEmbedFailed(db, row.id, model, err),
      folderOf: (row) => row.folder_abs_path,
      onProgress: onProgress ?? undefined,
      idle,
    });

    return { embedded: done - failed, failed, paused };
  } finally {
    embedInFlight = false;
  }
}

/** Test-only: clear the single-flight latch between cases. */
export function _resetEmbedSweepForTest() {
  embedInFlight = false;
}

/**
 * runSweep's `done` counts rows CLASSIFIED (written or sentinel-marked). The
 * user needs those separated: "not computed yet" and "cannot be computed" are
 * different answers, and collapsing them is how pre-2.17.14 backupCoverage
 * misled.
 * @param {{done: number, failed: number}} counters
 * @returns {{done: number, phase: string}}
 */
export function embedProgress({ done, failed }) {
  const embedded = done - failed;
  const phase =
    failed > 0
      ? `${embedded.toLocaleString()} embedded · ${failed} failed`
      : `${embedded.toLocaleString()} embedded`;
  return { done: embedded, phase };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/ml/embedSweep.test.js`
Expected: PASS (10 tests)

- [ ] **Step 5: Verify the pause test can fail**

Temporarily change `folderOf: (row) => row.folder_abs_path` to `folderOf: () => "/"` (always reachable) and re-run. The "PAUSES and marks NOTHING" case must go RED — that is the #169 guard actually being tested. Restore and confirm GREEN.

- [ ] **Step 6: Commit**

```bash
npm run format
git add server/ml/embedSweep.js server/ml/embedSweep.test.js
git commit -m "feat(ml): embedAllPending sweep on the shared runSweep (#161)

Drains to zero, isolates poison files with a countable sentinel, and pauses
without marking anything when a drive goes away. The pause case was verified
red by making folderOf always reachable — #169's exact failure shape.

Refs #161"
```

---

### Task 10: Settings, API, and the post-scan kick

**Files:**

- Create: `server/ml/settings.js`
- Modify: `server/api.js` (add `kickEmbedSweep`, call it beside `kickHashSweep` at :663 and :684, add the `/api/ml/*` routes)
- Modify: `server/index.js` (`createApp({ ml })`)
- Test: `server/ml/settings.test.js`; extend `server/api.test.js`

**Interfaces:**

- Produces: `readMlSettings()`, `writeMlSettings(patch)`, `defaultThreads()`; routes `GET/PUT /api/ml/settings`, `GET /api/ml/stats`, `POST /api/ml/purge`, `POST /api/ml/embed`
- `createApp({ ml })` — `ml` defaults to a lazily-constructed `OnnxMLService`

- [ ] **Step 1: Write the failing settings test**

Create `server/ml/settings.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpus } from "node:os";
import { readMlSettings, writeMlSettings, defaultThreads } from "./settings.js";
import { DEFAULT_MODEL_ID } from "./models.js";

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-mlset-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

describe("ML settings", () => {
  it("defaults to SigLIP at half the cores", () => {
    const s = readMlSettings();
    expect(s.modelId).toBe(DEFAULT_MODEL_ID);
    expect(s.threads).toBe(defaultThreads());
  });

  it("defaults threads to half the cores, never below 1", () => {
    expect(defaultThreads()).toBe(Math.max(1, Math.floor(cpus().length / 2)));
  });

  it("persists a change", () => {
    writeMlSettings({ threads: 3 });
    expect(readMlSettings().threads).toBe(3);
  });

  it("rejects an unknown model rather than persisting it", () => {
    expect(() => writeMlSettings({ modelId: "evil/model" })).toThrow(
      /unknown model/i
    );
    expect(readMlSettings().modelId).toBe(DEFAULT_MODEL_ID);
  });

  it("clamps threads to the machine's core count", () => {
    writeMlSettings({ threads: 9999 });
    expect(readMlSettings().threads).toBeLessThanOrEqual(cpus().length);
    writeMlSettings({ threads: 0 });
    expect(readMlSettings().threads).toBe(1);
  });

  it("survives a corrupt settings file rather than crashing the server", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(cacheDir, "ml.json"), "{ not json");
    expect(readMlSettings().modelId).toBe(DEFAULT_MODEL_ID);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/ml/settings.test.js`
Expected: FAIL — cannot resolve `./settings.js`.

- [ ] **Step 3: Implement `server/ml/settings.js`**

```js
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cpus } from "node:os";
import { cacheRoot } from "../lib/cachePaths.js";
import { DEFAULT_MODEL_ID, modelById } from "./models.js";

function settingsFile() {
  mkdirSync(cacheRoot(), { recursive: true });
  return join(cacheRoot(), "ml.json");
}

/**
 * Half the cores, floor 1.
 *
 * A separate process is NOT a separate CPU. Left uncapped, ORT takes every core
 * and starves the 16-slot libvips pool server/index.js:19 reserves for
 * thumbnails — measured at 15ms -> 90ms with tiles abandoned mid-scroll. Half
 * leaves the grid responsive while still finishing a large backfill unattended.
 * @returns {number}
 */
export function defaultThreads() {
  return Math.max(1, Math.floor(cpus().length / 2));
}

/** @returns {{modelId: string, threads: number}} */
export function readMlSettings() {
  const defaults = { modelId: DEFAULT_MODEL_ID, threads: defaultThreads() };
  const file = settingsFile();
  if (!existsSync(file)) return defaults;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    // Validate on READ as well as write: a hand-edited or partially-written
    // file must not take ML down, and must never name a model we never vetted.
    const modelId = MODEL_IS_KNOWN(raw.modelId)
      ? raw.modelId
      : defaults.modelId;
    return { modelId, threads: clampThreads(raw.threads ?? defaults.threads) };
  } catch {
    return defaults;
  }
}

/** @param {{modelId?: string, threads?: number}} patch */
export function writeMlSettings(patch) {
  const current = readMlSettings();
  const next = { ...current };
  if (patch.modelId !== undefined) {
    modelById(patch.modelId); // throws "unknown model: …" — do not persist it
    next.modelId = patch.modelId;
  }
  if (patch.threads !== undefined) next.threads = clampThreads(patch.threads);
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

function clampThreads(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return defaultThreads();
  return Math.min(cpus().length, Math.max(1, v));
}

function MODEL_IS_KNOWN(id) {
  try {
    modelById(id);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/ml/settings.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Add the API routes and the post-scan kick**

In `server/api.js`, add imports:

```js
import { embedAllPending, embedProgress } from "./ml/embedSweep.js";
import { readMlSettings, writeMlSettings } from "./ml/settings.js";
import { MODELS } from "./ml/models.js";
import { embedCounts, modelStorage, purgeModel } from "./db/embeddings.js";
```

Change `export function createApp() {` to `export function createApp({ ml } = {}) {` and, near the top of the function body, resolve the host lazily so no child is spawned unless embedding actually runs:

```js
// The ML host. Injected by electron/main.js (the WebGPU renderer); otherwise
// the ONNX child process, which is also what `npm run dev` gets. server/ must
// never import electron — same seam as ProcessingService.
let mlService = ml ?? null;
const getMl = () => (mlService ??= new OnnxMLService());
```

with `import { OnnxMLService } from "./ml/OnnxMLService.js";`.

Add the kick beside `kickHashSweep`:

```js
/** Kick the background embedder with a JobsPanel entry. Fire-and-forget: it
 *  must never block a scan's response. */
function kickEmbedSweep(db, getMl) {
  const { modelId, threads } = readMlSettings();
  const job = registry.create("embed", { label: "Embedding photos" });
  embedAllPending(db, {
    ml: getMl(),
    processing,
    model: modelId,
    threads,
    job,
    onProgress: (counters) => registry.update(job.id, embedProgress(counters)),
  })
    .then((r) => {
      if (r.alreadyRunning)
        return registry.finish(job.id, { alreadyRunning: true });
      if (r.paused) {
        return registry.update(job.id, {
          status: "failed",
          error: "paused — drive not available; resumes on the next scan",
        });
      }
      registry.finish(job.id, { embedded: r.embedded, failed: r.failed });
    })
    .catch((e) =>
      registry.fail(
        job.id,
        // Name the stage and keep the app usable. ML failing must never read
        // as the app failing.
        new Error(`Embedding stopped: ${e.message}. Photos are unaffected.`)
      )
    );
}
```

Add `"embed"` to `SELF_CLEARING` in `server/jobs/registry.js:16`, and call `kickEmbedSweep(db, getMl);` immediately after each existing `kickHashSweep(db);` (lines 663 and 684).

Then add the routes:

```js
// --- ML settings and status ---------------------------------------------
app.get("/api/ml/settings", (req, res) => {
  res.json({ ...readMlSettings(), models: MODELS });
});

app.put("/api/ml/settings", (req, res) => {
  try {
    res.json(writeMlSettings(req.body ?? {}));
  } catch (err) {
    // Specific over generic: the user picked something; say what was wrong.
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/ml/stats", (req, res) => {
  const db = getDb();
  const { modelId } = readMlSettings();
  res.json({
    model: modelId,
    counts: embedCounts(db, modelId),
    storage: modelStorage(db),
  });
});

app.post("/api/ml/purge", (req, res) => {
  const model = String(req.body?.model ?? "");
  if (!model) return res.status(400).json({ error: "model is required" });
  res.json(purgeModel(getDb(), model));
});

app.post("/api/ml/embed", (req, res) => {
  kickEmbedSweep(getDb(), getMl);
  res.json({ started: true });
});
```

- [ ] **Step 6: Extend `server/api.test.js`**

Add cases following that file's existing supertest pattern (read it first):

```js
describe("/api/ml", () => {
  it("reports the default model and the available models", async () => {
    const res = await request(app).get("/api/ml/settings").expect(200);
    expect(res.body.modelId).toBe("Xenova/siglip-base-patch16-224");
    expect(res.body.models.map((m) => m.id)).toContain(
      "Xenova/clip-vit-base-patch32"
    );
  });

  it("rejects an unknown model with a specific message, not a generic 500", async () => {
    const res = await request(app)
      .put("/api/ml/settings")
      .send({ modelId: "evil/model" })
      .expect(400);
    expect(res.body.error).toMatch(/unknown model/i);
  });

  it("reports embedded, failed and total separately", async () => {
    const res = await request(app).get("/api/ml/stats").expect(200);
    expect(res.body.counts).toHaveProperty("total");
    expect(res.body.counts).toHaveProperty("embedded");
    expect(res.body.counts).toHaveProperty("failed");
  });

  it("requires a model to purge", async () => {
    await request(app).post("/api/ml/purge").send({}).expect(400);
  });
});
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS. **No test may spawn a child process** — `createApp()` with no `ml` constructs `OnnxMLService` lazily, and nothing in the suite calls `/api/ml/embed`.

- [ ] **Step 8: Commit**

```bash
npm run format
git add server/ml/settings.js server/ml/settings.test.js server/api.js server/api.test.js server/jobs/registry.js
git commit -m "feat(ml): ML settings, stats endpoints and the post-scan embed sweep (#161)

Threads default to half the cores: a separate process is not a separate
CPU, and uncapped ORT starves the libvips pool reserved for thumbnails.
createApp now takes an injectable ml host so server/ never imports electron.

Refs #161"
```

---

## Phase 4 — WebGPU host, UI, packaging

### Task 11: `WebGpuMLService` — inference in a hidden Electron renderer

Prebuilt `onnxruntime-node` has no CoreML on any platform, so Apple Silicon gets CPU from the child process. Chromium's WebGPU is a different runtime and does reach the GPU — the same path transformers.js demos use.

**Files:**

- Create: `server/ml/WebGpuMLService.js`
- Create: `electron/mlHost.html`
- Create: `electron/mlHost.js`
- Modify: `electron/main.js`
- Test: `server/ml/WebGpuMLService.test.js`

**Interfaces:**

- Produces: `WebGpuMLService` implementing `configure`/`embedImages`, plus `available() -> Promise<boolean>`
- Constructor takes `{ createWindow }` so tests inject a fake and never open a real window.

- [ ] **Step 1: Write the failing test**

Create `server/ml/WebGpuMLService.test.js`:

```js
import { describe, it, expect, vi } from "vitest";
import { WebGpuMLService } from "./WebGpuMLService.js";

/** A fake hidden window: records what was sent, replies on demand. */
function fakeWindow({ webgpu = true } = {}) {
  const handlers = new Map();
  return {
    sent: [],
    async invoke(channel, payload) {
      this.sent.push({ channel, payload });
      if (channel === "ml:available") return webgpu;
      const h = handlers.get(channel);
      return h ? h(payload) : { ok: true };
    },
    on(channel, fn) {
      handlers.set(channel, fn);
    },
    destroy: vi.fn(),
  };
}

describe("WebGpuMLService", () => {
  it("reports unavailable when the renderer has no WebGPU adapter", async () => {
    const win = fakeWindow({ webgpu: false });
    const svc = new WebGpuMLService({ createWindow: async () => win });
    expect(await svc.available()).toBe(false);
  });

  it("reports available when the renderer has one", async () => {
    const svc = new WebGpuMLService({ createWindow: async () => fakeWindow() });
    expect(await svc.available()).toBe(true);
  });

  it("passes image BYTES, not paths — the renderer has no filesystem", async () => {
    const win = fakeWindow();
    win.on("ml:embed", () => ({ vectors: [[1, 2, 3]], dim: 3 }));
    const svc = new WebGpuMLService({ createWindow: async () => win });

    await svc.configure({
      modelId: "Xenova/clip-vit-base-patch32",
      threads: 4,
    });
    const out = await svc.embedImages([Buffer.from([9, 8, 7])]);

    const embed = win.sent.find((s) => s.channel === "ml:embed");
    expect(embed.payload.images[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(embed.payload.images[0])).toEqual([9, 8, 7]);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(out[0])).toEqual([1, 2, 3]);
  });

  it("refuses to embed before configure", async () => {
    const svc = new WebGpuMLService({ createWindow: async () => fakeWindow() });
    await expect(svc.embedImages([Buffer.from([1])])).rejects.toThrow(
      /configure/
    );
  });

  it("creates the window once, not per batch", async () => {
    const win = fakeWindow();
    win.on("ml:embed", () => ({ vectors: [[1]], dim: 1 }));
    const createWindow = vi.fn(async () => win);
    const svc = new WebGpuMLService({ createWindow });

    await svc.configure({
      modelId: "Xenova/clip-vit-base-patch32",
      threads: 1,
    });
    await svc.embedImages([Buffer.from([1])]);
    await svc.embedImages([Buffer.from([2])]);

    expect(createWindow).toHaveBeenCalledTimes(1);
  });

  it("surfaces a renderer crash as a named error, not a hang", async () => {
    const win = fakeWindow();
    win.on("ml:embed", () => {
      throw new Error("Render frame was disposed");
    });
    const svc = new WebGpuMLService({ createWindow: async () => win });
    await svc.configure({
      modelId: "Xenova/clip-vit-base-patch32",
      threads: 1,
    });

    await expect(svc.embedImages([Buffer.from([1])])).rejects.toThrow(
      /WebGPU host/
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/ml/WebGpuMLService.test.js`
Expected: FAIL — cannot resolve `./WebGpuMLService.js`.

- [ ] **Step 3: Implement `server/ml/WebGpuMLService.js`**

```js
import { MLService } from "./MLService.js";

/**
 * Inference in a hidden Electron renderer, on the GPU.
 *
 * WHY A SECOND HOST. Prebuilt onnxruntime-node ships NO CoreML on any platform,
 * so on Apple Silicon the child process is CPU-only — DirectML (Windows) and
 * CUDA (Linux x64) are the only real EPs it has. Chromium's WebGPU is a
 * different runtime entirely and does reach the GPU. Since the app is already
 * Electron, that host is already paid for.
 *
 * It is still out-of-process, so #160's resilience argument holds unchanged: a
 * hard resource boundary, a kill switch, and crash isolation.
 *
 * `createWindow` is injected so the test suite never opens a real BrowserWindow
 * — and so server/ never imports electron. electron/main.js supplies the real
 * one.
 */
export class WebGpuMLService extends MLService {
  #createWindow;
  #win = null;
  #modelId = null;

  /** @param {{createWindow: () => Promise<{invoke: Function, destroy: Function}>}} opts */
  constructor({ createWindow }) {
    super();
    this.#createWindow = createWindow;
  }

  async #window() {
    // Once, not per batch: creating a renderer and re-downloading model weights
    // for every 16 photos would be slower than the CPU path it replaces.
    return (this.#win ??= await this.#createWindow());
  }

  /** Does this machine actually have a WebGPU adapter? The answer decides
   *  which host runs, and it must be honest — the settings panel shows it. */
  async available() {
    try {
      const win = await this.#window();
      return Boolean(await win.invoke("ml:available"));
    } catch {
      return false;
    }
  }

  /** @param {{modelId: string, threads: number}} opts */
  async configure({ modelId, threads }) {
    this.#modelId = modelId;
    const win = await this.#window();
    return win.invoke("ml:configure", { modelId, threads });
  }

  /**
   * @param {Buffer[]} buffers JPEG bytes
   * @returns {Promise<Float32Array[]>}
   */
  async embedImages(buffers) {
    if (!this.#modelId) throw new Error("WebGpuMLService: configure() first");
    const win = await this.#window();
    try {
      const { vectors } = await win.invoke("ml:embed", {
        modelId: this.#modelId,
        // Uint8Array crosses the IPC boundary by structured clone. Bytes, not
        // paths: the renderer has no filesystem access, which also means
        // safeResolve gains no new surface to guard.
        images: buffers.map((b) => new Uint8Array(b)),
      });
      return vectors.map((v) => Float32Array.from(v));
    } catch (e) {
      // Drop the window so the next batch rebuilds it rather than talking to a
      // corpse — and name the stage, per the usability contract.
      this.#win = null;
      throw new Error(`WebGPU host failed: ${e?.message ?? e}`);
    }
  }

  stop() {
    this.#win?.destroy?.();
    this.#win = null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/ml/WebGpuMLService.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Create the renderer page**

Create `electron/mlHost.html`:

```html
<!doctype html>
<meta charset="utf-8" />
<title>AutoGallery ML host</title>
<body>
  <script type="module" src="./mlHost.js"></script>
</body>
```

Create `electron/mlHost.js`:

```js
/**
 * The WebGPU ML host, running in a hidden renderer.
 *
 * This file is a BROWSER context, not Node: no fs, no require. It receives JPEG
 * bytes and returns vectors. Diagnostics go to the renderer console, which
 * read_console_messages can read during verification.
 */
import {
  AutoProcessor,
  RawImage,
  SiglipVisionModel,
  CLIPVisionModelWithProjection,
  env,
} from "@huggingface/transformers";

const LOADERS = { SiglipVisionModel, CLIPVisionModelWithProjection };

let loaded = null;

async function ensureModel(spec) {
  if (loaded?.id === spec.id) return loaded;
  env.allowLocalModels = false;
  const model = await LOADERS[spec.loader].from_pretrained(spec.id, {
    dtype: spec.dtype,
    device: "webgpu",
  });
  const processor = await AutoProcessor.from_pretrained(spec.id);
  loaded = { id: spec.id, model, processor, outputKey: spec.outputKey };
  return loaded;
}

window.mlHost = {
  async available() {
    if (!navigator.gpu) return false;
    try {
      return Boolean(await navigator.gpu.requestAdapter());
    } catch {
      return false;
    }
  },

  async configure({ spec }) {
    await ensureModel(spec);
    return { ok: true };
  },

  async embed({ spec, images }) {
    const { model, processor, outputKey } = await ensureModel(spec);
    const raw = await Promise.all(
      images.map((bytes) => RawImage.fromBlob(new Blob([bytes])))
    );
    const out = await model(await processor(raw));
    const tensor = out[outputKey];
    const [n, dim] = tensor.dims;
    const vectors = [];
    for (let i = 0; i < n; i++) {
      vectors.push(Array.from(tensor.data.slice(i * dim, (i + 1) * dim)));
    }
    return { vectors, dim };
  },
};
```

- [ ] **Step 6: Wire it up in `electron/main.js`**

Add a `createMlWindow` factory and inject the host into `createApp`. The `modelById` lookup happens on the Node side so the renderer never chooses a model:

```js
import { WebGpuMLService } from "../server/ml/WebGpuMLService.js";
import { modelById } from "../server/ml/models.js";

/** A hidden renderer that runs transformers.js on WebGPU. Chromium reaches the
 *  GPU that prebuilt onnxruntime-node cannot (no CoreML in any prebuilt). */
async function createMlWindow() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: false },
  });
  await win.loadFile(path.join(__dirname, "mlHost.html"));

  return {
    async invoke(channel, payload = {}) {
      const spec = payload.modelId ? modelById(payload.modelId) : null;
      if (channel === "ml:available")
        return win.webContents.executeJavaScript("window.mlHost.available()");
      if (channel === "ml:configure")
        return win.webContents.executeJavaScript(
          `window.mlHost.configure(${JSON.stringify({ spec })})`
        );
      if (channel === "ml:embed")
        return win.webContents.executeJavaScript(
          `window.mlHost.embed(${JSON.stringify({
            spec,
            images: payload.images.map((u8) => Array.from(u8)),
          })})`
        );
      throw new Error(`unknown ml channel: ${channel}`);
    },
    destroy: () => win.destroy(),
  };
}
```

Then, where `createApp()` is called, select the host:

```js
const webgpu = new WebGpuMLService({ createWindow: createMlWindow });
// Honest fallback: if this machine has no adapter, use the CPU child and SAY
// so in the settings panel. A provider label that lies is worse than no label.
const ml = (await webgpu.available()) ? webgpu : undefined;
const app = createApp({ ml });
```

- [ ] **Step 7: Run the suite and verify no window opens**

Run: `npm test`
Expected: PASS. No Electron window may open during tests — `WebGpuMLService` is only constructed in `electron/main.js`, which the suite never imports.

- [ ] **Step 8: Commit**

```bash
npm run format
git add server/ml/WebGpuMLService.js server/ml/WebGpuMLService.test.js electron/
git commit -m "feat(ml): WebGPU inference host in a hidden Electron renderer (#161)

Prebuilt onnxruntime-node ships no CoreML on any platform, so the child
process is CPU-only on Apple Silicon. Chromium's WebGPU is a different
runtime and does reach the GPU. Injected via createApp so server/ never
imports electron and npm run dev falls back to the child automatically.

Refs #161"
```

---

### Task 12: Settings UI

**Files:**

- Create: `ui/src/lib/MlSettings.svelte`
- Modify: the settings/library panel that already hosts the cache controls (find it with `grep -rn "getCacheStats\|Manage library\|cache" ui/src --include=*.svelte`)
- Test: `e2e/ml-settings.spec.js`; selectors into `e2e/helpers.js`

**Interfaces:**

- Consumes: `GET/PUT /api/ml/settings`, `GET /api/ml/stats`, `POST /api/ml/purge`, `POST /api/ml/embed` (Task 10)
- This component stays **Svelte 4** (`export let`, `$:`) unless the panel it mounts into is already runes — a component is all-runes or all-legacy, never half (CLAUDE.md).

- [ ] **Step 1: Write the failing e2e test**

Create `e2e/ml-settings.spec.js` using the existing fixture and helpers (read `e2e/helpers.js` first and add any new selectors there, never inline):

```js
import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, openSettings } from "./helpers.js";

test.describe("ML settings", () => {
  test("shows counts, model choice and the active provider", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await openSettings(page);

    const panel = page.getByTestId("ml-settings");
    await expect(panel).toBeVisible();

    // Pending must read as "not computed yet", distinctly from failed —
    // collapsing them is how pre-2.17.14 backupCoverage misled.
    await expect(panel.getByTestId("ml-counts")).toContainText(/embedded/i);
    await expect(panel.getByTestId("ml-provider")).not.toBeEmpty();
    await expect(panel.getByTestId("ml-model")).toBeVisible();

    expect(errors).toEqual([]);
  });

  test("switching the model persists and keeps the old model's storage listed", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await openSettings(page);

    await page
      .getByTestId("ml-model")
      .selectOption("Xenova/clip-vit-base-patch32");
    await page.reload();
    await openSettings(page);

    await expect(page.getByTestId("ml-model")).toHaveValue(
      "Xenova/clip-vit-base-patch32"
    );
    expect(errors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test e2e/ml-settings.spec.js`
Expected: FAIL — no `ml-settings` testid exists.

- [ ] **Step 3: Build `ui/src/lib/MlSettings.svelte`**

Requirements — each is a line in CLAUDE.md's usability contract, not a nicety:

1. **Model `<select>`** listing `models` from `GET /api/ml/settings`, each option showing label, dim, and `approxDownloadMB`. Changing it PUTs, then re-fetches stats.
2. **A visible warning on switch**: vectors from different models are not comparable, so switching starts a fresh backfill. Say it before it happens, not after.
3. **CPU-share slider** 1..`cpus().length` (served in the settings payload), defaulting to half.
4. **Active provider**, read-only, from the stats payload. Under `npm run dev` this must render "CPU (WebGPU unavailable outside the app)". **It must never claim an accelerator that isn't running.**
5. **Counts**: `"{embedded} of {total} embedded, {failed} failed, {pending} pending"`, with pending computed as `total - embedded - failed` and rendered distinctly.
6. **Per-model storage rows** with a purge button each, confirming before deleting.
7. **An "Embed now" button** POSTing `/api/ml/embed`; progress appears in the JobsPanel.
8. **Every fetch's failure renders inline** via `result.error` — the existing pattern. A dead button is not acceptable.

Mount it in the existing settings/library panel beside the cache controls, with `data-testid="ml-settings"` on the root and testids `ml-counts`, `ml-provider`, `ml-model`.

- [ ] **Step 4: Run the e2e test to verify it passes**

Run: `npx playwright test e2e/ml-settings.spec.js`
Expected: PASS, with `trackPageErrors` clean.

- [ ] **Step 5: Commit**

```bash
npm run format
git add ui/src/lib/MlSettings.svelte ui/src e2e/
git commit -m "feat(ui): ML settings — model, CPU share, provider and honest counts (#161)

Pending and failed render distinctly, because 'not computed yet' and
'cannot be computed' are different answers to the user. The provider label
never claims an accelerator that is not running.

Refs #161"
```

---

### Task 13: Packaging — exactly one `onnxruntime-node`

**Files:**

- Modify: `package.json` (`overrides`, and `CHANGELOG.md` in the next task)

- [ ] **Step 1: Show the problem**

Run: `npm ls onnxruntime-node`
Expected: **two** entries — the top-level `^1.27.0` and a nested `1.24.3` under `@huggingface/transformers`. Record the output; this is #67's shape.

- [ ] **Step 2: Add the override**

In `package.json`, extend the existing `overrides` block (which already carries the `adm-zip` entry) with a sibling:

```json
  "overrides": {
    "onnxruntime-node": {
      "adm-zip": "^0.6.0"
    },
    "@huggingface/transformers": {
      "onnxruntime-node": "$onnxruntime-node"
    }
  }
```

`$onnxruntime-node` resolves to the top-level dependency's version, so the two can never drift apart again.

- [ ] **Step 3: Verify exactly one copy, and that it works**

```bash
rm -rf node_modules package-lock.json && npm install
npm ls onnxruntime-node
```

Expected: exactly ONE entry. Then run `npm test`.

**If transformers.js is incompatible with ORT 1.27**, change the top-level `dependencies.onnxruntime-node` to `1.24.3` instead and drop the override. One copy is the requirement; the version is negotiable. Record which path was taken in the commit message — a future reader needs to know this was measured, not guessed.

- [ ] **Step 4: Confirm the packaging globs still cover it**

`asarUnpack` already lists `node_modules/onnxruntime-node/**` and `rebuild:electron` already passes `-w onnxruntime-node`. With one hoisted copy both are correct. Verify the path exists: `ls node_modules/onnxruntime-node/package.json`.

- [ ] **Step 5: Commit**

```bash
npm run format
git add package.json package-lock.json
git commit -m "fix(build): collapse the nested onnxruntime-node copy (#161)

@huggingface/transformers pins onnxruntime-node to exactly 1.24.3 against
our ^1.27.0, so npm installed a second native addon that both asarUnpack
and electron-rebuild -w glob past — a Node-ABI binary in an Electron build,
which is exactly how #67 crashed on launch.

Refs #161, #67"
```

---

### Task 14: Measure, document, release

#161's first acceptance criterion is "model choice recorded with its measured cost per photo on the real library" — no test can satisfy it.

**Files:**

- Modify: `package.json` (version), `CHANGELOG.md`, `docs/superpowers/specs/2026-07-25-image-embeddings-design.md` (record measurements)

- [ ] **Step 1: Measure on the real library**

Launch the packaged/Electron app against a real folder (see `docs/TEST_FOLDERS.local.md`; those folders are **strictly read-only**). Let the sweep run and record, for **both** hosts and **both** models:

- ms/photo, from the JobsPanel progress rate
- the active provider reported in settings
- peak RSS of the host process
- whether scrolling stayed responsive at the default half-cores setting

- [ ] **Step 2: Verify against a live scroll — the acceptance criterion**

With a backfill running, scroll the grid hard and confirm tiles are not abandoned. **This is required explicitly by #161** ("verify against a live scroll, not just a test") and by CLAUDE.md's manual-verification convention. A passing suite is not sufficient here.

- [ ] **Step 3: Verify restart resumption**

Quit mid-backfill, relaunch, confirm the sweep resumes from the DB worklist and the counts continue rather than restarting. The worklist is SQL, so this should hold — confirm it does.

- [ ] **Step 4: Record the numbers in the spec**

Append a "## Measured (2026-07-…)" section to `docs/superpowers/specs/2026-07-25-image-embeddings-design.md` with a table of the above. If SigLIP's measured cost makes CLIP the better default, **say so and change `DEFAULT_MODEL_ID`** — the measurement is the point.

- [ ] **Step 5: Bump the version and write the changelog**

Set `package.json` version to **`2.18.28`** (already claimed). Add to `CHANGELOG.md`, newest first, user-facing:

```markdown
## 2.18.28

- Photos are now analyzed in the background so future features can find them by
  what they look like, not just by name or date. Progress and any failures show
  in the jobs panel, and the whole library ends up with warm thumbnails as a
  side effect (#161).
- New ML settings: choose the model, cap how much CPU the analysis may use
  (half your cores by default), see how many photos are done, and reclaim the
  space a model's data takes (#161).
- On the Mac app, analysis runs on the GPU (#161).
```

- [ ] **Step 6: Full verification before the PR**

```bash
npm test
npx playwright test
npm run build
npm ls onnxruntime-node   # must be exactly one
```

All four must pass. Do not claim completion on a partial run — paste the actual counts into the PR body.

- [ ] **Step 7: Rebase, commit, PR**

```bash
git fetch origin && git rebase origin/main
```

Resolve any `CHANGELOG.md` conflict mechanically — keep both entries, newest version on top. **If `main`'s version has passed 2.18.28**, release the claim and re-claim:

```bash
git push origin :refs/tags/claim/2.18.28
.claude/skills/working-issues/claim-version.sh 161
```

```bash
npm run format
git add package.json CHANGELOG.md docs/
git commit -m "chore(release): 2.18.28 — image embeddings over cached thumbnails (#161)

Refs #161"
git push -u origin issue-161-embeddings
gh pr create --title "feat(ml): image embeddings over cached thumbnails (#161)" --body "Refs #161

<what the user can now do, the measured cost per photo, and the test counts>"
```

- [ ] **Step 8: Post the evidence comment and hand back for validation**

Per the working-issues skill, after merge:

```bash
gh issue edit 161 --remove-label wip --add-label needs-validation
git push origin :refs/tags/claim/2.18.28
```

**Do not close #161.** John validates and closes.

---

## Self-review notes

**Spec coverage.** §A input pipeline → Tasks 1-2. §B storage → Tasks 3-6. §C two hosts → Tasks 8, 11. §D sweep + settings → Tasks 9, 10, 12. §E never-fail-silently → Task 10 (job errors, 400s) and Task 12 (inline errors, honest provider label, distinct pending/failed). §F packaging → Task 13. Testing section → Tasks 3, 5, 7, 9, 11, 12, and the measurement in Task 14. Build order maps to the four phases.

**Known gaps, deliberate.** (1) `queryPlan.test.js`'s `seed` helper shape is unverified — Task 7 tells the implementer to read it first rather than guessing. (2) `OnnxMLService.test.js`'s existing fake-spawn helper names are illustrative in Task 8 Step 7, flagged inline. (3) The settings panel's exact host component is found by grep in Task 12 rather than named, because it was not read during planning. Each is called out at its use site rather than hidden.

**Type consistency.** `embedImages` takes `Buffer[]` and returns `Float32Array[]` in both hosts (Tasks 8, 11) and is called that way in Task 9; the `MLService` JSDoc is updated in Task 8 Step 9. `quantize` returns `{scale, bytes}`, spread directly into `putEmbedding`'s `{photoId, model, dim, scale, bytes}` in Tasks 5, 6, 9. `pendingEmbedRows` returns `folder_abs_path`/`filename`/`mtime`/`size`/`kind`, which is exactly what Task 9's `process` reads and what `folderOf` uses.
