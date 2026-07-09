import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirsRecursive } from "./walkDirs.js";

let root;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ag-walk-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("listDirsRecursive", () => {
  it("returns the root first, then every descendant directory", async () => {
    await mkdir(join(root, "a", "a1"), { recursive: true });
    await mkdir(join(root, "b"), { recursive: true });
    const dirs = await listDirsRecursive(root);
    expect(dirs[0]).toBe(root);
    expect(new Set(dirs)).toEqual(
      new Set([root, join(root, "a"), join(root, "a", "a1"), join(root, "b")])
    );
  });

  it("does not descend into hidden (dot) directories", async () => {
    await mkdir(join(root, "visible"), { recursive: true });
    await mkdir(join(root, ".hidden", "deep"), { recursive: true });
    const dirs = await listDirsRecursive(root);
    expect(dirs).toContain(join(root, "visible"));
    expect(dirs.some((d) => d.includes(".hidden"))).toBe(false);
  });

  it("ignores files and does not follow symlinked directories", async () => {
    await mkdir(join(root, "real"), { recursive: true });
    await writeFile(join(root, "photo.jpg"), "x");
    // A symlink pointing back at root would loop forever if followed.
    await symlink(root, join(root, "real", "loop"));
    const dirs = await listDirsRecursive(root);
    expect(dirs).toEqual(expect.arrayContaining([root, join(root, "real")]));
    expect(dirs.some((d) => d.endsWith("loop"))).toBe(false);
    expect(dirs.some((d) => d.endsWith("photo.jpg"))).toBe(false);
  });
});
