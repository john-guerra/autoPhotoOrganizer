/**
 * Thin API client. All image fetches go through numeric ids resolved
 * server-side against the current scan session — never raw paths.
 */

/**
 * @param {string} dir
 * @returns {Promise<{root:string, count:number, elapsedMs:number, items:Array<{id:number,name:string,size:number,mtimeMs:number,rating:number}>}>}
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
