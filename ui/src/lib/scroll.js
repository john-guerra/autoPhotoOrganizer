/**
 * Minimal scroll geometry: the scrollTop that brings a box just into a
 * viewport, or null if it's already fully visible. Pure — no DOM. Mirrors a
 * roving-focus "scroll into view (nearest)" but with a `margin` that reserves
 * space at the top for the grid's stacked sticky headers, so a revealed tile
 * near a section boundary isn't left hidden behind them.
 * @param {{top:number, height:number}} box  position within the scroll content
 * @param {number} viewTop     current scrollTop
 * @param {number} viewHeight  visible height of the scroll container (clientHeight)
 * @param {number} margin      top inset to keep clear (sticky-header stack)
 * @returns {number|null} new scrollTop, or null if no scroll is needed
 */
export function revealScrollTop(box, viewTop, viewHeight, margin) {
  const headerAdjustedTop = box.top - margin;
  const bottom = box.top + box.height;
  if (headerAdjustedTop < viewTop) return headerAdjustedTop; // above the fold (or under headers)
  if (bottom > viewTop + viewHeight) return bottom - viewHeight; // below the fold
  return null; // fully visible
}
