import { relative, sep } from "node:path";
import { listDirsRecursive } from "./walkDirs.js";

/**
 * The candidate directories a recursive scan of `root` would import, each with
 * the number of media files in it — the input to the Add panel's subfolder
 * checklist. One entry here == one `folders` row the scan would create, so what
 * the user checks maps 1:1 onto what they get.
 *
 * Counting delegates to ProcessingService.scan, which is the single place that
 * knows which extensions count as photos/video (see walkDirs.js's note). A dir
 * with no media is omitted: a recursive scan already skips creating a row for
 * it, so offering it as a checkbox would be a lie.
 *
 * @param {string} root absolute directory path
 * @param {{scan: (dir:string) => Promise<unknown[]>}} processing
 * @returns {Promise<Array<{path:string, relPath:string, depth:number, mediaCount:number}>>}
 */
export async function listSubdirsWithCounts(root, processing) {
  const dirs = await listDirsRecursive(root);
  const out = [];
  for (const dir of dirs) {
    const files = await processing.scan(dir);
    if (!files.length) continue;
    const relPath = relative(root, dir);
    out.push({
      path: dir,
      relPath,
      depth: relPath === "" ? 0 : relPath.split(sep).length,
      mediaCount: files.length,
    });
  }
  return out;
}
