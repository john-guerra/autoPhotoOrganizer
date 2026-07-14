import { describe, it, expect } from "vitest";
import { isTypingTarget } from "./focus.js";

/** A DOM-ish stand-in: vitest runs in node, and this predicate only ever reads
 *  `tagName` and `isContentEditable`. */
const el = (tagName, isContentEditable = false) => ({
  tagName,
  isContentEditable,
});

describe("isTypingTarget", () => {
  it("claims the keyboard for text fields", () => {
    expect(isTypingTarget(el("INPUT"))).toBe(true);
    expect(isTypingTarget(el("TEXTAREA"))).toBe(true);
    expect(isTypingTarget(el("SELECT"))).toBe(true);
    expect(isTypingTarget(el("DIV", true))).toBe(true);
  });

  it("leaves it to the app everywhere else", () => {
    // The grid tile is the normal case: `3` must still rate the photo.
    expect(isTypingTarget(el("DIV"))).toBe(false);
    expect(isTypingTarget(el("BUTTON"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
  });
});
