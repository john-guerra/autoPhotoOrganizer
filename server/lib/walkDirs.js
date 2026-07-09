import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * List `root` and every subdirectory beneath it, depth-first. Hidden
 * directories (dotfiles like `.git`, `.Trashes`, `@eaDir` variants users tend
 * to keep hidden) are skipped, and symlinked directories are NOT followed —
 * `readdir(..., {withFileTypes:true})` reports a symlink's Dirent with
 * `isDirectory() === false`, so the plain `isDirectory()` gate both skips
 * files and stops symlink loops (a folder linking back into its own ancestor
 * would otherwise recurse forever). An unreadable directory (permissions) is
 * silently skipped rather than aborting the whole walk.
 *
 * This is the pure directory-enumeration half of a recursive scan: the caller
 * runs the media-file scan (ProcessingService.scan) on each returned dir, so
 * the "which files count as photos" logic stays in one place.
 *
 * @param {string} root absolute directory path
 * @returns {Promise<string[]>} root first, then each descendant directory
 */
export async function listDirsRecursive(root) {
  const dirs = [];
  const walk = async (dir) => {
    dirs.push(dir);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable (permissions, vanished mid-walk): skip this branch
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue; // files AND symlinks-to-dirs skipped
      if (entry.name.startsWith(".")) continue; // hidden directories
      await walk(join(dir, entry.name));
    }
  };
  await walk(root);
  return dirs;
}
