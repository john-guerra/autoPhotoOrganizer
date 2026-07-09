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
 * @returns {Promise<Array<{id:number, takenAt:string|null, width:number|null, height:number|null}>>}
 */
export async function fetchMeta(ids) {
  const res = await fetch(`/api/meta?ids=${ids.join(",")}`);
  if (!res.ok) throw new Error(`meta failed (${res.status})`);
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
}) {
  const params = new URLSearchParams({
    groupBy: groupBy.join(","),
    before: String(before),
    after: String(after),
  });
  if (focusId != null) params.set("focusId", String(focusId));
  if (startPath && startPath.length) {
    params.set("startPath", JSON.stringify(startPath));
  }
  if (collapsed.length) params.set("collapsed", JSON.stringify(collapsed));
  const fp = filter ? toQueryParam(filter) : null;
  if (fp) params.set("filter", fp);
  const res = await fetch(`/api/feed?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `feed failed (${res.status})`);
  }
  return res.json();
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
}) {
  const params = new URLSearchParams({
    groupBy: groupBy.join(","),
    focusId: String(focusId),
    direction,
  });
  if (collapsed.length) params.set("collapsed", JSON.stringify(collapsed));
  const fp = filter ? toQueryParam(filter) : null;
  if (fp) params.set("filter", fp);
  const res = await fetch(`/api/feed/boundary?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `feed boundary failed (${res.status})`);
  }
  return res.json();
}

/**
 * @param {{groupBy: string[], path?: Array<{dimension:string,value:string}>, filter?: object|null}} opts
 * @returns {Promise<{total:number, nodes: Array<{value:string,label:string,count:number,hasChildren:boolean}>}>}
 */
export async function fetchTreeNode({ groupBy, path = [], filter = null }) {
  const params = new URLSearchParams({ groupBy: groupBy.join(",") });
  if (path.length) params.set("path", JSON.stringify(path));
  const fp = filter ? toQueryParam(filter) : null;
  if (fp) params.set("filter", fp);
  const res = await fetch(`/api/tree?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `tree failed (${res.status})`);
  }
  return res.json();
}

/**
 * Ids of all non-stale photos matching a filter (for "filter → selection").
 * @param {{minRating?:number, orientations?:string[]}|null} [filter=null]
 * @returns {Promise<number[]>}
 */
export async function fetchPhotoIds(filter = null) {
  const params = new URLSearchParams();
  const fp = filter ? toQueryParam(filter) : null;
  if (fp) params.set("filter", fp);
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
 * @param {string[]} groupBy
 * @param {{minRating?:number, orientations?:string[]}|null} [filter=null]
 * @returns {Promise<{total:number, leaves: Array<{values: Record<string,string>, count:number}>}>}
 */
export async function fetchFlatTree(groupBy, filter = null) {
  const params = new URLSearchParams({ groupBy: groupBy.join(",") });
  const fp = filter ? toQueryParam(filter) : null;
  if (fp) params.set("filter", fp);
  const res = await fetch(`/api/tree/flat?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `flat tree failed (${res.status})`);
  }
  return res.json();
}
