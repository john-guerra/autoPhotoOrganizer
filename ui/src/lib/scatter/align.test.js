import { describe, it, expect } from "vitest";
import { alignTo, easeInOut, TWEEN_MS } from "./align.js";

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
