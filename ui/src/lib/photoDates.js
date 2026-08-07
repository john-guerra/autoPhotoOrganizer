/**
 * The dates behind a photo's one displayed date (#349).
 *
 * The feed shows ONE date per photo, and it is a `COALESCE` — EXIF, else the
 * file's creation time, else its modification time. That is the right answer
 * to display and the wrong answer to debug with: when a photo lands in a group
 * you did not expect, the single merged value cannot tell you which of the
 * three put it there.
 *
 * The case this was written for: a folder of Pixel photos grouped into **1984**
 * under "sort by Created". EXIF said 2025-01-02, mtime said 2025-01-02, and
 * `btime` said 1984-01-24 — on 1,557 files, all with the identical value.
 *
 * DOM-free on purpose, so the sentinel rule is unit-tested rather than
 * eyeballed through a screenshot.
 */

/**
 * macOS's "I do not know when this file was created" answer.
 *
 * 1984-01-24 is the day the Macintosh was introduced, and Apple uses it as the
 * sentinel birth time for files that have none — which is the normal state of
 * anything copied off a phone, a camera card, or a filesystem with no birth
 * time of its own. `stat` reports it as a perfectly ordinary date, and every
 * layer below this one is right to store it faithfully.
 *
 * Stored as a DAY rather than an instant: the value carries the local timezone
 * of whatever wrote it (08:00Z here, i.e. midnight Pacific), so an equality
 * check against one instant would miss it two timezones over.
 */
const MAC_EPOCH_DAY_START = Date.UTC(1984, 0, 23);
const MAC_EPOCH_DAY_END = Date.UTC(1984, 0, 25, 23, 59, 59, 999);

/**
 * The floor below which a FILE creation date cannot be true.
 *
 * Note this is about the file, not the photograph. A scan of a 1952 print is a
 * perfectly ordinary thing to have in a library and its EXIF may well say 1952
 * — but the JPEG holding it cannot have been created before JPEG existed. 1990
 * is comfortably before any digital camera this app will meet and comfortably
 * after every sentinel it will.
 */
const PLAUSIBLE_FROM = Date.UTC(1990, 0, 1);

/**
 * Is this file-creation timestamp a sentinel rather than a date?
 *
 * @param {number|null|undefined} ms epoch ms
 * @returns {"mac-epoch"|"implausible"|null} why it is not trustworthy, or null
 */
export function birthTimeSuspicion(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  if (ms >= MAC_EPOCH_DAY_START && ms <= MAC_EPOCH_DAY_END) return "mac-epoch";
  if (ms < PLAUSIBLE_FROM) return "implausible";
  return null;
}

/** Human wording for `birthTimeSuspicion`'s verdicts. */
export function suspicionNote(kind) {
  if (kind === "mac-epoch")
    return "not a real date — macOS writes this when a file has no creation date of its own, so the modified date is used instead";
  if (kind === "implausible")
    return "before digital photography — the file cannot really be this old";
  return "";
}

/**
 * Every date this photo has, with the merged one named.
 *
 * `sortAttr` names the feed's current sort so the row that is actually
 * deciding this photo's position can be marked — the whole point is to answer
 * "which of these put it in that group?" without the user matching timestamps
 * by eye.
 *
 * @param {{takenAtExif?:number|null, btime?:number|null, mtime?:number|null}|null} meta
 * @param {string} [sortAttr] e.g. "date_created"
 * @returns {Array<{key:string,label:string,ms:number|null,drives:boolean,note:string}>}
 */
export function dateRows(meta, sortAttr = "") {
  if (!meta) return [];
  const btime = meta.btime ?? null;
  const suspicion = birthTimeSuspicion(btime);
  return [
    {
      key: "exif",
      label: "EXIF taken",
      ms: meta.takenAtExif ?? null,
      // The one sort that does NOT prefer EXIF is date_created, which is
      // exactly why a bad btime is invisible until you sort by it.
      drives: sortAttr === "date_taken" && meta.takenAtExif != null,
      note: meta.takenAtExif == null ? "no EXIF date has been read" : "",
    },
    {
      key: "btime",
      label: "File created",
      ms: btime,
      // A sentinel does NOT drive anything any more: the server skips it and
      // falls through to mtime (#349). Saying "sorting by this" next to a date
      // the feed is deliberately ignoring would be confidently wrong — the
      // exact failure the marker exists to prevent.
      drives:
        !suspicion &&
        (sortAttr === "date_created" ||
          (sortAttr === "date_taken" && meta.takenAtExif == null)),
      note: suspicionNote(suspicion),
    },
    {
      key: "mtime",
      label: "File modified",
      ms: meta.mtime ?? null,
      // Also the answer when the creation date turned out to be a sentinel and
      // the server fell through to here — which is the whole point of showing
      // the marker rather than the user inferring it from the COALESCE order.
      drives:
        sortAttr === "date_modified" ||
        (!!suspicion &&
          (sortAttr === "date_created" ||
            (sortAttr === "date_taken" && meta.takenAtExif == null))),
      note: "",
    },
  ];
}
