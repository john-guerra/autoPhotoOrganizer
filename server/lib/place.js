import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Coordinates -> a place hierarchy, entirely offline.
 *
 * Bump when the ALGORITHM or the dataset changes in a way that would give an
 * already-geocoded photo a different answer. `backfillPlaces` (db/places.js)
 * re-derives every stored place whose version is older — straight from the
 * stored lat/lon, so it needs no file access and works with the drive
 * unmounted.
 */
export const PLACE_VERSION = 4;

/**
 * How close a photo must be to a neighbourhood (GeoNames PPLX, "section of a
 * populated place") before it is reported as being IN it. Below city in the
 * hierarchy (#176), and a DIFFERENT kind of lookup: pure nearest-neighbour
 * with this hard cap, NOT the population-weighted city score. Prominence is
 * the wrong idea at this scale — a photo is "in the Mission" because it is
 * physically there, not because the Mission is large.
 *
 * 3 km calibrated against the real `all-the-cities` PPLX rows: photos taken
 * inside a neighbourhood sit 0–1.3 km from its centroid (Mission District
 * 0.45, Chinatown 0, Manhattan's Hell's Kitchen 1.26), while the nearest PPLX
 * to a Palo Alto photo is North Fair Oaks at ~6 km — a place it is NOT in. A
 * 3 km cap admits the former and rejects the latter, so a photo with no
 * genuine neighbourhood reports "" instead of a distant wrong guess.
 */
const NEIGHBORHOOD_MAX_KM = 3;

/**
 * Every 10x of population buys a place this many km of extra distance.
 *
 * Plain nearest-neighbour over a dense gazetteer does NOT give the answer a
 * person would: standing in central Bogotá, the closest named point is a
 * 2,000-person barrio 7 km away, not Bogotá (11 km to its centroid). But
 * naively preferring the biggest city nearby is worse — it swallows genuinely
 * distinct neighbours, reporting Sausalito and Berkeley as San Francisco and
 * Oakland. So distance is offset by prominence instead of overridden by it.
 *
 * 2 km/decade was measured, not guessed: anything in 1.5–2.5 gets every case
 * in place.test.js right, so 2 sits in the middle of the working range rather
 * than on a knife edge. Raising it past ~5 starts absorbing real towns into
 * their big neighbours; dropping it below ~1 brings back the barrio answers.
 */
const KM_PER_POPULATION_DECADE = 2;

const KM_PER_DEG = 111.32;

/** @type {null | {lat: Float32Array, lon: Float32Array, bonus: Float32Array, name: string[], iso: string[], admin: string[], grid: Map<number, Int32Array>, maxBonus: number}} */
let index = null;

/** The PPLX-only index for neighbourhood lookups — same grid machinery as the
 *  city index, but no population bonus/iso/admin (a neighbourhood lookup is a
 *  pure nearest-neighbour within NEIGHBORHOOD_MAX_KM). Built by `build()` in
 *  the same single pass over `all-the-cities`, since placeFor now needs both.
 *  @type {null | {lat: Float32Array, lon: Float32Array, name: string[], grid: Map<number, Int32Array>}} */
let nIndex = null;

/**
 * `all-the-cities` is 138k GeoNames places (population >= 1000), bundled — no
 * network, ever. Loading and reshaping it costs ~1s and ~80 MB, so it happens
 * on the first lookup rather than at import: a library with no GPS photos
 * never pays for it.
 *
 * PPLX rows ("section of a populated place" — Mission District, Chinatown,
 * Hell's Kitchen) are kept OUT of the city index on purpose. They are
 * NEIGHBOURHOODS, and mixing them in makes a photo taken downtown resolve to
 * whichever neighbourhood centroid happens to be nearest instead of to the
 * city. They belong to a level BELOW city (#176), so they are routed into
 * their own `nIndex` here — one pass over the dataset builds both indexes,
 * since placeFor now populates city AND neighbourhood together.
 */
function build() {
  const cities = require("all-the-cities");
  const keep = [];
  const hoods = [];
  for (const c of cities) {
    if (c.featureCode === "PPLX") hoods.push(c);
    else keep.push(c);
  }

  const n = keep.length;
  const lat = new Float32Array(n);
  const lon = new Float32Array(n);
  const bonus = new Float32Array(n);
  const name = new Array(n);
  const iso = new Array(n);
  // "US.CA", "CO.34" — country + adminCode, pre-joined so resolveRegion never
  // rebuilds this string per lookup. "" (not the raw adminCode) when a place
  // has none, e.g. Vatican City, so a miss reads as "no region" rather than
  // stringifying to a bogus "VA.undefined" that admin1Map will just never
  // match anyway.
  const admin = new Array(n);
  const cells = new Map();
  // ISO codes come out of the protobuf as 130k separate 2-char strings; there
  // are only ~250 distinct values, so interning them drops 130k allocations.
  const isoPool = new Map();
  const adminPool = new Map();
  let maxBonus = 0;

  for (let i = 0; i < n; i++) {
    const c = keep[i];
    const la = c.loc.coordinates[1];
    const lo = c.loc.coordinates[0];
    lat[i] = la;
    lon[i] = lo;
    const b = KM_PER_POPULATION_DECADE * Math.log10(Math.max(c.population, 1));
    bonus[i] = b;
    if (b > maxBonus) maxBonus = b;
    name[i] = c.name;
    let code = isoPool.get(c.country);
    if (code === undefined) isoPool.set(c.country, (code = c.country));
    iso[i] = code;
    const adminKey = c.adminCode ? `${c.country}.${c.adminCode}` : "";
    let pooled = adminPool.get(adminKey);
    if (pooled === undefined) adminPool.set(adminKey, (pooled = adminKey));
    admin[i] = pooled;
    // wrapLonBucket, not a bare Math.floor: a gazetteer point at exactly
    // lon=180 would otherwise land in a bucket the search side (best()) can
    // never produce, since it always wraps through this same function —
    // making that point permanently unreachable. Storage and search must
    // agree on bucket identity.
    const k = cellKey(Math.floor(la), wrapLonBucket(Math.floor(lo)));
    let arr = cells.get(k);
    if (!arr) cells.set(k, (arr = []));
    arr.push(i);
  }

  const grid = new Map();
  for (const [k, arr] of cells) grid.set(k, Int32Array.from(arr));

  index = { lat, lon, bonus, name, iso, admin, grid, maxBonus };
  nIndex = buildNeighborhoodIndex(hoods);
  return index;
}

/** The PPLX neighbourhood index: the same 1°-cell grid as the city index, but
 *  carrying only what a capped nearest-neighbour search needs (lat/lon/name) —
 *  no population bonus, since neighbourhood matching is distance, not
 *  prominence. Shares cellKey/wrapLonBucket with the city grid so storage and
 *  search agree on bucket identity there too. */
function buildNeighborhoodIndex(rows) {
  const n = rows.length;
  const lat = new Float32Array(n);
  const lon = new Float32Array(n);
  const name = new Array(n);
  const cells = new Map();
  for (let i = 0; i < n; i++) {
    const c = rows[i];
    const la = c.loc.coordinates[1];
    const lo = c.loc.coordinates[0];
    lat[i] = la;
    lon[i] = lo;
    name[i] = c.name;
    const k = cellKey(Math.floor(la), wrapLonBucket(Math.floor(lo)));
    let arr = cells.get(k);
    if (!arr) cells.set(k, (arr = []));
    arr.push(i);
  }
  const grid = new Map();
  for (const [k, arr] of cells) grid.set(k, Int32Array.from(arr));
  return { lat, lon, name, grid };
}

/**
 * The nearest PPLX neighbourhood to a coordinate, or "" if none lies within
 * NEIGHBORHOOD_MAX_KM. Pure nearest-neighbour — no population bonus — so the
 * score IS monotonic in distance, and the search needs no two-phase bound like
 * `best()`: the cap (3 km) is far smaller than a 1° cell (~111 km), so any
 * candidate within it lies in the cell containing the point or an immediate
 * neighbour. `latSpan`/`lonSpan` are derived from the cap the same way best()
 * derives its phase-2 radius (longitude convergence and antimeridian wrap
 * handled), which keeps it correct at high latitude where a lon-cell narrows.
 */
function nearestNeighborhood(lat, lon) {
  const ix = nIndex ?? (build(), nIndex);
  const latBucket = Math.floor(lat);
  const lonBucket = Math.floor(lon);
  const latSpan = Math.ceil(NEIGHBORHOOD_MAX_KM / KM_PER_DEG) + 1;
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 1e-6);
  const lonSpanRaw = NEIGHBORHOOD_MAX_KM / (KM_PER_DEG * cosLat);
  const lonSpan = lonSpanRaw >= 180 ? 180 : Math.ceil(lonSpanRaw) + 1;
  let bestScore = Infinity;
  let bestI = -1;
  for (let dLat = -latSpan; dLat <= latSpan; dLat++) {
    for (let dLon = -lonSpan; dLon <= lonSpan; dLon++) {
      const arr = ix.grid.get(
        cellKey(latBucket + dLat, wrapLonBucket(lonBucket + dLon))
      );
      if (!arr) continue;
      for (let j = 0; j < arr.length; j++) {
        const i = arr[j];
        const d = distanceKm(lat, lon, i, ix);
        if (d < bestScore) {
          bestScore = d;
          bestI = i;
        }
      }
    }
  }
  if (bestI < 0 || bestScore > NEIGHBORHOOD_MAX_KM) return "";
  return ix.name[bestI];
}

/** One key per 1°x1° cell. Latitude is bounded to +/-90 and longitude to
 *  +/-180, so lat*1000+lon can never collide. */
function cellKey(latBucket, lonBucket) {
  return latBucket * 1000 + lonBucket;
}

/** Longitude buckets wrap: the cell east of +179 is -180. */
function wrapLonBucket(b) {
  if (b < -180) return b + 360;
  if (b > 179) return b - 360;
  return b;
}

/** Equirectangular approximation, which is accurate enough at the scale that
 *  decides between two nearby towns and far cheaper than haversine. Longitude
 *  is scaled by cos(lat) so it stays honest away from the equator. */
function distanceKm(lat, lon, i, ix) {
  const dLat = (ix.lat[i] - lat) * KM_PER_DEG;
  let dLonDeg = ix.lon[i] - lon;
  if (dLonDeg > 180) dLonDeg -= 360;
  if (dLonDeg < -180) dLonDeg += 360;
  const dLon = dLonDeg * KM_PER_DEG * Math.cos((lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

function scanCell(k, lat, lon, state, ix) {
  const arr = ix.grid.get(k);
  if (!arr) return;
  for (let j = 0; j < arr.length; j++) {
    const i = arr[j];
    const score = distanceKm(lat, lon, i, ix) - ix.bonus[i];
    if (score < state.score) {
      state.score = score;
      state.i = i;
    }
  }
}

/**
 * The best-scoring place for a coordinate, or null if the dataset is empty.
 *
 * Two phases, because the score is not monotonic in distance — a populous city
 * can beat a closer hamlet. Phase 1 expands rings only until SOME candidate
 * exists. Phase 2 then bounds the search exactly: a rival must lie within
 * `score + maxBonus` km, since `maxBonus` is the largest head start any
 * population can buy. Enumerating that radius in cells (with longitude
 * convergence and antimeridian wrap handled) is what makes this agree with a
 * brute-force scan everywhere, including the poles — an earlier ring-count
 * cutoff silently disagreed on 54 of 500 random points.
 */
function best(lat, lon) {
  const ix = index ?? build();
  const latBucket = Math.floor(lat);
  const lonBucket = Math.floor(lon);
  const state = { score: Infinity, i: -1 };

  for (let r = 0; r < 200 && state.i < 0; r++) {
    for (let dLat = -r; dLat <= r; dLat++) {
      for (let dLon = -r; dLon <= r; dLon++) {
        if (Math.max(Math.abs(dLat), Math.abs(dLon)) !== r) continue;
        scanCell(
          cellKey(latBucket + dLat, wrapLonBucket(lonBucket + dLon)),
          lat,
          lon,
          state,
          ix
        );
      }
    }
  }
  if (state.i < 0) return null;

  const radiusKm = state.score + ix.maxBonus;
  const latSpan = Math.ceil(radiusKm / KM_PER_DEG) + 1;
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 1e-6);
  const lonSpanRaw = radiusKm / (KM_PER_DEG * cosLat);
  // Near the poles the radius spans every meridian; cap rather than overflow.
  const lonSpan = lonSpanRaw >= 180 ? 180 : Math.ceil(lonSpanRaw) + 1;
  for (let dLat = -latSpan; dLat <= latSpan; dLat++) {
    for (let dLon = -lonSpan; dLon <= lonSpan; dLon++) {
      scanCell(
        cellKey(latBucket + dLat, wrapLonBucket(lonBucket + dLon)),
        lat,
        lon,
        state,
        ix
      );
    }
  }
  return {
    city: ix.name[state.i],
    iso: ix.iso[state.i],
    admin: ix.admin[state.i],
  };
}

/** Test-only: the shipped grid-based search. Exercises the real `build()` /
 *  `best()` path, not a re-implementation of it. */
export function _bestForTest(lat, lon) {
  return best(lat, lon);
}

/** Test-only: an exhaustive linear scan over the SAME built index — same
 *  data, same score, different search strategy. Grid vs. this is what an
 *  index-correctness test actually needs to check: not "is the dataset
 *  right" (place.test.js's named-city cases own that) but "does the grid's
 *  ring/radius shortcut ever disagree with checking every point." */
export function _bestLinearForTest(lat, lon) {
  const ix = index ?? build();
  let bestScore = Infinity;
  let bestI = -1;
  for (let i = 0; i < ix.lat.length; i++) {
    const score = distanceKm(lat, lon, i, ix) - ix.bonus[i];
    if (score < bestScore) {
      bestScore = score;
      bestI = i;
    }
  }
  if (bestI < 0) return null;
  return { city: ix.name[bestI], iso: ix.iso[bestI], admin: ix.admin[bestI] };
}

/** Test-only: the shipped capped cell-scan neighbourhood search. */
export function _nearestNeighborhoodForTest(lat, lon) {
  return nearestNeighborhood(lat, lon);
}

/** Test-only: an exhaustive linear scan over the SAME PPLX index with the SAME
 *  cap — same data and same rule, different search strategy. Grid-vs-this is
 *  what checks the cell-span shortcut (latSpan/lonSpan derived from the cap)
 *  never misses the true nearest neighbourhood within range, the same way
 *  _bestLinearForTest guards best(). */
export function _nearestNeighborhoodLinearForTest(lat, lon) {
  const ix = nIndex ?? (build(), nIndex);
  let bestScore = Infinity;
  let bestI = -1;
  for (let i = 0; i < ix.lat.length; i++) {
    const d = distanceKm(lat, lon, i, ix);
    if (d < bestScore) {
      bestScore = d;
      bestI = i;
    }
  }
  if (bestI < 0 || bestScore > NEIGHBORHOOD_MAX_KM) return "";
  return ix.name[bestI];
}

/** @type {null | ((iso: string) => string)} */
let countryName = null;

/** GeoNames gives an ISO2 code; the display name comes from
 *  `i18n-iso-countries`. "alias" over "official" for the shorter everyday form
 *  ("United States", "Russia", "Czechia" rather than "United States of
 *  America", "Russian Federation", "Czech Republic"). */
function resolveCountry(iso) {
  if (!countryName) {
    const countries = require("i18n-iso-countries");
    countries.registerLocale(require("i18n-iso-countries/langs/en.json"));
    countryName = (code) =>
      countries.getName(code, "en", { select: "alias" }) ||
      countries.getName(code, "en", { select: "official" }) ||
      code;
  }
  return countryName(iso);
}

/** @type {null | Map<string, string>} */
let admin1Names = null;

/** GeoNames admin1 code ("US.CA", "CO.34") -> display name ("California",
 *  "Bogota D.C."). `cities.json`'s bundled `admin1.json` (~150KB, CC-BY-4.0,
 *  GeoNames-derived like the rest of this file's data) is a subpath-only
 *  import — Vite/Node never touch the package's 17MB main cities.json file,
 *  since the exports map resolves "cities.json/admin1.json" to just that one
 *  file. Same lazy-load discipline as build(): loaded on first region lookup,
 *  not at import. */
function resolveRegion(admin) {
  if (!admin) return "";
  if (!admin1Names) {
    const table = require("cities.json/admin1.json");
    admin1Names = new Map(table.map((a) => [a.code, a.name]));
  }
  return admin1Names.get(admin) ?? "";
}

/**
 * @param {number|null|undefined} lat
 * @param {number|null|undefined} lon
 * @returns {{country: string, region: string, city: string, neighborhood: string}}
 *
 * Returns "" (never null) for unknown, because "" is the Unknown sentinel
 * every feed dimension already uses — it sorts before every real value, which
 * is what puts Unknown at the end of a DESC feed without a separate null-flag
 * sort key. See the DIMENSIONS doc comment in server/db/feed.js.
 *
 * `region` is GeoNames admin1 — "state" in the US, "departamento" in
 * Colombia, "région" in France, and so on. One field, not a per-country name
 * for the concept: the display value itself is already localized ("Bogota
 * D.C.", "California", "Île-de-France"), so a generic label covers every
 * country the same way `city` already does.
 *
 * NOTE: the lookup has no concept of coverage, so a mid-ocean coordinate still
 * resolves to the nearest coastal town. That is acceptable — a photo taken at
 * sea genuinely has no better answer — but it means `city`/`region` are "the
 * place this was most likely taken in", not a verified containment.
 */
export function placeFor(lat, lon) {
  if (typeof lat !== "number" || typeof lon !== "number") return EMPTY;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return EMPTY;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return EMPTY;
  try {
    const hit = best(lat, lon);
    if (!hit) return EMPTY;
    return {
      country: typeof hit.iso === "string" ? resolveCountry(hit.iso) : "",
      region: typeof hit.admin === "string" ? resolveRegion(hit.admin) : "",
      city: typeof hit.city === "string" ? hit.city : "",
      neighborhood: nearestNeighborhood(lat, lon),
    };
  } catch {
    // A geocoder failure must never break metadata extraction for a photo that
    // is otherwise perfectly usable.
    return EMPTY;
  }
}

const EMPTY = Object.freeze({
  country: "",
  region: "",
  city: "",
  neighborhood: "",
});
