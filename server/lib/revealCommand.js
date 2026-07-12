import { dirname } from "node:path";

/**
 * Map an OS platform to the file-manager command that reveals `filePath` in the
 * system file browser (highlighting the file where the platform supports it).
 *
 * Pure and side-effect-free so it can be unit-tested without spawning anything;
 * the caller runs the returned `{cmd, args}` through `execFile` (args array, no
 * shell). Returns `null` for platforms we don't support.
 *
 * @param {NodeJS.Platform|string} platform - typically `process.platform`.
 * @param {string} filePath - absolute path to the file to reveal.
 * @returns {{cmd: string, args: string[]}|null}
 */
export function revealCommand(platform, filePath) {
  switch (platform) {
    case "darwin":
      return { cmd: "open", args: ["-R", filePath] };
    case "win32":
      // Explorer's `/select,` highlights the file in its folder. Explorer often
      // exits non-zero even on success, so callers must not treat a non-zero
      // exit on Windows as a failure.
      return { cmd: "explorer", args: ["/select,", filePath] };
    case "linux":
      // No portable "select this file" call on Linux — open the containing
      // folder instead.
      return { cmd: "xdg-open", args: [dirname(filePath)] };
    default:
      return null;
  }
}

/**
 * Best-effort "reveal these N files" for a multi-selection. Where the platform
 * can highlight multiple files it does; otherwise it falls back to the best it
 * can (highlight the first / open the folder). Pure and side-effect-free.
 *
 * - darwin: AppleScript `reveal {POSIX file …}` selects ALL of them in Finder.
 * - win32:  `explorer /select,` is single-file only, so highlight the first.
 * - linux:  open the containing folder of the first file (no portable select).
 *
 * @param {NodeJS.Platform|string} platform
 * @param {string[]} filePaths - absolute paths (assumed non-empty).
 * @returns {{cmd: string, args: string[]}|null}
 */
export function revealManyCommand(platform, filePaths) {
  const paths = Array.isArray(filePaths) ? filePaths.filter(Boolean) : [];
  if (!paths.length) return null;
  // A single path is just the single-file reveal on every platform.
  if (paths.length === 1) return revealCommand(platform, paths[0]);

  switch (platform) {
    case "darwin": {
      // Build `reveal {POSIX file "p1", POSIX file "p2", …}` then activate
      // Finder. Escape backslashes and quotes inside each AppleScript string
      // literal so a path with those characters can't break out of the quotes.
      const list = paths
        .map(
          (p) => `POSIX file "${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
        )
        .join(", ");
      const script = `tell application "Finder"\nactivate\nreveal {${list}}\nend tell`;
      return { cmd: "osascript", args: ["-e", script] };
    }
    case "win32":
      // Explorer can't select multiple from the command line — highlight the
      // first file (callers should note the limitation to the user).
      return { cmd: "explorer", args: ["/select,", paths[0]] };
    case "linux":
      return { cmd: "xdg-open", args: [dirname(paths[0])] };
    default:
      return null;
  }
}
