import { resolveDimensions } from "./feed.js";
import { buildFilter } from "./filters.js";
import { applySortToDims } from "./sort.js";

/**
 * One level of the grouping hierarchy tree: the distinct values (with
 * counts) of the dimension at depth `path.length` within `groupBy`, scoped
 * to whatever prefix `path` already fixes. Lazily computed per call — one
 * GROUP BY query per expand click, not a full-tree walk, so this stays
 * cheap regardless of library size.
 * @param {import("better-sqlite3").Database} db
 * @param {{groupBy: string[], path?: Array<{dimension:string, value:string}>, filter?: Object}} opts
 * @returns {{total: number, nodes: Array<{value:string, label:string, count:number, hasChildren:boolean}>}}
 */
export function getTreeNode(db, { groupBy, path = [], filter: filterSpec = {}, sort } = {}) {
  const dims = applySortToDims(resolveDimensions(groupBy), sort ?? { by: "date_taken", dir: "desc" });
  if (path.length >= dims.length) {
    throw new Error("path is already at the deepest grouping level");
  }

  const filter = buildFilter(filterSpec);

  const total = db
    .prepare(`SELECT COUNT(*) AS count FROM photos WHERE stale = 0 AND (${filter.sql})`)
    .get(...filter.params).count;

  const prefixClauses = [];
  const prefixParams = [];
  path.forEach((p, i) => {
    const dim = dims[i];
    if (dim.name !== p.dimension) {
      throw new Error(
        `path dimension mismatch at depth ${i}: expected ${dim.name}, got ${p.dimension}`
      );
    }
    prefixClauses.push(`${dim.expr} = ?`);
    prefixParams.push(p.value);
  });

  const nextDim = dims[path.length];
  const whereSql = ["photos.stale = 0", `(${filter.sql})`, ...prefixClauses].join(" AND ");
  const rows = db
    .prepare(
      `SELECT ${nextDim.expr} AS value, COUNT(*) AS count
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE ${whereSql}
       GROUP BY ${nextDim.expr}
       ORDER BY ${nextDim.expr} ${nextDim.direction}`
    )
    .all(...filter.params, ...prefixParams);

  const hasChildren = path.length + 1 < dims.length;
  const nodes = rows.map((r) => ({
    value: r.value,
    label: formatTreeLabel(r.value),
    count: r.count,
    hasChildren,
  }));
  return { total, nodes };
}

/** Mirrors ui/src/lib/feed.js's formatGroupValue: the empty-string date
 * sentinel (see feed.js's DIMENSIONS doc comment) displays as "Unknown".
 * Kept in sync manually — there is no shared module between server and
 * client to import this from. */
function formatTreeLabel(value) {
  return value === "" ? "Unknown" : value;
}

/**
 * The full, ordered sequence of finest-level groups for `groupBy` — one row
 * per distinct combination of ALL groupBy dimensions, each with its photo
 * count, ordered exactly as the feed orders groups. Feeds the fisheye
 * navigator. One GROUP BY query; bounded by the number of distinct leaf groups.
 * @param {import("better-sqlite3").Database} db
 * @param {{groupBy: string[], filter?: Object}} opts
 * @returns {{total:number, leaves: Array<{values: Record<string,string>, count:number}>}}
 */
export function getFlatTree(db, { groupBy, filter: filterSpec = {}, sort } = {}) {
  const dims = applySortToDims(resolveDimensions(groupBy), sort ?? { by: "date_taken", dir: "desc" });

  const filter = buildFilter(filterSpec);

  const total = db
    .prepare(`SELECT COUNT(*) AS count FROM photos WHERE stale = 0 AND (${filter.sql})`)
    .get(...filter.params).count;

  const selectCols = dims.map((dim, i) => `${dim.expr} AS d${i}`).join(", ");
  const groupByCols = dims.map((dim) => dim.expr).join(", ");
  const orderByCols = dims
    .map((dim) => `${dim.expr} ${dim.direction}`)
    .join(", ");

  const rows = db
    .prepare(
      `SELECT ${selectCols}, COUNT(*) AS count
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE photos.stale = 0 AND (${filter.sql})
       GROUP BY ${groupByCols}
       ORDER BY ${orderByCols}`
    )
    .all(...filter.params);

  const leaves = rows.map((row) => {
    const values = {};
    dims.forEach((dim, i) => {
      values[dim.name] = row[`d${i}`];
    });
    return { values, count: row.count };
  });

  return { total, leaves };
}
