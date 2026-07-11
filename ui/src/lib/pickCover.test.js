import { describe, it, expect } from "vitest";
import { pickCoverId } from "./pickCover.js";

describe("pickCoverId", () => {
  it("prefers a manual preferredCover over everything", () => {
    const members = [
      { id: 1, name: "a.jpg", rating: 5 },
      { id: 2, name: "b.COVER.jpg", rating: 0, preferredCover: true },
      { id: 3, name: "c.jpg", rating: 4 },
    ];
    expect(pickCoverId(members)).toBe(2);
  });

  it("falls back to the highest rating (over a .COVER. filename)", () => {
    const members = [
      { id: 1, name: "a.COVER.jpg", rating: 0 },
      { id: 2, name: "b.jpg", rating: 3 },
      { id: 3, name: "c.jpg", rating: 5 },
    ];
    expect(pickCoverId(members)).toBe(3);
  });

  it("falls back to a .COVER. filename when nothing is rated", () => {
    const members = [
      { id: 1, name: "a.jpg", rating: 0 },
      { id: 2, name: "b.COVER.jpg", rating: 0 },
    ];
    expect(pickCoverId(members)).toBe(2);
  });

  it("falls back to the first member", () => {
    const members = [
      { id: 7, name: "a.jpg", rating: 0 },
      { id: 8, name: "b.jpg", rating: 0 },
    ];
    expect(pickCoverId(members)).toBe(7);
  });
});
