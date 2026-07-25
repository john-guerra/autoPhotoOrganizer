import { dateAttrExpr } from "./sort.js";

/**
 * Compiles a filter spec into a SQL fragment + bound params, ANDed into the
 * WHERE of every set-reasoning feed/tree query. The single definition of
 * "what's included," so counts/seeks/grid never disagree. Returns a "1=1"
 * no-op when the spec constrains nothing, so callers can unconditionally
 * splice `AND (${filter.sql})`.
 *
 * Injection-safe: orientation names index a hardcoded fragment table; the
 * rating threshold is a bound param. User-supplied strings never reach SQL.
 *
 * @param {{minRating?: number, orientations?: string[], kinds?: string[], scopeIds?: number[], keepScope?: boolean, folderPath?: string, dateAttr?: string}} [spec]
 * @returns {{sql: string, params: any[]}}
 */
export function buildFilter(spec = {}) {
  const clauses = [];
  const params = [];

  const minRating = Number(spec?.minRating) || 0;
  if (minRating > 0) {
    clauses.push("photos.rating >= ?");
    params.push(minRating);
  }

  // De-duplicate and normalize to canonical (ALLOWED_ORIENTATIONS) order in
  // one pass: filtering ALLOWED_ORIENTATIONS by requested membership both
  // drops unknown names and collapses duplicates, and keeps the emitted SQL
  // fragment order deterministic regardless of the caller's input order.
  const requested = new Set(
    Array.isArray(spec?.orientations) ? spec.orientations : []
  );
  const orientations = ALLOWED_ORIENTATIONS.filter((o) => requested.has(o));
  // A strict, non-empty subset constrains; all three (or none) shows all.
  if (
    orientations.length > 0 &&
    orientations.length < ALLOWED_ORIENTATIONS.length
  ) {
    const ors = orientations.map((o) => ORIENTATION_FRAGMENTS[o]).join(" OR ");
    clauses.push(`photos.width > 0 AND photos.height > 0 AND (${ors})`);
  }

  // Media-kind facet (image / raw / video). Mirrors the orientation pass: a
  // strict, non-empty subset constrains via `photos.kind IN (...)`; all kinds
  // (or none) shows everything. Injection-safe — requested names are filtered
  // against the hardcoded ALLOWED_KINDS list and bound as params.
  const requestedKinds = new Set(Array.isArray(spec?.kinds) ? spec.kinds : []);
  const kinds = ALLOWED_KINDS.filter((k) => requestedKinds.has(k));
  if (kinds.length > 0 && kinds.length < ALLOWED_KINDS.length) {
    clauses.push(`photos.kind IN (${kinds.map(() => "?").join(",")})`);
    params.push(...kinds);
  }

  // Working-set scope ("keep only"): restrict to an explicit id set. Injection-
  // safe — only integers survive the filter, bound as params. This is how a
  // kept subset (a folder, a group, or the current selection) becomes the
  // universe every feed/tree/count query agrees on.
  const scopeIds = Array.isArray(spec?.scopeIds)
    ? spec.scopeIds.filter((n) => Number.isInteger(n))
    : null;
  if (scopeIds && scopeIds.length) {
    clauses.push(`photos.id IN (${scopeIds.map(() => "?").join(",")})`);
    params.push(...scopeIds);
  }

  // "Keep only" working set stored server-side (server/db/keepScope.js): the
  // filter carries only a boolean, so the scope can be any size (no URL-length
  // cap, unlike scopeIds above). Restrict to whatever is in the keep_scope table.
  if (spec?.keepScope) {
    clauses.push(`photos.id IN (SELECT photo_id FROM keep_scope)`);
  }

  // Folder-focus scope ("open a folder"): restrict to the chosen folder plus
  // everything nested under it. abs_path is stored with no trailing separator
  // (see upsertScan), so the subtree is the exact path OR any path beginning
  // with `path + sep`. The required separator before the wildcard keeps
  // /a/trip from matching a sibling /a/trip-2. LIKE metacharacters in a folder
  // name are escaped (with ESCAPE '\') so a literal % or _ can't widen the
  // match; the exact-equality arm compares the raw path (a bound param, not a
  // pattern). Paths on this platform are '/'-delimited absolute paths.
  //
  // Phrased as a `photos.folder_id IN (subquery)` (like keepScope above) rather
  // than a direct `folders.abs_path` comparison, so it works in EVERY query
  // this filter is spliced into — including the tree and feed-seek queries that
  // don't JOIN the folders table (those would otherwise throw "no such column:
  // folders.abs_path"). photos.folder_id is always present.
  if (typeof spec?.folderPath === "string" && spec.folderPath.length) {
    const escaped = spec.folderPath.replace(/([\\%_])/g, "\\$1");
    clauses.push(
      `photos.folder_id IN (SELECT id FROM folders WHERE abs_path = ? OR abs_path LIKE ? ESCAPE '\\')`
    );
    params.push(spec.folderPath, escaped + "/%");
  }

  // Free-text search: the file's NAME, the folder path it lives in, or the
  // PLACE it was taken (#154). Name and folder path are what a photographer
  // actually remembers ("that Tayrona folder", "PXL_2024-something"); place is
  // the same kind of memory ("that was the Bogota trip") now that GPS resolves
  // to a country/city. Place needs no subquery — unlike the folder path, it is
  // a plain per-photo column (photos.place_country/place_region/place_city),
  // already denormalized onto the row for exactly this kind of lookup.
  //
  // Case-insensitive by SQLite's default LIKE (ASCII). LIKE metacharacters in
  // the QUERY are escaped, so typing a literal % or _ searches for that
  // character instead of silently matching everything. Phrased against
  // photos.folder_id IN (subquery) rather than folders.abs_path so it also works
  // in the feed-seek and tree queries, which don't JOIN folders (the same reason
  // folderPath above is written that way — a direct abs_path comparison threw
  // "no such column" there).
  const text = typeof spec?.text === "string" ? spec.text.trim() : "";
  if (text) {
    const like = `%${text.replace(/([\\%_])/g, "\\$1")}%`;
    clauses.push(
      `(photos.filename LIKE ? ESCAPE '\\'
          OR photos.place_country LIKE ? ESCAPE '\\'
          OR photos.place_region LIKE ? ESCAPE '\\'
          OR photos.place_city LIKE ? ESCAPE '\\'
          OR photos.folder_id IN (SELECT id FROM folders WHERE abs_path LIKE ? ESCAPE '\\'))`
    );
    params.push(like, like, like, like, like);
  }

  // Time-range facet (timeline filter). Filters on the SAME date attribute the
  // timeline plots — driven by `dateAttr` (which follows the feed's sort date;
  // defaults to date_taken = EXIF-created) — so the brush, the density, the
  // grid, and the counts all agree on "when". Bounds are epoch ms; either may be
  // absent (open-ended). Injection-safe: the expr comes from a hardcoded table
  // keyed by dateAttr, bounds are bound params, never spliced strings. Guard
  // null/undefined explicitly: Number(null) === 0 is finite, which would
  // silently add a `>= 0` clause for an open-ended (null) bound.
  const timeExpr = dateAttrExpr(spec?.dateAttr);
  if (spec?.dateFrom != null && Number.isFinite(Number(spec.dateFrom))) {
    clauses.push(`${timeExpr} >= ?`);
    params.push(Number(spec.dateFrom));
  }
  if (spec?.dateTo != null && Number.isFinite(Number(spec.dateTo))) {
    clauses.push(`${timeExpr} <= ?`);
    params.push(Number(spec.dateTo));
  }

  if (!clauses.length) return { sql: "1=1", params: [] };
  return { sql: clauses.join(" AND "), params };
}

const ORIENTATION_FRAGMENTS = {
  landscape: "photos.width > photos.height",
  portrait: "photos.height > photos.width",
  square: "photos.width = photos.height",
};

export const ALLOWED_ORIENTATIONS = ["landscape", "portrait", "square"];
export const ALLOWED_KINDS = ["image", "raw", "video"];
