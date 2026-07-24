import { relative, sep } from "node:path";
import { listDirsRecursive } from "./walkDirs.js";

/**
 * The candidate directories a recursive scan of `root` would import, each with
 * the number of media files in it — the input to the Add panel's subfolder
 * checklist. One entry here == one `folders` row the scan would create, so what
 * the user checks maps 1:1 onto what they get.
 *
 * Counting delegates to ProcessingService.scan, which is the single place that
 * knows which extensions count as photos/video (see walkDirs.js's note).
 *
 * A dir with no media of its OWN but media somewhere beneath it (a "Cards"
 * folder whose photos all live in camera subfolders) is kept as a `virtual`
 * grouping row: the recursive scan makes no `folders` row for it, but the
 * checklist needs a parent checkbox that toggles the whole subtree, or the
 * children render orphaned and there's no one click to drop the card (#137).
 * Its `mediaCount` is the subtree total, for a meaningful count column. A dir
 * with no media anywhere beneath it is dropped entirely.
 *
 * Order is depth-first (parent before its children), so the flat, depth-
 * indented checklist nests correctly.
 *
 * @param {string} root absolute directory path
 * @param {{scan: (dir:string) => Promise<unknown[]>}} processing
 * @returns {Promise<Array<{path:string, relPath:string, depth:number, mediaCount:number, virtual:boolean}>>}
 */
export async function listSubdirsWithCounts(root, processing) {
  const dirs = await listDirsRecursive(root); // depth-first: parent before child
  const direct = new Map(); // dir -> its OWN media count
  for (const dir of dirs) direct.set(dir, (await processing.scan(dir)).length);

  // Subtree total for each dir = its own media plus every descendant's. A dir
  // with a zero subtree total has no media anywhere below and is dropped.
  const subtreeTotal = (dir) => {
    const prefix = dir.endsWith(sep) ? dir : dir + sep;
    let n = direct.get(dir) ?? 0;
    for (const [d, c] of direct) if (d.startsWith(prefix)) n += c;
    return n;
  };

  const out = [];
  for (const dir of dirs) {
    const own = direct.get(dir) ?? 0;
    const total = subtreeTotal(dir);
    if (total === 0) continue; // empty branch: no row, nothing to group
    const relPath = relative(root, dir);
    const virtual = own === 0;
    // The root ITSELF is the folder being added, not a subfolder to choose — a
    // virtual row for it would just duplicate the All/None buttons. (A root with
    // its own media is still a real, selectable row, as before.)
    if (virtual && relPath === "") continue;
    out.push({
      path: dir,
      relPath,
      depth: relPath === "" ? 0 : relPath.split(sep).length,
      // A virtual (media-less) parent shows its subtree total so the count
      // column is meaningful; a real dir shows its own media count.
      mediaCount: virtual ? total : own,
      virtual,
    });
  }
  return out;
}
