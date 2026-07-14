import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignFolderOrder } from "./folderOrder.js";
import { getFeedPage } from "./feed.js";
import { getTreeNode } from "./tree.js";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan } from "./photos.js";

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-folderorder-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

function seedVolume(db, id) {
  db.prepare(`INSERT INTO volumes (id, label) VALUES (?, ?)`).run(
    id,
    `vol${id}`
  );
}

function setTakenAt(db, id, iso) {
  db.prepare(`UPDATE photos SET taken_at = ? WHERE id = ?`).run(
    Date.parse(iso),
    id
  );
}

/** The rows assignFolderOrder takes: one per folder that holds photos. */
const rows = (o) => Object.entries(o).map(([path, agg]) => ({ path, agg }));

/** The folders in walk order — a Map keyed by path, valued by rank. */
const order = (map) =>
  [...map.entries()].sort((a, b) => a[1] - b[1]).map(([path]) => path);

describe("assignFolderOrder", () => {
  it("ranks siblings by their photos, not by their names", () => {
    // Alphabetically /L/a comes first. By date it comes last — and by date is
    // what the user asked for.
    const { dfs } = assignFolderOrder(
      rows({ "/L/a": 300, "/L/b": 100, "/L/c": 200 })
    );
    expect(order(dfs)).toEqual(["/L/b", "/L/c", "/L/a"]);
  });

  it("keeps a folder immediately followed by its own subtree", () => {
    // THE constraint the feed's nesting rests on: a subtree must be contiguous,
    // or its sections re-open. /L/b holds the oldest photo, so it sorts first —
    // and its child comes with it, rather than being stranded after /L/a.
    const { dfs } = assignFolderOrder(
      rows({ "/L/a": 200, "/L/b": 500, "/L/b/sub": 100 })
    );
    expect(order(dfs)).toEqual(["/L/b", "/L/b/sub", "/L/a"]);
  });

  it("ranks a parent by the oldest photo ANYWHERE beneath it", () => {
    // A photo-less ancestor has no row of its own — it is invented from its
    // children's paths, and it sits where its children say it should.
    const { dfs } = assignFolderOrder(
      rows({ "/L/cards/cam2": 100, "/L/direct": 200 })
    );
    // /L/cards has no photos, but its subtree's oldest (100) beats /L/direct.
    expect(order(dfs)).toEqual(["/L/cards/cam2", "/L/direct"]);
  });

  it("descending puts the folder with the NEWEST photo first", () => {
    const { dfs } = assignFolderOrder(
      rows({ "/L/a": 300, "/L/b": 100, "/L/c": 200 }),
      true
    );
    expect(order(dfs)).toEqual(["/L/a", "/L/c", "/L/b"]);
  });

  it("sinks a folder with nothing to rank it by to the bottom", () => {
    // A null aggregate means no photo of this folder's matched the filter. It
    // belongs at the end, not floating to the top on a null.
    const { dfs } = assignFolderOrder(
      rows({ "/L/a": null, "/L/b": 200, "/L/c": 100 })
    );
    expect(order(dfs)).toEqual(["/L/c", "/L/b", "/L/a"]);
  });

  it("ranks folderName's flat list by each folder's own photos, ignoring the tree", () => {
    // Grouping by NAME is a flat list — a name has no parent (see FOLDER_DIMS in
    // ui/src/lib/folderSections.js), so a child can and must outrank its parent.
    const { flat } = assignFolderOrder(
      rows({ "/L/b": 500, "/L/b/sub": 100, "/L/a": 200 })
    );
    expect(order(flat)).toEqual(["/L/b/sub", "/L/a", "/L/b"]);
  });

  it("keeps the folder's stored path verbatim, trailing slash and all", () => {
    // Exactly one folder in the real library is stored with a trailing slash.
    // The rank is looked up by the value the query returns, so a normalised key
    // would leave that one folder unranked — and it would sink to the bottom.
    const { dfs, flat } = assignFolderOrder(rows({ "/L/odd/": 100 }));
    expect(dfs.get("/L/odd/")).toBe(0);
    expect(flat.get("/L/odd/")).toBe(0);
  });
});

describe("the feed and the tree order folders by the sort attribute", () => {
  let db;
  beforeEach(() => {
    db = getDb();
    seedVolume(db, 1);
    // Alphabetical order is a, b, c. Date order is c, a, b — so any assertion
    // below fails if the folders are still ordered by their path.
    const a = upsertScan(db, "/photos/a", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const b = upsertScan(db, "/photos/b", 1, [
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const c = upsertScan(db, "/photos/c", 1, [
      { name: "c.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(db, a[0].id, "2021-01-01T00:00:00.000Z");
    setTakenAt(db, b[0].id, "2022-01-01T00:00:00.000Z");
    setTakenAt(db, c[0].id, "2020-01-01T00:00:00.000Z");
  });

  it("ascending: the first folder holds the oldest photo", () => {
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      sort: { by: "date_taken", dir: "asc" },
      after: 10,
    });
    expect(items.map((i) => i.name)).toEqual(["c.jpg", "a.jpg", "b.jpg"]);
  });

  it("descending: the first folder holds the newest photo", () => {
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      sort: { by: "date_taken", dir: "desc" },
      after: 10,
    });
    expect(items.map((i) => i.name)).toEqual(["b.jpg", "a.jpg", "c.jpg"]);
  });

  it("the tree lists the folders in the same order the feed renders them", () => {
    // The two navigators must agree about the shape of the same library — the
    // tree listing a,b,c while the feed renders c,a,b is the bug.
    const { nodes } = getTreeNode(db, {
      groupBy: ["folder"],
      sort: { by: "date_taken", dir: "asc" },
    });
    expect(nodes.map((n) => n.value)).toEqual([
      "/photos/c",
      "/photos/a",
      "/photos/b",
    ]);
  });

  it("the ranking follows the FILTER — it is not the folder's oldest photo, it is its oldest MATCHING one", () => {
    // Give /photos/b a 5-star photo older than anything in c. Unfiltered, b is
    // last; filtered to 5 stars, b is first. A ranking computed once and cached
    // would get this wrong, which is why it is computed per request.
    const extra = upsertScan(db, "/photos/b", 1, [
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b-old.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const old = extra.find((r) => r.name === "b-old.jpg");
    setTakenAt(db, old.id, "2019-01-01T00:00:00.000Z");
    db.prepare("UPDATE photos SET rating = 5 WHERE id = ?").run(old.id);

    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      sort: { by: "date_taken", dir: "asc" },
      filter: { minRating: 5 },
      after: 10,
    });
    expect(items.map((i) => i.name)).toEqual(["b-old.jpg"]);

    const all = getFeedPage(db, {
      groupBy: ["folder"],
      sort: { by: "date_taken", dir: "asc" },
      after: 10,
    });
    expect(all.items[0].name).toBe("b-old.jpg"); // b now holds the oldest overall
  });
});
