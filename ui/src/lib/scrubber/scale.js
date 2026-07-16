/**
 * Pure math for the feed scrubber. No DOM, no Svelte. Turns the /api/tree/flat
 * response into coarse landmarks + cumulative counts and maps between cumulative
 * count (or sort value) and rail pixels. See
 * docs/superpowers/specs/2026-07-16-feed-scrubber-and-skeleton-design.md.
 */

/**
 * @param {{ total:number, leaves:Array<{values:Record<string,string>,count:number}> }} flat
 * @param {{ groupBy: string[] }} opts  ordered grouping dims (coarsest first)
 * @returns {{ total:number, landmarks:Array<{key:string,label:string,value:string,startCount:number,count:number,path:Array<{dimension:string,value:string}>}>, cumStart:number[] }}
 */
export function buildManifest(flat, { groupBy }) {
  const coarse = groupBy?.[0];
  const leaves = flat.leaves ?? [];
  const cumStart = [0];
  for (let i = 0; i < leaves.length; i++)
    cumStart.push(cumStart[i] + leaves[i].count);

  const landmarks = [];
  let running = 0;
  let current = null;
  for (const leaf of leaves) {
    const value = coarse ? (leaf.values[coarse] ?? "") : "";
    if (!current || current.value !== value) {
      current = {
        key: value,
        label: value,
        value,
        startCount: running,
        count: 0,
        path: coarse ? [{ dimension: coarse, value }] : [],
      };
      landmarks.push(current);
    }
    current.count += leaf.count;
    running += leaf.count;
  }
  return {
    total: flat.total ?? running,
    landmarks,
    cumStart,
    labelStops: labelStopsFor(landmarks, coarse),
  };
}

/** Last non-empty path segment. */
function basename(path) {
  const parts = String(path).split("/").filter(Boolean);
  return parts[parts.length - 1] || String(path);
}

/** Leading token of a name: everything before the first _ , - or space. */
export function leadingToken(name) {
  const m = String(name).match(/^[^_\s-]+/);
  return m ? m[0] : String(name);
}

/**
 * Which landmarks get a TEXT label on the rail. Folder grouping produces one
 * landmark per (leaf) folder — hundreds of them — so instead of a wall of names
 * we label only where the basename's leading token changes: for `2010_03Mar_…`
 * folders that collapses to clean year labels; for other names it's whatever
 * prefix they share, and unique names just each get their own stop (no worse than
 * before). Other groupings (year, camera…) are already coarse — every landmark
 * is a stop. The fine per-folder `landmarks` still drive density/scrub/hover.
 */
export function labelStopsFor(landmarks, coarse) {
  if (coarse !== "folder" && coarse !== "folderName") return landmarks;
  const stops = [];
  let lastTok = null;
  for (const lm of landmarks) {
    const tok = leadingToken(basename(lm.value));
    if (tok !== lastTok) {
      stops.push({ ...lm, token: tok });
      lastTok = tok;
    }
  }
  return stops;
}

/** Cumulative count → rail pixel y. */
export function countToY(n, total, railH) {
  if (!(total > 0)) return 0;
  return (n / total) * railH;
}

/** Rail pixel y → cumulative count. */
export function yToCount(y, total, railH) {
  if (!(total > 0) || !(railH > 0)) return 0;
  return (y / railH) * total;
}

/** The landmark whose [startCount, startCount+count) contains n (clamped to last). */
export function landmarkAtCount(manifest, n) {
  const ls = manifest.landmarks;
  if (!ls.length) return null;
  for (let i = ls.length - 1; i >= 0; i--)
    if (n >= ls[i].startCount) return ls[i];
  return ls[0];
}

/**
 * A position scale for the rail. `axis` is "count" (cumulative count) or "value"
 * (sort value, linear between min/max). Value axis falls back to count when
 * `valueOf` is non-finite for any landmark (categorical/folder — no metric).
 *
 * @param {"count"|"value"} axis
 * @param {ReturnType<typeof buildManifest>} manifest
 * @param {number} railH
 * @param {{ valueOf?: (l:any)=>number }} [opts]
 * @returns {{ toY:(l:any)=>number, fromY:(y:number)=>number }}
 */
export function axisScale(axis, manifest, railH, { valueOf } = {}) {
  const total = manifest.total;
  const countScale = {
    toY: (l) => countToY(l.startCount, total, railH),
    fromY: (y) => yToCount(y, total, railH),
  };
  if (axis !== "value" || !valueOf) return countScale;

  const vals = manifest.landmarks.map((l) => valueOf(l));
  if (!vals.every((v) => Number.isFinite(v))) return countScale;

  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  return {
    toY: (l) => ((valueOf(l) - min) / span) * railH,
    fromY: (y) => min + (y / railH) * span,
  };
}

/** Greedy label thinning: keep the first, drop any whose y is within minGapPx. */
export function thinLabels(landmarks, railH, minGapPx, toY) {
  const kept = [];
  let lastY = -Infinity;
  for (const l of landmarks) {
    const y = toY(l);
    if (y - lastY >= minGapPx) {
      kept.push(l);
      lastY = y;
    }
  }
  return kept;
}

/**
 * Bin ascending epoch-ms `times` into `bins` equal-width buckets over [min,max].
 * Powers the date "scent" on the value axis (the same whole-library timestamps
 * the top timeline samples). Out-of-range values clamp to the edge buckets.
 * @returns {number[]} per-bucket counts (length `bins`)
 */
export function densityBins(times, min, max, bins) {
  const out = new Array(Math.max(0, bins)).fill(0);
  if (!times?.length || !(max > min) || bins < 1) return out;
  const span = max - min;
  for (const t of times) {
    let i = Math.floor(((t - min) / span) * bins);
    if (i < 0) i = 0;
    if (i >= bins) i = bins - 1;
    out[i]++;
  }
  return out;
}

const MONTHS = [
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

/**
 * Display label for a landmark, by its coarsest dimension.
 * @param {any} landmark
 * @param {{ groupBy: string[] }} ctx
 */
export function landmarkLabel(landmark, { groupBy }) {
  const dim = groupBy?.[0];
  const v = landmark.value;
  if (dim === "folder" || dim === "folderName") {
    const parts = String(v).split("/").filter(Boolean);
    return parts[parts.length - 1] || v;
  }
  if (dim === "month") {
    const idx = Number(v) - 1;
    return MONTHS[idx] ?? v;
  }
  return String(v); // year, camera, kind, day
}
