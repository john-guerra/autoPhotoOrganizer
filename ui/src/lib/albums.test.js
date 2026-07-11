import { describe, it, expect } from "vitest";
import {
  computeGapStats,
  autoThresholdMs,
  clusterByGap,
  defaultAlbumName,
  renderAlbumName,
  computeAlbumNames,
  parseDuration,
  fmtDur,
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

describe("renderAlbumName", () => {
  // 2017-01-09 14:30 local. Build via components so the test is TZ-stable.
  const d = new Date(2017, 0, 9, 14, 30, 0);

  it("renders strftime date tokens", () => {
    expect(renderAlbumName("%Y-%m-%d", d, 1)).toBe("2017-01-09");
    expect(renderAlbumName("%Y_%m%b_%d", d, 1)).toBe("2017_01Jan_09");
  });

  it("renders the %n album index (1-based)", () => {
    expect(renderAlbumName("Album %n", d, 3)).toBe("Album 3");
    expect(renderAlbumName("%Y_%n", d, 12)).toBe("2017_12");
  });

  it("supports / for nested folders (year subfolder)", () => {
    expect(renderAlbumName("%Y/%Y_%m%b_%d", d, 1)).toBe("2017/2017_01Jan_09");
  });

  it("strips a leading slash and .. segments (stay relative, no traversal)", () => {
    expect(renderAlbumName("/%Y", d, 1)).toBe("2017");
    expect(renderAlbumName("../%Y", d, 1)).toBe("2017");
    expect(renderAlbumName("%Y/../x", d, 1)).toBe("2017/x");
  });

  it("falls back to Album {n} when the template renders empty", () => {
    expect(renderAlbumName("", d, 4)).toBe("Album 4");
    expect(renderAlbumName("   ", d, 4)).toBe("Album 4");
    expect(renderAlbumName("/", d, 4)).toBe("Album 4");
  });

  it("substitutes the {prefix} token with the (trimmed) prefix", () => {
    expect(renderAlbumName("%Y_{prefix}", d, 1, "Diana")).toBe("2017_Diana");
    expect(renderAlbumName("%Y_{prefix}", d, 1, "  Diana  ")).toBe(
      "2017_Diana"
    );
  });

  it("collapses a dangling separator when {prefix} is empty", () => {
    expect(renderAlbumName("%Y_{prefix}", d, 1)).toBe("2017");
    expect(renderAlbumName("%Y_{prefix}", d, 1, "")).toBe("2017");
    expect(renderAlbumName("{prefix}_%Y", d, 1, "")).toBe("2017");
  });

  it("combines {prefix} with %n", () => {
    expect(renderAlbumName("{prefix}_%n", d, 3, "Diana")).toBe("Diana_3");
  });
});

describe("computeAlbumNames", () => {
  const A = { startAt: new Date(2017, 0, 9).getTime(), ids: [10, 11, 12] };
  const B = { startAt: new Date(2017, 0, 11).getTime(), ids: [20, 21] };

  it("uses the template when no name was typed", () => {
    expect(computeAlbumNames([A, B], new Map(), "%Y-%m-%d")).toEqual([
      "2017-01-09",
      "2017-01-11",
    ]);
  });

  it("keeps a typed name keyed to the album's first photo", () => {
    const edited = new Map([[10, "Diana_VR"]]);
    expect(computeAlbumNames([A, B], edited, "%Y-%m-%d")).toEqual([
      "Diana_VR",
      "2017-01-11",
    ]);
  });

  it("drops a typed name once its album no longer starts with that photo", () => {
    const edited = new Map([[10, "Diana_VR"]]);
    // Re-clustered so the first album now starts at id 11, not 10.
    const A2 = { startAt: A.startAt, ids: [11, 12] };
    expect(computeAlbumNames([A2, B], edited, "%Y-%m-%d")).toEqual([
      "2017-01-09",
      "2017-01-11",
    ]);
  });

  it("threads prefix through to renderAlbumName for un-edited albums", () => {
    expect(
      computeAlbumNames([A, B], new Map(), "%Y_{prefix}", "Diana")
    ).toEqual(["2017_Diana", "2017_Diana"]);
  });
});

describe("parseDuration/fmtDur (moved from AlbumsView)", () => {
  it("parses compact durations", () => {
    expect(parseDuration("90m")).toBe(90 * 60000);
    expect(parseDuration("2d")).toBe(2 * 86400000);
    expect(parseDuration("garbage")).toBeNull();
  });
  it("formats a 1-minute gap", () => {
    expect(fmtDur(60000)).toBe("1 min");
  });
});
