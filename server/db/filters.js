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
 * @param {{minRating?: number, orientations?: string[]}} [spec]
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
  if (orientations.length > 0 && orientations.length < ALLOWED_ORIENTATIONS.length) {
    const ors = orientations.map((o) => ORIENTATION_FRAGMENTS[o]).join(" OR ");
    clauses.push(`photos.width > 0 AND photos.height > 0 AND (${ors})`);
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
