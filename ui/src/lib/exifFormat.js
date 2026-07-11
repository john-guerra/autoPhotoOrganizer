/** Human-readable EXIF/file formatting for the Loupe details panel. Each helper
 * returns "" for a missing or invalid value so the panel can render an em dash
 * (—) uniformly. Pure — unit-tested in exifFormat.test.js. */

export function formatAperture(f) {
  if (typeof f !== "number" || !(f > 0)) return "";
  return `ƒ/${f % 1 === 0 ? f : f.toFixed(1)}`;
}

export function formatShutter(s) {
  if (typeof s !== "number" || !(s > 0)) return "";
  if (s < 1) return `1/${Math.round(1 / s)} s`;
  return `${s % 1 === 0 ? s : s.toFixed(1)} s`;
}

export function formatIso(iso) {
  return typeof iso === "number" && iso > 0 ? `ISO ${iso}` : "";
}

export function formatFocal(mm) {
  return typeof mm === "number" && mm > 0 ? `${Math.round(mm)} mm` : "";
}

export function formatSize(bytes) {
  if (typeof bytes !== "number" || !(bytes > 0)) return "";
  const mb = bytes / 1e6;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`;
}

export function formatDimensions(w, h) {
  return w > 0 && h > 0 ? `${w} × ${h}` : "";
}
