/**
 * EXIF GPS -> plain {lat, lon}. Pure: no fs, no exifr, no DB.
 *
 * exifr computes merged decimal `latitude`/`longitude` from the raw
 * GPSLatitude/GPSLongitude rationals and their N/S/E/W refs — but ONLY when the
 * GPS tag names are present in the `pick` allowlist. `{ pick, gps: true }` does
 * NOT work: it returns an empty object rather than throwing, which is why this
 * was never noticed. See NodeProcessingService's pick list.
 *
 * 0,0 is deliberately kept: Null Island is a real (if suspicious) coordinate,
 * and silently dropping it would be a data decision this layer has no business
 * making. Out-of-range values are dropped — those are corrupt, not unusual.
 */

/** @param {{latitude?: unknown, longitude?: unknown}|null|undefined} exif
 *  @returns {{lat: number|null, lon: number|null}} */
export function gpsFromExif(exif) {
  const lat = exif?.latitude;
  const lon = exif?.longitude;
  const ok =
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180;
  return ok ? { lat, lon } : { lat: null, lon: null };
}
