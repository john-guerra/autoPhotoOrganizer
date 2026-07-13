/**
 * Feed sort semantics — the single home for "what can we sort by" and how a
 * date sort drives the date group dimensions. Pure (no DB handle), so it is
 * unit-testable and importable by feed.js / tree.js / api.js alike.
 *
 * WHEN WAS THIS TAKEN? EXIF is the answer when it has one, and for plenty of
 * files it doesn't: screenshots, downloads, exports, scans, stripped images.
 * Those used to group into a single "Unknown" bucket — where an undated photo
 * went to be forgotten. They now fall back to the file's own creation date
 * (`btime`), which is very often the real capture date (see TAKEN_AT_EXPR).
 *
 * Two intentionally-different date treatments — they look redundant; they are
 * not, and collapsing them into one breaks something either way:
 *
 *  - SORTING and FILTERING (SORT_ATTRS, dateAttrExpr) need a date for EVERY
 *    photo, always: a NULL sort key clumps every un-dated photo at one end of
 *    the feed, and the timeline can't plot a NULL. So they fall back
 *    unconditionally.
 *  - GROUPING and DISPLAY (TAKEN_AT_EXPR) must NOT guess for a photo whose EXIF
 *    hasn't been read yet, or it would file it under a made-up date and then
 *    move it once the real one arrives. So they fall back only after extraction
 *    has been attempted, and leave the rest in Unknown until it has.
 */

/** The unconditional fallback, for sorting and filtering: never NULL. */
const FILE_DATE = "COALESCE(photos.btime, photos.mtime)";

/**
 * The taken date for GROUPING and DISPLAY: EXIF, else — once we have actually
 * looked for EXIF and found none — the file's own creation date.
 *
 * `btime` is a best guess, not a fact: copying a file often resets it to the
 * copy time, so a whole card can end up "created" the day it was imported. It is
 * still far better than Unknown, and mtime (the previous fallback) is no more
 * trustworthy. mtime remains the last resort, for filesystems with no birth time.
 *
 * THE GUARD MATTERS AS MUCH AS THE FALLBACK. Metadata extraction is LAZY (see
 * /api/meta): `taken_at IS NULL` usually means "nobody has read this file's EXIF
 * yet", NOT "this file has no EXIF date" — on a real 114k library, 97k photos
 * were merely un-read and only ~900 were genuinely dateless. Dating an un-read
 * photo by its file time would file it under a made-up date, and then, the
 * moment it scrolled into view and enrichment found its real EXIF date, it would
 * JUMP to another group — the feed reshuffling as you browse it. So the fallback
 * only fires once extraction has been ATTEMPTED: `width IS NOT NULL`, the
 * sentinel /api/meta already uses (0 = tried but dimensionless, e.g. RAW; only
 * NULL means never tried). An un-read photo stays in Unknown until it is read.
 *
 * `effectiveTakenAtMs` is the JS twin of this SQL. THEY MUST STAY IN LOCKSTEP —
 * the SQL groups the feed, the JS labels the row that lands in it.
 */
export const TAKEN_AT_EXPR = `COALESCE(photos.taken_at,
    CASE WHEN photos.width IS NOT NULL THEN ${FILE_DATE} END)`;

/**
 * @param {{taken_at?:number|null, btime?:number|null, mtimeMs?:number|null, mtime?:number|null, width?:number|null}} row
 * @returns {number|null} epoch ms
 */
export function effectiveTakenAtMs(row) {
  if (row?.taken_at != null) return row.taken_at;
  if (row?.width == null) return null; // EXIF not read yet — don't guess
  return row.btime ?? row.mtimeMs ?? row.mtime ?? null;
}

/** Sortable attributes → NULL-safe ORDER-BY exprs. Determinism only needs to be
 *  total *with* the id tiebreak the feed appends, so ties are fine. Dates fall
 *  back UNCONDITIONALLY here (no width guard): a NULL sort key would clump every
 *  not-yet-read photo at one end of the feed. */
export const SORT_ATTRS = {
  date_taken: {
    expr: "COALESCE(photos.taken_at, photos.btime, photos.mtime)",
  },
  date_created: { expr: FILE_DATE },
  date_modified: { expr: "photos.mtime" },
  rating: { expr: "photos.rating" },
  size: { expr: "photos.size" },
  name: { expr: "photos.filename COLLATE NOCASE" },
};

/** Date exprs per date sort, for GROUP-dimension exprs. Guarded (TAKEN_AT_EXPR),
 *  so a photo whose EXIF has not been read yet keeps landing in the '' Unknown
 *  bucket rather than being filed under a guess it would later leave. */
const GROUP_DATE_COL = {
  date_taken: TAKEN_AT_EXPR,
  date_created: FILE_DATE,
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

const DEFAULT_SORT = { by: "date_taken", dir: "asc" };

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
