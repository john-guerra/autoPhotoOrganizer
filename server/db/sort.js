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

/**
 * The floor below which a FILE creation date is a sentinel, not a date (#349).
 *
 * macOS answers "this file has no creation date" with **1984-01-24** — the day
 * the Macintosh was introduced — and that is the normal state of anything
 * copied off a phone, a camera card, or a filesystem with no birth time of its
 * own. `stat` reports it as an ordinary date and we store it faithfully, so
 * nothing anywhere is misbehaving; the value itself is a sentinel wearing a
 * date's costume. On John's library it was **1,557 photos (4.6%), every one
 * carrying the identical value**, all sorting into 1984 under "Created".
 *
 * A single floor rather than an equality check on 1984-01-24, for two reasons:
 * the stored value carries the timezone of whatever machine wrote it, so there
 * is no one instant to compare against; and other filesystems have their own
 * sentinels (the unix epoch is the common one) which this catches too.
 *
 * **1990 is about the FILE, not the photograph.** A scan of a 1952 print is an
 * ordinary thing to own and its EXIF may well say 1952 — `taken_at` is
 * untouched by this and always wins. But the JPEG holding that scan cannot
 * have been created before JPEG existed, so no real `btime` is below this.
 */
export const BTIME_FLOOR_MS = Date.UTC(1990, 0, 1);

/** `btime`, or NULL when it is a sentinel — so the COALESCEs below fall
 *  through to `mtime` exactly as they already do for a missing btime. */
const TRUSTED_BTIME = `CASE WHEN photos.btime >= ${BTIME_FLOOR_MS} THEN photos.btime END`;

/** The unconditional fallback, for sorting and filtering: never NULL. */
const FILE_DATE = `COALESCE(${TRUSTED_BTIME}, photos.mtime)`;

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
  // The twin of TRUSTED_BTIME. A sentinel btime falls through to mtime here
  // exactly as it does in SQL — if these two disagree the SQL groups the feed
  // one way and this labels the row that lands in it another.
  const btime = trustedBtime(row.btime);
  return btime ?? row.mtimeMs ?? row.mtime ?? null;
}

/** @param {number|null|undefined} btime @returns {number|null} */
export function trustedBtime(btime) {
  return typeof btime === "number" && btime >= BTIME_FLOOR_MS ? btime : null;
}

/** Sortable attributes → NULL-safe ORDER-BY exprs. Determinism only needs to be
 *  total *with* the id tiebreak the feed appends, so ties are fine. Dates fall
 *  back UNCONDITIONALLY here (no width guard): a NULL sort key would clump every
 *  not-yet-read photo at one end of the feed. */
export const SORT_ATTRS = {
  date_taken: {
    // Same sentinel guard as FILE_DATE — a photo whose EXIF has not been read
    // reaches the file dates here too, so skipping it in only one of the two
    // would fix Created and leave Taken misfiling the same photos.
    expr: `COALESCE(photos.taken_at, ${FILE_DATE})`,
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

// --- Index support ----------------------------------------------------------
//
// Every date-grouped feed page used to be a FULL SCAN of the photos table plus a
// temp B-tree sort — the date dimensions are `strftime(COALESCE(...))`
// expressions, and no plain column index can serve those. Measured on a real
// 114k library: 33ms for the first page, 61ms per loadMore, and 224ms once ~20
// albums were collapsed (each collapsed group adds its own full-scan COUNT). At
// 224ms/page the feed sustains ~270 photos/s — far below a fling, which is
// exactly the reported "the album loading is slower than I can scroll".
//
// SQLite CAN index an expression, and it matches on the resolved expression, so
// an index over these same exprs turns the scan into a seek: 33ms → 0.2ms,
// 224ms → 17ms, tree counts 18ms → 0.4ms.
//
// THE INDEX MUST BE BUILT FROM THE VERY EXPRESSIONS THE QUERIES USE. If the two
// ever drift by a character, SQLite silently stops using the index and the feed
// quietly returns to full scans — no error, no test failure, just a slow app
// again. So the DDL is GENERATED here from SORT_ATTRS/GROUP_DATE_COL rather than
// hand-written, and the index name carries a fingerprint of its own definition
// (see indexNameFor): change an expression and the old index no longer matches
// its name, so applySchema drops it and builds the new one. Drift becomes a
// rebuild instead of a silent regression.

/** CREATE INDEX cannot use qualified names — "photos.taken_at" is a syntax error
 *  inside an index expression, though the QUERY may (and does) qualify them;
 *  SQLite compares resolved expressions, so the two still match. */
const unqualify = (expr) => expr.replace(/\bphotos\./g, "");

/** Cheap, stable fingerprint of a definition (djb2). Not security, just drift
 *  detection — it only has to change when the expression does. */
function fingerprint(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Index columns for one date sort: the three group dims (outermost first, the
 *  order the feed's ORDER BY uses), then the photo-level sort key, then id — the
 *  seek tuple's tiebreak. A prefix of this serves groupBy [year], [year,month],
 *  [year,month,day] and the bare sort alike. */
function indexExprsFor(attr) {
  const col = GROUP_DATE_COL[attr];
  return [
    dateDimExpr("year", col),
    dateDimExpr("month", col),
    dateDimExpr("day", col),
    SORT_ATTRS[attr].expr,
    "photos.id",
  ].map(unqualify);
}

/**
 * The feed's expression indexes, one per date sort — DDL and name, generated.
 *
 * Partial on `stale = 0` because every feed query carries that predicate: it
 * keeps the index smaller and lets soft-deleted rows fall out of it entirely.
 * @returns {Array<{name: string, sql: string}>}
 */
export function feedIndexes() {
  return DATE_SORTS.map((attr) => {
    const exprs = indexExprsFor(attr);
    const body = `ON photos (\n  ${exprs.join(",\n  ")}\n) WHERE stale = 0`;
    const name = `idx_photos_feed_${attr}_${fingerprint(body)}`;
    return { name, sql: `CREATE INDEX IF NOT EXISTS ${name} ${body}` };
  });
}

/** Prefix every generated feed index shares, so applySchema can find (and drop)
 *  the ones left behind by an older expression. */
export const FEED_INDEX_PREFIX = "idx_photos_feed_";
