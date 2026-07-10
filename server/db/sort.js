/**
 * Feed sort semantics — the single home for "what can we sort by" and how a
 * date sort drives the date group dimensions. Pure (no DB handle), so it is
 * unit-testable and importable by feed.js / tree.js / api.js alike.
 *
 * Two intentionally-different date treatments:
 *  - SORTING (SORT_ATTRS) uses a NULL-safe expr that falls back to mtime, so an
 *    undated photo still sorts into a sensible position instead of clumping.
 *  - GROUPING (GROUP_DATE_COL, via applySortToDims) uses the RAW column, so an
 *    undated photo keeps landing in the "Unknown" bucket ('' from a NULL date) —
 *    a deliberate, tested grouping behavior (and what the timeline's Unknown
 *    band mirrors). Falling back to mtime here would silently erase Unknown.
 */

/** Sortable attributes → NULL-safe ORDER-BY exprs. Determinism only needs to be
 *  total *with* the id tiebreak the feed appends, so ties are fine. Date attrs
 *  fall back to mtime (confirmed with the user). */
export const SORT_ATTRS = {
  date_taken: { expr: "COALESCE(photos.taken_at, photos.mtime)" },
  date_created: { expr: "COALESCE(photos.btime, photos.mtime)" },
  date_modified: { expr: "photos.mtime" },
  rating: { expr: "photos.rating" },
  size: { expr: "photos.size" },
  name: { expr: "photos.filename COLLATE NOCASE" },
};

/** Raw date columns per date sort, for GROUP-dimension exprs. Raw (not COALESCE)
 *  so a NULL date → '' Unknown bucket survives. Non-date sorts group by taken. */
const GROUP_DATE_COL = {
  date_taken: "photos.taken_at",
  date_created: "photos.btime",
  date_modified: "photos.mtime",
};

/** The date-type sort attributes (the ones the timeline can plot against). */
export const DATE_SORTS = ["date_taken", "date_created", "date_modified"];

/** @param {string} attr @returns {boolean} is it a date-type sort? */
export function isDateSort(attr) {
  return DATE_SORTS.includes(attr);
}

/** NULL-safe instant expr for a date attribute, shared by the time FILTER
 *  (buildFilter) and the timeline density (workingSetTimes) so both agree on
 *  which date the timeline reflects. Falls back to date_taken (EXIF-created) for
 *  a missing/non-date attr, so the timeline always has a sensible date to plot. */
export function dateAttrExpr(attr) {
  return SORT_ATTRS[isDateSort(attr) ? attr : "date_taken"].expr;
}

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

// year/month/day formats MUST match the DIMENSIONS exprs (only the date source
// varies). `month` is month-of-year ("%m" → "01".."12"), so all Decembers
// aggregate into one group regardless of year; a full chronological month is
// still reachable via groupBy [year, month].
const DATE_DIM_FMT = { year: "%Y", month: "%m", day: "%Y-%m-%d" };

function dateDimExpr(unit, colExpr) {
  // Outer COALESCE(..., '') turns a NULL date into the '' Unknown bucket.
  return `COALESCE(strftime('${DATE_DIM_FMT[unit]}', ${colExpr} / 1000, 'unixepoch'), '')`;
}

/** Rewrite year/month/day dims to the sort's date COLUMN + direction. A non-date
 *  sort leaves them at the default (taken, DESC). Other dims pass through. */
export function applySortToDims(dims, sort) {
  const isDate = Boolean(GROUP_DATE_COL[sort?.by]);
  const col = isDate ? GROUP_DATE_COL[sort.by] : GROUP_DATE_COL.date_taken;
  const dir = isDate ? sort.dir.toUpperCase() : "DESC";
  return dims.map((d) =>
    ["year", "month", "day"].includes(d.name)
      ? { ...d, expr: dateDimExpr(d.name, col), direction: dir }
      : d
  );
}
