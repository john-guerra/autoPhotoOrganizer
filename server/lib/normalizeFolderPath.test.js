import { describe, it, expect } from "vitest";
import { normalizeFolderPath } from "./normalizeFolderPath.js";

describe("normalizeFolderPath", () => {
  it("strips a single trailing slash", () => {
    expect(normalizeFolderPath("/photos/trip/")).toBe("/photos/trip");
  });

  it("strips repeated trailing slashes", () => {
    expect(normalizeFolderPath("/photos/trip///")).toBe("/photos/trip");
  });

  it("leaves a path without a trailing slash untouched", () => {
    expect(normalizeFolderPath("/photos/trip")).toBe("/photos/trip");
  });

  it("preserves the filesystem root, never reducing it to empty", () => {
    expect(normalizeFolderPath("/")).toBe("/");
  });

  it("does not touch interior separators or resolve dot segments", () => {
    // Deliberately NOT resolve() — a path stored verbatim keeps its spelling.
    expect(normalizeFolderPath("/a/./b/")).toBe("/a/./b");
  });

  it("passes through empty / non-string input unchanged", () => {
    expect(normalizeFolderPath("")).toBe("");
    expect(normalizeFolderPath(undefined)).toBe(undefined);
  });
});
