/**
 * Pure fisheye / degree-of-interest layout for the sidebar navigator — no DOM,
 * no Svelte. Same "pure logic module + thin Svelte view" split as
 * justified.js / windowing.js / feed.js / navigation.js.
 *
 * Inspired by John's PhotoRing `navigationList.js` (d3 v3): a near zone with
 * uniform, readable spacing; a far zone compressed by a fisheye falloff;
 * count-weighted bars (a histogram silhouette); count-aggregating sampling so
 * huge lists stay cheap without dropping photos from the silhouette; and a
 * distinction between where you ARE (currentI) and where you POINT (focusI).
 *
 * Reformulated from PhotoRing's absolute-position fisheye scale to a
 * degree-of-interest **weight → cumulative layout**: each kept leaf gets a
 * weight, rows are laid out by normalized cumulative sum. This guarantees the
 * column fills `height` exactly, y is monotonic, and every thickness is > 0.
 */

import { scaleLinear } from "d3";

/** Tuning knobs — John's domain (see ROADMAP "John authors/tunes thresholds").
 * vicinity: half-width (in leaves) of the uniform near zone.
 * falloff: how many leaves it takes the far-zone lens to decay.
 * distortion: >1 sharpens the focus vs. context contrast.
 * checkpointWeight: minimum weight floor so year/month bands never vanish.
 * minRowPx: target min row height → bounds how many rows we sample. */
export const FISHEYE_DEFAULTS = {
  vicinity: 4, // ± leaves force-kept & kept readable around the focus
  distortion: 1.8, // higher = sharper lens peak
  checkpointWeight: 0.4, // floor so year/month bands stay visible
  minRowPx: 14, // target min row height → bounds how many rows we sample
};

/**
 * Smooth fisheye lens weight: 1 at the focus, decaying with distance so row
 * heights form a *visible gradient* (the lens). No flat plateau — the focus is
 * always the single tallest row, and its neighbours step down smoothly.
 * @returns {number} in (0, 1]
 */
export function doiWeight(dist, { vicinity, distortion } = FISHEYE_DEFAULTS) {
  const d = dist / Math.max(1e-6, vicinity);
  return 1 / (1 + distortion * d * d);
}

/**
 * For each leaf, the index of the shallowest grouping dimension (strictly
 * above the finest) whose value changed vs. the previous leaf — i.e. a
 * checkpoint (year/month) boundary. `null` when only the finest dimension
 * changed (an ordinary leaf). Index 0 is always a checkpoint at depth 0.
 * @param {Array<{values: Record<string,string>}>} leaves  ordered
 * @param {string[]} groupBy
 * @returns {Array<number|null>}
 */
export function deriveCheckpointDepth(leaves, groupBy) {
  const finest = groupBy.length - 1;
  const out = new Array(leaves.length).fill(null);
  let prev = null;
  for (let i = 0; i < leaves.length; i++) {
    const v = leaves[i].values;
    if (i === 0) {
      out[i] = 0;
      prev = v;
      continue;
    }
    let changed = null;
    for (let d = 0; d < groupBy.length; d++) {
      if (v[groupBy[d]] !== prev[groupBy[d]]) {
        changed = d;
        break;
      }
    }
    out[i] = changed != null && changed < finest ? changed : null;
    prev = v;
  }
  return out;
}

/**
 * Decimate a long leaf list down to ~maxRows, but ALWAYS keep the near zone
 * around `focusI`, every checkpoint boundary, and the first/last leaf.
 * Skipped leaves' counts are summed into the next kept leaf's `binCount`
 * (PhotoRing's aggregation) so the histogram silhouette loses no photos.
 * @param {Array<{values:Record<string,string>, count:number}>} leaves
 * @param {Array<number|null>} checkpoints  from deriveCheckpointDepth
 * @param {number} focusI
 * @param {{maxRows:number, vicinity:number}} opts
 * @returns {Array<{i:number, values:object, count:number, binCount:number, checkpointDepth:number|null}>}
 */
export function sampleLeaves(leaves, checkpoints, focusI, { maxRows, vicinity }) {
  const n = leaves.length;
  const mod = Math.max(1, Math.ceil(n / maxRows));
  const forced = (i) =>
    Math.abs(i - focusI) <= vicinity ||
    checkpoints[i] != null ||
    i === 0 ||
    i === n - 1;
  const kept = [];
  let bin = 0;
  for (let i = 0; i < n; i++) {
    bin += leaves[i].count;
    if (forced(i) || i % mod === 0) {
      kept.push({
        i,
        values: leaves[i].values,
        count: leaves[i].count,
        binCount: bin,
        checkpointDepth: checkpoints[i],
      });
      bin = 0;
    }
  }
  return kept;
}

/**
 * The full fisheye layout: derive checkpoints, sample, weight, and lay rows
 * out along `height` by normalized cumulative weight.
 * @param {Array<{values:Record<string,string>, count:number}>} leaves ordered
 * @param {string[]} groupBy
 * @param {{height:number, focusI:number} & Partial<typeof FISHEYE_DEFAULTS> & {maxRows?:number}} options
 * @returns {{rows: Array<{i:number, values:object, count:number, binCount:number,
 *   checkpointDepth:number|null, y:number, thickness:number}>, maxBinCount:number}}
 */
export function layoutFisheye(leaves, groupBy, options) {
  const o = { ...FISHEYE_DEFAULTS, ...options };
  const { height, focusI } = o;
  if (!leaves?.length || !height) return { rows: [], maxBinCount: 0 };

  const checkpoints = deriveCheckpointDepth(leaves, groupBy);
  const maxRows = o.maxRows ?? Math.max(8, Math.floor(height / o.minRowPx));
  const kept = sampleLeaves(leaves, checkpoints, focusI, {
    maxRows,
    vicinity: o.vicinity,
  });

  const weights = kept.map((k) => {
    let w = doiWeight(k.i - focusI, o);
    if (k.checkpointDepth != null) w = Math.max(w, o.checkpointWeight);
    return w;
  });
  const sumW = weights.reduce((s, w) => s + w, 0) || 1;

  const rows = [];
  let acc = 0;
  let maxBinCount = 0;
  for (let j = 0; j < kept.length; j++) {
    const thickness = (weights[j] / sumW) * height;
    rows.push({ ...kept[j], y: acc + thickness / 2, thickness });
    acc += thickness;
    if (kept[j].binCount > maxBinCount) maxBinCount = kept[j].binCount;
  }
  return { rows, maxBinCount };
}

/**
 * Bar-length scale for the count histogram: photo mass → pixel length.
 * @param {number} maxBinCount
 * @param {number} maxLenPx
 * @param {number} [minLenPx]
 */
export function makeBarScale(maxBinCount, maxLenPx, minLenPx = 4) {
  return scaleLinear()
    .domain([0, Math.max(1, maxBinCount)])
    .range([minLenPx, maxLenPx])
    .clamp(true);
}
