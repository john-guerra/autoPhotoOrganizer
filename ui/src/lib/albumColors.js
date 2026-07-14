/**
 * The colour of an album — the single mapping shared by the timeline bands and
 * the divider chips. That shared function IS the link between the chart and the
 * list: band `i` and divider `i` are the same colour because both call this.
 *
 * Keyed by INDEX, not by name. The legacy chart keyed `d3.scale.category20()` by
 * album name (photoTimelineChart.js:101), which hashes two adjacent albums to
 * arbitrary hues — sometimes neighbouring ones, so a break point could fall
 * between two bands you can't tell apart. Indexing makes consecutive albums
 * differ by construction, which is the only property this encoding actually owes
 * the user: albums are a sequence, and the boundary between two of them is the
 * thing being looked at.
 */

// Tableau 10 — categorical, and (unlike category20) every pair is distinguishable
// at the 6px band height this is drawn at. The 11th album reuses the 1st: with a
// cyclic scheme, only ADJACENCY is guaranteed, never global uniqueness. A library
// can produce hundreds of albums; ten hues cannot be hundreds of distinct things,
// and pretending otherwise (a continuous rainbow, say) would encode a false
// ordering.
const SCHEME = [
  "#4e79a7",
  "#f28e2b",
  "#59a14f",
  "#e15759",
  "#b07aa1",
  "#76b7b2",
  "#edc948",
  "#ff9da7",
  "#9c755f",
  "#bab0ac",
];

/**
 * @param {number} index  the album's position in the clustered sequence
 * @returns {string} a CSS colour
 */
export function albumColor(index) {
  if (!Number.isFinite(index) || index < 0) return SCHEME[0];
  return SCHEME[Math.floor(index) % SCHEME.length];
}

export const ALBUM_SCHEME_SIZE = SCHEME.length;
