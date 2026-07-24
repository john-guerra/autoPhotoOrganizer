import { sep } from "node:path";

/**
 * Canonicalise a folder path for use as a stable identity key.
 *
 * `folders.abs_path` is a UNIQUE column and the ON CONFLICT target in
 * `upsertScan`, so identity is the exact string. A path that arrives with a
 * trailing separator — `/trip/` vs `/trip` — would otherwise become a SECOND
 * folders row for the same physical directory. That row holds the same files,
 * so the feed renders every photo twice (#138).
 *
 * This strips trailing separators only (both the platform `sep` and a literal
 * "/", since callers may pass POSIX paths on any platform). It deliberately
 * does NOT `resolve()` — it must not touch `.`/`..` or make relative absolute,
 * so a path already stored verbatim keeps its exact spelling apart from the
 * trailing slash. The filesystem root ("/") is preserved, never reduced to "".
 *
 * @param {string} p
 * @returns {string}
 */
export function normalizeFolderPath(p) {
  if (typeof p !== "string" || p.length === 0) return p;
  let out = p;
  while (out.length > 1 && (out.endsWith("/") || out.endsWith(sep))) {
    out = out.slice(0, -1);
  }
  return out;
}
