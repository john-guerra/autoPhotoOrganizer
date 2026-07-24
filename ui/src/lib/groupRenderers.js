import SnapshotStrip from "./SnapshotStrip.svelte";

/**
 * How a group's PHOTOS are drawn. The group's label/icon/actions are NOT a
 * renderer's business — every group always gets exactly one section header
 * (see App.svelte); a renderer only fills the band beneath it.
 *
 * That split is the whole point: before this, a group was drawn three different
 * ways (a header, a snapshot row with its own head, a collapsed pill with its own
 * label), each re-implementing the label. The label drifted, the snapshot ignored
 * the header's indentation, and adding a fourth way meant touching all of them.
 *
 * Adding a new widget is now: write a Svelte component that takes
 * `{ group, rect, params }`, and add one entry to GROUP_RENDERERS.
 *
 * @typedef {object} GroupRenderer
 * @property {string} id
 * @property {string} label                 human name (tooltips / future menu)
 * @property {"grid"|"strip"|"bar"} icon    which GroupStateIcon to show
 * @property {boolean} needsFeedPhotos
 *   true  → the group's photos stream into the feed and the justified grid draws
 *           them (no band of our own).
 *   false → the group is collapsed SERVER-side (it becomes one placeholder row);
 *           the widget draws the band itself from its own sampled data.
 * @property {(ctx: {snapshotRowHeight: number}) => number} bandHeight
 *   px to reserve under the header. 0 = nothing but the header.
 * @property {import("svelte").ComponentType|null} component
 *   Rendered into the band with `{ group, rect, params }`. null = empty band.
 */

/** @type {GroupRenderer} */
export const GRID = {
  id: "grid",
  label: "Full grid",
  icon: "grid",
  needsFeedPhotos: true,
  bandHeight: () => 0,
  component: null,
};

/** @type {GroupRenderer} */
export const SNAPSHOT = {
  id: "snapshot",
  label: "Snapshot strip",
  icon: "strip",
  needsFeedPhotos: false,
  bandHeight: ({ snapshotRowHeight }) => snapshotRowHeight,
  component: SnapshotStrip,
};

/** @type {GroupRenderer} */
export const COLLAPSED = {
  id: "collapsed",
  label: "Collapsed",
  icon: "bar",
  needsFeedPhotos: false,
  // Nothing under the header at all — the header (with its bar icon and count)
  // IS the collapsed representation. No more separate pill.
  bandHeight: () => 0,
  component: null,
};

/** The cycle order for the header toggle. Append a new widget here. */
export const GROUP_RENDERERS = [GRID, SNAPSHOT, COLLAPSED];

export const DEFAULT_RENDERER_ID = GRID.id;
/** The one renderer whose "collapsed" groups still draw a strip. Exported so
 *  callers name it via the registry instead of a bare "snapshot" literal. */
export const SNAPSHOT_ID = SNAPSHOT.id;

/**
 * The subtree-fold equivalents of SNAPSHOT/COLLAPSED (#142): folderSections.js
 * assigns a header one of THESE ids — never a plain "snapshot"/"collapsed" —
 * when a whole folder subtree is aggregated into one header (see its
 * AGGREGATE_SNAPSHOT_RENDERER_ID / AGGREGATE_COLLAPSED_RENDERER_ID). They draw
 * exactly like their leaf counterparts (a SnapshotStrip fed by the subtree
 * sample, or nothing but the header) but are deliberately NOT part of
 * GROUP_RENDERERS: that array is the per-group toggle's 3-way cycle, and an
 * aggregate fold is a separate, whole-subtree action (wired in a later task)
 * that a single-group click must never cycle into or out of.
 */

/** @type {GroupRenderer} */
export const AGGREGATE_SNAPSHOT = {
  id: "aggregate-snapshot",
  label: "Aggregate snapshot strip",
  icon: "strip",
  needsFeedPhotos: false,
  bandHeight: ({ snapshotRowHeight }) => snapshotRowHeight,
  component: SnapshotStrip,
};

/** @type {GroupRenderer} */
export const AGGREGATE_COLLAPSED = {
  id: "aggregate-collapsed",
  label: "Aggregate collapsed",
  icon: "bar",
  needsFeedPhotos: false,
  // Same as COLLAPSED: the header (with its bar icon and subtree-total count)
  // IS the representation — no band underneath.
  bandHeight: () => 0,
  component: null,
};

/** Resolvable by `getRenderer` but never cycled through. */
const AGGREGATE_RENDERERS = [AGGREGATE_SNAPSHOT, AGGREGATE_COLLAPSED];

/** @param {string|undefined} id @returns {GroupRenderer} */
export function getRenderer(id) {
  return (
    GROUP_RENDERERS.find((r) => r.id === id) ??
    AGGREGATE_RENDERERS.find((r) => r.id === id) ??
    GRID
  );
}

/** Next renderer in the cycle (wraps). @param {string|undefined} id */
export function nextRendererId(id) {
  const i = GROUP_RENDERERS.findIndex(
    (r) => r.id === (id ?? DEFAULT_RENDERER_ID)
  );
  return GROUP_RENDERERS[(i + 1) % GROUP_RENDERERS.length].id;
}

/** Does this renderer require the group to be collapsed server-side? */
export function isServerCollapsed(id) {
  return !getRenderer(id).needsFeedPhotos;
}

/** What the cycle-all button PROMISES, keyed by the state it would move you to.
 * A verb, because the button is a thing you do — not a badge for the state you
 * are already in. */
const CYCLE_ALL_PROMISE = {
  grid: "▦ Expand all",
  snapshot: "◐ Snapshot all",
  collapsed: "▸ Collapse all",
};

/**
 * The cycle-all button's label: what the NEXT click will do.
 *
 * It used to name the state you were ALREADY in ("▦ Full view" while everything
 * was, in fact, in full view), which reads as a status badge on something shaped
 * like a button — so you had to press it to find out what it did, and pressing it
 * was the thing you were trying to decide about. A button says what happens if you
 * press it.
 *
 * @param {string|undefined} current the current global renderer id
 */
export function cycleAllLabel(current) {
  return CYCLE_ALL_PROMISE[nextRendererId(current)];
}
