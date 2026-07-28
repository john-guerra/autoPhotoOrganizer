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
  return `AND ${column} IN (${ids.join(",")})`;
}
