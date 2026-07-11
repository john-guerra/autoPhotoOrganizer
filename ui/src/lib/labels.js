/**
 * Pure label-shortening logic: no DOM, no Svelte, no fetch. Same shape as
 * feed.js — UI components (e.g. TreeNode.svelte) compose this to show only
 * the differentiating part of a group value instead of a full duplicated
 * string (e.g. an absolute folder path repeated across many sibling rows).
 */

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** @param {string} path @returns {string[]} */
function pathSegments(path) {
  return path.split("/").filter((s) => s.length > 0);
}

/** @param {string} monthNum "01".."12" @returns {string|null} */
function monthName(monthNum) {
  const idx = Number(monthNum) - 1;
  return MONTH_NAMES[idx] ?? null;
}

/**
 * The compact, differentiating label for a group value at `dimension`.
 * `prevValue` (optional) is the previous leaf's raw value in a flat ordered
 * list; when given, coarser date context is added only where it changed.
 * @param {string} dimension  one of "folder" | "year" | "month" | "day"
 * @param {string} value      raw group value (folder abs_path, "YYYY", "YYYY-MM", "YYYY-MM-DD")
 * @param {string} [prevValue]
 * @returns {string}
 */
export function shortLeafLabel(dimension, value, prevValue) {
  if (value === "") return "Unknown";

  if (dimension === "folder") {
    const segs = pathSegments(value);
    if (segs.length === 0) return value;
    const basename = segs[segs.length - 1];
    if (prevValue !== undefined) {
      const prevSegs = pathSegments(prevValue);
      const prevBasename = prevSegs[prevSegs.length - 1];
      if (prevBasename === basename && segs.length >= 2) {
        return segs.slice(-2).join("/");
      }
    }
    return basename;
  }

  if (dimension === "year") {
    return value;
  }

  if (dimension === "month") {
    // month-of-year: the value is now a bare "01".."12" (all years aggregated).
    const bare = /^(\d{2})$/.exec(value);
    if (bare) return monthName(bare[1]) ?? value;
    // Legacy "YYYY-MM" fallback (kept in case any cached value slips through).
    const m = MONTH_RE.exec(value);
    if (!m) return value;
    const [, year, monthNum] = m;
    const name = monthName(monthNum);
    if (name === null) return value;
    const prevYear =
      prevValue !== undefined ? prevValue.slice(0, 4) : undefined;
    if (prevValue === undefined || prevYear !== year) {
      return `${year} ${name}`;
    }
    return name;
  }

  if (dimension === "day") {
    const m = DAY_RE.exec(value);
    if (!m) return value;
    const [, year, monthNum, day] = m;
    const name = monthName(monthNum);
    if (name === null) return value;
    const dayNum = String(Number(day));
    if (prevValue === undefined) {
      return dayNum;
    }
    const prevYear = prevValue.slice(0, 4);
    const prevMonth = prevValue.slice(0, 7);
    if (prevYear !== year) {
      return `${year} ${name} ${dayNum}`;
    }
    if (prevMonth !== value.slice(0, 7)) {
      return `${name} ${dayNum}`;
    }
    return dayNum;
  }

  return value;
}
