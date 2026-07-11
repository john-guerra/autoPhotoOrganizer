import { describe, it, expect } from "vitest";
import {
  applyCreateToItems,
  applyDissolveToItems,
  targetStackMemberIds,
  buildStackMenuItems,
} from "./stackActions.js";

function item(id, extra = {}) {
  return { id, name: `${id}.jpg`, ...extra };
}

describe("applyCreateToItems", () => {
  it("sets manualStackId and clears keepSeparate on the members only", () => {
    const items = [item(1, { keepSeparate: true }), item(2), item(3)];
    const next = applyCreateToItems(items, [1, 2], 42);
    expect(next[0]).toMatchObject({
      id: 1,
      manualStackId: 42,
      keepSeparate: false,
    });
    expect(next[1]).toMatchObject({
      id: 2,
      manualStackId: 42,
      keepSeparate: false,
    });
    expect(next[2].manualStackId).toBeUndefined(); // untouched
    expect(next).not.toBe(items); // new array (reactivity)
  });
});

describe("applyDissolveToItems", () => {
  it("sets keepSeparate and clears manualStackId on the members only", () => {
    const items = [
      item(1, { manualStackId: 5 }),
      item(2, { manualStackId: 5 }),
      item(3),
    ];
    const next = applyDissolveToItems(items, [1, 2]);
    expect(next[0]).toMatchObject({ keepSeparate: true, manualStackId: null });
    expect(next[1]).toMatchObject({ keepSeparate: true, manualStackId: null });
    expect(next[2].manualStackId).toBeUndefined();
  });
});

describe("targetStackMemberIds", () => {
  const stacks = [
    { id: "burst-1", memberIds: [1, 2, 3], coverId: 1, count: 3 },
  ];
  it("returns members for a stack entry", () => {
    expect(
      targetStackMemberIds({ kind: "stack", stack: stacks[0] }, stacks)
    ).toEqual([1, 2, 3]);
  });
  it("returns members for an expanded photo member", () => {
    expect(
      targetStackMemberIds({ kind: "photo", stackId: "burst-1" }, stacks)
    ).toEqual([1, 2, 3]);
  });
  it("returns null for a lone photo", () => {
    expect(
      targetStackMemberIds({ kind: "photo", stackId: null }, stacks)
    ).toBeNull();
  });
});

describe("buildStackMenuItems", () => {
  const items = [
    item(1, { groupValues: { folder: "/a" } }),
    item(2, { groupValues: { folder: "/a" } }),
    item(3, { groupValues: { folder: "/b" } }),
  ];
  const displayEntries = [
    { kind: "photo", item: items[0], stackId: null },
    {
      kind: "stack",
      stack: { id: "burst-1", memberIds: [1, 2], coverId: 1, count: 2 },
    },
  ];
  const stacks = [{ id: "burst-1", memberIds: [1, 2], coverId: 1, count: 2 }];

  it("enables Create for a valid single-group selection and Dissolve for a stack target", () => {
    const menu = buildStackMenuItems({
      items,
      selectedIds: new Set([1, 2]),
      groupBy: ["folder"],
      displayEntries,
      targetIndex: 1, // the stack entry
      stacks,
      onCreate: () => {},
      onDissolve: () => {},
    });
    const create = menu.find((m) => m.label.startsWith("Create stack"));
    const dissolve = menu.find((m) => m.label === "Dissolve stack");
    expect(create.enabled).toBe(true);
    expect(create.label).toBe("Create stack from 2 photos");
    expect(dissolve.enabled).toBe(true);
  });

  it("disables Create for a cross-group selection and Dissolve for a lone-photo target", () => {
    const menu = buildStackMenuItems({
      items,
      selectedIds: new Set([1, 3]),
      groupBy: ["folder"],
      displayEntries,
      targetIndex: 0, // a lone photo
      stacks,
      onCreate: () => {},
      onDissolve: () => {},
    });
    expect(menu.find((m) => m.label.startsWith("Create stack")).enabled).toBe(
      false
    );
    expect(menu.find((m) => m.label === "Dissolve stack").enabled).toBe(false);
  });

  it("fires onCreate with the selection and onDissolve with the target members", () => {
    let created = null;
    let dissolved = null;
    const menu = buildStackMenuItems({
      items,
      selectedIds: new Set([1, 2]),
      groupBy: ["folder"],
      displayEntries,
      targetIndex: 1,
      stacks,
      onCreate: (ids) => (created = ids),
      onDissolve: (ids) => (dissolved = ids),
    });
    menu.find((m) => m.label.startsWith("Create stack")).action();
    menu.find((m) => m.label === "Dissolve stack").action();
    expect(created.sort()).toEqual([1, 2]);
    expect(dissolved).toEqual([1, 2]);
  });
});
