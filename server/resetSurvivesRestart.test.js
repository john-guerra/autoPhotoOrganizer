import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./db/connection.js";
import { createApp } from "./index.js";
import { upsertScan, resetLibrary } from "./db/photos.js";

/**
 * A reset library must still be empty after the app restarts (#295).
 *
 * John reset his library on 2.19.29, watched it complete, quit the app, and
 * reopened it to find five folders back — including
 * `/Users/aguerra/Pictures/fotos/Wonders Years` and two on an external
 * volume. Nothing had re-scanned them; they were replayed out of
 * `~/.autogallery/library.json`, the pre-SQLite store, by
 * `migrateLegacyJsonIfNeeded`.
 *
 * That importer's only guard was `SELECT COUNT(*) FROM photos == 0`, and its
 * comment called that "safe to call unconditionally on every startup". It was,
 * for as long as the only way to reach an empty `photos` table was a fresh
 * install. **A deliberate reset produces byte-for-byte the same state**, so a
 * row count cannot tell the two apart — which is why the fix is to delete the
 * import rather than to add a second guard that the next state change can
 * fool in the same way.
 *
 * #293 is what made this reachable: before it, reset threw on any library
 * with a manual burst stack and never emptied `photos` at all.
 *
 * The test drives `createApp()` because startup is where the bug lived — the
 * reset itself was always correct.
 */

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-reset-restart-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

/** Reopen the app against the same cache root, as quitting and relaunching does. */
function restart() {
  _resetDbForTest();
  createApp();
  const db = getDb();
  // `folders.volume_id` has a real foreign key, so a scan needs a volume to
  // hang off. Re-created after every restart because `resetLibrary` clears
  // `volumes` too — which is itself the correct behaviour.
  db.prepare(
    `INSERT OR IGNORE INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
     VALUES (1, 'v', 'uuid-1', '/test', ?)`
  ).run(Date.now());
  return db;
}

/** The legacy stores, exactly as John's ~/.autogallery still holds them. */
async function writeLegacyStores() {
  await writeFile(
    join(cacheDir, "library.json"),
    JSON.stringify({
      "/Users/aguerra/Pictures/fotos/Wonders Years": {
        name: "Wonders Years",
        lastScannedAt: 1783381794042,
      },
      "/Volumes/EOS_DIG_256/DCIM": {
        name: "DCIM",
        lastScannedAt: 1783389384084,
      },
    })
  );
  await writeFile(
    join(cacheDir, "ratings.json"),
    JSON.stringify({ "/Users/aguerra/Pictures/fotos/Wonders Years/a.jpg": 4 })
  );
}

describe("a reset library stays reset across a restart (#295)", () => {
  it("does not resurrect folders from the legacy library.json", async () => {
    await writeLegacyStores();
    const db = restart();
    upsertScan(db, "/photos/mine", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);

    await resetLibrary(db);
    expect(db.prepare(`SELECT COUNT(*) c FROM folders`).get().c).toBe(0);

    // Quit, reopen. THIS is where the five folders came back.
    const after = restart();

    expect(after.prepare(`SELECT COUNT(*) c FROM folders`).get().c).toBe(0);
    expect(after.prepare(`SELECT COUNT(*) c FROM photos`).get().c).toBe(0);
  });

  it("does not resurrect ratings either — a reset was PARTIALLY undone", async () => {
    // Worth its own assertion: the folder list was the visible half, but
    // `ratings.json` and `coverChoices.json` came back as photo stubs too, so
    // the library that reappeared was not even a faithful copy of anything
    // the user had recently.
    await writeLegacyStores();
    const db = restart();
    upsertScan(db, "/photos/mine", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    await resetLibrary(db);

    const after = restart();

    expect(
      after.prepare(`SELECT COUNT(*) c FROM photos WHERE rating > 0`).get().c
    ).toBe(0);
  });

  it("a FRESH install with legacy files present also imports nothing", async () => {
    // The other half of the decision: the import is gone, not merely gated.
    // A row count could never distinguish "never imported" from "just wiped",
    // so nothing here should depend on which of the two this is.
    await writeLegacyStores();

    const db = restart();

    expect(db.prepare(`SELECT COUNT(*) c FROM folders`).get().c).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) c FROM photos`).get().c).toBe(0);
  });

  it("leaves the legacy files on disk, so nothing is destroyed", async () => {
    // Removing the importer must not remove the data it used to read. The
    // files stay exactly where they are; only the code that replayed them is
    // gone, which is what makes this reversible if it was ever wrong.
    await writeLegacyStores();
    restart();

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(cacheDir, "library.json"))).toBe(true);
    expect(existsSync(join(cacheDir, "ratings.json"))).toBe(true);
  });
});
