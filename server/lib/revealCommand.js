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
