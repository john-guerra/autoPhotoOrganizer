/**
 * Thin API client. All image fetches go through numeric ids resolved
 * server-side against the current scan session — never raw paths.
 */

import { toQueryParam } from "./filterSpec.js";

/**
 * @param {string} dir
 * @param {boolean} [recursive=false] scan every subfolder too ("soup folder")
 * @returns {Promise<{root:string, count:number, folders:number, elapsedMs:number, items:Array<{id:number,name:string,size:number,mtimeMs:number,rating:number,preferredCover:boolean}>}>}
 */
export async function scan(dir, recursive = false) {
  const res = await fetch("/api/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir, recursive }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `scan failed (${res.status})`);
  }
  return res.json();
}

/**
 * Fetch dimensions/takenAt for a batch of ids (feeds the justified layout).
 * @param {number[]} ids
 * @returns {Promise<Array<{id:number, takenAt:string|null, width:number|null, height:number|null, duration:number|null}>>}
 */
export async function fetchMeta(ids) {
  const res = await fetch(`/api/meta?ids=${ids.join(",")}`);
  if (!res.ok) throw new Error(`meta failed (${res.status})`);
  return res.json();
}

/** How many photos have never had their metadata read (drives the sweep button).
 * @returns {Promise<number>} */
export async function fetchPendingMeta() {
  const res = await fetch("/api/enrich/pending");
  if (!res.ok) throw new Error(`pending metadata check failed (${res.status})`);
  return (await res.json()).pending;
}

/**
 * Start a metadata job. With no ids it SWEEPS every photo nobody has read yet;
 * with ids it RE-READS exactly those, even ones already read (the file may have
 * changed on disk). Returns `{ jobId, pending }` — jobId is null when there was
 * nothing to do.
 * @param {number[]} [ids]
 * @returns {Promise<{jobId: string|null, pending: number}>}
 */
export async function startEnrich(ids) {
  const res = await fetch("/api/enrich", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ids ? { ids } : {}),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `metadata read failed (${res.status})`);
  }
  return res.json();
}

/**
 * @param {number} id
 * @param {number} rating
 */
export async function setRating(id, rating) {
  const res = await fetch("/api/rating", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, rating }),
  });
  if (!res.ok) throw new Error(`rating failed (${res.status})`);
  return res.json();
}

/**
 * @param {number} id
 * @param {boolean} isCover
 */
export async function setCover(id, isCover) {
  const res = await fetch("/api/cover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, isCover }),
  });
  if (!res.ok) throw new Error(`cover failed (${res.status})`);
  return res.json();
}

/** Force a set of photo ids into one manual burst stack (issue #24).
 * @param {number[]} ids @returns {Promise<{groupId:number, count:number}>} */
export async function createStack(ids) {
  const res = await fetch("/api/stacks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `create stack failed (${res.status})`);
  }
  return res.json();
}

/** Dissolve a stack: mark these photos "keep separate" so they don't auto-stack.
 * @param {number[]} ids @returns {Promise<{count:number}>} */
export async function dissolveStackApi(ids) {
  const res = await fetch("/api/stacks/dissolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `dissolve stack failed (${res.status})`);
  }
  return res.json();
}

/**
 * Ask the server to reveal a photo's real file in the OS file browser
 * (Finder/Explorer/file manager) — read-only, no file operations. Resolves to
 * `{ok:false, error}` on any failure instead of throwing, so callers can show a
 * non-blocking notice rather than crash the app.
 * @param {number} id
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function revealInFinder(id) {
  try {
    const res = await fetch(`/api/reveal/${id}`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: body.error || `reveal failed (${res.status})`,
      };
    }
    return body;
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/** Reveal a FOLDER in the OS file browser. Unlike revealInFinder (which takes a
 * photo id), the folder is named by path — the server refuses any path that
 * isn't a folder in this library, or an ancestor of one.
 * @returns {Promise<{ok:boolean, error?:string}>} */
export async function revealFolder(path) {
  try {
    const res = await fetch("/api/reveal-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: body.error || `reveal failed (${res.status})`,
      };
    }
    return body;
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/** Reveal a whole selection in the OS file browser (best-effort per platform;
 * macOS highlights all, Windows the first, Linux opens the folder). */
export async function revealSelection(ids) {
  try {
    const res = await fetch(`/api/reveal-selection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: body.error || `reveal failed (${res.status})`,
      };
    }
    return body;
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

// Image URLs carry a `v` version token (the file's mtimeMs). A numeric id is
// only meaningful within the current scan session — after rescanning a
// different folder, id 0 points to a different file. Without a version the
// browser's HTTP cache would serve the previous folder's thumbnail for that id.
// The server ignores `v`; it resolves the id against the session either way.

/** @param {number} id @param {number} size @param {number} [v] mtime version */
export function thumbUrl(id, size = 320, v = 0) {
  return `/api/thumb/${id}?size=${size}&v=${v}`;
}

/** @param {number} id @param {number} [v] mtime version */
export function previewUrl(id, v = 0) {
  return `/api/preview/${id}?v=${v}`;
}

/** @param {number} id @param {number} [v] mtime version */
export function imageUrl(id, v = 0) {
  return `/api/image/${id}?v=${v}`;
}

/** Video playback source — same Range-capable endpoint as imageUrl; the server
 * resolves the id kind-agnostically and streams the original bytes.
 * @param {number} id @param {number} [v] mtime version */
export function videoUrl(id, v = 0) {
  return `/api/image/${id}?v=${v}`;
}

/**
 * Ask the server how to play a video. Never point a <video> at the file
 * directly: the browser can't decode everything ffmpeg can read (an old
 * camcorder .avi plays its AUDIO and shows a black frame — Chromium has no
 * MPEG-4 Part 2 decoder), and a silent black rectangle looks like a broken file
 * rather than a missing codec.
 *
 * @param {number} id
 * @param {{transcode?: boolean}} [opts] transcode: convert it, don't offer me the
 *   original — the caller asked its OWN decoder about a `verify` type and was
 *   turned down (HEVC, whose support is a property of the machine, not the file).
 * @returns {Promise<{ready: true, url: string, verify?: string} | {preparing: true, jobId: string, reason: string}>}
 *   ready → play `url` (the original, or an already-built proxy). If it carries a
 *     `verify` MIME type, the server is GUESSING that this machine can decode it:
 *     check canPlayType(verify) first and come back with {transcode: true} if not.
 *   preparing → a transcode is running; wait on `jobId`, then play its result.
 */
export async function prepareVideo(id, { transcode = false } = {}) {
  const res = await fetch(`/api/video/${id}${transcode ? "?transcode=1" : ""}`);
  if (!res.ok && res.status !== 202) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `video failed (${res.status})`);
  }
  return res.json();
}

/** Format a duration in seconds as m:ss (or h:mm:ss past an hour). Returns "" for
 * null/NaN so the caller can omit the badge for un-probed videos.
 * @param {number|null|undefined} seconds */
export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return "";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

/**
 * @returns {Promise<Array<{path:string, name:string, lastScannedAt:number, mounted:boolean}>>}
 */
export async function fetchLibrary() {
  const res = await fetch("/api/library");
  if (!res.ok) throw new Error(`library failed (${res.status})`);
  return res.json();
}

/** @param {number} id */
export async function deleteFolder(id) {
  const res = await fetch(`/api/folders/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete folder failed (${res.status})`);
  return res.json();
}

/** Remove an indexed folder from the library by its on-disk path (index-only;
 * files on disk are untouched). @param {string} path */
export async function removeFolderByPath(path) {
  const res = await fetch(`/api/folders/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `remove folder failed (${res.status})`);
  }
  return res.json();
}

/** Remove photos from the index by id — how a non-folder group header drops its
 * subtree (there's no folder to delete). Files on disk are untouched. Chunked so
 * a huge group (a whole year) stays under the endpoint's per-request cap; the
 * counts are summed across chunks.
 * @param {number[]} ids
 * @returns {Promise<{removed:boolean, photos:number, folders:number}>} */
export async function removePhotosByIds(ids) {
  const CHUNK = 10000;
  let photos = 0;
  let folders = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const res = await fetch(`/api/photos/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ids.slice(i, i + CHUNK) }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `remove photos failed (${res.status})`);
    }
    const r = await res.json();
    photos += r.photos ?? 0;
    folders += r.folders ?? 0;
  }
  return { removed: true, photos, folders };
}

/** Rename a scanned folder on disk (and update the index). `path` is the
 * folder's absolute path, `newName` a bare folder name (no separators).
 * @param {string} path @param {string} newName
 * @returns {Promise<{ok:boolean, oldPath:string, newPath:string}>} */
export async function renameFolder(path, newName) {
  const res = await fetch(`/api/folders/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, newName }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `rename failed (${res.status})`);
  }
  return res.json();
}

/** @returns {Promise<{totalBytes:number, totalFiles:number}>} */
export async function fetchCacheStats() {
  const res = await fetch("/api/cache/stats");
  if (!res.ok) throw new Error(`cache stats failed (${res.status})`);
  return res.json();
}

/** @returns {Promise<{folders: Array<{id:number, path:string, cachedBytes:number, cachedFiles:number}>}>} */
export async function fetchCacheBreakdown() {
  const res = await fetch("/api/cache/breakdown");
  if (!res.ok) throw new Error(`cache breakdown failed (${res.status})`);
  return res.json();
}

/** @returns {Promise<{freedBytes:number, freedFiles:number}>} */
export async function clearCache() {
  const res = await fetch("/api/cache/clear", { method: "POST" });
  if (!res.ok) throw new Error(`cache clear failed (${res.status})`);
  return res.json();
}

/** @returns {Promise<{freedBytes:number, freedFiles:number}>} */
export async function pruneCache() {
  const res = await fetch("/api/cache/prune", { method: "POST" });
  if (!res.ok) throw new Error(`cache prune failed (${res.status})`);
  return res.json();
}

/**
 * A URL longer than this is sent as a POST body instead of a query string.
 *
 * Node caps request HEADERS (which is where the query string lives) at 16KB and
 * answers anything longer with a 431 — before Express, so no handler and no
 * error message of ours ever runs. The feed's `collapsed` param is unbounded:
 * collapsing every group of a 114k-photo library is 195KB of URL, so the feed
 * simply stopped responding. 8KB leaves room for the other params and is well
 * inside every proxy's limit; below it, nothing changes.
 */
const MAX_URL_BYTES = 8 * 1024;

/**
 * GET when the query fits in a URL, POST the same params as a JSON body when it
 * doesn't. The server serves both verbs from one handler, so the response is
 * identical either way — this is purely about what the transport can carry.
 */
async function getOrPost(path, params, what) {
  const qs = params.toString();
  const res =
    qs.length <= MAX_URL_BYTES
      ? await fetch(`${path}?${qs}`)
      : await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(Object.fromEntries(params)),
        });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${what} failed (${res.status})`);
  }
  return res.json();
}

/**
 * @param {{groupBy: string[], collapsed?: Array<Array<{dimension:string,value:string}>>, focusId?: number|null, startPath?: Array<{dimension:string,value:string}>|null, before?: number, after?: number, filter?: object|null}} opts
 * @returns {Promise<{items: object[], focusItem: object|null}>}
 */
export async function fetchFeed({
  groupBy,
  collapsed = [],
  focusId = null,
  startPath = null,
  before = 0,
  after = 50,
  filter = null,
  sort = null,
}) {
  const params = new URLSearchParams({
    groupBy: groupBy.join(","),
    before: String(before),
    after: String(after),
  });
  if (sort) params.set("sort", `${sort.by}:${sort.dir}`);
  if (focusId != null) params.set("focusId", String(focusId));
  if (startPath && startPath.length) {
    params.set("startPath", JSON.stringify(startPath));
  }
  if (collapsed.length) params.set("collapsed", JSON.stringify(collapsed));
  const fp = filter ? toQueryParam(filter) : null;
  if (fp) params.set("filter", fp);
  return getOrPost("/api/feed", params, "feed");
}

/**
 * @param {{groupBy: string[], collapsed?: Array<Array<{dimension:string,value:string}>>, focusId: number, direction: "next"|"prev", filter?: object|null}} opts
 * @returns {Promise<{id: number|null}>}
 */
export async function fetchGroupBoundary({
  groupBy,
  collapsed = [],
  focusId,
  direction,
  filter = null,
  sort = null,
}) {
  const params = new URLSearchParams({
    groupBy: groupBy.join(","),
    focusId: String(focusId),
    direction,
  });
  if (sort) params.set("sort", `${sort.by}:${sort.dir}`);
  if (collapsed.length) params.set("collapsed", JSON.stringify(collapsed));
  const fp = filter ? toQueryParam(filter) : null;
  if (fp) params.set("filter", fp);
  return getOrPost("/api/feed/boundary", params, "feed boundary");
}

/**
 * First/middle/last sample of a group, for the fisheye snapshot strip — a
 * scroll-free stand-in for a whole group without fetching every row.
 * @param {{path: Array<{dimension:string,value:string}>, groupBy: string[], filter?: object|null, sort?: object|null, slots?: number}} opts
 * @returns {Promise<{count:number, samples: Array<object & {offset:number, gapAfter:boolean}>}>}
 */
export async function fetchGroupSample({
  path,
  groupBy,
  filter = null,
  sort = null,
  slots = 12,
}) {
  const params = new URLSearchParams({
    groupBy: groupBy.join(","),
    path: JSON.stringify(path),
    slots: String(slots),
  });
  if (sort) params.set("sort", `${sort.by}:${sort.dir}`);
  const fp = filter ? toQueryParam(filter) : null;
  if (fp) params.set("filter", fp);
  const res = await fetch(`/api/group/sample?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `group sample failed (${res.status})`);
  }
  return res.json();
}

/**
 * @param {{groupBy: string[], path?: Array<{dimension:string,value:string}>, filter?: object|null}} opts
 * @returns {Promise<{total:number, nodes: Array<{value:string,label:string,count:number,hasChildren:boolean}>}>}
 */
export async function fetchTreeNode({
  groupBy,
  path = [],
  filter = null,
  sort = null,
}) {
  const params = new URLSearchParams({ groupBy: groupBy.join(",") });
  if (path.length) params.set("path", JSON.stringify(path));
  const fp = filter ? toQueryParam(filter) : null;
  if (fp) params.set("filter", fp);
  if (sort) params.set("sort", `${sort.by}:${sort.dir}`);
  const res = await fetch(`/api/tree?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `tree failed (${res.status})`);
  }
  return res.json();
}

/**
 * Ids of all non-stale photos matching a filter (for "filter → selection").
 * An optional group `path` scopes to one section ("select all in this group").
 * `sort` must be the feed's active sort so a date group scopes by the same date
 * column the feed grouped by — otherwise the id set disagrees with the section
 * (issue #71).
 * @param {{minRating?:number, orientations?:string[]}|null} [filter=null]
 * @param {Array<{dimension:string,value:string}>|null} [path=null]
 * @param {{by:string,dir:string}|null} [sort=null]
 * @returns {Promise<number[]>}
 */
export async function fetchPhotoIds(
  filter = null,
  path = null,
  sort = null,
  edge = null // "first" | "last" — ask the server for ONE id, not all of them
) {
  const params = new URLSearchParams();
  const fp = filter ? toQueryParam(filter) : null;
  if (fp) params.set("filter", fp);
  if (path && path.length) params.set("path", JSON.stringify(path));
  if (sort) params.set("sort", `${sort.by}:${sort.dir}`);
  if (edge) params.set("edge", edge);
  const res = await fetch(`/api/photos/ids?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `photo ids failed (${res.status})`);
  }
  return (await res.json()).ids;
}

/**
 * COUNT of matching photos. Empty filter ⇒ library total; a filter ⇒ "showing".
 * @param {{minRating?:number, orientations?:string[]}|null} [filter=null]
 * @returns {Promise<number>}
 */
export async function fetchPhotoCount(filter = null) {
  const params = new URLSearchParams();
  const fp = filter ? toQueryParam(filter) : null;
  if (fp) params.set("filter", fp);
  const res = await fetch(`/api/photos/count?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `photo count failed (${res.status})`);
  }
  return (await res.json()).count;
}

/**
 * Store the "keep only" working set server-side (any size — the ids go in the
 * POST body, not a URL param). An empty array clears the scope.
 * @param {number[]} ids
 * @returns {Promise<{count:number}>}
 */
export async function setScope(ids) {
  const res = await fetch("/api/scope", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `scope failed (${res.status})`);
  }
  return res.json();
}

/**
 * Copy the given photos into a new folder on disk (never moves/deletes).
 * @param {number[]} photoIds
 * @param {string} destParent existing parent directory
 * @param {string} folderName new subfolder to create inside destParent
 * @returns {Promise<{target:string, copied:number, skipped:number}>}
 */
export async function exportSelection(photoIds, destParent, folderName) {
  const res = await fetch("/api/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ photoIds, destParent, folderName }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `export failed (${res.status})`);
  }
  return res.json();
}

/**
 * The working set as a time-ordered timeline for album gap-clustering.
 * @param {{minRating?:number, orientations?:string[], scopeIds?:number[]}|null} [filter=null]
 * @param {number} [limit=20000] max photos to pull (server hard-caps at 200000)
 * @returns {Promise<{photos:Array<{id:number,t:number,mtimeMs:number}>, truncated:boolean, limit:number}>}
 */
export async function fetchAlbumTimeline(filter = null, limit = 20000) {
  const params = new URLSearchParams();
  const fp = filter ? toQueryParam(filter) : null;
  if (fp) params.set("filter", fp);
  if (limit) params.set("limit", String(limit));
  const res = await fetch(`/api/albums/timeline?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `album timeline failed (${res.status})`);
  }
  return res.json();
}

/**
 * Timestamps of the working set for the timeline filter's density curve. Pass
 * the filter with its time facet already stripped (the caller keys the
 * crossfilter refetch on the non-time facets); the server also strips it
 * defensively. Returns exact min/max/total plus a down-sampled `times` array.
 * @param {object|null} [filter=null] non-time filter facets (or null for the whole library)
 * @returns {Promise<{times:number[], total:number, min:number|null, max:number|null, sampled:boolean}>}
 */
export async function fetchTimes(filter = null) {
  const params = new URLSearchParams();
  const fp = filter ? toQueryParam(filter) : null;
  if (fp) params.set("filter", fp);
  const res = await fetch(`/api/times?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `times failed (${res.status})`);
  }
  return res.json();
}

/**
 * Materialize albums to disk: copy each album into its own folder under
 * destParent (copies, never moves).
 * @param {string} destParent
 * @param {Array<{name:string, photoIds:number[]}>} albums
 * @returns {Promise<{destParent:string, albums:Array<{name:string,target:string,copied:number,skipped:number}>}>}
 */
export async function materializeAlbums(destParent, albums) {
  const res = await fetch("/api/albums/materialize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ destParent, albums }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `materialize failed (${res.status})`);
  }
  return res.json();
}

/**
 * Danger zone: wipe the entire index + thumbnail cache. Requires the literal
 * confirmation string "DELETE". Source photos on disk are never touched.
 * @returns {Promise<{folders:number, photos:number, cacheFreedFiles:number, cacheFreedBytes:number}>}
 */
export async function resetLibrary() {
  const res = await fetch("/api/library/reset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: "DELETE" }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `reset failed (${res.status})`);
  }
  return res.json();
}

/**
 * Recursive scan runs as a cancelable background job (progress via the jobs
 * SSE stream / JobsPanel). Single-folder (non-recursive) scan still returns
 * items synchronously via `scan()` above — leave that path alone.
 * @param {string} dir
 * @param {{recursive?: boolean}} [opts]
 * @returns {Promise<{jobId: string}>}
 */
export async function startScan(dir, { recursive = true, dirs = null } = {}) {
  const res = await fetch("/api/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // `dirs` (optional) scans exactly that subset of the recursive walk — the
    // subfolders the user checked. Omitted entirely when they didn't curate one,
    // so the server takes its usual whole-tree path.
    body: JSON.stringify({ dir, recursive, ...(dirs ? { dirs } : {}) }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `scan failed (${res.status})`);
  }
  return res.json();
}

/**
 * The scannable subdirectories of `dir` (each with a media count) — the Add
 * panel's subfolder checklist. One entry per `folders` row a recursive scan
 * would create, so what the user checks maps 1:1 onto what they get.
 * @returns {Promise<Array<{path:string, relPath:string, depth:number, mediaCount:number}>>}
 */
export async function fetchSubdirs(dir) {
  const res = await fetch(`/api/fs/subdirs?dir=${encodeURIComponent(dir)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `couldn't read ${dir} (${res.status})`);
  }
  return res.json();
}

/**
 * Start an export as a background job. Job `result` is
 * `{target, copied, skipped}` once `status` leaves "running" — poll via
 * `waitForJob(jobId)` from `./jobs.js`.
 * @param {{photoIds:number[], destParent:string, folderName:string}} opts
 * @returns {Promise<{jobId: string}>}
 */
export async function startExport({
  photoIds,
  destParent,
  folderName,
  move = false, // MOVE the originals out of their source folder (undoable)
}) {
  const res = await fetch("/api/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ photoIds, destParent, folderName, move }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `export failed (${res.status})`);
  }
  return res.json();
}

/**
 * Materialize albums to disk as a background job. `move` defaults to true
 * server-side when omitted; job `result` is
 * `{destParent, albums:[{name,target,copied,moved,skipped}], move, manifest}`.
 * @param {{destParent:string, albums:Array<{name:string,photoIds:number[]}>, move?:boolean}} opts
 * @returns {Promise<{jobId: string}>}
 */
export async function startMaterialize({ destParent, albums, move }) {
  const res = await fetch("/api/albums/materialize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ destParent, albums, move }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `materialize failed (${res.status})`);
  }
  return res.json();
}

/**
 * Undo a completed move-materialize job: restores each `{from,to}` pair in
 * the job's result manifest. Runs as a background job too.
 * @param {Array<{id:number, from:string, to:string}>} manifest
 * @returns {Promise<{jobId: string}>}
 */
export async function undoMove(manifest) {
  const res = await fetch("/api/albums/undo-move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // Attach the HTTP status so callers can tailor the message (e.g. a 413
    // "manifest too large" vs a generic reject) — see undoFailureMessage.
    const err = new Error(body.error || `undo failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** @param {string} id */
export async function cancelJob(id) {
  const res = await fetch(`/api/jobs/${id}/cancel`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `cancel failed (${res.status})`);
  }
  return res.json();
}

/** @param {string} id */
export async function dismissJob(id) {
  const res = await fetch(`/api/jobs/${id}/dismiss`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `dismiss failed (${res.status})`);
  }
  return res.json();
}

/** Clear every finished job at once. Running jobs are untouched.
 * @returns {Promise<{ok: true, dismissed: number}>} */
export async function dismissAllJobs() {
  const res = await fetch(`/api/jobs/dismiss-all`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `dismiss failed (${res.status})`);
  }
  return res.json();
}

/**
 * @param {string[]} groupBy
 * @param {{minRating?:number, orientations?:string[]}|null} [filter=null]
 * @returns {Promise<{total:number, leaves: Array<{values: Record<string,string>, count:number}>}>}
 */
export async function fetchFlatTree(groupBy, filter = null, sort = null) {
  const params = new URLSearchParams({ groupBy: groupBy.join(",") });
  const fp = filter ? toQueryParam(filter) : null;
  if (fp) params.set("filter", fp);
  if (sort) params.set("sort", `${sort.by}:${sort.dir}`);
  const res = await fetch(`/api/tree/flat?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `flat tree failed (${res.status})`);
  }
  return res.json();
}

/**
 * Well-known system paths for the materialize dest picker's smart defaults
 * (Copy defaults to Desktop; Move defaults to in-place/source).
 * @returns {Promise<{home:string, desktop:string}>}
 */
export async function fetchSystemPaths() {
  const res = await fetch("/api/system/paths");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `system paths failed (${res.status})`);
  }
  return res.json();
}

/**
 * Whether two paths live on the same device (statSync(...).dev), so the UI
 * can warn that a same-volume-only "Move" would actually be a full copy.
 * `sameVolume` is `null` when either path can't be stat'd (e.g. dest not
 * created yet, or a drive is unmounted) rather than throwing.
 * @param {string} a
 * @param {string} b
 * @returns {Promise<{sameVolume: boolean|null}>}
 */
export async function checkSameVolume(a, b) {
  const params = new URLSearchParams({ a, b });
  const res = await fetch(`/api/system/same-volume?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `same-volume check failed (${res.status})`);
  }
  return res.json();
}

/** Photos that vanished from disk (stale, not dismissed) on mounted volumes. */
export async function fetchMissing() {
  const res = await fetch("/api/missing");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      body.error || `could not load missing files (${res.status})`
    );
  }
  return res.json();
}

/** Repoint a vanished photo to its new location (destAbsPath = the file's new path). */
export async function relocateMissing(id, destAbsPath) {
  const res = await fetch("/api/missing/relocate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, destAbsPath }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `relocate failed (${res.status})`);
  }
  return res.json();
}

/** Tombstone vanished photos (recoverable; never a hard delete). */
export async function dismissMissing(ids) {
  const res = await fetch("/api/missing/dismiss", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `dismiss failed (${res.status})`);
  }
  return res.json();
}

/** Carry a vanished copy's rating/albums/tags/stack onto an unrated survivor. */
export async function carryMissing(fromId, toId) {
  const res = await fetch("/api/missing/carry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fromId, toId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `carry failed (${res.status})`);
  }
  return res.json();
}
