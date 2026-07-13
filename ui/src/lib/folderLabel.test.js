import { describe, it, expect } from "vitest";
import {
  tokenize,
  buildTokenStats,
  buildSiblingIndex,
  labelParts,
  labelText,
  EMPTY_STATS,
} from "./folderLabel.js";

/** A stand-in for the real library: the _peq suffix on almost everything, the
 * year restated on every child, and the Selected/starred pair that differs by a
 * single token. Nothing here may ever be DELETED from a label — the rule decides
 * emphasis only. */
const LIBRARY = [
  "/lib/2005/2005_03Mar_26_Harbour_Walk_peq",
  "/lib/2005/2005_03Mar_19_Birthday_Late_peq",
  "/lib/2005/2005_04Apr_19_Interview_Radio_peq",
  "/lib/2013/2013_01Jan_02_Museum_Visit_Selected_peq",
  "/lib/2013/2013_01Jan_02_Museum_Visit_Selected_starred_peq",
  "/lib/2013/2013_01Jan_19_Campus_selected_peq",
  "/lib/2013/2013_02Feb_22_River_Trail_seleccion",
];
const stats = buildTokenStats(LIBRARY);

const siblings2005 = [
  "2005_03Mar_26_Harbour_Walk_peq",
  "2005_03Mar_19_Birthday_Late_peq",
  "2005_04Apr_19_Interview_Radio_peq",
];
const siblings2013 = [
  "2013_01Jan_02_Museum_Visit_Selected_peq",
  "2013_01Jan_02_Museum_Visit_Selected_starred_peq",
  "2013_01Jan_19_Campus_selected_peq",
  "2013_02Feb_22_River_Trail_seleccion",
];

/** kind of each token, keyed by its text — separators ignored. */
const kinds = (name, siblings) =>
  Object.fromEntries(
    labelParts(name, { stats, siblings })
      .filter((p) => /[a-z0-9]/i.test(p.text))
      .map((p) => [p.text, p.kind])
  );

describe("tokenize", () => {
  it("splits on the separators people actually use, keeping them for rebuild", () => {
    expect(tokenize("2005_03Mar-26 Harbour/raw").map((t) => t.text)).toEqual([
      "2005",
      "03Mar",
      "26",
      "Harbour",
      "raw",
    ]);
    expect(tokenize("a_b").map((t) => t.sep)).toEqual(["_", ""]);
  });
});

describe("buildTokenStats", () => {
  it("counts tokens from the WHOLE path, so the shared prefix scores 1.0", () => {
    expect(stats.docCount).toBe(7);
    expect(stats.df.get("lib")).toBe(7); // on every folder → it will recede on its own
    expect(stats.df.get("peq")).toBe(6);
    expect(stats.df.get("starred")).toBe(1);
  });

  it("is case-insensitive, so Selected and selected are one token", () => {
    expect(stats.df.get("selected")).toBe(3);
  });
});

describe("labelParts", () => {
  it("never deletes anything — the full name always survives", () => {
    // peq and selected are meaningful (the resized copy, the culled set). They
    // recede; they do not disappear.
    const name = "2005_03Mar_26_Harbour_Walk_peq";
    expect(labelText(labelParts(name, { stats, siblings: siblings2005 }))).toBe(
      name
    );
  });

  it("dims the year every sibling repeats, and the library-wide boilerplate", () => {
    const k = kinds("2005_03Mar_26_Harbour_Walk_peq", siblings2005);
    expect(k["2005"]).toBe("dim"); // the parent row already says it
    expect(k["peq"]).toBe("dim"); // on 6 of 7 folders
  });

  it("keeps the event name bright — it is what tells the folder apart", () => {
    const k = kinds("2005_03Mar_26_Harbour_Walk_peq", siblings2005);
    expect(k["Harbour"]).toBe("keep");
    expect(k["Walk"]).toBe("keep");
  });

  it("keeps two near-identical siblings distinguishable (the starred pair)", () => {
    const a = kinds("2013_01Jan_02_Museum_Visit_Selected_peq", siblings2013);
    const b = kinds(
      "2013_01Jan_02_Museum_Visit_Selected_starred_peq",
      siblings2013
    );
    expect(a["starred"]).toBeUndefined();
    expect(b["starred"]).toBe("keep"); // rare → bright: it IS the difference
  });

  it("quiets the shared word on an SD card without a hardcoded rule", () => {
    const card = buildTokenStats(["/DCIM/100CANON", "/DCIM/101CANON"]);
    const k = Object.fromEntries(
      labelParts("100CANON", {
        stats: card,
        siblings: ["100CANON", "101CANON"],
      }).map((p) => [p.text, p.kind])
    );
    // One token, nothing to strip, and it's all this row has — so it stays bright.
    expect(k["100CANON"]).toBe("keep");
  });

  it("never renders a row entirely grey — the tail is promoted back", () => {
    // Every token is on every folder, so every token is 'common'. The row would
    // be unreadable; the last (deepest, most specific) one comes back bright.
    const only = buildTokenStats([
      "/Users/j/Pictures/fotos",
      "/Users/j/Pictures/fotos/a",
      "/Users/j/Pictures/fotos/b",
      "/Users/j/Pictures/fotos/c",
    ]);
    const k = Object.fromEntries(
      labelParts("Users/j/Pictures/fotos", {
        stats: only,
        siblings: ["Users/j/Pictures/fotos"],
      }).map((p) => [p.text, p.kind])
    );
    expect(k["fotos"]).toBe("keep");
    expect(k["Users"]).toBe("dim");
  });

  it("leaves a lone folder alone — a group of one has no redundancy to exploit", () => {
    // "constant across siblings" is trivially true when there is one sibling; the
    // rule must not fire on it, or a lone row would grey out its own name.
    const solo = buildTokenStats(["/lib/Kite_Contest"]);
    const k = Object.fromEntries(
      labelParts("Kite_Contest", {
        stats: solo,
        siblings: ["Kite_Contest"],
      }).map((p) => [p.text, p.kind])
    );
    expect(k["Kite"]).toBe("keep");
  });

  it("without a corpus, nothing is judged common — but a date is still a date", () => {
    const parts = labelParts("2005_Harbour_peq", { stats: EMPTY_STATS });
    const k = Object.fromEntries(parts.map((p) => [p.text, p.kind]));
    expect(labelText(parts)).toBe("2005_Harbour_peq");
    expect(k["Harbour"]).toBe("keep");
    expect(k["peq"]).toBe("keep"); // no corpus → no way to know it is boilerplate
    expect(k["2005"]).toBe("dim"); // date-shaped: structural, needs no corpus
  });

  it("dims dates by shape, which frequency alone cannot see", () => {
    // The month tokens are spread thin across the years (05May is on 8% of the
    // real library, 12Dic 6%), so each lands under the common-token line and would
    // render bright, competing with the event name. Shape catches them — and unlike
    // a word list, shape survives a change of language.
    const k = kinds("2013_11Nov_03_Canyon_day2_selected_peq", siblings2013);
    expect(k["11Nov"]).toBe("dim");
    expect(k["03"]).toBe("dim");
    expect(k["Canyon"]).toBe("keep");
    expect(k["day2"]).toBe("keep"); // not date-shaped — a word with a digit stuck on
  });
});

describe("buildSiblingIndex", () => {
  it("groups folder names by the parent they share on disk", () => {
    const index = buildSiblingIndex(LIBRARY);
    expect(index.get("/lib/2005")).toHaveLength(3);
    expect(index.get("/lib/2013")).toContain(
      "2013_01Jan_19_Campus_selected_peq"
    );
  });
});
