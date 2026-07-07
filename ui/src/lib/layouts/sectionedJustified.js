import { justifiedLayout, layoutHeight } from "./justified.js";

/**
 * Wraps justifiedLayout to reserve full-width header bands at section
 * boundaries and restart each section on a fresh row, so a header never
 * splits a row of photos across two sections. Also computes each header's
 * vertical extent (y..endY) so the caller can render a per-section wrapper
 * bounding a sticky header — true "sticky within this section only"
 * behavior requires a bounded ancestor; a flat position:sticky sibling of
 * absolutely-positioned photo boxes has no such bound on its own.
 *
 * @param {Array<{id: number|string, aspectRatio: number}>} items
 * @param {Array<{index: number, depth: number, dimension: string, value: string, label: string}>} headers
 *   from deriveSectionHeaders, indices into `items`, ascending order.
 * @param {{ targetRowHeight?: number, containerWidth: number, gap?: number, headerHeight?: number }} opts
 * @returns {{
 *   boxes: Array<{id: number|string, x: number, y: number, width: number, height: number}>,
 *   headers: Array<{index: number, depth: number, dimension: string, value: string, label: string, y: number, endY: number}>,
 *   totalHeight: number
 * }}
 */
export function sectionedJustifiedLayout(
  items,
  headers,
  { targetRowHeight = 220, containerWidth, gap = 8, headerHeight = 32 }
) {
  const headersByIndex = new Map();
  for (const h of headers) {
    if (!headersByIndex.has(h.index)) headersByIndex.set(h.index, []);
    headersByIndex.get(h.index).push(h);
  }

  const boxes = [];
  const openHeaders = []; // stack of headers currently "in scope", ordered by depth
  const closedHeaders = [];
  let yOffset = 0;
  let chunkStart = 0;

  function flushChunk(end) {
    if (end <= chunkStart) return;
    const chunkBoxes = justifiedLayout(items.slice(chunkStart, end), {
      targetRowHeight,
      containerWidth,
      gap,
    });
    for (const b of chunkBoxes) boxes.push({ ...b, y: b.y + yOffset });
    yOffset += layoutHeight(chunkBoxes) + (chunkBoxes.length ? gap : 0);
    chunkStart = end;
  }

  // A header at depth D closes every currently-open header at depth >= D —
  // an outer boundary (smaller depth) always ends every inner section
  // nested under it; a new header at the SAME depth as an open one replaces
  // it (a sibling section, not a child).
  function closeAtOrBelow(depth, endY) {
    while (
      openHeaders.length &&
      openHeaders[openHeaders.length - 1].depth >= depth
    ) {
      closedHeaders.push({ ...openHeaders.pop(), endY });
    }
  }

  for (let i = 0; i < items.length; i++) {
    const hs = headersByIndex.get(i);
    if (hs) {
      flushChunk(i);
      for (const h of hs) {
        closeAtOrBelow(h.depth, yOffset);
        openHeaders.push({ ...h, y: yOffset });
        yOffset += headerHeight;
      }
    }
  }
  flushChunk(items.length);
  closeAtOrBelow(0, yOffset);

  closedHeaders.sort((a, b) => a.index - b.index || a.depth - b.depth);
  return { boxes, headers: closedHeaders, totalHeight: yOffset };
}
