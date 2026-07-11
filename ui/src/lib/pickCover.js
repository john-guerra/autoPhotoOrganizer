/**
 * The canonical burst-stack cover-priority rule, extracted so auto stacks
 * (ui/src/lib/bursts.js) and manual stacks (ui/src/lib/stackOverrides.js) share
 * one definition. Pure — no DOM, no Svelte.
 *
 * Priority: a manually-chosen member (`preferredCover === true`), else the
 * highest-rated member, else the file marked `.COVER.`, else the first member
 * in the given order (callers pass members in chronological/window order). If
 * more than one member carries `preferredCover`, the first wins — the app's UI
 * never lets that happen (see
 * docs/superpowers/specs/2026-07-06-burst-stack-visual-and-manual-cover-design.md);
 * this is just a deterministic fallback.
 *
 * @param {Array<{id: number|string, name: string, rating?: number, preferredCover?: boolean}>} members
 * @returns {number|string} the cover member's id
 */
export function pickCoverId(members) {
  const manual = members.find((m) => m.preferredCover === true);
  if (manual) return manual.id;

  let bestRated = null;
  for (const m of members) {
    if (m.rating > 0 && (bestRated === null || m.rating > bestRated.rating)) {
      bestRated = m;
    }
  }
  if (bestRated) return bestRated.id;

  const coverMarked = members.find((m) => COVER_FILENAME_RE.test(m.name));
  if (coverMarked) return coverMarked.id;

  return members[0].id;
}

const COVER_FILENAME_RE = /\.COVER\.[^.]+$/i;
