import {
  existsSync,
  statSync,
  createReadStream,
  mkdirSync,
  renameSync,
  fsyncSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import * as fsp from "node:fs/promises";
import { writeFile, rename, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import {
  extname,
  join,
  basename,
  dirname,
  resolve,
  sep,
  isAbsolute,
} from "node:path";
import { homedir, cpus } from "node:os";
import { revealCommand, revealManyCommand } from "./lib/revealCommand.js";
import { NodeProcessingService } from "./processing/NodeProcessingService.js";
import {
  thumbCachePath,
  tmpCachePath,
  thumbsDir,
  cacheRoot,
  videoProxiesDir,
  modelsDir,
} from "./lib/cachePaths.js";
import {
  getCacheStats,
  getCacheBreakdown,
  clearCache,
  pruneOrphanedCache,
} from "./lib/cacheStats.js";
import { safeResolve } from "./lib/safeResolve.js";
import { nextAvailablePath } from "./lib/nextAvailablePath.js";
import { listDirsRecursive } from "./lib/walkDirs.js";
import { listSubdirsWithCounts } from "./lib/subdirs.js";
import { isInsideDir } from "./lib/insideDir.js";
import { normalizeFolderPath } from "./lib/normalizeFolderPath.js";
import { getDb } from "./db/connection.js";
import {
  volumeRootForPath,
  upsertVolume,
  isVolumeMounted,
} from "./db/volumes.js";
import {
  upsertScan,
  getPhotoById,
  setPhotoRating,
  setPhotoCover,
  deleteFolder,
  deleteFolderSubtree,
  deletePhotosByIds,
  resetLibrary,
  resolveDestFolderId,
  repointPhotoToFolder,
  renameFolderPath,
} from "./db/photos.js";
import { hashAllPending, hashProgress } from "./db/hashing.js";
import { runSweep } from "./ml/sweep.js";
import {
  embedAllPending,
  embedProgress,
  isEmbedInFlight,
} from "./ml/embedSweep.js";
import {
  readMlSettings,
  writeMlSettings,
  MlSettingsPersistError,
  effectiveThreshold,
  DEVICES,
} from "./ml/settings.js";
import { MODELS } from "./ml/models.js";
import {
  FACE_MODELS,
  DEFAULT_FACE_MODEL_ID,
  faceModelById,
} from "./ml/faceModels.js";
import { checkFaceModel, downloadFaceModel } from "./ml/faceDownload.js";
import { sweepFaces, isFaceSweepInFlight } from "./ml/faceSweep.js";
import { createFaceEngine } from "./ml/faceEngine.js";
import { faceCounts, purgeFaces } from "./db/faces.js";
import sharp from "sharp";

/**
 * Face-model plumbing (#166), kept together so the routes below read as
 * intent rather than as path arithmetic.
 *
 * `loadOrt` is DYNAMIC on purpose. onnxruntime-node pulls a native addon and
 * ~100 MB of runtime into the process; importing it at module scope would pay
 * that on every server start, including for a user who never turns faces on.
 * Cached after the first call, so a sweep pays it once.
 */
let ortPromise = null;
function loadOrt() {
  ortPromise ??= import("onnxruntime-node").then((m) => m.default ?? m);
  return ortPromise;
}

/** Where one pack's graphs live. NOT under cache/thumbs/ —
 *  pruneOrphanedCache deletes anything there outside its expected key set,
 *  regardless of extension, and would eat a 174 MB model on the next prune. */
function faceModelDir(modelId) {
  return join(modelsDir(), "insightface", modelId);
}

/** An id from a request is untrusted input. faceModelById throws on anything
 *  off the allowlist, and this normalizes an absent/blank value to the default
 *  rather than letting `undefined` reach it — an arbitrary id would be an
 *  arbitrary path AND an arbitrary download. */
function faceModelIdOf(raw) {
  const id =
    typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_FACE_MODEL_ID;
  faceModelById(id); // throws for anything not on the list
  return id;
}

/** The io surface faceDownload expects, bound to one pack's directory. */
function faceIo(modelId) {
  const dir = faceModelDir(modelId);
  return {
    pathFor: (file) => join(dir, file),
    readFile: (path) => fsp.readFile(path),
    writeFile: async (path, bytes) => {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path, bytes);
    },
    unlink: (path) => fsp.unlink(path),
    fetchImpl: (url) => fetch(url),
  };
}
import {
  embedCounts,
  pendingEmbedRows,
  modelStorage,
  purgeModel,
  clearEmbedFailures,
} from "./db/embeddings.js";
import { OnnxMLService } from "./ml/OnnxMLService.js";
import {
  groupNearDupes,
  isNearDupeSweepInFlight,
  nearDupeProgress,
} from "./ml/nearDupeSweep.js";
import {
  nearDupeCounts,
  nearDupeCountsForIds,
  clearNearDupeGroups,
} from "./db/nearDupes.js";
import {
  embeddedVectors,
  normalize,
  rankByVector,
  scoreQuantiles,
} from "./ml/textSearch.js";
import { saveTag, listTags, deleteTag } from "./db/tags.js";
import { interactiveRoute } from "./lib/interactive.js";
import { whyTranscode, playbackPlan } from "./lib/videoPlayback.js";
import {
  pendingMetaPhotos,
  pendingMetaCount,
  photosByIds,
  enrichBatch,
  writeMeta,
} from "./db/enrich.js";

/** Photos per extraction batch: big enough to amortise the exiftool daemon
 *  round-trip, small enough that Cancel feels immediate on a 100k library AND
 *  that the sweep can step aside for the user between batches (see whenIdle). */
const BATCH = 50;
import {
  getFeedPage,
  findGroupBoundary,
  photoIdsMatchingFilter,
  photoCountMatchingFilter,
  workingSetTimeline,
  workingSetTimes,
  countGroupPath,
  fetchGroupRowsAtOffsets,
  takenAtIso,
  DIMENSIONS,
} from "./db/feed.js";
import { getTreeNode, getFlatTree } from "./db/tree.js";
import { ALLOWED_ORIENTATIONS, ALLOWED_KINDS } from "./db/filters.js";
import { parseSort, DATE_SORTS } from "./db/sort.js";
import { sampleOffsets } from "./db/sampleGroup.js";
import { setKeepScope } from "./db/keepScope.js";
import { createManualStack, dissolveStack } from "./db/manualStacks.js";
import { registry } from "./jobs/registry.js";
import {
  classifyMissing,
  listMissing,
  relocateMissing,
  dismissPhotos,
  carryMetadata,
} from "./db/missing.js";

/** Kick the background hasher with a JobsPanel entry, so hours of full-file
 * SHA-1 on a 114k library are visible and cancelable rather than invisible.
 * Fire-and-forget: it must never block a scan's response. */
function kickHashSweep(db) {
  const job = registry.create("hash", { label: "Hashing library contents" });
  hashAllPending(db, {
    job,
    onProgress: (counters) => {
      registry.update(job.id, hashProgress(counters));
    },
  })
    .then((r) => {
      // registry.dismiss() no-ops on a "running" job (by design — you cannot
      // dismiss what hasn't finished), and this job's status is still
      // "running" at this point since nothing has updated it yet. finish()
      // is what actually clears it: "hash" is SELF_CLEARING, so it vanishes
      // from list() immediately instead of leaking as a permanently
      // "running" ghost entry in the JobsPanel.
      if (r.alreadyRunning)
        return registry.finish(job.id, { alreadyRunning: true });
      if (r.paused) {
        return registry.update(job.id, {
          status: "failed",
          error: "paused — drive not available; resumes on the next scan",
        });
      }
      registry.finish(job.id, { hashed: r.hashed, failed: r.failed });
    })
    .catch((e) => registry.fail(job.id, e));
}

/**
 * Kick the background embedder with a JobsPanel entry. Fire-and-forget: it
 * must never block a scan's response.
 *
 * OPT-IN, off by default (#161 fix round 1, Critical): the spec's own words
 * are "models are downloaded, never bundled — first use shows what is being
 * fetched, how big, and its licence." A scan that silently spends tens of MB
 * of someone's connection breaks that promise, so a SCAN-triggered kick is a
 * no-op — no job row, no `getMl()`, nothing touches the ML host — until the
 * user has turned this on in the settings panel. `force: true` is the one
 * escape hatch, and it exists for exactly one caller: `POST /api/ml/embed`.
 * Calling that endpoint IS the explicit consent this whole gate exists to
 * require — do not remove `force` thinking it re-opens the hole; it only
 * ever fires from a route the user had to deliberately hit.
 *
 * The whole body is wrapped in try/catch (Important 3): `readMlSettings()`
 * does synchronous fs work (mkdirSync/existsSync/readFileSync) that CAN
 * throw (EACCES/EROFS on the cache root, EMFILE under load). Uncaught, that
 * throw would escape into the CALLER's control flow — the recursive scan's
 * own try/catch would report a completed scan as FAILED, and the
 * non-recursive scan handler (async, nothing catches a synchronous throw in
 * Express 4) would take the request down entirely. "ML failing must never
 * read as the app failing" applies to this setup work too, not just the
 * async sweep below.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {() => import("./ml/OnnxMLService.js").OnnxMLService} getMl lazy —
 *   only called (and so only spawns the ONNX child) once a sweep actually
 *   runs, and only when this function actually proceeds past the gates
 *   above.
 * @param {{force?: boolean}} [opts] `force` bypasses the `enabled` gate —
 *   NOT the single-flight latch (see isEmbedInFlight, checked by the
 *   /api/ml/embed route itself before calling this).
 */
function kickEmbedSweep(
  db,
  getMl,
  { force = false, scopeIds = null, scopeLabel = null } = {}
) {
  let job;
  try {
    const { modelId, threads, enabled, device } = readMlSettings();
    if (!enabled && !force) return; // opt-in; silent when off — see doc above

    // How many photos this sweep will actually touch, counted ONCE, up front.
    // Without it the job's `total` stays 0 and the JobsPanel renders an
    // indeterminate bar for the whole run (#208) — on a 34,807-photo library
    // that is ~20 minutes of a control that looks frozen. Scoped sweeps count
    // their own scope, so "3 of 12" means what it says.
    const pending = scopeIds
      ? pendingEmbedRows(db, modelId, Number.MAX_SAFE_INTEGER, scopeIds).length
      : (() => {
          const c = embedCounts(db, modelId);
          return Math.max(0, c.total - c.embedded - c.failed);
        })();

    job = registry.create("embed", {
      label: scopeLabel ? `Embedding ${scopeLabel}` : "Embedding photos",
      total: pending,
    });
    const ml = getMl();

    // A first embed against a freshly-selected model means the worker has to
    // download it (tens of MB, per models.js's approxDownloadMB) before it
    // can embed a single photo — embedAllPending's own onProgress (per-photo
    // done/failed counts) has nothing to report during that window, so
    // without this the job would sit at "Embedding photos" / 0 of 0 for
    // however long the download takes, indistinguishable from a frozen
    // control (CLAUDE.md, "Usability"). Relay OnnxMLService's unsolicited
    // download/load frames into the job's phase instead. Guarded — `on`/`off`
    // are that class's own transport detail, not part of the MLService
    // contract, so an injected host without them (a test stub, or a future
    // host with no out-of-process download step to report) simply gets no
    // relay rather than a crash.
    const canStreamProgress =
      typeof ml.on === "function" && typeof ml.off === "function";
    // Filtered to real download chunks and throttled to one registry.update
    // (== one SSE broadcast to every connected client) per {file, whole
    // percentage point} — transformers.js's progress_callback fires per HTTP
    // chunk, thousands of times for a 94 MB file, and a "ready"/"done" frame
    // at 100% for an ALREADY-CACHED model would otherwise render as
    // "downloading … 100%" on every single embed, which reads as re-fetching
    // the model every time (#161 fix round 1, Minor 1).
    let lastRelayed = null;
    const onDownloadProgress = (msg) => {
      if (msg.modelId !== modelId) return; // a stale frame from a prior model
      if (msg.status !== "progress") return; // "initiate"/"done"/"ready" aren't download chunks
      const pct = Number.isFinite(msg.progress)
        ? Math.round(msg.progress)
        : null;
      const key = `${msg.file ?? ""}:${pct}`;
      if (key === lastRelayed) return;
      lastRelayed = key;
      registry.update(job.id, {
        phase: `downloading ${msg.file ?? modelId}${pct !== null ? ` ${pct}%` : ""}`,
      });
    };
    if (canStreamProgress) ml.on("progress", onDownloadProgress);

    embedAllPending(db, {
      ml,
      processing,
      model: modelId,
      threads,
      job,
      scopeIds,
      device,
      onProgress: (counters) =>
        registry.update(job.id, embedProgress(counters, pending)),
    })
      .then((r) => {
        // Mirrors kickHashSweep above: "embed" is SELF_CLEARING, so finish()
        // (not dismiss()) is what actually removes a successful run's row.
        if (r.alreadyRunning)
          return registry.finish(job.id, { alreadyRunning: true });
        if (r.paused) {
          // WHY it paused, in the sweep's own words. "Drive not available"
          // was the only reason a sweep could pause when this was written;
          // it can now also stand down because the ENCODER failed (a model
          // that would not download, a dead worker), and telling that user
          // to check their drive would be both wrong and unactionable.
          // "Nothing was marked" is stated outright because it is the part
          // that matters: no photo was written off.
          return registry.update(job.id, {
            status: "failed",
            error:
              `paused — ${r.pauseReason ?? "drive not available"}. ` +
              "No photo was marked as failed; it resumes on the next scan.",
          });
        }
        registry.finish(job.id, { embedded: r.embedded, failed: r.failed });
        // Vectors just changed, so the grouping computed from them is stale.
        // Chained on success only: after a pause or a failure the vector set
        // is incomplete, and regrouping then would stack photos from a
        // half-embedded library and look like a finished answer.
        kickNearDupeSweep(db);
      })
      .catch((e) =>
        registry.fail(
          job.id,
          // Name the stage and keep the app usable. ML failing must never
          // read as the app failing.
          new Error(`Embedding stopped: ${e.message}. Photos are unaffected.`)
        )
      )
      .finally(() => {
        if (canStreamProgress) ml.off("progress", onDownloadProgress);
      });
  } catch (e) {
    if (job) {
      registry.fail(
        job.id,
        new Error(`Embedding stopped: ${e.message}. Photos are unaffected.`)
      );
    } else {
      // Failed before a job existed to attach the failure to (e.g. reading
      // settings itself threw) — there's nothing for the JobsPanel to show,
      // but this must not be silent to the operator, and it must not
      // propagate into the scan/route that triggered the kick.
      console.error("kickEmbedSweep: could not start the embed sweep:", e);
    }
  }
}

/**
 * Recompute the near-duplicate grouping (#162) in the background.
 *
 * Runs AFTER an embed sweep finishes rather than alongside it, because the
 * grouping is whole-library by nature: one new photo can merge two previously
 * separate groups, so there is no meaningful partial answer to compute while
 * vectors are still arriving. Also kicked directly when a setting that
 * PRODUCED the grouping changes.
 *
 * Never throws into its caller — like kickEmbedSweep, this hangs off scan and
 * settings paths that must not fail because an optional feature did.
 *
 * @param {import("better-sqlite3").Database} db
 */
function kickNearDupeSweep(db) {
  let job;
  try {
    const settings = readMlSettings();
    if (!settings.enabled) return null; // opt-in, same gate as embedding
    // Checked before creating a job: a second job row that immediately
    // self-clears as `alreadyRunning` is a flicker in the JobsPanel the user
    // cannot act on (the same reasoning as isEmbedInFlight, #161 round 1, I2).
    if (isNearDupeSweepInFlight()) return null;

    job = registry.create("near-dupes", { label: "Finding near-duplicates" });
    groupNearDupes(db, {
      model: settings.modelId,
      threshold: effectiveThreshold(settings),
      windowMs: settings.nearDupeWindowMs,
      job,
      onProgress: (c) => registry.update(job.id, nearDupeProgress(c)),
    })
      .then((r) => {
        if (r.alreadyRunning)
          return registry.finish(job.id, { alreadyRunning: true });
        if (r.cancelled)
          return registry.finish(job.id, { cancelled: true, groups: 0 });
        registry.finish(job.id, { groups: r.groups, photos: r.photos });
      })
      .catch((e) =>
        registry.fail(
          job.id,
          new Error(
            `Near-duplicate detection stopped: ${e.message}. ` +
              "Photos and existing stacks are unaffected."
          )
        )
      );
  } catch (e) {
    if (job) {
      registry.fail(
        job.id,
        new Error(`Near-duplicate detection stopped: ${e.message}.`)
      );
    } else {
      console.error("kickNearDupeSweep: could not start the grouping pass:", e);
    }
    return null;
  }
  // The job id so a caller can await completion — the toolbar button reloads
  // the feed once grouping lands, because dupeGroupId rides the feed row and a
  // regrouping the user cannot see is indistinguishable from one that did
  // nothing (#207).
  return job?.id ?? null;
}

/**
 * True if `target` is `root` itself or nested anywhere inside it. Same
 * resolve+startsWith(root+sep) primitive as safeResolve.js, but for testing
 * containment of an already-resolved path rather than joining/validating a
 * user-supplied relative segment.
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function isPathContainedIn(root, target) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const rootWithSep = resolvedRoot.endsWith(sep)
    ? resolvedRoot
    : resolvedRoot + sep;
  return (
    resolvedTarget === resolvedRoot || resolvedTarget.startsWith(rootWithSep)
  );
}

/**
 * Validate + resolve an export destination folder, shared by /api/export and
 * /api/albums/materialize. Guards traversal (safeResolve) and refuses to write
 * inside the app cache. It also refuses to write inside any scanned source
 * folder (the read-only invariant) UNLESS `allowInsideSource` is set — which
 * materialize passes so it can organize a folder *in place* (move rated photos
 * into dated subfolders of the folder they already live in). Copies into a new
 * subfolder never modify existing source files, and the user explicitly asked
 * for it; the cache and traversal guards always apply.
 * @param {import("better-sqlite3").Database} db
 * @param {string} destParent
 * @param {string} folderName
 * @param {{allowInsideSource?: boolean}} [opts]
 * @returns {{target:string}|{error:string}}
 */
function resolveExportTarget(
  db,
  destParent,
  folderName,
  { allowInsideSource = false } = {}
) {
  let destSt;
  try {
    destSt = statSync(destParent);
  } catch {
    return { error: "destination not found" };
  }
  if (!destSt.isDirectory()) return { error: "destination is not a directory" };
  let target;
  try {
    target = safeResolve(destParent, folderName);
  } catch (err) {
    return { error: err.message };
  }
  if (isPathContainedIn(cacheRoot(), target)) {
    return {
      error: "export destination cannot be inside the AutoGallery cache",
    };
  }
  if (!allowInsideSource) {
    const sourceFolders = db.prepare(`SELECT abs_path FROM folders`).all();
    if (sourceFolders.some((f) => isPathContainedIn(f.abs_path, target))) {
      return {
        error: "export destination cannot be inside a scanned source folder",
      };
    }
  }
  return { target };
}

/**
 * Move `src` to `dst`. Tries a same-volume `renameSync` first (atomic); on
 * `EXDEV` (cross-volume — e.g. SD card -> internal disk) falls back to
 * copy -> fsync -> verify size -> unlink. The source is removed ONLY after
 * the destination is confirmed written, so a crash between copy and unlink
 * leaves a harmless duplicate, never a lost file. This is the only code path
 * allowed to remove a source file.
 * The cross-volume copy uses async `fsp.copyFile` (libuv threadpool) so a large
 * file never blocks the event loop — critical in the packaged app where the
 * Express server runs inside the Electron main process.
 * @param {string} src
 * @param {string} dst
 */
async function moveFile(src, dst) {
  try {
    renameSync(src, dst);
    return;
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
  }
  await fsp.copyFile(src, dst); // cross-volume
  const fd = openSync(dst, "r");
  fsyncSync(fd);
  closeSync(fd);
  if (statSync(dst).size !== statSync(src).size) {
    throw new Error(`move verify failed: ${src}`);
  }
  unlinkSync(src); // remove source only after the copy is verified
}

/**
 * Copy (or move) the given photo ids into `targetDir` (created if needed).
 * Never overwrites — collisions get a " (2)" suffix; missing/unmounted
 * sources are counted as skipped. Shared by export and materialize.
 *
 * `signal?.aborted` is checked at the top of every iteration; on abort, an
 * `AbortError` is thrown (files already processed stay — a canceled run
 * leaves a partial, consistent result). The partial manifest is attached to
 * the thrown error as `.manifest` so a caller (e.g. a canceled background
 * job) can still see exactly what was processed for undo purposes.
 *
 * In move mode, each successfully moved file's index row is repointed
 * (`repointPhoto`) so it isn't reported "missing" at its new location.
 * @param {import("better-sqlite3").Database} db
 * @param {string} targetDir
 * @param {Array<number|string>} ids
 * File I/O is async (`fsp.copyFile` on the libuv threadpool) so a single large
 * file never blocks the event loop; in the packaged app the Express server runs
 * inside the Electron main process, so a synchronous copy would beachball the UI.
 * @param {{signal?: AbortSignal, onProgress?: (done:number, total:number, phase:string) => void, move?: boolean}} [opts]
 * @returns {Promise<{copied:number, moved:number, skipped:number, manifest:Array<{id:number, from:string, to:string}>}>}
 */
export async function copyIdsIntoFolder(
  db,
  targetDir,
  ids,
  { signal, onProgress, move = false } = {}
) {
  mkdirSync(targetDir, { recursive: true });
  let copied = 0;
  let moved = 0;
  let skipped = 0;
  const manifest = [];
  const total = ids.length;

  // Resolve the destination folder's id ONCE (it shells out to `diskutil` via
  // upsertVolume). Every photo lands in the same targetDir, so doing this per
  // file — as repointPhoto did — spawned a subprocess per file and made a
  // fast same-volume move crawl for minutes. Move only; copy doesn't reindex.
  const destFolderId = move ? resolveDestFolderId(db, targetDir) : null;

  let i = 0;
  for (const id of ids) {
    if (signal?.aborted) {
      const e = new Error("canceled");
      e.name = "AbortError";
      e.manifest = manifest;
      throw e;
    }
    const photo = getPhotoById(db, Number(id));
    if (!photo || !existsSync(photo.path)) {
      skipped++;
    } else {
      const dst = nextAvailablePath(targetDir, basename(photo.path));
      if (move) {
        await moveFile(photo.path, dst);
        repointPhotoToFolder(db, Number(id), destFolderId, basename(dst));
        moved++;
      } else {
        await fsp.copyFile(photo.path, dst);
        copied++;
      }
      manifest.push({ id: Number(id), from: photo.path, to: dst });
    }
    // Report after every file so the UI can show a live count ("moved 45 of
    // 1200") — the registry update is in-memory and the client polls, so this
    // is cheap even on large jobs.
    onProgress?.(i + 1, total, move ? "moving" : "copying");
    // Yield to the event loop so the client's progress poll (and a cancel) get
    // served *during* the album, not just at album boundaries. A same-volume
    // move is a synchronous renameSync, so without this the loop never lets the
    // HTTP poll through and the count appears frozen until the album finishes.
    if (i % 4 === 0) await new Promise((resolve) => setImmediate(resolve));
    i++;
  }

  return { copied, moved, skipped, manifest };
}

const processing = new NodeProcessingService();

const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  // Video containers. Correct types are served regardless of whether a given
  // container plays natively in the loupe's <video> (mkv/avi/mts and HEVC may
  // not) — playability is a browser concern, separate from serving.
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".3gp": "video/3gpp",
  ".mts": "video/mp2t",
  ".m2ts": "video/mp2t",
};

/**
 * Parse a single-range `Range: bytes=start-end` header against a known total
 * size. Returns `null` when there is no Range header (caller serves the whole
 * file), `"invalid"` when the range is unsatisfiable (caller responds 416), or
 * `{start, end}` (inclusive, clamped) for a valid range. Only the common
 * single-range form is supported; multi-range requests fall back to null (full
 * file), which is a valid response.
 * @param {string|undefined} header
 * @param {number} size
 * @returns {null | "invalid" | {start:number, end:number}}
 */
function parseByteRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multi-range or malformed → serve the whole file
  const [, startStr, endStr] = m;
  if (startStr === "" && endStr === "") return null;
  let start;
  let end;
  if (startStr === "") {
    // suffix range: last N bytes
    const suffix = Number(endStr);
    if (suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? size - 1 : Math.min(Number(endStr), size - 1);
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

/**
 * Parses + validates the optional `filter` query param into a filter spec.
 * @returns {{spec: object, error?: string}} `error` set ⇒ respond 400.
 */
function parseFilterParam(req) {
  if (!req.query.filter) return { spec: {} };
  let raw;
  try {
    raw = JSON.parse(String(req.query.filter));
  } catch {
    return { spec: {}, error: "filter must be JSON" };
  }
  if (!raw || typeof raw !== "object") return { spec: {} };
  const spec = {};
  if (raw.minRating !== undefined) {
    const r = Number(raw.minRating);
    if (!Number.isInteger(r) || r < 0 || r > 5) {
      return { spec: {}, error: "minRating must be an integer 0-5" };
    }
    spec.minRating = r;
  }
  if (raw.orientations !== undefined) {
    if (
      !Array.isArray(raw.orientations) ||
      !raw.orientations.every((o) => ALLOWED_ORIENTATIONS.includes(o))
    ) {
      return {
        spec: {},
        error:
          "orientations must be a subset of " + ALLOWED_ORIENTATIONS.join("/"),
      };
    }
    spec.orientations = raw.orientations;
  }
  if (raw.text !== undefined) {
    // A facet missing from THIS allowlist is silently dropped, however correct
    // the SQL and the UI are — so the search box lives or dies on this block.
    if (typeof raw.text !== "string") {
      return { spec: {}, error: "text must be a string" };
    }
    if (raw.text.length > 200) {
      return { spec: {}, error: "text must be 200 characters or fewer" };
    }
    spec.text = raw.text;
  }
  if (raw.kinds !== undefined) {
    if (
      !Array.isArray(raw.kinds) ||
      !raw.kinds.every((k) => ALLOWED_KINDS.includes(k))
    ) {
      return {
        spec: {},
        error: "kinds must be a subset of " + ALLOWED_KINDS.join("/"),
      };
    }
    spec.kinds = raw.kinds;
  }
  if (raw.scopeIds !== undefined) {
    if (
      !Array.isArray(raw.scopeIds) ||
      !raw.scopeIds.every((n) => Number.isInteger(n))
    ) {
      return { spec: {}, error: "scopeIds must be an array of integers" };
    }
    // Guard the URL/SQL-parameter length ("keep only" a huge group). Callers
    // should narrow before focusing on more than this.
    if (raw.scopeIds.length > 5000) {
      return { spec: {}, error: "scopeIds too large (max 5000)" };
    }
    spec.scopeIds = raw.scopeIds;
  }
  // "Keep only" working set, referenced by flag; the ids live in the keep_scope
  // table (set via POST /api/scope), so there is no size cap here.
  if (raw.keepScope) spec.keepScope = true;
  // A saved semantic tag (#164), matched by the value the user typed. This
  // allowlist entry is load-bearing in the quiet way this file warns about
  // above: correct SQL in filters.js and correct UI in filterSpec.js still
  // produce a filter that does NOTHING if the key never gets past here.
  // Person (#167). A facet missing from THIS allowlist is silently dropped
  // however correct the SQL and the UI are, and that failure looks like
  // nothing at all from the client side — see the warning above.
  if (raw.personId !== undefined && raw.personId !== null) {
    const id = Number(raw.personId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return { spec: {}, error: "personId must be a positive integer" };
    }
    spec.personId = id;
  }
  if (raw.tag !== undefined && raw.tag !== null) {
    if (typeof raw.tag !== "string" || !raw.tag.length) {
      return { spec: {}, error: "tag must be a non-empty string" };
    }
    spec.tag = raw.tag;
  }
  // Folder-focus scope ("open a folder"): the abs_path of the focused subtree
  // root. Only ever compared against the indexed folders.abs_path column (never
  // resolved to a file), so no safeResolve is needed here.
  if (raw.folderPath !== undefined && raw.folderPath !== null) {
    if (typeof raw.folderPath !== "string" || !raw.folderPath.length) {
      return { spec: {}, error: "folderPath must be a non-empty string" };
    }
    spec.folderPath = raw.folderPath;
  }
  // Timeline filter time-range (epoch ms). Each bound is optional; a finite
  // number constrains, anything else is rejected so a garbled range can't
  // silently widen the query.
  for (const key of ["dateFrom", "dateTo"]) {
    if (raw[key] !== undefined && raw[key] !== null) {
      const v = Number(raw[key]);
      if (!Number.isFinite(v)) {
        return { spec: {}, error: `${key} must be a finite epoch-ms number` };
      }
      spec[key] = v;
    }
  }
  // Which date attribute the timeline (and thus the dateFrom/dateTo bounds)
  // reflects — follows the feed's sort date on the client. Must be a known
  // date-type sort; anything else is rejected rather than silently ignored.
  if (raw.dateAttr !== undefined && raw.dateAttr !== null) {
    if (!DATE_SORTS.includes(raw.dateAttr)) {
      return {
        spec: {},
        error: `dateAttr must be one of ${DATE_SORTS.join("/")}`,
      };
    }
    spec.dateAttr = raw.dateAttr;
  }
  return { spec };
}

/**
 * Register the API routes on an Express app.
 * @param {import("express").Express} app
 */
export function registerApi(app, { ml } = {}) {
  // The ML host. Defaults to the ONNX child process (server/ml/
  // OnnxMLService.js) — which is what every caller actually gets today:
  // electron/main.js calls createApp() with no arguments, and nothing else
  // injects a host either. `ml` exists for TESTS (api.test.js's
  // workingMl()/inertMl(), which keep the suite from forking a real worker)
  // and to keep the seam open for a future host, e.g. the Python sidecar
  // ProcessingService.js has always anticipated. An earlier version of this
  // comment claimed electron/main.js injected a WebGPU renderer host: that
  // host existed only briefly on this branch and was DELETED (#161, Task 11
  // — it had three Criticals, including one leaked Chromium window per
  // photo; the GPU is taken from the ONNX child's own execution-provider
  // selection instead, see server/ml/worker/devices.js). server/ must never
  // import electron — same seam as ProcessingService. Resolved LAZILY:
  // constructing OnnxMLService does not spawn anything (see its constructor) —
  // only the first configure()/embedImages() call does, via #ensureChild() —
  // so no child process exists until an embed sweep actually runs.
  let mlService = ml ?? null;
  const getMl = () => (mlService ??= new OnnxMLService());

  // --- Jobs -----------------------------------------------------------------
  app.get("/api/jobs", (_req, res) => res.json({ jobs: registry.list() }));

  app.get("/api/jobs/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (jobs) => res.write(`data: ${JSON.stringify(jobs)}\n\n`);
    send(registry.list());
    const onChange = (jobs) => send(jobs);
    registry.on("change", onChange);
    req.on("close", () => registry.off("change", onChange));
  });

  app.post("/api/jobs/:id/cancel", (req, res) => {
    const j = registry.get(req.params.id);
    if (!j) return res.status(404).json({ error: "no such job" });
    if (j.status !== "running")
      return res.status(409).json({ error: "not running" });
    registry.cancel(req.params.id);
    res.json({ ok: true });
  });

  // Clear the finished rows in one go. Running jobs are left alone — this is
  // "dismiss all", not "cancel all".
  app.post("/api/jobs/dismiss-all", (_req, res) => {
    res.json({ ok: true, dismissed: registry.dismissAll() });
  });

  app.post("/api/jobs/:id/dismiss", (req, res) => {
    const j = registry.get(req.params.id);
    if (!j) return res.status(404).json({ error: "no such job" });
    if (j.status === "running")
      return res.status(409).json({ error: "still running" });
    registry.dismiss(req.params.id);
    res.json({ ok: true });
  });

  // --- Scan ---------------------------------------------------------------
  // The directories a recursive scan of `dir` would import, each with a media
  // count — the Add panel's subfolder checklist reads this so the user can
  // uncheck an Exports/ or Selects/ folder BEFORE it lands in the library.
  app.get("/api/fs/subdirs", async (req, res) => {
    const dir = req.query?.dir;
    if (typeof dir !== "string" || dir.length === 0) {
      return res.status(400).json({ error: "dir is required" });
    }
    let st;
    try {
      st = statSync(dir);
    } catch {
      return res.status(404).json({ error: `not found: ${dir}` });
    }
    if (!st.isDirectory()) {
      return res.status(400).json({ error: `not a directory: ${dir}` });
    }
    try {
      res.json(await listSubdirsWithCounts(dir, processing));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/scan", async (req, res) => {
    // Wall-clock (Date.now, NOT the monotonic t0 below) so it's comparable
    // against photos.first_seen_at when classifyMissing runs after the scan.
    const scanStartedAt = Date.now();
    const dir = req.body?.dir;
    // Recursive ("soup folder") scan: point at a parent, pull in every
    // subfolder. Each directory with media becomes its own folders row, so the
    // on-disk structure is preserved as browsable sections.
    const recursive = req.body?.recursive === true;
    if (typeof dir !== "string" || dir.length === 0) {
      return res.status(400).json({ error: "dir is required" });
    }
    // Optional subset: scan exactly these directories instead of the whole
    // recursive walk (the subfolders the user checked). These are user-supplied
    // paths arriving over HTTP, so each is validated to be a real directory
    // INSIDE `dir` — isInsideDir closes both the shared-name-prefix hole
    // (/a/bc is not inside /a/b) and the `..`-traversal hole. One bad entry
    // rejects the whole request: we never silently drop a folder the user asked
    // for, and never scan one they didn't.
    const dirsSubset = req.body?.dirs;
    if (dirsSubset !== undefined) {
      if (
        !Array.isArray(dirsSubset) ||
        dirsSubset.some((d) => typeof d !== "string")
      ) {
        return res
          .status(400)
          .json({ error: "dirs must be an array of strings" });
      }
      for (const d of dirsSubset) {
        if (!isInsideDir(dir, d)) {
          return res
            .status(400)
            .json({ error: `outside the scanned folder: ${d}` });
        }
        let sub;
        try {
          sub = statSync(d);
        } catch {
          return res.status(400).json({ error: `not found: ${d}` });
        }
        if (!sub.isDirectory()) {
          return res.status(400).json({ error: `not a directory: ${d}` });
        }
      }
    }
    let st;
    try {
      st = statSync(dir);
    } catch {
      return res.status(404).json({ error: `not found: ${dir}` });
    }
    if (!st.isDirectory()) {
      return res.status(400).json({ error: `not a directory: ${dir}` });
    }
    // Canonicalise before anything keys on it: the recursive walk seeds its
    // first entry from this exact string, and a trailing slash would fork the
    // same folder into a duplicate row whose photos then double in the feed
    // (#138). upsertScan normalises again as the identity backstop.
    const scanRoot = normalizeFolderPath(dir);

    const db = getDb();
    // Every subfolder is under `dir`, hence on the same physical volume — one
    // volume lookup covers the whole tree.
    const volumeId = upsertVolume(db, volumeRootForPath(dir));

    const t0 = performance.now();

    if (recursive) {
      const dirs =
        dirsSubset && dirsSubset.length
          ? dirsSubset
          : await listDirsRecursive(scanRoot);
      const job = registry.create("scan", {
        label: `Scan ${basename(dir)}`,
        total: dirs.length,
      });
      res.status(202).json({ jobId: job.id });

      (async () => {
        try {
          let count = 0;
          let folders = 0;
          for (let i = 0; i < dirs.length; i++) {
            if (job.controller.signal.aborted) {
              const e = new Error("canceled");
              e.name = "AbortError";
              throw e;
            }
            const subdir = dirs[i];
            const files = await processing.scan(subdir);
            if (files.length) {
              // don't create empty folders rows
              upsertScan(db, subdir, volumeId, files);
              count += files.length;
              folders += 1;
            } else {
              // A folder ALREADY in the index that is now empty must have its
              // rows reconciled (marked stale), or an emptied folder's photos
              // are never noticed as missing. New empty folders create no row.
              const known = db
                .prepare(`SELECT id FROM folders WHERE abs_path = ?`)
                .get(subdir);
              if (known) {
                db.prepare(
                  `UPDATE photos SET stale = 1 WHERE folder_id = ?`
                ).run(known.id);
              }
            }
            registry.update(job.id, {
              done: i + 1,
              phase: `scanning ${basename(subdir)}`,
            });
          }
          const elapsedMs = Math.round(performance.now() - t0);
          kickHashSweep(db);
          kickEmbedSweep(db, getMl);
          const missing = classifyMissing(db, scanStartedAt);
          registry.finish(job.id, {
            root: scanRoot,
            count,
            folders,
            elapsedMs,
            missing,
          });
        } catch (e) {
          registry.fail(job.id, e);
        }
      })();
      return;
    }

    const files = await processing.scan(scanRoot);
    const rows = upsertScan(db, scanRoot, volumeId, files);
    const elapsedMs = Math.round(performance.now() - t0);

    // Never blocks the response — see server/db/hashing.js.
    kickHashSweep(db);
    kickEmbedSweep(db, getMl);

    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      size: r.size,
      mtimeMs: r.mtimeMs,
      rating: r.rating,
      preferredCover: r.preferredCover === 1,
      kind: r.kind,
      duration: r.duration ?? null,
      manualStackId: r.manualStackId ?? null,
      keepSeparate: r.keepSeparate === 1,
    }));
    const missing = classifyMissing(db, scanStartedAt);
    res.json({
      root: dir,
      count: items.length,
      folders: 1,
      elapsedMs,
      missing,
      items,
    });
  });

  // --- Metadata sweep -------------------------------------------------------
  // GET /api/enrich/pending -> { pending } so the UI can say how much is left
  // (and hide the button when there's nothing to do).
  app.get("/api/enrich/pending", (_req, res) => {
    res.json({ pending: pendingMetaCount(getDb()) });
  });

  // POST /api/enrich -> 202 { jobId }. Two modes, deliberately one endpoint
  // because the work (extract → write) is identical; only the to-do list differs.
  //
  //   {}            SWEEP: every photo nobody has looked at yet. Enrichment is
  //                 otherwise LAZY (only what you scroll past), so on a big
  //                 library most photos have no date, camera or dimensions —
  //                 they sit in "Unknown" and never reach the timeline. This is
  //                 the "go and actually read all of it" button.
  //                 Resumable by construction: `width IS NULL` IS the to-do
  //                 list, so a cancel (or crash, or quit) just leaves a shorter
  //                 list next time. No cursor to persist, nothing to clean up.
  //
  //   { ids: [..] } RE-READ: exactly these photos, EVEN IF already read — the
  //                 sentinel is ignored on purpose. This is "rescan the selected
  //                 photos", for when the file changed on disk (or we got it
  //                 wrong) and the user wants us to look again.
  app.post("/api/enrich", async (req, res) => {
    const db = getDb();
    const rawIds = req.body?.ids;
    if (rawIds !== undefined && !Array.isArray(rawIds)) {
      return res.status(400).json({ error: "ids must be an array" });
    }
    const ids = Array.isArray(rawIds)
      ? rawIds.map(Number).filter(Number.isInteger)
      : null;
    if (ids && ids.length === 0) {
      return res
        .status(400)
        .json({ error: "ids was empty — nothing to re-read" });
    }

    // Building the to-do list touches SQLite, and this is an ASYNC handler:
    // Express 4 does not catch a throw in one, so an uncaught error here does
    // not 500 — it takes the whole server down with it (which is exactly what
    // "too many SQL variables" did before photosByIds learned to chunk). The
    // user gets a real message instead of a dead app.
    let forced, total, job;
    try {
      // The re-read list is FIXED up front (the same photos the user selected);
      // the sweep's list is drained as it goes, since it shrinks as we write.
      forced = ids ? photosByIds(db, ids) : null;
      total = forced ? forced.length : pendingMetaCount(db);
    } catch (e) {
      return res
        .status(500)
        .json({ error: `could not work out what to read: ${e.message}` });
    }
    if (total === 0) {
      return res.status(200).json({ jobId: null, pending: 0 });
    }
    job = registry.create("enrich", {
      label: forced
        ? `Re-read metadata for ${total.toLocaleString()} photo${total === 1 ? "" : "s"}`
        : `Read metadata for ${total.toLocaleString()} photos`,
      total,
    });
    res.status(202).json({ jobId: job.id, pending: total });

    (async () => {
      const t0 = performance.now();
      try {
        // `forced` (re-read mode) is a FIXED in-memory list; the sweep's list is
        // drained from SQL as it goes. runSweep does not care which — nextBatch
        // is a callback precisely so both modes share one loop.
        let taken = 0;
        const { done, failed, paused } = await runSweep(job, {
          nextBatch: () => {
            if (!forced) return pendingMetaPhotos(db, { limit: BATCH });
            const slice = forced.slice(taken, taken + BATCH);
            taken += slice.length;
            return slice;
          },
          process: (batch) => enrichBatch(db, processing, batch),
          // width=0 is the metadata sweep's "attempted, nothing there" sentinel
          // — see db/enrich.js. This file simply has no readable metadata.
          markFailed: (p) => writeMeta(db, p.id, {}),
          folderOf: (p) => dirname(p.path),
          onProgress: ({ done: d }) =>
            registry.update(job.id, {
              done: d,
              phase: `${d.toLocaleString()} of ${total.toLocaleString()} read`,
            }),
        });
        // Mirrors kickHashSweep's paused handling below: the drive went away
        // mid-sweep, runSweep stopped and marked nothing, so a normal finish()
        // here would tell the user the read completed when a chunk of it never
        // ran. Nothing fails silently (CLAUDE.md, "Usability").
        if (paused) {
          // Unlike the hash sweep (kickHashSweep, above), nothing re-kicks
          // enrich automatically — it only ever runs from the UI's
          // Read-metadata action. "resumes on the next sweep" would promise a
          // resumption that never happens, which this project's usability
          // rule (CLAUDE.md, "specific over generic") forbids. Tell the user
          // what to actually do instead.
          registry.update(job.id, {
            status: "failed",
            error: "paused — drive not available; reconnect it and run again",
          });
          return;
        }
        registry.finish(job.id, {
          read: done - failed,
          failed,
          elapsedMs: Math.round(performance.now() - t0),
        });
      } catch (e) {
        registry.fail(job.id, e);
      }
    })();
  });

  // --- ML settings and status (#161) ----------------------------------------
  // Historically a hardcoded string here, true only by accident: the worker
  // hardcoded `device: "cpu"` and never tried anything else, even though
  // onnxruntime-node's prebuilt actually bundles CoreML/DirectML/CUDA too
  // (worker/devices.js's candidateDevices() and worker/index.js's
  // loadWithBestDevice() now try them
  // in order and records the winner). A static string here would silently
  // become a lie the moment that changed, so each MLService implementation
  // now answers for itself via `describeProvider()` (server/ml/MLService.js),
  // and /api/ml/stats below asks whichever host is actually configured. This
  // fallback is for legacy test doubles that predate that method (plain
  // objects, not real MLService subclasses — see workingMl()/inertMl() in
  // api.test.js) so a GET never throws just because the injected stub
  // doesn't implement it.
  const ML_PROVIDER_FALLBACK = "onnxruntime-node (cpu)";

  // GET current settings plus the vetted model list and the machine's core
  // count (`maxThreads`, for a 1..N threads slider — Task 12), so a settings
  // panel can render a picker without a second round trip.
  app.get("/api/ml/settings", (req, res) => {
    res.json({
      ...readMlSettings(),
      models: MODELS,
      maxThreads: cpus().length,
      // The execution providers the panel may offer (#209). Sent from here
      // rather than hardcoded client-side so the list can never drift from
      // what writeMlSettings will actually accept.
      devices: DEVICES,
    });
  });

  // PUT a patch ({modelId?, threads?, enabled?}). writeMlSettings throws a
  // plain Error with a specific "unknown model: …" for a bad id (a
  // VALIDATION failure — the user gave us something invalid, 400) or an
  // MlSettingsPersistError when the write to disk itself failed (ENOSPC,
  // EACCES, a read-only cache root — not the user's fault, 500). Never a
  // generic 500 for the validation case, and never a 400 that blames the
  // user for a disk problem (CLAUDE.md, "specific over generic"; #161 fix
  // round 1, Minor 4).
  app.put("/api/ml/settings", (req, res) => {
    try {
      const before = readMlSettings();
      const next = writeMlSettings(req.body ?? {});
      // A stored grouping is the OUTPUT of these three inputs. Leaving it in
      // place after one of them changes would keep stacking photos by a rule
      // the user has just revoked — silently, and with the panel reporting the
      // new setting as if it were in force. Cleared immediately rather than at
      // the end of the next sweep, so the grid never shows a grouping that no
      // setting on screen would produce.
      const regroupingInputChanged =
        next.modelId !== before.modelId ||
        next.nearDupeThreshold !== before.nearDupeThreshold ||
        next.nearDupeWindowMs !== before.nearDupeWindowMs;
      if (regroupingInputChanged) {
        clearNearDupeGroups(getDb());
        kickNearDupeSweep(getDb());
      }
      res.json(next);
    } catch (err) {
      if (err instanceof MlSettingsPersistError) {
        return res.status(500).json({ error: err.message });
      }
      res.status(400).json({ error: err.message });
    }
  });

  // GET embedded/failed/total counts for the ACTIVE model, plus per-model
  // on-disk storage so a settings panel can offer a targeted purge, and the
  // provider string (see ML_PROVIDER_FALLBACK above — `describeProvider()`
  // is the real source of truth). Counts come from embedCounts (queries
  // `photos` directly), not from a sweep's live counters — a concurrent-
  // delete race can transiently overstate a live `failed` tally, but
  // embedCounts is the persisted, UI-facing truth.
  //
  // `getMl()` here does NOT spawn anything: constructing OnnxMLService is
  // inert (see its constructor), and describeProvider() answers from
  // already-known state (the EP the last real embed reported, or "cpu" if
  // none has run yet) rather than probing the worker — it never touches the
  // child process on its own. So this GET still never triggers the
  // un-opted-in spawn the `enabled` gate in kickEmbedSweep exists to prevent.
  app.get("/api/ml/stats", async (req, res) => {
    const db = getDb();
    const { modelId } = readMlSettings();
    const ml = getMl();
    const provider =
      typeof ml.describeProvider === "function"
        ? await ml.describeProvider()
        : ML_PROVIDER_FALLBACK;
    res.json({
      model: modelId,
      provider,
      counts: embedCounts(db, modelId),
      storage: modelStorage(db),
      // #162. Reported as "photos in a group" and "groups", never as a
      // percentage of the library: most photos have no near-duplicate, so a
      // percentage would read as low coverage when it is the correct answer.
      nearDupes: nearDupeCounts(db, modelId),
    });
  });

  // The one thing both write routes below must not do: delete rows out from
  // under a RUNNING sweep. runSweep remembers the ids it sentinel-marked in
  // the current pass and throws if one comes back from nextBatch() — a real
  // guard against a caller whose markFailed doesn't remove its row, but it
  // cannot tell that apart from a purge/retry that legitimately cleared the
  // record a second ago. The user would then see "Embedding stopped:
  // runSweep: row 42 was marked failed but nextBatch() returned it again…"
  // for a button they were invited to press. Refuse with a 409 and say what
  // to do instead; the settings panel also disables both buttons while a
  // sweep runs, but the UI check races the sweep's own start and this one
  // does not (isEmbedInFlight is synchronous, and so is the latch it reads).
  const SWEEP_RUNNING =
    "an embedding sweep is running — stop it in the jobs panel first, " +
    "then try again";
  /** @param {import("express").Response} res @returns {boolean} answered? */
  const refuseWhileSweeping = (res) => {
    if (!isEmbedInFlight()) return false;
    res.status(409).json({ error: SWEEP_RUNNING });
    return true;
  };

  // POST { model } -> drop every vector + failure sentinel for that model.
  app.post("/api/ml/purge", (req, res) => {
    const model = String(req.body?.model ?? "");
    if (!model) return res.status(400).json({ error: "model is required" });
    if (refuseWhileSweeping(res)) return;
    res.json(purgeModel(getDb(), model));
  });

  // POST -> forget every "this photo could not be embedded" record for the
  // ACTIVE model, so the next sweep tries them again. The vectors already
  // computed are untouched.
  //
  // This exists because a sentinel was, until now, effectively permanent:
  // the only three things that clear one need the file's bytes to change,
  // the photo to be deleted, or the Purge button — and Purge is rendered per
  // row of `storage`, which is a GROUP BY over photo_embeddings. A sweep
  // that failed EVERYTHING (a model that would not download; before the
  // Critical-1 fix, any host failure at all) writes no vectors, so there is
  // no storage row, no Purge button, and the only recourse left was deleting
  // index.db — which also destroys ratings, keep-scope, manual stacks and
  // album names. A failure record the user cannot take back is not an
  // acceptable end state regardless of how it got written.
  app.post("/api/ml/retry-failed", (req, res) => {
    if (refuseWhileSweeping(res)) return;
    const { modelId } = readMlSettings();
    res.json({ model: modelId, ...clearEmbedFailures(getDb(), modelId) });
  });

  // POST -> (re)kick the background embedder against the current settings,
  // e.g. after switching models. Fire-and-forget, mirroring /api/scan: the
  // response confirms the kick, not completion — progress lives in the
  // JobsPanel (GET /api/jobs, /api/jobs/events).
  //
  // Two things this route alone is responsible for, that a scan-triggered
  // kick is not:
  //  1. `force: true` — hitting this endpoint IS the explicit user consent
  //     the `enabled` gate (kickEmbedSweep, above) requires, so it bypasses
  //     that gate on purpose. Do not remove it thinking it's a hole.
  //  2. The single-flight latch in embedAllPending is NOT keyed by model, so
  //     a kick while a sweep against a DIFFERENT model is still running
  //     would otherwise silently no-op — kickEmbedSweep's own alreadyRunning
  //     handling creates a job, finishes it, and self-clears it in the same
  //     tick, which is invisible to anyone who didn't already have an SSE
  //     subscription open. That's fine for a SCAN's silent background kick,
  //     but not for a button the user just clicked (#161 fix round 1,
  //     Important 2) — so check isEmbedInFlight() FIRST and answer
  //     synchronously instead, before a job (that would vanish before
  //     anyone could read it) ever gets created.
  app.post("/api/ml/embed", (req, res) => {
    if (isEmbedInFlight()) {
      return res.json({ started: false, alreadyRunning: true });
    }
    // #206: an optional `ids` scope embeds just those photos — the selection,
    // the current view, or one right-clicked folder — instead of the whole
    // library. Absent, behaviour is exactly as before.
    const ids = req.body?.ids;
    if (ids !== undefined) {
      if (!Array.isArray(ids) || ids.length === 0) {
        // Specific over generic: an empty selection is a real thing a user can
        // do, and "nothing selected" is far more useful than "bad request".
        return res
          .status(400)
          .json({ error: "No photos were selected to embed." });
      }
      if (ids.length > 50_000) {
        return res.status(413).json({
          error: `That is ${ids.length.toLocaleString()} photos — too many to send at once. Embed the whole library instead.`,
        });
      }
    }
    kickEmbedSweep(getDb(), getMl, {
      force: true,
      scopeIds: ids ?? null,
      scopeLabel: ids ? `${ids.length.toLocaleString()} photos` : null,
    });
    res.json({ started: true, scoped: ids ? ids.length : null });
  });

  // POST -> recompute the near-duplicate grouping (#162) against the current
  // settings, without re-embedding anything. Separate from /api/ml/embed
  // because the two costs are wildly different: embedding 114k photos is
  // ~72 minutes of inference, regrouping them is seconds of arithmetic over
  // vectors already on disk. A user tuning the threshold needs the cheap one
  // on its own.
  //
  // Answers synchronously when a pass is already running, for the same reason
  // /api/ml/embed does: a job row created and self-cleared in one tick is
  // invisible to anyone without an SSE subscription already open, which is
  // not an acceptable answer to a button the user just clicked.
  app.post("/api/ml/near-dupes", (req, res) => {
    if (isNearDupeSweepInFlight()) {
      return res.json({ started: false, alreadyRunning: true });
    }
    if (!readMlSettings().enabled) {
      // Specific over generic (CLAUDE.md): the button is reachable from the
      // panel, so saying WHY nothing happened, and what to do about it, is
      // the difference between a dead control and an actionable one.
      return res.status(409).json({
        error:
          "Photo similarity is off. Turn it on in Manage library to compute embeddings first.",
      });
    }
    const jobId = kickNearDupeSweep(getDb());
    res.json({ started: true, jobId });
  });

  // POST -> rank the library against a phrase (#164).
  //
  // Nothing is thresholded and nothing is stored: the phrase is encoded, every
  // stored vector is scored against it, and the ranked list comes back with
  // the distribution's own quantiles so the client can show WHERE results stop
  // being good. server/ml/textSearch.js carries the measurements behind that
  // decision — the short version is that this model's cosine is uncalibrated,
  // so no fixed cutoff means "this is a dog".
  //
  // Costs no per-photo inference. The text tower shares the image tower's
  // vector space, so a query is one small text encode plus arithmetic over
  // vectors #161 already computed — measured at 12ms to load 16,797 vectors
  // and 8-17ms to score them.
  app.post("/api/ml/search", async (req, res) => {
    const q = typeof req.body?.q === "string" ? req.body.q.trim() : "";
    if (!q) return res.status(400).json({ error: "q must be a phrase" });

    const settings = readMlSettings();
    if (!settings.enabled) {
      return res.status(409).json({
        error:
          "Photo similarity is off. Turn it on in Manage library to search by what is in a photo.",
      });
    }
    const db = getDb();
    const { modelId } = settings;
    const rows = embeddedVectors(db, modelId);
    if (!rows.length) {
      // Specific over generic (CLAUDE.md): the search is not broken, it has
      // nothing to search. Saying so — and what to do — is the difference
      // between a dead box and an actionable one.
      return res.status(409).json({
        error:
          "No photos have been read by the vision model yet. Compute embeddings in Manage library first.",
      });
    }

    try {
      const ml = getMl();
      await ml.configure({
        modelId,
        threads: settings.threads,
        // "auto" is the ABSENCE of a pin, not a device name — see embedSweep.
        device: settings.device === "auto" ? null : settings.device,
      });
      const [raw] = await ml.embedTexts([q]);
      const ranked = rankByVector(rows, normalize(raw));
      const limit = Math.min(1000, Math.max(1, Number(req.body?.limit) || 300));
      res.json({
        query: q,
        model: modelId,
        scored: ranked.length,
        // Quantiles come from the FULL ranking, never the returned page: the
        // top 300 of this library is already its top 2%, so a distribution
        // taken from the page would describe only the good end.
        quantiles: scoreQuantiles(ranked),
        results: ranked.slice(0, limit),
      });
    } catch (e) {
      // The first search downloads the text tower, so this is also where a
      // failed download surfaces. Carry the host's own words.
      res
        .status(500)
        .json({ error: `Couldn't search by phrase: ${e?.message ?? e}` });
    }
  });

  // The saved half of #164. Searching is disposable and costs ~10ms; what is
  // worth storing is the user's DECISION about where a ranked list stopped
  // being dogs, which no threshold can reproduce.
  app.get("/api/ml/tags", (req, res) => res.json({ tags: listTags(getDb()) }));

  app.post("/api/ml/tags", (req, res) => {
    const value = typeof req.body?.value === "string" ? req.body.value : "";
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
    if (!value.trim())
      return res.status(400).json({ error: "tag needs a name" });
    if (!ids) {
      return res
        .status(400)
        .json({ error: "ids must be an array of photo ids" });
    }
    try {
      res.json(saveTag(getDb(), value, ids));
    } catch (e) {
      res
        .status(500)
        .json({ error: `Couldn't save the tag: ${e?.message ?? e}` });
    }
  });

  app.delete("/api/ml/tags/:value", (req, res) => {
    const { removed } = deleteTag(getDb(), req.params.value);
    if (!removed) return res.status(404).json({ error: "no such tag" });
    res.json({ removed });
  });

  // POST -> how much of the stored grouping the caller's photos account for
  // (#211). READ-ONLY: it recomputes nothing and writes nothing, so it is safe
  // to call after any sweep, or on its own to re-read a selection's answer.
  //
  // Scoping the ANSWER rather than the sweep is the whole design — see
  // db/nearDupes.js's nearDupeCountsForIds for the measurement that made the
  // issue's merge-vs-replace choice unnecessary.
  //
  // POST, not GET, for the same reason /api/ml/embed is: the id list is the
  // user's selection and routinely runs to tens of thousands, which no query
  // string should carry.
  // ---- Faces (#166) -------------------------------------------------------
  //
  // Three endpoints because there are three distinct states the user can be
  // in, and collapsing them would make the panel lie: the weights are not
  // here yet (a ~200 MB decision), the weights are here but nothing has been
  // scanned, or a scan is running. A single "Find faces" button that silently
  // triggered a 191 MB download would be the worst version of this.

  /** What the panel needs to decide what to offer. Never triggers work. */
  app.get("/api/ml/faces", async (req, res) => {
    const modelId = faceModelIdOf(req.query.model);
    const model = faceModelById(modelId);
    const model_ = await checkFaceModel(modelId, faceIo(modelId));
    res.json({
      models: FACE_MODELS.map((m) => ({
        id: m.id,
        label: m.label,
        approxDownloadMB: m.approxDownloadMB,
        approxMsPerPhoto: m.approxMsPerPhoto,
        licence: m.licence,
        modelCardUrl: m.modelCardUrl,
        note: m.note,
      })),
      modelId,
      weights: model_,
      running: isFaceSweepInFlight(),
      counts: faceCounts(getDb(), modelId),
      // The estimate the user is really deciding about. Rounded hard and
      // labelled "about" in the UI — see models.js on approxMsPerPhoto.
      approxMinutes: Math.round(
        (faceCounts(getDb(), modelId).total * model.approxMsPerPhoto) / 60000
      ),
    });
  });

  /** Fetch the weights. Separate from the sweep so the user consents to the
   *  download — and to the LICENCE — as its own act. */
  app.post("/api/ml/faces/download", async (req, res) => {
    const modelId = faceModelIdOf(req.body?.model);
    const model = faceModelById(modelId);
    const job = registry.create("face-download", {
      label: `Downloading ${model.label}`,
    });
    res.json({
      started: true,
      jobId: job.id,
      approxDownloadMB: model.approxDownloadMB,
    });
    try {
      const r = await downloadFaceModel(modelId, faceIo(modelId), {
        onProgress: ({ done, total, file, phase }) =>
          registry.update(job.id, {
            done,
            total,
            label: `${phase === "cached" ? "Checking" : "Downloading"} ${file}`,
          }),
      });
      registry.finish(job.id, r);
    } catch (e) {
      // downloadFaceModel's messages already say which file, why, and that
      // nothing was changed — pass them through rather than flattening them.
      registry.fail(job.id, e);
    }
  });

  /** Start (or report) a face pass. */
  app.post("/api/ml/faces", async (req, res) => {
    if (isFaceSweepInFlight()) {
      return res.json({ started: false, alreadyRunning: true });
    }
    const modelId = faceModelIdOf(req.body?.model);
    const model = faceModelById(modelId);
    const weights = await checkFaceModel(modelId, faceIo(modelId));
    if (!weights.ready) {
      // Specific over generic, and the two cases need different fixes: absent
      // means "press download", corrupt means "what you have is wrong".
      const why = weights.corrupt.length
        ? `the ${weights.corrupt.join(" and ")} on disk ${weights.corrupt.length > 1 ? "do" : "does"} not match ${model.label}'s checksum`
        : `the ${weights.missing.join(" and ")} ${weights.missing.length > 1 ? "have" : "has"} not been downloaded yet`;
      return res.status(409).json({
        error: `Can't look for faces yet — ${why}. Download ${model.label} (about ${model.approxDownloadMB} MB) first.`,
        weights,
      });
    }
    const job = registry.create("faces", {
      label: `Finding faces (${model.label})`,
    });
    res.json({ started: true, jobId: job.id });

    const engine = createFaceEngine({
      modelId,
      pathFor: (file) => join(faceModelDir(modelId), file),
      runtime: { ort: await loadOrt(), sharp },
      readFile: (p) => fsp.readFile(p),
    });
    try {
      const r = await sweepFaces({
        db: getDb(),
        modelId,
        engine,
        job,
        onProgress: ({ done, failed }) =>
          registry.update(job.id, {
            done,
            total: faceCounts(getDb(), modelId).total,
            label: `Finding faces — ${done.toLocaleString()} scanned${failed ? `, ${failed} unreadable` : ""}`,
          }),
      });
      // A PAUSE is not a success and must not be reported as one. The sweep
      // stands down on a host failure precisely so it does not blame photos —
      // saying "done" here would hide that from the user entirely.
      if (r.paused) {
        registry.fail(
          job.id,
          new Error(
            `Face detection stopped: ${r.pauseReason}. ` +
              `${r.done.toLocaleString()} photos were scanned; the rest are untouched and will resume.`
          )
        );
      } else {
        registry.finish(job.id, {
          scanned: r.done,
          faces: r.faces,
          failed: r.failed,
        });
      }
    } catch (e) {
      registry.fail(
        job.id,
        new Error(
          `Face detection stopped: ${e.message}. No photos were changed.`
        )
      );
    } finally {
      // ~200 MB of resident session must not outlive the sweep.
      await engine.close();
    }
  });

  /** Forget every face this model found. */
  app.post("/api/ml/faces/purge", (req, res) => {
    if (isFaceSweepInFlight()) {
      return res.status(409).json({
        error: "A face scan is running. Stop it from the jobs panel first.",
      });
    }
    res.json(purgeFaces(getDb(), faceModelIdOf(req.body?.model)));
  });

  app.post("/api/ml/near-dupes/counts", (req, res) => {
    const db = getDb();
    const { modelId } = readMlSettings();
    const ids = Array.isArray(req.body?.ids)
      ? [...new Set(req.body.ids.filter((n) => Number.isInteger(n)))]
      : null;
    if (!ids) {
      return res
        .status(400)
        .json({ error: "ids must be an array of photo ids" });
    }
    res.json({
      scoped: nearDupeCountsForIds(db, modelId, ids),
      library: nearDupeCounts(db, modelId),
    });
  });

  // --- Lazy metadata enrichment --------------------------------------------
  // GET /api/meta?ids=1,2,3 -> [{ id, takenAt, width, height }].
  // width is used as the "already attempted extraction" marker, but sharp
  // can't read most RAW headers, so a genuinely-attempted RAW photo has no
  // dimensions to report. Storing that outcome as NULL would be
  // indistinguishable from "never tried" and re-trigger extraction forever,
  // so a completed-but-dimensionless attempt is stored as 0 (falsy, but
  // distinct from NULL) — only NULL means "never tried".
  app.get("/api/meta", interactiveRoute, async (req, res) => {
    const db = getDb();
    const idsParam = String(req.query.ids ?? "");
    const ids = idsParam
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n));

    const photosById = new Map();
    const need = [];
    for (const id of ids) {
      const photo = getPhotoById(db, id);
      if (!photo) continue;
      photosById.set(id, photo);
      if (photo.width === null || photo.camera === null || photo.lens === null)
        need.push(photo);
    }

    if (need.length) {
      // Same writer the sweep uses (server/db/enrich.js) — the sentinels it
      // stores are what the date fallback in sort.js keys off, so there is
      // exactly one place that decides what an enriched row looks like.
      const metas = await processing.metadata(need.map((p) => p.path));
      metas.forEach((m, i) => {
        const photo = need[i];
        const fields = writeMeta(db, photo.id, m);
        photosById.set(photo.id, { ...photo, ...fields });
      });
    }

    const out = ids
      .map((id) => photosById.get(id))
      .filter(Boolean)
      .map((p) => ({
        id: p.id,
        // EXIF date, else the file's creation date (see TAKEN_AT_EXPR). Same
        // helper the feed rows use, so the loupe and the grid never disagree.
        takenAt: takenAtIso(p),
        width: p.width ?? null,
        height: p.height ?? null,
        duration: p.duration ?? null,
        camera: p.camera ?? null,
        aperture: p.aperture ?? null,
        shutter: p.shutter ?? null,
        iso: p.iso ?? null,
        focalLength: p.focal_length ?? null,
        lens: p.lens ?? null,
        size: p.size ?? null,
        folder: p.folder_abs_path ?? null,
        // Raw EXIF coordinates (for the minimap) plus the offline-geocoded
        // names (server/lib/place.js) already shown as feed/tree dimensions
        // (#154) — the loupe just hadn't surfaced either one yet (#175
        // follow-up). "" is the Unknown sentinel; the client only renders a
        // Location section once BOTH lat and lon are present.
        lat: p.lat ?? null,
        lon: p.lon ?? null,
        placeCountry: p.place_country ?? "",
        placeRegion: p.place_region ?? "",
        placeCity: p.place_city ?? "",
        placeNeighborhood: p.place_neighborhood ?? "",
      }));
    res.json(out);
  });

  // --- Thumbnail ----------------------------------------------------------
  app.get("/api/thumb/:id", interactiveRoute, async (req, res) => {
    const db = getDb();
    const it = getPhotoById(db, Number(req.params.id));
    if (!it) return res.status(404).end();
    const size = Math.min(1024, Math.max(64, Number(req.query.size) || 320));

    const cachePath = thumbCachePath(it, size);

    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.type("image/jpeg");

    if (existsSync(cachePath)) {
      res.set("X-Cache", "hit");
      return createReadStream(cachePath).pipe(res);
    }

    try {
      const { data } =
        it.kind === "video"
          ? await processing.videoThumb(it.path, size)
          : await processing.thumbnail(it.path, size);
      // Unique per write, not just per process: the embedding sweep writes
      // this same bucket concurrently now — see tmpCachePath's own doc.
      const tmp = tmpCachePath(cachePath);
      await writeFile(tmp, data);
      await rename(tmp, cachePath);
      res.set("X-Cache", "miss");
      res.send(data);
    } catch (err) {
      res.status(500).json({ error: `thumbnail failed: ${err.message}` });
    }
  });

  // --- Embedded preview (fast tier) ----------------------------------------
  app.get("/api/preview/:id", interactiveRoute, async (req, res) => {
    const db = getDb();
    const it = getPhotoById(db, Number(req.params.id));
    if (!it) return res.status(404).end();

    // A video has no embedded EXIF preview to extract — its poster frame IS its
    // thumbnail, and exifr THROWS when handed one. "There is no preview here" is
    // a 404, not a server error: this used to 500 whenever a slow video thumbnail
    // made the grid fall back to the preview URL (a CI-only flake, because it
    // takes a loaded machine to push the poster frame past the fallback delay).
    if (it.kind === "video") return res.status(404).end();

    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.type("image/jpeg");

    try {
      const preview = await processing.extractPreview(it.path);
      if (!preview) return res.status(404).end();
      res.send(preview.data);
    } catch (err) {
      res.status(500).json({ error: `preview failed: ${err.message}` });
    }
  });

  // --- Full image / video (loupe) -----------------------------------------
  // Serves the original bytes. Videos need HTTP Range so the loupe's <video>
  // element can start playback and seek (a browser won't scrub, and often won't
  // even begin, without 206 support); images take the same path and simply
  // request without a Range header, getting the whole-file 200. No transcoding —
  // the browser plays whatever codec the container holds.
  /**
   * Serve a file with byte-range support (what a <video> scrub bar needs). Used
   * for both originals and transcoded proxies, so seeking works identically in
   * either — a proxy the user can't scrub would be a downgrade, not a fix.
   */
  async function serveFileWithRanges(req, res, path) {
    let st;
    try {
      st = await stat(path);
    } catch {
      return res.status(404).end();
    }
    res.set("Cache-Control", "public, max-age=3600");
    res.set("Accept-Ranges", "bytes");
    res.type(
      MIME_BY_EXT[extname(path).toLowerCase()] || "application/octet-stream"
    );

    const range = parseByteRange(req.headers.range, st.size);
    if (range === "invalid") {
      // Unsatisfiable range → 416 with the resource size, per RFC 7233.
      res.set("Content-Range", `bytes */${st.size}`);
      return res.status(416).end();
    }
    // Browsers routinely abort/reopen ranges while scrubbing; swallow the
    // resulting stream EPIPE/ECONNRESET rather than crashing the process.
    const onStreamError = () => res.destroyed || res.end();

    if (range) {
      const { start, end } = range;
      res.status(206);
      res.set("Content-Range", `bytes ${start}-${end}/${st.size}`);
      res.set("Content-Length", String(end - start + 1));
      createReadStream(path, { start, end })
        .on("error", onStreamError)
        .pipe(res);
      return;
    }

    res.set("Content-Length", String(st.size));
    createReadStream(path).on("error", onStreamError).pipe(res);
  }

  app.get("/api/image/:id", interactiveRoute, async (req, res) => {
    const db = getDb();
    const it = getPhotoById(db, Number(req.params.id));
    if (!it) return res.status(404).end();
    await serveFileWithRanges(req, res, it.path);
  });

  // --- Video playback -------------------------------------------------------
  // Chromium can't decode everything ffmpeg can. It has NO MPEG-4 Part 2
  // decoder and won't demux AVI at all — so an old camcorder .avi (MPEG-4 video
  // + MP3 audio) hands it an audio track it CAN play and a video track it can't:
  // the clip plays sound and shows nothing. On the real library that was 275
  // files, plus 32 more in MJPEG/H.263 and 10 in 4:2:2 H.264 (which plays on
  // macOS via VideoToolbox and shows black on Windows — same file, different
  // machine, which is exactly what got reported).
  //
  // So: anything the browser can't decode gets transcoded ONCE into an H.264
  // 4:2:0 MP4 and cached beside the thumbnails. The source video is never
  // touched. GET /api/video/:id answers "can I play this yet?":
  //   { ready: true, url }        → play it (original, or a proxy already built)
  //   202 { jobId, preparing }    → a transcode is running; watch the job
  const proxyPathFor = (it) =>
    join(videoProxiesDir(), `${it.id}-${Math.round(it.mtime ?? 0)}.mp4`);

  /** Codec/pix_fmt from the index, probing once if this video predates the
   *  columns (and remembering the answer, so it's probed at most once). */
  async function videoFormatOf(db, it) {
    // NULL = never probed; "" = probed, no video stream (the sentinel writeMeta
    // stores). Only NULL is worth an ffprobe — testing truthiness here would
    // re-probe an unreadable file on every single open.
    if (it.video_codec != null) {
      return { codec: it.video_codec || null, pixFmt: it.pix_fmt };
    }
    const [meta] = await processing.metadata([it.path]);
    db.prepare(
      `UPDATE photos SET video_codec = ?, pix_fmt = ? WHERE id = ?`
    ).run(meta?.videoCodec ?? "", meta?.pixFmt ?? null, it.id);
    return { codec: meta?.videoCodec ?? null, pixFmt: meta?.pixFmt ?? null };
  }

  app.get("/api/video/:id", interactiveRoute, async (req, res) => {
    const db = getDb();
    const it = getPhotoById(db, Number(req.params.id));
    if (!it) return res.status(404).json({ error: "unknown id" });
    if (it.kind !== "video") {
      return res.status(400).json({ error: "not a video" });
    }

    try {
      const ext = extname(it.path).toLowerCase();
      const { codec, pixFmt } = await videoFormatOf(db, it);
      const plan = playbackPlan({ ext, codec, pixFmt });

      // The client comes back with ?transcode=1 when it ASKED ITS OWN DECODER
      // about a native-first plan and was told no (an HEVC machine without the
      // codec, or a <video> that errored anyway). Its answer is authoritative —
      // it is the thing that has to render the frames — so we skip straight to
      // the conversion rather than offering it the same original again.
      const forced = req.query.transcode === "1";

      if (!forced && plan.mode === "direct") {
        return res.json({ ready: true, url: `/api/image/${it.id}` });
      }

      const proxy = proxyPathFor(it);

      // Native-first: offer the original, but only if we haven't already built a
      // proxy for this file (if we have, it is the surer bet and it is free).
      if (!forced && plan.mode === "native-first" && !existsSync(proxy)) {
        return res.json({
          ready: true,
          url: `/api/image/${it.id}`,
          verify: plan.mimeType,
        });
      }
      if (existsSync(proxy)) {
        return res.json({ ready: true, url: `/api/video/${it.id}/file` });
      }

      // Already being built (the user re-opened the loupe on it) — hand back the
      // SAME job rather than starting a second ffmpeg on the same file.
      const running = registry
        .list()
        .find(
          (j) =>
            j.type === "transcode" &&
            j.status === "running" &&
            j.photoId === it.id
        );
      if (running) {
        return res
          .status(202)
          .json({ preparing: true, jobId: running.id, reason: running.reason });
      }

      const reason = plan.reason || whyTranscode({ ext, codec, pixFmt });
      // A real bar, not a spinner: ffmpeg reports how far into the clip it has
      // encoded, and the index already knows how long the clip is. A 337MB
      // camcorder AVI takes minutes — "converting…" for that long is
      // indistinguishable from "hung". (duration is NULL for a video whose probe
      // failed; total 0 keeps the spinner for those, which is honest.)
      const total = Math.round(it.duration ?? 0);
      const job = registry.create("transcode", {
        label: `Converting ${it.filename} for playback`,
        total,
      });
      registry.update(job.id, { photoId: it.id, reason, phase: reason });
      res.status(202).json({ preparing: true, jobId: job.id, reason });

      (async () => {
        try {
          await processing.transcodeForPlayback(it.path, proxy, {
            signal: job.controller.signal,
            onProgress: (seconds) => {
              // Clamp: ffmpeg can overshoot the probed duration by a frame or two,
              // and a bar that reads 101% looks broken.
              registry.update(job.id, {
                done: total ? Math.min(Math.round(seconds), total) : 0,
              });
            },
          });
          registry.finish(job.id, { url: `/api/video/${it.id}/file` });
        } catch (e) {
          registry.fail(job.id, e);
        }
      })();
    } catch (e) {
      // Async handler: an uncaught throw here would take the whole server down
      // (Express 4 doesn't catch them), so the user gets a message instead.
      res.status(500).json({ error: `could not prepare video: ${e.message}` });
    }
  });

  /** The transcoded proxy itself, with ranges so the scrub bar still works. */
  app.get("/api/video/:id/file", interactiveRoute, async (req, res) => {
    const db = getDb();
    const it = getPhotoById(db, Number(req.params.id));
    if (!it) return res.status(404).end();
    await serveFileWithRanges(req, res, proxyPathFor(it));
  });

  // --- Ratings / cover choices ----------------------------------------------
  app.post("/api/rating", (req, res) => {
    const { id, rating } = req.body ?? {};
    const db = getDb();
    const it = getPhotoById(db, Number(id));
    if (!it) return res.status(404).json({ error: "unknown id" });
    if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
      return res.status(400).json({ error: "rating must be an integer 0-5" });
    }
    setPhotoRating(db, it.id, rating);
    res.json({ id: it.id, rating });
  });

  // Reveal a photo's real location in the OS file browser (Finder/Explorer/
  // file manager) — a read-only escape hatch to the file on disk (issue #18).
  // No file operations: it only asks the OS to show where the file already
  // lives. Runs server-side so it works identically in the browser dev server
  // and the packaged Electron app (both host this Express server locally).
  app.post("/api/reveal/:id", async (req, res) => {
    const db = getDb();
    const it = getPhotoById(db, Number(req.params.id));
    if (!it) return res.status(404).json({ ok: false, error: "unknown id" });
    try {
      await stat(it.path);
    } catch {
      // File gone (offline drive, or moved in Finder since the last scan).
      return res.status(404).json({ ok: false, error: "file not found" });
    }
    const command = revealCommand(process.platform, it.path);
    if (!command) {
      return res.status(501).json({
        ok: false,
        error: `unsupported platform: ${process.platform}`,
      });
    }
    try {
      await new Promise((resolveSpawn, reject) => {
        // execFile with an args array (never a shell string) — the path is
        // trusted-from-index, but this keeps the launch injection-proof anyway.
        execFile(command.cmd, command.args, (err) => {
          // Windows Explorer routinely exits non-zero even on a successful
          // reveal, so a non-zero exit there is not a failure.
          if (err && process.platform !== "win32") reject(err);
          else resolveSpawn();
        });
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message ?? err) });
    }
  });

  // Reveal a FOLDER (the tree's right-click menu). The existing reveal routes
  // take photo ids and resolve the path from the index; a folder has no id, so
  // the path arrives from the client — and is therefore not trusted.
  //
  // The guard is the index itself, which is stronger than a root-prefix check:
  // the path must BE a folder we have indexed, or be an ancestor of one. That
  // second case is not slack — it is a VIRTUAL ancestor (a folder holding only
  // sub-folders, so it has no `folders` row of its own, e.g. "Cards"), which the
  // tree shows and the user can right-click. Anything else — a path outside the
  // library, a traversal, a file — matches nothing and is refused.
  app.post("/api/reveal-folder", async (req, res) => {
    const folderPath = req.body?.path;
    if (typeof folderPath !== "string" || !folderPath.length) {
      return res.status(400).json({ ok: false, error: "path is required" });
    }
    const db = getDb();
    const escaped = folderPath.replace(/([\\%_])/g, "\\$1");
    const known = db
      .prepare(
        `SELECT 1 FROM folders
          WHERE abs_path = ? OR abs_path LIKE ? ESCAPE '\\'
          LIMIT 1`
      )
      .get(folderPath, `${escaped}/%`);
    if (!known) {
      return res
        .status(404)
        .json({ ok: false, error: "not a folder in this library" });
    }
    try {
      const st = await stat(folderPath);
      if (!st.isDirectory()) throw new Error("not a directory");
    } catch {
      // Removed in Finder, or on a drive that isn't mounted right now.
      return res
        .status(404)
        .json({ ok: false, error: "folder not found on disk" });
    }
    const command = revealCommand(process.platform, folderPath);
    if (!command) {
      return res.status(501).json({
        ok: false,
        error: `unsupported platform: ${process.platform}`,
      });
    }
    try {
      await new Promise((resolveSpawn, reject) => {
        execFile(command.cmd, command.args, (err) => {
          if (err && process.platform !== "win32") reject(err);
          else resolveSpawn();
        });
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message ?? err) });
    }
  });

  // Reveal a whole selection at once (issue #18, multi-select). Best-effort per
  // OS: macOS highlights all of them in Finder (AppleScript), Windows highlights
  // the first (explorer /select is single-only), Linux opens the containing
  // folder. Read-only — only shows where the files already live.
  // One Finder/Explorer window opens per distinct parent folder.
  const MAX_REVEAL_FOLDERS = 12;
  // A giant AppleScript `reveal {…}` list stalls Finder; cap the file count.
  const MAX_REVEAL_FILES = 500;

  app.post("/api/reveal-selection", async (req, res) => {
    let ids = Array.isArray(req.body?.ids)
      ? [...new Set(req.body.ids.filter((n) => Number.isInteger(n)))]
      : [];
    if (!ids.length) {
      return res.status(400).json({
        ok: false,
        error: "ids must be a non-empty array of integers",
      });
    }
    // Revealing thousands of files in a file manager isn't useful and can hang
    // it — a giant AppleScript `reveal {…}` list stalls Finder. Rather than
    // rejecting the whole action (the user's 1500-photo selection, #140),
    // highlight the first MAX_REVEAL_FILES and report the rest as omitted.
    const requested = ids.length;
    let omittedNote = null;
    if (ids.length > MAX_REVEAL_FILES) {
      ids = ids.slice(0, MAX_REVEAL_FILES);
      omittedNote = `only the first ${MAX_REVEAL_FILES} of ${requested} were revealed — narrow the selection to highlight specific files`;
    }
    const db = getDb();
    const paths = [];
    for (const id of ids) {
      const it = getPhotoById(db, id);
      if (!it) continue;
      try {
        await stat(it.path);
        paths.push(it.path);
      } catch {
        // Skip files gone offline/moved since the last scan.
      }
    }
    if (!paths.length) {
      return res
        .status(404)
        .json({ ok: false, error: "none of the selected files were found" });
    }
    // The 500-file cap protects the command line; THIS protects the user. macOS
    // opens one Finder window per distinct parent folder, so revealing files
    // spread across dozens of folders buries the desktop.
    const folders = new Set(paths.map((p) => dirname(p)));
    if (folders.size > MAX_REVEAL_FOLDERS) {
      return res.status(413).json({
        ok: false,
        error: `those photos live in ${folders.size} different folders (max ${MAX_REVEAL_FOLDERS}) — revealing them would open a window for each. Narrow the selection first.`,
      });
    }
    const command = revealManyCommand(process.platform, paths);
    if (!command) {
      return res.status(501).json({
        ok: false,
        error: `unsupported platform: ${process.platform}`,
      });
    }
    try {
      await new Promise((resolveSpawn, reject) => {
        execFile(command.cmd, command.args, (err) => {
          if (err && process.platform !== "win32") reject(err);
          else resolveSpawn();
        });
      });
      // Explorer's /select, highlights ONE file — saying "revealed: N" here would
      // be a lie the UI then repeats to the user. Report the limitation so the
      // caller can surface it (see revealManyCommand's win32 branch).
      const winPartial =
        process.platform === "win32" && paths.length > 1
          ? "Windows Explorer can only highlight one file at a time."
          : null;
      // Either limitation is worth surfacing; `requested` lets the UI say
      // "Revealed N of M". win32 wins when both apply (it only shows one file).
      const partial = winPartial ?? omittedNote;
      res.json({
        ok: true,
        revealed: winPartial ? 1 : paths.length,
        ...(partial ? { partial, requested } : {}),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message ?? err) });
    }
  });

  app.post("/api/cover", (req, res) => {
    const { id, isCover } = req.body ?? {};
    const db = getDb();
    const it = getPhotoById(db, Number(id));
    if (!it) return res.status(404).json({ error: "unknown id" });
    if (typeof isCover !== "boolean") {
      return res.status(400).json({ error: "isCover must be a boolean" });
    }
    setPhotoCover(db, it.id, isCover);
    res.json({ id: it.id, preferredCover: isCover });
  });

  // --- Library (previously-scanned folders) --------------------------------
  app.get("/api/library", (_req, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT folders.id AS id, folders.abs_path AS path, folders.last_scanned_at AS lastScannedAt,
                volumes.uuid AS volumeUuid, volumes.last_mount_path AS volumeMountPath
         FROM folders LEFT JOIN volumes ON volumes.id = folders.volume_id
         ORDER BY folders.last_scanned_at DESC`
      )
      .all();
    // isVolumeMounted shells out to `diskutil info` synchronously; memoize per
    // volume so N folders on the same volume cost one subprocess, not N.
    const mountedByVolumeKey = new Map();
    const entries = rows.map((r) => {
      const volumeKey = r.volumeUuid ?? r.volumeMountPath ?? null;
      let volumeMounted = true;
      if (volumeKey !== null) {
        if (!mountedByVolumeKey.has(volumeKey)) {
          mountedByVolumeKey.set(
            volumeKey,
            isVolumeMounted({
              uuid: r.volumeUuid,
              last_mount_path: r.volumeMountPath,
            })
          );
        }
        volumeMounted = mountedByVolumeKey.get(volumeKey);
      }
      return {
        id: r.id,
        path: r.path,
        name: basename(r.path),
        lastScannedAt: r.lastScannedAt,
        mounted: volumeMounted && existsSync(r.path),
      };
    });
    res.json(entries);
  });

  // --- Missing files (vanished-from-disk review) ----------------------------
  /** Volume ids that are currently mounted (UUID-aware, same check as /api/library). */
  function mountedVolumeIds(db) {
    return db
      .prepare(`SELECT id, uuid, last_mount_path FROM volumes`)
      .all()
      .filter(
        (v) =>
          v.last_mount_path &&
          isVolumeMounted({ uuid: v.uuid, last_mount_path: v.last_mount_path })
      )
      .map((v) => v.id);
  }

  app.get("/api/missing", (_req, res) => {
    const db = getDb();
    // scanStartedAt = now: at display time no scan is in progress, so no surviving
    // copy counts as "new this scan". Without this (default 0), classifyRow would
    // treat every survivor as new and mislabel a still-backed-up row as "moved"
    // instead of "covered" — which makes the review pane skip carrying the vanished
    // copy's rating to its survivor on dismiss. See db/missing.js classifyRow.
    const items = listMissing(db, {
      mountedVolumeIds: mountedVolumeIds(db),
      scanStartedAt: Date.now(),
    });
    res.json({ items, count: items.length });
  });

  // A relocate destination is a user-chosen absolute path anywhere on disk —
  // there is no trusted root to confine it to (same shape as /api/scan's
  // `dir`), so this validates with statSync rather than safeResolve (which
  // requires a root + userPath pair and doesn't apply here).
  app.post("/api/missing/relocate", (req, res) => {
    const { id, destAbsPath } = req.body ?? {};
    if (
      !Number.isInteger(id) ||
      typeof destAbsPath !== "string" ||
      !destAbsPath
    ) {
      return res.status(400).json({ error: "id and destAbsPath are required" });
    }
    if (!isAbsolute(destAbsPath)) {
      return res.status(400).json({ error: "destAbsPath must be absolute" });
    }
    let st;
    try {
      st = statSync(destAbsPath);
    } catch {
      return res
        .status(400)
        .json({ error: `file not found at destination: ${destAbsPath}` });
    }
    if (!st.isFile()) {
      return res
        .status(400)
        .json({ error: `file not found at destination: ${destAbsPath}` });
    }
    const db = getDb();
    try {
      const { relocatedId } = relocateMissing(db, id, destAbsPath);
      res.json({ relocated: true, id: relocatedId });
    } catch (e) {
      if (e.code === "DEST_OCCUPIED") {
        return res.status(409).json({ error: e.message });
      }
      throw e;
    }
  });

  app.post("/api/missing/dismiss", (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.every((n) => Number.isInteger(n))) {
      return res
        .status(400)
        .json({ error: "ids must be an array of integers" });
    }
    res.json(dismissPhotos(getDb(), ids));
  });

  app.post("/api/missing/carry", (req, res) => {
    const { fromId, toId } = req.body ?? {};
    if (!Number.isInteger(fromId) || !Number.isInteger(toId)) {
      return res.status(400).json({ error: "fromId and toId are required" });
    }
    res.json(carryMetadata(getDb(), fromId, toId));
  });

  app.delete("/api/folders/:id", (req, res) => {
    const db = getDb();
    const removed = deleteFolder(db, Number(req.params.id));
    if (!removed) return res.status(404).end();
    res.json({ removed: true });
  });

  // Remove a folder from the index by its on-disk path (how the feed knows a
  // group). Index-only: real files on disk are never touched (see
  // deleteFolder). Ratings for those photos live in SQLite, so they DO go with
  // the rows — the client confirms before calling this.
  app.post("/api/folders/remove", (req, res) => {
    const path = req.body?.path;
    if (typeof path !== "string" || !path.length) {
      return res.status(400).json({ error: "path is required" });
    }
    const db = getDb();
    // Subtree removal: a parent folder must take its descendants with it, or the
    // children keep the parent alive in the index and the remove looks like a
    // no-op. Works for a pure ancestor (no own row) too. See deleteFolderSubtree.
    const { folders, photos } = deleteFolderSubtree(db, path);
    if (folders === 0) {
      return res.status(404).json({ error: `not indexed: ${path}` });
    }
    res.json({ removed: true, folders, photos });
  });

  // Remove photos from the index by id — how a NON-folder group header (a year,
  // a camera, a day) drops its whole subtree, since there's no folder to delete.
  // Files on disk are untouched; only the SQLite rows. Capped to keep a single
  // request bounded — the client removes a very large group in chunks.
  app.post("/api/photos/remove", (req, res) => {
    const ids = req.body?.ids;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      !ids.every((n) => Number.isInteger(n))
    ) {
      return res
        .status(400)
        .json({ error: "ids must be a non-empty array of integers" });
    }
    if (ids.length > 50000) {
      return res
        .status(413)
        .json({ error: "too many ids in one request (max 50000)" });
    }
    const db = getDb();
    const { photos, folders } = deletePhotosByIds(db, ids);
    res.json({ removed: true, photos, folders });
  });

  // Rename a scanned folder on disk and update the index (issue #68 Slice B).
  // Folders on disk are the source of truth, so this renames the real directory
  // (renameSync) and repoints the folder rows — the user explicitly asked to
  // rename it. Photo rows are untouched (paths derive from folder_id).
  app.post("/api/folders/rename", (req, res) => {
    const { path, newName } = req.body ?? {};
    if (typeof path !== "string" || !path.length) {
      return res.status(400).json({ error: "path is required" });
    }
    if (typeof newName !== "string" || !newName.trim()) {
      return res.status(400).json({ error: "newName is required" });
    }
    const name = newName.trim();
    // A bare folder name only — no separators, no traversal.
    if (
      name.includes("/") ||
      name.includes(sep) ||
      name === "." ||
      name === ".."
    ) {
      return res.status(400).json({ error: "invalid folder name" });
    }
    const db = getDb();
    const row = db
      .prepare(`SELECT id FROM folders WHERE abs_path = ?`)
      .get(path);
    if (!row) return res.status(404).json({ error: `not indexed: ${path}` });
    if (!existsSync(path)) {
      return res
        .status(409)
        .json({ error: "folder is not on disk (offline?)" });
    }
    const newAbsPath = join(dirname(path), name);
    if (newAbsPath === path) {
      return res.json({ ok: true, oldPath: path, newPath: newAbsPath }); // no-op
    }
    if (
      existsSync(newAbsPath) ||
      db.prepare(`SELECT id FROM folders WHERE abs_path = ?`).get(newAbsPath)
    ) {
      return res
        .status(409)
        .json({ error: "a folder with that name already exists" });
    }
    try {
      renameSync(path, newAbsPath);
    } catch (err) {
      return res.status(500).json({ error: `rename failed: ${err.message}` });
    }
    renameFolderPath(db, path, newAbsPath);
    res.json({ ok: true, oldPath: path, newPath: newAbsPath });
  });

  app.get("/api/cache/stats", (_req, res) => {
    res.json(getCacheStats());
  });

  // async: Express 4 does NOT catch a throw in an async handler — it kills the
  // process (learned the hard way when a "too many SQL variables" throw took the
  // whole server down). Catch it here.
  app.get("/api/cache/breakdown", async (_req, res) => {
    try {
      res.json(await getCacheBreakdown(getDb()));
    } catch (e) {
      res.status(500).json({ error: `cache breakdown failed: ${e.message}` });
    }
  });

  app.post("/api/cache/clear", (_req, res) => {
    res.json(clearCache());
  });

  app.post("/api/cache/prune", (_req, res) => {
    res.json(pruneOrphanedCache(getDb()));
  });

  // --- Grouped endless feed --------------------------------------------------
  /**
   * Promote a JSON body onto req.query so ONE handler serves both the GET and
   * the POST twin of a read endpoint.
   *
   * The feed's collapsed-group set has to reach the server somehow, and as a
   * query param it does not fit: collapsing every group of a real library
   * (1,183 folders) is a 195KB URL against Node's 16KB header cap, so the
   * request died with a 431 before Express ever saw it — "Collapse all" was a
   * dead button on exactly the libraries big enough to want it. A body has no
   * such cap. GET stays for small requests, bookmarks and every existing
   * caller; the client posts when the state it must send is genuinely large.
   */
  const bodyAsQuery = (req, _res, next) => {
    const body = req.body ?? {};
    const promoted = {};
    for (const [k, v] of Object.entries(body)) {
      // The handlers below parse these params out of strings (`JSON.parse` for
      // collapsed/startPath, `split(",")` for groupBy), so a caller may send
      // either the string form or the real value and get the same result — with
      // the one exception that groupBy is comma-separated, not JSON, so an
      // array of dimensions has to be joined rather than stringified.
      if (typeof v === "string") promoted[k] = v;
      else if (k === "groupBy" && Array.isArray(v)) promoted[k] = v.join(",");
      else promoted[k] = JSON.stringify(v);
    }
    // Express 5 made req.query a getter-only accessor (parsed lazily from the
    // URL) — assigning `req.query = …` now throws. Shadow it with an own data
    // property so the downstream handlers read the promoted body instead.
    Object.defineProperty(req, "query", {
      value: { ...req.query, ...promoted },
      writable: true,
      configurable: true,
      enumerable: true,
    });
    next();
  };

  const feedHandler = (req, res) => {
    const groupBy = String(req.query.groupBy ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    // Empty groupBy is valid: a flat feed of every photo (getFeedPage builds no
    // dim columns). Only reject unknown dimension names.
    if (groupBy.some((d) => !DIMENSIONS[d])) {
      return res.status(400).json({
        error: `unknown dimension in groupBy: ${groupBy.join(",")}`,
      });
    }
    const { spec: filter, error: filterError } = parseFilterParam(req);
    if (filterError) return res.status(400).json({ error: filterError });
    const sort = parseSort(req.query.sort ? String(req.query.sort) : undefined);

    let collapsed = [];
    if (req.query.collapsed) {
      try {
        collapsed = JSON.parse(String(req.query.collapsed));
      } catch {
        return res.status(400).json({ error: "collapsed must be JSON" });
      }
    }

    const focusIdParam = req.query.focusId;
    const focusId =
      focusIdParam !== undefined && focusIdParam !== ""
        ? Number(focusIdParam)
        : null;
    let startPath = null;
    if (req.query.startPath) {
      try {
        startPath = JSON.parse(String(req.query.startPath));
      } catch {
        return res.status(400).json({ error: "startPath must be JSON" });
      }
    }
    // `|| 0`/`|| 50` as a fallback for a MISSING param would also silently
    // override an explicitly-passed `0` (falsy in JS) — a real, shipped bug:
    // jumpGroupBoundary's "before" fetch passes `after=0` deliberately (it
    // wants only before-items), but that got coerced back up to the default
    // 50, injecting 50 unrelated "after" items into what should have been a
    // pure before-page and corrupting the client's assembled feed order
    // (duplicate/out-of-order section headers after a group-jump). Only
    // fall back to the default when the param is genuinely absent.
    const before =
      req.query.before !== undefined
        ? Math.max(0, Number(req.query.before) || 0)
        : 0;
    const after =
      req.query.after !== undefined
        ? Math.max(0, Number(req.query.after) || 0)
        : 50;

    const db = getDb();
    try {
      const { items, focusItem } = getFeedPage(db, {
        groupBy,
        collapsed,
        focusId,
        startPath,
        before,
        after,
        filter,
        sort,
      });
      res.json({ items, focusItem });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };
  app.get("/api/feed", feedHandler);
  app.post("/api/feed", bodyAsQuery, feedHandler);

  const boundaryHandler = (req, res) => {
    const groupBy = String(req.query.groupBy ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!groupBy.length) {
      return res.status(400).json({ error: "groupBy is required" });
    }
    if (groupBy.some((d) => !DIMENSIONS[d])) {
      return res.status(400).json({
        error: `unknown dimension in groupBy: ${groupBy.join(",")}`,
      });
    }
    const { spec: filter, error: filterError } = parseFilterParam(req);
    if (filterError) return res.status(400).json({ error: filterError });
    const sort = parseSort(req.query.sort ? String(req.query.sort) : undefined);

    const direction = String(req.query.direction ?? "");
    if (direction !== "next" && direction !== "prev") {
      return res
        .status(400)
        .json({ error: `direction must be "next" or "prev"` });
    }

    let collapsed = [];
    if (req.query.collapsed) {
      try {
        collapsed = JSON.parse(String(req.query.collapsed));
      } catch {
        return res.status(400).json({ error: "collapsed must be JSON" });
      }
    }

    const focusId = Number(req.query.focusId);
    if (!Number.isInteger(focusId)) {
      return res.status(400).json({ error: "focusId is required" });
    }

    try {
      const db = getDb();
      const result = findGroupBoundary(db, {
        groupBy,
        collapsed,
        focusId,
        direction,
        filter,
        sort,
      });
      res.json(result ?? { id: null });
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  };
  app.get("/api/feed/boundary", boundaryHandler);
  app.post("/api/feed/boundary", bodyAsQuery, boundaryHandler);

  // --- Fisheye snapshot: first/middle/last of a group, without paging
  // through the whole thing --------------------------------------------------
  app.get("/api/group/sample", (req, res) => {
    const groupBy = String(req.query.groupBy ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!groupBy.length) {
      return res.status(400).json({ error: "groupBy is required" });
    }
    if (groupBy.some((d) => !DIMENSIONS[d])) {
      return res.status(400).json({
        error: `unknown dimension in groupBy: ${groupBy.join(",")}`,
      });
    }
    const { spec: filter, error: filterError } = parseFilterParam(req);
    if (filterError) return res.status(400).json({ error: filterError });
    const sort = parseSort(req.query.sort ? String(req.query.sort) : undefined);

    let path;
    try {
      path = req.query.path ? JSON.parse(String(req.query.path)) : null;
    } catch {
      return res.status(400).json({ error: "path must be JSON" });
    }
    if (!Array.isArray(path) || !path.length) {
      return res.status(400).json({ error: "path is required" });
    }

    // Aggregate snapshot for a folder PARENT: the exact group at that path is
    // usually empty (a "Cards"-style folder holds no photos of its own, only
    // its camera subfolders do), so `subtree=1` samples across the whole
    // subtree instead. Marking the last path segment `subtree: true` is the
    // same flag `collapsedPathCondition`/`countCollapsedPaths` already read
    // for subtree-collapsed groups (see server/db/feed.js), so countGroupPath
    // and fetchGroupRowsAtOffsets need no changes — they already swap in
    // `folderSubtreeCondition`'s prefix predicate for a flagged segment.
    const subtree = req.query.subtree === "1";
    if (subtree && path.length === 1 && path[0].dimension === "folder") {
      path = [{ ...path[0], subtree: true }];
    }

    const slots = Math.min(64, Math.max(1, Number(req.query.slots) || 12));

    const db = getDb();
    try {
      const count = countGroupPath(db, { path, groupBy, filter, sort });
      const { offsets, gaps } = sampleOffsets(count, slots);
      const rows = fetchGroupRowsAtOffsets(db, {
        path,
        groupBy,
        offsets,
        filter,
        sort,
      });
      const samples = rows.map((row, i) => ({
        ...row,
        offset: offsets[i],
        gapAfter: gaps.includes(i),
      }));
      res.json({ count, samples });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- Hierarchy tree (lazy, per-level) --------------------------------------
  app.get("/api/tree", (req, res) => {
    const groupBy = String(req.query.groupBy ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (groupBy.length && groupBy.some((d) => !DIMENSIONS[d])) {
      return res.status(400).json({
        error: `unknown dimension in groupBy: ${groupBy.join(",")}`,
      });
    }
    const { spec: filter, error: filterError } = parseFilterParam(req);
    if (filterError) return res.status(400).json({ error: filterError });
    const sort = parseSort(req.query.sort ? String(req.query.sort) : undefined);

    // Flat feed (no grouping) has no hierarchy — an empty tree, not an error —
    // but still report the real matching total so the sidebar header is right.
    if (!groupBy.length) {
      return res.json({
        total: photoCountMatchingFilter(getDb(), filter),
        nodes: [],
      });
    }

    let path = [];
    if (req.query.path) {
      try {
        path = JSON.parse(String(req.query.path));
      } catch {
        return res.status(400).json({ error: "path must be JSON" });
      }
    }

    const db = getDb();
    try {
      const { total, nodes } = getTreeNode(db, {
        groupBy,
        path,
        filter,
        sort,
      });
      res.json({ total, nodes });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/tree/flat", (req, res) => {
    const groupBy = String(req.query.groupBy ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (groupBy.length && groupBy.some((d) => !DIMENSIONS[d])) {
      return res.status(400).json({
        error: `unknown dimension in groupBy: ${groupBy.join(",")}`,
      });
    }
    const { spec: filter, error: filterError } = parseFilterParam(req);
    if (filterError) return res.status(400).json({ error: filterError });
    const sort = parseSort(req.query.sort ? String(req.query.sort) : undefined);

    // Flat feed (no grouping) has no leaves — empty, not an error — but still
    // report the real matching total for the sidebar header.
    if (!groupBy.length) {
      return res.json({
        total: photoCountMatchingFilter(getDb(), filter),
        leaves: [],
      });
    }

    const db = getDb();
    try {
      const { total, leaves } = getFlatTree(db, { groupBy, filter, sort });
      res.json({ total, leaves });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- Selection ids (respects the same filter as /api/feed) ----------------
  // Optional `path` (JSON [{dimension,value}]) scopes to one group — the
  // "select all in this section" case.
  app.get("/api/photos/ids", (req, res) => {
    const { spec: filter, error: filterError } = parseFilterParam(req);
    if (filterError) return res.status(400).json({ error: filterError });
    let path = null;
    if (req.query.path) {
      try {
        path = JSON.parse(String(req.query.path));
      } catch {
        return res.status(400).json({ error: "path must be JSON" });
      }
    }
    // The feed's sort drives date-dimension grouping, so the group scope must
    // see it too (else keep-only/select disagree with the section — issue #71).
    const sort = parseSort(req.query.sort ? String(req.query.sort) : undefined);
    // `edge=first|last` returns only the group's boundary photo. The jump
    // controls (the ‹ › buttons and the Option+arrow edge fallback) need exactly
    // one id; shipping every id of a 10,000-photo folder to read one of them was
    // pure waste on every click.
    const edge = req.query.edge ? String(req.query.edge) : null;
    if (edge && edge !== "first" && edge !== "last") {
      return res.status(400).json({ error: "edge must be 'first' or 'last'" });
    }
    const db = getDb();
    try {
      const ids = photoIdsMatchingFilter(db, filter, path, sort);
      if (!edge) return res.json({ ids });
      const one = edge === "last" ? ids[ids.length - 1] : ids[0];
      res.json({ ids: one == null ? [] : [one] });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- Photo count (library total when unfiltered; "showing" with a filter) -
  app.get("/api/photos/count", (req, res) => {
    const { spec: filter, error: filterError } = parseFilterParam(req);
    if (filterError) return res.status(400).json({ error: filterError });
    const db = getDb();
    res.json({ count: photoCountMatchingFilter(db, filter) });
  });

  // --- "Keep only" working set: store the id list server-side so the filter
  // only carries a boolean (keepScope), lifting the URL-length cap on its size.
  app.post("/api/scope", (req, res) => {
    const ids = req.body?.ids;
    if (ids !== undefined && !Array.isArray(ids)) {
      return res.status(400).json({ error: "ids must be an array" });
    }
    const db = getDb();
    const count = setKeepScope(db, ids ?? []);
    res.json({ count });
  });

  // --- Manual burst stacks (issue #24) -------------------------------------
  // Force a selection into one stack, or dissolve a mis-detected stack so its
  // photos stay separate. Both key on photo id and persist across rescans.
  app.post("/api/stacks", (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids)) {
      return res.status(400).json({ error: "ids must be an array" });
    }
    if (ids.filter((n) => Number.isInteger(n)).length < 2) {
      return res
        .status(400)
        .json({ error: "a manual stack needs at least 2 photos" });
    }
    const db = getDb();
    const { groupId, count } = createManualStack(db, ids);
    res.json({ groupId, count });
  });

  app.post("/api/stacks/dissolve", (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: "ids must be a non-empty array" });
    }
    const db = getDb();
    const { count } = dissolveStack(db, ids);
    res.json({ count });
  });

  // --- Library reset (danger zone: wipes the index, not the photos) --------
  app.post("/api/library/reset", (req, res) => {
    if (req.body?.confirm !== "DELETE") {
      return res.status(400).json({ error: "confirmation required" });
    }
    const db = getDb();
    const cleared = resetLibrary(db);
    const cacheResult = clearCache();
    res.json({
      ...cleared,
      cacheFreedFiles: cacheResult.freedFiles,
      cacheFreedBytes: cacheResult.freedBytes,
    });
  });

  // --- Export selected photos into a new folder -----------------------------
  app.post("/api/export", (req, res) => {
    // `move` MOVES the originals out of the source folder. It goes through the
    // same audited path materialize uses (copyIdsIntoFolder -> moveFile:
    // rename, or copy -> fsync -> verify size -> unlink; the source is removed
    // only after the destination is confirmed). It returns a manifest so the
    // move is UNDOABLE — never a one-way door on someone's photos.
    const { photoIds, destParent, folderName, move } = req.body ?? {};
    if (!Array.isArray(photoIds) || photoIds.length === 0) {
      return res
        .status(400)
        .json({ error: "photoIds must be a non-empty array" });
    }
    if (typeof destParent !== "string" || destParent.length === 0) {
      return res.status(400).json({ error: "destParent is required" });
    }
    if (typeof folderName !== "string" || folderName.length === 0) {
      return res.status(400).json({ error: "folderName is required" });
    }

    const db = getDb();
    // Export may write inside a scanned source folder: the user explicitly
    // picked it, and a copy/move into it never corrupts the read-only invariant
    // the way an unattended write would (issue #5). The cache + traversal guards
    // inside resolveExportTarget still apply.
    const resolved = resolveExportTarget(db, destParent, folderName, {
      allowInsideSource: true,
    });
    if (resolved.error) return res.status(400).json({ error: resolved.error });

    const job = registry.create("export", {
      label: `Export ${photoIds.length} photos`,
      total: photoIds.length,
    });
    res.status(202).json({ jobId: job.id });

    (async () => {
      try {
        const { copied, skipped, moved, manifest } = await copyIdsIntoFolder(
          db,
          resolved.target,
          photoIds,
          {
            signal: job.controller.signal,
            move: move === true,
            onProgress: (done, total, phase) =>
              registry.update(job.id, { done, total, phase }),
          }
        );
        registry.finish(job.id, {
          target: resolved.target,
          copied: copied + moved,
          skipped,
          // Carry the move flag + manifest so the jobs panel can offer Undo —
          // same contract as materialize. A move without an undo would be a
          // one-way door on the user's originals.
          move: move === true,
          ...(move === true ? { manifest } : {}),
        });
      } catch (e) {
        registry.fail(job.id, e);
      }
    })();
  });

  // --- Album timeline (working set, time-ordered, for gap clustering) --------
  app.get("/api/albums/timeline", (req, res) => {
    const { spec: filter, error: filterError } = parseFilterParam(req);
    if (filterError) return res.status(400).json({ error: filterError });
    // Client-tunable working-set cap. AlbumsView renders each album as a
    // fisheye SnapshotStrip (first/middle/last), not every thumbnail, so this
    // is now a DB-time safety cap rather than a DOM-size one. Echoed back so
    // the UI can show the clamped value.
    const ALBUM_TIMELINE_MAX = 200000;
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 2000;
    limit = Math.min(limit, ALBUM_TIMELINE_MAX);
    const db = getDb();
    const { photos, truncated } = workingSetTimeline(db, filter, limit);
    res.json({ photos, truncated, limit });
  });

  // --- Timeline filter density: timestamps of the working set (crossfilter on
  // every facet except the time range itself). Drives the brushable timeline's
  // KDE; down-sampled server-side so the payload stays small on big libraries.
  app.get("/api/times", (req, res) => {
    const { spec: filter, error: filterError } = parseFilterParam(req);
    if (filterError) return res.status(400).json({ error: filterError });
    const TIMES_SAMPLE_MAX = 12000;
    const db = getDb();
    res.json(workingSetTimes(db, filter, TIMES_SAMPLE_MAX));
  });

  // --- Materialize albums: move (default) or copy each album into its own
  // dated folder, as a cancelable background job. Move is copy->verify->unlink
  // (see moveFile) with an undo manifest, so a completed or partially-canceled
  // move can be reversed via POST /api/albums/undo-move.
  app.post("/api/albums/materialize", (req, res) => {
    const { destParent, albums } = req.body ?? {};
    if (typeof destParent !== "string" || destParent.length === 0) {
      return res.status(400).json({ error: "destParent is required" });
    }
    if (!Array.isArray(albums) || albums.length === 0) {
      return res
        .status(400)
        .json({ error: "albums must be a non-empty array" });
    }
    for (const a of albums) {
      if (typeof a?.name !== "string" || !a.name.length) {
        return res.status(400).json({ error: "each album needs a name" });
      }
      if (!Array.isArray(a.photoIds) || a.photoIds.length === 0) {
        return res
          .status(400)
          .json({ error: `album "${a.name}" has no photos` });
      }
    }

    const db = getDb();
    // Resolve + validate every album's destination up front (fail fast, 400,
    // before any job/file work starts) rather than discovering a bad album
    // name mid-job, which would just surface as an async job failure.
    //
    // Two albums can render the SAME name (a same-day default, a template
    // that collapses distinct gap-clusters to one nested path like
    // "2017/DCIM", or a client that skips AlbumsView's own dedup) — without
    // disambiguation here they'd resolve to the identical target directory
    // and copyIdsIntoFolder's per-FILENAME collision handling would merge
    // both albums' photos into one physical folder (not overwritten, since
    // nextAvailablePath still suffixes same-named files, but silently
    // merged, which is its own kind of data loss for "keep these as
    // separate albums"). `usedTargets` mirrors AlbumsView's namedAlbums()
    // client-side dedup as a server-side backstop.
    const usedTargets = new Set();
    const resolvedAlbums = [];
    for (const album of albums) {
      let name = album.name;
      let resolved;
      let n = 1;
      for (;;) {
        // Materialize allows an in-place destination (a subfolder of the
        // source folder) — that's the default "organize this folder in
        // place" flow.
        resolved = resolveExportTarget(db, destParent, name, {
          allowInsideSource: true,
        });
        if (resolved.error)
          return res.status(400).json({ error: resolved.error });
        if (!usedTargets.has(resolved.target)) break;
        n += 1;
        name = `${album.name}_${n}`;
      }
      usedTargets.add(resolved.target);
      resolvedAlbums.push({ album, target: resolved.target, name });
    }

    const move = req.body?.move !== false; // default MOVE
    const total = albums.reduce((n, a) => n + a.photoIds.length, 0);
    const job = registry.create("materialize", {
      label: `Materialize ${albums.length} albums (${move ? "move" : "copy"})`,
      total,
    });
    res.status(202).json({ jobId: job.id });

    (async () => {
      const results = [];
      const manifest = [];
      let done = 0;
      try {
        for (const { album, target, name } of resolvedAlbums) {
          // copyIdsIntoFolder now awaits async fs per file, so it yields the
          // event loop on its own. Keep an explicit yield at the album boundary
          // so an album that ends up skipping every file (no awaited copy)
          // still can't starve a pending cancel between albums.
          await new Promise((resolve) => setImmediate(resolve));
          if (job.controller.signal.aborted) {
            const e = new Error("canceled");
            e.name = "AbortError";
            throw e;
          }
          const r = await copyIdsIntoFolder(db, target, album.photoIds, {
            signal: job.controller.signal,
            move,
            onProgress: (d, _t, phase) =>
              registry.update(job.id, {
                done: done + d,
                phase: `${name}: ${phase}`,
              }),
          });
          done += album.photoIds.length;
          results.push({
            name,
            target,
            copied: r.copied,
            moved: r.moved,
            skipped: r.skipped,
          });
          manifest.push(...r.manifest);
        }
        registry.finish(job.id, {
          destParent,
          albums: results,
          move,
          manifest,
        });
      } catch (e) {
        // Albums already fully processed (and, on the album that was
        // in-flight, whatever copyIdsIntoFolder had done before it threw —
        // see its `.manifest` on AbortError) must stay undoable even though
        // the job itself ends in "canceled"/"failed". Stash that into
        // `result` BEFORE fail() (fail() never touches `result`).
        const partialManifest = manifest.concat(e.manifest ?? []);
        if (move && partialManifest.length) {
          registry.update(job.id, {
            result: {
              destParent,
              albums: results,
              move,
              manifest: partialManifest,
            },
          });
        }
        registry.fail(job.id, e);
      }
    })();
  });

  // --- Undo a materialize-with-move: move every manifest entry back to its
  // original location and repoint the index. Skips entries whose `to` no
  // longer exists (e.g. the user already moved/renamed it via Finder).
  app.post("/api/albums/undo-move", (req, res) => {
    const { manifest } = req.body ?? {};
    if (!Array.isArray(manifest) || manifest.length === 0) {
      return res
        .status(400)
        .json({ error: "manifest must be a non-empty array" });
    }
    for (const m of manifest) {
      if (
        !Number.isInteger(m?.id) ||
        typeof m?.from !== "string" ||
        typeof m?.to !== "string"
      ) {
        return res
          .status(400)
          .json({ error: "each manifest entry needs id, from, to" });
      }
    }

    const db = getDb();
    const job = registry.create("undo-move", {
      label: `Undo move (${manifest.length} photos)`,
      total: manifest.length,
    });
    res.status(202).json({ jobId: job.id });

    (async () => {
      try {
        let restored = 0;
        let skipped = 0;
        // Cache the folder-id resolution per source directory — resolving it
        // per file spawns `diskutil` per file (see copyIdsIntoFolder). Undo
        // restores to the ORIGINAL folders, which vary, so key the cache by dir.
        const folderIdByDir = new Map();
        const destFolderIdFor = (absPath) => {
          const dir = dirname(absPath);
          let fid = folderIdByDir.get(dir);
          if (fid == null) {
            fid = resolveDestFolderId(db, dir);
            folderIdByDir.set(dir, fid);
          }
          return fid;
        };
        for (let i = 0; i < manifest.length; i++) {
          // Same rationale as the materialize loop above: moveFile is async
          // (it may fall back to copy+unlink across volumes), so we still
          // yield periodically to keep cancel responsive between awaits.
          if (i % 50 === 0)
            await new Promise((resolve) => setImmediate(resolve));
          if (job.controller.signal.aborted) {
            const e = new Error("canceled");
            e.name = "AbortError";
            throw e;
          }
          const entry = manifest[i];
          if (!existsSync(entry.to)) {
            skipped++;
          } else {
            await moveFile(entry.to, entry.from);
            repointPhotoToFolder(
              db,
              Number(entry.id),
              destFolderIdFor(entry.from),
              basename(entry.from)
            );
            restored++;
          }
          registry.update(job.id, { done: i + 1, phase: "restoring" });
        }
        registry.finish(job.id, { restored, skipped });
      } catch (e) {
        registry.fail(job.id, e);
      }
    })();
  });

  // --- System paths: smart defaults for the materialize dest picker
  // (Move defaults to in-place/source, Copy defaults to Desktop) --------------
  app.get("/api/system/paths", (_req, res) => {
    const home = homedir();
    res.json({ home, desktop: join(home, "Desktop") });
  });

  // Cheap same-device probe so the UI can warn "this Move is a full copy, not
  // instant" when source and dest straddle two volumes. Missing paths are a
  // normal case (dest not created yet, drive unmounted) — never 500, just
  // report "unknown" via null.
  app.get("/api/system/same-volume", (req, res) => {
    const { a, b } = req.query;
    if (typeof a !== "string" || typeof b !== "string") {
      return res.status(400).json({ error: "a and b are required" });
    }
    let sameVolume = null;
    try {
      sameVolume = statSync(a).dev === statSync(b).dev;
    } catch {
      sameVolume = null;
    }
    res.json({ sameVolume });
  });
}
