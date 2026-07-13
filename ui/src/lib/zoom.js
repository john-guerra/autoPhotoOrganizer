/**
 * Grid zoom levels: the target row height (px) of the justified layout.
 *
 * The two smallest levels exist to scan a big shoot at a glance; 220 is the
 * default working size. The progression is roughly ×1.4 per step, so a single
 * +/- press is always a visible change.
 */
export const ZOOM_LEVELS = [60, 90, 120, 160, 220, 300, 400];
export const DEFAULT_ROW_HEIGHT = 220;

/** The level list as it stood before 60/90 were added (see resolveZoom). */
export const LEGACY_ZOOM_LEVELS = [120, 160, 220, 300, 400];

/**
 * Resolve the stored preference to an index into ZOOM_LEVELS.
 *
 * We persist the row HEIGHT, not the index, because an index means a different
 * size every time ZOOM_LEVELS grows: prepending 60 and 90 would have silently
 * shrunk every existing user's grid by two steps. The legacy index-based key is
 * migrated once, on the first load after upgrading, and never read again.
 *
 * @param {{px?: string|null, legacyIndex?: string|null}} stored raw localStorage values
 * @returns {number} an index into ZOOM_LEVELS, always in range
 */
export function resolveZoom({ px, legacyIndex } = {}) {
  const byPx = ZOOM_LEVELS.indexOf(Number.parseInt(px ?? "", 10));
  if (byPx >= 0) return byPx;

  const legacy = Number.parseInt(legacyIndex ?? "", 10);
  const byLegacy = ZOOM_LEVELS.indexOf(LEGACY_ZOOM_LEVELS[legacy]);
  if (byLegacy >= 0) return byLegacy;

  return ZOOM_LEVELS.indexOf(DEFAULT_ROW_HEIGHT);
}

/**
 * Gutter between tiles. A fixed 8px between 60px thumbs reads as a grid of
 * whitespace with photos in it, so it shrinks with the tile to hold the ~7%
 * ratio the grid has always had at 120px.
 * @param {number} rowHeight
 */
export function gapFor(rowHeight) {
  return rowHeight < 120 ? 4 : 8;
}
