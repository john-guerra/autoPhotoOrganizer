/**
 * The baseline decision **D2** needs.
 *
 * `docs/superpowers/specs/2026-07-31-unified-scan-pipeline-design.md` §7 says
 * the unified "Scan my photos" pipeline must be **at least as fast** as today's
 * separate passes, as an acceptance criterion rather than an aspiration. That
 * is unenforceable without a number measured before the change, so this
 * produces one — and the same script, run after, is the comparison.
 *
 *     node scripts/benchmark.mjs 500            # measure
 *     node scripts/benchmark.mjs 500 --save     # ...and write the record
 *
 * ## Hermetic, and it never touches a real library
 *
 * Photos are generated into a temp directory and the index lives in a temp
 * `AUTOGALLERY_HOME`. Nothing here can reach `~/.autogallery/` or any folder of
 * John's — the same guarantee `docs/AGENT-NOTES.md` requires of destructive
 * index tests, and the reason this is safe to run unattended.
 *
 * ## What it measures, and what it deliberately does not
 *
 * | stage    | needs a model | why it is here                            |
 * | -------- | ------------- | ----------------------------------------- |
 * | `index`  | no            | the upsert cost the pipeline still pays   |
 * | `meta`   | no            | EXIF read; the first stage of the pipeline|
 * | `hash`   | no            | SHA-1 over the file                       |
 * | `cohort` | no            | **the design's largest unquantified risk**|
 * | `embed`  | YES           | skipped loudly — see below                |
 * | `faces`  | YES           | skipped loudly — see below                |
 *
 * **The cohort query is the point of this script**, more than the per-photo
 * numbers. §1.4 of the design flags it: the pipeline picks each cohort with a
 * DISJUNCTION of four pending predicates, and `schema.js:453` already records
 * that SQLite will not use the partial index for an OR of this shape. John's
 * decision **D1** then made cohorts a ~20-SECOND time budget rather than a
 * fixed 500 photos — which for an all-stages run is ~57 photos, so that query
 * runs roughly **2,200 times** for a full-library pass instead of ~250. A cost
 * that is fine at 150ms and unacceptable at 2s, multiplied by nine.
 *
 * `embed` and `faces` need real weights (191 MB for faces) and real inference.
 * A benchmark that downloads a model is a benchmark that fails on a plane, so
 * they are gated behind `ML_INTEGRATION=1` and skip **loudly** — a silent skip
 * on half the pipeline would make the total look better than it is.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import sharp from "sharp";

const COUNT = Number(process.argv[2]) || 500;
const SAVE = process.argv.includes("--save");

/** Wall-clock a thunk. Returns [result, ms]. */
async function timed(fn) {
  const t0 = performance.now();
  const out = await fn();
  return [out, performance.now() - t0];
}

const pad = (n) => String(n).padStart(2, "0");
const fmt = (ms) => `${ms.toFixed(0)}ms`;
const per = (ms, n) => (n ? `${(ms / n).toFixed(2)}ms/photo` : "—");

async function main() {
  const root = await mkdtemp(join(tmpdir(), "ag-bench-"));
  const photosDir = join(root, "photos");
  const home = join(root, "home");
  process.env.AUTOGALLERY_HOME = home;

  const results = [];
  const note = (stage, ms, n, extra = "") =>
    results.push({ stage, ms, n, extra });

  try {
    // --- generate ---------------------------------------------------------
    // Distinct timestamps per photo: identical ones collapse a folder into one
    // burst stack, and then there is no per-photo cost left to measure
    // (docs/TESTING.md, learned from #97).
    const { mkdirSync } = await import("node:fs");
    mkdirSync(photosDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    const start = new Date("2025-06-01T00:00:00Z");
    const [, genMs] = await timed(async () => {
      for (let i = 0; i < COUNT; i++) {
        const t = new Date(start.getTime() + i * 60_000);
        const date =
          `${t.getUTCFullYear()}:${pad(t.getUTCMonth() + 1)}:${pad(t.getUTCDate())} ` +
          `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00`;
        await sharp({
          create: {
            width: 60 + (i % 4) * 10,
            height: 45 + (i % 3) * 10,
            channels: 3,
            background: { r: (i * 7) % 256, g: (i * 13) % 256, b: 160 },
          },
        })
          .withMetadata({ exif: { IFD2: { DateTimeOriginal: date } } })
          .jpeg({ quality: 60 })
          .toFile(join(photosDir, `b_${String(i).padStart(6, "0")}.jpg`));
      }
    });
    note("generate", genMs, COUNT);

    // --- index ------------------------------------------------------------
    const { getDb } = await import("../server/db/connection.js");
    const { upsertScan } = await import("../server/db/photos.js");
    const db = getDb();
    db.prepare(
      `INSERT INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
       VALUES (1, 'bench', 'uuid-bench', ?, ?)`
    ).run(root, Date.now());

    const files = readdirSync(photosDir).map((name) => {
      const st = statSync(join(photosDir, name));
      return { name, size: st.size, mtimeMs: st.mtimeMs, kind: "image" };
    });
    const [rows, indexMs] = await timed(async () =>
      upsertScan(db, photosDir, 1, files)
    );
    note("index", indexMs, rows.length);

    // --- meta -------------------------------------------------------------
    const { NodeProcessingService } =
      await import("../server/processing/NodeProcessingService.js");
    const { pendingMetaPhotos, enrichBatch } =
      await import("../server/db/enrich.js");
    const processing = new NodeProcessingService();
    const [metaDone, metaMs] = await timed(async () => {
      let done = 0;
      for (;;) {
        const batch = pendingMetaPhotos(db, { limit: 200 });
        if (!batch.length) break;
        done += await enrichBatch(db, processing, batch);
      }
      return done;
    });
    note("meta", metaMs, metaDone);

    // --- hash -------------------------------------------------------------
    const { hashFile } = await import("../server/db/hashing.js");
    const paths = files.map((f) => join(photosDir, f.name));
    const [, hashMs] = await timed(async () => {
      for (const p of paths) await hashFile(p);
    });
    note("hash", hashMs, paths.length);

    // --- the cohort query, at a size where the answer means something -----
    //
    // Measured against SYNTHETIC ROWS, not generated files, and the distinction
    // is the whole reason this section exists. The cohort query never opens a
    // photo — it is a scan of the `photos` table — so its cost scales with ROW
    // COUNT, not with anything on disk. Timing it against the few hundred real
    // files above produces a number near zero that says nothing whatsoever
    // about the 125,000-row library the design is worried about.
    //
    // So: insert COHORT_ROWS bare rows (cheap, one transaction, no JPEGs) and
    // time the query there. That is the only way this answers §1.4's question
    // rather than decorating the report with a reassuring 0.01ms.
    const { PENDING_CONDITION } = await import("../server/db/enrich.js");
    const COHORT_ROWS = Number(process.env.BENCH_ROWS) || 125_000;
    const ins = db.prepare(
      `INSERT INTO photos (folder_id, filename, mtime, size, kind, stale)
       VALUES (1, ?, 1, 1, 'image', 0)`
    );
    const [, seedMs] = await timed(async () => {
      db.transaction(() => {
        for (let i = 0; i < COHORT_ROWS; i++) ins.run(`synthetic_${i}.jpg`);
      })();
    });
    note("seed-rows", seedMs, COHORT_ROWS);

    const cohortSql = `
      SELECT photos.id
        FROM photos
        JOIN folders ON folders.id = photos.folder_id
       WHERE photos.stale = 0
         AND ( (${PENDING_CONDITION})
            OR (photos.content_hash IS NULL AND photos.hash_attempted = 0) )
       ORDER BY photos.id
       LIMIT 57`;
    const stmt = db.prepare(cohortSql);
    // The plan the design is worried about, captured verbatim rather than
    // reasoned about — schema.js:453 says SQLite will not use the partial
    // index for an OR of this shape, and this is where that gets checked.
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${cohortSql}`)
      .all()
      .map((r) => r.detail)
      .join(" | ");
    const REPS = 50;

    // TWO measurements, because one of them is a lie.
    //
    // `LIMIT 57` short-circuits: while everything is still pending SQLite finds
    // 57 matches in the first 57 rows and stops, so the query looks free no
    // matter how large the table is. That is the FIRST cohort of a run.
    //
    // The cost the design is actually worried about is the LAST cohort: nearly
    // every row is done, so the scan has to walk the whole table to find the
    // few that are not. Reporting only the first number would put a reassuring
    // 0.01ms next to a risk it never measured.
    const [, cohortEarlyMs] = await timed(async () => {
      for (let i = 0; i < REPS; i++) stmt.all();
    });
    note(
      "cohort (first)",
      cohortEarlyMs,
      REPS,
      `${(cohortEarlyMs / REPS).toFixed(2)}ms — everything pending, LIMIT stops at row 57`
    );

    // Now make it the worst case: everything done except a tail at the far end.
    db.prepare(
      `UPDATE photos
          SET width = 100, height = 100, gps_checked = 1,
              content_hash = 'x', hash_attempted = 1
        WHERE id <= (SELECT MAX(id) - 57 FROM photos)`
    ).run();
    const [, cohortLateMs] = await timed(async () => {
      for (let i = 0; i < REPS; i++) stmt.all();
    });
    note(
      "cohort (last)",
      cohortLateMs,
      REPS,
      `${(cohortLateMs / REPS).toFixed(2)}ms — full scan of ${COHORT_ROWS.toLocaleString("en-US")} rows`
    );
    results.push({ stage: "cohort-plan", plan });

    // --- the gated stages -------------------------------------------------
    if (!process.env.ML_INTEGRATION) {
      console.warn(
        "\n  SKIPPED (loudly): embed and faces need real weights and real\n" +
          "  inference. Re-run with ML_INTEGRATION=1 once the models are on\n" +
          "  disk. Half a pipeline measured is a total that looks better than\n" +
          "  it is.\n"
      );
    }

    report(results, root);
    if (SAVE) await save(results);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function report(results, root) {
  console.log(`\nAutoGallery stage baseline — ${COUNT} photos`);
  console.log(`node ${process.version} · hermetic in ${root}\n`);
  const rows = results.filter((r) => !r.plan);
  const w = Math.max(...rows.map((r) => r.stage.length));
  for (const r of rows) {
    const rate = r.stage.startsWith("cohort") ? r.extra : per(r.ms, r.n);
    console.log(`  ${r.stage.padEnd(w)}  ${fmt(r.ms).padStart(9)}   ${rate}`);
  }
  const planRow = results.find((r) => r.plan);
  if (planRow) console.log(`\n  cohort query plan: ${planRow.plan}`);
  const cohort = results.find((r) => r.stage === "cohort (last)");
  if (cohort) {
    const each = cohort.ms / cohort.n;
    // 2,200 cohorts is a full-library pass at D1's ~57-photo cohorts.
    const projected = (each * 2200) / 1000;
    console.log(
      `\n  WORST-CASE cohort query over a full 125k run (2,200 cohorts): ` +
        `${projected.toFixed(1)}s`
    );
    console.log(
      "  §1.4 calls this the design's largest unquantified risk. Fine at a" +
        "\n  few seconds; a reason to change the plan at minutes."
    );
  }
  console.log("");
}

async function save(results) {
  const stamp = new Date().toISOString().slice(0, 10);
  const path = join(process.cwd(), "docs", "benchmarks", `${stamp}-stages.md`);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(process.cwd(), "docs", "benchmarks"), { recursive: true });
  const lines = [
    `# Stage baseline — ${stamp}`,
    "",
    `Measured by \`scripts/benchmark.mjs ${COUNT}\` on node ${process.version}.`,
    "Hermetic: generated photos in a temp dir, index in a temp AUTOGALLERY_HOME.",
    "",
    "This is the **before** half of decision D2 (the unified pipeline must be at",
    "least as fast as today's separate passes). Re-run the same command after",
    "Phase 3 and diff.",
    "",
    "| stage | total | per unit |",
    "| ----- | ----- | -------- |",
    ...results
      .filter((r) => !r.plan)
      .map(
        (r) =>
          `| \`${r.stage}\` | ${fmt(r.ms)} | ${r.stage.startsWith("cohort") ? r.extra : per(r.ms, r.n)} |`
      ),
    "",
    `**Cohort query plan:** \`${results.find((r) => r.plan)?.plan ?? "n/a"}\``,
    "",
    process.env.ML_INTEGRATION
      ? ""
      : "`embed` and `faces` are NOT in this table — they need real weights and were skipped. Re-run with `ML_INTEGRATION=1` to include them.",
    "",
  ];
  await writeFile(path, lines.join("\n"), "utf8");
  console.log(`  saved ${path}\n`);
}

await main();
