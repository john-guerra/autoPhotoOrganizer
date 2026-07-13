import { describe, it, expect } from "vitest";
import { isInsideDir } from "./insideDir.js";

describe("isInsideDir", () => {
  it("accepts the directory itself", () => {
    expect(isInsideDir("/photos/trip", "/photos/trip")).toBe(true);
  });

  it("accepts a descendant", () => {
    expect(isInsideDir("/photos/trip", "/photos/trip/raw")).toBe(true);
    expect(isInsideDir("/photos/trip", "/photos/trip/a/b/c")).toBe(true);
  });

  it("rejects a sibling with a shared name prefix", () => {
    // The classic hole: a naive startsWith("/photos/trip") lets /photos/tripX
    // through. It is NOT inside /photos/trip.
    expect(isInsideDir("/photos/trip", "/photos/tripX")).toBe(false);
    expect(isInsideDir("/a/b", "/a/bc")).toBe(false);
  });

  it("rejects an ancestor and an unrelated path", () => {
    expect(isInsideDir("/photos/trip", "/photos")).toBe(false);
    expect(isInsideDir("/photos/trip", "/etc/passwd")).toBe(false);
  });

  it("rejects a traversal that escapes the parent", () => {
    expect(isInsideDir("/photos/trip", "/photos/trip/../../etc")).toBe(false);
    expect(isInsideDir("/photos/trip", "/photos/trip/./../other")).toBe(false);
  });

  it("normalizes a trailing slash on the parent", () => {
    expect(isInsideDir("/photos/trip/", "/photos/trip/raw")).toBe(true);
  });
});
