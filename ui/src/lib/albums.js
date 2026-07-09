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

/**
 * @param {number[]} times ascending photo timestamps (ms)
 * @returns {{mean:number, stdev:number, count:number, minGap:number, maxGap:number}}
 */
export function computeGapStats(times) {
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  const n = gaps.length;
  if (!n) return { mean: 0, stdev: 0, count: times.length, minGap: 0, maxGap: 0 };
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
      cur = { index: albums.length, startAt: photos[i].t, endAt: photos[i].t, ids: [photos[i].id] };
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
