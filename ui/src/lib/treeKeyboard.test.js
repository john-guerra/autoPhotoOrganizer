import { describe, it, expect } from "vitest";
import { moveCursor, typeAheadTarget } from "./treeKeyboard.js";

describe("moveCursor", () => {
  it("moves up/down and clamps at the ends", () => {
    expect(moveCursor(5, 2, "down")).toBe(3);
    expect(moveCursor(5, 2, "up")).toBe(1);
    expect(moveCursor(5, 4, "down")).toBe(4); // clamp at bottom
    expect(moveCursor(5, 0, "up")).toBe(0); // clamp at top
  });

  it("home/end jump to the ends", () => {
    expect(moveCursor(5, 3, "home")).toBe(0);
    expect(moveCursor(5, 1, "end")).toBe(4);
  });

  it("page moves by pageSize, clamped", () => {
    expect(moveCursor(50, 20, "pagedown", 10)).toBe(30);
    expect(moveCursor(50, 5, "pageup", 10)).toBe(0);
    expect(moveCursor(50, 45, "pagedown", 10)).toBe(49);
  });

  it("an unset cursor (-1) starts from the top", () => {
    expect(moveCursor(5, -1, "down")).toBe(1);
    expect(moveCursor(5, -1, "up")).toBe(0);
  });

  it("empty list yields -1", () => {
    expect(moveCursor(0, -1, "down")).toBe(-1);
  });
});

describe("typeAheadTarget", () => {
  const labels = ["Alpha", "beta", "Bravo", "Cam 1", "Cam 10"];

  it("finds the next match after the cursor, case-insensitive", () => {
    expect(typeAheadTarget(labels, 0, "b")).toBe(1); // "beta"
    expect(typeAheadTarget(labels, 0, "BR")).toBe(2); // "Bravo"
  });

  it("cycles through matches on repeated keystrokes", () => {
    expect(typeAheadTarget(labels, 1, "b")).toBe(2); // beta -> Bravo
    expect(typeAheadTarget(labels, 2, "b")).toBe(1); // Bravo -> wraps to beta
  });

  it("matches a multi-char prefix", () => {
    expect(typeAheadTarget(labels, 0, "Cam")).toBe(3);
    expect(typeAheadTarget(labels, 3, "Cam")).toBe(4); // step to the next Cam
  });

  it("returns -1 for no match or empty buffer", () => {
    expect(typeAheadTarget(labels, 0, "zzz")).toBe(-1);
    expect(typeAheadTarget(labels, 0, "")).toBe(-1);
  });

  it("matches a substring, not just a prefix (date-stamped folder names)", () => {
    const dated = ["2024_01Jan Trip", "2024_02Feb Party", "2024_03Mar Cards"];
    expect(typeAheadTarget(dated, 0, "party")).toBe(1);
    expect(typeAheadTarget(dated, 0, "cards")).toBe(2);
    expect(typeAheadTarget(dated, 1, "trip")).toBe(0); // wraps
  });
});
