/**
 * "How many photos still need each stage?" — for every scope, in one query set.
 *
 * Phase 1 of the unified scan pipeline (design §2.2/§2.3). Independently
 * valuable: it answers John's "I want to know how many photos we are missing in
 * any of the selection modes" on its own, with no pipeline attached.
 *
 * ## Why one endpoint rather than one per panel
 *
 * The scope control offers up to four choices and each needs a live count. A
 * fetch per radio button is four round trips that can land out of order, which
 * is how two panels come to show different numbers for the same library — the
 * failure #245 was made of. One request answers every scope × every stage, so
 * the numbers are consistent by construction because they came from one read.
 *
 * ## Built from the SAME predicates the worklists use
 *
 * That is the whole point of Phase 0. A count that says "312 pending" and a
 * sweep that then processes a different 312 is worse than no count: the user
 * plans around the first number and watches the second. `pendingWhere` is the
 * single definition both consume.
 *
 * ## Counting by ANTI-JOIN, never by subtraction
 *
 * `total - done - failed` is how `faceCounts` produced a pending that could go
 * negative (#261): the two halves counted differently-filtered populations. A
 * direct `COUNT(*)` over the pending predicate cannot drift from the worklist
 * because it IS the worklist's predicate.
 */
import { buildFilter } from "../db/filters.js";
import { STAGES, pendingWhere } from "./stages.js";
import { normalizeScope, scopeClauseFor } from "../db/scopeIds.js";

/**
 * `buildFilter` with POSITIONAL `?` rewritten to NAMED `@f0, @f1, …`.
 *
 * Necessary rather than stylistic: the stage predicates bind named parameters
 * (`@model`, `@faceModel`) and better-sqlite3 refuses a statement mixing named
 * and positional. This is the same constraint that made `resolveScope` turn a
 * filter into ids instead of splicing SQL (#245) — here we can rewrite instead,
 * because a COUNT is one synchronous query rather than a sweep that yields.
 *
 * Safe for `buildFilter`'s output specifically: it puts every user value in a
 * parameter, so no `?` can appear inside a string literal. Do not reach for
 * this on arbitrary SQL.
 *
 * @param {object} spec
 * @returns {{sql: string, params: Record<string, unknown>}}
 */
export function namedFilter(spec) {
  const { sql, params } = buildFilter(spec ?? {});
  const named = {};
  let i = 0;
  const out = sql.replace(/\?/g, () => {
    const key = `f${i}`;
    named[key] = params[i];
    i += 1;
    return `@${key}`;
  });
  if (i !== params.length) {
    // A mismatch means the rewrite missed a placeholder — bind-time would fail
    // confusingly, so say so here instead.
    throw new Error(
      `namedFilter: rewrote ${i} placeholders but buildFilter supplied ${params.length}`
    );
  }
  return { sql: out, params: named };
}

/**
 * Pending/done counts per stage for one scope.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{filter?: object, ids?: number[]|null}} scope
 * @param {{model: string, faceModel: string}} models
 * @returns {{photos: number, stages: Record<string, {pending: number}>}}
 */
export function coverageFor(db, scope, { model, faceModel }) {
  const ids = scope.ids === undefined ? null : normalizeScope(scope.ids);
  // An explicitly EMPTY scope is zero photos, never all of them — the same
  // distinction the ML routes keep, held here so a DISPLAYED number can never
  // contradict what an operation would act on.
  if (ids !== null && ids.length === 0) {
    return {
      photos: 0,
      stages: Object.fromEntries(STAGES.map((s) => [s.id, { pending: 0 }])),
    };
  }
  const idClause = ids === null ? "" : scopeClauseFor(ids);
  const { sql: filterSql, params: filterParams } = namedFilter(scope.filter);
  const filterClause = filterSql === "1=1" ? "" : `AND (${filterSql})`;
  const bind = { model, faceModel, ...filterParams };

  const photos = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM photos
         JOIN folders ON folders.id = photos.folder_id
        WHERE photos.stale = 0 ${filterClause} ${idClause}`
    )
    .get(bind).n;

  const stages = {};
  for (const stage of STAGES) {
    stages[stage.id] = {
      pending: db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM photos
             JOIN folders ON folders.id = photos.folder_id
            WHERE ${pendingWhere(stage)} ${filterClause} ${idClause}`
        )
        .get(bind).n,
    };
  }
  return { photos, stages };
}

/**
 * Every scope the caller asked about, in one read.
 *
 * `library` is always present — it is the denominator the other two are read
 * against. `filtered` and `selected` appear only when asked for, so a caller
 * with no selection does not pay for a count it will not show.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{filter?: object, ids?: number[]|null}} body
 * @param {{model: string, faceModel: string}} models
 */
export function coverage(db, body, models) {
  const out = { library: coverageFor(db, {}, models) };
  if (body?.filter)
    out.filtered = coverageFor(db, { filter: body.filter }, models);
  if (body?.ids !== undefined && body?.ids !== null) {
    out.selected = coverageFor(db, { ids: body.ids }, models);
  }
  return out;
}
