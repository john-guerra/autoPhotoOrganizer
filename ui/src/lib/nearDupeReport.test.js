import { describe, it, expect } from "vitest";
import { nearDupeReportMessage } from "./nearDupeReport.js";

describe("nearDupeReportMessage (#211)", () => {
  describe("with no selection", () => {
    it("reports the library, and does not say the same number twice", () => {
      const msg = nearDupeReportMessage({
        library: { groups: 43, photos: 118 },
      });
      expect(msg).toBe(
        "Found 43 groups of near-identical photos (118 photos stacked)"
      );
      expect(msg).not.toContain("selected");
      expect(msg).not.toContain("library-wide");
    });

    it("says nothing was stacked rather than reporting a bare zero", () => {
      expect(nearDupeReportMessage({ library: { groups: 0, photos: 0 } })).toBe(
        "No near-identical photos found — nothing was stacked"
      );
    });
  });

  describe("with a selection", () => {
    it("answers about the selection, and still gives the library total", () => {
      expect(
        nearDupeReportMessage({
          scoped: { groups: 12, photos: 27, spillGroups: 0 },
          library: { groups: 43, photos: 118 },
          selectionCount: 200,
        })
      ).toBe(
        "Found 12 groups of near-identical photos among your 200 selected " +
          "photos (43 groups library-wide)"
      );
    });

    it("admits when a counted group reaches outside the selection", () => {
      // The honest case: claiming "12 groups in your selection" while 3 of
      // them include photos the user never selected overstates the answer.
      const msg = nearDupeReportMessage({
        scoped: { groups: 12, photos: 27, spillGroups: 3 },
        library: { groups: 43, photos: 118 },
        selectionCount: 200,
      });
      expect(msg).toContain("3 of them reaching photos outside it");
    });

    it("distinguishes 'none here' from 'none at all'", () => {
      // A selection with no duplicates reads as a broken button unless the
      // message can say the sweep ran and found things elsewhere.
      expect(
        nearDupeReportMessage({
          scoped: { groups: 0, photos: 0, spillGroups: 0 },
          library: { groups: 43, photos: 118 },
          selectionCount: 200,
        })
      ).toBe(
        "No near-identical photos among your 200 selected photos — " +
          "43 groups elsewhere in the library"
      );

      expect(
        nearDupeReportMessage({
          scoped: { groups: 0, photos: 0, spillGroups: 0 },
          library: { groups: 0, photos: 0 },
          selectionCount: 200,
        })
      ).toBe(
        "No near-identical photos among your 200 selected photos, or " +
          "anywhere else in the library"
      );
    });

    it("pluralises the noun, not the adjective", () => {
      const msg = nearDupeReportMessage({
        scoped: { groups: 1, photos: 2, spillGroups: 0 },
        library: { groups: 1, photos: 2 },
        selectionCount: 1,
      });
      expect(msg).toContain("1 group of near-identical photos");
      expect(msg).toContain("your 1 selected photo ");
      expect(msg).not.toContain("selecteds");
      expect(msg).not.toContain("1 groups");
    });

    it("falls back to the library sentence when the scoped read failed", () => {
      // fetchNearDupeCounts rejects -> scoped is null. A successful sweep must
      // not be reported as though it found nothing.
      expect(
        nearDupeReportMessage({
          scoped: null,
          library: { groups: 43, photos: 118 },
          selectionCount: 200,
        })
      ).toBe("Found 43 groups of near-identical photos (118 photos stacked)");
    });
  });
});
