# Places (GPS + offline reverse geocoding + place dimension) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user group, browse, and search their library by where a photo was taken — country → city — using only EXIF GPS and a bundled offline geocoder.

**Architecture:** `exifr` already reads every photo during the metadata sweep; we extend its `pick` list with the four GPS tags, store `lat`/`lon`, reverse-geocode them offline into two denormalized single-valued columns (`place_country`, `place_city`), and register those as ordinary feed group dimensions. Single-valued per photo is what makes them legal dimensions under the feed's keyset-seek invariant. No model, no new runtime, no packaging change.

**Tech Stack:** Node ESM, better-sqlite3, exifr 7.x, `offline-geocode-city` (new dep, 217 kB, bundled dataset, zero network), vitest, Playwright, Svelte 5 runes.

**Spec:** `docs/superpowers/specs/2026-07-24-ml-signals-design.md` §8
**Issue:** #154 — "Places: GPS extraction + offline reverse geocoding + place dimension"

## Global Constraints

- **ESM everywhere** (`"type": "module"`). No TypeScript — plain JS with JSDoc types.
- **Prettier gates CI.** Run `npm run format` before every commit.
- **Version bump + CHANGELOG in the same commit that closes the issue.** Current version is `2.18.2`; this ships as **`2.18.3`** (patch).
- **A fixed bug / new behaviour gets a test at the tier that would have caught it, in the same commit.** Before committing a test, confirm it fails without the implementation.
- **Never fail silently** — a photo with no GPS must read as "Unknown", distinguishable from "not yet extracted".
- **Never modify the user's real photo folders.** All fixtures are generated into temp dirs.
- **Destructive/index tests use a temp `AUTOGALLERY_HOME`**, never the real `~/.autogallery`.
- **Test command:** `npx vitest run <path>` for one file, `npm test` for all.

## Verified facts this plan depends on

These were established empirically before writing the plan. Do not re-derive them; do not "improve" them without re-measuring.

1. **`exifr.parse(path, { pick })` does NOT return GPS**, and adding `gps: true` alongside `pick` **still returns nothing** — it fails silently rather than throwing. The combination that works is **extending the `pick` array itself** with `GPSLatitude`, `GPSLongitude`, `GPSLatitudeRef`, `GPSLongitudeRef`. exifr then also computes the merged decimal `latitude` / `longitude` properties. Verified output: `{"lat":4.711,"lon":-74.0721,"rawLat":[4,42,39.6],"ref":"N"}`.
2. **sharp cannot write GPS EXIF.** `sharp().withExif({ GPS: {...} })` writes IFD0 (Make/Model survive) but **silently drops the GPS block**. Test fixtures must hand-build the EXIF APP1 segment — Task 1 provides that helper.
3. **`offline-geocode-city` returns `{ cityName, countryIso2, countryName }` — no admin1/state/region.** The dataset is bundled; there are no runtime downloads. So the hierarchy is **two levels: country → city**. Do **not** add a `place_admin1` column — an unfilled column that looks like a feature is exactly the `perceptual_hash` mistake (`server/db/schema.js:32`, declared and referenced nowhere).
4. **`camera` and `kind` are group dimensions with no dedicated index.** Place follows that precedent; Task 3 measures and only then adds one.

## File Structure

| File                                         | Responsibility                                                                       | Action |
| -------------------------------------------- | ------------------------------------------------------------------------------------ | ------ |
| `server/lib/exifGps.js`                      | Pure: exifr GPS fields → `{lat, lon}` or nulls                                       | Create |
| `server/lib/place.js`                        | Pure: `{lat, lon}` → `{country, city}` via the offline geocoder                      | Create |
| `e2e/gpsJpeg.mjs`                            | Test-only: hand-build a JPEG carrying EXIF date **and** GPS                          | Create |
| `server/lib/exifGps.test.js`                 | Unit tests for the pure mapper + a real-exifr round-trip                             | Create |
| `server/lib/place.test.js`                   | Unit tests for the geocoder wrapper                                                  | Create |
| `server/processing/NodeProcessingService.js` | Extend the `pick` list; map GPS into `MediaMetadata`                                 | Modify |
| `server/db/schema.js`                        | `lat`, `lon`, `place_country`, `place_city`, `gps_checked` columns                   | Modify |
| `server/db/enrich.js`                        | Persist the new fields; extend `PENDING_CONDITION` so already-enriched rows backfill | Modify |
| `server/db/feed.js`                          | `country` / `city` entries in `DIMENSIONS`                                           | Modify |
| `server/db/tree.js`                          | `formatTreeLabel` — verify no branch needed; add a note                              | Modify |
| `server/db/filters.js`                       | Extend the free-text clause to match place                                           | Modify |
| `ui/src/lib/dimensions.js`                   | `country` / `city` in `ALL_DIMENSIONS`                                               | Modify |
| `ui/src/lib/feed.js`                         | `formatGroupValue` — same verification as its server twin                            | Modify |
| `e2e/fixture.mjs`                            | Give some fixture photos GPS                                                         | Modify |
| `e2e/places.spec.js`                         | End-to-end: group by country, tree counts, search                                    | Create |

**Decomposition note.** `exifGps.js` and `place.js` are separate small pure modules rather than logic inlined into `NodeProcessingService` (611-line file already) or `enrich.js`. Each is independently testable with no DB and no filesystem, which is the whole reason the bugs this app keeps shipping live in seams.

**Why the fixture builder lives in `e2e/`.** Both the vitest test and `e2e/fixture.mjs` need it, so it cannot live inside a `*.test.js` file. It must not live under `server/` either: electron-builder's `files` list ships `server/**/*` and excludes only `*.test.js`, so a fixture builder there would be shipped to users. `e2e/` is not in the `files` list, so nothing ships and both callers can import it.

---

### Task 1: Read GPS out of EXIF

**Files:**

- Create: `server/lib/exifGps.js`
- Create: `server/lib/exifGps.test.js`
- Create: `e2e/gpsJpeg.mjs` (Step 7 — shared with the e2e fixture in Task 5)
- Modify: `server/processing/NodeProcessingService.js` (the `pick` array at ~:330, and `exifToMeta` at :152)
- Modify: `server/processing/ProcessingService.js` (`MediaMetadata` typedef, ~:36)

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `gpsFromExif(exif) => { lat: number|null, lon: number|null }` — from `server/lib/exifGps.js`
  - `withDateAndGps(jpegBuffer, { date, lat, lon }) => Buffer` — from `e2e/gpsJpeg.mjs`, used by this task's test and by Task 5's fixture
  - `NodeProcessingService.metadata()` results gain `lat` and `lon` (both `number|null`) on the `MediaMetadata` object.

- [ ] **Step 1: Write the failing test**

Create `server/lib/exifGps.test.js`. Start with the pure mapper only — no files, no exifr. The JPEG round-trip arrives in Step 8, once there is something to round-trip.

```js
import { describe, it, expect } from "vitest";
import { gpsFromExif } from "./exifGps.js";

describe("gpsFromExif", () => {
  it("reads exifr's merged decimal latitude/longitude", () => {
    expect(gpsFromExif({ latitude: 4.711, longitude: -74.0721 })).toEqual({
      lat: 4.711,
      lon: -74.0721,
    });
  });

  it("returns nulls when the photo has no GPS", () => {
    expect(gpsFromExif({ Make: "Canon" })).toEqual({ lat: null, lon: null });
  });

  it("returns nulls for undefined/null EXIF (no EXIF block at all)", () => {
    expect(gpsFromExif(undefined)).toEqual({ lat: null, lon: null });
    expect(gpsFromExif(null)).toEqual({ lat: null, lon: null });
  });

  it("rejects out-of-range and non-finite coordinates", () => {
    expect(gpsFromExif({ latitude: 91, longitude: 0 })).toEqual({
      lat: null,
      lon: null,
    });
    expect(gpsFromExif({ latitude: 0, longitude: 181 })).toEqual({
      lat: null,
      lon: null,
    });
    expect(gpsFromExif({ latitude: NaN, longitude: 10 })).toEqual({
      lat: null,
      lon: null,
    });
    expect(gpsFromExif({ latitude: "4.7", longitude: -74 })).toEqual({
      lat: null,
      lon: null,
    });
  });

  it("keeps 0,0 — Null Island is a real coordinate, not a missing one", () => {
    expect(gpsFromExif({ latitude: 0, longitude: 0 })).toEqual({
      lat: 0,
      lon: 0,
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run server/lib/exifGps.test.js`
Expected: FAIL — `Failed to resolve import "./exifGps.js"`.

- [ ] **Step 3: Write the module**

Create `server/lib/exifGps.js`:

```js
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
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run server/lib/exifGps.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire GPS into the extraction call**

In `server/processing/NodeProcessingService.js`, add the four GPS tags to the `pick` array (currently nine entries, around line 330). **The order does not matter, but all four are required** — the two `Ref` tags carry the N/S/E/W hemisphere, without which exifr cannot sign the decimals:

```js
const exif = await exifr.parse(path, {
  pick: [
    "DateTimeOriginal",
    "CreateDate",
    "Make",
    "Model",
    "FNumber",
    "ExposureTime",
    "ISO",
    "FocalLength",
    "LensModel",
    // GPS. All four are needed: exifr derives the merged decimal
    // `latitude`/`longitude` from the rationals PLUS the hemisphere
    // refs. Adding `gps: true` instead of these does nothing when
    // `pick` is set — it silently returns {}.
    "GPSLatitude",
    "GPSLongitude",
    "GPSLatitudeRef",
    "GPSLongitudeRef",
  ],
});
```

- [ ] **Step 6: Map GPS into the metadata object**

In the same file, import the helper at the top:

```js
import { gpsFromExif } from "../lib/exifGps.js";
```

and extend `exifToMeta` (line 152) so every caller gets the fields:

```js
export function exifToMeta(exif) {
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const { lat, lon } = gpsFromExif(exif);
  return {
    aperture: num(exif?.FNumber),
    shutter: num(exif?.ExposureTime),
    iso: num(exif?.ISO),
    focalLength: num(exif?.FocalLength),
    lens: typeof exif?.LensModel === "string" ? exif.LensModel : "",
    lat,
    lon,
  };
}
```

Also add the two fields to the `MediaMetadata` typedef in `server/processing/ProcessingService.js` (around :36) so the contract is documented:

```js
 * @property {number|null} [lat]   EXIF GPS latitude, decimal degrees (null = none)
 * @property {number|null} [lon]   EXIF GPS longitude, decimal degrees (null = none)
```

- [ ] **Step 7: Create the shared GPS-JPEG fixture builder**

Create `e2e/gpsJpeg.mjs`. **This exact code is verified working** — it produces a JPEG whose single EXIF segment carries both `DateTimeOriginal` and GPS, and which sharp still reads as a valid JPEG. Do not "simplify" the byte offsets; they are load-bearing.

```js
/**
 * Test-only: build a JPEG carrying EXIF capture date AND GPS, by hand.
 *
 * Hand-rolled for two reasons, both verified:
 *  1. sharp's `withExif` writes IFD0 (Make/Model survive) but SILENTLY DROPS a
 *     GPS block, so there is no way to make a GPS fixture with our deps.
 *  2. Splicing a second APP1 segment next to sharp's `withMetadata` one is not
 *     safe — readers take the FIRST Exif segment, so the two would fight. This
 *     writes ONE segment containing both, and the caller must NOT also use
 *     withMetadata on the same image.
 *
 * Lives in e2e/ (not server/lib/) on purpose: electron-builder ships
 * `server/**` minus `*.test.js`, so a fixture builder there would ship to users.
 *
 * Layout, little-endian TIFF, offsets from the start of the block:
 *   0   header "II" 0x2A, IFD0 offset = 8
 *   8   IFD0: 2 entries -> ExifIFDPointer(0x8769)=38, GPSInfoIFDPointer(0x8825)=56
 *   38  ExifIFD: 1 entry -> DateTimeOriginal(0x9003), ASCII[20] @110
 *   56  GPS IFD: 4 entries -> LatRef, Lat @130, LonRef, Lon @154
 *   110 date string (20 bytes)   130 lat rationals (24)   154 lon rationals (24)
 */

/** Decimal degrees -> [deg, min, sec*100] as EXIF RATIONALs. */
function dms(dec) {
  const a = Math.abs(dec);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  return [
    [d, 1],
    [m, 1],
    [Math.round(((a - d) * 60 - m) * 60 * 100), 100],
  ];
}

/** @param {string} dateStr "YYYY:MM:DD HH:MM:SS" @param {number} lat @param {number} lon */
function exifBlock(dateStr, lat, lon) {
  const EXIF_OFF = 38,
    GPS_OFF = 56,
    DATE_OFF = 110,
    LAT_OFF = 130,
    LON_OFF = 154,
    TOTAL = 178;
  const b = Buffer.alloc(TOTAL);
  b.write("II", 0, "ascii");
  b.writeUInt16LE(0x2a, 2);
  b.writeUInt32LE(8, 4);
  b.writeUInt16LE(2, 8);
  const ent = (o, tag, type, count, val) => {
    b.writeUInt16LE(tag, o);
    b.writeUInt16LE(type, o + 2);
    b.writeUInt32LE(count, o + 4);
    b.writeUInt32LE(val, o + 8);
  };
  ent(10, 0x8769, 4, 1, EXIF_OFF);
  ent(22, 0x8825, 4, 1, GPS_OFF);
  b.writeUInt32LE(0, 34);
  b.writeUInt16LE(1, EXIF_OFF);
  ent(EXIF_OFF + 2, 0x9003, 2, 20, DATE_OFF);
  b.writeUInt32LE(0, EXIF_OFF + 14);
  b.writeUInt16LE(4, GPS_OFF);
  const g = GPS_OFF + 2;
  b.writeUInt16LE(0x0001, g);
  b.writeUInt16LE(2, g + 2);
  b.writeUInt32LE(2, g + 4);
  b.write((lat >= 0 ? "N" : "S") + "\0", g + 8, "ascii");
  ent(g + 12, 0x0002, 5, 3, LAT_OFF);
  b.writeUInt16LE(0x0003, g + 24);
  b.writeUInt16LE(2, g + 26);
  b.writeUInt32LE(2, g + 28);
  b.write((lon >= 0 ? "E" : "W") + "\0", g + 32, "ascii");
  ent(g + 36, 0x0004, 5, 3, LON_OFF);
  b.writeUInt32LE(0, GPS_OFF + 50);
  b.write(dateStr.padEnd(19, " ").slice(0, 19) + "\0", DATE_OFF, "ascii");
  dms(lat).forEach(([n, d], i) => {
    b.writeUInt32LE(n, LAT_OFF + i * 8);
    b.writeUInt32LE(d, LAT_OFF + i * 8 + 4);
  });
  dms(lon).forEach(([n, d], i) => {
    b.writeUInt32LE(n, LON_OFF + i * 8);
    b.writeUInt32LE(d, LON_OFF + i * 8 + 4);
  });
  return b;
}

/**
 * Splice a date+GPS EXIF segment into a plain JPEG buffer.
 * @param {Buffer} jpeg a JPEG built WITHOUT withMetadata/withExif
 * @param {{date: string, lat: number, lon: number}} opts
 * @returns {Buffer}
 */
export function withDateAndGps(jpeg, { date, lat, lon }) {
  const payload = Buffer.concat([
    Buffer.from("Exif\0\0", "ascii"),
    exifBlock(date, lat, lon),
  ]);
  const h = Buffer.alloc(4);
  h.writeUInt16BE(0xffe1, 0);
  h.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), h, payload, jpeg.subarray(2)]);
}
```

- [ ] **Step 8: Add an integration test proving a real JPEG round-trips**

Append to `server/lib/exifGps.test.js`. This is the test that would have caught the `pick` trap — it exercises the _actual_ exifr call, not the pure mapper:

```js
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import exifr from "exifr";
import { exifToMeta } from "../processing/NodeProcessingService.js";
import { withDateAndGps } from "../../e2e/gpsJpeg.mjs";

const PICK = [
  "DateTimeOriginal",
  "CreateDate",
  "Make",
  "Model",
  "FNumber",
  "ExposureTime",
  "ISO",
  "FocalLength",
  "LensModel",
  "GPSLatitude",
  "GPSLongitude",
  "GPSLatitudeRef",
  "GPSLongitudeRef",
];

describe("GPS through the real exifr call", () => {
  it("extracts lat/lon AND the capture date using the app's own pick list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gps-"));
    const file = join(dir, "geo.jpg");
    const base = await sharp({
      create: { width: 64, height: 48, channels: 3, background: "#1a5aa0" },
    })
      .jpeg()
      .toBuffer();
    writeFileSync(
      file,
      withDateAndGps(base, {
        date: "2024:01:10 09:05:00",
        lat: 4.711,
        lon: -74.0721,
      })
    );

    const exif = await exifr.parse(file, { pick: PICK });
    const meta = exifToMeta(exif);
    expect(meta.lat).toBeCloseTo(4.711, 4);
    expect(meta.lon).toBeCloseTo(-74.0721, 4);
    // The date must survive too: the fixture writes ONE Exif segment holding
    // both, and a reader that took only the first IFD would lose one of them.
    expect(exif.DateTimeOriginal).toBeInstanceOf(Date);
  });

  it("a JPEG with no GPS yields null lat/lon, not undefined", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gps-"));
    const file = join(dir, "plain.jpg");
    const base = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#000" },
    })
      .jpeg()
      .toBuffer();
    writeFileSync(file, base);
    const exif = await exifr.parse(file, { pick: PICK });
    expect(exifToMeta(exif)).toMatchObject({ lat: null, lon: null });
  });
});
```

- [ ] **Step 9: Prove the integration test catches the trap**

Temporarily remove the four GPS tags from the test's `PICK` constant, re-run, and confirm the first case fails with `expected null to be close to 4.711`. Restore them. **If it still passes, the test is decoration — stop and fix it.**

Run: `npx vitest run server/lib/exifGps.test.js`

- [ ] **Step 10: Format and commit**

```bash
npm run format
git add server/lib/exifGps.js server/lib/exifGps.test.js e2e/gpsJpeg.mjs \
        server/processing/NodeProcessingService.js server/processing/ProcessingService.js
git commit -m "feat(places): read EXIF GPS during metadata extraction (#154)

exifr never returned GPS because the pick allowlist omitted it. Note that
adding \`gps: true\` alongside \`pick\` does NOT work — it returns {} silently;
the GPS tag names must be in the pick array itself, all four (the Ref tags
carry the hemisphere).

Test fixture hand-builds the EXIF APP1 segment because sharp's withExif
drops the GPS block."
```

---

### Task 2: Reverse-geocode to country + city, offline

**Files:**

- Create: `server/lib/place.js`
- Create: `server/lib/place.test.js`
- Modify: `package.json` (add `offline-geocode-city`)

**Interfaces:**

- Consumes: `{ lat, lon }` as produced by Task 1.
- Produces: `placeFor(lat, lon) => { country: string, city: string }` — **always strings, `""` when unknown**, matching the `''`-is-Unknown sentinel every existing dimension uses (`server/db/feed.js:24` doc comment).

- [ ] **Step 1: Install the dependency**

```bash
npm install offline-geocode-city
```

217 kB, dataset bundled, **zero network calls at runtime** — which is the whole point, since the app must work with no connection.

- [ ] **Step 2: Write the failing test**

Create `server/lib/place.test.js`:

```js
import { describe, it, expect } from "vitest";
import { placeFor } from "./place.js";

describe("placeFor", () => {
  it("resolves a well-known coordinate to its country and city", () => {
    const p = placeFor(4.711, -74.0721); // Bogota, Colombia
    expect(p.country).toBe("Colombia");
    expect(p.city).toBeTruthy();
  });

  it("returns the '' Unknown sentinel — never null — for missing coordinates", () => {
    expect(placeFor(null, null)).toEqual({ country: "", city: "" });
    expect(placeFor(undefined, undefined)).toEqual({ country: "", city: "" });
    expect(placeFor(4.711, null)).toEqual({ country: "", city: "" });
  });

  it("returns the sentinel rather than throwing when the geocoder finds nothing", () => {
    const p = placeFor(0, 0); // Null Island, mid-Atlantic
    expect(typeof p.country).toBe("string");
    expect(typeof p.city).toBe("string");
  });

  it("never throws on absurd input", () => {
    expect(() => placeFor(NaN, NaN)).not.toThrow();
    expect(placeFor(NaN, NaN)).toEqual({ country: "", city: "" });
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run server/lib/place.test.js`
Expected: FAIL — cannot resolve `./place.js`.

- [ ] **Step 4: Write the module**

Create `server/lib/place.js`:

```js
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
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx vitest run server/lib/place.test.js`
Expected: PASS (4 tests).

If the Bogotá case returns an unexpected country, print the raw result (`console.log(getNearestCity(4.711, -74.0721))`) and adjust the expectation to the dataset's actual answer — but **only the expectation, never the assertion that it is non-empty.**

- [ ] **Step 6: Format and commit**

```bash
npm run format
git add package.json package-lock.json server/lib/place.js server/lib/place.test.js
git commit -m "feat(places): offline reverse geocoding to country + city (#154)

offline-geocode-city: 217kB, dataset bundled, no network. Two levels only
— the package has no admin1/region, and an unfilled place_admin1 column
would repeat the perceptual_hash mistake."
```

---

### Task 3: Persist lat/lon + place, and backfill the existing library

**Files:**

- Modify: `server/db/schema.js` (after the `pix_fmt` column, ~:133)
- Modify: `server/db/enrich.js` (`PENDING_CONDITION` :33, `writeMeta` :117)
- Modify: `server/db/photos.js` (`upsertScan`'s `ON CONFLICT` `CASE`, ~:39)
- Modify: `server/db/enrich.test.js` (add cases; create the file if absent)

**Interfaces:**

- Consumes: `exifToMeta`'s `lat`/`lon` (Task 1), `placeFor` (Task 2).
- Produces: `photos.lat`, `photos.lon` (REAL, nullable), `photos.place_country`, `photos.place_city` (TEXT, nullable), `photos.gps_checked` (INTEGER NOT NULL DEFAULT 0).

**Why `gps_checked` exists — read this before changing it.** `PENDING_CONDITION` is `width IS NULL OR (kind='video' AND video_codec IS NULL)`. Every one of the ~114k already-enriched photos has a `width`, so **none of them would ever come back through the sweep to have GPS read.** `server/db/enrich.js:25-32` documents this exact failure for `video_codec`, which was added late and left 1,171 of 1,173 videos unprobed. We cannot key the backfill on `lat IS NULL` either, because most photos legitimately have no GPS and would be retried forever. A dedicated "we have looked" flag is the only correct answer — and per #169, a sentinel must mean _"we looked"_, never _"the file was unreachable"_.

- [ ] **Step 1: Write the failing test**

Add to `server/db/enrich.test.js`:

```js
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import { writeMeta, pendingMetaCount } from "./enrich.js";

describe("GPS + place persistence", () => {
  let db, photoId;
  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    db.prepare("INSERT INTO folders (abs_path) VALUES ('/lib')").run();
    photoId = db
      .prepare(
        `INSERT INTO photos (folder_id, filename, size, mtime, kind)
         VALUES (1, 'a.jpg', 10, 100, 'image')`
      )
      .run().lastInsertRowid;
  });

  it("stores coordinates and the resolved place", () => {
    writeMeta(db, photoId, { width: 4, height: 3, lat: 4.711, lon: -74.0721 });
    const row = db
      .prepare(
        "SELECT lat, lon, place_country, place_city, gps_checked FROM photos"
      )
      .get();
    expect(row.lat).toBeCloseTo(4.711, 4);
    expect(row.place_country).toBe("Colombia");
    expect(row.gps_checked).toBe(1);
  });

  it("marks gps_checked even when the photo has NO GPS, so it is not retried forever", () => {
    writeMeta(db, photoId, { width: 4, height: 3 });
    const row = db
      .prepare("SELECT lat, place_country, gps_checked FROM photos")
      .get();
    expect(row.lat).toBeNull();
    expect(row.place_country).toBe(""); // the Unknown sentinel, not null
    expect(row.gps_checked).toBe(1);
  });

  it("an already-enriched photo with gps_checked = 0 is still pending (backfill)", () => {
    // Simulates a row enriched BEFORE this feature existed: it has a width, so
    // the old PENDING_CONDITION considered it done.
    db.prepare(
      "UPDATE photos SET width = 100, height = 50, gps_checked = 0"
    ).run();
    expect(pendingMetaCount(db)).toBe(1);
  });

  it("stops being pending once it has been checked", () => {
    db.prepare(
      "UPDATE photos SET width = 100, height = 50, gps_checked = 1"
    ).run();
    expect(pendingMetaCount(db)).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run server/db/enrich.test.js`
Expected: FAIL — `no such column: lat`.

- [ ] **Step 3: Add the columns**

In `server/db/schema.js`, immediately after the `pix_fmt` line (~:133):

```js
// Places (#154). lat/lon are the raw EXIF coordinates; place_country and
// place_city are the offline-reverse-geocoded, DENORMALIZED single values
// that make place a legal feed group dimension (the keyset seek assumes one
// value per photo per dimension — see server/db/feed.js:53-77).
//
// gps_checked is the "we have looked" marker, and it is load-bearing: the
// sweep's to-do list keys on `width IS NULL`, so every photo enriched before
// this feature existed already has a width and would NEVER come back to have
// its GPS read. That is exactly what happened to video_codec (1,171 of 1,173
// videos left unprobed — see db/enrich.js). Keying on `lat IS NULL` instead
// is not an option: most photos genuinely have no GPS and would be retried on
// every sweep, forever.
ensureColumn(db, "photos", "lat", "REAL");
ensureColumn(db, "photos", "lon", "REAL");
ensureColumn(db, "photos", "place_country", "TEXT");
ensureColumn(db, "photos", "place_city", "TEXT");
ensureColumn(db, "photos", "gps_checked", "INTEGER NOT NULL DEFAULT 0");
```

- [ ] **Step 4: Extend the sweep's to-do list**

In `server/db/enrich.js`, replace `PENDING_CONDITION` (:33):

```js
const PENDING_CONDITION = `photos.stale = 0
    AND (photos.width IS NULL
         OR (photos.kind = 'video' AND photos.video_codec IS NULL)
         OR photos.gps_checked = 0)`;
```

Extend the file's SENTINELS doc block (:13-22) with:

```
 *  - `gps_checked` 0 = EXIF GPS has never been looked for. 1 = looked, whatever
 *    the answer. Photos indexed before places existed have a width and would
 *    otherwise never return here; this is the same "a column added late needs a
 *    way to be filled late" problem video_codec had.
```

- [ ] **Step 5: Persist the fields**

In `server/db/enrich.js`, import the geocoder at the top:

```js
import { placeFor } from "../lib/place.js";
```

and extend `writeMeta`'s `fields` object plus its `UPDATE`:

```js
const { country, city } = placeFor(m.lat ?? null, m.lon ?? null);
const fields = {
  // ... every existing field unchanged ...
  lat: m.lat ?? null,
  lon: m.lon ?? null,
  // "" (not NULL) is the Unknown sentinel every dimension uses.
  place_country: country,
  place_city: city,
  gps_checked: 1,
};
db.prepare(
  `UPDATE photos SET taken_at = @taken_at, width = @width, height = @height,
       camera = @camera, duration = @duration, aperture = @aperture,
       shutter = @shutter, iso = @iso, focal_length = @focal_length,
       lens = @lens, video_codec = @video_codec, pix_fmt = @pix_fmt,
       lat = @lat, lon = @lon, place_country = @place_country,
       place_city = @place_city, gps_checked = @gps_checked
     WHERE id = @id`
).run({ ...fields, id });
```

- [ ] **Step 6: Invalidate on a changed file**

In `server/db/photos.js`, extend `upsertScan`'s `ON CONFLICT` block (after the `hash_attempted` `CASE`, ~:51) so replacing a file re-reads its GPS:

```js
      ,
      -- A changed file may have been re-exported with different (or stripped)
      -- GPS, so clear the "we looked" marker and let the sweep look again.
      gps_checked = CASE
        WHEN photos.size = excluded.size AND photos.mtime = excluded.mtime
        THEN photos.gps_checked
        ELSE 0
      END
```

- [ ] **Step 7: Run the tests and watch them pass**

Run: `npx vitest run server/db/enrich.test.js`
Expected: PASS (4 new cases).

- [ ] **Step 8: Run the whole server suite for regressions**

Run: `npx vitest run server/`
Expected: all green. `writeMeta` gained columns, so any test asserting an exact row shape may need the new fields added — update the assertion, never the production code, unless the failure reveals a genuine bug.

- [ ] **Step 9: Format and commit**

```bash
npm run format
git add server/db/schema.js server/db/enrich.js server/db/photos.js server/db/enrich.test.js
git commit -m "feat(places): store lat/lon + resolved place, and backfill old rows (#154)

gps_checked is the 'we have looked' marker. Without it every already-
enriched photo (all ~114k, they all have a width) would never come back
through the sweep to have GPS read — the exact gap that left 1,171 of
1,173 videos unprobed when video_codec was added late."
```

---

### Task 4: Country and city as feed group dimensions

**Files:**

- Modify: `server/db/feed.js` (`DIMENSIONS` :24-51)
- Modify: `server/db/tree.js` (`formatTreeLabel` :103)
- Modify: `ui/src/lib/dimensions.js` (`ALL_DIMENSIONS` :10)
- Modify: `ui/src/lib/feed.js` (`formatGroupValue` :25)
- Modify: `server/db/queryPlan.test.js`
- Modify: `server/db/tree.test.js` (create if absent)

**Interfaces:**

- Consumes: `photos.place_country` / `photos.place_city` (Task 3).
- Produces: dimension names **`country`** and **`city`**, valid in `groupBy` everywhere. Named to match the existing bare-noun convention (`camera`, `kind`), not `placeCountry`.

- [ ] **Step 1: Write the failing test**

Add to `server/db/tree.test.js`:

```js
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import { getTreeNode } from "./tree.js";

describe("place dimensions", () => {
  let db;
  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    db.prepare("INSERT INTO folders (abs_path) VALUES ('/lib')").run();
    const add = db.prepare(
      `INSERT INTO photos (folder_id, filename, size, mtime, kind, width,
                           place_country, place_city, gps_checked)
       VALUES (1, ?, 10, 100, 'image', 4, ?, ?, 1)`
    );
    add.run("a.jpg", "Colombia", "Bogota");
    add.run("b.jpg", "Colombia", "Medellin");
    add.run("c.jpg", "Spain", "Madrid");
    add.run("d.jpg", "", ""); // no GPS -> Unknown
  });

  it("groups by country with correct counts", () => {
    const { nodes } = getTreeNode(db, { groupBy: ["country"], path: [] });
    const byLabel = Object.fromEntries(nodes.map((n) => [n.label, n.count]));
    expect(byLabel["Colombia"]).toBe(2);
    expect(byLabel["Spain"]).toBe(1);
  });

  it("labels the empty-string sentinel as Unknown, not as a blank row", () => {
    const { nodes } = getTreeNode(db, { groupBy: ["country"], path: [] });
    expect(nodes.some((n) => n.label === "Unknown" && n.count === 1)).toBe(
      true
    );
  });

  it("nests city under country", () => {
    const { nodes } = getTreeNode(db, {
      groupBy: ["country", "city"],
      path: [{ dimension: "country", value: "Colombia" }],
    });
    expect(nodes.map((n) => n.label).sort()).toEqual(["Bogota", "Medellin"]);
  });
});
```

⚠️ Check `getTreeNode`'s actual signature and the shape of its returned nodes in `server/db/tree.js:16` before running — mirror the call style used by the existing tests in that file rather than trusting the sketch above.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run server/db/tree.test.js`
Expected: FAIL — `unknown dimension: country` from `resolveDimensions`.

- [ ] **Step 3: Register the dimensions**

In `server/db/feed.js`, add to `DIMENSIONS` after `camera` (:49):

```js
  // Places (#154). Denormalized single-valued columns, which is precisely what
  // makes them legal here — the keyset seek assumes one value per photo per
  // dimension. COALESCE to '' matches the Unknown sentinel every other
  // dimension uses (a photo with no GPS, or one indexed before places existed).
  country: { expr: "COALESCE(photos.place_country, '')", direction: "ASC" },
  city: { expr: "COALESCE(photos.place_city, '')", direction: "ASC" },
```

- [ ] **Step 4: Add the client dimension list entry**

In `ui/src/lib/dimensions.js`, extend `ALL_DIMENSIONS`:

```js
export const ALL_DIMENSIONS = [
  "folder",
  "folderName",
  "year",
  "month",
  "day",
  "camera",
  "kind",
  "country",
  "city",
];
```

- [ ] **Step 5: Verify both label functions**

`formatTreeLabel` (`server/db/tree.js:103`) and `formatGroupValue` (`ui/src/lib/feed.js:25`) both already map `""` → `"Unknown"` unconditionally, and place values are plain display strings. **So no branch is needed in either.** Read both functions and confirm this before moving on — they are hand-kept twins with no shared module, and a divergence here is invisible until a user sees two different labels for one group.

Add a one-line note to each function's doc comment recording that place needs no special case:

```
 * Place dimensions (country/city) need no branch — their values are already
 * display strings, and '' is handled by the Unknown rule above.
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `npx vitest run server/db/tree.test.js`
Expected: PASS (3 cases).

- [ ] **Step 7: Measure the query plan before deciding on an index**

`camera` and `kind` are group dimensions with **no** dedicated index, so place follows that precedent until measurement says otherwise. Add to `server/db/queryPlan.test.js`, matching the style of the existing cases (reuse its `capturingSql` helper and its `isFullScan` / `isTempSort` predicates — do **not** hand-roll new ones):

```js
it("a country/city grouped page does not full-scan photos", () => {
  const lines = capturingSql(db, () =>
    getFeedPage(db, { groupBy: ["country", "city"], limit: 50 })
  );
  expect(lines.filter(isFullScan)).toEqual([]);
});
```

Run: `npx vitest run server/db/queryPlan.test.js`

- **If it passes:** add no index. Commit as is.
- **If it fails**, add one composite index in `server/db/schema.js` beside the other explicit ones, then re-run:

```js
// Grouping by place scans otherwise — measured, not assumed (see queryPlan.test.js).
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_photos_place
       ON photos (place_country, place_city) WHERE stale = 0`
);
```

Record which branch you took in the commit message.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 9: Format and commit**

```bash
npm run format
git add server/db/feed.js server/db/tree.js server/db/tree.test.js \
        server/db/queryPlan.test.js server/db/schema.js \
        ui/src/lib/dimensions.js ui/src/lib/feed.js
git commit -m "feat(places): group the feed and tree by country and city (#154)

Single-valued denormalized columns, so they satisfy the keyset seek's
one-value-per-photo-per-dimension invariant and need no new feed path.
Both label functions already handle the '' Unknown sentinel, so neither
twin needed a branch."
```

---

### Task 5: Make place searchable, then ship it

**Files:**

- Modify: `server/db/filters.js` (the free-text clause :107-114)
- Modify: `server/db/filters.test.js`
- Modify: `e2e/fixture.mjs`
- Create: `e2e/places.spec.js`
- Modify: `package.json` (version), `CHANGELOG.md`

**Interfaces:**

- Consumes: everything above.
- Produces: the existing `text` filter facet also matches country and city.

**Scope decision — read this.** The spec and issue #154 both mention a _dedicated_ place filter facet. This task deliberately ships **place inside the existing free-text search** instead, because that is a four-line change to one clause with **no new UI, no `parseFilterParam` allowlist entry, and no `filterSpec.js` change** — the three-layer cost is zero since `text` already traverses all three. A dedicated facet needs a place picker to be worth anything (a raw list of every country is not a control), and that belongs with the view work. Note this deviation on #154 rather than silently dropping it.

- [ ] **Step 1: Write the failing test**

Add to `server/db/filters.test.js`:

```js
it("free-text search matches the place a photo was taken", () => {
  const { sql, params } = buildFilter({ text: "Bogota" });
  expect(sql).toContain("place_country");
  expect(sql).toContain("place_city");
  expect(params.filter((p) => p === "%Bogota%").length).toBeGreaterThanOrEqual(
    3
  );
});

it("escapes LIKE metacharacters in a place search", () => {
  const { params } = buildFilter({ text: "100%" });
  expect(params.every((p) => !String(p).includes("100%%"))).toBe(true);
  expect(params.some((p) => String(p).includes("100\\%"))).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run server/db/filters.test.js`
Expected: FAIL — `sql` does not contain `place_country`.

- [ ] **Step 3: Extend the text clause**

In `server/db/filters.js`, replace the `if (text) { ... }` body (:108-114):

```js
if (text) {
  const like = `%${text.replace(/([\\%_])/g, "\\$1")}%`;
  clauses.push(
    `(photos.filename LIKE ? ESCAPE '\\'
        OR photos.place_country LIKE ? ESCAPE '\\'
        OR photos.place_city LIKE ? ESCAPE '\\'
        OR photos.folder_id IN (SELECT id FROM folders WHERE abs_path LIKE ? ESCAPE '\\'))`
  );
  params.push(like, like, like, like);
}
```

Update the clause's doc comment (:95-106) to say place is now searched too, and why: place is per-photo and needs no subquery, unlike the folder path.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run server/db/filters.test.js`
Expected: PASS.

- [ ] **Step 5: Give the e2e fixture some GPS**

In `e2e/fixture.mjs`, add the import and a coordinate table near the other fixture constants:

```js
import { withDateAndGps } from "./gpsJpeg.mjs";

/**
 * GPS for the FIRST TWO photos of the first folder: same country, different
 * cities. That one structure exercises everything at once — a country group
 * with a real count, city nesting under it, and (because every other photo has
 * no GPS) the Unknown bucket. One clever fixture beats five specs.
 *
 * These two photos are written by hand rather than through sharp's
 * `withMetadata`, because sharp cannot write GPS and two Exif segments would
 * fight. `withDateAndGps` carries the capture date too, so their dates stay
 * consistent with the rest of the folder.
 */
export const GPS_PHOTOS = [
  { index: 0, city: "Bogota", lat: 4.711, lon: -74.0721 },
  { index: 1, city: "Medellin", lat: 6.2442, lon: -75.5812 },
];
export const GPS_COUNTRY = "Colombia";
```

Then, inside `buildFixture`'s photo loop, branch on whether this photo gets GPS. Replace the existing `await sharp({...}).withMetadata(...).jpeg().toFile(...)` call with:

```js
const dest = join(dir, `img_${String(i).padStart(2, "0")}.jpg`);
const geo =
  folder === FOLDERS[0] ? GPS_PHOTOS.find((g) => g.index === i) : undefined;

if (geo) {
  // Hand-written EXIF: sharp drops GPS, and a second Exif segment beside
  // sharp's would be ignored by readers that take the first one.
  const plain = await sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      background: { r: 40 + i * 20, g: 90, b: 160 },
    },
  })
    .jpeg()
    .toBuffer();
  writeFileSync(
    dest,
    withDateAndGps(plain, { date, lat: geo.lat, lon: geo.lon })
  );
} else {
  await sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      background: { r: 40 + i * 20, g: 90, b: 160 },
    },
  })
    .withMetadata({ exif: { IFD2: { DateTimeOriginal: date } } })
    .jpeg()
    .toFile(dest);
}
```

Add `writeFileSync` to the `node:fs` import at the top of the file.

⚠️ Confirm the loop's local variable names (`w`, `h`, `date`, `dir`, `i`, `folder`) against the real file before pasting — this mirrors the version read at planning time.

- [ ] **Step 6: Write the e2e spec**

Create `e2e/places.spec.js`. It uses only selectors that already exist in `e2e/helpers.js` (`group`, `tree`, `toolbar`); if a needed selector is missing, **add it to `helpers.js`, never inline it in the spec**.

```js
import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, group, tree } from "./helpers.js";
import { GPS_PHOTOS, GPS_COUNTRY } from "./fixture.mjs";

/**
 * Places (#154). The interesting risk here is NOT "does grouping work" — it is
 * the seam: a dimension or facet that looks right in the feed while the tree
 * counts disagree. That is where this app's shipped bugs keep coming from, so
 * the tree/feed agreement case is the point of this file.
 */
test.describe("@p1 places", () => {
  test("groups the feed by country, with photos that have no GPS under Unknown", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["country"] });

    const labels = await page.locator(".section-header").allInnerTexts();
    const joined = labels.join(" | ");
    expect(joined).toContain(GPS_COUNTRY);
    // Every other fixture photo has no GPS, so Unknown must exist and must be
    // a real labelled group — not a blank header.
    expect(joined).toContain("Unknown");

    expect(errors).toEqual([]);
  });

  test("nests city under country", async ({ page }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["country", "city"] });

    const joined = (await page.locator(".section-header").allInnerTexts()).join(
      " | "
    );
    for (const { city } of GPS_PHOTOS) expect(joined).toContain(city);

    expect(errors).toEqual([]);
  });

  test("the tree's country count matches the feed's", async ({ page }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["country"] });

    // The API is the lowest layer and the one that actually decides both — check
    // it directly rather than inferring from two rendered numbers.
    const res = await page.request.get(
      `/api/tree?groupBy=${encodeURIComponent(JSON.stringify(["country"]))}`
    );
    expect(res.ok()).toBe(true);
    const { nodes = [] } = await res.json();
    const colombia = nodes.find((n) => n.label === GPS_COUNTRY);
    expect(
      colombia,
      `no ${GPS_COUNTRY} node in ${JSON.stringify(nodes)}`
    ).toBeTruthy();
    expect(colombia.count).toBe(GPS_PHOTOS.length);

    expect(errors).toEqual([]);
  });

  test("searching a place name narrows the feed to photos taken there", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["country"] });

    const city = GPS_PHOTOS[0].city;
    const res = await page.request.get(
      `/api/photos/ids?filter=${encodeURIComponent(JSON.stringify({ text: city }))}`
    );
    expect(res.ok()).toBe(true);
    const { ids = [] } = await res.json();
    expect(ids.length).toBe(1); // exactly the one photo shot in that city

    expect(errors).toEqual([]);
  });
});
```

⚠️ Verify the `/api/tree` and `/api/photos/ids` query-parameter shapes against `ui/src/lib/api.js` (`:400-535`) before running — those two calls are written from the client's serialization contract and are the most likely thing in this spec to need a tweak.

- [ ] **Step 7: Run the e2e suite**

Run: `npx playwright test e2e/places.spec.js`
Expected: PASS. If `e2e/albums.spec.js` is run too and fails around its album-count precondition, that is a known pre-existing flake (~20-40%) — retry before assuming a regression.

- [ ] **Step 8: Bump the version and write the changelog**

`package.json`: `2.18.2` → `2.18.3`.

`CHANGELOG.md`, directly under the intro block:

```markdown
## 2.18.3

- **Group and search your photos by where they were taken.** AutoGallery now
  reads the GPS in your photos and resolves it to a country and city — entirely
  offline, no accounts and no network. Group the feed or the Library tree by
  Country or City, and type a place name into search to find everything shot
  there. Photos without GPS group under "Unknown". Existing libraries fill in
  automatically in the background after the next scan (#154).
```

- [ ] **Step 9: Full verification before claiming done**

```bash
npm run format
npm test
npx playwright test
```

All three must be green. Then **run the real app** and confirm by hand: `npm run dev`, group by Country, open the tree, search a city. Per the project's live-verification rule, a passing suite plus a plausible screenshot is not sufficient for anything touching the feed window.

⚠️ `npm run dev` does **not** watch `server/`. Restart it after server changes or you will be testing stale code.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(places): search by place, e2e coverage, ship 2.18.3 (#154)

Place rides the existing free-text facet rather than getting a dedicated
one: `text` already spans all three filter layers, so this costs no
allowlist entry and no new UI. A dedicated picker belongs with the view
work — noted on #154.

Closes #154"
```

---

## Deviations from the spec, to note on #154

1. **Two place levels, not three.** `offline-geocode-city` has no admin1/region. A `place_admin1` column nothing fills would repeat the `perceptual_hash` mistake. Upgrade path: swap the geocoder adapter in `server/lib/place.js` — the column set and dimensions are the only other change.
2. **No dedicated filter facet.** Place joins the existing free-text search (Task 5's scope note). A dedicated picker is deferred.
3. **`gps_checked` is a new sentinel column** the spec did not anticipate. It is required for backfill; the rationale is in Task 3's preamble.

## Follow-ups worth their own issues

- A **map view** — now that lat/lon exist, this is a natural client of the view registry (#155).
- A **dedicated place filter facet** with a picker, once there is a control worth building.
- **Place-aware album naming** — #79 wants meaningful album names, and "Bogotá, March 2026" is achievable with no model at all.
