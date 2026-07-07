import { describe, it, expect } from "vitest";
import { treeKey, collapseDescendants } from "./treeState.js";

describe("treeKey", () => {
  it("joins dimension=value pairs with '>'", () => {
    expect(
      treeKey([
        { dimension: "folder", value: "/a" },
        { dimension: "year", value: "2020" },
      ])
    ).toBe("folder=/a>year=2020");
  });

  it("returns an empty string for the root path", () => {
    expect(treeKey([])).toBe("");
  });
});

describe("collapseDescendants", () => {
  it("removes every key nested under the given path", () => {
    const expanded = new Set([
      "folder=/a",
      "folder=/a>year=2020",
      "folder=/a>year=2020>month=2020-01",
      "folder=/b",
    ]);
    const next = collapseDescendants(expanded, [
      { dimension: "folder", value: "/a" },
    ]);
    expect(next).toEqual(new Set(["folder=/a", "folder=/b"]));
  });

  it("leaves the path's own key untouched", () => {
    const expanded = new Set(["folder=/a"]);
    const next = collapseDescendants(expanded, [
      { dimension: "folder", value: "/a" },
    ]);
    expect(next.has("folder=/a")).toBe(true);
  });

  it("does not remove a sibling whose key merely starts with the same string prefix", () => {
    const expanded = new Set(["folder=/a", "folder=/a2"]);
    const next = collapseDescendants(expanded, [
      { dimension: "folder", value: "/a" },
    ]);
    expect(next).toEqual(new Set(["folder=/a", "folder=/a2"]));
  });
});
