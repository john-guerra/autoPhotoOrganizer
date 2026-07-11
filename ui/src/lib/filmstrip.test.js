import { describe, it, expect } from "vitest";
import { filmstripWindow } from "./filmstrip.js";

describe("filmstripWindow", () => {
  it("centers a window of radius around the index", () => {
    expect(filmstripWindow(50, 200, 10)).toEqual({ start: 40, end: 61 });
  });
  it("clamps at the start", () => {
    expect(filmstripWindow(2, 200, 10)).toEqual({ start: 0, end: 13 });
  });
  it("clamps at the end", () => {
    expect(filmstripWindow(198, 200, 10)).toEqual({ start: 188, end: 200 });
  });
  it("handles an empty feed", () => {
    expect(filmstripWindow(0, 0, 10)).toEqual({ start: 0, end: 0 });
  });
});
