import { describe, it, expect } from "vitest";
import {
  alignTo,
  easeInOut,
  delayFraction,
  progressAt,
  lerpTransform,
  TWEEN_MS,
  STAGGER_MS,
  TOTAL_MS,
  FIT_MS,
} from "./align.js";

/** RMS distance between two interleaved coordinate lists. */
function rms(a, b) {
  const n = a.length >> 1;
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += (a[i * 2] - b[i * 2]) ** 2 + (a[i * 2 + 1] - b[i * 2 + 1]) ** 2;
  }
  return Math.sqrt(s / n);
}

const BASE = Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1, 2, 0.5, -1, 0.5]);

/** Rotate, scale, translate and optionally reflect — all meaningless in UMAP. */
function transform(xy, { theta = 0, scale = 1, dx = 0, dy = 0, flip = 1 }) {
  const out = Float32Array.from(xy);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  for (let i = 0; i < xy.length >> 1; i++) {
    const x = xy[i * 2] * flip;
    const y = xy[i * 2 + 1];
    out[i * 2] = (x * c - y * s) * scale + dx;
    out[i * 2 + 1] = (x * s + y * c) * scale + dy;
  }
  return out;
}

describe("alignTo (#327)", () => {
  it("undoes a rotation completely", () => {
    const rotated = transform(BASE, { theta: 1.1 });
    expect(rms(BASE, rotated)).toBeGreaterThan(0.5);
    expect(rms(BASE, alignTo(BASE, rotated))).toBeLessThan(1e-4);
  });

  it("undoes scale and translation too", () => {
    const moved = transform(BASE, { theta: 0.4, scale: 7, dx: 100, dy: -40 });
    expect(rms(BASE, alignTo(BASE, moved))).toBeLessThan(1e-4);
  });

  it("undoes a REFLECTION, which is as meaningless as a rotation here", () => {
    // Without considering both handednesses, half of all maps come back
    // mirrored and every point animates across the screen for no reason.
    const mirrored = transform(BASE, { flip: -1, theta: 0.9 });
    expect(rms(BASE, alignTo(BASE, mirrored))).toBeLessThan(1e-4);
  });

  it("leaves a genuinely different layout different", () => {
    // The alignment must not flatten real change into no change — that would
    // be the warm-start failure in a new place (a smooth slider that does
    // nothing). One point moved a long way stays moved.
    const changed = Float32Array.from(BASE);
    changed[8] = 9;
    changed[9] = 9;
    const aligned = alignTo(BASE, changed);
    expect(rms(BASE, aligned)).toBeGreaterThan(0.5);
  });

  it("does not mutate its input", () => {
    const next = transform(BASE, { theta: 0.7 });
    const before = Array.from(next);
    alignTo(BASE, next);
    expect(Array.from(next)).toEqual(before);
  });

  it("survives degenerate input rather than emitting NaN", () => {
    // A single point has no orientation, and every coordinate identical has no
    // scale. One NaN poisons fitExtent for the whole map.
    const one = Float32Array.from([1, 2]);
    expect([...alignTo(one, one)].every(Number.isFinite)).toBe(true);
    const flat = Float32Array.from([3, 3, 3, 3, 3, 3]);
    expect([...alignTo(flat, flat)].every(Number.isFinite)).toBe(true);
  });
});

describe("the tween's shape", () => {
  it("eases in and out between 0 and 1", () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 5);
    // Slow at the ends, fast in the middle.
    expect(easeInOut(0.1)).toBeLessThan(0.1);
    expect(easeInOut(0.9)).toBeGreaterThan(0.9);
  });

  it("is long enough to read and short enough not to be in the way", () => {
    expect(TWEEN_MS).toBeGreaterThanOrEqual(250);
    expect(TWEEN_MS).toBeLessThanOrEqual(800);
  });
});

describe("the stagger (#327)", () => {
  it("spreads the starts across the whole window", () => {
    const n = 200;
    const d = Array.from({ length: n }, (_, i) => delayFraction(i, n));
    expect(Math.min(...d)).toBeLessThan(0.1);
    expect(Math.max(...d)).toBeGreaterThan(0.9);
    // Roughly uniform, not clustered at one end.
    const mean = d.reduce((a, b) => a + b, 0) / n;
    expect(mean).toBeGreaterThan(0.35);
    expect(mean).toBeLessThan(0.65);
  });

  it("does NOT sweep in index order", () => {
    // Delaying by index makes a wave cross the map in whatever order
    // persons.id happens to be — mechanical, and it implies an ordering that
    // does not exist. Consecutive points should not be consecutive starts.
    const n = 60;
    let ascending = 0;
    for (let i = 1; i < n; i++) {
      if (delayFraction(i, n) > delayFraction(i - 1, n)) ascending++;
    }
    expect(ascending).toBeGreaterThan(n * 0.25);
    expect(ascending).toBeLessThan(n * 0.75);
  });

  it("is deterministic, so the same change animates the same way", () => {
    expect(delayFraction(7, 100)).toBe(delayFraction(7, 100));
  });

  it("has no stagger when there is nothing to stagger", () => {
    expect(delayFraction(0, 1)).toBe(0);
    expect(delayFraction(NaN, 10)).toBe(0);
  });

  it("every point has finished by TOTAL_MS", () => {
    // Otherwise the animation ends while something is still mid-flight and the
    // map jumps to its resting frame — the snap this design already fixed once.
    expect(TOTAL_MS).toBe(TWEEN_MS + STAGGER_MS);
    expect(progressAt(TOTAL_MS, STAGGER_MS)).toBe(1);
  });

  it("holds a delayed point still until its turn", () => {
    expect(progressAt(0, 120)).toBe(0);
    expect(progressAt(100, 120)).toBe(0);
    expect(progressAt(120 + TWEEN_MS, 120)).toBe(1);
    expect(progressAt(120 + TWEEN_MS / 2, 120)).toBeCloseTo(0.5, 5);
  });
});

describe("the camera lead-in (#327)", () => {
  it("interpolates zoom in LOG space", () => {
    // k is a multiplier. Linearly, half way from 1 to 8 is 4.5 — nearly zoomed
    // in already — so the move spends its time at the wrong end and lurches.
    const mid = lerpTransform(
      { k: 1, tx: 0, ty: 0 },
      { k: 8, tx: 0, ty: 0 },
      0.5
    );
    expect(mid.k).toBeCloseTo(Math.sqrt(8), 4);
  });

  it("starts and ends exactly where it was told", () => {
    const a = { k: 1, tx: 10, ty: -4 };
    const b = { k: 3, tx: 100, ty: 50 };
    expect(lerpTransform(a, b, 0)).toEqual(a);
    const end = lerpTransform(a, b, 1);
    expect(end.k).toBeCloseTo(b.k, 5);
    expect(end.tx).toBeCloseTo(b.tx, 5);
    expect(end.ty).toBeCloseTo(b.ty, 5);
  });

  it("clamps rather than overshooting", () => {
    const a = { k: 1, tx: 0, ty: 0 };
    const b = { k: 4, tx: 20, ty: 20 };
    expect(lerpTransform(a, b, 2).tx).toBeCloseTo(20, 5);
    expect(lerpTransform(a, b, -1).tx).toBeCloseTo(0, 5);
  });

  it("leads the points rather than running with them", () => {
    // The whole point of the sequencing: the camera is done before anything
    // sets off, so the user is looking at the right place already.
    expect(FIT_MS).toBeGreaterThan(0);
    expect(FIT_MS).toBeLessThan(TWEEN_MS);
  });
});
