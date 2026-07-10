import { describe, it, expect } from "vitest";
import { revealCommand } from "./revealCommand.js";

describe("revealCommand", () => {
  const p = "/Volumes/Trip/DCIM/IMG_0001.JPG";

  it("reveals-and-selects the file in Finder on macOS", () => {
    expect(revealCommand("darwin", p)).toEqual({ cmd: "open", args: ["-R", p] });
  });

  it("uses explorer /select, to highlight the file on Windows", () => {
    expect(revealCommand("win32", p)).toEqual({
      cmd: "explorer",
      args: ["/select,", p],
    });
  });

  it("opens the containing folder on Linux (no portable file-select)", () => {
    expect(revealCommand("linux", p)).toEqual({
      cmd: "xdg-open",
      args: ["/Volumes/Trip/DCIM"],
    });
  });

  it("returns null for an unsupported platform", () => {
    expect(revealCommand("sunos", p)).toBeNull();
    expect(revealCommand("aix", p)).toBeNull();
  });
});
