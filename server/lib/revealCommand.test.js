import { describe, it, expect } from "vitest";
import { revealCommand, revealManyCommand } from "./revealCommand.js";

describe("revealCommand", () => {
  const p = "/Volumes/Trip/DCIM/IMG_0001.JPG";

  it("reveals-and-selects the file in Finder on macOS", () => {
    expect(revealCommand("darwin", p)).toEqual({
      cmd: "open",
      args: ["-R", p],
    });
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

describe("revealManyCommand", () => {
  const a = "/Volumes/Trip/DCIM/IMG_0001.JPG";
  const b = "/Volumes/Trip/DCIM/IMG_0002.JPG";

  it("selects all files in Finder via AppleScript on macOS", () => {
    const cmd = revealManyCommand("darwin", [a, b]);
    expect(cmd.cmd).toBe("osascript");
    expect(cmd.args[0]).toBe("-e");
    expect(cmd.args[1]).toContain(`POSIX file "${a}"`);
    expect(cmd.args[1]).toContain(`POSIX file "${b}"`);
    expect(cmd.args[1]).toContain("reveal {");
    expect(cmd.args[1]).toContain('tell application "Finder"');
  });

  it("escapes quotes and backslashes in AppleScript paths", () => {
    const tricky = '/Volumes/Trip/we"ird\\path.JPG';
    const cmd = revealManyCommand("darwin", [tricky, b]);
    expect(cmd.args[1]).toContain(
      'POSIX file "/Volumes/Trip/we\\"ird\\\\path.JPG"'
    );
  });

  it("highlights only the first file on Windows (explorer is single-select)", () => {
    expect(revealManyCommand("win32", [a, b])).toEqual({
      cmd: "explorer",
      args: ["/select,", a],
    });
  });

  it("opens the containing folder of the first file on Linux", () => {
    expect(revealManyCommand("linux", [a, b])).toEqual({
      cmd: "xdg-open",
      args: ["/Volumes/Trip/DCIM"],
    });
  });

  it("delegates a single path to the single-file reveal on every platform", () => {
    expect(revealManyCommand("darwin", [a])).toEqual(
      revealCommand("darwin", a)
    );
    expect(revealManyCommand("win32", [a])).toEqual(revealCommand("win32", a));
  });

  it("returns null for empty input or an unsupported platform", () => {
    expect(revealManyCommand("darwin", [])).toBeNull();
    expect(revealManyCommand("sunos", [a, b])).toBeNull();
  });
});
