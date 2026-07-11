import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";

/** @param {string} absPath @returns {string} */
export function volumeRootForPath(absPath) {
  const match = /^(\/Volumes\/[^/]+)/.exec(absPath);
  return match ? match[1] : "/";
}

function defaultExec(mountRoot) {
  return execFileSync("diskutil", ["info", mountRoot], { encoding: "utf8" });
}

/**
 * @param {string} mountRoot
 * @param {(mountRoot: string) => string} [exec]
 * @returns {{uuid: string|null, label: string}}
 */
export function getVolumeInfo(mountRoot, exec = defaultExec) {
  try {
    const output = exec(mountRoot);
    const captured = /Volume UUID:\s+(\S+)/.exec(output)?.[1] ?? null;
    // FAT32/exFAT (common on SD cards) may report "Not applicable" instead of a UUID;
    // validate it matches the UUID format (8-4-4-4-12 hex) to avoid false positives.
    const uuidPattern =
      /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
    const uuid = captured && uuidPattern.test(captured) ? captured : null;
    const label =
      /Volume Name:\s+(.+)/.exec(output)?.[1]?.trim() ?? basename(mountRoot);
    return { uuid, label };
  } catch {
    return { uuid: null, label: basename(mountRoot) };
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} mountRoot
 * @param {(mountRoot: string) => string} [exec]
 * @returns {number} the volume's id
 */
export function upsertVolume(db, mountRoot, exec = defaultExec) {
  const { uuid, label } = getVolumeInfo(mountRoot, exec);
  const now = Date.now();

  if (uuid) {
    db.prepare(
      `INSERT INTO volumes (label, uuid, last_mount_path, last_seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         label = excluded.label,
         last_mount_path = excluded.last_mount_path,
         last_seen_at = excluded.last_seen_at`
    ).run(label, uuid, mountRoot, now);
    return db.prepare(`SELECT id FROM volumes WHERE uuid = ?`).get(uuid).id;
  }

  // No stable identifier available (non-macOS, or diskutil failed): key on
  // mount path instead, same degraded behavior as today's path-only check.
  const existing = db
    .prepare(
      `SELECT id FROM volumes WHERE last_mount_path = ? AND uuid IS NULL`
    )
    .get(mountRoot);
  if (existing) {
    db.prepare(
      `UPDATE volumes SET label = ?, last_seen_at = ? WHERE id = ?`
    ).run(label, now, existing.id);
    return existing.id;
  }
  return db
    .prepare(
      `INSERT INTO volumes (label, uuid, last_mount_path, last_seen_at)
       VALUES (?, NULL, ?, ?)`
    )
    .run(label, mountRoot, now).lastInsertRowid;
}

/**
 * @param {{uuid: string|null, last_mount_path: string}} volumeRow
 * @param {(mountRoot: string) => string} [exec]
 * @returns {boolean}
 */
export function isVolumeMounted(volumeRow, exec = defaultExec) {
  if (!volumeRow.uuid) {
    // No stable UUID (internal disk, or a non-macOS host where `diskutil`
    // doesn't exist): "mounted" degrades to "the mount path is present". Using
    // existsSync here instead of a `diskutil` probe keeps this correct on
    // Linux/Windows — the old probe threw on every non-macOS host and reported
    // every folder as unmounted (which turned the CI `mounted` assertion red).
    return existsSync(volumeRow.last_mount_path);
  }
  const current = getVolumeInfo(volumeRow.last_mount_path, exec);
  return current.uuid === volumeRow.uuid;
}
