/**
 * Time-gap album clustering — pure, DOM-free, ported from the legacy
 * autoAlbums.js. Photos taken close together belong to one album; a gap larger
 * than a threshold starts a new one. The default threshold is mean + k·stddev
 * of the inter-photo gaps (k defaults to 2, as in the legacy tool), so it
 * adapts to each set: a lazy day of occasional shots and a rapid-fire event
 * both split at *their* unusually-large gaps, not a fixed wall-clock number.
 *
 * Runs client-side so the tuning slider re-clusters instantly with no round
 * trip — the server only ever copies the id-groups this produces (materialize).
 */

import * as d3 from "d3";

/**
 * @param {number[]} times ascending photo timestamps (ms)
 * @returns {{mean:number, stdev:number, count:number, minGap:number, maxGap:number}}
 */
export function computeGapStats(times) {
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  const n = gaps.length;
  if (!n)
    return { mean: 0, stdev: 0, count: times.length, minGap: 0, maxGap: 0 };
  const mean = gaps.reduce((a, b) => a + b, 0) / n;
  const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return {
    mean,
    stdev: Math.sqrt(variance),
    count: times.length,
    minGap: Math.min(...gaps),
    maxGap: Math.max(...gaps),
  };
}

/** The legacy auto threshold: mean + k·stddev of the gaps. @returns {number} ms */
export function autoThresholdMs(stats, k = 2) {
  return stats.mean + k * stats.stdev;
}

/**
 * Split time-ordered photos into albums wherever the gap to the next photo
 * exceeds `thresholdMs`.
 * @param {Array<{id:number, t:number}>} photos ascending by `t` (ms)
 * @param {number} thresholdMs
 * @returns {Array<{index:number, startAt:number, endAt:number, ids:number[]}>}
 */
export function clusterByGap(photos, thresholdMs) {
  if (!photos.length) return [];
  const albums = [];
  let cur = {
    index: 0,
    startAt: photos[0].t,
    endAt: photos[0].t,
    ids: [photos[0].id],
  };
  for (let i = 1; i < photos.length; i++) {
    const gap = photos[i].t - photos[i - 1].t;
    if (gap > thresholdMs) {
      cur.endAt = photos[i - 1].t;
      albums.push(cur);
      cur = {
        index: albums.length,
        startAt: photos[i].t,
        endAt: photos[i].t,
        ids: [photos[i].id],
      };
    } else {
      cur.ids.push(photos[i].id);
    }
  }
  cur.endAt = photos[photos.length - 1].t;
  albums.push(cur);
  return albums;
}

/** Default folder-safe album name from its start time: `YYYY-MM-DD`. Ties are
 * disambiguated by the caller (materialize) with a numeric suffix if needed. */
export function defaultAlbumName(startAtMs) {
  const d = new Date(startAtMs);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Render an album folder name from a strftime-style template. Date tokens are
 * delegated to d3.timeFormat; `%n` is the 1-based album index. The result MAY
 * contain "/" to create nested folders (e.g. a year subfolder). Leading "/" and
 * any ".." path segments are stripped so the name is always a safe relative
 * path (the server's safeResolve also blocks traversal, but we keep it clean).
 * An empty render falls back to `Album {n}`.
 * @param {string} template e.g. "%Y/%Y_%m%b_%d"
 * @param {Date} date album start date
 * @param {number} n 1-based album index
 * @returns {string}
 */
export function renderAlbumName(template, date, n) {
  // %n isn't a d3 token — substitute it first (escape any literal % the user
  // typed as %% so d3 doesn't choke), then run d3.timeFormat for the rest.
  const withIndex = String(template ?? "").replace(/%n/g, String(n));
  let rendered = "";
  try {
    rendered = d3.timeFormat(withIndex)(date);
  } catch {
    rendered = withIndex; // unparseable template: use it literally
  }
  const safe = rendered
    .split("/")
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0 && seg !== "..")
    .join("/");
  return safe.length ? safe : `Album ${n}`;
}

/**
 * Display name for each album, keeping a user-typed name alive across
 * re-clustering as long as the album still starts with the same first photo.
 * @param {Array<{startAt:number, ids:number[]}>} albums
 * @param {Map<number,string>} editedNames keyed by first-photo id
 * @param {string} template strftime template for un-edited albums
 * @returns {string[]}
 */
export function computeAlbumNames(albums, editedNames, template) {
  return albums.map((a, i) => {
    const firstId = a.ids[0];
    const typed = editedNames.get(firstId);
    return typed != null && typed !== ""
      ? typed
      : renderAlbumName(template, new Date(a.startAt), i + 1);
  });
}
