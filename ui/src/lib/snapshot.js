/**
 * Client-side counterpart to `server/db/sampleGroup.js`. `sampleOffsets` is a
 * deliberate verbatim twin — kept in sync manually (no shared server/client
 * module — same pattern as the MONTH_NAMES twin between server/db/tree.js
 * and ui/src/lib/feed.js). `slotCount` is client-only: it turns a strip's
 * measured pixel width into how many thumbnail slots fit.
 */

/**
 * @param {number} count total rows in the group
 * @param {number} slots how many thumbnails the strip has room for
 * @returns {{offsets: number[], gaps: number[]}} `offsets` are strictly
 *   increasing indices into `[0, count)`. `gaps` are indices *within
 *   `offsets`* after which a real omission occurs (render a "…" there).
 */
export function sampleOffsets(count, slots) {
  if (count <= 0 || slots <= 0) return { offsets: [], gaps: [] };
  if (count <= slots)
    return { offsets: Array.from({ length: count }, (_, i) => i), gaps: [] };
  if (slots === 1) return { offsets: [0], gaps: [] };
  // Evenly distributed across the WHOLE album — a representative spread, not a
  // contiguous run. First (0) and last (count-1) are always included; interior
  // picks land at equal strides (100 photos into 10 slots ≈ every ~11th), so
  // the strip samples the album rather than showing a sequential slice. A "…"
  // gap marks every place photos were skipped between two shown thumbnails.
  const offsets = [];
  for (let k = 0; k < slots; k++) {
    const idx = Math.round((k * (count - 1)) / (slots - 1));
    if (offsets.length === 0 || idx > offsets[offsets.length - 1]) {
      offsets.push(idx);
    }
  }
  const gaps = [];
  for (let i = 0; i < offsets.length - 1; i++)
    if (offsets[i + 1] - offsets[i] > 1) gaps.push(i);
  return { offsets, gaps };
}

/**
 * How many thumbnail slots fit in a measured strip width.
 * @param {number} widthPx
 * @param {number} thumbPx
 * @param {number} gapPx
 * @returns {number} at least 1
 */
export function slotCount(widthPx, thumbPx, gapPx) {
  return Math.max(1, Math.floor((widthPx + gapPx) / (thumbPx + gapPx)));
}
