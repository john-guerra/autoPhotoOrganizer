import { statSync } from "node:fs";

/**
 * Is this folder still there?
 *
 * The sweep's failure classifier needs to tell "this photo is corrupt" from
 * "the drive went away" — see #169, where conflating the two marked every
 * unreachable file permanently attempted and excluded it from hashing forever.
 *
 * Probes the FOLDER, deliberately:
 *  - not the file, whose absence is the thing being diagnosed;
 *  - not the volume mount root, because on macOS `/Volumes/Name` can survive an
 *    eject as an empty directory, which would report a vanished drive as
 *    present and defeat the whole check.
 *
 * Synchronous: it runs only on the failure path (one stat per FAILURE, not per
 * row), and the sweep is already awaiting between batches.
 *
 * @param {string} absPath folder path
 * @returns {boolean}
 */
export function reachable(absPath) {
  try {
    return statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}
