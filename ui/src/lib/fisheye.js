/**
 * Pure fisheye / focus+context layout for the sidebar navigator — no DOM, no
 * Svelte. Same "pure logic module + thin Svelte view" split as
 * justified.js / windowing.js / feed.js / navigation.js.
 *
 * Ports PhotoRing `navigationList.js`'s `d3_fisheye_scale` (d3 v3 → pure JS):
 * a fisheye scale maps each leaf's linear position to a distorted position that
 * magnifies around a *focus pixel* and compresses far from it, while still
 * filling the whole column. Pinning the focus pixel to the cursor keeps the
 * magnified row exactly under the pointer — smooth hover magnification AND
 * reliable clicks (the target never slides away). Plus: count-aggregating
 * sampling so huge lists stay cheap without dropping photos from the
 * silhouette, and outer-level checkpoints (year/month) for long jumps.
 */

import { scaleLinear } from "d3";

/** Tuning knobs — John's domain (see ROADMAP "John authors/tunes thresholds").
 * vicinity: ± leaves force-kept & readable around the focus.
 * distortion: fisheye strength `d` — higher = stronger magnification at the
 *   focus and harder compression far away.
 * pad: top/bottom inset in px.
 * minRowPx: target min row height → bounds how many rows we sample. */
export const FISHEYE_DEFAULTS = {
  vicinity: 4,
  distortion: 4,
  pad: 6,
  minRowPx: 14,
  positioning: "rank",
};

/** The positioning modes the lens can magnify over (see `layoutFisheye`). */
export const POSITIONING_MODES = ["rank", "proportional"];

/**
 * PhotoRing's fisheye position function (ported from `d3_fisheye_scale`). Maps
 * a base linear position `x` (within `[min,max]`) to a distorted position that
 * magnifies around focus pixel `a` and compresses away from it. Monotonic in
 * `x`; `x === a → a`; the endpoints map to the endpoints. Larger `d` = gentler
 * (less) distortion, smaller `d` = sharper lens.
 * @returns {number}
 */
export function fisheyePosition(x, a, min, max, d) {
  const left = x < a;
  let m = left ? a - min : max - a;
  if (m === 0) m = max - min;
  const dx = Math.abs(x - a);
  if (dx < 1e-9) return a;
  return ((left ? -1 : 1) * (m * (d + 1))) / (d + m / dx) + a;
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
export function sampleLeaves(
  leaves,
  checkpoints,
  focusI,
  { maxRows, vicinity }
) {
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

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Index within `kept` of the row whose leaf index is closest to `focusI`.
 * `focusI` is force-kept by the vicinity, so this is usually an exact hit; the
 * nearest-search just makes edge/empty-vicinity cases safe. */
function keptRankOf(kept, focusI) {
  let best = 0;
  let bestD = Infinity;
  for (let j = 0; j < kept.length; j++) {
    const d = Math.abs(kept[j].i - focusI);
    if (d < bestD) {
      bestD = d;
      best = j;
    }
  }
  return best;
}

/**
 * The full fisheye layout. The focus is either a pinned pixel (`focusPx`, e.g.
 * the cursor while hovering) or the natural position of `focusI` (the current
 * feed position). Rows are positioned by the fisheye scale and tile the column
 * (each row's thickness is the gap to the next kept row).
 * @param {Array<{values:Record<string,string>, count:number}>} leaves ordered
 * @param {string[]} groupBy
 * @param {{height:number, focusI?:number, focusPx?:number} & Partial<typeof FISHEYE_DEFAULTS> & {maxRows?:number}} options
 * @returns {{rows: Array<{i:number, values:object, count:number, binCount:number,
 *   checkpointDepth:number|null, y:number, thickness:number}>, maxBinCount:number, focusI:number}}
 */
export function layoutFisheye(leaves, groupBy, options) {
  const o = { ...FISHEYE_DEFAULTS, ...options };
  const { height } = o;
  if (!leaves?.length || !height)
    return { rows: [], maxBinCount: 0, focusI: 0 };

  const n = leaves.length;
  const min = o.pad;
  const max = height - o.pad;
  // Domain [0, n] (not n-1): leaf i owns the CELL [base(i), base(i+1)], so the
  // last leaf gets a real cell instead of collapsing onto the bottom edge.
  const base = scaleLinear().domain([0, n]).range([min, max]);

  // Focus pixel: pinned to the cursor (focusPx) or the natural spot of focusI.
  // When pinned, the focused leaf is whichever one sits under that pixel.
  const a =
    o.focusPx != null ? clamp(o.focusPx, min, max) : base(o.focusI ?? 0);
  const focusI =
    o.focusPx != null
      ? clamp(Math.round(base.invert(a)), 0, n - 1)
      : clamp(o.focusI ?? 0, 0, n - 1);

  const checkpoints = deriveCheckpointDepth(leaves, groupBy);
  const maxRows = o.maxRows ?? Math.max(8, Math.floor(height / o.minRowPx));
  const kept = sampleLeaves(leaves, checkpoints, focusI, {
    maxRows,
    vicinity: o.vicinity,
  });

  // How the lens magnifies over the kept rows:
  //  - "rank" (default): magnify over the KEPT-ROW SEQUENCE. Every surviving row
  //    gets equal base spacing, so the dense ±vicinity around the focus lands
  //    real, readable pixels — the point of a focus+context navigator. Vertical
  //    position no longer encodes true folder-count density (the count bars still
  //    carry photo mass; checkpoints still anchor structure).
  //  - "proportional": magnify over the raw leaf index. Rows sit at their true
  //    fractional position in the list, but on a heavily decimated list the
  //    consecutive vicinity leaves share a sub-pixel span and collapse into an
  //    unreadable sliver band under the cursor. Kept for comparison/tuning.
  let pos;
  if (o.positioning === "proportional") {
    pos = (j) => fisheyePosition(base(kept[j].i), a, min, max, o.distortion);
  } else {
    const K = kept.length;
    const baseKept = scaleLinear().domain([0, K]).range([min, max]);
    // Focus in kept-rank space: the cursor pixel when hovering (so the magnified
    // row still pins to the pointer), else the rank of the current feed leaf.
    const aRank =
      o.focusPx != null
        ? clamp(o.focusPx, min, max)
        : baseKept(keptRankOf(kept, focusI));
    pos = (j) => fisheyePosition(baseKept(j), aRank, min, max, o.distortion);
  }

  const rows = [];
  let maxBinCount = 0;
  for (let j = 0; j < kept.length; j++) {
    const top = pos(j);
    const nextTop = j + 1 < kept.length ? pos(j + 1) : max;
    const thickness = Math.max(1, nextTop - top);
    rows.push({ ...kept[j], y: top + thickness / 2, thickness });
    if (kept[j].binCount > maxBinCount) maxBinCount = kept[j].binCount;
  }
  return { rows, maxBinCount, focusI };
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
