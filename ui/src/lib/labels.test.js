import { describe, it, expect } from "vitest";
import { shortLeafLabel } from "./labels.js";

describe("shortLeafLabel", () => {
  describe("folder", () => {
    it("returns the basename of a path", () => {
      expect(shortLeafLabel("folder", "/photos/2024/trip")).toBe("trip");
    });

    it("handles a trailing slash", () => {
      expect(shortLeafLabel("folder", "/photos/2024/trip/")).toBe("trip");
    });

    it("disambiguates with parent/basename when the previous basename collides", () => {
      expect(
        shortLeafLabel("folder", "/photos/2024/trip", "/photos/2023/trip")
      ).toBe("2024/trip");
    });

    it("does not add a parent when there is no basename collision", () => {
      expect(
        shortLeafLabel("folder", "/photos/2024/trip", "/photos/2024/beach")
      ).toBe("trip");
    });
  });

  describe("year", () => {
    it("passes the value through unchanged", () => {
      expect(shortLeafLabel("year", "2024")).toBe("2024");
    });
  });

  describe("month", () => {
    it("omits the year when the previous value has the same year", () => {
      expect(shortLeafLabel("month", "2024-06", "2024-01")).toBe("Jun");
    });

    it("includes the year when the previous value has a different year", () => {
      expect(shortLeafLabel("month", "2024-06", "2023-12")).toBe("2024 Jun");
    });

    it("includes the year when there is no previous value", () => {
      expect(shortLeafLabel("month", "2024-06")).toBe("2024 Jun");
    });
  });

  describe("day", () => {
    it("returns only the day number when the previous value is the same month", () => {
      expect(shortLeafLabel("day", "2024-06-14", "2024-06-01")).toBe("14");
    });

    it("includes the month when the previous value is a different month, same year", () => {
      expect(shortLeafLabel("day", "2024-06-14", "2024-05-30")).toBe("Jun 14");
    });

    it("includes the year and month when the previous value is a different year", () => {
      expect(shortLeafLabel("day", "2024-06-14", "2023-06-30")).toBe(
        "2024 Jun 14"
      );
    });

    it("has no leading zero on single-digit days", () => {
      expect(shortLeafLabel("day", "2024-06-04", "2024-06-01")).toBe("4");
    });

    it("returns only the day number when there is no previous value", () => {
      expect(shortLeafLabel("day", "2024-06-14")).toBe("14");
    });
  });

  describe("Unknown sentinel", () => {
    it("maps the empty string to 'Unknown' for every dimension", () => {
      expect(shortLeafLabel("folder", "")).toBe("Unknown");
      expect(shortLeafLabel("year", "")).toBe("Unknown");
      expect(shortLeafLabel("month", "")).toBe("Unknown");
      expect(shortLeafLabel("day", "")).toBe("Unknown");
    });
  });
});
