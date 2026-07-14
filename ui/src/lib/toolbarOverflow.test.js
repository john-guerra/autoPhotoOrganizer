import { describe, it, expect } from "vitest";
import { stepOverflow } from "./toolbarOverflow.js";

const ORDER = ["group", "view"];
const start = { order: ORDER, folded: [], thresholds: {} };

/** Runs the machine to a fixed point, the way the component does: measure, apply,
 *  measure again. `fits(folded, available)` stands in for the browser's flex
 *  solver. Returns the folded set it settles on, or throws if it never settles. */
function settle(available, fits, state = start) {
  let s = state;
  for (let i = 0; i < 20; i++) {
    const next = stepOverflow({
      ...s,
      available,
      overflowing: !fits(s.folded, available),
    });
    if (!next.changed) return next;
    s = { ...s, folded: next.folded, thresholds: next.thresholds };
  }
  throw new Error("never settled — the machine is oscillating");
}

describe("stepOverflow", () => {
  // Each folded group frees 300px. The row needs 1400px with nothing folded.
  const fits = (folded, available) => available >= 1400 - folded.length * 300;

  it("folds nothing when there is room", () => {
    expect(settle(1600, fits).folded).toEqual([]);
  });

  it("folds one group — the first in line — when one is enough", () => {
    expect(settle(1200, fits).folded).toEqual(["group"]);
  });

  it("keeps folding until the row fits", () => {
    expect(settle(900, fits).folded).toEqual(["group", "view"]);
  });

  it("gives up rather than folding a group that is not on the list", () => {
    // Nothing left to fold and it still doesn't fit: the row overflows, and that
    // is the honest outcome. It must not spin looking for a group to sacrifice.
    const s = settle(400, fits);
    expect(s.folded).toEqual(["group", "view"]);
    expect(s.changed).toBe(false);
  });

  it("does NOT unfold the group it just folded, however much room that freed", () => {
    // The trap: folding frees width, the row now fits, so the group looks like it
    // could come back — and folding it again frees width again. Forever. `settle`
    // throws if that happens.
    const generous = (folded) => folded.length > 0; // one fold frees a huge amount
    expect(settle(1000, generous).folded).toEqual(["group"]);
  });

  it("gives the group back when the window is genuinely widened", () => {
    const narrow = settle(1200, fits);
    const wide = settle(1600, fits, { ...start, ...narrow });
    expect(wide.folded).toEqual([]);
  });

  it("gives them back in the reverse of the order it took them", () => {
    const tight = settle(900, fits); // ["group", "view"]
    // 1250 fits with ONE folded (1400-300 = 1100), so "view" — folded last, most
    // reluctantly — is the one that comes back.
    const looser = settle(1250, fits, { ...start, ...tight });
    expect(looser.folded).toEqual(["group"]);
  });

  it("holds a fold at exactly the width it failed at — one pixel is not a change", () => {
    const s = settle(1200, fits);
    // Same width, and the row now fits only BECAUSE the group is folded. Unfolding
    // here would put us straight back where we were.
    const again = stepOverflow({
      ...start,
      ...s,
      available: 1200,
      overflowing: false,
    });
    expect(again.changed).toBe(false);
    expect(again.folded).toEqual(["group"]);
  });
});
