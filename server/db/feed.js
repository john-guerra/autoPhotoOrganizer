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
export function resolveDimensions(groupBy) {
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
 * Like seekCondition, but seeks to an arbitrary hierarchy PATH's position
 * rather than a specific row — used for "jump to this tree node," which has
 * no focusId to anchor on since the target section may never have been
 * loaded. Inclusive of the path's own exact prefix match (seekCondition
 * seeks strictly past a given row; this seeks AT-OR-after a path).
 * @param {Array<{expr:string, direction:string}>} dims
 * @param {Array<{dimension:string, value:string}>} path a prefix of dims
 * @returns {{sql:string, params:any[]}}
 */
function startPathCondition(dims, path) {
  const clauses = [];
  const params = [];
  path.forEach(({ value }, i) => {
    const parts = [];
    for (let j = 0; j < i; j++) {
      parts.push(`${dims[j].expr} = ?`);
      params.push(path[j].value);
    }
    const op = cmpOp(dims[i].direction, true);
    const inclusiveOp = op === ">" ? ">=" : "<=";
    parts.push(`${dims[i].expr} ${inclusiveOp} ?`);
    params.push(value);
    clauses.push(`(${parts.join(" AND ")})`);
  });
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
    kind: r.kind,
    groupValues,
  };
}

/** @param {Array<{dimension:string,value:string}>} path @returns {string} */
function placeholderId(path) {
  return "collapsed:" + path.map((p) => `${p.dimension}=${p.value}`).join(">");
}

/** @param {Array<{dimension:string,value:string}>} path @returns {Record<string,string>} */
function pathGroupValues(path) {
  const groupValues = {};
  for (const { dimension, value } of path) groupValues[dimension] = value;
  return groupValues;
}

/** Per-dimension comparison of two key tuples of the SAME length, honoring
 * each dimension's own sort direction. @returns {-1|0|1} */
function compareKeyTuples(a, b, dims) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const lt = dims[i].direction === "ASC" ? a[i] < b[i] : a[i] > b[i];
    return lt ? -1 : 1;
  }
  return 0;
}

/** True if `key` (a collapsed path's own tuple, possibly shorter than
 * `dims`) sorts strictly on the `wantAfter` side of `focusValues` in
 * composite order. A full tie can't occur in practice: focusId always
 * names a real, non-collapsed row, so no collapsed path's full prefix can
 * equal it. */
function keyPassesSeek(key, focusValues, dims, wantAfter) {
  for (let i = 0; i < key.length; i++) {
    if (key[i] === focusValues[i]) continue;
    const gt =
      dims[i].direction === "ASC"
        ? key[i] > focusValues[i]
        : key[i] < focusValues[i];
    return wantAfter ? gt : !gt;
  }
  return false;
}

function countCollapsedPath(db, path, dims) {
  const { sql, params } = collapsedPathCondition(path, dims);
  const positiveSql = sql.replace(/^NOT /, "");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE photos.stale = 0 AND ${positiveSql}`
    )
    .get(...params);
  return row.count;
}

/**
 * Which collapsed paths belong in this direction's page, as fully-built
 * placeholder objects (with their count already queried): on the correct
 * side of the focus (or, with no focus, only the "after" direction — there
 * is nothing "before" the true start of the whole feed), and not further
 * out than what was actually fetched — UNLESS fetching returned fewer than
 * `limit` real rows, meaning this direction hit the true edge of the whole
 * dataset, so nothing bounds it from that side.
 */
function selectPlaceholders(
  db,
  collapsed,
  dims,
  focusValues,
  wantAfter,
  realRows,
  limit
) {
  if (!collapsed.length) return [];
  // A limit of 0 means this direction wasn't requested at all (e.g. the
  // default before:0 on a forward-only page) — realRows is then empty not
  // because we hit the true edge of the dataset, but because we never
  // looked, so there's no boundary to bound a placeholder against. Without
  // this guard a collapsed path merely on the correct side of the focus
  // would leak in from a direction the caller asked for zero rows of.
  if (!limit) return [];
  const hitEdge = realRows.length < limit;
  const boundaryRow = realRows.length
    ? realRows[wantAfter ? realRows.length - 1 : 0]
    : null;
  const boundaryKey = boundaryRow
    ? dims.map((d) => boundaryRow.groupValues[d.name])
    : null;

  return collapsed
    .filter((path) => {
      const key = path.map((p) => p.value); // length = path.length, NOT dims.length
      if (focusValues) {
        if (!keyPassesSeek(key, focusValues, dims, wantAfter)) return false;
      } else if (!wantAfter) {
        return false;
      }
      if (!hitEdge && boundaryKey) {
        const cmp = compareKeyTuples(
          key,
          boundaryKey.slice(0, key.length),
          dims
        );
        const withinBound = wantAfter ? cmp <= 0 : cmp >= 0;
        if (!withinBound) return false;
      }
      return true;
    })
    .map((path) => ({
      collapsed: true,
      id: placeholderId(path),
      path,
      groupValues: pathGroupValues(path),
      count: countCollapsedPath(db, path, dims),
    }));
}

/** How many leading dimensions an item's groupValues actually has real
 * values for — the full dims.length for a real row, or just its own
 * collapsed path's length for a placeholder. Needed so two placeholders of
 * DIFFERENT depths landing in the same page never get compared past
 * whichever one's shallower (comparing past that point would read
 * `undefined` off the shorter one's groupValues). */
function itemDepth(item, dims) {
  return item.collapsed ? item.path.length : dims.length;
}

/** Inserts each placeholder into `realRows` (already in ascending composite
 * order) at the position of the first row — real or a previously-inserted
 * placeholder — that sorts after it. */
function spliceInPlaceholders(realRows, placeholders, dims) {
  if (!placeholders.length) return realRows;
  const result = [...realRows];
  for (const ph of placeholders) {
    const key = ph.path.map((p) => p.value);
    let insertAt = result.length;
    for (let i = 0; i < result.length; i++) {
      const depth = Math.min(key.length, itemDepth(result[i], dims));
      const itemKey = dims
        .slice(0, depth)
        .map((d) => result[i].groupValues[d.name]);
      if (compareKeyTuples(key.slice(0, depth), itemKey, dims) < 0) {
        insertAt = i;
        break;
      }
    }
    result.splice(insertAt, 0, ph);
  }
  return result;
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{groupBy: string[], collapsed?: Array<Array<{dimension:string,value:string}>>, focusId?: number|null, startPath?: Array<{dimension:string,value:string}>|null, before?: number, after?: number}} opts
 */
export function getFeedPage(
  db,
  {
    groupBy,
    collapsed = [],
    focusId = null,
    startPath = null,
    before = 0,
    after = 50,
  }
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
                photos.width, photos.height, photos.taken_at, photos.kind,
                ${selectDimCols}
         FROM photos JOIN folders ON folders.id = photos.folder_id
         WHERE photos.id = ?`
      )
      .get(focusId);
    if (!focusRow) throw new Error(`focusId ${focusId} not found`);
    focusValues = dims.map((_, i) => focusRow[`dim${i}`]).concat(focusRow.id);
    focusItem = rowToItem(focusRow, dims);
  }

  function fetchRealRows(wantAfter, limit) {
    if (!limit) return [];
    let seekSql = "1=1";
    let seekParams = [];
    if (focusValues) {
      const seek = seekCondition(seekDims, focusValues, wantAfter);
      seekSql = seek.sql;
      seekParams = seek.params;
    } else if (startPath && startPath.length && wantAfter) {
      const seek = startPathCondition(dims, startPath);
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
                photos.width, photos.height, photos.taken_at, photos.kind,
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

  const beforeReal = fetchRealRows(false, before);
  const afterReal = fetchRealRows(true, after);

  const beforePlaceholders = selectPlaceholders(
    db,
    collapsed,
    dims,
    focusValues,
    false,
    beforeReal,
    before
  );
  const afterPlaceholders = selectPlaceholders(
    db,
    collapsed,
    dims,
    focusValues,
    true,
    afterReal,
    after
  );

  const items = [
    ...spliceInPlaceholders(beforeReal, beforePlaceholders, dims),
    ...spliceInPlaceholders(afterReal, afterPlaceholders, dims),
  ];
  return { items, focusItem };
}

/**
 * Find the id of the first real row (in true forward composite order) of
 * the next/previous DIFFERENT group after/before focusId's own group, at
 * any dimension depth — e.g. the next year within the same folder, or the
 * next folder once the last year in the current one is passed. Regardless
 * of how many rows sit between focusId and the boundary, this costs one
 * indexed query for "next" and two for "prev" — the client-side
 * alternative (paging through every intermediate row) doesn't scale to a
 * 10,000-photo folder.
 *
 * "next" and "prev" are NOT symmetric here. Composite ordering already
 * walks forward, so for "next", the first row found past the current
 * group's boundary is necessarily the target group's own first row —
 * one query suffices. For "prev", walking backward to find the nearest
 * row across the boundary lands on the target group's LAST row in true
 * forward order (the row closest to focus from the far side), not its
 * first — so a second query re-seeks within that row's exact group
 * tuple, in true forward order, to find the group's actual first row.
 * @param {import("better-sqlite3").Database} db
 * @param {{groupBy:string[], collapsed?:Array<Array<{dimension:string,value:string}>>, focusId:number, direction:"next"|"prev"}} opts
 * @returns {{id:number}|null}
 */
export function findGroupBoundary(
  db,
  { groupBy, collapsed = [], focusId, direction }
) {
  const dims = resolveDimensions(groupBy);
  const seekDims = [
    ...dims,
    { name: "__id", expr: "photos.id", direction: "ASC" },
  ];
  const wantAfter = direction === "next";
  const selectDimCols = dims.map((d, i) => `${d.expr} AS dim${i}`).join(", ");

  const focusRow = db
    .prepare(
      `SELECT photos.id, ${selectDimCols}
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE photos.id = ?`
    )
    .get(focusId);
  if (!focusRow) throw new Error(`focusId ${focusId} not found`);
  const focusValues = dims
    .map((_, i) => focusRow[`dim${i}`])
    .concat(focusRow.id);

  const { sql: exclSql, params: exclParams } = exclusionClause(collapsed, dims);
  const { sql: seekSql, params: seekParams } = seekCondition(
    seekDims,
    focusValues,
    wantAfter
  );
  // "Not the focus row's own full group" — collapsedPathCondition already
  // builds exactly this NOT(...) shape for an arbitrary dimension/value
  // path; the focus row's own current groupBy values are just another
  // path to exclude, reused verbatim rather than duplicating the SQL.
  const currentGroupPath = groupBy.map((name, i) => ({
    dimension: name,
    value: focusRow[`dim${i}`],
  }));
  const { sql: notCurrentSql, params: notCurrentParams } =
    collapsedPathCondition(currentGroupPath, dims);

  const orderCols = seekDims
    .map((d, i) => {
      const col = i < dims.length ? `dim${i}` : "photos.id";
      const dir = wantAfter
        ? d.direction
        : d.direction === "ASC"
          ? "DESC"
          : "ASC";
      return `${col} ${dir}`;
    })
    .join(", ");

  const row = db
    .prepare(
      `SELECT photos.id, ${selectDimCols}
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE photos.stale = 0 AND (${exclSql}) AND (${seekSql}) AND (${notCurrentSql})
       ORDER BY ${orderCols}
       LIMIT 1`
    )
    .get(...exclParams, ...seekParams, ...notCurrentParams);
  if (!row) return null;
  if (wantAfter) return { id: row.id };

  // `row` only tells us WHICH group is across the boundary (its own
  // groupBy values), not which of that group's rows sorts first — reseek
  // for the row with the smallest composite key among rows sharing that
  // exact group tuple, in true forward order (each dimension in its own
  // configured direction, id ASC as final tiebreaker).
  const targetGroupPath = groupBy.map((name, i) => ({
    dimension: name,
    value: row[`dim${i}`],
  }));
  const { sql: notMatchSql, params: matchParams } = collapsedPathCondition(
    targetGroupPath,
    dims
  );
  const matchSql = notMatchSql.replace(/^NOT /, "");
  const forwardOrderCols = seekDims
    .map(
      (d, i) => `${i < dims.length ? `dim${i}` : "photos.id"} ${d.direction}`
    )
    .join(", ");
  const firstRow = db
    .prepare(
      `SELECT photos.id, ${selectDimCols}
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE photos.stale = 0 AND (${exclSql}) AND (${matchSql})
       ORDER BY ${forwardOrderCols}
       LIMIT 1`
    )
    .get(...exclParams, ...matchParams);
  return firstRow ? { id: firstRow.id } : null;
}
