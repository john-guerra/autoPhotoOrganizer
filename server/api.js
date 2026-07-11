import { createHash } from "node:crypto";
import {
  existsSync,
  statSync,
  createReadStream,
  mkdirSync,
  copyFileSync,
  renameSync,
  fsyncSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { writeFile, rename, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { extname, join, basename, dirname, resolve, sep } from "node:path";
import { revealCommand } from "./lib/revealCommand.js";
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
  repointPhoto,
  renameFolderPath,
} from "./db/photos.js";
import { hashPendingPhotos } from "./db/hashing.js";
import {
  getFeedPage,
  findGroupBoundary,
  photoIdsMatchingFilter,
  photoCountMatchingFilter,
  workingSetTimeline,
  workingSetTimes,
  countGroupPath,
  fetchGroupRowsAtOffsets,
  DIMENSIONS,
} from "./db/feed.js";
import { getTreeNode, getFlatTree } from "./db/tree.js";
import { ALLOWED_ORIENTATIONS } from "./db/filters.js";
import { parseSort, DATE_SORTS } from "./db/sort.js";
import { sampleOffsets } from "./db/sampleGroup.js";
import { setKeepScope } from "./db/keepScope.js";
import { createManualStack, dissolveStack } from "./db/manualStacks.js";
import { registry } from "./jobs/registry.js";

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

/**
 * Validate + resolve an export destination folder, shared by /api/export and
 * /api/albums/materialize. Guards traversal (safeResolve) and refuses to write
 * inside the app cache. It also refuses to write inside any scanned source
 * folder (the read-only invariant) UNLESS `allowInsideSource` is set — which
 * materialize passes so it can organize a folder *in place* (move rated photos
 * into dated subfolders of the folder they already live in). Copies into a new
 * subfolder never modify existing source files, and the user explicitly asked
 * for it; the cache and traversal guards always apply.
 * @param {import("better-sqlite3").Database} db
 * @param {string} destParent
 * @param {string} folderName
 * @param {{allowInsideSource?: boolean}} [opts]
 * @returns {{target:string}|{error:string}}
 */
function resolveExportTarget(
  db,
  destParent,
  folderName,
  { allowInsideSource = false } = {}
) {
  let destSt;
  try {
    destSt = statSync(destParent);
  } catch {
    return { error: "destination not found" };
  }
  if (!destSt.isDirectory()) return { error: "destination is not a directory" };
  let target;
  try {
    target = safeResolve(destParent, folderName);
  } catch (err) {
    return { error: err.message };
  }
  if (isPathContainedIn(cacheRoot(), target)) {
    return {
      error: "export destination cannot be inside the AutoGallery cache",
    };
  }
  if (!allowInsideSource) {
    const sourceFolders = db.prepare(`SELECT abs_path FROM folders`).all();
    if (sourceFolders.some((f) => isPathContainedIn(f.abs_path, target))) {
      return {
        error: "export destination cannot be inside a scanned source folder",
      };
    }
  }
  return { target };
}

/**
 * Move `src` to `dst`. Tries a same-volume `renameSync` first (atomic); on
 * `EXDEV` (cross-volume — e.g. SD card -> internal disk) falls back to
 * copy -> fsync -> verify size -> unlink. The source is removed ONLY after
 * the destination is confirmed written, so a crash between copy and unlink
 * leaves a harmless duplicate, never a lost file. This is the only code path
 * allowed to remove a source file.
 * @param {string} src
 * @param {string} dst
 */
function moveFile(src, dst) {
  try {
    renameSync(src, dst);
    return;
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
  }
  copyFileSync(src, dst); // cross-volume
  const fd = openSync(dst, "r");
  fsyncSync(fd);
  closeSync(fd);
  if (statSync(dst).size !== statSync(src).size) {
    throw new Error(`move verify failed: ${src}`);
  }
  unlinkSync(src); // remove source only after the copy is verified
}

/**
 * Copy (or move) the given photo ids into `targetDir` (created if needed).
 * Never overwrites — collisions get a " (2)" suffix; missing/unmounted
 * sources are counted as skipped. Shared by export and materialize.
 *
 * `signal?.aborted` is checked at the top of every iteration; on abort, an
 * `AbortError` is thrown (files already processed stay — a canceled run
 * leaves a partial, consistent result). The partial manifest is attached to
 * the thrown error as `.manifest` so a caller (e.g. a canceled background
 * job) can still see exactly what was processed for undo purposes.
 *
 * In move mode, each successfully moved file's index row is repointed
 * (`repointPhoto`) so it isn't reported "missing" at its new location.
 * @param {import("better-sqlite3").Database} db
 * @param {string} targetDir
 * @param {Array<number|string>} ids
 * @param {{signal?: AbortSignal, onProgress?: (done:number, total:number, phase:string) => void, move?: boolean}} [opts]
 * @returns {{copied:number, moved:number, skipped:number, manifest:Array<{id:number, from:string, to:string}>}}
 */
export function copyIdsIntoFolder(
  db,
  targetDir,
  ids,
  { signal, onProgress, move = false } = {}
) {
  mkdirSync(targetDir, { recursive: true });
  let copied = 0;
  let moved = 0;
  let skipped = 0;
  const manifest = [];
  const total = ids.length;

  ids.forEach((id, i) => {
    if (signal?.aborted) {
      const e = new Error("canceled");
      e.name = "AbortError";
      e.manifest = manifest;
      throw e;
    }
    const photo = getPhotoById(db, Number(id));
    if (!photo || !existsSync(photo.path)) {
      skipped++;
    } else {
      const dst = nextAvailablePath(targetDir, basename(photo.path));
      if (move) {
        moveFile(photo.path, dst);
        repointPhoto(db, Number(id), dst);
        moved++;
      } else {
        copyFileSync(photo.path, dst);
        copied++;
      }
      manifest.push({ id: Number(id), from: photo.path, to: dst });
    }
    if (i % 50 === 0 || i === total - 1) {
      onProgress?.(i + 1, total, move ? "moving" : "copying");
    }
  });

  return { copied, moved, skipped, manifest };
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
  if (raw.scopeIds !== undefined) {
    if (
      !Array.isArray(raw.scopeIds) ||
      !raw.scopeIds.every((n) => Number.isInteger(n))
    ) {
      return { spec: {}, error: "scopeIds must be an array of integers" };
    }
    // Guard the URL/SQL-parameter length ("keep only" a huge group). Callers
    // should narrow before focusing on more than this.
    if (raw.scopeIds.length > 5000) {
      return { spec: {}, error: "scopeIds too large (max 5000)" };
    }
    spec.scopeIds = raw.scopeIds;
  }
  // "Keep only" working set, referenced by flag; the ids live in the keep_scope
  // table (set via POST /api/scope), so there is no size cap here.
  if (raw.keepScope) spec.keepScope = true;
  // Folder-focus scope ("open a folder"): the abs_path of the focused subtree
  // root. Only ever compared against the indexed folders.abs_path column (never
  // resolved to a file), so no safeResolve is needed here.
  if (raw.folderPath !== undefined && raw.folderPath !== null) {
    if (typeof raw.folderPath !== "string" || !raw.folderPath.length) {
      return { spec: {}, error: "folderPath must be a non-empty string" };
    }
    spec.folderPath = raw.folderPath;
  }
  // Timeline filter time-range (epoch ms). Each bound is optional; a finite
  // number constrains, anything else is rejected so a garbled range can't
  // silently widen the query.
  for (const key of ["dateFrom", "dateTo"]) {
    if (raw[key] !== undefined && raw[key] !== null) {
      const v = Number(raw[key]);
      if (!Number.isFinite(v)) {
        return { spec: {}, error: `${key} must be a finite epoch-ms number` };
      }
      spec[key] = v;
    }
  }
  // Which date attribute the timeline (and thus the dateFrom/dateTo bounds)
  // reflects — follows the feed's sort date on the client. Must be a known
  // date-type sort; anything else is rejected rather than silently ignored.
  if (raw.dateAttr !== undefined && raw.dateAttr !== null) {
    if (!DATE_SORTS.includes(raw.dateAttr)) {
      return {
        spec: {},
        error: `dateAttr must be one of ${DATE_SORTS.join("/")}`,
      };
    }
    spec.dateAttr = raw.dateAttr;
  }
  return { spec };
}

/**
 * Register the API routes on an Express app.
 * @param {import("express").Express} app
 */
export function registerApi(app) {
  // --- Jobs -----------------------------------------------------------------
  app.get("/api/jobs", (_req, res) => res.json({ jobs: registry.list() }));

  app.get("/api/jobs/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (jobs) => res.write(`data: ${JSON.stringify(jobs)}\n\n`);
    send(registry.list());
    const onChange = (jobs) => send(jobs);
    registry.on("change", onChange);
    req.on("close", () => registry.off("change", onChange));
  });

  app.post("/api/jobs/:id/cancel", (req, res) => {
    const j = registry.get(req.params.id);
    if (!j) return res.status(404).json({ error: "no such job" });
    if (j.status !== "running")
      return res.status(409).json({ error: "not running" });
    registry.cancel(req.params.id);
    res.json({ ok: true });
  });

  app.post("/api/jobs/:id/dismiss", (req, res) => {
    const j = registry.get(req.params.id);
    if (!j) return res.status(404).json({ error: "no such job" });
    if (j.status === "running")
      return res.status(409).json({ error: "still running" });
    registry.dismiss(req.params.id);
    res.json({ ok: true });
  });

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
      const job = registry.create("scan", {
        label: `Scan ${basename(dir)}`,
        total: dirs.length,
      });
      res.status(202).json({ jobId: job.id });

      (async () => {
        try {
          let count = 0;
          let folders = 0;
          for (let i = 0; i < dirs.length; i++) {
            if (job.controller.signal.aborted) {
              const e = new Error("canceled");
              e.name = "AbortError";
              throw e;
            }
            const subdir = dirs[i];
            const files = await processing.scan(subdir);
            if (files.length) {
              // don't create empty folders rows
              upsertScan(db, subdir, volumeId, files);
              count += files.length;
              folders += 1;
            }
            registry.update(job.id, {
              done: i + 1,
              phase: `scanning ${basename(subdir)}`,
            });
          }
          const elapsedMs = Math.round(performance.now() - t0);
          hashPendingPhotos(db).catch(() => {});
          registry.finish(job.id, { root: dir, count, folders, elapsedMs });
        } catch (e) {
          registry.fail(job.id, e);
        }
      })();
      return;
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
      manualStackId: r.manualStackId ?? null,
      keepSeparate: r.keepSeparate === 1,
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

  // Reveal a photo's real location in the OS file browser (Finder/Explorer/
  // file manager) — a read-only escape hatch to the file on disk (issue #18).
  // No file operations: it only asks the OS to show where the file already
  // lives. Runs server-side so it works identically in the browser dev server
  // and the packaged Electron app (both host this Express server locally).
  app.post("/api/reveal/:id", async (req, res) => {
    const db = getDb();
    const it = getPhotoById(db, Number(req.params.id));
    if (!it) return res.status(404).json({ ok: false, error: "unknown id" });
    try {
      await stat(it.path);
    } catch {
      // File gone (offline drive, or moved in Finder since the last scan).
      return res.status(404).json({ ok: false, error: "file not found" });
    }
    const command = revealCommand(process.platform, it.path);
    if (!command) {
      return res.status(501).json({
        ok: false,
        error: `unsupported platform: ${process.platform}`,
      });
    }
    try {
      await new Promise((resolveSpawn, reject) => {
        // execFile with an args array (never a shell string) — the path is
        // trusted-from-index, but this keeps the launch injection-proof anyway.
        execFile(command.cmd, command.args, (err) => {
          // Windows Explorer routinely exits non-zero even on a successful
          // reveal, so a non-zero exit there is not a failure.
          if (err && process.platform !== "win32") reject(err);
          else resolveSpawn();
        });
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message ?? err) });
    }
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

  // Remove a folder from the index by its on-disk path (how the feed knows a
  // group). Index-only: real files on disk are never touched (see
  // deleteFolder). Ratings for those photos live in SQLite, so they DO go with
  // the rows — the client confirms before calling this.
  app.post("/api/folders/remove", (req, res) => {
    const path = req.body?.path;
    if (typeof path !== "string" || !path.length) {
      return res.status(400).json({ error: "path is required" });
    }
    const db = getDb();
    const row = db
      .prepare(`SELECT id FROM folders WHERE abs_path = ?`)
      .get(path);
    if (!row) return res.status(404).json({ error: `not indexed: ${path}` });
    deleteFolder(db, row.id);
    res.json({ removed: true, id: row.id });
  });

  // Rename a scanned folder on disk and update the index (issue #68 Slice B).
  // Folders on disk are the source of truth, so this renames the real directory
  // (renameSync) and repoints the folder rows — the user explicitly asked to
  // rename it. Photo rows are untouched (paths derive from folder_id).
  app.post("/api/folders/rename", (req, res) => {
    const { path, newName } = req.body ?? {};
    if (typeof path !== "string" || !path.length) {
      return res.status(400).json({ error: "path is required" });
    }
    if (typeof newName !== "string" || !newName.trim()) {
      return res.status(400).json({ error: "newName is required" });
    }
    const name = newName.trim();
    // A bare folder name only — no separators, no traversal.
    if (
      name.includes("/") ||
      name.includes(sep) ||
      name === "." ||
      name === ".."
    ) {
      return res.status(400).json({ error: "invalid folder name" });
    }
    const db = getDb();
    const row = db
      .prepare(`SELECT id FROM folders WHERE abs_path = ?`)
      .get(path);
    if (!row) return res.status(404).json({ error: `not indexed: ${path}` });
    if (!existsSync(path)) {
      return res
        .status(409)
        .json({ error: "folder is not on disk (offline?)" });
    }
    const newAbsPath = join(dirname(path), name);
    if (newAbsPath === path) {
      return res.json({ ok: true, oldPath: path, newPath: newAbsPath }); // no-op
    }
    if (
      existsSync(newAbsPath) ||
      db.prepare(`SELECT id FROM folders WHERE abs_path = ?`).get(newAbsPath)
    ) {
      return res
        .status(409)
        .json({ error: "a folder with that name already exists" });
    }
    try {
      renameSync(path, newAbsPath);
    } catch (err) {
      return res.status(500).json({ error: `rename failed: ${err.message}` });
    }
    renameFolderPath(db, path, newAbsPath);
    res.json({ ok: true, oldPath: path, newPath: newAbsPath });
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
    // Empty groupBy is valid: a flat feed of every photo (getFeedPage builds no
    // dim columns). Only reject unknown dimension names.
    if (groupBy.some((d) => !DIMENSIONS[d])) {
      return res.status(400).json({
        error: `unknown dimension in groupBy: ${groupBy.join(",")}`,
      });
    }
    const { spec: filter, error: filterError } = parseFilterParam(req);
    if (filterError) return res.status(400).json({ error: filterError });
    const sort = parseSort(req.query.sort ? String(req.query.sort) : undefined);

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
        sort,
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
    const sort = parseSort(req.query.sort ? String(req.query.sort) : undefined);

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
        sort,
      });
      res.json(result ?? { id: null });
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  // --- Fisheye snapshot: first/middle/last of a group, without paging
  // through the whole thing --------------------------------------------------
  app.get("/api/group/sample", (req, res) => {
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
    const sort = parseSort(req.query.sort ? String(req.query.sort) : undefined);

    let path;
    try {
      path = req.query.path ? JSON.parse(String(req.query.path)) : null;
    } catch {
      return res.status(400).json({ error: "path must be JSON" });
    }
    if (!Array.isArray(path) || !path.length) {
      return res.status(400).json({ error: "path is required" });
    }

    const slots = Math.min(64, Math.max(1, Number(req.query.slots) || 12));

    const db = getDb();
    try {
      const count = countGroupPath(db, { path, groupBy, filter, sort });
      const { offsets, gaps } = sampleOffsets(count, slots);
      const rows = fetchGroupRowsAtOffsets(db, {
        path,
        groupBy,
        offsets,
        filter,
        sort,
      });
      const samples = rows.map((row, i) => ({
        ...row,
        offset: offsets[i],
        gapAfter: gaps.includes(i),
      }));
      res.json({ count, samples });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- Hierarchy tree (lazy, per-level) --------------------------------------
  app.get("/api/tree", (req, res) => {
    const groupBy = String(req.query.groupBy ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (groupBy.length && groupBy.some((d) => !DIMENSIONS[d])) {
      return res.status(400).json({
        error: `unknown dimension in groupBy: ${groupBy.join(",")}`,
      });
    }
    const { spec: filter, error: filterError } = parseFilterParam(req);
    if (filterError) return res.status(400).json({ error: filterError });
    const sort = parseSort(req.query.sort ? String(req.query.sort) : undefined);

    // Flat feed (no grouping) has no hierarchy — an empty tree, not an error —
    // but still report the real matching total so the sidebar header is right.
    if (!groupBy.length) {
      return res.json({
        total: photoCountMatchingFilter(getDb(), filter),
        nodes: [],
      });
    }

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
      const { total, nodes } = getTreeNode(db, {
        groupBy,
        path,
        filter,
        sort,
      });
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
    if (groupBy.length && groupBy.some((d) => !DIMENSIONS[d])) {
      return res.status(400).json({
        error: `unknown dimension in groupBy: ${groupBy.join(",")}`,
      });
    }
    const { spec: filter, error: filterError } = parseFilterParam(req);
    if (filterError) return res.status(400).json({ error: filterError });
    const sort = parseSort(req.query.sort ? String(req.query.sort) : undefined);

    // Flat feed (no grouping) has no leaves — empty, not an error — but still
    // report the real matching total for the sidebar header.
    if (!groupBy.length) {
      return res.json({
        total: photoCountMatchingFilter(getDb(), filter),
        leaves: [],
      });
    }

    const db = getDb();
    try {
      const { total, leaves } = getFlatTree(db, { groupBy, filter, sort });
      res.json({ total, leaves });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- Selection ids (respects the same filter as /api/feed) ----------------
  // Optional `path` (JSON [{dimension,value}]) scopes to one group — the
  // "select all in this section" case.
  app.get("/api/photos/ids", (req, res) => {
    const { spec: filter, error: filterError } = parseFilterParam(req);
    if (filterError) return res.status(400).json({ error: filterError });
    let path = null;
    if (req.query.path) {
      try {
        path = JSON.parse(String(req.query.path));
      } catch {
        return res.status(400).json({ error: "path must be JSON" });
      }
    }
    // The feed's sort drives date-dimension grouping, so the group scope must
    // see it too (else keep-only/select disagree with the section — issue #71).
    const sort = parseSort(req.query.sort ? String(req.query.sort) : undefined);
    const db = getDb();
    try {
      res.json({ ids: photoIdsMatchingFilter(db, filter, path, sort) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- Photo count (library total when unfiltered; "showing" with a filter) -
  app.get("/api/photos/count", (req, res) => {
    const { spec: filter, error: filterError } = parseFilterParam(req);
    if (filterError) return res.status(400).json({ error: filterError });
    const db = getDb();
    res.json({ count: photoCountMatchingFilter(db, filter) });
  });

  // --- "Keep only" working set: store the id list server-side so the filter
  // only carries a boolean (keepScope), lifting the URL-length cap on its size.
  app.post("/api/scope", (req, res) => {
    const ids = req.body?.ids;
    if (ids !== undefined && !Array.isArray(ids)) {
      return res.status(400).json({ error: "ids must be an array" });
    }
    const db = getDb();
    const count = setKeepScope(db, ids ?? []);
    res.json({ count });
  });

  // --- Manual burst stacks (issue #24) -------------------------------------
  // Force a selection into one stack, or dissolve a mis-detected stack so its
  // photos stay separate. Both key on photo id and persist across rescans.
  app.post("/api/stacks", (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids)) {
      return res.status(400).json({ error: "ids must be an array" });
    }
    if (ids.filter((n) => Number.isInteger(n)).length < 2) {
      return res
        .status(400)
        .json({ error: "a manual stack needs at least 2 photos" });
    }
    const db = getDb();
    const { groupId, count } = createManualStack(db, ids);
    res.json({ groupId, count });
  });

  app.post("/api/stacks/dissolve", (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: "ids must be a non-empty array" });
    }
    const db = getDb();
    const { count } = dissolveStack(db, ids);
    res.json({ count });
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

    const db = getDb();
    const resolved = resolveExportTarget(db, destParent, folderName);
    if (resolved.error) return res.status(400).json({ error: resolved.error });

    const job = registry.create("export", {
      label: `Export ${photoIds.length} photos`,
      total: photoIds.length,
    });
    res.status(202).json({ jobId: job.id });

    (async () => {
      try {
        const { copied, skipped, moved } = copyIdsIntoFolder(
          db,
          resolved.target,
          photoIds,
          {
            signal: job.controller.signal,
            onProgress: (done, total, phase) =>
              registry.update(job.id, { done, total, phase }),
          }
        );
        registry.finish(job.id, {
          target: resolved.target,
          copied: copied + moved,
          skipped,
        });
      } catch (e) {
        registry.fail(job.id, e);
      }
    })();
  });

  // --- Album timeline (working set, time-ordered, for gap clustering) --------
  app.get("/api/albums/timeline", (req, res) => {
    const { spec: filter, error: filterError } = parseFilterParam(req);
    if (filterError) return res.status(400).json({ error: filterError });
    // Client-tunable working-set cap. AlbumsView renders each album as a
    // fisheye SnapshotStrip (first/middle/last), not every thumbnail, so this
    // is now a DB-time safety cap rather than a DOM-size one. Echoed back so
    // the UI can show the clamped value.
    const ALBUM_TIMELINE_MAX = 200000;
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 2000;
    limit = Math.min(limit, ALBUM_TIMELINE_MAX);
    const db = getDb();
    const { photos, truncated } = workingSetTimeline(db, filter, limit);
    res.json({ photos, truncated, limit });
  });

  // --- Timeline filter density: timestamps of the working set (crossfilter on
  // every facet except the time range itself). Drives the brushable timeline's
  // KDE; down-sampled server-side so the payload stays small on big libraries.
  app.get("/api/times", (req, res) => {
    const { spec: filter, error: filterError } = parseFilterParam(req);
    if (filterError) return res.status(400).json({ error: filterError });
    const TIMES_SAMPLE_MAX = 12000;
    const db = getDb();
    res.json(workingSetTimes(db, filter, TIMES_SAMPLE_MAX));
  });

  // --- Materialize albums: move (default) or copy each album into its own
  // dated folder, as a cancelable background job. Move is copy->verify->unlink
  // (see moveFile) with an undo manifest, so a completed or partially-canceled
  // move can be reversed via POST /api/albums/undo-move.
  app.post("/api/albums/materialize", (req, res) => {
    const { destParent, albums } = req.body ?? {};
    if (typeof destParent !== "string" || destParent.length === 0) {
      return res.status(400).json({ error: "destParent is required" });
    }
    if (!Array.isArray(albums) || albums.length === 0) {
      return res
        .status(400)
        .json({ error: "albums must be a non-empty array" });
    }
    for (const a of albums) {
      if (typeof a?.name !== "string" || !a.name.length) {
        return res.status(400).json({ error: "each album needs a name" });
      }
      if (!Array.isArray(a.photoIds) || a.photoIds.length === 0) {
        return res
          .status(400)
          .json({ error: `album "${a.name}" has no photos` });
      }
    }

    const db = getDb();
    // Resolve + validate every album's destination up front (fail fast, 400,
    // before any job/file work starts) rather than discovering a bad album
    // name mid-job, which would just surface as an async job failure.
    const resolvedAlbums = [];
    for (const album of albums) {
      // Materialize allows an in-place destination (a subfolder of the source
      // folder) — that's the default "organize this folder in place" flow.
      const resolved = resolveExportTarget(db, destParent, album.name, {
        allowInsideSource: true,
      });
      if (resolved.error)
        return res.status(400).json({ error: resolved.error });
      resolvedAlbums.push({ album, target: resolved.target });
    }

    const move = req.body?.move !== false; // default MOVE
    const total = albums.reduce((n, a) => n + a.photoIds.length, 0);
    const job = registry.create("materialize", {
      label: `Materialize ${albums.length} albums (${move ? "move" : "copy"})`,
      total,
    });
    res.status(202).json({ jobId: job.id });

    (async () => {
      const results = [];
      const manifest = [];
      let done = 0;
      try {
        for (const { album, target } of resolvedAlbums) {
          // copyIdsIntoFolder is synchronous fs work end-to-end, so without a
          // yield here the whole multi-album job would run in one blocking
          // tick — starving the event loop (no other request, including a
          // cancel, could be served) and making the per-album abort check
          // below unreachable in practice. Yielding once per album keeps
          // cancel (and everything else) actually responsive.
          await new Promise((resolve) => setImmediate(resolve));
          if (job.controller.signal.aborted) {
            const e = new Error("canceled");
            e.name = "AbortError";
            throw e;
          }
          const r = copyIdsIntoFolder(db, target, album.photoIds, {
            signal: job.controller.signal,
            move,
            onProgress: (d, _t, phase) =>
              registry.update(job.id, {
                done: done + d,
                phase: `${album.name}: ${phase}`,
              }),
          });
          done += album.photoIds.length;
          results.push({
            name: album.name,
            target,
            copied: r.copied,
            moved: r.moved,
            skipped: r.skipped,
          });
          manifest.push(...r.manifest);
        }
        registry.finish(job.id, {
          destParent,
          albums: results,
          move,
          manifest,
        });
      } catch (e) {
        // Albums already fully processed (and, on the album that was
        // in-flight, whatever copyIdsIntoFolder had done before it threw —
        // see its `.manifest` on AbortError) must stay undoable even though
        // the job itself ends in "canceled"/"failed". Stash that into
        // `result` BEFORE fail() (fail() never touches `result`).
        const partialManifest = manifest.concat(e.manifest ?? []);
        if (move && partialManifest.length) {
          registry.update(job.id, {
            result: {
              destParent,
              albums: results,
              move,
              manifest: partialManifest,
            },
          });
        }
        registry.fail(job.id, e);
      }
    })();
  });

  // --- Undo a materialize-with-move: move every manifest entry back to its
  // original location and repoint the index. Skips entries whose `to` no
  // longer exists (e.g. the user already moved/renamed it via Finder).
  app.post("/api/albums/undo-move", (req, res) => {
    const { manifest } = req.body ?? {};
    if (!Array.isArray(manifest) || manifest.length === 0) {
      return res
        .status(400)
        .json({ error: "manifest must be a non-empty array" });
    }
    for (const m of manifest) {
      if (
        !Number.isInteger(m?.id) ||
        typeof m?.from !== "string" ||
        typeof m?.to !== "string"
      ) {
        return res
          .status(400)
          .json({ error: "each manifest entry needs id, from, to" });
      }
    }

    const db = getDb();
    const job = registry.create("undo-move", {
      label: `Undo move (${manifest.length} photos)`,
      total: manifest.length,
    });
    res.status(202).json({ jobId: job.id });

    (async () => {
      try {
        let restored = 0;
        let skipped = 0;
        for (let i = 0; i < manifest.length; i++) {
          // Same rationale as the materialize loop above: moveFile is
          // synchronous, so yield periodically to keep cancel responsive.
          if (i % 50 === 0)
            await new Promise((resolve) => setImmediate(resolve));
          if (job.controller.signal.aborted) {
            const e = new Error("canceled");
            e.name = "AbortError";
            throw e;
          }
          const entry = manifest[i];
          if (!existsSync(entry.to)) {
            skipped++;
          } else {
            moveFile(entry.to, entry.from);
            repointPhoto(db, Number(entry.id), entry.from);
            restored++;
          }
          registry.update(job.id, { done: i + 1, phase: "restoring" });
        }
        registry.finish(job.id, { restored, skipped });
      } catch (e) {
        registry.fail(job.id, e);
      }
    })();
  });
}
