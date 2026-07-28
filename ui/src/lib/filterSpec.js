/** Client-side filter-spec helpers. Mirrors server/db/filters.js semantics:
 * minRating 0 = off; orientations of length 0 or 3 = off. Pure + DOM-free. */

export const ORIENTATIONS = ["landscape", "portrait", "square"];
/** Media kinds, matching photos.kind. Subset of length 0 or 3 = off. */
export const KINDS = ["image", "raw", "video"];

export const DEFAULT_FILTER = {
  // Free-text search over filename + folder path. "" = off.
  text: "",
  minRating: 0,
  orientations: [...ORIENTATIONS],
  kinds: [...KINDS],
  // Time-range facet (epoch ms), driven by the timeline filter. null = open.
  dateFrom: null,
  dateTo: null,
  // Which date attribute the timeline reflects — follows the feed's sort date;
  // defaults to date_taken (EXIF-created). Not a constraint on its own.
  dateAttr: "date_taken",
};

/** @param {{minRating?:number, orientations?:string[], scopeIds?:number[], keepScope?:boolean, folderPath?:string, dateFrom?:number|null, dateTo?:number|null}} spec */
export function isActive(spec) {
  const minRating = spec?.minRating ?? 0;
  const o = spec?.orientations ?? [];
  const k = spec?.kinds ?? [];
  const scoped = Array.isArray(spec?.scopeIds) && spec.scopeIds.length > 0;
  const focused =
    typeof spec?.folderPath === "string" && spec.folderPath.length > 0;
  const timed = spec?.dateFrom != null || spec?.dateTo != null;
  const searched = typeof spec?.text === "string" && spec.text.trim() !== "";
  // A saved semantic tag (#164). Counted as active so the toolbar reports the
  // feed as filtered — a tag that silently narrows the library while the UI
  // says "no filters" is the same lie as any other missing facet.
  const tagged = typeof spec?.tag === "string" && spec.tag.length > 0;
  // Filtering to one person narrows the library hard, so the toolbar must
  // report the feed as filtered — an unreported narrowing is how "where did
  // my photos go" happens (#167).
  const byPerson = Number.isSafeInteger(spec?.personId) && spec.personId > 0;
  return (
    searched ||
    tagged ||
    byPerson ||
    minRating > 0 ||
    (o.length > 0 && o.length < ORIENTATIONS.length) ||
    (k.length > 0 && k.length < KINDS.length) ||
    scoped ||
    Boolean(spec?.keepScope) ||
    focused ||
    timed
  );
}

/** The `filter` query-param JSON string, or null when nothing is sent.
 * `dateAttr` rides along whenever it differs from the default, even if no other
 * facet is active, so the timeline density and date bounds use the right column.
 * @param {{minRating?:number, orientations?:string[], scopeIds?:number[], keepScope?:boolean, folderPath?:string, dateAttr?:string}} spec */
export function toQueryParam(spec) {
  const out = {};
  if (typeof spec?.text === "string" && spec.text.trim()) {
    out.text = spec.text.trim();
  }
  if ((spec?.minRating ?? 0) > 0) out.minRating = spec.minRating;
  const o = spec?.orientations ?? [];
  if (o.length > 0 && o.length < ORIENTATIONS.length) out.orientations = o;
  const k = spec?.kinds ?? [];
  if (k.length > 0 && k.length < KINDS.length) out.kinds = k;
  if (Array.isArray(spec?.scopeIds) && spec.scopeIds.length) {
    out.scopeIds = spec.scopeIds;
  }
  if (spec?.keepScope) out.keepScope = true;
  // Third of the three layers a facet needs (SQL -> server allowlist -> here).
  // Miss this one and the filter is correct everywhere and reaches nothing.
  if (typeof spec?.tag === "string" && spec.tag) out.tag = spec.tag;
  if (Number.isSafeInteger(spec?.personId) && spec.personId > 0)
    out.personId = spec.personId;
  if (typeof spec?.folderPath === "string" && spec.folderPath) {
    out.folderPath = spec.folderPath;
  }
  if (Number.isFinite(spec?.dateFrom)) out.dateFrom = spec.dateFrom;
  if (Number.isFinite(spec?.dateTo)) out.dateTo = spec.dateTo;
  if (spec?.dateAttr && spec.dateAttr !== "date_taken")
    out.dateAttr = spec.dateAttr;
  return Object.keys(out).length ? JSON.stringify(out) : null;
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

/** Toggle media kind `k` in/out of the included set, result in canonical
 * KINDS order. @returns a new spec. */
export function toggleKind(spec, k) {
  const set = new Set(spec?.kinds ?? []);
  set.has(k) ? set.delete(k) : set.add(k);
  return { ...spec, kinds: KINDS.filter((x) => set.has(x)) };
}
