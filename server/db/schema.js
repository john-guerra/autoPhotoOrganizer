import { feedIndexes, FEED_INDEX_PREFIX } from "./sort.js";
import { PENDING_CONDITION } from "./enrich.js";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS volumes (
  id INTEGER PRIMARY KEY,
  label TEXT,
  uuid TEXT UNIQUE,
  last_mount_path TEXT,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY,
  abs_path TEXT NOT NULL UNIQUE,
  volume_id INTEGER REFERENCES volumes(id),
  last_scanned_at INTEGER
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  folder_id INTEGER NOT NULL REFERENCES folders(id),
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  btime INTEGER,
  content_hash TEXT,
  taken_at INTEGER,
  width INTEGER,
  height INTEGER,
  camera TEXT,
  kind TEXT NOT NULL,
  rating INTEGER NOT NULL DEFAULT 0,
  preferred_cover INTEGER NOT NULL DEFAULT 0,
  stale INTEGER NOT NULL DEFAULT 0,
  UNIQUE(folder_id, filename)
);
CREATE INDEX IF NOT EXISTS idx_photos_taken_at ON photos(taken_at);
CREATE INDEX IF NOT EXISTS idx_photos_content_hash ON photos(content_hash);

CREATE TABLE IF NOT EXISTS albums (
  id INTEGER PRIMARY KEY,
  name TEXT,
  start_at INTEGER,
  end_at INTEGER
);
CREATE TABLE IF NOT EXISTS photo_album (
  photo_id INTEGER REFERENCES photos(id),
  album_id INTEGER REFERENCES albums(id),
  PRIMARY KEY (photo_id, album_id)
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  dimension_name TEXT NOT NULL,
  value TEXT NOT NULL,
  UNIQUE(dimension_name, value)
);
CREATE TABLE IF NOT EXISTS photo_tags (
  photo_id INTEGER REFERENCES photos(id),
  tag_id INTEGER REFERENCES tags(id),
  source TEXT NOT NULL,
  PRIMARY KEY (photo_id, tag_id)
);
-- The single active "keep only" working set. Membership is referenced by the
-- filter's keepScope flag (photos.id IN (SELECT photo_id FROM keep_scope)) so an
-- arbitrarily large scope never has to travel in a URL query param.
CREATE TABLE IF NOT EXISTS keep_scope (
  photo_id INTEGER PRIMARY KEY
);
-- Manual burst-stack grouping (issue #24): photos sharing a group_id are forced
-- into one stack regardless of the time-gap heuristic. A photo can belong to at
-- most one manual stack (PK on photo_id). The complementary "keep separate"
-- override (dissolve) is the photos.no_auto_stack column. See
-- docs/superpowers/specs/2026-07-11-manual-burst-override-design.md.
CREATE TABLE IF NOT EXISTS manual_stacks (
  photo_id INTEGER PRIMARY KEY REFERENCES photos(id),
  group_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_manual_stacks_group ON manual_stacks(group_id);
`;

/** @param {import("better-sqlite3").Database} db */
export function applySchema(db) {
  db.exec(SCHEMA_SQL);
  // The folder feed's ORDER BY key: abs_path with "/" replaced by char(1), which
  // sorts below every character a path can contain. That turns byte order into a
  // pre-order walk of the folder tree, so a folder's children immediately follow
  // it and a subtree stays contiguous — the precondition for nesting folders in
  // the feed. Byte order does NOT do this: "/Selectas copy" sorts between
  // "/Selectas" and "/Selectas/…" (' ' 0x20 < '/' 0x2F). See db/feed.js.
  //
  // VIRTUAL, not STORED: SQLite only permits adding a VIRTUAL generated column
  // via ALTER TABLE, and this app ships no migration runner. Costs nothing — the
  // index below materializes the value, which is what the ORDER BY actually reads.
  ensureColumn(
    db,
    "folders",
    "sort_path",
    "TEXT GENERATED ALWAYS AS (replace(abs_path, '/', char(1))) VIRTUAL"
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_folders_sort_path ON folders(sort_path)`
  );
  ensureColumn(db, "photos", "btime", "INTEGER");
  // "Keep separate" (dissolve) marker — a per-photo boolean like preferred_cover,
  // so it rides upsertScan's ON CONFLICT and survives rescans of unchanged files.
  ensureColumn(db, "photos", "no_auto_stack", "INTEGER NOT NULL DEFAULT 0");
  // Missing-files review (#1). `dismissed` is a recoverable tombstone: a stale
  // row the user removed from the index, hidden everywhere but never deleted, so
  // its rating survives and is restored if the file reappears. `first_seen_at`
  // (set on INSERT, never updated) distinguishes a row that appeared THIS scan
  // (a candidate move target) from a pre-existing copy — the signal that keeps
  // auto-relocate from repointing onto an existing backup. See db/missing.js.
  ensureColumn(db, "photos", "dismissed", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "photos", "first_seen_at", "INTEGER");
  // Video length in seconds (fractional; NULL for images and un-probed videos).
  ensureColumn(db, "photos", "duration", "REAL");
  // Loupe details panel EXIF (issue #27). Nullable — populated lazily by
  // /api/meta on first detailed view; `lens` doubles as the "EXIF attempted"
  // sentinel (see NodeProcessingService.exifToMeta / api.js /api/meta trigger).
  ensureColumn(db, "photos", "aperture", "REAL");
  ensureColumn(db, "photos", "shutter", "REAL");
  ensureColumn(db, "photos", "iso", "INTEGER");
  ensureColumn(db, "photos", "focal_length", "REAL");
  ensureColumn(db, "photos", "lens", "TEXT");
  // Video stream format, so playback knows whether the BROWSER can decode this
  // file or whether it needs a transcoded proxy first (see lib/videoPlayback.js
  // — Chromium has no MPEG-4 Part 2 decoder, which is why a camcorder .avi
  // plays its audio and shows a black frame). NULL for images and for videos
  // indexed before this column existed; playback probes those on demand.
  ensureColumn(db, "photos", "video_codec", "TEXT");
  ensureColumn(db, "photos", "pix_fmt", "TEXT");
  // Places (#154). lat/lon are the raw EXIF coordinates; place_country and
  // place_city are the offline-reverse-geocoded, DENORMALIZED single values
  // that make place a legal feed group dimension (the keyset seek assumes one
  // value per photo per dimension — see server/db/feed.js:53-77).
  //
  // gps_checked is the "we have looked" marker, and it is load-bearing: the
  // sweep's to-do list keys on `width IS NULL`, so every photo enriched before
  // this feature existed already has a width and would NEVER come back to have
  // its GPS read. That is exactly what happened to video_codec (1,171 of 1,173
  // videos left unprobed — see db/enrich.js). Keying on `lat IS NULL` instead
  // is not an option: most photos genuinely have no GPS and would be retried on
  // every sweep, forever.
  ensureColumn(db, "photos", "lat", "REAL");
  ensureColumn(db, "photos", "lon", "REAL");
  ensureColumn(db, "photos", "place_country", "TEXT");
  // State/province/departamento/prefecture (GeoNames admin1, #173) — one
  // level between country and city. Added after country/city already
  // shipped, which is why place_version exists at all: adding this column
  // bumped PLACE_VERSION to 3 so every already-scanned GPS photo backfills
  // it, not just newly-scanned ones. See server/lib/place.js.
  ensureColumn(db, "photos", "place_region", "TEXT");
  ensureColumn(db, "photos", "place_city", "TEXT");
  // Neighbourhood (GeoNames PPLX, #176) — one level BELOW city, the finest
  // place level. Same story as place_region: added after city already
  // shipped, so it bumped PLACE_VERSION to 4 to backfill every already-scanned
  // GPS photo. Often "" (only ~4,800 PPLX exist worldwide, skewed to big US
  // cities), which is fine for a bottom level: it resolves only when the photo
  // is genuinely inside a known neighbourhood. See server/lib/place.js.
  ensureColumn(db, "photos", "place_neighborhood", "TEXT");
  ensureColumn(db, "photos", "gps_checked", "INTEGER NOT NULL DEFAULT 0");
  // Which geocoder generation produced place_country/place_city (#175). NOT the
  // same question as gps_checked: that one says "we read the file's GPS" and is
  // permanent, while this says "we derived these NAMES with algorithm version
  // N" and must expire when the algorithm improves. Without it, replacing the
  // geocoder left every already-scanned photo showing its old wrong answer for
  // good, because gps_checked = 1 keeps the sweep away. See db/places.js.
  ensureColumn(db, "photos", "place_version", "INTEGER NOT NULL DEFAULT 0");
  // db/places.js's backfill gate (`place_version < ?`) and its GPS-less stamp
  // (`place_version < ? AND lat IS NULL`) both run on every startup, and
  // without this the gate's own COUNT was a full table scan — verified via
  // EXPLAIN QUERY PLAN, the same trap idx_photos_pending_meta's comment above
  // describes. A plain (non-partial) index, unlike that one: PLACE_VERSION
  // only ever goes up, so once a library is caught up almost nothing matches
  // `place_version < ?` and the range scan is cheap regardless of `lat`.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_photos_place_version ON photos(place_version)`
  );
  // Content-hash sweep bookkeeping (#12/#86). `hash_attempted` mirrors the
  // metadata sweep's "mark attempted" trick: an unreadable file keeps
  // content_hash NULL but sets hash_attempted=1 so the background hasher
  // (db/hashing.js hashAllPending) can't re-select the same failing rows forever.
  // No dedicated pending-index is needed (unlike idx_photos_pending_meta): the
  // existing idx_photos_content_hash already turns the per-batch
  // "content_hash IS NULL" lookup into an index SEARCH, not a 100k full scan
  // (verified via EXPLAIN QUERY PLAN), and LIMIT caps it regardless.
  ensureColumn(db, "photos", "hash_attempted", "INTEGER NOT NULL DEFAULT 0");

  // --- One-shot data repairs -----------------------------------------------
  // Everything else in applySchema is idempotent BY CONSTRUCTION (CREATE TABLE
  // IF NOT EXISTS, ensureColumn) and re-runs harmlessly on every startup. A
  // data UPDATE is not, so it needs a gate — PRAGMA user_version, SQLite's
  // built-in one-shot counter. It is the app's counter, not SQLite's, and only
  // ever moves forward.
  //
  // This section sits HERE — before the ML artifacts tables below — and not
  // where a "repairs run last" instinct would put it, because the dataVersion
  // < 2 step drops and recreates photo_embeddings/ml_status, and that DROP
  // must execute before the `CREATE TABLE IF NOT EXISTS` further down. If it
  // ran after, `IF NOT EXISTS` would see tables that already exist (with the
  // wrong constraint) and skip creating them — the drop would have nothing
  // left to fix.
  const dataVersion = db.pragma("user_version", { simple: true });
  if (dataVersion < 1) {
    // #169: 2.17.14-2.18.4 marked every file unreachable during a hash sweep
    // hash_attempted=1, including a whole drive that was merely unmounted. Only
    // a size/mtime CHANGE clears that marker, and an unmount changes neither —
    // so those photos were excluded from hashing permanently, and
    // backup-coverage/dedup silently under-reported.
    //
    // Un-marking is safe: a genuinely unreadable file is re-attempted once and
    // re-marked by the (now correct) sweep. Rows that already HAVE a hash, and
    // stale rows, are untouched.
    //
    // Must run once, not per startup: re-running would also clear the marks the
    // FIXED code sets on genuinely corrupt files, re-attempting them forever.
    db.exec(`UPDATE photos SET hash_attempted = 0
                WHERE hash_attempted = 1 AND content_hash IS NULL AND stale = 0`);
    db.pragma("user_version = 1");
  }
  if (dataVersion < 2) {
    // #161 fix round 2 (I1): photo_embeddings/ml_status first shipped (commit
    // c465228) with a plain `REFERENCES photos(id)` — no ON DELETE CASCADE.
    // better-sqlite3 enables PRAGMA foreign_keys by default, so every existing
    // `DELETE FROM photos` path threw once a photo had a vector or a sentinel;
    // the CASCADE clause (commit e126785) fixes that — but only for a table
    // CREATEd fresh. `CREATE TABLE IF NOT EXISTS` is a no-op against a table
    // that already exists, so any database that started the app in the window
    // between those two commits has both tables WITHOUT the cascade, forever,
    // unless something drops and recreates them — SQLite cannot ALTER a
    // foreign-key clause in place.
    //
    // This DROP is safe TODAY, and ONLY today: #161 has not shipped in any
    // released build, so no real inference result has ever been written to
    // either table — dropping them destroys nothing. DO NOT copy this pattern
    // forward once embeddings ship: the same DROP TABLE run against a live
    // library would destroy hours of real inference work. A future schema
    // change to these tables needs an actual data-preserving migration, not
    // this one reused.
    db.exec(`DROP TABLE IF EXISTS photo_embeddings`);
    db.exec(`DROP TABLE IF EXISTS ml_status`);
    db.pragma("user_version = 2");
  }
  if (dataVersion < 3) {
    // #162: `perceptual_hash` was carved into the photos table and then
    // referenced by absolutely nothing — a pre-allocated slot for a feature
    // nobody built. Embeddings (#161) answer the question it was reserved for,
    // and far better than a hash could: a perceptual hash finds "the same
    // pixels, re-encoded", while a vector finds "the same shot, one frame
    // later", which is what near-duplicate stacking actually needs.
    //
    // Dropped rather than left in place because a column that looks like a
    // feature but has never held a value is actively misleading — that is
    // exactly how `content_hash` read as working dedup for two releases while
    // only ~50 rows were ever populated. Removing it from the CREATE TABLE
    // alone would only affect fresh databases, so existing libraries need this
    // ALTER; nothing reads the column, so there is no data to preserve.
    const hasColumn = db
      .prepare(`SELECT 1 FROM pragma_table_info('photos') WHERE name = ?`)
      .get("perceptual_hash");
    if (hasColumn) db.exec(`ALTER TABLE photos DROP COLUMN perceptual_hash`);
    db.pragma("user_version = 3");
  }
  if (dataVersion < 4) {
    // #162 / Recommendation 4: near_dupe_groups gained `computed_at` so the ML
    // panel can say when the grouping last ran instead of offering a duplicate
    // trigger. `CREATE TABLE IF NOT EXISTS` is a no-op against a table that
    // already exists, so a library created between 2.18.34 and now needs the
    // column added explicitly.
    //
    // NOT a DROP, unlike the user_version 2 step above: that one was safe only
    // because #161 had never shipped, and its comment says in terms not to
    // copy it forward. Existing groupings are real derived data — cheap to
    // recompute, but dropping them would silently un-stack a user's grid until
    // they noticed and re-ran it. The DEFAULT 0 reads as "unknown", which the
    // panel renders as "last run: unknown" rather than as the epoch.
    const hasColumn = db
      .prepare(
        `SELECT 1 FROM pragma_table_info('near_dupe_groups') WHERE name = ?`
      )
      .get("computed_at");
    const tableExists = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
      .get("near_dupe_groups");
    if (tableExists && !hasColumn) {
      db.exec(
        `ALTER TABLE near_dupe_groups ADD COLUMN computed_at INTEGER NOT NULL DEFAULT 0`
      );
    }
    db.pragma("user_version = 4");
  }

  // --- ML artifacts (#161) --------------------------------------------------
  // Their OWN tables, never columns on `photos`. The feed's hot path is
  // `SELECT photos.*` over a keyset seek; a ~800-byte blob per row would be
  // dragged through every page fetch, every tree count and every group sample
  // for no benefit whatsoever.
  //
  // The primary key is (photo_id, model), NOT photo_id. The entire point of the
  // `model` column is that upgrading the model is NEW ROWS rather than a
  // migration — so two models' vectors must be able to coexist, and a photo_id
  // PK would forbid exactly that. Switching models then costs a backfill;
  // switching BACK costs nothing, because the old rows are still here.
  // ON DELETE CASCADE: better-sqlite3 enables PRAGMA foreign_keys by default
  // (confirmed empirically — it is NOT the raw-SQLite off-by-default), so every
  // `DELETE FROM photos` path (resetLibrary, deleteFolder(Subtree),
  // deletePhotosByIds, missing.js relocateMissing) throws once a photo has a
  // vector, unless the child row disappears with its parent automatically.
  // Deriving that from a CASCADE here — rather than adding a clearMlArtifactsFor
  // call at each of today's five delete sites — means a SIXTH delete site added
  // later can't silently reintroduce the same throw.
  db.exec(`
    CREATE TABLE IF NOT EXISTS photo_embeddings (
      photo_id   INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      model      TEXT    NOT NULL,
      dim        INTEGER NOT NULL,
      scale      REAL    NOT NULL,
      vec        BLOB    NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (photo_id, model)
    )
  `);
  // "How many are embedded under model X", and the whole-library vector load,
  // both scan by model. Without this they are full table scans of the widest
  // table in the schema.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_photo_embeddings_model
       ON photo_embeddings(model)`
  );

  // The failure sentinel. An explicit table rather than an overloaded data
  // column, because a failed embedding has no natural zero value — enrich can
  // use width=0 and hashing can use hash_attempted=1, but a vector cannot.
  //
  // It carries `attempts` and `error` so a sentinel can distinguish "this photo
  // cannot be processed" (permanent) from "the drive was not there" (a property
  // of the MOMENT, and the common case on a removable-drive library). Conflating
  // those two is #169, which excluded a whole unmounted drive from hashing
  // forever. runSweep already classifies; this is where the answer is recorded.
  //
  // Keyed by model as well as stage: a photo that fails under one model is not
  // thereby failed under another.
  // Same ON DELETE CASCADE reasoning as photo_embeddings above: a failure
  // sentinel must not outlive the photo it describes, or deleting that photo
  // throws instead of just dropping its sentinel too.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ml_status (
      photo_id   INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      stage      TEXT    NOT NULL,
      model      TEXT    NOT NULL,
      state      TEXT    NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 1,
      error      TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (photo_id, stage, model)
    )
  `);
  // embedCounts' failed-count query filters this table by (stage, model) with
  // no photo_id bound at all; without an index on that pair it is a full
  // table scan. (It is NOT what serves pendingEmbedRows' worklist anti-join —
  // that query correlates on photo_id, which is already the leading column of
  // this table's own PRIMARY KEY, so SQLite plans it off that PK's automatic
  // index regardless of this one. Verified via EXPLAIN QUERY PLAN; see
  // queryPlan.test.js's "embed worklist" describe block. An earlier version of
  // this comment claimed this index was what protected the worklist query —
  // it never was.)
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_ml_status_lookup
       ON ml_status(stage, model, photo_id)`
  );

  // --- Near-duplicate groups (#162) -----------------------------------------
  // The output of nearDupeSweep: which photos are the SAME SHOT as which
  // others. `group_id` is an opaque component label — equal values mean "same
  // group", and nothing else about the number is meaningful or stable across
  // sweeps.
  //
  // photo_id alone is the PK, unlike photo_embeddings' (photo_id, model). A
  // photo has one vector PER model simultaneously, but it belongs to one
  // near-dupe grouping at a time: the sweep computes the whole grouping under
  // the active model and replaces it wholesale. `model` is carried anyway so a
  // stale grouping left by a previous model is recognizable as stale rather
  // than silently mixed into the current one.
  //
  // ON DELETE CASCADE for the same reason as the two tables above, which is
  // not a style preference: better-sqlite3 enables PRAGMA foreign_keys by
  // default, so without it every `DELETE FROM photos` path in the app throws
  // the moment a photo lands in a group. That was #161's Critical 1, and a
  // plain `REFERENCES` here would reproduce it exactly.
  db.exec(`
    CREATE TABLE IF NOT EXISTS near_dupe_groups (
      photo_id    INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
      group_id    INTEGER NOT NULL,
      model       TEXT    NOT NULL,
      computed_at INTEGER NOT NULL DEFAULT 0
    )
  `);
  // `computed_at` repeats the same value on every row, which is not normalized
  // and is deliberate. The grouping is replaced WHOLESALE (see
  // replaceNearDupeGroups), so there is exactly one timestamp per grouping and
  // no partial state a separate table could describe more truthfully. Storing
  // it here means it is deleted with the data it describes — including via the
  // CASCADE above — instead of outliving it as a stale "last run" for a
  // grouping that no longer exists. At ~1,500 rows the duplication costs about
  // 12 KB.
  //
  // It exists so the panel can report STATE rather than offer a second trigger
  // (Recommendation 4, docs/ML-UX-REVIEW-2026-07-26.md): "608 groups, last run
  // 3 minutes ago" answers "did this work?", which a button never did.
  // How alike each photo is to the one immediately BEFORE it in capture time
  // (#216). Distinct from near_dupe_groups, which answers "which photos are the
  // same shot" at the discovery threshold (0.93): this answers "is this photo
  // even related to its predecessor", which the refiner asks at a much lower
  // bar (0.6). One grouping cannot encode two thresholds, and a second
  // component grouping would be wrong for this job — complete linkage means
  // membership implies similarity to EVERY member, so two photos scoring 0.65
  // can land in different components and be split despite being related.
  //
  // `prev_id` is stored, not implied, and it is what makes this SAFE. The
  // client walks its own time order inside whatever grouping is active, which
  // need not match the order this was computed in. It compares prev_id against
  // the photo it actually has in hand and, on any mismatch, declines to split —
  // degrading to today's pure-time behaviour rather than acting on a
  // comparison between the wrong pair.
  db.exec(`
    CREATE TABLE IF NOT EXISTS photo_neighbor_sim (
      photo_id INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
      prev_id  INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      sim      REAL    NOT NULL,
      model    TEXT    NOT NULL
    )
  `);

  // Serves "how many groups are there" and the whole-grouping wipe that starts
  // each sweep; both filter on model with no photo_id bound, so without this
  // they scan the table.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_near_dupe_group
       ON near_dupe_groups(model, group_id)`
  );

  // The metadata sweep's to-do list is PENDING_CONDITION (see db/enrich.js —
  // width IS NULL, an unprobed video, or gps_checked = 0). It runs once per
  // batch over the whole table, so without a matching index it re-scans 100k+
  // rows on every one of the ~2,000 batches a full sweep takes.
  //
  // The partial index's WHERE clause is built from PENDING_CONDITION itself,
  // not a hand-copied literal, and dropped + rebuilt on every startup rather
  // than `CREATE INDEX IF NOT EXISTS`. Both exist for the same reason: SQLite
  // only uses a partial index as a full replacement scan for a query whose
  // WHERE clause it can prove is covered by the index's own predicate — once
  // PENDING_CONDITION gained a disjunct (video_codec, then gps_checked) that
  // an `IF NOT EXISTS` index kept from a prior app version would NOT match,
  // and the query fell back to scanning the whole table with no error and no
  // failing test. (SQLite's multi-index OR optimization was tried and doesn't
  // apply here — it requires each OR arm to be searchable by a plain,
  // non-partial index on the compared column, which doesn't fit this file's
  // "one partial covering index" style. Verified via EXPLAIN QUERY PLAN; see
  // queryPlan.test.js.)
  db.exec(`DROP INDEX IF EXISTS idx_photos_pending_meta`);
  db.exec(
    `CREATE INDEX idx_photos_pending_meta
       ON photos (id) WHERE ${PENDING_CONDITION}`
  );
  // --- Faces (#166) ---------------------------------------------------------
  // A person, which is #167's subject. Created here because photo_faces has to
  // reference something, and a nullable person_id with no target table is a
  // migration waiting to be forgotten.
  //
  // `name` is NULLABLE on purpose: a cluster the user has not named yet must
  // still be browsable ("this face, whoever they are"). Requiring a name would
  // leave every unnamed cluster unreachable until someone does ten minutes of
  // data entry, which is how a face feature becomes a chore.
  db.exec(`
    CREATE TABLE IF NOT EXISTS persons (
      id            INTEGER PRIMARY KEY,
      name          TEXT,
      cover_face_id INTEGER,
      created_at    INTEGER NOT NULL DEFAULT 0
    )
  `);

  // One row PER FACE, not per photo — which is the whole reason this cannot be
  // columns on `photos`, and why person is a filter facet rather than a group
  // dimension (feed.js:53-77: the keyset seek assumes one value per photo per
  // dimension).
  //
  // The box is in SOURCE-IMAGE pixels after EXIF rotation, not in the 640
  // letterbox the detector saw. Storing detector-space coordinates would make
  // every consumer re-derive the scale from the photo's dimensions, and the
  // one that got it wrong would crop a stranger.
  //
  // `vec` follows photo_embeddings' int8 contract exactly (dim + scale + bytes,
  // see server/ml/quantize.js) so one cosine implementation serves both. Keyed
  // by `model` for the same reason embeddings are: a buffalo_l vector and a
  // buffalo_s vector are different spaces, and comparing them yields confident
  // nonsense rather than an error.
  //
  // ON DELETE CASCADE on photo_id but SET NULL on person_id, and the asymmetry
  // is deliberate. Deleting a photo must take its faces with it — a face cannot
  // outlive the pixels it describes, and without CASCADE every `DELETE FROM
  // photos` path throws, which was #161's Critical 1. Deleting a PERSON must
  // not delete faces: unnaming someone corrects the clustering, it does not
  // assert the faces were never there.
  db.exec(`
    CREATE TABLE IF NOT EXISTS photo_faces (
      id         INTEGER PRIMARY KEY,
      photo_id   INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      model      TEXT    NOT NULL,
      box_x      REAL    NOT NULL,
      box_y      REAL    NOT NULL,
      box_w      REAL    NOT NULL,
      box_h      REAL    NOT NULL,
      det_score  REAL    NOT NULL,
      dim        INTEGER NOT NULL,
      scale      REAL    NOT NULL,
      vec        BLOB    NOT NULL,
      person_id  INTEGER REFERENCES persons(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL DEFAULT 0
    )
  `);
  // (model, photo_id) rather than (photo_id): it serves BOTH "the faces in this
  // photo under the active model" and the sweep's anti-join for "photos with no
  // faces yet under this model", which filters on model with no photo_id bound.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_photo_faces_model_photo
       ON photo_faces(model, photo_id)`
  );
  // #167's person filter is phrased `photos.id IN (SELECT photo_id FROM
  // photo_faces WHERE person_id = ?)` — required rather than stylistic, since
  // the feed-seek and tree queries do not JOIN extra tables. Without this index
  // that subquery scans every face in the library on every feed page. Partial,
  // because the overwhelming majority of rows are unassigned until #167 runs
  // and an index over those NULLs answers no query anyone asks.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_photo_faces_person
       ON photo_faces(person_id) WHERE person_id IS NOT NULL`
  );
  // WHO said this face is this person (#167). 'manual' means a human did,
  // and a re-cluster must not overwrite it — exactly what photo_tags.source
  // does for semantic tags. Without this column a re-run silently discards
  // every correction the user made, which #167 names as the thing that must
  // survive ("durable — it survives the next sweep and new photos").
  ensureColumn(db, "photo_faces", "person_source", "TEXT");

  // 2-D projections of the library, for the face map (#232).
  //
  // A run is a SNAPSHOT identified by (kind, model, algorithm, params_key) —
  // `params_key` being a canonicalised digest rather than the raw JSON, so
  // {"a":1,"b":2} and {"b":2,"a":1} are one run and not two. `kind` is what
  // lets #165's photo scatter be another row here rather than another schema.
  db.exec(`
    CREATE TABLE IF NOT EXISTS projection_runs (
      id         INTEGER PRIMARY KEY,
      kind       TEXT    NOT NULL,
      model      TEXT    NOT NULL,
      algorithm  TEXT    NOT NULL,
      params_key TEXT    NOT NULL,
      params     TEXT    NOT NULL,
      members    INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_projection_runs_key
       ON projection_runs(kind, model, algorithm, params_key)`
  );

  // The points. Served by INNER JOIN persons, which is the neatest property of
  // the design: merge eight people away and their dots vanish with NO
  // re-projection, so the map stays truthful about who exists and only their
  // positions go stale.
  //
  // `ref_id` deliberately has NO foreign key and NO cascade, and this is the
  // one thing here a future reader will want to "fix". The point rows must
  // SURVIVE a merge so that an undo brings the dot back; the join already
  // hides them while the person is gone. Adding ON DELETE CASCADE would look
  // like tightening the schema and would silently break undo.
  //
  // WITHOUT ROWID so the primary key IS the table: a run's points are then a
  // contiguous prefix scan rather than an index lookup plus a row fetch each.
  db.exec(`
    CREATE TABLE IF NOT EXISTS projection_point (
      run_id INTEGER NOT NULL,
      ref_id INTEGER NOT NULL,
      x      REAL    NOT NULL,
      y      REAL    NOT NULL,
      PRIMARY KEY (run_id, ref_id)
    ) WITHOUT ROWID
  `);

  ensureFeedIndexes(db);
}

/**
 * Expression indexes for the feed's date grouping/sorting (see sort.js — the DDL
 * is generated there, from the very expressions the queries use).
 *
 * Rebuilds rather than rots: each index name carries a fingerprint of its own
 * definition, so if an expression in sort.js changes, the index built from the
 * OLD expression no longer answers to a wanted name and is dropped here. Without
 * that, a drifted index just stops being used — silently, with no error and no
 * failing test, and the feed slides back to full scans.
 *
 * @param {import("better-sqlite3").Database} db
 */
function ensureFeedIndexes(db) {
  const wanted = feedIndexes();
  const wantedNames = new Set(wanted.map((i) => i.name));

  const existing = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'index' AND name LIKE ?`
    )
    .all(`${FEED_INDEX_PREFIX}%`);

  for (const { name } of existing) {
    if (!wantedNames.has(name)) db.exec(`DROP INDEX IF EXISTS "${name}"`);
  }
  for (const { sql } of wanted) db.exec(sql);
}

/** Idempotent ADD COLUMN — the app ships no migration runner, and
 *  CREATE TABLE IF NOT EXISTS never alters an existing table.
 *
 *  table_xinfo, NOT table_info: `table_info` omits GENERATED columns entirely,
 *  so it reports sort_path as missing on every run after the first, and the
 *  second ALTER dies with "duplicate column name" — i.e. the app would crash on
 *  its second open. `table_xinfo` lists the hidden/generated ones too, and is
 *  identical to `table_info` for ordinary columns. */
function ensureColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_xinfo(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
