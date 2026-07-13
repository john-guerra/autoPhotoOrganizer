import { describe, it, expect } from "vitest";
import {
  nextBulkAction,
  groupLabel,
  restoreSelection,
} from "./bulkSelection.js";

describe("restoreSelection (Undo)", () => {
  it("restores exactly the snapshot, replacing what is selected now", () => {
    const before = new Set([1, 2]);
    // ...user hits ⌘A and ends up with everything...
    const now = new Set([1, 2, 3, 4, 5]);
    expect([...restoreSelection(before)]).toEqual([1, 2]);
    expect([...now]).toEqual([1, 2, 3, 4, 5]); // untouched — a new Set comes back
  });

  it("does NOT union — undoing a select-all must not leave everything selected", () => {
    // The bug: `new Set([...selectedIds, ...snapshot])` looked right for Clear
    // (merging into an empty set) but made undoing a select-all a no-op.
    const snapshot = new Set([1, 2]);
    const restored = restoreSelection(snapshot);
    expect(restored.has(3)).toBe(false);
    expect(restored.size).toBe(2);
  });

  it("restores an empty selection — undoing a select-all from nothing selects nothing", () => {
    expect(restoreSelection(new Set()).size).toBe(0);
    expect(restoreSelection(null).size).toBe(0);
  });
});

describe("groupLabel", () => {
  it("names a folder group by its last segment, not the whole path", () => {
    expect(
      groupLabel([{ dimension: "folder", value: "/Users/x/photos/DCIM" }])
    ).toBe("DCIM");
  });

  it("uses the deepest dimension when the grouping is nested", () => {
    expect(
      groupLabel([
        { dimension: "folderName", value: "Trip" },
        { dimension: "year", value: 2026 },
      ])
    ).toBe("2026");
  });

  it("never renders [object Object] — a path holds objects, not strings", () => {
    // The exact bug live verification caught: String(last) on a {dimension,value}.
    expect(groupLabel([{ dimension: "camera", value: "Canon" }])).toBe("Canon");
  });

  it("falls back when there is no group", () => {
    expect(groupLabel(null)).toBe("this group");
    expect(groupLabel([])).toBe("this group");
  });
});

describe("⌘A escalation", () => {
  it("takes the current group first", () => {
    expect(
      nextBulkAction("select", {
        pending: null,
        hasGroup: true,
        groupFullySelected: false,
      })
    ).toBe("group");
  });

  it("asks about the whole set once the group is already fully selected", () => {
    // The escalation trigger: you already hold the group, so the next press can
    // only mean "more" — no timer, no double-tap window.
    expect(
      nextBulkAction("select", {
        pending: null,
        hasGroup: true,
        groupFullySelected: true,
      })
    ).toBe("prompt");
  });

  it("asks straight away when there is no group to act on", () => {
    expect(nextBulkAction("select", { pending: null, hasGroup: false })).toBe(
      "prompt"
    );
  });

  it("treats a second press while the prompt is up as the confirmation", () => {
    expect(
      nextBulkAction("select", {
        pending: "select",
        hasGroup: true,
        groupFullySelected: true,
      })
    ).toBe("confirm");
  });

  it("does not let the OTHER shortcut's prompt count as confirmation", () => {
    // ⌘⇧A is up; pressing ⌘A must not confirm the deselect-everything prompt.
    expect(
      nextBulkAction("select", {
        pending: "deselect",
        hasGroup: true,
        groupFullySelected: false,
      })
    ).toBe("group");
  });
});

describe("⌘⇧A escalation", () => {
  it("removes the current group first", () => {
    expect(
      nextBulkAction("deselect", {
        pending: null,
        hasGroup: true,
        groupHasSelection: true,
      })
    ).toBe("group");
  });

  it("asks about the whole set when the group holds nothing to remove", () => {
    // Removing a group that contributes nothing would be a no-op, so the press
    // escalates rather than doing nothing at all.
    expect(
      nextBulkAction("deselect", {
        pending: null,
        hasGroup: true,
        groupHasSelection: false,
      })
    ).toBe("prompt");
  });

  it("treats a second press while its prompt is up as the confirmation", () => {
    expect(
      nextBulkAction("deselect", {
        pending: "deselect",
        hasGroup: true,
        groupHasSelection: false,
      })
    ).toBe("confirm");
  });

  it("asks straight away when there is no group", () => {
    expect(nextBulkAction("deselect", { pending: null, hasGroup: false })).toBe(
      "prompt"
    );
  });
});
