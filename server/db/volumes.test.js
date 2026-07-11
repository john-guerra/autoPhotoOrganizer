import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import {
  volumeRootForPath,
  getVolumeInfo,
  upsertVolume,
  isVolumeMounted,
} from "./volumes.js";

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-db-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

describe("volumeRootForPath", () => {
  it("returns the /Volumes/<Name> prefix for an external drive path", () => {
    expect(volumeRootForPath("/Volumes/EOS_DIG_256/DCIM/101CANON")).toBe(
      "/Volumes/EOS_DIG_256"
    );
  });

  it("returns / for a path on the internal disk", () => {
    expect(volumeRootForPath("/Users/john/Pictures/trip")).toBe("/");
  });
});

describe("getVolumeInfo", () => {
  it("parses Volume UUID and Volume Name from diskutil output", () => {
    const fakeExec = () =>
      "   Volume Name:               EOS_DIG_256\n" +
      "   Volume UUID:               34B1102D-EC2C-431A-B14A-AE1381C18125\n";
    const info = getVolumeInfo("/Volumes/EOS_DIG_256", fakeExec);
    expect(info).toEqual({
      uuid: "34B1102D-EC2C-431A-B14A-AE1381C18125",
      label: "EOS_DIG_256",
    });
  });

  it("falls back to a null uuid and basename label when exec throws", () => {
    const throwingExec = () => {
      throw new Error("diskutil not found");
    };
    const info = getVolumeInfo("/Volumes/Whatever", throwingExec);
    expect(info).toEqual({ uuid: null, label: "Whatever" });
  });

  it("rejects placeholder UUID text (FAT32/exFAT SD cards) as null", () => {
    const fakeExec = () =>
      "   Volume Name:               MyCard\n" +
      "   Volume UUID:               Not applicable (no root user UUID)\n";
    const info = getVolumeInfo("/Volumes/MyCard", fakeExec);
    expect(info).toEqual({ uuid: null, label: "MyCard" });
  });
});

describe("upsertVolume", () => {
  it("creates a volume row keyed by uuid and returns its id", () => {
    const db = getDb();
    const fakeExec = () =>
      "   Volume Name:  Foo\n   Volume UUID:  12345678-1234-1234-1234-123456789012\n";
    const id1 = upsertVolume(db, "/Volumes/Foo", fakeExec);
    const id2 = upsertVolume(db, "/Volumes/Foo", fakeExec);
    expect(id1).toBe(id2);
    const row = db.prepare("SELECT * FROM volumes WHERE id = ?").get(id1);
    expect(row).toMatchObject({
      uuid: "12345678-1234-1234-1234-123456789012",
      label: "Foo",
    });
  });

  it("re-links to the same volume row even if the mount path changes", () => {
    const db = getDb();
    const fakeExec = () =>
      "   Volume Name:  Foo\n   Volume UUID:  12345678-1234-1234-1234-123456789012\n";
    const id1 = upsertVolume(db, "/Volumes/Foo", fakeExec);
    const id2 = upsertVolume(db, "/Volumes/Foo 1", fakeExec); // remounted with a suffix
    expect(id1).toBe(id2);
  });

  it("falls back to mount-path keying when no uuid is available", () => {
    const db = getDb();
    const throwingExec = () => {
      throw new Error("no diskutil");
    };
    const id1 = upsertVolume(db, "/Volumes/NoUuid", throwingExec);
    const id2 = upsertVolume(db, "/Volumes/NoUuid", throwingExec);
    expect(id1).toBe(id2);
  });
});

describe("isVolumeMounted", () => {
  it("returns true when the current mount path reports the same uuid", () => {
    const fakeExec = () =>
      "   Volume UUID:  12345678-1234-1234-1234-123456789012\n";
    expect(
      isVolumeMounted(
        {
          uuid: "12345678-1234-1234-1234-123456789012",
          last_mount_path: "/Volumes/Foo",
        },
        fakeExec
      )
    ).toBe(true);
  });

  it("returns false when a different drive is now at the same mount path", () => {
    const fakeExec = () =>
      "   Volume UUID:  87654321-4321-4321-4321-210987654321\n";
    expect(
      isVolumeMounted(
        {
          uuid: "12345678-1234-1234-1234-123456789012",
          last_mount_path: "/Volumes/Foo",
        },
        fakeExec
      )
    ).toBe(false);
  });

  it("returns false when diskutil throws (drive unmounted)", () => {
    const throwingExec = () => {
      throw new Error("not mounted");
    };
    expect(
      isVolumeMounted(
        {
          uuid: "12345678-1234-1234-1234-123456789012",
          last_mount_path: "/Volumes/Foo",
        },
        throwingExec
      )
    ).toBe(false);
  });
});
