/** Client-side filter-spec helpers. Mirrors server/db/filters.js semantics:
 * minRating 0 = off; orientations of length 0 or 3 = off. Pure + DOM-free. */

export const ORIENTATIONS = ["landscape", "portrait", "square"];

export const DEFAULT_FILTER = {
  minRating: 0,
  orientations: [...ORIENTATIONS],
  // Time-range facet (epoch ms), driven by the timeline filter. null = open.
  dateFrom: null,
  dateTo: null,
};

/** @param {{minRating?:number, orientations?:string[], scopeIds?:number[], keepScope?:boolean, dateFrom?:number|null, dateTo?:number|null}} spec */
export function isActive(spec) {
  const minRating = spec?.minRating ?? 0;
  const o = spec?.orientations ?? [];
  const scoped = Array.isArray(spec?.scopeIds) && spec.scopeIds.length > 0;
  const timed = spec?.dateFrom != null || spec?.dateTo != null;
  return (
    minRating > 0 ||
    (o.length > 0 && o.length < ORIENTATIONS.length) ||
    scoped ||
    Boolean(spec?.keepScope) ||
    timed
  );
}

/** The `filter` query-param JSON string, or null when nothing is constrained.
 * @param {{minRating?:number, orientations?:string[], scopeIds?:number[]}} spec */
export function toQueryParam(spec) {
  if (!isActive(spec)) return null;
  const out = {};
  if ((spec.minRating ?? 0) > 0) out.minRating = spec.minRating;
  const o = spec?.orientations ?? [];
  if (o.length > 0 && o.length < ORIENTATIONS.length) out.orientations = o;
  if (Array.isArray(spec?.scopeIds) && spec.scopeIds.length) {
    out.scopeIds = spec.scopeIds;
  }
  if (spec?.keepScope) out.keepScope = true;
  if (Number.isFinite(spec?.dateFrom)) out.dateFrom = spec.dateFrom;
  if (Number.isFinite(spec?.dateTo)) out.dateTo = spec.dateTo;
  return JSON.stringify(out);
}

/** Click star k (1..5): set the threshold to k, or clear to 0 if k is already
 * the current threshold (click-again-to-clear). @returns a new spec. */
export function applyRatingClick(spec, k) {
  const current = spec?.minRating ?? 0;
  return { ...spec, minRating: current === k ? 0 : k };
}

/** Toggle orientation `o` in/out of the included set, result in canonical
 * ORIENTATIONS order. @returns a new spec. */
export function toggleOrientation(spec, o) {
  const set = new Set(spec?.orientations ?? []);
  set.has(o) ? set.delete(o) : set.add(o);
  return { ...spec, orientations: ORIENTATIONS.filter((x) => set.has(x)) };
}
