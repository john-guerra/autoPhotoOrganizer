import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { safeResolve } from "./safeResolve.js";

describe("safeResolve", () => {
  const root = "/srv/photos";

  it("accepts a direct child", () => {
    expect(safeResolve(root, "IMG_0001.jpg")).toBe(
      resolve(root, "IMG_0001.jpg")
    );
  });

  it("accepts a nested child", () => {
    expect(safeResolve(root, "2024_01Jan_05_Trip/IMG_0001.jpg")).toBe(
      resolve(root, "2024_01Jan_05_Trip/IMG_0001.jpg")
    );
  });

  it("accepts the root itself", () => {
    expect(safeResolve(root, ".")).toBe(resolve(root));
  });

  it("rejects a simple ../ escape", () => {
    expect(() => safeResolve(root, "../secret.txt")).toThrow(/traversal/i);
  });

  it("rejects a deep ../ escape", () => {
    expect(() => safeResolve(root, "a/b/../../../../etc/passwd")).toThrow(
      /traversal/i
    );
  });

  it("rejects an absolute path outside root", () => {
    expect(() => safeResolve(root, "/etc/passwd")).toThrow(/traversal/i);
  });

  it("rejects a sibling directory with a shared prefix", () => {
    // /srv/photos-evil must not be treated as inside /srv/photos
    expect(() => safeResolve(root, "../photos-evil/x")).toThrow(/traversal/i);
  });
});
