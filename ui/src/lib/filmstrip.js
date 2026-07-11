/** The [start, end) slice of `items` the filmstrip should render: a window of
 * `radius` entries on each side of `index`, clamped to [0, length]. Windowing
 * keeps a large feed (10k+ photos) from mounting thousands of <img>s. Pure —
 * unit-tested in filmstrip.test.js. */
export function filmstripWindow(index, length, radius) {
  if (length <= 0) return { start: 0, end: 0 };
  const i = Math.max(0, Math.min(length - 1, index));
  return {
    start: Math.max(0, i - radius),
    end: Math.min(length, i + radius + 1),
  };
}
