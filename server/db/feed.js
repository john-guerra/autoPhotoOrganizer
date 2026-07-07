/**
 * Grouping dimensions available to the feed. Each maps to a plain SQL
 * expression over `photos`/`folders` — no new columns. Date dimensions
 * fall back to an empty string (not a real value) for NULL `taken_at`,
 * because an empty string sorts before every real value in both ASC and
 * DESC comparisons for the string data these expressions produce — the
 * cheapest way to force "unknown date" to the end of a DESC-ordered feed
 * without a separate null-flag sort key. `formatGroupValue` (frontend,
 * Task 4) turns "" back into the "Unknown" label for display.
 */
export const DIMENSIONS = {
  folder: { expr: "folders.abs_path", direction: "ASC" },
  year: {
    expr: "COALESCE(strftime('%Y', photos.taken_at / 1000, 'unixepoch'), '')",
    direction: "DESC",
  },
  month: {
    expr: "COALESCE(strftime('%Y-%m', photos.taken_at / 1000, 'unixepoch'), '')",
    direction: "DESC",
  },
  day: {
    expr: "COALESCE(strftime('%Y-%m-%d', photos.taken_at / 1000, 'unixepoch'), '')",
    direction: "DESC",
  },
};

/** @param {string[]} groupBy @returns {Array<{name:string, expr:string, direction:string}>} */
function resolveDimensions(groupBy) {
  return groupBy.map((name) => {
    const dim = DIMENSIONS[name];
    if (!dim) throw new Error(`unknown dimension: ${name}`);
    return { name, ...dim };
  });
}

/**
 * @param {Array<{dimension:string, value:string}>} path
 * @param {Array<{name:string, expr:string}>} dims
 * @returns {{sql:string, params:any[]}}
 */
function collapsedPathCondition(path, dims) {
  const clauses = [];
  const params = [];
  for (const { dimension, value } of path) {
    const dim = dims.find((d) => d.name === dimension);
    if (!dim) {
      throw new Error(
        `collapsed path references unknown dimension: ${dimension}`
      );
    }
    clauses.push(`${dim.expr} = ?`);
    params.push(value);
  }
  return { sql: `NOT (${clauses.join(" AND ")})`, params };
}

/**
 * @param {Array<Array<{dimension:string, value:string}>>} collapsedPaths
 * @param {Array<{name:string, expr:string}>} dims
 * @returns {{sql:string, params:any[]}}
 */
function exclusionClause(collapsedPaths, dims) {
  if (!collapsedPaths.length) return { sql: "1=1", params: [] };
  const parts = [];
  const params = [];
  for (const path of collapsedPaths) {
    const { sql, params: p } = collapsedPathCondition(path, dims);
    parts.push(sql);
    params.push(...p);
  }
  return { sql: parts.join(" AND "), params };
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{groupBy: string[], collapsed: Array<Array<{dimension:string, value:string}>>}} opts
 * @returns {Array<{path: Array<{dimension:string, value:string}>, count: number}>}
 */
function getCollapsedSummaries(db, { groupBy, collapsed }) {
  const dims = resolveDimensions(groupBy);
  return collapsed.map((path) => {
    const { sql, params } = collapsedPathCondition(path, dims);
    const positiveSql = sql.replace(/^NOT /, "");
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM photos JOIN folders ON folders.id = photos.folder_id
         WHERE photos.stale = 0 AND ${positiveSql}`
      )
      .get(...params);
    return { path, count: row.count };
  });
}

/** @param {string} direction @param {boolean} wantAfter @returns {">"|"<"} */
function cmpOp(direction, wantAfter) {
  if (direction === "ASC") return wantAfter ? ">" : "<";
  return wantAfter ? "<" : ">";
}

/**
 * Standard multi-column keyset "seek" condition: rows strictly after (or
 * before) the focus tuple in the composite sort order.
 * `(d0 op d0v) OR (d0=d0v AND d1 op d1v) OR (d0=d0v AND d1=d1v AND ...)`.
 * @param {Array<{expr:string, direction:string}>} seekDims includes the
 *   trailing `photos.id` tiebreaker as its own entry.
 * @param {any[]} focusValues one value per seekDim, in order.
 * @param {boolean} wantAfter
 * @returns {{sql:string, params:any[]}}
 */
function seekCondition(seekDims, focusValues, wantAfter) {
  const clauses = [];
  const params = [];
  for (let i = 0; i < seekDims.length; i++) {
    const parts = [];
    for (let j = 0; j < i; j++) {
      parts.push(`${seekDims[j].expr} = ?`);
      params.push(focusValues[j]);
    }
    const op = cmpOp(seekDims[i].direction, wantAfter);
    parts.push(`${seekDims[i].expr} ${op} ?`);
    params.push(focusValues[i]);
    clauses.push(`(${parts.join(" AND ")})`);
  }
  return { sql: clauses.join(" OR "), params };
}

/**
 * @param {{id:number, name:string, size:number, mtimeMs:number, rating:number, preferredCover:number, width:number|null, height:number|null, taken_at:number|null}} r
 * @param {Array<{name:string}>} dims
 */
function rowToItem(r, dims) {
  const groupValues = {};
  dims.forEach((d, i) => (groupValues[d.name] = r[`dim${i}`]));
  return {
    id: r.id,
    name: r.name,
    size: r.size,
    mtimeMs: r.mtimeMs,
    rating: r.rating,
    preferredCover: r.preferredCover === 1,
    width: r.width,
    height: r.height,
    takenAt: r.taken_at ? new Date(r.taken_at).toISOString() : null,
    groupValues,
  };
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{groupBy: string[], collapsed?: Array<Array<{dimension:string, value:string}>>, focusId?: number|null, before?: number, after?: number}} opts
 */
export function getFeedPage(
  db,
  { groupBy, collapsed = [], focusId = null, before = 0, after = 50 }
) {
  const dims = resolveDimensions(groupBy);
  const seekDims = [
    ...dims,
    { name: "__id", expr: "photos.id", direction: "ASC" },
  ];
  const selectDimCols = dims.map((d, i) => `${d.expr} AS dim${i}`).join(", ");
  const { sql: exclSql, params: exclParams } = exclusionClause(collapsed, dims);

  let focusValues = null;
  let focusItem = null;
  if (focusId != null) {
    const focusRow = db
      .prepare(
        `SELECT photos.id, photos.filename AS name, photos.size,
                photos.mtime AS mtimeMs, photos.rating,
                photos.preferred_cover AS preferredCover,
                photos.width, photos.height, photos.taken_at,
                ${selectDimCols}
         FROM photos JOIN folders ON folders.id = photos.folder_id
         WHERE photos.id = ?`
      )
      .get(focusId);
    if (!focusRow) throw new Error(`focusId ${focusId} not found`);
    focusValues = dims.map((_, i) => focusRow[`dim${i}`]).concat(focusRow.id);
    focusItem = rowToItem(focusRow, dims);
  }

  function fetchDirection(wantAfter, limit) {
    if (!limit) return [];
    let seekSql = "1=1";
    let seekParams = [];
    if (focusValues) {
      const seek = seekCondition(seekDims, focusValues, wantAfter);
      seekSql = seek.sql;
      seekParams = seek.params;
    }
    // Fetching "before" a focus needs the DB to walk backwards from the
    // focus (nearest-first) so LIMIT keeps the N closest rows, not an
    // arbitrary N from the start of the whole table — then reverse back
    // to ascending-output order once the page itself is small.
    const orderCols = seekDims
      .map((d, i) => {
        const col = i < dims.length ? `dim${i}` : "photos.id";
        const direction = wantAfter
          ? d.direction
          : d.direction === "ASC"
            ? "DESC"
            : "ASC";
        return `${col} ${direction}`;
      })
      .join(", ");
    const rows = db
      .prepare(
        `SELECT photos.id, photos.filename AS name, photos.size,
                photos.mtime AS mtimeMs, photos.rating,
                photos.preferred_cover AS preferredCover,
                photos.width, photos.height, photos.taken_at,
                ${selectDimCols}
         FROM photos
         JOIN folders ON folders.id = photos.folder_id
         WHERE photos.stale = 0 AND (${exclSql}) AND (${seekSql})
         ORDER BY ${orderCols}
         LIMIT ?`
      )
      .all(...exclParams, ...seekParams, limit);
    const items = rows.map((r) => rowToItem(r, dims));
    return wantAfter ? items : items.reverse();
  }

  const beforeItems = fetchDirection(false, before);
  const afterItems = fetchDirection(true, after);
  const sections = getCollapsedSummaries(db, { groupBy, collapsed });
  return { items: [...beforeItems, ...afterItems], sections, focusItem };
}
