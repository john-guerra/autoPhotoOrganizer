/**
 * The photo-id scope validator, shared by every ML stage that can be scoped.
 *
 * SQLite has no array parameter, so a scoped worklist inlines its ids as a SQL
 * literal list. That is safe ONLY because every id is coerced through `Number`
 * and filtered to finite integers first — the ids arrive in a request body, and
 * string-concatenating an unvalidated value into SQL is exactly the injection
 * this codebase guards against elsewhere (`safeResolve`, for paths).
 *
 * It lives in its own module rather than beside one stage's query because
 * embeddings (#206) and faces (#221) both need it, and a second copy of a
 * security-relevant validator is how one copy quietly drifts.
 */

/**
 * @param {Array<number|string>|null|undefined} scopeIds
 * @returns {number[]|null} `null` when no scope was given at all (sweep the
 *   library). Otherwise the ids that survived validation — possibly EMPTY,
 *   which the caller must treat as "no photos", not as "no scope". Keeping
 *   those two cases distinct is the whole job of this function: collapsing
 *   them turns a user's empty selection into a full-library sweep, the most
 *   expensive possible way to misread an empty array.
 */
export function normalizeScope(scopeIds) {
  if (scopeIds === null || scopeIds === undefined) return null;
  if (!Array.isArray(scopeIds)) return [];
  return scopeIds.map((v) => Number(v)).filter((n) => Number.isSafeInteger(n));
}

/**
 * The `AND photos.id IN (…)` fragment for a normalized scope, or `""` for an
 * unscoped sweep.
 *
 * Callers must handle the empty-scope case BEFORE calling this — an empty list
 * cannot be expressed as a SQL `IN ()` and must short-circuit to "no rows".
 * `scopeClauseFor` throws rather than silently emitting a clause that matches
 * everything, because that failure is invisible until the CPU bill arrives.
 *
 * @param {number[]|null} ids the OUTPUT of normalizeScope
 * @param {string} [column] qualified column name
 * @returns {string}
 */
export function scopeClauseFor(ids, column = "photos.id") {
  if (ids === null) return "";
  if (ids.length === 0) {
    throw new Error(
      "scopeClauseFor: an empty scope must short-circuit to no rows, not build a clause"
    );
  }
  // Re-check here rather than trusting the caller ran normalizeScope. This is
  // the one line in the codebase that concatenates request-derived values into
  // SQL, so "a future caller forgets to validate" must be a loud throw and not
  // an injection. Cheap: an integer test over a list already bounded at 50,000
  // by the routes.
  if (!ids.every(Number.isSafeInteger)) {
    throw new Error(
      "scopeClauseFor: ids must be safe integers — run normalizeScope first"
    );
  }
  // `column` is interpolated raw and is NEVER caller-supplied — both call
  // sites pass a literal. Allowlisted so it cannot become one by accident.
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(column)) {
    throw new Error(
      `scopeClauseFor: unsafe column name ${JSON.stringify(column)}`
    );
  }
  return `AND ${column} IN (${ids.join(",")})`;
}

/**
 * Resolve a request's scope — `{ids}` or `{filter}` — to the id list every
 * scoped worklist already understands (#245).
 *
 * ## Why a filter arrives at all
 *
 * Three of the four scopes the UI offers can be arbitrarily large: "All",
 * "Keep only", and "Filtered" with no facets active is the whole library. So
 * they travel as a DESCRIPTION rather than an enumeration — the same reason
 * `keep_scope` exists. Only "Selected" is a genuine list.
 *
 * ## Why it becomes ids HERE rather than a SQL clause
 *
 * Tempting to splice `buildFilter`'s SQL straight into the worklist. It does
 * not work: `buildFilter` emits POSITIONAL (`?`) parameters and the worklists
 * bind NAMED ones (`@model`, `@limit`), and better-sqlite3 refuses a statement
 * that mixes the two. A temp table would dodge that, but temp tables are
 * per-connection and a sweep yields between batches, so a concurrent request
 * would clobber the scope mid-run — a bug that only appears under load.
 *
 * Resolving to ids up front avoids both, and gives the sweep a SNAPSHOT: the
 * work is fixed at request time, so a rating changed while the sweep runs
 * cannot silently add or drop photos from a job the user already approved.
 *
 * **Known cost, stated rather than hidden:** a filter matching the whole
 * library materializes that many integers and inlines them into SQL. Callers
 * should collapse "no active filter" to an unscoped sweep (`{}`) before
 * reaching here, which is what the client does. The proper fix is the scope
 * temp table in `docs/superpowers/specs/2026-07-31-unified-scan-pipeline-design.md`
 * §2.2, which has to solve the concurrency question above first.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ids?: unknown, filter?: object}} body the request body
 * @param {(spec: object) => {sql: string, params: unknown[]}} buildFilter
 * @returns {number[]|null} `null` for an unscoped sweep; otherwise the ids,
 *   possibly EMPTY, which means "these zero photos" and never "all of them".
 */
export function resolveScope(db, body, buildFilter) {
  const hasIds = body?.ids !== undefined && body?.ids !== null;
  const hasFilter = body?.filter !== undefined && body?.filter !== null;

  // An id scope wins if both are somehow present: it is the narrower, explicit
  // one, and silently preferring the broader would be the wrong direction to
  // fail in.
  if (hasIds) return normalizeScope(body.ids);
  if (!hasFilter) return null;

  const filter = buildFilter(body.filter);
  return db
    .prepare(
      `SELECT photos.id AS id
         FROM photos
         JOIN folders ON folders.id = photos.folder_id
        WHERE photos.stale = 0 AND (${filter.sql})
        ORDER BY photos.id`
    )
    .all(...filter.params)
    .map((r) => r.id);
}
