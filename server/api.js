import { createHash } from "node:crypto";
import { existsSync, statSync, createReadStream } from "node:fs";
import { writeFile, rename, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { NodeProcessingService } from "./processing/NodeProcessingService.js";
import { thumbsDir } from "./lib/cachePaths.js";
import { getAllRatings, setRating } from "./ratings.js";
import { getAllCoverChoices, setCoverChoice } from "./coverChoices.js";
import { getMeta, putMeta } from "./metaCache.js";
import { getAllLibraryEntries, recordScan } from "./library.js";

const processing = new NodeProcessingService();

/**
 * Module-level scan session. The UI never sends raw file paths for image
 * fetches — it sends numeric ids which index into `session.items`, resolved to
 * absolute paths server-side. A rescan replaces the whole session.
 * @type {{ root: string|null, items: Array<{id:number, path:string, name:string, size:number, mtimeMs:number, takenAt?:string|null}> }}
 */
const session = { root: null, items: [] };

/** @param {number} id @returns {(typeof session.items)[number] | undefined} */
function itemById(id) {
  if (!Number.isInteger(id) || id < 0 || id >= session.items.length)
    return undefined;
  return session.items[id];
}

const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * Register the v0.1 API routes on an Express app.
 * @param {import("express").Express} app
 */
export function registerApi(app) {
  // --- Scan ---------------------------------------------------------------
  app.post("/api/scan", async (req, res) => {
    const dir = req.body?.dir;
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
    recordScan(dir);

    const t0 = performance.now();
    const files = await processing.scan(dir);
    session.root = dir;
    session.items = files.map((f, id) => ({
      id,
      path: f.path,
      name: f.name,
      size: f.size,
      mtimeMs: f.mtimeMs,
    }));
    const elapsedMs = Math.round(performance.now() - t0);

    const ratings = getAllRatings();
    const coverChoices = getAllCoverChoices();
    const items = session.items.map((it) => ({
      id: it.id,
      name: it.name,
      size: it.size,
      mtimeMs: it.mtimeMs,
      rating: ratings[it.path] ?? 0,
      preferredCover: coverChoices[it.path] === true,
    }));
    res.json({ root: dir, count: items.length, elapsedMs, items });
  });

  // --- Lazy metadata enrichment --------------------------------------------
  // GET /api/meta?ids=0,1,2 -> [{ id, takenAt, width, height }].
  // Dimensions feed the justified grid layout; takenAt feeds album clustering
  // later. Batched (the UI requests chunks). Two cache layers: the in-memory
  // session, and the persistent ~/.autogallery/metacache.json keyed by
  // absPath+mtimeMs so each folder pays the extraction cost once ever.
  app.get("/api/meta", async (req, res) => {
    const idsParam = String(req.query.ids ?? "");
    const ids = idsParam
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n));
    const need = [];
    for (const id of ids) {
      const it = itemById(id);
      if (!it || it.takenAt !== undefined) continue; // done or unknown id
      const hit = getMeta(it.path, it.mtimeMs);
      if (hit) {
        it.takenAt = hit.t;
        it.width = hit.w;
        it.height = hit.h;
      } else {
        need.push(it);
      }
    }
    if (need.length) {
      const metas = await processing.metadata(need.map((it) => it.path));
      metas.forEach((m, i) => {
        const it = need[i];
        const d = m.createDate;
        it.takenAt = d ? new Date(d).toISOString() : null;
        it.width = m.width ?? null;
        it.height = m.height ?? null;
        putMeta(it.path, it.mtimeMs, {
          w: it.width,
          h: it.height,
          t: it.takenAt,
        });
      });
    }
    const out = ids
      .map((id) => itemById(id))
      .filter(Boolean)
      .map((it) => ({
        id: it.id,
        takenAt: it.takenAt ?? null,
        width: it.width ?? null,
        height: it.height ?? null,
      }));
    res.json(out);
  });

  // --- Thumbnail ----------------------------------------------------------
  app.get("/api/thumb/:id", async (req, res) => {
    const it = itemById(Number(req.params.id));
    if (!it) return res.status(404).end();
    const size = Math.min(1024, Math.max(64, Number(req.query.size) || 320));

    const key = createHash("sha1")
      .update(`${it.path}:${it.mtimeMs}:${it.size}:${size}`)
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
      // Atomic cache write so a concurrent request never reads a partial file.
      const tmp = `${cachePath}.${process.pid}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, cachePath);
      res.set("X-Cache", "miss");
      res.send(data);
    } catch (err) {
      res.status(500).json({ error: `thumbnail failed: ${err.message}` });
    }
  });

  // --- Full image (loupe) -------------------------------------------------
  app.get("/api/image/:id", async (req, res) => {
    const it = itemById(Number(req.params.id));
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

  // --- Ratings ------------------------------------------------------------
  app.get("/api/ratings", (_req, res) => {
    // Return ratings for the current session keyed by id (plus the raw map).
    const map = getAllRatings();
    const byId = {};
    for (const it of session.items) {
      const r = map[it.path];
      if (r) byId[it.id] = r;
    }
    res.json({ byId });
  });

  app.post("/api/rating", (req, res) => {
    const { id, rating } = req.body ?? {};
    const it = itemById(Number(id));
    if (!it) return res.status(404).json({ error: "unknown id" });
    if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
      return res.status(400).json({ error: "rating must be an integer 0-5" });
    }
    setRating(it.path, rating);
    res.json({ id: it.id, rating });
  });

  app.post("/api/cover", (req, res) => {
    const { id, isCover } = req.body ?? {};
    const it = itemById(Number(id));
    if (!it) return res.status(404).json({ error: "unknown id" });
    if (typeof isCover !== "boolean") {
      return res.status(400).json({ error: "isCover must be a boolean" });
    }
    setCoverChoice(it.path, isCover);
    res.json({ id: it.id, preferredCover: isCover });
  });

  // --- Library (recently-scanned folders) ----------------------------------
  app.get("/api/library", (_req, res) => {
    const entries = getAllLibraryEntries().map((e) => ({
      ...e,
      mounted: existsSync(e.path),
    }));
    res.json(entries);
  });
}

/** Reset the scan session (tests only). */
export function _resetSession() {
  session.root = null;
  session.items = [];
}
