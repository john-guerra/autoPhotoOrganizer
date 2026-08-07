/**
 * The scope choice, as data (#215/#206/#221).
 *
 * "All / Visible / Selected with live counts" is contract 1 in
 * `docs/UI-CONTRACTS.md`, and the contract says one control, not one per
 * feature — three near-identical copies is already Finding 4 of
 * `docs/ML-UX-REVIEW-2026-07-26.md`. The rendering lives in
 * `ScopeControl.svelte`; the arithmetic lives here so it can be tested without
 * a DOM, and so a caller can ask "what ids did they pick?" without reaching
 * into a component.
 *
 * NB `ui/src/lib/scope.js` is a DIFFERENT thing — the feed's working scope
 * ("Keep only", a folder), which is server-side state that persists. This is
 * the transient "what should this one operation run over?" choice.
 */

/** @typedef {"selected"|"visible"|"all"} ScopeKey */

export const DEFAULT_SCOPE = "all";

/**
 * The scope choices, in the order the contract fixes, each with its count.
 *
 * ## Four, and the first three nest (#245, decision D3)
 *
 *     All  ⊇  Keep only  ⊇  Filtered        Selected — deliberately NOT inside
 *
 * so those three counts fall monotonically and read as one story rather than
 * three unrelated numbers. "Keep only" appears ONLY while a working set is in
 * force; without one it is the same set as All, and offering a duplicate
 * option is worse than offering three.
 *
 * **Selected is the exception, on purpose.** A selection SURVIVES a filter
 * change — you can check twenty photos, narrow the view, and still act on all
 * twenty. That is the behaviour John asked for, and it means "Selected" can
 * contain photos "Filtered" excludes. The set is not wrong; a UI that implies
 * it nests is. So when the two disagree, `selectedInFilter` carries the
 * overlap and the control says so — "20 selected · 14 in the current filter" —
 * rather than quietly presenting a number that looks like a subset of the one
 * above it. Pass `undefined` when it is unknown or irrelevant and nothing is
 * claimed.
 *
 * ## "Filtered", not "Visible"
 *
 * The old name is why this was broken. It was READ as "what is on screen" and
 * MEANT "what the current filter matches", so the count came from the loaded
 * feed window — a few hundred rows that vary with how far you have scrolled —
 * while the contract, the docs and the user all meant the filter's whole
 * result set. Asking for faces in 1,557 photos scanned 175 of them and
 * reported success (#245). The name now says which one it is.
 *
 * `filteredCount` therefore comes from the SERVER (`fetchPhotoCount`), never
 * from `items.length`. If you find yourself passing an array of loaded rows
 * here, that is the bug returning.
 *
 * ## `allCount` is the operation's own remaining work
 *
 * Not the library total: embedding quotes pending rather than 34,807, because
 * re-embedding what is done is not work the sweep will do. The other three are
 * raw counts and therefore UPPER bounds — the sweep skips already-done rows
 * inside them too, which is why the estimate says "up to".
 *
 * @param {{selectedIds?: unknown[], selectedInFilter?: number|undefined,
 *          filteredCount?: number, keepCount?: number, keepActive?: boolean,
 *          allCount?: number, allLabel?: string}} args
 */
export function buildScopes({
  selectedIds = [],
  selectedInFilter = undefined,
  filteredCount = 0,
  keepCount = 0,
  keepActive = false,
  allCount = 0,
  allLabel = "All",
}) {
  const nSel = selectedIds.length;
  // Only disclose the overlap when it actually differs — "20 selected · 20 in
  // the current filter" is noise, and noise is how a real disagreement gets
  // skimmed past.
  const note =
    Number.isFinite(selectedInFilter) && selectedInFilter !== nSel
      ? `${selectedInFilter.toLocaleString()} in the current filter`
      : undefined;
  const scopes = [
    { key: "selected", label: "Selected", n: nSel, note },
    { key: "filtered", label: "Filtered", n: Math.max(0, filteredCount) },
  ];
  if (keepActive) {
    scopes.push({ key: "keep", label: "Keep only", n: Math.max(0, keepCount) });
  }
  scopes.push({ key: "all", label: allLabel, n: Math.max(0, allCount) });
  return scopes;
}

/**
 * The chosen scope, falling back to "All" for an unknown key.
 * @param {ReturnType<typeof buildScopes>} scopes
 * @param {string|undefined} choice
 */
export function activeScope(scopes, choice) {
  return scopes.find((s) => s.key === choice) ?? scopes[scopes.length - 1];
}

/**
 * What to PUT ON THE WIRE for a scope choice (#245).
 *
 * Three shapes, because the four scopes are only expressible in three ways:
 *
 * | choice     | sends                    | why                                |
 * | ---------- | ------------------------ | ---------------------------------- |
 * | `all`      | `{}`                     | no restriction; the sweep          |
 * | `keep`     | `{ filter: {keepScope} }`| ids live server-side in keep_scope |
 * | `filtered` | `{ filter: <spec> }`     | may be the WHOLE library           |
 * | `selected` | `{ ids: [...] }`         | a genuine enumeration              |
 *
 * **Only `selected` may be an id list.** The other three can each be
 * arbitrarily large — "Filtered" with no facets active IS the whole library —
 * so enumerating them would put 125,000 ids in a request body. That is the
 * same unbounded-list problem `keep_scope` was built to avoid, and the reason
 * a scope travels as a DESCRIPTION the server resolves.
 *
 * `null` vs `[]` still means what it always meant, and the distinction now
 * lives in the presence of the keys: an omitted `ids` is "no id scope", an
 * `ids: []` is "these zero photos". The server keeps them apart all the way
 * into the SQL (`server/db/scopeIds.js`); collapsing them is how an empty
 * selection becomes an hour of inference.
 *
 * @param {string|undefined} choice
 * @param {{selectedIds?: unknown[], filterSpec?: object}} sets
 * @returns {{ids?: unknown[], filter?: object}}
 */
export function scopeRequestFor(choice, { selectedIds = [], filterSpec } = {}) {
  if (choice === "selected") return { ids: selectedIds };
  if (choice === "filtered") return { filter: filterSpec ?? {} };
  if (choice === "keep") return { filter: { keepScope: true } };
  return {};
}

/**
 * @deprecated Use {@link scopeRequestFor}. Kept only so a caller that still
 * thinks in ids fails loudly rather than silently sending the wrong set: the
 * two scopes that CANNOT be enumerated throw instead of returning a list that
 * would quietly under-scope the operation — which is exactly the shape of the
 * bug this replaced.
 * @param {string|undefined} choice
 * @param {{selectedIds?: unknown[]}} sets
 * @returns {unknown[]|null}
 */
export function scopeIdsFor(choice, { selectedIds = [] } = {}) {
  if (choice === "selected") return selectedIds;
  if (choice === "filtered" || choice === "keep") {
    throw new Error(
      `scopeIdsFor: "${choice}" cannot be enumerated as ids — it may be the ` +
        `whole library. Use scopeRequestFor and send a filter spec (#245).`
    );
  }
  return null;
}

/**
 * Roughly how long `n` photos will take, from a measured per-photo cost.
 *
 * Rounded hard and prefixed "about": an order-of-magnitude honesty aid
 * measured on one machine, not a promise. Returns null when there is nothing
 * to estimate — the caller says "nothing to do here" rather than "about 0s".
 *
 * @param {number} n
 * @param {number|undefined} msPerPhoto
 * @returns {string|null}
 */
export function formatEstimate(n, msPerPhoto) {
  if (!msPerPhoto || !n) return null;
  const secs = Math.round((n * msPerPhoto) / 1000);
  if (secs < 60) return `about ${Math.max(1, secs)}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `about ${mins} min`;
  return `about ${(mins / 60).toFixed(1)} h`;
}

/**
 * Is this scope request the whole-library sweep?
 *
 * The client-side statement of the SERVER's rule, and it exists so the two
 * cannot drift apart again (#279). `POST /api/ml/faces` and `POST /api/ml/embed`
 * refuse a request carrying no scope while a pass is already live — it is the
 * same worklist — and let a scoped one through to the scheduler, which parks
 * the running sweep in its favour.
 *
 * A UI that disables its button for the whole of any running pass therefore
 * makes the accepted request impossible to compose. That is exactly what
 * happened: the server half of #279 shipped, and John reported "I cannot start
 * the scoped find faces because the ui is disabled when running the previous
 * one" — nothing he could see had changed.
 *
 * **Ask the REQUEST, not the choice.** `choice === "all"` is not the same
 * predicate: "Filtered" with nothing filtered produces `{filter: {}}`, which
 * `resolveScope` collapses to the sweep, so the server sees an unscoped ask
 * from a choice that does not look like one.
 *
 * @param {{ids?: unknown[], filter?: object}} request as built by
 *   {@link scopeRequestFor}
 * @returns {boolean} true when the request scopes nothing — i.e. it IS "All"
 */
export function isWholeLibraryRequest(request) {
  return !request?.ids && !request?.filter;
}
