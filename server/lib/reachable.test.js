import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reachable } from "./reachable.js";

describe("reachable", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reachable-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is true for a directory that exists", () => {
    expect(reachable(dir)).toBe(true);
  });

  it("is false for a directory that does not exist", () => {
    expect(reachable(join(dir, "gone"))).toBe(false);
  });

  it("is false for a path that exists but is a FILE, not a directory", () => {
    // A folder row's abs_path must be a directory. If a file sits at that path
    // the index is wrong about the world, and treating it as reachable would
    // let the sweep mark every row in it permanently failed.
    const f = join(dir, "not-a-dir");
    writeFileSync(f, "x");
    expect(reachable(f)).toBe(false);
  });

  it("is false rather than throwing for a nonsense path", () => {
    expect(reachable("\0invalid")).toBe(false);
  });
});
