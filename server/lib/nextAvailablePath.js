import { existsSync } from "node:fs";
import { join, extname, basename } from "node:path";

/**
 * Find a free (non-colliding) absolute path for `filename` inside `dir`,
 * never overwriting an existing file. On collision, inserts " (2)", " (3)",
 * ... before the extension until a free name is found — the same policy
 * Finder/Explorer use for "copy into a folder that already has this file."
 * @param {string} dir - Absolute destination directory.
 * @param {string} filename - Desired filename (basename only).
 * @returns {string} An absolute path inside `dir` that does not yet exist.
 */
export function nextAvailablePath(dir, filename) {
  const ext = extname(filename);
  const base = basename(filename, ext);
  let candidate = join(dir, filename);
  let n = 2;
  while (existsSync(candidate)) {
    candidate = join(dir, `${base} (${n})${ext}`);
    n++;
  }
  return candidate;
}
