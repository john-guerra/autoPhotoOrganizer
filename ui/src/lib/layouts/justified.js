/**
 * Justified layout (Flickr-style) as a PURE function.
 *
 * Layouts are renderer-agnostic pure functions: aspect ratios in, positioned
 * boxes out. Future layout algorithms (treemap, timeline, embedding scatter)
 * and future renderers (WebGL canvas for archive-scale zooming) plug into this
 * same contract without touching components. No Svelte, no DOM.
 *
 * Algorithm: greedily fill a row with photos at the target height until the
 * row's natural width reaches the container width, then scale the whole row so
 * it fills the container exactly — every photo keeps its aspect ratio, photos
 * in a row share one height, and a portrait is proportionally narrower than a
 * landscape beside it. The last row is left-aligned at the target height
 * rather than stretched.
 *
 * @param {Array<{id: number|string, aspectRatio: number}>} items
 * @param {{ targetRowHeight?: number, containerWidth: number, gap?: number }} opts
 * @returns {Array<{id: number|string, x: number, y: number, width: number, height: number}>}
 */
export function justifiedLayout(
  items,
  { targetRowHeight = 220, containerWidth, gap = 8 }
) {
  const boxes = [];
  let row = []; // items accumulating for the current row
  let rowNaturalWidth = 0; // sum of widths at targetRowHeight, excluding gaps
  let y = 0;

  const flushRow = (justify) => {
    if (!row.length) return;
    const gaps = gap * (row.length - 1);
    const scale = justify
      ? (containerWidth - gaps) / rowNaturalWidth
      : Math.min(1, (containerWidth - gaps) / rowNaturalWidth);
    const height = targetRowHeight * scale;
    let x = 0;
    for (const it of row) {
      const width = it.aspectRatio * height;
      boxes.push({ id: it.id, x, y, width, height });
      x += width + gap;
    }
    y += height + gap;
    row = [];
    rowNaturalWidth = 0;
  };

  for (const it of items) {
    const ar =
      Number.isFinite(it.aspectRatio) && it.aspectRatio > 0
        ? it.aspectRatio
        : 1.5;
    row.push({ id: it.id, aspectRatio: ar });
    rowNaturalWidth += ar * targetRowHeight;
    const gaps = gap * (row.length - 1);
    if (rowNaturalWidth + gaps >= containerWidth) flushRow(true);
  }
  flushRow(false); // last, partial row: left-aligned, never stretched

  return boxes;
}

/**
 * Total content height of a layout produced by justifiedLayout.
 * @param {ReturnType<typeof justifiedLayout>} boxes
 * @returns {number}
 */
export function layoutHeight(boxes) {
  const last = boxes[boxes.length - 1];
  return last ? last.y + last.height : 0;
}
