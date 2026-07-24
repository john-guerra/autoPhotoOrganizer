import { getNearestCity } from "offline-geocode-city";

/**
 * Coordinates -> a two-level place hierarchy, entirely offline.
 *
 * TWO levels, not three: `offline-geocode-city` returns
 * { cityName, countryIso2, countryName } and has no admin1/state/region. A
 * `place_admin1` column would be a column nothing fills — the same trap as
 * `photos.perceptual_hash`, declared in the schema and read by nobody.
 *
 * Returns "" (never null) for unknown, because "" is the Unknown sentinel every
 * feed dimension already uses — it sorts before every real value, which is what
 * puts Unknown at the end of a DESC feed without a separate null-flag sort key.
 * See the DIMENSIONS doc comment in server/db/feed.js.
 *
 * NOTE: the lookup is nearest-neighbour, so a mid-ocean coordinate still
 * resolves to the nearest coastal city. That is acceptable — a photo taken at
 * sea genuinely has no better answer — but it means `city` is "closest known
 * city", not "the city this was taken in".
 *
 * @param {number|null|undefined} lat
 * @param {number|null|undefined} lon
 * @returns {{country: string, city: string}}
 */
export function placeFor(lat, lon) {
  if (typeof lat !== "number" || typeof lon !== "number") return EMPTY;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return EMPTY;
  try {
    const hit = getNearestCity(lat, lon);
    return {
      country: typeof hit?.countryName === "string" ? hit.countryName : "",
      city: typeof hit?.cityName === "string" ? hit.cityName : "",
    };
  } catch {
    // A geocoder failure must never break metadata extraction for a photo that
    // is otherwise perfectly usable.
    return EMPTY;
  }
}

const EMPTY = Object.freeze({ country: "", city: "" });
