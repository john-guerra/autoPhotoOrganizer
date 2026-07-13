/** Decides which characters of a folder name are worth a pixel.
 *
 * Measured on a real 1,200-folder library: 56/56
 * children of 2005/ start with "2005_", 1036/1234 folders end in "_peq", and the
 * median basename is 39 chars against a ~30-char sidebar. So nearly every label
 * overflows, and WHICH characters survive is the whole design. Cutting by
 * position (a middle ellipsis) keeps the noise and drops the signal:
 *
 *   2013_01Jan_02_Harbour_Walk_Selected_peq  ->  "2013_01Ja…_peq"   (useless)
 *
 * So we cut by information content instead. A token that appears in nearly every
 * folder in the library ("peq", "selected") discriminates nothing — its IDF is
 * ~0 bits. A token that is identical across every sibling in a group ("2005"
 * under 2005/) has zero entropy by definition. Those are the tokens to spend no
 * pixels on. Everything else is signal and is kept.
 *
 * The rule is computed, never hardcoded, which is why it also handles a library
 * it has never seen: point it at an SD card and "CANON" goes quiet while
 * "100"/"101" stay bright. And it keeps sibling pairs distinguishable that a
 * stopword list would have collapsed:
 *
 *   ..._Harbour_Selected_peq          ->  Harbour + Selected
 *   ..._Harbour_Selected_starred_peq  ->  Harbour + starred  ("starred" is rare -> bright)
 */

const SEPARATORS = /([_\-\s/]+)/;

/** Splits a name into tokens, remembering the separator that followed each one
 * so a rebuilt label still reads like the original name. */
export function tokenize(name) {
  const parts = String(name).split(SEPARATORS);
  const tokens = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i];
    if (!text) continue;
    tokens.push({ text, sep: parts[i + 1] ?? "" });
  }
  return tokens;
}

/** Document frequency of every token across the whole library.
 *
 * The corpus is EVERY folder path in the library, not the currently visible or
 * filtered subset, so a label never reshuffles as you filter, expand, or scroll.
 * Stable labels are worth more than perfectly-tuned ones.
 *
 * Counts tokens from the WHOLE path, not just the basename. That is what makes
 * the shared prefix ("/Users/me/Pictures/library") recede on its own — it
 * is on every folder, so its df is 1.0 and the ordinary rule quiets it. No
 * special case for "the path part" is needed, and a directory that is genuinely
 * rare (one-off_Contest/) stays bright, as it should.
 *
 * @param {string[]} allFolderPaths
 */
export function buildTokenStats(allFolderPaths) {
  const df = new Map();
  const paths = allFolderPaths ?? [];
  for (const path of paths) {
    const seen = new Set();
    for (const { text } of tokenize(path)) seen.add(text.toLowerCase());
    for (const token of seen) df.set(token, (df.get(token) ?? 0) + 1);
  }
  return { docCount: paths.length, df };
}

export const EMPTY_STATS = { docCount: 0, df: new Map() };

/** parent directory -> the names of every folder in it. A folder's siblings are
 * what decides which of its tokens are redundant, and the tree only knows the
 * siblings it has on screen — the feed's headers need to look them up. */
export function buildSiblingIndex(allFolderPaths) {
  const index = new Map();
  for (const path of allFolderPaths ?? []) {
    const parent = dirname(path);
    if (!index.has(parent)) index.set(parent, []);
    index.get(parent).push(basename(path));
  }
  return index;
}

export function basename(path) {
  return String(path).split("/").filter(Boolean).pop() ?? "";
}

export function dirname(path) {
  const segments = String(path).split("/").filter(Boolean);
  segments.pop();
  return segments.length ? `/${segments.join("/")}` : "/";
}

/** How common a token is across the library: the raw count of folders it appears
 * on, and that as a fraction (1 = every folder). */
function commonness(token, stats) {
  const count = stats.df.get(token.toLowerCase()) ?? 0;
  return { count, df: stats.docCount ? count / stats.docCount : 0 };
}

/** A token on 8% or more of the library's folders is common enough that it isn't
 * what tells this folder apart. Set from a real library's measured distribution:
 * the resize suffix 0.85, the cull marker 0.33, years ~0.11, "starred" 0.10,
 * month tokens 0.05-0.10 — against ordinary content words (a recurring person's
 * name, a recurring word like "birthday") at 0.05-0.06, just underneath. The line
 * has to sit where it does BECAUSE those two bands nearly touch: any lower and a
 * name you actually search for goes quiet along with the boilerplate. */
const DIM_DF = 0.08;

/** ...but a ratio is meaningless on a small library: with 7 folders the SMALLEST
 * possible df is 0.14, so every token would clear the bar and the whole tree
 * would come out grey. A token has to actually repeat — on at least this many
 * folders — before it counts as common. */
const DIM_MIN_COUNT = 3;

/**
 * How much of the row's width a token deserves.
 *
 *   "dim"  — common, or repeated by every sibling: still rendered, just muted
 *   "keep" — what tells this folder apart: rendered bright
 *
 * NOTHING IS EVER DELETED. That is a deliberate reversal of where this started.
 * The first cut dropped high-df tokens outright, on the theory that a token on
 * 85% of folders carries no information — but "peq" (the resized copy) and
 * "selected" (the culled set) are exactly the tokens the photographer puts
 * everywhere ON PURPOSE. Statistical rarity turns out to be a bad proxy for importance: the
 * tokens that appear everywhere are the ones that were deliberately put
 * everywhere. So rarity decides EMPHASIS, never existence — the layering does the
 * work, and width is handled by the ellipsis and the hover reveal, which the user
 * can undo with their eyes.
 */
export function classifyToken({
  token,
  df,
  count,
  constantAcrossSiblings,
  siblingCount,
}) {
  // Every sibling repeats it, so it separates nothing here — and in the tree the
  // parent row above already says it. (A group of one has no redundancy to
  // exploit: everything is trivially "constant", so the rule must not fire.)
  if (constantAcrossSiblings && siblingCount > 1) return "dim";
  if (looksLikeDate(token)) return "dim";
  if (df >= DIM_DF && count >= DIM_MIN_COUNT) return "dim";
  return "keep";
}

/** Dates are context, not identity: you look for "Harbour", not for "26".
 *
 * Frequency cannot discover this. The month tokens are spread thin across the
 * years ("05May" is on 8% of folders, "12Dic" 6%), so each one lands under the
 * common-token line and would render bright, competing with the event name. But
 * a date is structurally a date. This tests SHAPE, not a word list, so it travels
 * to any library and any language: a bare number ("26", "2015") or a number glued
 * to a month-ish word ("03Marzo", "01Ene", "08Aug"). "100CANON" (three digits,
 * then a word) and "day2" are not date-shaped and stay bright.
 */
function looksLikeDate(token) {
  return /^\d+$/.test(token) || /^\d{1,2}[a-záéíóúñ]{2,}$/i.test(token);
}

/**
 * Renders one folder name into display parts.
 *
 * @param {string} name      the row's label (may be a compacted chain, "a/b/c")
 * @param {object} opts
 * @param {object} opts.stats     from buildTokenStats()
 * @param {string[]} opts.siblings  the labels of every row in this sibling group
 *                                  (including `name` itself)
 * @returns {Array<{text: string, kind: "keep"|"dim"}>}
 */
export function labelParts(name, { stats = EMPTY_STATS, siblings = [] } = {}) {
  const tokens = tokenize(name);
  if (!tokens.length) return [];

  const constant = constantTokens(siblings);
  const siblingCount = siblings.length;
  // Where the folder's OWN name starts. Everything before it is the path — the
  // route to the folder, not the folder — and it is never allowed to outshine the
  // name, however rare its words happen to be. (Rarity alone put "Backup" and
  // "temp" in lights while the folder's actual name sat grey beneath them.)
  const nameStart = tokens.map((t) => t.sep).lastIndexOf("/") + 1;

  const classified = tokens.map((t, i) => {
    const { count, df } = commonness(t.text, stats);
    const isConstant = constant.has(t.text.toLowerCase());
    return {
      ...t,
      df,
      isConstant,
      inName: i >= nameStart,
      kind:
        i < nameStart
          ? "dim"
          : classifyToken({
              token: t.text,
              df,
              count,
              constantAcrossSiblings: isConstant,
              siblingCount,
            }),
    };
  });

  return assembleLabel(classified);
}

/** Tokens shared, identically, by every sibling in the group — zero entropy. */
function constantTokens(siblings) {
  if (siblings.length < 2) return new Set();
  let shared = null;
  for (const sibling of siblings) {
    const tokens = new Set(tokenize(sibling).map((t) => t.text.toLowerCase()));
    if (shared === null) shared = tokens;
    else shared = new Set([...shared].filter((t) => tokens.has(t)));
  }
  return shared ?? new Set();
}

/** Renders the tokens, guaranteeing the folder's own name still says something.
 *
 * A name whose every token is common comes out entirely grey. Two real cases:
 * the library's own root row ("Users/me/Pictures/library" — every token is on
 * every folder by definition), and a camera dump ("2025_11Nov_08 Canon 1", where
 * the date is date-shaped, "Canon" is on hundreds of folders, and the "1" is a
 * bare number). The row would be unreadable, and worse, its SIBLING would render
 * identically — "Canon 1" and "Canon 10" differ by one character and that
 * character is the only thing either rule would throw away.
 *
 * So: if nothing in the name survived, bring back whatever DIFFERS from the
 * siblings — that is the discriminator, by definition, whatever shape it has. If
 * even that is empty (a lone row, nothing to differ from), bring the whole name
 * back. Never touch the path: it is context, and it already lost. */
function assembleLabel(classified) {
  const name = classified.filter((t) => t.inName);
  if (name.length && name.every((t) => t.kind === "dim")) {
    const discriminators = name.filter((t) => !t.isConstant);
    for (const token of discriminators.length ? discriminators : name) {
      token.kind = "keep";
    }
  }
  const parts = [];
  for (const token of classified) {
    parts.push({ text: token.text, kind: token.kind });
    // The separator belongs to the quieter of the two tokens it joins, so a
    // bright name isn't fenced in by bright underscores.
    if (token.sep) parts.push({ text: token.sep, kind: "dim" });
  }
  return parts;
}

/** The plain-text form of what labelParts() renders — for titles and tests. */
export function labelText(parts) {
  return parts.map((p) => p.text).join("");
}
