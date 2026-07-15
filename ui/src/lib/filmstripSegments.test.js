import { describe, it, expect } from "vitest";
import { filmstripSegments } from "./filmstripSegments.js";

/** Build a window of cells with ascending indices from a compact spec:
 *  each entry is [id, burstTag] where burstTag is null | {count} | {member,stackId}. */
function build(spec) {
  const windowItems = spec.map(([id], k) => ({
    i: k,
    item: id == null ? { placeholder: true } : { id, name: `p${id}` },
  }));
  const burstInfo = spec.map(([, tag]) => tag ?? null);
  return { windowItems, burstInfo };
}

const member = (stackId) => ({ member: true, stackId });

describe("filmstripSegments", () => {
  it("groups consecutive members of the same burst into one run", () => {
    const { windowItems, burstInfo } = build([
      [1, null],
      [2, member("s1")],
      [3, member("s1")],
      [4, member("s1")],
      [5, null],
    ]);
    const segs = filmstripSegments(windowItems, burstInfo);
    expect(segs.map((s) => s.type)).toEqual(["cell", "run", "cell"]);
    expect(segs[1].stackId).toBe("s1");
    expect(segs[1].cells.map((c) => c.item.id)).toEqual([2, 3, 4]);
  });

  it("does NOT merge members of different bursts that sit next to each other", () => {
    const { windowItems, burstInfo } = build([
      [1, member("s1")],
      [2, member("s1")],
      [3, member("s2")],
      [4, member("s2")],
    ]);
    const segs = filmstripSegments(windowItems, burstInfo);
    expect(segs.map((s) => s.type)).toEqual(["run", "run"]);
    expect(segs[0].cells.map((c) => c.item.id)).toEqual([1, 2]);
    expect(segs[1].cells.map((c) => c.item.id)).toEqual([3, 4]);
  });

  it("breaks a run on a gap (placeholder) between two members of the same burst", () => {
    const { windowItems, burstInfo } = build([
      [1, member("s1")],
      [null, member("s1")], // a layout gap tagged the same — must still split
      [2, member("s1")],
    ]);
    const segs = filmstripSegments(windowItems, burstInfo);
    expect(segs.map((s) => s.type)).toEqual(["run", "cell", "run"]);
  });

  it("a collapsed cover is a standalone cell, never a run", () => {
    const { windowItems, burstInfo } = build([
      [1, { count: 3 }],
      [2, null],
    ]);
    const segs = filmstripSegments(windowItems, burstInfo);
    expect(segs.every((s) => s.type === "cell")).toBe(true);
  });
});
