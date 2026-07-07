import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";

/** @param {string} path @returns {Promise<string>} */
export function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha1");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Hash photos whose content_hash is still NULL. Never blocks a scan's grid
 * paint — callers invoke this after already responding to the request.
 * @param {import("better-sqlite3").Database} db
 * @param {{limit?: number}} [opts]
 * @returns {Promise<{hashed: number, remaining: boolean}>}
 */
export async function hashPendingPhotos(db, { limit = 50 } = {}) {
  const rows = db
    .prepare(
      `SELECT photos.id, folders.abs_path AS folder_abs_path, photos.filename
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE photos.content_hash IS NULL AND photos.stale = 0
       LIMIT ?`
    )
    .all(limit);

  const update = db.prepare(`UPDATE photos SET content_hash = ? WHERE id = ?`);
  let hashed = 0;
  for (const row of rows) {
    const path = join(row.folder_abs_path, row.filename);
    try {
      const hash = await hashFile(path);
      update.run(hash, row.id);
      hashed++;
    } catch {
      // Unreadable file: leave content_hash NULL. Hashing failure must
      // never block culling on an otherwise-usable photo.
    }
  }
  return { hashed, remaining: rows.length === limit };
}
