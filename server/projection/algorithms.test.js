import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  ALGORITHMS,
  TSNE_MAX_MEMBERS,
  offerableAlgorithms,
  isOfferable,
  defaultParams,
  allParamSpecs,
  paramsFor,
  DEFAULT_MIN_FACES,
  MIN_MEMBERS,
  tooFewMembers,
} from "./algorithms.js";

describe("offerableAlgorithms (#232)", () => {
  it("always offers UMAP, at every size", () => {
    // It is the only method measured that both scales to a whole library and
    // has usable neighbourhood fidelity, so it is the one that can never be
    // unavailable.
    for (const n of [10, 5_499, 25_758, 200_000]) {
      expect(isOfferable("umap", n)).toBe(true);
    }
  });

  it("offers t-SNE below the cap", () => {
    // 5,499 is the real working set (persons with >=2 faces) and t-SNE costs
    // about 2 minutes there — worth it for 93% top-5 against UMAP's 58%.
    expect(isOfferable("tsne", 5_499)).toBe(true);
    expect(isOfferable("tsne", TSNE_MAX_MEMBERS)).toBe(true);
  });

  it("refuses t-SNE above the cap WITH A REASON, rather than hiding it", () => {
    // t-SNE is O(n^2): 74s at 4,072 points measured, so ~47 minutes at
    // 25,758. Silently dropping the option would read as a missing feature;
    // offering it would wedge the app. Disabled-with-a-reason is the only
    // honest third answer.
    expect(isOfferable("tsne", TSNE_MAX_MEMBERS + 1)).toBe(false);
    const row = offerableAlgorithms(25_758).find((a) => a.id === "tsne");
    expect(row).toBeDefined();
    expect(row.enabled).toBe(false);
    expect(row.reason).toMatch(/6,000/);
    expect(row.reason).toMatch(/minimum faces/i);
  });

  it("never offers the algorithms that measured at chance", () => {
    // SQDMDS scored 0.0% twin-is-nearest with a median rank of 1822, and MDS
    // 2.8%, on the time-split test. Those are not choices, they are traps —
    // and SQDMDS scores 100% on a naive benchmark, so it WILL be re-proposed.
    for (const n of [100, 5_499, 25_758]) {
      const ids = offerableAlgorithms(n).map((a) => a.id);
      expect(ids).not.toContain("sqdmds");
      expect(ids).not.toContain("mds");
      expect(ids).not.toContain("fastmap");
    }
  });

  it("every option carries a label and a note with its measured score", () => {
    // The note is what turns a menu of three options, two of which are worse,
    // from a footgun into information.
    for (const a of offerableAlgorithms(5_499)) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.note.length).toBeGreaterThan(0);
      expect(a.note).toMatch(/\d/);
    }
    expect(ALGORITHMS.map((a) => a.id)).toEqual(["umap", "tsne", "pca"]);
  });

  it("is total: an unknown algorithm is not offerable rather than throwing", () => {
    expect(isOfferable("nope", 100)).toBe(false);
    expect(isOfferable(undefined, 100)).toBe(false);
  });

  it("handles a nonsense member count without throwing", () => {
    for (const n of [0, -1, NaN, undefined, null]) {
      expect(Array.isArray(offerableAlgorithms(n))).toBe(true);
    }
  });
});

describe("per-algorithm parameters (#237)", () => {
  it("gives each algorithm ITS OWN parameters", () => {
    // The gear shipped with UMAP's two knobs hardcoded, so choosing t-SNE
    // offered nothing to tune and its perplexity was frozen in the worker.
    const keys = (id) => allParamSpecs(id).map((s) => s.key);
    expect(keys("umap")).toContain("nNeighbors");
    expect(keys("umap")).not.toContain("perplexity");
    expect(keys("tsne")).toContain("perplexity");
    expect(keys("tsne")).toContain("epsilon");
    expect(keys("tsne")).not.toContain("nNeighbors");
  });

  it("honours a t-SNE parameter instead of ignoring it", () => {
    // The bug: perplexity was hardcoded in worker.js, so this value never
    // reached the projection at all.
    expect(
      defaultParams({ algorithm: "tsne", perplexity: 45 }).perplexity
    ).toBe(45);
    expect(defaultParams({ algorithm: "tsne", epsilon: 120 }).epsilon).toBe(
      120
    );
  });

  it("clamps every parameter from its OWN spec, not a hand-written list", () => {
    const p = defaultParams({
      algorithm: "tsne",
      perplexity: 99999,
      epsilon: -50,
    });
    expect(p.perplexity).toBeLessThanOrEqual(100);
    expect(p.epsilon).toBeGreaterThanOrEqual(1);
  });

  it("drops a parameter that belongs to a DIFFERENT algorithm", () => {
    // Otherwise a stale field from the previously-selected algorithm rides
    // into the cache key and every request misses.
    const p = defaultParams({ algorithm: "tsne", nNeighbors: 40 });
    expect("nNeighbors" in p).toBe(false);
  });

  it("gives PCA no tunables, and still an nEpochs for the job's total", () => {
    // PCA is deterministic with nothing to tune — the gear says so rather than
    // rendering an empty panel. But the job's total is read before the worker
    // starts, so nEpochs must exist regardless (#208).
    expect(paramsFor("pca")).toEqual([]);
    expect(defaultParams({ algorithm: "pca" }).nEpochs).toBeGreaterThan(0);
  });

  it("every spec is renderable: bounds, a step, a default and help text", () => {
    // The gear renders these directly, so a spec missing a bound is a control
    // with no limit and a spec missing help is a number nobody can interpret.
    for (const a of ALGORITHMS) {
      for (const s of allParamSpecs(a.id)) {
        expect(typeof s.label).toBe("string");
        expect(s.label.length).toBeGreaterThan(0);
        expect(s.help.length).toBeGreaterThan(10);
        expect(s.min).toBeLessThan(s.max);
        expect(s.step).toBeGreaterThan(0);
        expect(s.default).toBeGreaterThanOrEqual(s.min);
        expect(s.default).toBeLessThanOrEqual(s.max);
      }
    }
  });

  it("snaps whole-number parameters but keeps fractional ones", () => {
    // nEpochs drives the job's total; a fractional total is a bar that never
    // reaches 100%. minDist is genuinely fractional and must not be truncated
    // to 0.
    expect(defaultParams({ algorithm: "umap", nEpochs: 200.7 }).nEpochs).toBe(
      200
    );
    expect(defaultParams({ algorithm: "umap", minDist: 0.35 }).minDist).toBe(
      0.35
    );
  });
});

describe("defaultParams", () => {
  it("defaults minFaces to 5 — the map is for people you can name (#255)", () => {
    // Not a tuning knob picked for speed. At 2, a real library's map is
    // dominated BY COUNT by two-face groups that are detection noise or a
    // stranger in the background, and they crowd out the people you came to
    // find and merge. (Cheapness follows: at 2 it was already 5,499 members
    // instead of 25,758, initializeFit 14.1s -> 2.1s, peak RSS 1,825MB ->
    // 824MB; 5 is cheaper still.)
    expect(defaultParams().minFaces).toBe(5);
    expect(DEFAULT_MIN_FACES).toBe(5);
  });

  it("is the SAME number the gear renders, not a second copy", () => {
    // The gear seeds every control from `paramSpecs[].default`, so a spec
    // default that drifted from `DEFAULT_MIN_FACES` would show one number and
    // run another, with nothing failing.
    const spec = allParamSpecs("umap").find((s) => s.key === "minFaces");
    expect(spec.default).toBe(DEFAULT_MIN_FACES);
    expect(defaultParams().minFaces).toBe(spec.default);
  });

  it("names nEpochs EXPLICITLY rather than leaving it to umap-js's heuristic", () => {
    // umap-js picks 500/400/300/200 by point count. Leaving it implicit would
    // mean the job's total is unknown until the worker starts, which is a bar
    // that arrives late at exactly the moment the user is deciding whether it
    // hung (#208) — and it would make the run cache key incomplete.
    expect(defaultParams().nEpochs).toBeGreaterThan(0);
    expect(Number.isInteger(defaultParams().nEpochs)).toBe(true);
  });

  it("carries a fixed seed, so a run is reproducible", () => {
    expect(defaultParams().seed).toBe(defaultParams().seed);
    expect(Number.isFinite(defaultParams().seed)).toBe(true);
  });

  it("clamps hostile input rather than passing it to the worker", () => {
    // These arrive from a JSON body. nNeighbors <= 1 or nEpochs of 0 produce
    // a degenerate or empty layout, and a huge nEpochs is a job nobody asked
    // to wait for.
    const p = defaultParams({
      minFaces: -5,
      nNeighbors: 0,
      nEpochs: 10 ** 9,
      minDist: -1,
    });
    expect(p.minFaces).toBeGreaterThanOrEqual(1);
    expect(p.nNeighbors).toBeGreaterThanOrEqual(2);
    expect(p.nEpochs).toBeLessThanOrEqual(2000);
    expect(p.minDist).toBeGreaterThanOrEqual(0);
  });

  it("keeps only known keys, so the cache key cannot be polluted", () => {
    // The params object IS the cache key. An unknown field riding along would
    // make every request a cache miss and recompute a 20-second map forever.
    const p = defaultParams({ minFaces: 3, evil: "x", __proto__: { y: 1 } });
    expect(Object.keys(p).sort()).toEqual(
      ["minDist", "minFaces", "nEpochs", "nNeighbors", "seed"].sort()
    );
  });
});

describe("UMAP's default neighbourhood (#326)", () => {
  it("defaults to 30 — the value John picked on his own library", () => {
    // Still chosen by LOOKING rather than by theory, but by looking at forty
    // projections instead of one screenshot: a sweep of eight neighbourhood
    // values across five photo scopes of the real library, John picking the
    // best cell in each. 30 is his pick for the WHOLE-LIBRARY case, which is
    // the case a default actually serves.
    const umap = ALGORITHMS.find((a) => a.id === "umap");
    const n = umap.params.find((p) => p.key === "nNeighbors");
    expect(n.default).toBe(30);
    expect(n.default).toBeGreaterThanOrEqual(n.min);
    expect(n.default).toBeLessThanOrEqual(n.max);
  });

  it("keeps the measured note honest about WHICH setting it measured", () => {
    // The 58.3% top-5 figure was measured at nNeighbors=15 and is no longer
    // the default. A measured number attached to the wrong configuration is
    // worse than no number — this repo has been bitten twice this week by
    // comments describing states that do not exist (#250, #279).
    const src = readFileSync(
      new URL("./algorithms.js", import.meta.url),
      "utf8"
    );
    expect(src).toMatch(/58\.3% top-5.*nNeighbors=15/);
  });

  it("records that the default must NOT be derived from the member count", () => {
    // #307's note argued the opposite — "a default derived from the point
    // count would preserve what he actually saw" — and that idea was tested
    // and refuted (#326): two scopes of nearly the same size want values 2.4x
    // apart, so no f(members) can return both. The refutation lives in a
    // comment, so a test keeps the comment alive, exactly like the 58.3%
    // assertion above. Without it the next agent re-derives the idea, which is
    // how #307 shipped in the first place.
    const src = readFileSync(
      new URL("./algorithms.js", import.meta.url),
      "utf8"
    );
    expect(src).toMatch(/do not derive this from the member count/i);
  });
});

describe("tooFewMembers — preview and Apply refuse at the SAME size (#345)", () => {
  it("accepts every size Apply accepts, starting at three", () => {
    // The bug was a preview that refused what Apply would run: 3-4 people
    // could commit a map they could never look at first. One constant, so the
    // question "is this enough to be a map?" has exactly one answer.
    expect(MIN_MEMBERS).toBe(3);
    for (const n of [3, 4, 5, 40]) expect(tooFewMembers(n, 5)).toBeNull();
  });

  it("refuses below it, and says what to DO about it", () => {
    // Two different next steps, so a shared refusal must not flatten them into
    // one sentence: nobody qualifying means the faces are not grouped yet,
    // while two qualifying means the threshold is too high.
    expect(tooFewMembers(0, 5)).toMatch(/group faces first/i);
    expect(tooFewMembers(1, 5)).toMatch(/1 person has/);
    expect(tooFewMembers(2, 5)).toMatch(/2 people have/);
    for (const n of [0, 1, 2]) {
      expect(tooFewMembers(n, 5)).toMatch(/lower the minimum/i);
      expect(tooFewMembers(n, 5)).toContain("5");
    }
  });
});
