import { createHash } from "node:crypto";
import {
  existsSync,
  statSync,
  createReadStream,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { writeFile, rename, stat } from "node:fs/promises";
import { extname, join, basename, resolve, sep } from "node:path";
import { NodeProcessingService } from "./processing/NodeProcessingService.js";
import { thumbsDir, cacheRoot } from "./lib/cachePaths.js";
import {
  getCacheStats,
  getCacheBreakdown,
  clearCache,
  pruneOrphanedCache,
} from "./lib/cacheStats.js";
import { safeResolve } from "./lib/safeResolve.js";
import { nextAvailablePath } from "./lib/nextAvailablePath.js";
import { listDirsRecursive } from "./lib/walkDirs.js";
import { getDb } from "./db/connection.js";
import {
  volumeRootForPath,
  upsertVolume,
  isVolumeMounted,
} from "./db/volumes.js";
import {
  upsertScan,
  getPhotoById,
  setPhotoRating,
  setPhotoCover,
  deleteFolder,
  resetLibrary,
} from "./db/photos.js";
import { hashPendingPhotos } from "./db/hashing.js";
import {
  getFeedPage,
  findGroupBoundary,
  photoIdsMatchingFilter,
  photoCountMatchingFilter,
  DIMENSIONS,
} from "./db/feed.js";
import { getTreeNode, getFlatTree } from "./db/tree.js";
import { ALLOWED_ORIENTATIONS } from "./db/filters.js";

/**
 * True if `target` is `root` itself or nested anywhere inside it. Same
 * resolve+startsWith(root+sep) primitive as safeResolve.js, but for testing
 * containment of an already-resolved path rather than joining/validating a
 * user-supplied relative segment.
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function isPathContainedIn(root, target) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const rootWithSep = resolvedRoot.endsWith(sep)
    ? resolvedRoot
    : resolvedRoot + sep;
  return (
    resolvedTarget === resolvedRoot || resolvedTarget.startsWith(rootWithSep)
  );
}

const processing = new NodeProcessingService();

const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * Parses + validates the optional `filter` query param into a filter spec.
 * @returns {{spec: object, error?: string}} `error` set ⇒ respond 400.
 */
function parseFilterParam(req) {
  if (!req.query.filter) return { spec: {} };
  let raw;
  try {
    raw = JSON.parse(String(req.query.filter));
  } catch {
    return { spec: {}, error: "filter must be JSON" };
  }
  if (!raw || typeof raw !== "object") return { spec: {} };
  const spec = {};
  if (raw.minRating !== undefined) {
    const r = Number(raw.minRating);
    if (!Number.isInteger(r) || r < 0 || r > 5) {
      return { spec: {}, error: "minRating must be an integer 0-5" };
    }
    spec.minRating = r;
  }
  if (raw.orientations !== undefined) {
    if (
      !Array.isArray(raw.orientations) ||
      !raw.orientations.every((o) => ALLOWED_ORIENTATIONS.includes(o))
    ) {
      return {
        spec: {},
        error:
          "orientations must be a subset of " + ALLOWED_ORIENTATIONS.join("/"),
      };
    }
    spec.orientations = raw.orientations;
  }
  return { spec };
}

/**
 * Register the API routes on an Express app.
 * @param {import("express").Express} app
 */
export function registerApi(app) {
  // --- Scan ---------------------------------------------------------------
  app.post("/api/scan", async (req, res) => {
    const dir = req.body?.dir;
    // Recursive ("soup folder") scan: point at a parent, pull in every
    // subfolder. Each directory with media becomes its own folders row, so the
    // on-disk structure is preserved as browsable sections.
    const recursive = req.body?.recursive === true;
    if (typeof dir !== "string" || dir.length === 0) {
      return res.status(400).json({ error: "dir is required" });
    }
    let st;
    try {
      st = statSync(dir);
    } catch {
      return res.status(404).json({ error: `not found: ${dir}` });
    }
    if (!st.isDirectory()) {
      return res.status(400).json({ error: `not a directory: ${dir}` });
    }

    const db = getDb();
    // Every subfolder is under `dir`, hence on the same physical volume — one
    // volume lookup covers the whole tree.
    const volumeId = upsertVolume(db, volumeRootForPath(dir));

    const t0 = performance.now();

    if (recursive) {
      const dirs = await listDirsRecursive(dir);
      let count = 0;
      let folders = 0;
      for (const subdir of dirs) {
        const files = await processing.scan(subdir);
        if (!files.length) continue; // don't create empty folders rows
        upsertScan(db, subdir, volumeId, files);
        count += files.length;
        folders += 1;
      }
      const elapsedMs = Math.round(performance.now() - t0);
      hashPendingPhotos(db).catch(() => {});
      // items intentionally omitted for a tree scan (could be tens of
      // thousands); the client reloads the feed after any scan.
      return res.json({ root: dir, count, folders, elapsedMs, items: [] });
    }

    const files = await processing.scan(dir);
    const rows = upsertScan(db, dir, volumeId, files);
    const elapsedMs = Math.round(performance.now() - t0);

    // Never blocks the response — see server/db/hashing.js.
    hashPendingPhotos(db).catch(() => {});

    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      size: r.size,
      mtimeMs: r.mtimeMs,
      rating: r.rating,
      preferredCover: r.preferredCover === 1,
    }));
    res.json({ root: dir, count: items.length, folders: 1, elapsedMs, items });
  });

  // --- Lazy metadata enrichment --------------------------------------------
  // GET /api/meta?ids=1,2,3 -> [{ id, takenAt, width, height }].
  // width is used as the "already attempted extraction" marker, but sharp
  // can't read most RAW headers, so a genuinely-attempted RAW photo has no
  // dimensions to report. Storing that outcome as NULL would be
  // indistinguishable from "never tried" and re-trigger extraction forever,
  // so a completed-but-dimensionless attempt is stored as 0 (falsy, but
  // distinct from NULL) — only NULL means "never tried".
  app.get("/api/meta", async (req, res) => {
    const db = getDb();
    const idsParam = String(req.query.ids ?? "");
    const ids = idsParam
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n));

    const photosById = new Map();
    const need = [];
    for (const id of ids) {
      const photo = getPhotoById(db, id);
      if (!photo) continue;
      photosById.set(id, photo);
      if (photo.width === null || photo.camera === null) need.push(photo);
    }

    if (need.length) {
      const metas = await processing.metadata(need.map((p) => p.path));
      const update = db.prepare(
        `UPDATE photos SET taken_at = ?, width = ?, height = ?, camera = ? WHERE id = ?`
      );
      metas.forEach((m, i) => {
        const photo = need[i];
        const takenAtMs = m.createDate
          ? new Date(m.createDate).getTime()
          : null;
        update.run(
          takenAtMs,
          m.width ?? 0,
          m.height ?? 0,
          m.camera ?? "",
          photo.id
        );
        photosById.set(photo.id, {
          ...photo,
          taken_at: takenAtMs,
          width: m.width ?? 0,
          height: m.height ?? 0,
          camera: m.camera ?? "",
        });
      });
    }

    const out = ids
      .map((id) => photosById.get(id))
      .filter(Boolean)
      .map((p) => ({
        id: p.id,
        takenAt: p.taken_at ? new Date(p.taken_at).toISOString() : null,
        width: p.width ?? null,
        height: p.height ?? null,
      }));
    res.json(out);
  });

  // --- Thumbnail ----------------------------------------------------------
  app.get("/api/thumb/:id", async (req, res) => {
    const db = getDb();
    const it = getPhotoById(db, Number(req.params.id));
    if (!it) return res.status(404).end();
    const size = Math.min(1024, Math.max(64, Number(req.query.size) || 320));

    const key = createHash("sha1")
      .update(`${it.path}:${it.mtime}:${it.size}:${size}`)
      .digest("hex");
    const cachePath = join(thumbsDir(), `${key}.jpg`);

    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.type("image/jpeg");

    if (existsSync(cachePath)) {
      res.set("X-Cache", "hit");
      return createReadStream(cachePath).pipe(res);
    }

    try {
      const { data } = await processing.thumbnail(it.path, size);
      const tmp = `${cachePath}.${process.pid}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, cachePath);
      res.set("X-Cache", "miss");
      res.send(data);
    } catch (err) {
      res.status(500).json({ error: `thumbnail failed: ${err.message}` });
    }
  });

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

  // --- Full image (loupe) -------------------------------------------------
  app.get("/api/image/:id", async (req, res) => {
    const db = getDb();
    const it = getPhotoById(db, Number(req.params.id));
    if (!it) return res.status(404).end();
    let st;
    try {
      st = await stat(it.path);
    } catch {
      return res.status(404).end();
    }
    res.set("Cache-Control", "public, max-age=3600");
    res.type(
      MIME_BY_EXT[extname(it.path).toLowerCase()] || "application/octet-stream"
    );
    res.set("Content-Length", String(st.size));
    createReadStream(it.path).pipe(res);
  });

  // --- Ratings / cover choices ----------------------------------------------
  app.post("/api/rating", (req, res) => {
    const { id, rating } = req.body ?? {};
    const db = getDb();
    const it = getPhotoById(db, Number(id));
    if (!it) return res.status(404).json({ error: "unknown id" });
    if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
      return res.status(400).json({ error: "rating must be an integer 0-5" });
    }
    setPhotoRating(db, it.id, rating);
    res.json({ id: it.id, rating });
  });

  app.post("/api/cover", (req, res) => {
    const { id, isCover } = req.body ?? {};
    const db = getDb();
    const it = getPhotoById(db, Number(id));
    if (!it) return res.status(404).json({ error: "unknown id" });
    if (typeof isCover !== "boolean") {
      return res.status(400).json({ error: "isCover must be a boolean" });
    }
    setPhotoCover(db, it.id, isCover);
    res.json({ id: it.id, preferredCover: isCover });
  });

  // --- Library (previously-scanned folders) --------------------------------
  app.get("/api/library", (_req, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT folders.id AS id, folders.abs_path AS path, folders.last_scanned_at AS lastScannedAt,
                volumes.uuid AS volumeUuid, volumes.last_mount_path AS volumeMountPath
         FROM folders LEFT JOIN volumes ON volumes.id = folders.volume_id
         ORDER BY folders.last_scanned_at DESC`
      )
      .all();
    // isVolumeMounted shells out to `diskutil info` synchronously; memoize per
    // volume so N folders on the same volume cost one subprocess, not N.
    const mountedByVolumeKey = new Map();
    const entries = rows.map((r) => {
      const volumeKey = r.volumeUuid ?? r.volumeMountPath ?? null;
      let volumeMounted = true;
      if (volumeKey !== null) {
        if (!mountedByVolumeKey.has(volumeKey)) {
          mountedByVolumeKey.set(
            volumeKey,
            isVolumeMounted({
              uuid: r.volumeUuid,
              last_mount_path: r.volumeMountPath,
            })
          );
        }
        volumeMounted = mountedByVolumeKey.get(volumeKey);
      }
      return {
        id: r.id,
        path: r.path,
        name: basename(r.path),
        lastScannedAt: r.lastScannedAt,
        mounted: volumeMounted && existsSync(r.path),
      };
    });
    res.json(entries);
  });

  app.delete("/api/folders/:id", (req, res) => {
    const db = getDb();
    const removed = deleteFolder(db, Number(req.params.id));
    if (!removed) return res.status(404).end();
    res.json({ removed: true });
  });

  app.get("/api/cache/stats", (_req, res) => {
    res.json(getCacheStats());
  });

  app.get("/api/cache/breakdown", (_req, res) => {
    res.json(getCacheBreakdown(getDb()));
  });

  app.post("/api/cache/clear", (_req, res) => {
    res.json(clearCache());
  });

  app.post("/api/cache/prune", (_req, res) => {
    res.json(pruneOrphanedCache(getDb()));
  });

  // --- Grouped endless feed --------------------------------------------------
  app.get("/api/feed", (req, res) => {
    const groupBy = String(req.query.groupBy ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!groupBy.length) {
      return res.status(400).json({ error: "groupBy is required" });
    }
    if (groupBy.some((d) => !DIMENSIONS[d])) {
      return res.status(400).json({
        error: `unknown dimension in groupBy: ${groupBy.join(",")}`,
      });
    }
    const { spec: filter, error: filterError } = parseFilterParam(req);
    if (filterError) return res.status(400).json({ error: filterError });

    let collapsed = [];
    if (req.query.collapsed) {
      try {
        collapsed = JSON.parse(String(req.query.collapsed));
      } catch {
        return res.status(400).json({ error: "collapsed must be JSON" });
      }
    }

    const focusIdParam = req.query.focusId;
    const focusId =
      focusIdParam !== undefined && focusIdParam !== ""
        ? Number(focusIdParam)
        : null;
    let startPath = null;
    if (req.query.startPath) {
      try {
        startPath = JSON.parse(String(req.query.startPath));
      } catch {
        return res.status(400).json({ error: "startPath must be JSON" });
      }
    }
    // `|| 0`/`|| 50` as a fallback for a MISSING param would also silently
    // override an explicitly-passed `0` (falsy in JS) — a real, shipped bug:
    // jumpGroupBoundary's "before" fetch passes `after=0` deliberately (it
    // wants only before-items), but that got coerced back up to the default
    // 50, injecting 50 unrelated "after" items into what should have been a
    // pure before-page and corrupting the client's assembled feed order
    // (duplicate/out-of-order section headers after a group-jump). Only
    // fall back to the default when the param is genuinely absent.
    const before =
      req.query.before !== undefined
        ? Math.max(0, Number(req.query.before) || 0)
        : 0;
    const after =
      req.query.after !== undefined
        ? Math.max(0, Number(req.query.after) || 0)
        : 50;

    const db = getDb();
    try {
      const { items, focusItem } = getFeedPage(db, {
        groupBy,
        collapsed,
        focusId,
        startPath,
        before,
        after,
        filter,
      });
      res.json({ items, focusItem });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/feed/boundary", (req, res) => {
    const groupBy = String(req.query.groupBy ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!groupBy.length) {
      return res.status(400).json({ error: "groupBy is required" });
    }
    if (groupBy.some((d) => !DIMENSIONS[d])) {
      return res.status(400).json({
        error: `unknown dimension in groupBy: ${groupBy.join(",")}`,
      });
    }
    const { spec: filter, error: filterError } = parseFilterParam(req);
    if (filterError) return res.status(400).json({ error: filterError });

    const direction = String(req.query.direction ?? "");
    if (direction !== "next" && direction !== "prev") {
      return res
        .status(400)
        .json({ error: `direction must be "next" or "prev"` });
    }

    let collapsed = [];
    if (req.query.collapsed) {
      try {
        collapsed = JSON.parse(String(req.query.collapsed));
      } catch {
        return res.status(400).json({ error: "collapsed must be JSON" });
      }
    }

    const focusId = Number(req.query.focusId);
    if (!Number.isInteger(focusId)) {
      return res.status(400).json({ error: "focusId is required" });
    }

    try {
      const db = getDb();
      const result = findGroupBoundary(db, {
        groupBy,
        collapsed,
        focusId,
        direction,
        filter,
      });
      res.json(result ?? { id: null });
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  // --- Hierarchy tree (lazy, per-level) --------------------------------------
  app.get("/api/tree", (req, res) => {
    const groupBy = String(req.query.groupBy ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!groupBy.length) {
      return res.status(400).json({ error: "groupBy is required" });
    }
    if (groupBy.some((d) => !DIMENSIONS[d])) {
      return res.status(400).json({
        error: `unknown dimension in groupBy: ${groupBy.join(",")}`,
      });
    }
    const { spec: filter, error: filterError } = parseFilterParam(req);
    if (filterError) return res.status(400).json({ error: filterError });

    let path = [];
    if (req.query.path) {
      try {
        path = JSON.parse(String(req.query.path));
      } catch {
        return res.status(400).json({ error: "path must be JSON" });
      }
    }

    const db = getDb();
    try {
      const { total, nodes } = getTreeNode(db, { groupBy, path, filter });
      res.json({ total, nodes });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/tree/flat", (req, res) => {
    const groupBy = String(req.query.groupBy ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!groupBy.length) {
      return res.status(400).json({ error: "groupBy is required" });
    }
    if (groupBy.some((d) => !DIMENSIONS[d])) {
      return res.status(400).json({
        error: `unknown dimension in groupBy: ${groupBy.join(",")}`,
      });
    }
    const { spec: filter, error: filterError } = parseFilterParam(req);
    if (filterError) return res.status(400).json({ error: filterError });

    const db = getDb();
    try {
      const { total, leaves } = getFlatTree(db, { groupBy, filter });
      res.json({ total, leaves });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- Selection ids (respects the same filter as /api/feed) ----------------
  app.get("/api/photos/ids", (req, res) => {
    const { spec: filter, error: filterError } = parseFilterParam(req);
    if (filterError) return res.status(400).json({ error: filterError });
    const db = getDb();
    res.json({ ids: photoIdsMatchingFilter(db, filter) });
  });

  // --- Photo count (library total when unfiltered; "showing" with a filter) -
  app.get("/api/photos/count", (req, res) => {
    const { spec: filter, error: filterError } = parseFilterParam(req);
    if (filterError) return res.status(400).json({ error: filterError });
    const db = getDb();
    res.json({ count: photoCountMatchingFilter(db, filter) });
  });

  // --- Library reset (danger zone: wipes the index, not the photos) --------
  app.post("/api/library/reset", (req, res) => {
    if (req.body?.confirm !== "DELETE") {
      return res.status(400).json({ error: "confirmation required" });
    }
    const db = getDb();
    const cleared = resetLibrary(db);
    const cacheResult = clearCache();
    res.json({
      ...cleared,
      cacheFreedFiles: cacheResult.freedFiles,
      cacheFreedBytes: cacheResult.freedBytes,
    });
  });

  // --- Export selected photos into a new folder -----------------------------
  app.post("/api/export", (req, res) => {
    const { photoIds, destParent, folderName } = req.body ?? {};
    if (!Array.isArray(photoIds) || photoIds.length === 0) {
      return res
        .status(400)
        .json({ error: "photoIds must be a non-empty array" });
    }
    if (typeof destParent !== "string" || destParent.length === 0) {
      return res.status(400).json({ error: "destParent is required" });
    }
    if (typeof folderName !== "string" || folderName.length === 0) {
      return res.status(400).json({ error: "folderName is required" });
    }

    let destSt;
    try {
      destSt = statSync(destParent);
    } catch {
      return res.status(400).json({ error: "destination not found" });
    }
    if (!destSt.isDirectory()) {
      return res.status(400).json({ error: "destination is not a directory" });
    }

    let target;
    try {
      target = safeResolve(destParent, folderName);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    if (isPathContainedIn(cacheRoot(), target)) {
      return res.status(400).json({
        error: "export destination cannot be inside the AutoGallery cache",
      });
    }

    const db = getDb();
    const sourceFolders = db.prepare(`SELECT abs_path FROM folders`).all();
    const insideSource = sourceFolders.some((f) =>
      isPathContainedIn(f.abs_path, target)
    );
    if (insideSource) {
      return res.status(400).json({
        error: "export destination cannot be inside a scanned source folder",
      });
    }

    mkdirSync(target, { recursive: true });

    let copied = 0;
    let skipped = 0;
    for (const id of photoIds) {
      const photo = getPhotoById(db, Number(id));
      if (!photo || !existsSync(photo.path)) {
        skipped++;
        continue;
      }
      const destPath = nextAvailablePath(target, basename(photo.path));
      copyFileSync(photo.path, destPath);
      copied++;
    }

    res.json({ target, copied, skipped });
  });
}
