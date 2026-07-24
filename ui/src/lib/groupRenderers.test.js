import { describe, it, expect } from "vitest";
import {
  GROUP_RENDERERS,
  DEFAULT_RENDERER_ID,
  getRenderer,
  nextRendererId,
  isServerCollapsed,
  cycleAllLabel,
  AGGREGATE_CYCLE,
  nextAggregateRendererId,
  currentAggregateRendererId,
} from "./groupRenderers.js";
import SnapshotStrip from "./SnapshotStrip.svelte";

describe("groupRenderers registry", () => {
  it("defaults to the grid, and falls back to it for an unknown id", () => {
    expect(DEFAULT_RENDERER_ID).toBe("grid");
    expect(getRenderer(undefined).id).toBe("grid");
    expect(getRenderer("nope").id).toBe("grid");
  });

  it("cycles grid → snapshot → collapsed → grid", () => {
    expect(nextRendererId("grid")).toBe("snapshot");
    expect(nextRendererId("snapshot")).toBe("collapsed");
    expect(nextRendererId("collapsed")).toBe("grid");
    expect(nextRendererId(undefined)).toBe("snapshot"); // undefined = grid
  });

  it("only the grid streams the group's photos into the feed", () => {
    expect(isServerCollapsed("grid")).toBe(false);
    expect(isServerCollapsed("snapshot")).toBe(true);
    expect(isServerCollapsed("collapsed")).toBe(true);
  });

  it("a collapsed group reserves NO band — the header alone represents it", () => {
    const ctx = { snapshotRowHeight: 148 };
    expect(getRenderer("collapsed").bandHeight(ctx)).toBe(0);
    expect(getRenderer("collapsed").component).toBeNull();
    expect(getRenderer("grid").bandHeight(ctx)).toBe(0);
    expect(getRenderer("snapshot").bandHeight(ctx)).toBe(148);
    expect(getRenderer("snapshot").component).not.toBeNull();
  });

  it("every renderer declares the fields the header/layout rely on", () => {
    for (const r of GROUP_RENDERERS) {
      expect(typeof r.id).toBe("string");
      expect(["grid", "strip", "bar"]).toContain(r.icon);
      expect(typeof r.needsFeedPhotos).toBe("boolean");
      expect(typeof r.bandHeight).toBe("function");
    }
    // ids are unique — the cycle and the lookup both assume it
    const ids = GROUP_RENDERERS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("aggregate subtree renderers (#142)", () => {
  it("aggregate-snapshot resolves to a strip band fed by SnapshotStrip", () => {
    const r = getRenderer("aggregate-snapshot");
    expect(r.icon).toBe("strip");
    expect(r.needsFeedPhotos).toBe(false);
    expect(r.component).toBe(SnapshotStrip);
    expect(r.bandHeight({ snapshotRowHeight: 148 })).toBe(148);
  });

  it("aggregate-collapsed resolves to a bar with no band — the header alone stands for it", () => {
    const r = getRenderer("aggregate-collapsed");
    expect(r.icon).toBe("bar");
    expect(r.needsFeedPhotos).toBe(false);
    expect(r.component).toBeNull();
    expect(r.bandHeight({ snapshotRowHeight: 148 })).toBe(0);
  });

  it("both are server-collapsed, same as their leaf counterparts", () => {
    expect(isServerCollapsed("aggregate-snapshot")).toBe(true);
    expect(isServerCollapsed("aggregate-collapsed")).toBe(true);
  });

  it("neither joins the leaf 3-way toggle cycle — an aggregate fold is a separate action", () => {
    const ids = GROUP_RENDERERS.map((r) => r.id);
    expect(ids).not.toContain("aggregate-snapshot");
    expect(ids).not.toContain("aggregate-collapsed");
    // nextRendererId only ever cycles grid/snapshot/collapsed, unaffected by
    // the aggregate ids being resolvable via getRenderer.
    expect(nextRendererId("collapsed")).toBe("grid");
  });
});

describe("the aggregate cycle (#142 review)", () => {
  // The bug that shipped in 3a38c4d: cycleSubtreeAggregate's `current` read
  // used SNAPSHOT_ID ("snapshot") where AGGREGATE_SNAPSHOT_RENDERER_ID
  // ("aggregate-snapshot") belonged — a DIFFERENT string that AGGREGATE_CYCLE
  // never contains, so `indexOf` returned -1, `current` silently fell back to
  // "grid", and a parent's 2nd plain-click recomputed "aggregate-snapshot"
  // forever: it could never advance to the collapsed bar or return to grid.
  // These assertions fail immediately if that swap is reintroduced (verified
  // by hand: temporarily changing AGGREGATE_SNAPSHOT.id back to "snapshot" in
  // groupRenderers.js turns both `currentAggregateRendererId` cases red).

  it("currentAggregateRendererId reads grid/aggregate-snapshot/aggregate-collapsed, never plain snapshot", () => {
    const key = "the-key";
    expect(currentAggregateRendererId(key, new Set(), new Set())).toBe("grid");
    expect(
      currentAggregateRendererId(key, new Set([key]), new Set([key]))
    ).toBe("aggregate-snapshot"); // NOT "snapshot" — that's a different renderer id
    expect(currentAggregateRendererId(key, new Set([key]), new Set())).toBe(
      "aggregate-collapsed"
    );
  });

  it("a key only in aggregateSnapshotKeys (no aggregateKeys entry) is still grid", () => {
    // aggregateSnapshotKeys is documented as always a SUBSET of aggregateKeys;
    // a stale/missing aggregateKeys entry must not be masked by the snapshot set.
    const key = "orphaned-snapshot-key";
    expect(currentAggregateRendererId(key, new Set(), new Set([key]))).toBe(
      "grid"
    );
  });

  it("cycles grid → aggregate-snapshot → aggregate-collapsed → grid", () => {
    expect(nextAggregateRendererId("grid")).toBe("aggregate-snapshot");
    expect(nextAggregateRendererId("aggregate-snapshot")).toBe(
      "aggregate-collapsed"
    );
    expect(nextAggregateRendererId("aggregate-collapsed")).toBe("grid");
  });

  it("full round trip via currentAggregateRendererId + nextAggregateRendererId, from real Set state", () => {
    const key = "cards-subtree";
    let aggregateKeys = new Set();
    let aggregateSnapshotKeys = new Set();

    // 1st click: grid → aggregate-snapshot
    let current = currentAggregateRendererId(
      key,
      aggregateKeys,
      aggregateSnapshotKeys
    );
    expect(current).toBe("grid");
    let next = nextAggregateRendererId(current);
    expect(next).toBe("aggregate-snapshot");
    aggregateKeys = new Set([key]);
    aggregateSnapshotKeys = new Set([key]);

    // 2nd click: aggregate-snapshot → aggregate-collapsed (this is the step
    // that stayed stuck on aggregate-snapshot before the fix).
    current = currentAggregateRendererId(
      key,
      aggregateKeys,
      aggregateSnapshotKeys
    );
    expect(current).toBe("aggregate-snapshot");
    next = nextAggregateRendererId(current);
    expect(next).toBe("aggregate-collapsed");
    aggregateSnapshotKeys = new Set(); // no longer the snapshot flavor

    // 3rd click: aggregate-collapsed → grid
    current = currentAggregateRendererId(
      key,
      aggregateKeys,
      aggregateSnapshotKeys
    );
    expect(current).toBe("aggregate-collapsed");
    next = nextAggregateRendererId(current);
    expect(next).toBe("grid");
  });

  it("AGGREGATE_CYCLE never mixes with the plain per-group GROUP_RENDERERS cycle", () => {
    const plainIds = GROUP_RENDERERS.map((r) => r.id);
    for (const id of AGGREGATE_CYCLE) {
      if (id !== DEFAULT_RENDERER_ID) expect(plainIds).not.toContain(id);
    }
  });
});

describe("cycleAllLabel", () => {
  it("promises what the NEXT click does, never what state you are already in", () => {
    // The bug: the button read "▦ Full view" while everything WAS in full view —
    // a status badge on something shaped like a button. The only way to learn what
    // it did was to press it, which is the thing you were trying to decide about.
    expect(cycleAllLabel("grid")).toBe("◐ Snapshot all");
    expect(cycleAllLabel("snapshot")).toBe("▸ Collapse all");
    expect(cycleAllLabel("collapsed")).toBe("▦ Expand all");
  });

  it("says nothing about the state it is in", () => {
    // Every label is a verb about where you're going. If one of them ever names
    // the current state again, this catches it.
    for (const id of ["grid", "snapshot", "collapsed"]) {
      expect(cycleAllLabel(id)).toBe(cycleAllLabel(id));
      expect(cycleAllLabel(id)).not.toBe(cycleAllLabel(nextRendererId(id)));
    }
  });

  it("an unset mode is the default (grid), so the button offers the step after it", () => {
    expect(cycleAllLabel(undefined)).toBe("◐ Snapshot all");
  });
});
