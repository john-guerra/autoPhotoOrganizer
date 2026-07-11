import { describe, it, expect } from "vitest";
import {
  computeGapStats,
  autoThresholdMs,
  clusterByGap,
  defaultAlbumName,
} from "./albums.js";

const H = 3600_000; // one hour in ms

describe("computeGapStats", () => {
  it("returns zeros for fewer than two photos", () => {
    expect(computeGapStats([])).toMatchObject({ mean: 0, stdev: 0, count: 0 });
    expect(computeGapStats([5])).toMatchObject({ mean: 0, stdev: 0, count: 1 });
  });

  it("computes mean and population stddev of consecutive gaps", () => {
    // gaps: 1h, 1h, 4h -> mean 2h, variance = ((1)^2+(1)^2+(2)^2)/3 h^2 = 2 -> stdev sqrt(2) h
    const times = [0, 1 * H, 2 * H, 6 * H];
    const s = computeGapStats(times);
    expect(s.mean).toBeCloseTo(2 * H);
    expect(s.stdev).toBeCloseTo(Math.sqrt(2) * H);
    expect(s).toMatchObject({ count: 4, minGap: 1 * H, maxGap: 4 * H });
  });
});

describe("clusterByGap", () => {
  const photos = [
    { id: 1, t: 0 },
    { id: 2, t: 1 * H }, // small gap -> same album
    { id: 3, t: 10 * H }, // big gap -> new album
    { id: 4, t: 10.5 * H }, // small gap -> same album
  ];

  it("splits where a gap exceeds the threshold", () => {
    const albums = clusterByGap(photos, 5 * H);
    expect(albums.map((a) => a.ids)).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(albums[0]).toMatchObject({ index: 0, startAt: 0, endAt: 1 * H });
    expect(albums[1]).toMatchObject({
      index: 1,
      startAt: 10 * H,
      endAt: 10.5 * H,
    });
  });

  it("makes one album when the threshold exceeds every gap", () => {
    const albums = clusterByGap(photos, 100 * H);
    expect(albums).toHaveLength(1);
    expect(albums[0].ids).toEqual([1, 2, 3, 4]);
  });

  it("makes one album per photo when the threshold is below every gap", () => {
    const albums = clusterByGap(photos, 0);
    expect(albums.map((a) => a.ids)).toEqual([[1], [2], [3], [4]]);
  });

  it("returns nothing for no photos", () => {
    expect(clusterByGap([], 1)).toEqual([]);
  });
});

describe("autoThresholdMs", () => {
  it("is mean + k·stddev (k defaults to 2)", () => {
    const stats = { mean: 2 * H, stdev: 1 * H };
    expect(autoThresholdMs(stats)).toBe(4 * H);
    expect(autoThresholdMs(stats, 3)).toBe(5 * H);
  });
});

describe("defaultAlbumName", () => {
  it("formats the start date as YYYY-MM-DD", () => {
    const d = new Date(2024, 6, 6, 9, 30); // local time, Jul 6 2024
    expect(defaultAlbumName(d.getTime())).toBe("2024-07-06");
  });
});
