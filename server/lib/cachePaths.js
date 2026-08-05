import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

/**
 * Resolve the AutoGallery cache root on the INTERNAL disk.
 *
 * ALL writes this app makes land under here (~/.autogallery). Scanned photo
 * folders are strictly read-only; nothing is ever written back to them.
 *
 * Overridable via AUTOGALLERY_HOME so tests can point at a temp dir.
 *
 * ## Under a test runner the override is REQUIRED, not optional
 *
 * The suite is full of genuinely destructive tests — `resetLibrary` empties
 * every table, `clearCache` unlinks every thumbnail — and the only thing
 * keeping them off the user's real `~/.autogallery` was a `beforeEach` in each
 * file setting AUTOGALLERY_HOME. That is a convention, and a convention that
 * FAILS SILENTLY: forget it in a new file, call `getDb()` at module scope
 * (which runs before any `beforeEach`), or land in the window after an
 * `afterEach` has deleted the variable, and this function cheerfully returns
 * the real library. The first symptom would be a developer's own index gone.
 *
 * So under vitest (`VITEST` is set by the runner itself) an unset
 * AUTOGALLERY_HOME is a hard error rather than a fallback. The failure mode
 * flips from "silently destroyed the real database" to "one test threw with a
 * message saying exactly what to add", which is the trade every time.
 *
 * @returns {string} Absolute path to the cache root.
 */
export function cacheRoot() {
  const override = process.env.AUTOGALLERY_HOME;
  if (override) return override;
  if (process.env.VITEST) {
    throw new Error(
      "AUTOGALLERY_HOME is not set, and this is a test run — refusing to " +
        "resolve the REAL cache root (~/.autogallery), because tests in this " +
        "suite reset the library and delete the thumbnail cache. Point it at " +
        "a temp dir first:\n" +
        "  beforeEach(async () => {\n" +
        "    cacheDir = await mkdtemp(join(tmpdir(), 'ag-'));\n" +
        "    process.env.AUTOGALLERY_HOME = cacheDir;\n" +
        "    _resetDbForTest();\n" +
        "  });"
    );
  }
  return join(homedir(), ".autogallery");
}

/** @returns {string} Absolute path to the thumbnail cache dir (created if missing). */
export function thumbsDir() {
  const dir = join(cacheRoot(), "cache", "thumbs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Browser-playable proxies for videos whose codec the browser can't decode
 *  (see videoPlayback.js). Same deal as thumbs: a derived, rebuildable cache on
 *  the internal disk — the source video is never touched.
 *  @returns {string} Absolute path to the video-proxy cache dir (created if missing). */
export function videoProxiesDir() {
  const dir = join(cacheRoot(), "cache", "videos");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// `ratingsFile()`, `coverChoicesFile()` and `libraryFile()` were removed with
// the legacy JSON importer (#295). Their only caller was
// `migrateLegacyJsonIfNeeded`; leaving them behind would advertise a store the
// app no longer reads, which is how `perceptual_hash` sat in the schema for two
// releases looking like a feature. The FILES are untouched on disk.

/** @returns {string} Absolute path to the SQLite index database file. */
export function indexDbFile() {
  mkdirSync(cacheRoot(), { recursive: true });
  return join(cacheRoot(), "index.db");
}

/**
 * Every thumbnail size the client ever requests. ui/src/App.svelte snaps the
 * displayed size to one of these five specifically so the disk cache doesn't
 * fragment per pixel.
 */
export const THUMB_BUCKETS = [160, 320, 480, 640, 1024];

/**
 * Pure computation of the thumbnail cache key (bare SHA1 hex, no path or extension).
 *
 * thumbsDir() calls mkdirSync, which is a blocking syscall. Callers that only
 * need to compare keys against directory listings (cacheStats, pruneOrphanedCache)
 * must use this instead of thumbCachePath to avoid a syscall per photo per bucket
 * in loops spanning 100k+ photos. The invariant "thumbCachePath(photo, size)
 * equals join(thumbsDir(), thumbCacheKey(photo, size) + '.jpg')" is tested and
 * must not drift.
 *
 * @param {{path: string, mtime: number, size: number}} photo
 * @param {number} size one of THUMB_BUCKETS
 * @returns {string} bare 40-char SHA1 hex digest
 */
export function thumbCacheKey(photo, size) {
  return createHash("sha1")
    .update(`${photo.path}:${photo.mtime}:${photo.size}:${size}`)
    .digest("hex");
}

/**
 * Face crops for the People view (#223).
 *
 * Deliberately NOT under cache/thumbs/, for the same reason modelsDir isn't:
 * `pruneOrphanedCache` deletes anything in that directory outside its expected
 * key set, and a face crop's key is derived from a FACE id, not a photo+size —
 * so every crop would be swept away on the next prune and silently recomputed.
 * @returns {string} Absolute path to the face-crop cache dir (created if missing).
 */
export function faceCropsDir() {
  const dir = join(cacheRoot(), "cache", "faces");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The face-crop cache key: the PHOTO's identity, the face's BOX, and the size.
 *
 * Those three things are exactly what determines the pixels, which is the
 * whole point — a cache key that is not a function of the content is a wrong
 * answer waiting for a collision.
 *
 * ## It used to key on the face ID, and that collided (#302)
 *
 * The old key was `face:${faceId}:${photo.path}:${photo.mtime}:${photo.size}`,
 * and its comment had already reasoned half way there: it folded in the photo
 * "so an id alone would serve a stale crop from a photo that has since changed
 * on disk". True, and not enough — it left the case where the photo has NOT
 * changed and the id means something different.
 *
 * `photo_faces.id` is `INTEGER PRIMARY KEY`, i.e. a rowid. Delete every row
 * and the counter restarts at 1, so **ids are reused**. John reset his
 * library, re-added the same folder, and recomputed faces: the photo half of
 * the key was identical by design (path + mtime + size is the repo's identity
 * rule and the files had not changed), so a DIFFERENT face at a REUSED id
 * hashed to the SAME path and the People view served last week's crops.
 *
 * Reset is not the only way in. Removing a folder and re-adding it, "forget
 * all face data", or any re-scan that clears the rows reuses ids the same way.
 *
 * The box makes it content-addressed: the same region of the same bytes always
 * hits, a different region always misses, and a re-scan that finds the same
 * face in the same place correctly REUSES the cached crop instead of
 * recomputing it.
 *
 * Fixed precision on the box so a float that round-trips through SQLite as
 * 12.300000000000001 cannot mint a second cache entry for the same crop.
 *
 * @param {{id: number, path: string, mtime: number, size: number}} photo
 * @param {{x: number, y: number, w: number, h: number}} box the face's
 *   bounding box, as stored — NOT the face id, which is not stable
 * @param {number} px
 * @returns {string} bare 40-char SHA1 hex digest
 */
export function faceCropKey(photo, box, px) {
  const n = (v) => Number(v).toFixed(4);
  const region = `${n(box.x)},${n(box.y)},${n(box.w)},${n(box.h)}`;
  return createHash("sha1")
    .update(`face:${region}:${photo.path}:${photo.mtime}:${photo.size}:${px}`)
    .digest("hex");
}

/** Downloaded ML model weights. Deliberately NOT under cache/thumbs/ —
 *  pruneOrphanedCache deletes anything there outside its expected key set,
 *  regardless of extension.
 *  @returns {string} Absolute path to the model cache dir (created if missing). */
export function modelsDir() {
  const dir = join(cacheRoot(), "models");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * THE thumbnail cache path. One definition, because it was two — GET
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
  return join(thumbsDir(), `${thumbCacheKey(photo, size)}.jpg`);
}

/** Monotonic within this process; combined with the pid it makes every
 *  in-flight temp file unique across processes AND within one. */
let tmpSeq = 0;

/**
 * A UNIQUE temp path to write `cachePath` through before renaming it into
 * place. Callers write here, then `rename()` — the rename is atomic, so a
 * reader never sees a half-written JPEG.
 *
 * The uniqueness is the point, and it is newer than the pattern. Keying the
 * temp name on the pid alone was safe while GET /api/thumb/:id was the only
 * writer of a 320px thumb, because two concurrent requests for the same photo
 * are rare and short. #161 added a SECOND writer in the SAME process — the
 * embedding sweep (server/ml/thumbSource.js), which walks the entire library
 * and is not serialized against the endpoint at all. `whenIdle` gates it as a
 * courtesy, not as a lock: a user scrolling onto the photo the sweep is
 * currently embedding gives two concurrent writeFile()s to one temp path,
 * then a rename — a torn JPEG cached under a VALID key and served to the grid
 * forever after, since the key only changes when the file's bytes do.
 *
 * pruneOrphanedCache already deletes any non-`.jpg` file it finds under
 * thumbsDir(), so a temp file orphaned by a crash is swept without needing to
 * be findable by name.
 *
 * @param {string} cachePath the final path this temp file becomes
 * @returns {string}
 */
export function tmpCachePath(cachePath) {
  return `${cachePath}.${process.pid}.${++tmpSeq}.tmp`;
}
