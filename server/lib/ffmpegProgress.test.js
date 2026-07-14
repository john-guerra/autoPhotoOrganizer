import { describe, it, expect } from "vitest";
import { createProgressParser } from "./ffmpegProgress.js";

describe("createProgressParser", () => {
  it("reads the position out of a progress block", () => {
    const p = createProgressParser();
    expect(
      p.push("frame=12\nfps=0\nout_time_us=2500000\nprogress=continue\n")
    ).toBe(2.5);
  });

  it("treats out_time_ms as MICROseconds, because that is what ffmpeg puts there", () => {
    // The name is an upstream lie. Believing it makes every report 1000x too big:
    // the bar slams to 100% on the first update and sits there, which reads as a
    // finished conversion that never finishes — worse than no bar at all.
    const p = createProgressParser();
    expect(p.push("out_time_ms=2500000\nprogress=continue\n")).toBe(2.5);
  });

  it("survives a chunk split in the middle of a number", () => {
    // The stream arrives in arbitrary chunks. A parser that treats each chunk as
    // whole lines reads "250" here and reports 0.00025s — a bar that goes
    // backwards.
    const p = createProgressParser();
    expect(p.push("out_time_us=250")).toBe(null);
    expect(p.push("0000\nprogress=continue\n")).toBe(2.5);
  });

  it("keeps the LAST position when a chunk carries several blocks", () => {
    const p = createProgressParser();
    expect(
      p.push(
        "out_time_us=1000000\nprogress=continue\nout_time_us=4000000\nprogress=continue\n"
      )
    ).toBe(4);
  });

  it("ignores the N/A ffmpeg emits before the first frame lands", () => {
    const p = createProgressParser();
    expect(p.push("out_time_us=N/A\nprogress=continue\n")).toBe(null);
  });

  it("says nothing about chunks that carry no position", () => {
    const p = createProgressParser();
    expect(p.push("frame=1\nfps=0\n")).toBe(null);
  });
});
