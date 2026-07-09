/**
 * Feed sort semantics — the single home for "what can we sort by" and how a
 * date sort drives the date group dimensions. Pure (no DB handle), so it is
 * unit-testable and importable by feed.js / tree.js / api.js alike.
 */

/** Each date source as a null-safe SQL expr over epoch-ms columns. */
export const DATE_SOURCES = {
  date_taken: "COALESCE(photos.taken_at, photos.mtime)",
  date_created: "COALESCE(photos.btime, photos.mtime)",
  date_modified: "photos.mtime",
};

/** Sortable attributes. Determinism only needs to be total *with* the id
 *  tiebreak the feed appends, so ties are fine. */
export const SORT_ATTRS = {
  date_taken: { expr: DATE_SOURCES.date_taken },
  date_created: { expr: DATE_SOURCES.date_created },
  date_modified: { expr: DATE_SOURCES.date_modified },
  rating: { expr: "photos.rating" },
  size: { expr: "photos.size" },
  name: { expr: "photos.filename COLLATE NOCASE" },
};

const DEFAULT_SORT = { by: "date_taken", dir: "desc" };

/** @param {string|undefined} raw "by:dir" @returns {{by:string,dir:"asc"|"desc"}} */
export function parseSort(raw) {
  if (typeof raw !== "string" || !raw) return { ...DEFAULT_SORT };
  const [by, dir] = raw.split(":");
  return {
    by: SORT_ATTRS[by] ? by : DEFAULT_SORT.by,
    dir: dir === "asc" || dir === "desc" ? dir : DEFAULT_SORT.dir,
  };
}

/** The photo-level sort column inserted into the seek tuple. */
export function sortSeekDim(sort) {
  return {
    name: "__sort",
    expr: SORT_ATTRS[sort.by].expr,
    direction: sort.dir.toUpperCase(),
  };
}

// year/month/day formats MUST reproduce the current DIMENSIONS exprs (only the
// date source varies). NOTE: the timeline spec later changes `month` to "%m"
// (month-of-year); when that lands, update the month format here too — this is
// the single seam both features touch.
const DATE_DIM_FMT = { year: "%Y", month: "%Y-%m", day: "%Y-%m-%d" };

function dateDimExpr(unit, srcExpr) {
  return `COALESCE(strftime('${DATE_DIM_FMT[unit]}', (${srcExpr}) / 1000, 'unixepoch'), '')`;
}

/** Rewrite year/month/day dims to the sort's date source + direction. A non-date
 *  sort leaves them at the default (taken, DESC). Other dims pass through. */
export function applySortToDims(dims, sort) {
  const isDate = Boolean(DATE_SOURCES[sort?.by]);
  const src = isDate ? DATE_SOURCES[sort.by] : DATE_SOURCES.date_taken;
  const dir = isDate ? sort.dir.toUpperCase() : "DESC";
  return dims.map((d) =>
    ["year", "month", "day"].includes(d.name)
      ? { ...d, expr: dateDimExpr(d.name, src), direction: dir }
      : d
  );
}
