import { describe, it, expect } from "vitest";
import { holdAnchorScrollTop } from "./landing.js";

describe("holdAnchorScrollTop", () => {
  const bounds = { scrollHeight: 1000, clientHeight: 400 }; // max scroll = 600

  it("is a no-op (returns the current scrollTop) when drift is within threshold", () => {
    // Anchor sits 20.3px below the top, wants to sit at 20px — 0.3px < 0.5px.
    const scrollTop = 150;
    expect(
      holdAnchorScrollTop({
        scrollTop,
        currentOffset: 20.3,
        targetOffset: 20,
        ...bounds,
      })
    ).toBe(scrollTop);
  });

  it("scrolls DOWN when the anchor has drifted below its target", () => {
    // Anchor is at 120px, should be at 20px → it's 100px too low, so scroll
    // down 100px to bring it back up to the target.
    expect(
      holdAnchorScrollTop({
        scrollTop: 150,
        currentOffset: 120,
        targetOffset: 20,
        ...bounds,
      })
    ).toBe(250);
  });

  it("scrolls UP when the anchor has drifted above its target", () => {
    // Anchor is at 5px, should be at 40px → it's 35px too high, scroll up 35.
    expect(
      holdAnchorScrollTop({
        scrollTop: 150,
        currentOffset: 5,
        targetOffset: 40,
        ...bounds,
      })
    ).toBe(115);
  });

  it("clamps to 0 and never returns a negative scrollTop", () => {
    // A large upward correction from near the top would go negative.
    expect(
      holdAnchorScrollTop({
        scrollTop: 30,
        currentOffset: 0,
        targetOffset: 500,
        ...bounds,
      })
    ).toBe(0);
  });

  it("clamps to the maximum scrollable position", () => {
    // A large downward correction can't scroll past scrollHeight - clientHeight.
    expect(
      holdAnchorScrollTop({
        scrollTop: 500,
        currentOffset: 900,
        targetOffset: 0,
        ...bounds,
      })
    ).toBe(600);
  });

  it("honors a custom threshold", () => {
    const scrollTop = 200;
    // 3px drift is a no-op under a 5px threshold...
    expect(
      holdAnchorScrollTop({
        scrollTop,
        currentOffset: 23,
        targetOffset: 20,
        ...bounds,
        threshold: 5,
      })
    ).toBe(scrollTop);
    // ...but corrects under the default 0.5px threshold.
    expect(
      holdAnchorScrollTop({
        scrollTop,
        currentOffset: 23,
        targetOffset: 20,
        ...bounds,
      })
    ).toBe(203);
  });
});
