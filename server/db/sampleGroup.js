/**
 * Pure sampling math for the fisheye snapshot strip: which indices of a
 * (possibly huge) ordered group to show — first few + a middle fragment +
 * the last two — so a strip can stand in for the whole group without
 * rendering (or fetching) every row.
 *
 * Kept in sync manually with its client-side twin, `ui/src/lib/snapshot.js`
 * (no shared server/client module — same pattern as the MONTH_NAMES twin
 * between server/db/tree.js and ui/src/lib/feed.js).
 *
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
