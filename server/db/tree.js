import { resolveDimensions } from "./feed.js";

/**
 * One level of the grouping hierarchy tree: the distinct values (with
 * counts) of the dimension at depth `path.length` within `groupBy`, scoped
 * to whatever prefix `path` already fixes. Lazily computed per call — one
 * GROUP BY query per expand click, not a full-tree walk, so this stays
 * cheap regardless of library size.
 * @param {import("better-sqlite3").Database} db
 * @param {{groupBy: string[], path?: Array<{dimension:string, value:string}>}} opts
 * @returns {{total: number, nodes: Array<{value:string, label:string, count:number, hasChildren:boolean}>}}
 */
export function getTreeNode(db, { groupBy, path = [] }) {
  const dims = resolveDimensions(groupBy);
  if (path.length >= dims.length) {
    throw new Error("path is already at the deepest grouping level");
  }

  const total = db
    .prepare(`SELECT COUNT(*) AS count FROM photos WHERE stale = 0`)
    .get().count;

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
  const whereSql = ["photos.stale = 0", ...prefixClauses].join(" AND ");
  const rows = db
    .prepare(
      `SELECT ${nextDim.expr} AS value, COUNT(*) AS count
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE ${whereSql}
       GROUP BY ${nextDim.expr}
       ORDER BY ${nextDim.expr} ${nextDim.direction}`
    )
    .all(...prefixParams);

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
