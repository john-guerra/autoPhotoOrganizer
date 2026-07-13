import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSubdirsWithCounts } from "./subdirs.js";

// A stand-in for ProcessingService: the real one classifies by extension, so
// the fake just counts .jpg files. What matters is that subdirs.js delegates
// "what counts as media" rather than re-implementing it.
const fakeProcessing = {
  async scan(dir) {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".jpg"))
      .map((e) => ({ name: e.name }));
  },
};

let root;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "subdirs-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("listSubdirsWithCounts", () => {
  it("returns each directory with media, its depth, and its count", async () => {
    await mkdir(join(root, "trip"), { recursive: true });
    await mkdir(join(root, "trip", "raw"), { recursive: true });
    await writeFile(join(root, "trip", "a.jpg"), "x");
    await writeFile(join(root, "trip", "b.jpg"), "x");
    await writeFile(join(root, "trip", "raw", "c.jpg"), "x");

    const dirs = await listSubdirsWithCounts(root, fakeProcessing);

    expect(dirs).toEqual([
      { path: join(root, "trip"), relPath: "trip", depth: 1, mediaCount: 2 },
      {
        path: join(root, "trip", "raw"),
        relPath: join("trip", "raw"),
        depth: 2,
        mediaCount: 1,
      },
    ]);
  });

  it("omits directories with no media (they'd produce no folders row)", async () => {
    await mkdir(join(root, "empty"), { recursive: true });
    await mkdir(join(root, "has"), { recursive: true });
    await writeFile(join(root, "has", "a.jpg"), "x");

    const dirs = await listSubdirsWithCounts(root, fakeProcessing);

    expect(dirs.map((d) => d.relPath)).toEqual(["has"]);
  });

  it("includes the root itself when it holds media, at depth 0", async () => {
    await writeFile(join(root, "a.jpg"), "x");

    const dirs = await listSubdirsWithCounts(root, fakeProcessing);

    expect(dirs).toEqual([
      { path: root, relPath: "", depth: 0, mediaCount: 1 },
    ]);
  });

  it("is empty for a tree with no media at all", async () => {
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "notes.txt"), "x");

    expect(await listSubdirsWithCounts(root, fakeProcessing)).toEqual([]);
  });
});
