/**
 * What order folders come in.
 *
 * Folder groups used to be ordered by their PATH — `folders.sort_path`, the
 * pre-order key. That is what makes a subtree contiguous, which is what lets the
 * feed draw a folder hierarchy at all (a parent must be immediately followed by
 * its own descendants, or the sections re-open). But it also meant the feed
 * ignored the sort you asked for: with "date taken, ascending", the first folder
 * was the alphabetically-first path, not the one holding your oldest photos.
 *
 * Both, then. Siblings are ranked by the sort attribute — for a folder that means
 * the oldest (ascending) or newest (descending) photo anywhere in its SUBTREE,
 * because a parent contains its children and that is what the user is picking it
 * out by — and the walk is still depth-first, so a folder is still followed by its
 * own subtree and the dendrogram still draws.
 *
 * The rank is just an integer: the folder's position in that walk. Which means it
 * drops straight into the machinery that already exists — it becomes the folder
 * dimension's `sortExpr`, and the seek conditions, the ord columns and the JS
 * mirror of the SQL comparison all keep working unchanged, on a number instead of
 * a string. (See THE INVARIANT at the top of feed.js: identity uses `expr` and the
 * raw value; ordering uses `sortExpr` and `sortKey(value)`.)
 *
 * It has to be computed per request, not stored: "the oldest photo in this folder"
 * depends on the FILTER. Filter to 5 stars and the folder holding your oldest
 * five-star photo is a different folder.
 */

import { SORT_ATTRS } from "./sort.js";
import { buildFilter } from "./filters.js";

/** Sorts after every real rank: a folder with no photo matching the filter has no
 * date to be ranked by, and belongs at the end rather than at the beginning. */
const NO_AGG = Number.POSITIVE_INFINITY;

/**
 * Rank folders for display.
 *
 * @param {Array<{path: string, agg: number|string|null}>} rows one per folder that
 *   has photos: its absolute path, and the aggregate of the sort attribute over
 *   its OWN photos (MIN for ascending, MAX for descending — see buildFolderOrder).
 * @param {boolean} desc is the sort descending?
 * @returns {{dfs: Map<string, number>, flat: Map<string, number>, dfsAncestors: Map<string, number>}}
 *   `dfs`  — depth-first, siblings ranked by their subtree's aggregate. For the
 *            `folder` dimension, which nests. Keyed only by REAL folders (ones
 *            with photos of their own) — the set `applyFolderOrder` populates
 *            `folder_order` from.
 *   `flat` — every folder ranked by its own aggregate, ignoring the tree. For
 *            `folderName`, which is a flat list (a NAME has no parent — see
 *            FOLDER_DIMS in ui/src/lib/folderSections.js).
 *   `dfsAncestors` — rank for a photo-less ancestor folder (invented by the
 *            trie, not in `dfs`), keyed by its own path: the position it would
 *            occupy in the walk, i.e. its first real descendant's rank. Used
 *            only as a fallback so a subtree-collapsed placeholder — which
 *            names such a folder directly (#142) — sorts at its parent's
 *            position instead of falling through to UNRANKED.
 */
export function assignFolderOrder(rows, desc = false) {
  // A folder that holds only sub-folders has no row of its own here (the index
  // only records folders that contain photos), so the trie has to invent it —
  // exactly as the client's folderTree does. It gets no rank, but its children's
  // aggregates still decide where the whole branch sits among its siblings.
  const root = { children: new Map(), path: "", real: false, agg: NO_AGG };

  for (const { path, agg } of rows) {
    const segs = path.split("/").filter(Boolean);
    let node = root;
    let acc = "";
    for (const seg of segs) {
      acc += `/${seg}`;
      if (!node.children.has(seg)) {
        node.children.set(seg, {
          children: new Map(),
          path: acc,
          real: false,
          agg: NO_AGG,
        });
      }
      node = node.children.get(seg);
    }
    node.real = true;
    // The stored path is the identity the server matches on, and exactly one
    // folder in the real library carries a trailing slash — keep the raw string,
    // or the map's key won't match the value the query returns.
    node.rawPath = path;
    node.agg = agg == null ? NO_AGG : agg;
  }

  const better = (a, b) => (desc ? (a > b ? a : b) : a < b ? a : b);
  // A branch is ranked by the best photo ANYWHERE under it, so a parent sits where
  // its oldest photo says it should, not where its own name does.
  const subtreeAgg = (node) => {
    let best = node.real ? node.agg : desc ? -Infinity : NO_AGG;
    for (const child of node.children.values()) {
      const c = subtreeAgg(child);
      if (c !== NO_AGG && c !== -Infinity) {
        best = best === NO_AGG || best === -Infinity ? c : better(best, c);
      }
    }
    node.rank = best;
    return best;
  };
  subtreeAgg(root);

  const dfs = new Map();
  // A folder that holds only sub-folders (no photos of its own) is invented by
  // the trie above and never gets a `real` rank in `dfs` — but a
  // subtree-collapsed placeholder names exactly such a folder directly (#142).
  // Track its rank separately (rather than folding it into `dfs`, whose exact
  // key set — real folders only — existing callers and tests pin down) so
  // `dfsAncestors` can be consulted as a fallback: the rank of whatever comes
  // next in the walk (its own first real descendant, pre-order), so the
  // placeholder splices in at the parent's position among its siblings
  // instead of falling through to UNRANKED and sinking to the end of the feed.
  const dfsAncestors = new Map();
  let seq = 0;
  const walk = (node) => {
    if (node.real) {
      dfs.set(node.rawPath, seq++);
    } else if (node.path) {
      dfsAncestors.set(node.path, seq);
    }
    const kids = [...node.children.values()].sort((a, b) => {
      // Unrankable branches (nothing under them matches the filter) sink to the
      // bottom rather than floating to the top on a null.
      const ra = a.rank === NO_AGG || a.rank === -Infinity ? null : a.rank;
      const rb = b.rank === NO_AGG || b.rank === -Infinity ? null : b.rank;
      if (ra === null && rb === null) return a.path < b.path ? -1 : 1;
      if (ra === null) return 1;
      if (rb === null) return -1;
      if (ra === rb) return a.path < b.path ? -1 : 1; // stable, and deterministic
      return desc ? (ra > rb ? -1 : 1) : ra < rb ? -1 : 1;
    });
    for (const kid of kids) walk(kid);
  };
  walk(root);

  const flat = new Map();
  const byAgg = [...rows].sort((a, b) => {
    const ra = a.agg == null ? null : a.agg;
    const rb = b.agg == null ? null : b.agg;
    if (ra === null && rb === null) return a.path < b.path ? -1 : 1;
    if (ra === null) return 1;
    if (rb === null) return -1;
    if (ra === rb) return a.path < b.path ? -1 : 1;
    return desc ? (ra > rb ? -1 : 1) : ra < rb ? -1 : 1;
  });
  byAgg.forEach((r, i) => flat.set(r.path, i));

  return { dfs, flat, dfsAncestors };
}

/** Ranks above every real folder — for a value the map has never heard of, which
 * can only be a folder with no matching photos, i.e. one that isn't in the feed. */
const UNRANKED = 1e9;

const FOLDER_DIMS = new Set(["folder", "folderName"]);

/**
 * Give the folder dimensions a sort expression that follows the feed's sort.
 *
 * Populates a per-connection TEMP table and rewrites the dims to order by it.
 * Safe to do per request: better-sqlite3 is synchronous, so nothing else can run
 * between filling the table and reading it.
 *
 * A no-op (and no query) when nothing is grouped by folder.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {Array<object>} dims resolved dimensions
 * @param {{filterSpec?: object, sort: {by: string, dir: string}}} opts
 * @returns {Array<object>} dims, with the folder ones re-pointed at the ranking
 */
export function applyFolderOrder(db, dims, { filterSpec = {}, sort }) {
  if (!dims.some((d) => FOLDER_DIMS.has(d.name))) return dims;

  const desc = sort?.dir === "desc";
  const attr = SORT_ATTRS[sort?.by] ?? SORT_ATTRS.date_taken;
  const filter = buildFilter(filterSpec);

  // The aggregate of the sort attribute over each folder's own photos — the
  // oldest when ascending, the newest when descending, so "first" always means
  // "the one you'd reach first".
  const agg = desc ? "MAX" : "MIN";
  const rows = db
    .prepare(
      `SELECT folders.id AS fid, folders.abs_path AS path, ${agg}(${attr.expr}) AS agg
         FROM photos JOIN folders ON folders.id = photos.folder_id
        WHERE photos.stale = 0 AND (${filter.sql})
        GROUP BY folders.id`
    )
    .all(...filter.params);

  const { dfs, flat, dfsAncestors } = assignFolderOrder(rows, desc);

  db.exec(`CREATE TEMP TABLE IF NOT EXISTS folder_order (
             folder_id INTEGER PRIMARY KEY,
             dfs INTEGER NOT NULL,
             flat INTEGER NOT NULL
           )`);
  db.exec("DELETE FROM folder_order");
  const ins = db.prepare(
    "INSERT INTO folder_order (folder_id, dfs, flat) VALUES (?, ?, ?)"
  );
  const fill = db.transaction((list) => {
    for (const r of list) {
      ins.run(r.fid, dfs.get(r.path) ?? UNRANKED, flat.get(r.path) ?? UNRANKED);
    }
  });
  fill(rows);

  // A correlated subquery, not a join: it drops into the dimension's `sortExpr`
  // and every query that orders or seeks on a folder picks it up without any of
  // them changing shape. The lookup is a primary-key hit on a table of ~1k rows,
  // and folder grouping already sorts through a temp B-tree either way.
  const rank = (col) =>
    `(SELECT fo.${col} FROM folder_order fo WHERE fo.folder_id = photos.folder_id)`;

  return dims.map((d) => {
    if (!FOLDER_DIMS.has(d.name)) return d;
    const map = d.name === "folder" ? dfs : flat;
    return {
      ...d,
      // The rank IS the display order, so it always reads forwards. The sort's
      // direction is already baked into it (which end the oldest photo went).
      direction: "ASC",
      sortExpr: rank(d.name === "folder" ? "dfs" : "flat"),
      // `dfsAncestors` is consulted only for the `folder` dim, and only when
      // `dfs` misses: a real folder value is always in `dfs` (every photo
      // belongs to one), so the fallback only ever fires for a value that
      // names a photo-less ancestor — i.e. a subtree-collapsed placeholder's
      // own path (#142). SQL never needs the equivalent: a placeholder is a
      // JS-only construct spliced in after the query runs (spliceInPlaceholders
      // in feed.js), so only this JS-side `sortKey` twin sees such a value.
      sortKey: (v) => {
        const key = String(v);
        const primary = map.get(key);
        if (primary !== undefined) return primary;
        if (d.name === "folder") {
          const ancestor = dfsAncestors.get(key);
          if (ancestor !== undefined) return ancestor;
        }
        return UNRANKED;
      },
    };
  });
}
