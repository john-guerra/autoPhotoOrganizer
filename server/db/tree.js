import { resolveDimensions, sortExprOf } from "./feed.js";
import { applyFolderOrder } from "./folderOrder.js";
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
export function getTreeNode(
  db,
  { groupBy, path = [], filter: filterSpec = {}, sort } = {}
) {
  // The tree lists a level in exactly the order the feed renders it — including
  // the folder ranking, so with an ascending date sort the top folder is the one
  // holding the oldest photos that match the current filters.
  const effSort = sort ?? { by: "date_taken", dir: "desc" };
  const dims = applyFolderOrder(
    db,
    applySortToDims(resolveDimensions(groupBy), effSort),
    { filterSpec, sort: effSort }
  );
  if (path.length >= dims.length) {
    throw new Error("path is already at the deepest grouping level");
  }

  const filter = buildFilter(filterSpec);

  const total = db
    .prepare(
      `SELECT COUNT(*) AS count FROM photos WHERE stale = 0 AND (${filter.sql})`
    )
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
  const whereSql = [
    "photos.stale = 0",
    `(${filter.sql})`,
    ...prefixClauses,
  ].join(" AND ");
  const rows = db
    .prepare(
      // Orders by the dimension's SORT expression (pre-order for folders), so the
      // tree lists a level in exactly the order the feed renders it. Grouping
      // still keys on the identity expr — see the invariant in db/feed.js.
      `SELECT ${nextDim.expr} AS value, COUNT(*) AS count
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE ${whereSql}
       GROUP BY ${nextDim.expr}
       ORDER BY ${sortExprOf(nextDim)} ${nextDim.direction}`
    )
    .all(...filter.params, ...prefixParams);

  const hasChildren = path.length + 1 < dims.length;
  const nodes = rows.map((r) => ({
    value: r.value,
    label: formatTreeLabel(nextDim.name, r.value),
    count: r.count,
    hasChildren,
  }));
  return { total, nodes };
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Mirrors ui/src/lib/feed.js's formatGroupValue: the empty-string date
 * sentinel (see feed.js's DIMENSIONS doc comment) displays as "Unknown", and
 * the month-of-year dimension ("01".."12") displays as its month name.
 * Kept in sync manually — there is no shared module between server and
 * client to import this from.
 * Place dimensions (country/city) need no branch — their values are already
 * display strings, and '' is handled by the Unknown rule above. */
function formatTreeLabel(dimension, value) {
  if (value === "") return "Unknown";
  if (dimension === "month") return MONTH_NAMES[Number(value) - 1] ?? value;
  return value;
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
export function getFlatTree(
  db,
  { groupBy, filter: filterSpec = {}, sort } = {}
) {
  // The tree lists a level in exactly the order the feed renders it — including
  // the folder ranking, so with an ascending date sort the top folder is the one
  // holding the oldest photos that match the current filters.
  const effSort = sort ?? { by: "date_taken", dir: "desc" };
  const dims = applyFolderOrder(
    db,
    applySortToDims(resolveDimensions(groupBy), effSort),
    { filterSpec, sort: effSort }
  );

  const filter = buildFilter(filterSpec);

  const total = db
    .prepare(
      `SELECT COUNT(*) AS count FROM photos WHERE stale = 0 AND (${filter.sql})`
    )
    .get(...filter.params).count;

  const selectCols = dims.map((dim, i) => `${dim.expr} AS d${i}`).join(", ");
  const groupByCols = dims.map((dim) => dim.expr).join(", ");
  const orderByCols = dims
    .map((dim) => `${sortExprOf(dim)} ${dim.direction}`)
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
