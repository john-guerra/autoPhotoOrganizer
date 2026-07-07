import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-db-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

describe("getDb", () => {
  it("creates all expected tables", () => {
    const db = getDb();
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
      )
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "volumes",
        "folders",
        "photos",
        "albums",
        "photo_album",
        "tags",
        "photo_tags",
      ])
    );
  });

  it("returns the same connection on repeated calls", () => {
    expect(getDb()).toBe(getDb());
  });

  it("is idempotent to re-apply the schema on an existing db file", () => {
    const db = getDb();
    db.prepare("INSERT INTO volumes (label) VALUES (?)").run("test-volume");

    _resetDbForTest();
    expect(() => getDb()).not.toThrow();

    const reopenedDb = getDb();
    const row = reopenedDb
      .prepare("SELECT label FROM volumes WHERE label = ?")
      .get("test-volume");
    expect(row).toBeDefined();
    expect(row.label).toBe("test-volume");
  });
});
