/** Client-side filter-spec helpers. Mirrors server/db/filters.js semantics:
 * minRating 0 = off; orientations of length 0 or 3 = off. Pure + DOM-free. */

export const ORIENTATIONS = ["landscape", "portrait", "square"];

export const DEFAULT_FILTER = { minRating: 0, orientations: [...ORIENTATIONS] };

/** @param {{minRating?:number, orientations?:string[]}} spec */
export function isActive(spec) {
  const minRating = spec?.minRating ?? 0;
  const o = spec?.orientations ?? [];
  return minRating > 0 || (o.length > 0 && o.length < ORIENTATIONS.length);
}

/** The `filter` query-param JSON string, or null when nothing is constrained.
 * @param {{minRating?:number, orientations?:string[]}} spec */
export function toQueryParam(spec) {
  if (!isActive(spec)) return null;
  const out = {};
  if ((spec.minRating ?? 0) > 0) out.minRating = spec.minRating;
  const o = spec?.orientations ?? [];
  if (o.length > 0 && o.length < ORIENTATIONS.length) out.orientations = o;
  return JSON.stringify(out);
}
