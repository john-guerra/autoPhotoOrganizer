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
 * An item marked `{ id, placeholder: true }` instead of carrying an
 * `aspectRatio` (a collapsed section's folded row — see
 * ui/src/lib/displayEntries.js's "placeholder" entry kind) also forces a
 * row-break on both sides and reserves its own full-width band, sized by
 * `placeholderHeight` — it never participates in the photo-packing rows.
 * A placeholder may carry its own `height` (e.g. a taller snapshot-strip
 * row); when present it overrides `placeholderHeight` for that one band.
 * Every original index still contributes exactly one entry to `boxes`
 * (either a real photo box or a placeholder box), so `boxes` stays
 * index-aligned 1:1 with the input `items` array — callers can keep using
 * a positional `boxes[i]` lookup rather than needing a separate id-keyed
 * map.
 *
 * @param {Array<{id: number|string, aspectRatio: number} | {id: number|string, placeholder: true, height?: number}>} items
 * @param {Array<{index: number, depth: number, dimension: string, value: string, label: string}>} headers
 *   from deriveSectionHeaders, indices into `items`, ascending order.
 * `indentPerDepth` nests the CONTENT under its section, not just the header:
 * a chunk of photos (and a placeholder band) is inset by
 * `innermostHeaderDepth * indentPerDepth`, and packed into the correspondingly
 * narrower width, so the photos line up beneath the header they belong to
 * instead of all starting at the left margin. 0 (the default) reproduces the
 * previous flush-left behavior exactly.
 *
 * @param {{ targetRowHeight?: number, containerWidth: number, gap?: number, headerHeight?: number, placeholderHeight?: number, indentPerDepth?: number }} opts
 * @returns {{
 *   boxes: Array<{id: number|string, x: number, y: number, width: number, height: number, placeholder?: true}>,
 *   headers: Array<{index: number, depth: number, dimension: string, value: string, label: string, y: number, endY: number}>,
 *   totalHeight: number
 * }}
 */
export function sectionedJustifiedLayout(
  items,
  headers,
  {
    targetRowHeight = 220,
    containerWidth,
    gap = 8,
    headerHeight = 32,
    placeholderHeight = 32,
    indentPerDepth = 0,
  }
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

  /** How far the CURRENT section's content is inset: the innermost open
   * header's depth, so photos sit under their own header. */
  function currentIndent() {
    if (!indentPerDepth || !openHeaders.length) return 0;
    return openHeaders[openHeaders.length - 1].depth * indentPerDepth;
  }

  function flushChunk(end) {
    if (end <= chunkStart) {
      chunkStart = end;
      return;
    }
    // Placeholders always advance chunkStart past themselves the moment
    // they're encountered (below), so a chunk slice never contains one —
    // this filter is a defensive no-op given the current call pattern,
    // kept because it makes that invariant checkable in isolation.
    const chunkItems = items
      .slice(chunkStart, end)
      .filter((it) => !it.placeholder);
    const indent = currentIndent();
    const chunkBoxes = justifiedLayout(chunkItems, {
      targetRowHeight,
      containerWidth: Math.max(1, containerWidth - indent),
      gap,
    });
    for (const b of chunkBoxes) {
      boxes.push({ ...b, x: b.x + indent, y: b.y + yOffset });
    }
    yOffset += chunkBoxes.length ? layoutHeight(chunkBoxes) + gap : 0;
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
    if (items[i].placeholder) {
      flushChunk(i);
      // x/width span the full row (matching a real box's shape) rather
      // than being omitted — App.svelte's navVertical computes
      // `box.x + box.width / 2` for ANY box, placeholder or not; leaving
      // these undefined would silently produce NaN and desync arrow-key
      // navigation around a placeholder row.
      const height = items[i].height ?? placeholderHeight;
      const pIndent = currentIndent();
      boxes.push({
        id: items[i].id,
        x: pIndent,
        y: yOffset,
        width: Math.max(1, containerWidth - pIndent),
        height,
        placeholder: true,
      });
      yOffset += height + gap;
      chunkStart = i + 1;
    }
  }
  flushChunk(items.length);
  closeAtOrBelow(0, yOffset);

  closedHeaders.sort((a, b) => a.index - b.index || a.depth - b.depth);
  return { boxes, headers: closedHeaders, totalHeight: yOffset };
}
