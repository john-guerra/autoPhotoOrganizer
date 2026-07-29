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
} from "./lasso.js";
import {
  shouldDrawImages,
  imageSide,
  dotRadius,
  MIN_RADIUS,
  MAX_RADIUS,
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

  it("catches 25,000 points in under a frame", () => {
    // The lasso runs on release with the whole map loaded. If this is not
    // sub-frame the count lags the cursor and the drag stutters.
    const n = 25_000;
    const xs = new Float32Array(n);
    const ys = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = (i % 500) / 10;
      ys[i] = Math.floor(i / 500) / 10;
    }
    const ix = buildIndex(xs, ys);
    const poly = [
      [0, 0],
      [25, 0],
      [25, 3],
      [0, 3],
    ];
    const t0 = performance.now();
    const got = caught(ix, poly);
    const ms = performance.now() - t0;
    expect(got.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(16);
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

  it("keeps the drawn image between a legible floor and a sane ceiling", () => {
    expect(imageSide(12)).toBeGreaterThanOrEqual(16);
    expect(imageSide(10_000)).toBeLessThanOrEqual(96);
  });

  it("sizes dots on a SQRT scale, so AREA tracks the weight", () => {
    // sqrt, not linear: a person in 3,512 faces exists in this library, and a
    // linear radius would give them 100x the area of a 4-photo person for 100x
    // the weight — reading as two orders of magnitude more than it is.
    //
    // Compared BELOW the cap on purpose. At the extremes both curves clamp, so
    // a test there compares the cap with the cap and passes against a linear
    // implementation — which is exactly what an earlier version of this did.
    //
    // Quadrupling the weight should roughly DOUBLE the radius above the floor.
    const r = (w) => dotRadius(w, 1) - MIN_RADIUS;
    expect(r(16) / r(4)).toBeCloseTo(2, 1);
    expect(r(100) / r(25)).toBeCloseTo(2, 1);
    // ...which a linear scale could not do (it would be 4x).
    expect(r(16) / r(4)).toBeLessThan(3);
  });

  it("anchors both ends: clickable at the tail, not a blob at the head", () => {
    // Most points weigh 1 — they must still be hittable. And the handful of
    // enormous ones must not swallow the neighbours you are trying to lasso.
    expect(dotRadius(1, 1)).toBeGreaterThanOrEqual(MIN_RADIUS);
    expect(dotRadius(0, 1)).toBeGreaterThanOrEqual(MIN_RADIUS);
    expect(dotRadius(3512, 400)).toBeLessThanOrEqual(MAX_RADIUS);
    expect(dotRadius(1e9, 400)).toBeLessThanOrEqual(MAX_RADIUS);
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
