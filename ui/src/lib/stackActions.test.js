import { describe, it, expect, vi, beforeEach } from "vitest";

// createStack is the only network call burstSelectionIntoStacks makes; stubbed
// so the clustering itself is what is under test.
let nextGroupId = 100;
vi.mock("./api.js", () => ({
  createStack: vi.fn(async () => ({ groupId: nextGroupId++, count: 0 })),
  dissolveStackApi: vi.fn(async () => ({ count: 0 })),
}));
import {
  applyCreateToItems,
  applyDissolveToItems,
  selectedStackedMemberIds,
  targetStackMemberIds,
  buildStackMenuItems,
  burstSelectionIntoStacks,
} from "./stackActions.js";
import { createStack } from "./api.js";

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

describe("selectedStackedMemberIds", () => {
  const stacks = [
    { id: "burst-1", memberIds: [1, 2, 3], coverId: 1, count: 3 },
    { id: "burst-2", memberIds: [7, 8], coverId: 7, count: 2 },
  ];

  it("returns only the selected ids that belong to a stack (loose ones excluded)", () => {
    // 2 is in burst-1, 8 is in burst-2, 5 is loose → 5 must be dropped.
    expect(selectedStackedMemberIds(new Set([2, 5, 8]), stacks).sort()).toEqual(
      [2, 8]
    );
  });

  it("spans multiple stacks, de-duplicating", () => {
    expect(
      selectedStackedMemberIds(new Set([1, 2, 3, 7, 8]), stacks).sort()
    ).toEqual([1, 2, 3, 7, 8]);
  });

  it("returns [] when the selection touches no stack", () => {
    expect(selectedStackedMemberIds(new Set([5, 6]), stacks)).toEqual([]);
  });

  it("returns [] for an empty selection or empty stacks", () => {
    expect(selectedStackedMemberIds(new Set(), stacks)).toEqual([]);
    expect(selectedStackedMemberIds(new Set([1, 2]), [])).toEqual([]);
  });

  it("accepts any iterable of ids, not just a Set", () => {
    expect(selectedStackedMemberIds([2, 3], stacks).sort()).toEqual([2, 3]);
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

/**
 * Stacking a SELECTION by its own time gaps (#207).
 *
 * The distinction that matters: "make a stack" forces the whole selection into
 * ONE group regardless of the pauses inside it. This applies the ordinary
 * burst rule to just the selected photos, so a swept-up run splits where the
 * user watching the grid would expect it to.
 */
describe("burstSelectionIntoStacks", () => {
  beforeEach(() => {
    nextGroupId = 100;
    createStack.mockClear();
  });

  const photo = (id, mtimeMs) => ({ id, name: `${id}.jpg`, mtimeMs });

  it("splits the selection where the gap exceeds the burst gap", async () => {
    const items = [
      photo(1, 0),
      photo(2, 500),
      photo(3, 60_000), // new burst
      photo(4, 60_400),
      photo(5, 200_000), // alone — never stacked
    ];
    const res = await burstSelectionIntoStacks(
      items,
      new Set([1, 2, 3, 4, 5]),
      1000
    );

    expect(res.stacks).toBe(2);
    expect(res.photos).toBe(4);
    // The lone photo keeps no manual group: a one-photo stack is not a stack,
    // and persisting one would freeze it out of later automatic bursting.
    const byId = new Map(res.nextItems.map((it) => [it.id, it]));
    expect(byId.get(1).manualStackId).toBe(byId.get(2).manualStackId);
    expect(byId.get(3).manualStackId).toBe(byId.get(4).manualStackId);
    expect(byId.get(1).manualStackId).not.toBe(byId.get(3).manualStackId);
    expect(byId.get(5).manualStackId ?? null).toBeNull();
  });

  it("ignores photos outside the selection entirely", async () => {
    // 2 sits between 1 and 3 in time and would bridge them if the selection
    // were ignored — it must not, or the button would stack photos the user
    // never selected.
    const items = [photo(1, 0), photo(2, 500), photo(3, 1000)];
    const res = await burstSelectionIntoStacks(items, new Set([1, 3]), 600);

    expect(res.stacks).toBe(0);
    expect(createStack).not.toHaveBeenCalled();
  });

  it("creates nothing when no two selected photos are close enough", async () => {
    const items = [photo(1, 0), photo(2, 90_000)];
    const res = await burstSelectionIntoStacks(items, new Set([1, 2]), 1000);

    expect(res).toMatchObject({ stacks: 0, photos: 0 });
    expect(res.nextItems).toEqual(items);
    expect(createStack).not.toHaveBeenCalled();
  });
});
