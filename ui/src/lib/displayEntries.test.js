import { describe, it, expect } from "vitest";
import {
  buildDisplayEntries,
  entryDomId,
  resolvePhoto,
} from "./displayEntries.js";

const items = [
  { id: 1, name: "solo.jpg", mtimeMs: 0 },
  { id: 2, name: "burst-a.jpg", mtimeMs: 100 },
  { id: 3, name: "burst-b.jpg", mtimeMs: 200 },
  { id: 4, name: "burst-c.jpg", mtimeMs: 300 },
];
const stack = { id: "burst-3", memberIds: [2, 3, 4], coverId: 3, count: 3 };

describe("buildDisplayEntries", () => {
  it("passes ungrouped photos through unchanged", () => {
    const entries = buildDisplayEntries(items, [stack], new Set());
    const solo = entries.find((e) => e.kind === "photo" && e.item.id === 1);
    expect(solo).toEqual({ kind: "photo", item: items[0], stackId: null });
  });

  it("collapses a stack to one entry, at its first member's position, using the cover photo", () => {
    const entries = buildDisplayEntries(items, [stack], new Set());
    expect(entries).toHaveLength(2); // solo + one collapsed stack entry
    expect(entries[0].item.id).toBe(1); // solo stays first
    expect(entries[1]).toEqual({
      kind: "stack",
      stack,
      coverItem: items[2], // id 3, the cover
      peekItems: [items[1], items[3]], // ids 2 and 4, excluding the cover
    });
  });

  it("expands every member of an expanded stack individually, tagged with stackId", () => {
    const entries = buildDisplayEntries(items, [stack], new Set(["burst-3"]));
    expect(entries).toHaveLength(4); // solo + 3 expanded members
    const members = entries.filter(
      (e) => e.kind === "photo" && e.stackId === "burst-3"
    );
    expect(members.map((e) => e.item.id)).toEqual([2, 3, 4]);
  });

  it("does not duplicate a collapsed stack's later members", () => {
    const entries = buildDisplayEntries(items, [stack], new Set());
    const stackEntries = entries.filter((e) => e.kind === "stack");
    expect(stackEntries).toHaveLength(1);
  });

  it("computes peekItems as the stack's other members, excluding the cover, in memberIds order", () => {
    const entries = buildDisplayEntries(items, [stack], new Set());
    const stackEntry = entries.find((e) => e.kind === "stack");
    expect(stackEntry.peekItems).toEqual([items[1], items[3]]); // ids 2, 4 — not 3 (the cover)
  });
});

describe("entryDomId", () => {
  it("returns the stack id for a collapsed stack entry", () => {
    expect(entryDomId({ kind: "stack", stack, coverItem: items[2] })).toBe(
      "burst-3"
    );
  });

  it("returns the photo id for a photo entry", () => {
    expect(entryDomId({ kind: "photo", item: items[0], stackId: null })).toBe(
      "1"
    );
  });
});

describe("resolvePhoto", () => {
  it("returns the cover item for a collapsed stack entry", () => {
    expect(resolvePhoto({ kind: "stack", stack, coverItem: items[2] })).toBe(
      items[2]
    );
  });

  it("returns the item itself for a photo entry", () => {
    expect(resolvePhoto({ kind: "photo", item: items[0], stackId: null })).toBe(
      items[0]
    );
  });
});

describe("buildDisplayEntries — placeholder entries", () => {
  const placeholder = {
    collapsed: true,
    id: "collapsed:year=2019",
    path: [{ dimension: "year", value: "2019" }],
    count: 42,
    groupValues: { year: "2019" },
  };

  it("passes a collapsed item through as its own placeholder entry, never treated as a photo or burst member", () => {
    const mixed = [items[0], placeholder, items[1]];
    const entries = buildDisplayEntries(mixed, [], new Set());
    expect(entries).toEqual([
      { kind: "photo", item: items[0], stackId: null },
      { kind: "placeholder", item: placeholder },
      { kind: "photo", item: items[1], stackId: null },
    ]);
  });
});

describe("entryDomId — placeholder entries", () => {
  it("returns the placeholder's own id", () => {
    const placeholder = {
      collapsed: true,
      id: "collapsed:year=2019",
      path: [],
      count: 1,
      groupValues: {},
    };
    expect(entryDomId({ kind: "placeholder", item: placeholder })).toBe(
      "collapsed:year=2019"
    );
  });
});

describe("resolvePhoto — placeholder entries", () => {
  it("returns the placeholder object itself", () => {
    const placeholder = {
      collapsed: true,
      id: "collapsed:year=2019",
      path: [],
      count: 1,
      groupValues: {},
    };
    expect(resolvePhoto({ kind: "placeholder", item: placeholder })).toBe(
      placeholder
    );
  });
});
