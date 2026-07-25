/**
 * Pure "landing" math for the feed — no DOM, no Svelte — extracted from
 * App.svelte as step 2 of the jump/landing refactor (GitHub issue #189).
 *
 * "Landing" is the behaviour of jumping to a group and holding its first photo
 * in view while the window backfills and metadata reflows the rows. Today that
 * hold is enforced imperatively by `pinNow` (anchors the selected tile) and
 * `pinExpandNow` (anchors a group header) writing `mainColumnEl.scrollTop`.
 * Both compute the SAME thing: given where an anchor currently sits and where
 * it should sit, the scrollTop that puts it back. That kernel is pure; only the
 * getBoundingClientRect reads and the scrollTop write are not. This module owns
 * the kernel so it can be unit-tested and shared, and so the later stages of
 * #189 (a single `landing` state + one hold effect) have a tested foundation.
 */

/**
 * The scrollTop that holds an anchor at `targetOffset` px below the scroll
 * container's top, given it currently sits at `currentOffset`. The result is
 * clamped into the scrollable range `[0, scrollHeight - clientHeight]`.
 *
 * When the drift is within `threshold` px the anchor is close enough to count
 * as held, so this returns the CURRENT `scrollTop` unchanged — the caller
 * compares against `scrollTop` and skips the DOM write (and its forced layout)
 * on a no-op. This mirrors the original inline guard (`if Math.abs(delta) >
 * 0.5`) exactly: within threshold, nothing is written.
 *
 * @param {object} p
 * @param {number} p.scrollTop      current scroll position of the container
 * @param {number} p.currentOffset  anchor's current px offset below the top
 * @param {number} p.targetOffset   anchor's desired px offset below the top
 * @param {number} p.scrollHeight   container scrollHeight
 * @param {number} p.clientHeight   container clientHeight (viewport)
 * @param {number} [p.threshold=0.5] px of drift tolerated before a correction
 * @returns {number} the scrollTop to set (=== `scrollTop` when it's a no-op)
 */
export function holdAnchorScrollTop({
  scrollTop,
  currentOffset,
  targetOffset,
  scrollHeight,
  clientHeight,
  threshold = 0.5,
}) {
  const delta = currentOffset - targetOffset;
  if (Math.abs(delta) <= threshold) return scrollTop;
  const max = scrollHeight - clientHeight;
  return Math.max(0, Math.min(max, scrollTop + delta));
}
