import { describe, it, expect } from "vitest";
import { analyzedDomain, nearestPhoto, albumAtTime } from "./albumTimeline.js";
import { albumColor, ALBUM_SCHEME_SIZE } from "./albumColors.js";
import { clusterByGap } from "./albums.js";

const HOUR = 3600e3;
const DAY = 24 * HOUR;

describe("analyzedDomain", () => {
  it("spans the photos that were actually clustered", () => {
    const photos = [{ t: 100 }, { t: 500 }, { t: 900 }];
    expect(analyzedDomain(photos)).toEqual([100, 900]);
  });

  it("returns null when there is nothing to draw", () => {
    expect(analyzedDomain([])).toBe(null);
    expect(analyzedDomain(undefined)).toBe(null);
  });

  it("survives a folder where every photo shares one timestamp", () => {
    // Real: a batch of scans all stamped with the same mtime. A zero-width span
    // is the truth — the chart has to cope, not this function.
    expect(analyzedDomain([{ t: 7 }, { t: 7 }, { t: 7 }])).toEqual([7, 7]);
  });

  it("ignores photos with no usable time rather than poisoning the domain to NaN", () => {
    const photos = [{ t: 100 }, { t: NaN }, { t: undefined }, { t: 900 }];
    expect(analyzedDomain(photos)).toEqual([100, 900]);
  });

  it("returns null when NO photo has a usable time", () => {
    expect(analyzedDomain([{ t: NaN }, { t: null }])).toBe(null);
  });
});

describe("nearestPhoto", () => {
  const times = [0, 10, 20, 30, 100];

  it("finds the photo under the cursor", () => {
    expect(nearestPhoto(times, 20)).toBe(2);
  });

  it("picks the closer of the two neighbours, on both sides of the midpoint", () => {
    expect(nearestPhoto(times, 14)).toBe(1); // 10 is closer than 20
    expect(nearestPhoto(times, 16)).toBe(2); // 20 is closer than 10
  });

  it("clamps outside the domain instead of returning nothing", () => {
    expect(nearestPhoto(times, -1e9)).toBe(0);
    expect(nearestPhoto(times, 1e9)).toBe(times.length - 1);
  });

  it("returns -1 for an empty set", () => {
    expect(nearestPhoto([], 5)).toBe(-1);
    expect(nearestPhoto(times, NaN)).toBe(-1);
  });

  // A hand-rolled binary search is precisely where an off-by-one hides, and a
  // hover that lands on the neighbouring photo is invisible in a screenshot.
  // So: check it against the definition itself, over random data.
  it("agrees with a linear scan, always", () => {
    let seed = 42;
    const rnd = () =>
      (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(rnd() * 40);
      const ts = Array.from({ length: n }, () => Math.floor(rnd() * 1000)).sort(
        (a, b) => a - b
      );
      for (let probe = 0; probe < 20; probe++) {
        const t = Math.floor(rnd() * 1200) - 100; // deliberately overshoots both ends

        const got = nearestPhoto(ts, t);
        let best = 0;
        for (let i = 1; i < ts.length; i++) {
          if (Math.abs(ts[i] - t) < Math.abs(ts[best] - t)) best = i;
        }
        // Ties are legitimately ambiguous; only the DISTANCE has to be minimal.
        expect(Math.abs(ts[got] - t)).toBe(Math.abs(ts[best] - t));
      }
    }
  });
});

describe("albumAtTime", () => {
  // Two albums a week apart: exactly the shape the clustering produces.
  const albums = [
    { startAt: 0, endAt: 2 * HOUR },
    { startAt: 7 * DAY, endAt: 7 * DAY + HOUR },
  ];

  it("finds the album covering an instant, inclusive of its endpoints", () => {
    expect(albumAtTime(albums, HOUR)).toBe(0);
    expect(albumAtTime(albums, 0)).toBe(0); // startAt is a real photo's time
    expect(albumAtTime(albums, 2 * HOUR)).toBe(0); // and so is endAt
    expect(albumAtTime(albums, 7 * DAY)).toBe(1);
  });

  it("returns -1 INSIDE A GAP — which is the whole point of the chart", () => {
    expect(albumAtTime(albums, 3 * DAY)).toBe(-1);
  });

  it("returns -1 outside the analyzed range", () => {
    expect(albumAtTime(albums, -1)).toBe(-1);
    expect(albumAtTime(albums, 30 * DAY)).toBe(-1);
    expect(albumAtTime([], 5)).toBe(-1);
  });

  it("covers every photo that the clustering actually produced", () => {
    // The invariant that ties this module to albums.js: every photo belongs to
    // exactly one album, so no photo may land in a gap.
    const photos = [
      { id: 1, t: 0 },
      { id: 2, t: HOUR },
      { id: 3, t: 9 * DAY },
      { id: 4, t: 9 * DAY + HOUR },
      { id: 5, t: 40 * DAY },
    ];
    const clustered = clusterByGap(photos, DAY);
    expect(clustered.length).toBe(3);
    for (const p of photos) {
      expect(albumAtTime(clustered, p.t), `photo at ${p.t}`).not.toBe(-1);
    }
  });
});

describe("albumColor", () => {
  it("gives adjacent albums different colours — the only property it owes anyone", () => {
    for (let i = 0; i < 50; i++) {
      expect(albumColor(i), `album ${i}`).not.toBe(albumColor(i + 1));
    }
  });

  it("cycles, and says so: the 11th album reuses the 1st", () => {
    expect(albumColor(ALBUM_SCHEME_SIZE)).toBe(albumColor(0));
  });

  it("never returns undefined for a garbage index", () => {
    for (const bad of [-1, NaN, undefined, null, 1.5]) {
      expect(typeof albumColor(bad)).toBe("string");
    }
  });
});
