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
  const last = Math.min(2, slots);
  const first = Math.max(0, Math.ceil((slots - last) * 0.6));
  const mid = slots - last - first;
  const offsets = [];
  for (let i = 0; i < first; i++) offsets.push(i);
  // middle: a CONTIGUOUS cluster (a "fragment" of the middle) centered in the
  // band between the front and last blocks — so the strip reads as
  // "first few … middle cluster … last two" with just two omission gaps,
  // not a sparse filmstrip with a gap between every middle thumbnail.
  if (mid > 0) {
    const bandLo = first; // first free index after the front block
    const bandHi = count - last - 1; // last free index before the last block
    let start = bandLo + Math.floor((bandHi - bandLo + 1 - mid) / 2);
    if (start < bandLo) start = bandLo;
    if (start + mid - 1 > bandHi) start = bandHi - mid + 1;
    for (let i = 0; i < mid; i++) offsets.push(start + i);
  }
  for (let i = count - last; i < count; i++) offsets.push(i);
  // gaps: after any offset whose successor skips ≥2
  const gaps = [];
  for (let i = 0; i < offsets.length - 1; i++)
    if (offsets[i + 1] - offsets[i] > 1) gaps.push(i);
  return { offsets, gaps };
}
