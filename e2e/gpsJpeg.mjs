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
