/**
 * "Scan my photos" — one process, every enabled stage, progressively.
 *
 * Phase 3 of the unified scan pipeline (design §1). John's ask:
 *
 * > "As a user, I actually only care about one process — 'Scan my photos' — and
 * > then depending on the features selected in the panel, it should do the
 * > embeddings, faces, and grouping automatically. For each photo it should do
 * > all these progressively."
 *
 * ## Cohort-major, stage-minor
 *
 * NOT one photo through every stage. Batching is load-bearing per stage and the
 * sizes differ by 60× (faces takes 8 because each can hold a 60 MB decoded
 * bitmap; hashing takes 50), sessions are expensive and per-stage, and
 * `runSweep`'s termination depends on a shrinking SQL worklist. So a run walks
 * its scope in COHORTS and carries each cohort through every enabled stage
 * before taking the next.
 *
 * What the user perceives is the same thing either way — a slab of photos
 * becoming fully useful at a steady rhythm, rather than everything becoming
 * slightly useful at the end.
 *
 * ## The cohort is a TIME budget (decision D1)
 *
 * Not a fixed photo count. John asked for "the photos that could be processed
 * every 20 secs... so the user can see updates", so the size is derived from
 * what is actually enabled:
 *
 *     cohortSize = clamp(20_000ms / Σ msPerPhoto[enabled], MIN, MAX)
 *
 * With every stage on (~350 ms/photo) that is ~57 photos; with metadata and
 * hashing alone (~25 ms/photo) it is ~800. Both feel identical to the user,
 * which is the point. The clamp exists so a wildly wrong `msPerPhoto` cannot
 * produce a 1-photo or 100,000-photo cohort.
 *
 * ## Progress is milliseconds of work, not photos (design §4.2)
 *
 * Stages differ ~25× in cost, so a bar counting photos would sprint through
 * metadata and crawl through faces. `total` is Σ pending × msPerPhoto, computed
 * once up front and set at `registry.create` — never revised, because a total
 * that arrives late is an indeterminate bar at exactly the moment the user
 * decides whether it hung (#208).
 *
 * ## Stages are INJECTED
 *
 * `runners` maps a stage id to `(ctx) => Promise<{done, failed}>`. That keeps
 * this module testable with no models, no ONNX and no weights on disk — and it
 * is the seam the route uses to hand in the real sweeps.
 */
import { STAGES, pendingAnyWhere, stageById } from "./stages.js";
import { scopeClauseFor, normalizeScope } from "../db/scopeIds.js";

/** The felt rhythm John asked for: a slab of photos every ~20 seconds. */
export const COHORT_MS = 20_000;
/** Bounds, so a wrong msPerPhoto cannot produce an absurd cohort. */
export const COHORT_MIN = 25;
export const COHORT_MAX = 2000;

/**
 * Measured per-photo costs. Deliberately here rather than guessed per caller,
 * so the cohort size, the progress bar and the "about N minutes" estimate
 * cannot disagree about what a stage costs.
 *
 * meta and hash are from `scripts/benchmark.mjs` on a real library; embed and
 * faces come from the model registries, which is where the scope control
 * already reads them.
 */
export const MS_PER_PHOTO = Object.freeze({
  meta: 0.2,
  hash: 0.1,
  embed: 40,
  faces: 300,
});

/**
 * How many photos to take at a time, given what is enabled.
 * @param {string[]} stageIds
 * @param {Record<string, number>} [cost]
 */
export function cohortSize(stageIds, cost = MS_PER_PHOTO) {
  const per = stageIds.reduce((sum, id) => sum + (cost[id] ?? 0), 0);
  if (!per) return COHORT_MAX;
  return Math.max(
    COHORT_MIN,
    Math.min(COHORT_MAX, Math.round(COHORT_MS / per))
  );
}

/**
 * Milliseconds of work implied by a coverage report — the job's `total`.
 * @param {{stages: Record<string, {pending: number}>}} cov
 * @param {string[]} stageIds
 * @param {Record<string, number>} [cost]
 */
export function totalWorkMs(cov, stageIds, cost = MS_PER_PHOTO) {
  return stageIds.reduce(
    (sum, id) => sum + (cov.stages?.[id]?.pending ?? 0) * (cost[id] ?? 0),
    0
  );
}

/**
 * The next cohort: photos in scope still pending in ANY enabled stage.
 *
 * No cursor is stored, and that is the design's central resumability claim. A
 * completed cohort's photos are no longer pending in any stage, so the next
 * call naturally returns the next slab — the DATABASE is the checkpoint, and a
 * crash costs one in-flight batch rather than a run.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{stageIds: string[], scopeIds?: number[]|null, limit: number,
 *          model: string, faceModel: string}} opts
 * @returns {number[]}
 */
export function nextCohort(
  db,
  { stageIds, scopeIds = null, limit, model, faceModel }
) {
  const stages = stageIds.map(stageById).filter(Boolean);
  if (!stages.length) return [];
  const ids = scopeIds === null ? null : normalizeScope(scopeIds);
  // An empty scope is zero photos, never all of them.
  if (ids !== null && ids.length === 0) return [];
  const scopeClause = ids === null ? "" : scopeClauseFor(ids);
  return db
    .prepare(
      `SELECT photos.id AS id
         FROM photos
         JOIN folders ON folders.id = photos.folder_id
        WHERE ${pendingAnyWhere(stages)}
          ${scopeClause}
        ORDER BY photos.id
        LIMIT @limit`
    )
    .all({ model, faceModel, limit })
    .map((r) => r.id);
}

/**
 * Carry a scope through every enabled stage, cohort by cohort.
 *
 * @param {object} opts
 * @param {import("better-sqlite3").Database} opts.db
 * @param {string[]} opts.stageIds which stages are enabled, in STAGES order
 * @param {Record<string, (ctx: {ids: number[]}) => Promise<{done?: number, failed?: number}>>} opts.runners
 * @param {number[]|null} [opts.scopeIds]
 * @param {string} opts.model
 * @param {string} opts.faceModel
 * @param {() => Promise<void>} [opts.checkpoint] preemption (#257)
 * @param {AbortSignal} [opts.signal]
 * @param {(p: {doneMs: number, phase: string, counts: object}) => void} [opts.onProgress]
 * @param {Record<string, number>} [opts.cost]
 */
export async function runPipeline({
  db,
  stageIds,
  runners,
  scopeIds = null,
  model,
  faceModel,
  checkpoint = async () => {},
  signal,
  onProgress = () => {},
  cost = MS_PER_PHOTO,
}) {
  const enabled = STAGES.filter((s) => stageIds.includes(s.id));
  const counts = Object.fromEntries(
    enabled.map((s) => [s.id, { done: 0, failed: 0 }])
  );
  /** Stages that stood down for a HOST reason — a missing model, a dead
   *  worker. Recorded per stage and skipped for the rest of the run: a missing
   *  face model must not stop hashing (design §4.6). */
  const stalled = [];
  const limit = cohortSize(
    enabled.map((s) => s.id),
    cost
  );
  let doneMs = 0;
  let cohorts = 0;
  let photos = 0;

  for (;;) {
    if (signal?.aborted) break;
    // Park here if something higher-priority is waiting (#257). At the TOP of
    // the loop, so a preemption costs at most the cohort already in flight.
    await checkpoint();

    const live = enabled.filter((s) => !stalled.some((x) => x.id === s.id));
    if (!live.length) break;
    const ids = nextCohort(db, {
      stageIds: live.map((s) => s.id),
      scopeIds,
      limit,
      model,
      faceModel,
    });
    if (!ids.length) break;

    cohorts += 1;
    photos += ids.length;
    for (const stage of live) {
      if (signal?.aborted) break;
      onProgress({
        doneMs,
        phase: `${stage.label} · ${photos} photos`,
        counts,
      });
      let r;
      try {
        r = await runners[stage.id]?.({ ids });
      } catch (err) {
        // A stage that throws stands the STAGE down, not the run — the same
        // rule §4.6 sets for a host pause. Hashing must not stop because a
        // face model would not load.
        stalled.push({ id: stage.id, reason: String(err?.message ?? err) });
        continue;
      }
      if (r?.paused) {
        stalled.push({ id: stage.id, reason: r.pauseReason ?? "unavailable" });
        continue;
      }
      counts[stage.id].done += r?.done ?? 0;
      counts[stage.id].failed += r?.failed ?? 0;
      doneMs += (r?.done ?? 0) * (cost[stage.id] ?? 0);
      onProgress({
        doneMs,
        phase: `${stage.label} · ${photos} photos`,
        counts,
      });
    }
  }

  return {
    photos,
    cohorts,
    counts,
    stalled,
    canceled: !!signal?.aborted,
  };
}
