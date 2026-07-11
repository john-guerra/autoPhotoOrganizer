import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan } from "./photos.js";
import {
  createManualStack,
  dissolveStack,
  getManualStackId,
  isKeptSeparate,
} from "./manualStacks.js";

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-mstacks-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

/** Seed n photos in one folder, return their ids in order. */
function seed(db, n = 4) {
  db.prepare(`INSERT INTO volumes (id, label) VALUES (1, 'v')`).run();
  const files = Array.from({ length: n }, (_, i) => ({
    name: `p${i}.jpg`,
    size: 1,
    mtimeMs: i,
    kind: "image",
  }));
  return upsertScan(db, "/photos/trip", 1, files).map((r) => r.id);
}

describe("createManualStack", () => {
  it("allocates a fresh group_id, groups the ids, and clears keep-separate", () => {
    const db = getDb();
    const [a, b, c] = seed(db, 3);
    // c is kept-separate to start; grouping it should clear that.
    dissolveStack(db, [c]);
    expect(isKeptSeparate(db, c)).toBe(true);

    const { groupId, count } = createManualStack(db, [a, b, c]);
    expect(count).toBe(3);
    expect(getManualStackId(db, a)).toBe(groupId);
    expect(getManualStackId(db, b)).toBe(groupId);
    expect(getManualStackId(db, c)).toBe(groupId);
    expect(isKeptSeparate(db, c)).toBe(false);
  });

  it("allocates increasing group ids across stacks", () => {
    const db = getDb();
    const [a, b, c, d] = seed(db, 4);
    const g1 = createManualStack(db, [a, b]).groupId;
    const g2 = createManualStack(db, [c, d]).groupId;
    expect(g2).toBeGreaterThan(g1);
  });

  it("moves a photo cleanly into a new stack (single membership via PK)", () => {
    const db = getDb();
    const [a, b, c] = seed(db, 3);
    const g1 = createManualStack(db, [a, b]).groupId;
    const g2 = createManualStack(db, [b, c]).groupId; // b re-grouped
    expect(getManualStackId(db, b)).toBe(g2);
    expect(getManualStackId(db, a)).toBe(g1); // a untouched, still its group
    expect(getManualStackId(db, c)).toBe(g2);
  });

  it("throws for fewer than 2 photos", () => {
    const db = getDb();
    const [a] = seed(db, 1);
    expect(() => createManualStack(db, [a])).toThrow(/at least 2/);
  });
});

describe("dissolveStack", () => {
  it("sets keep-separate and removes any manual-stack rows", () => {
    const db = getDb();
    const [a, b] = seed(db, 2);
    createManualStack(db, [a, b]);
    const { count } = dissolveStack(db, [a, b]);
    expect(count).toBe(2);
    expect(isKeptSeparate(db, a)).toBe(true);
    expect(isKeptSeparate(db, b)).toBe(true);
    expect(getManualStackId(db, a)).toBeNull();
    expect(getManualStackId(db, b)).toBeNull();
  });

  it("round-trips mutual exclusion: dissolve → create → dissolve", () => {
    const db = getDb();
    const [a, b] = seed(db, 2);
    dissolveStack(db, [a, b]);
    createManualStack(db, [a, b]);
    expect(isKeptSeparate(db, a)).toBe(false);
    expect(getManualStackId(db, a)).not.toBeNull();
    dissolveStack(db, [a, b]);
    expect(isKeptSeparate(db, a)).toBe(true);
    expect(getManualStackId(db, a)).toBeNull();
  });
});

describe("rescan preservation", () => {
  it("keeps no_auto_stack and manual_stacks across an unchanged-file rescan", () => {
    const db = getDb();
    const [a, b, c] = seed(db, 3);
    createManualStack(db, [a, b]);
    dissolveStack(db, [c]);

    // Re-scan the same folder with identical files (same name/size/mtime).
    upsertScan(db, "/photos/trip", 1, [
      { name: "p0.jpg", size: 1, mtimeMs: 0, kind: "image" },
      { name: "p1.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "p2.jpg", size: 1, mtimeMs: 2, kind: "image" },
    ]);

    expect(getManualStackId(db, a)).not.toBeNull();
    expect(getManualStackId(db, a)).toBe(getManualStackId(db, b));
    expect(isKeptSeparate(db, c)).toBe(true);
  });
});
