import { describe, it, expect } from "vitest";
import { revealScrollTop } from "./scroll.js";

describe("revealScrollTop", () => {
  // viewport is [viewTop, viewTop + viewHeight); margin reserves top space.
  it("returns null when the box is already fully visible", () => {
    // box 200..300 inside view 0..600, clear of the 32px header margin
    expect(revealScrollTop({ top: 200, height: 100 }, 0, 600, 32)).toBeNull();
  });

  it("scrolls down the minimum needed when the box is below the fold", () => {
    // box 700..800, view 0..600 → bottom(800) - viewHeight(600) = 200
    expect(revealScrollTop({ top: 700, height: 100 }, 0, 600, 32)).toBe(200);
  });

  it("scrolls up to the header-adjusted top when the box is above the fold", () => {
    // box 100..200, view 400..1000 → top(100) - margin(32) = 68
    expect(revealScrollTop({ top: 100, height: 100 }, 400, 600, 32)).toBe(68);
  });

  it("nudges up when the box sits under the sticky-header band", () => {
    // box top 410 is within view 400..1000 but the 32px header covers 400..432;
    // reveal so the tile clears it: 410 - 32 = 378
    expect(revealScrollTop({ top: 410, height: 100 }, 400, 600, 32)).toBe(378);
  });

  it("prefers showing the top for a box taller than the viewport", () => {
    // box 100..1100 (height 1000) with view 400..1000 → show top: 100 - 32 = 68
    expect(revealScrollTop({ top: 100, height: 1000 }, 400, 600, 32)).toBe(68);
  });
});
