import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  toScreen,
  toData,
  fitExtent,
  clampZoom,
  zoomAbout,
  MAX_ZOOM,
} from "./transform.js";
import { buildIndex, nearest } from "./hit.js";
import {
  pointInPolygon,
  polygonBBox,
  simplify,
  caught,
  applyLasso,
  lassoStats,
} from "./lasso.js";
import {
  shouldDrawImages,
  imageSide,
  dotRadius,
  sizeAnchor,
  zoomGain,
  clampRadius,
  DEFAULT_MIN_RADIUS,
  DEFAULT_MAX_RADIUS,
  RADIUS_LIMITS,
  MIN_IMAGE_SIDE,
} from "./lod.js";

describe("transform", () => {
  it("round-trips screen and data space", () => {
    // Hover, lasso and draw all go through this pair. A mismatch is a hover
    // ring on one dot and a click on its neighbour.
    const t = { k: 2.5, tx: 40, ty: -12 };
    const [px, py] = toScreen(3, -7, t);
    const [x, y] = toData(px, py, t);
    expect(x).toBeCloseTo(3, 9);
    expect(y).toBeCloseTo(-7, 9);
  });

  it("fitExtent puts every point inside the viewport", () => {
    const xs = Float32Array.from([-5, 0, 11]);
    const ys = Float32Array.from([2, -3, 8]);
    const t = fitExtent(xs, ys, 800, 600, 20);
    for (let i = 0; i < xs.length; i++) {
      const [px, py] = toScreen(xs[i], ys[i], t);
      expect(px).toBeGreaterThanOrEqual(0);
      expect(px).toBeLessThanOrEqual(800);
      expect(py).toBeGreaterThanOrEqual(0);
      expect(py).toBeLessThanOrEqual(600);
    }
  });

  it("survives a degenerate extent rather than painting nothing", () => {
    // Every point identical divides by zero and puts k at Infinity, which
    // paints an empty canvas — indistinguishable from a broken view.
    for (const [xs, ys] of [
      [Float32Array.from([4, 4]), Float32Array.from([9, 9])],
      [Float32Array.from([4]), Float32Array.from([9])],
    ]) {
      const t = fitExtent(xs, ys, 800, 600, 20);
      expect(Number.isFinite(t.k)).toBe(true);
      // Finiteness alone is too weak to catch the real failure: a zero span
      // divides to Infinity, and clampZoom's non-finite fallback then quietly
      // yields k = 1 — a one-point map rendered unzoomed rather than fitted.
      // Assert it is actually ZOOMED IN.
      expect(t.k).toBeGreaterThan(1);
      // ...and that the point still lands in the middle of the viewport.
      const [px, py] = toScreen(xs[0], ys[0], t);
      expect(px).toBeCloseTo(400, 0);
      expect(py).toBeCloseTo(300, 0);
    }
  });

  it("survives an empty point set and a zero-sized viewport", () => {
    // Both happen for a frame before layout settles, and a canvas sized 0
    // throws — which would fail trackPageErrors.
    expect(Number.isFinite(fitExtent([], [], 800, 600).k)).toBe(true);
    const t = fitExtent(
      Float32Array.from([1, 2]),
      Float32Array.from([1, 2]),
      0,
      0
    );
    expect(Number.isFinite(t.k)).toBe(true);
  });

  it("ignores a non-finite point instead of collapsing the whole map", () => {
    // One NaN would make every bound NaN and put every other dot in a corner.
    const xs = Float32Array.from([0, 10, NaN]);
    const ys = Float32Array.from([0, 10, 5]);
    const t = fitExtent(xs, ys, 800, 600, 20);
    expect(Number.isFinite(t.k)).toBe(true);
    const [px] = toScreen(10, 10, t);
    expect(Number.isFinite(px)).toBe(true);
  });

  it("clamps zoom rather than letting it run away", () => {
    expect(clampZoom(1e9)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBeGreaterThan(0);
    expect(clampZoom(NaN)).toBeGreaterThan(0);
  });

  it("zoomAbout keeps the point under the cursor under the cursor", () => {
    // Getting this wrong is a map that slides away as you scroll — the single
    // most disorienting thing a zoomable view can do.
    const t = { k: 3, tx: 100, ty: 50 };
    const [px, py] = [420, 300];
    const before = toData(px, py, t);
    const after = toData(px, py, zoomAbout(t, 1.7, px, py));
    expect(after[0]).toBeCloseTo(before[0], 6);
    expect(after[1]).toBeCloseTo(before[1], 6);
  });
});

describe("hit", () => {
  it("finds the nearest point and returns -1 outside the radius", () => {
    const xs = Float32Array.from([0, 10, 20]);
    const ys = Float32Array.from([0, 10, 20]);
    const ix = buildIndex(xs, ys);
    expect(nearest(ix, 10.4, 9.6, 2)).toBe(1);
    // -1, matching hitAt's convention, so a caller cannot mistake "nothing"
    // for index 0.
    expect(nearest(ix, 100, 100, 2)).toBe(-1);
  });

  it("skips non-finite points rather than poisoning the tree", () => {
    const ix = buildIndex(
      Float32Array.from([0, NaN, 20]),
      Float32Array.from([0, 5, 20])
    );
    expect(nearest(ix, 0.1, 0.1, 2)).toBe(0);
    expect(nearest(ix, 20.1, 20.1, 2)).toBe(2);
  });

  it("answers -1 for a nonsense query instead of throwing", () => {
    const ix = buildIndex(Float32Array.from([1]), Float32Array.from([1]));
    expect(nearest(ix, NaN, 1, 2)).toBe(-1);
    expect(nearest(null, 1, 1, 2)).toBe(-1);
  });
});

describe("lasso", () => {
  const square = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];

  it("includes an interior point and excludes an exterior one", () => {
    expect(pointInPolygon(5, 5, square)).toBe(true);
    expect(pointInPolygon(15, 5, square)).toBe(false);
    expect(pointInPolygon(5, 15, square)).toBe(false);
  });

  it("is DECISIVE and STABLE on a vertex and an edge", () => {
    // Ray casting's classic off-by-one. Whatever the answer is, it must be a
    // boolean and it must be the same every time — otherwise a point flickers
    // in and out of the selection as the polygon is redrawn, and the live
    // count disagrees with the tray.
    for (const [x, y] of [
      [0, 0],
      [5, 0],
      [10, 10],
      [0, 5],
    ]) {
      const first = pointInPolygon(x, y, square);
      expect(typeof first).toBe("boolean");
      expect(pointInPolygon(x, y, square)).toBe(first);
      expect(pointInPolygon(x, y, square)).toBe(first);
    }
  });

  it("handles a self-intersecting polygon without throwing", () => {
    // A real lasso crosses itself constantly.
    const bowtie = [
      [0, 0],
      [10, 10],
      [10, 0],
      [0, 10],
    ];
    expect(typeof pointInPolygon(5, 5, bowtie)).toBe("boolean");
    expect(typeof pointInPolygon(2, 5, bowtie)).toBe("boolean");
  });

  it("returns NOTHING for a polygon with fewer than three points", () => {
    // A stray click must not select the library.
    const ix = buildIndex(Float32Array.from([1, 2]), Float32Array.from([1, 2]));
    expect(caught(ix, [])).toEqual([]);
    expect(caught(ix, [[0, 0]])).toEqual([]);
    expect(
      caught(ix, [
        [0, 0],
        [1, 1],
      ])
    ).toEqual([]);
  });

  it("catches exactly the enclosed points, in index order", () => {
    const xs = Float32Array.from([1, 5, 50, 9]);
    const ys = Float32Array.from([1, 5, 50, 9]);
    const ix = buildIndex(xs, ys);
    expect(caught(ix, square)).toEqual([0, 1, 3]);
  });

  it("polygonBBox bounds the path", () => {
    expect(polygonBBox(square)).toEqual([0, 0, 10, 10]);
  });

  it("simplify drops dense vertices but KEEPS the final one", () => {
    // Dropping the last vertex leaves a visible gap between the path drawn and
    // the polygon actually tested.
    const path = Array.from({ length: 50 }, (_, i) => [i * 0.1, 0]);
    const s = simplify(path, 2);
    expect(s.length).toBeLessThan(path.length);
    expect(s[0]).toEqual(path[0]);
    expect(s[s.length - 1]).toEqual(path[path.length - 1]);
  });

  it("PRUNES: a small lasso over a big map tests only nearby points", () => {
    // The lasso runs on release with the whole map loaded, so its cost has to
    // track what it encloses rather than the map's size — otherwise the count
    // lags the cursor on a real library.
    //
    // Asserted by COUNTING COMPARISONS, not by the clock. The obvious version
    // ("finishes in under 16ms") passed locally and failed CI at 24ms, which
    // is precisely what queryPlan.test.js warns about: a timing test only ever
    // fails on someone's slower machine. Comparisons give the same answer
    // everywhere.
    const n = 25_000;
    const xs = new Float32Array(n);
    const ys = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = (i % 500) / 10; // a 50 x 50 grid of points
      ys[i] = Math.floor(i / 500) / 10;
    }
    const ix = buildIndex(xs, ys);

    // A lasso over roughly 1/25th of the extent.
    const small = [
      [0, 0],
      [10, 0],
      [10, 5],
      [0, 5],
    ];
    const got = caught(ix, small);
    expect(got.length).toBeGreaterThan(0);
    // Without pruning this would be all 25,000. Generous bound: the quadtree
    // visits whole nodes, so it tests somewhat more than it returns.
    expect(lassoStats.tested).toBeLessThan(n / 4);

    // And the whole map still works — pruning must not lose points.
    const all = caught(ix, [
      [-1, -1],
      [100, -1],
      [100, 100],
      [-1, 100],
    ]);
    expect(all.length).toBe(n);
  });
});

describe("applyLasso", () => {
  const sel = new Set([1, 2, 3]);

  it("replaces by default", () => {
    expect([...applyLasso(sel, [7, 8])]).toEqual([7, 8]);
  });

  it("shift adds, alt subtracts — the d3 idiom", () => {
    // Building a selection over several passes is the whole reason the tray
    // can be assembled from a crowded map.
    expect([...applyLasso(sel, [3, 4], { shift: true })].sort()).toEqual([
      1, 2, 3, 4,
    ]);
    expect([...applyLasso(sel, [2, 9], { alt: true })].sort()).toEqual([1, 3]);
  });

  it("never mutates the set it was given, so Svelte sees the change", () => {
    // A mutated Set is the same reference, and $state would not re-render.
    const next = applyLasso(sel, [9], { shift: true });
    expect(next).not.toBe(sel);
    expect([...sel]).toEqual([1, 2, 3]);
  });
});

describe("lod", () => {
  it("draws dots when zoomed out and images when zoomed in", () => {
    expect(shouldDrawImages(0.5)).toBe(false);
    expect(shouldDrawImages(50)).toBe(true);
    expect(shouldDrawImages(NaN)).toBe(false);
  });

  it("sizes points on a SQRT scale, so AREA tracks the weight", () => {
    // sqrt, not linear: a person in 400 photos should not read as 100x the
    // presence of one in 4.
    const anchor = { lo: 0, hi: 100 };
    const floor = DEFAULT_MIN_RADIUS * zoomGain(100);
    const r = (w) => dotRadius(w, 100, anchor) - floor;
    // Quadrupling the weight doubles the radius above the floor.
    expect(r(16) / r(4)).toBeCloseTo(2, 1);
    expect(r(64) / r(16)).toBeCloseTo(2, 1);
    expect(r(16) / r(4)).toBeLessThan(3); // a linear scale would be 4x
  });

  it("anchors to a QUANTILE, so one giant does not flatten everyone", () => {
    // The failure this exists to stop: photo counts are extremely skewed, and
    // anchoring to the maximum spends the whole radius range on a single
    // 3,512-photo person, rendering the other 5,498 within a few pixels of
    // each other. That is "they all look the same size".
    const weights = [
      ...Array(5000).fill(1),
      ...Array(400).fill(5),
      ...Array(80).fill(30),
      3512,
    ];
    const anchor = sizeAnchor(weights);
    expect(anchor.hi).toBeLessThan(100);
    expect(anchor.hi).toBeGreaterThan(anchor.lo);

    // With the quantile anchor the COMMON range is visibly separated...
    const k = 100;
    const spread = dotRadius(5, k, anchor) - dotRadius(1, k, anchor);
    expect(spread).toBeGreaterThan(4);

    // ...whereas anchoring to the max collapses it.
    const flat =
      dotRadius(5, k, { lo: 1, hi: 3512 }) -
      dotRadius(1, k, { lo: 1, hi: 3512 });
    expect(flat).toBeLessThan(spread / 3);
  });

  it("clamps above the anchor rather than growing without bound", () => {
    const anchor = { lo: 0, hi: 10 };
    expect(dotRadius(1e6, 100, anchor)).toBeCloseTo(
      dotRadius(10, 100, anchor),
      5
    );
  });

  it("draws UNIFORM data at the floor, not all at the ceiling", () => {
    // A young library — everyone in the same number of photos — has nothing to
    // encode. Drawing every point at the maximum says "these are all
    // enormous" and merges the map into one blob, which is what the e2e
    // fixture actually looked like.
    const uniform = sizeAnchor(Array(120).fill(2));
    expect(uniform.lo).toBe(uniform.hi);
    expect(dotRadius(2, 1, uniform)).toBeCloseTo(DEFAULT_MIN_RADIUS, 5);
  });

  it("uses the configured range at base zoom", () => {
    // The defaults John asked for: 1.5px for the long tail, 20px at the top.
    // Hit-testing does not use the radius, so 1.5 is still easy to click.
    expect(DEFAULT_MIN_RADIUS).toBe(1.5);
    expect(DEFAULT_MAX_RADIUS).toBe(20);
    const anchor = { lo: 0, hi: 10 };
    expect(dotRadius(anchor.lo, 1, anchor)).toBeCloseTo(1.5, 5);
    expect(dotRadius(anchor.hi, 1, anchor)).toBeCloseTo(20, 5);
  });

  it("honours a CUSTOM range, so the gear controls actually do something", () => {
    const anchor = { lo: 0, hi: 10 };
    expect(dotRadius(anchor.lo, 1, anchor, 4, 40)).toBeCloseTo(4, 5);
    expect(dotRadius(anchor.hi, 1, anchor, 4, 40)).toBeCloseTo(40, 5);
    const r = (w) => dotRadius(w, 1, { lo: 0, hi: 100 }, 4, 40) - 4;
    expect(r(16) / r(4)).toBeCloseTo(2, 1); // sqrt survives a custom range
  });

  it("clamps a nonsense range rather than producing an unusable map", () => {
    expect(clampRadius(-5, 1.5)).toBe(RADIUS_LIMITS.min);
    expect(clampRadius(1e6, 1.5)).toBe(RADIUS_LIMITS.max);
    expect(clampRadius("x", 1.5)).toBe(1.5);
    // An inverted range must not invert the scale.
    expect(dotRadius(10, 1, 10, 30, 5)).toBeGreaterThanOrEqual(
      dotRadius(0, 1, 10, 30, 5)
    );
  });

  it("grows with zoom, so zooming in enlarges faces rather than only spreading them", () => {
    const anchor = { lo: 0, hi: 20 };
    expect(zoomGain(500)).toBeGreaterThan(zoomGain(20));
    expect(dotRadius(10, 500, anchor)).toBeGreaterThan(
      dotRadius(10, 20, anchor)
    );
    // The gain applies to the WHOLE range, so the ratio the user configured
    // survives zooming — which is what stops faces flattening out at exactly
    // the zoom where you are reading them.
    const near = dotRadius(10, 20, anchor) / dotRadius(1, 20, anchor);
    const far = dotRadius(10, 500, anchor) / dotRadius(1, 500, anchor);
    expect(far).toBeCloseTo(near, 5);
    // ...but bounded, or one face fills the viewport.
    expect(zoomGain(1e9)).toBeLessThanOrEqual(6);
  });

  it("draws a crop at the POINT's size, so faces carry the encoding too", () => {
    // The bug this pins: `imageSide` used to depend only on zoom, so at the
    // very zoom where you read faces every person was drawn identically and
    // the size encoding disappeared.
    const anchor = { lo: 0, hi: 50 };
    const small = imageSide(100, 1, anchor);
    const big = imageSide(100, 50, anchor);
    expect(big).toBeGreaterThan(small * 1.5);
    expect(small).toBeGreaterThanOrEqual(MIN_IMAGE_SIDE);
  });

  it("sizeAnchor is total for empty or nonsense input", () => {
    expect(sizeAnchor([])).toEqual({ lo: 0, hi: 1 });
    expect(sizeAnchor(null)).toEqual({ lo: 0, hi: 1 });
    expect(sizeAnchor([0, 0, 0])).toEqual({ lo: 0, hi: 0 });
  });
});

describe("the #165 seam", () => {
  it("the scatter modules know NOTHING about people or photos", () => {
    // This is what makes #165's photo scatter an entry plus a component
    // rather than a rewrite, and it is enforced rather than intended: the
    // moment a domain word appears here, the seam has cracked.
    const files = readdirSync(new URL(".", import.meta.url)).filter(
      (f) => f.endsWith(".js") && !f.endsWith(".test.js")
    );
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const raw = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");

      // COMMENTS ARE EXEMPT, and deliberately so: the invariant worth
      // enforcing is that no domain concept appears in an identifier, a
      // string, or an import — not that the docs may never explain which
      // feature motivated the module. A doc comment saying "a wrong lasso
      // leads to a durable wrong merge" is exactly the context a reader
      // needs; a variable called `personIndex` is the seam cracking.
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");

      expect(code, `${f} names a domain concept in its CODE`).not.toMatch(
        /\bperson\b|\bpersons\b|\bpeople\b|\bfaces?\b|\bphotos?\b/i
      );
      expect(code, `${f} imports the API`).not.toMatch(
        /from ["'][^"']*api\.js["']/
      );
    }
  });
});
