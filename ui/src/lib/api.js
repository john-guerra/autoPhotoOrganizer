/**
 * Thin API client. All image fetches go through numeric ids resolved
 * server-side against the current scan session — never raw paths.
 */

/**
 * @param {string} dir
 * @returns {Promise<{root:string, count:number, elapsedMs:number, items:Array<{id:number,name:string,size:number,mtimeMs:number,rating:number,preferredCover:boolean}>}>}
 */
export async function scan(dir) {
  const res = await fetch("/api/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir }),
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

/**
 * @param {{groupBy: string[], collapsed?: Array<Array<{dimension:string,value:string}>>, focusId?: number|null, startPath?: Array<{dimension:string,value:string}>|null, before?: number, after?: number}} opts
 * @returns {Promise<{items: object[], focusItem: object|null}>}
 */
export async function fetchFeed({
  groupBy,
  collapsed = [],
  focusId = null,
  startPath = null,
  before = 0,
  after = 50,
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
  const res = await fetch(`/api/feed?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `feed failed (${res.status})`);
  }
  return res.json();
}

/**
 * @param {{groupBy: string[], path?: Array<{dimension:string,value:string}>}} opts
 * @returns {Promise<{total:number, nodes: Array<{value:string,label:string,count:number,hasChildren:boolean}>}>}
 */
export async function fetchTreeNode({ groupBy, path = [] }) {
  const params = new URLSearchParams({ groupBy: groupBy.join(",") });
  if (path.length) params.set("path", JSON.stringify(path));
  const res = await fetch(`/api/tree?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `tree failed (${res.status})`);
  }
  return res.json();
}
