import { describe, it, expect } from "vitest";
import { faceClusterSummary } from "./faceClusterSummary.js";

/**
 * The bug this covers is a WRONG FIELD NAME, which is the kind a type system
 * would catch and this repo does not have one (CLAUDE.md: no TypeScript for
 * now). It shipped in two components at once, both reading `r.people` off a
 * result that has never had a `people` key, and `?? 0` rendering the miss as a
 * confident zero rather than as anything wrong.
 *
 * So the test that would have caught it is not "does it say something" — the
 * old code said something — it is "does the number MATCH the result it was
 * given". Every assertion below pins a specific field to a specific position
 * in the sentence.
 */

describe("faceClusterSummary — the incremental pass (#293)", () => {
  /** John's run: 327 faces filed, and it made people out of them. */
  const remaining = {
    mode: "remaining",
    assigned: 327,
    created: 41,
    examined: 327,
    remaining: 0,
    removedEmpty: 0,
  };

  it("reports the people it CREATED, not a field that does not exist", () => {
    const s = faceClusterSummary(remaining);
    expect(s).toContain("41 new people");
    // The exact symptom: "0 people" for a run that made 41.
    expect(s).not.toMatch(/\b0 (new )?people/);
  });

  it("reports the faces it filed", () => {
    expect(faceClusterSummary(remaining)).toContain("filed 327 faces");
  });

  it("stays silent about work left when there is none", () => {
    // "0 still to do" on every successful run is noise, and noise is how a
    // summary stops being read.
    expect(faceClusterSummary(remaining)).not.toContain("still to do");
    expect(faceClusterSummary(remaining)).not.toContain("tidied");
  });

  it("says what is left after a stop or a scoped run", () => {
    const s = faceClusterSummary({
      ...remaining,
      assigned: 100,
      remaining: 227,
    });
    expect(s).toContain("227 still to do");
  });

  it("mentions the empty people it swept, when it swept any", () => {
    const s = faceClusterSummary({ ...remaining, removedEmpty: 974 });
    expect(s).toContain("974 empty people");
  });

  it("pluralizes one of each correctly", () => {
    const s = faceClusterSummary({
      mode: "remaining",
      assigned: 1,
      created: 1,
      remaining: 0,
      removedEmpty: 1,
    });
    expect(s).toContain("filed 1 face");
    expect(s).not.toContain("1 faces");
    expect(s).toContain("1 new person");
    expect(s).toContain("1 empty person");
  });
});

describe("faceClusterSummary — regroup keeps its own wording", () => {
  it("answers how many people you have NOW", () => {
    // A different question from the incremental pass's "how many did this
    // add", and rendering one with the other's wording would be wrong even
    // with the right field.
    const s = faceClusterSummary({
      mode: "regroup",
      people: 88,
      faces: 1431,
      keptManual: 12,
    });
    expect(s).toContain("88 people");
    expect(s).toContain("from 1,431 faces");
    expect(s).toContain("12 kept as you set them");
  });

  it("omits the manual count when nothing was kept by hand", () => {
    const s = faceClusterSummary({ mode: "regroup", people: 3, faces: 9 });
    expect(s).not.toContain("kept as you set them");
  });

  it("never returns an empty string — a bare tick is an unfinished feature", () => {
    // UI-CONTRACTS §2: "summarized on completion". Even a result the client
    // does not recognize gets a sentence rather than nothing.
    expect(faceClusterSummary(undefined)).not.toBe("");
    expect(faceClusterSummary({})).not.toBe("");
  });
});
