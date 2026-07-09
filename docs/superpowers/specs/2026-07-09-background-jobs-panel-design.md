# Background jobs + cancelable status-bar panel — design

## Context

Three operations in AutoGallery do real, potentially long-running work on disk:

- **Scan / recursive rescan** (`POST /api/scan`) — can index tens of thousands of files.
- **Export** (`POST /api/export`) — copies a selected set into a new folder.
- **Materialize auto-albums** (`POST /api/albums/materialize`) — writes each detected
  album into its own dated folder.

Today all three are **synchronous request handlers**: they run to completion and return
their result in the HTTP response, while the client `await`s. There is no progress, no
way to cancel, and no visibility that anything is happening — a 20k-photo materialize
just hangs the request until it finishes.

This spec adds a **background-job system** with a **cancelable status-bar panel**, and — in
the same pass, because materialize is one of the jobs — a **move option for materialize**
(relocate originals instead of copying), which is a new, deliberately-guarded capability.

Decisions locked in with John:

- **True cancel**, not best-effort: ops become cancelable jobs with real progress and a
  hard mid-operation stop (`AbortController` / `AbortSignal`).
- **All three ops** (scan, export, materialize) surface in the panel.
- Progress delivery is **SSE** (event-driven; no polling timers — matches the project's
  standing preference against `setTimeout` "settle" hacks).
- **Materialize defaults to MOVE** (copy is opt-in). Move is the first operation in the
  app that mutates the user's source folders, so it ships with four non-negotiable
  guardrails (below).

## Invariant tension (read before implementing)

Invariant #1 (`CLAUDE.md`): *folders on disk are the source of truth; the app only ever
copies.* Move breaks the "only copies" half. This is sanctioned — John explicitly asked —
but it means move is the **only** code path allowed to remove a source file, and it must
never be reachable except through an explicit materialize-with-move that the user
triggered. It must obey the "always recoverable" rule (`CLAUDE.md`): a move is undoable.

## Architecture

### Job registry (`server/jobs/registry.js` — new)

In-memory, single-process, single-user. No persistence (jobs die with the server; the
client reconnects to the current list on reload). A plain `Map<id, Job>` plus an
`EventEmitter` that emits `"change"` on every mutation.

```
Job = {
  id: string,                 // monotonic "job-1", "job-2", … (no Date/random — see note)
  type: "scan" | "export" | "materialize",
  label: string,              // human summary, e.g. "Materialize 6 albums (move)"
  status: "running" | "done" | "canceled" | "failed",
  done: number,               // items processed
  total: number,              // items expected (0 until known)
  phase: string,              // short current-step text, e.g. "copying" / "removing sources"
  result: object | null,      // op-specific summary on success
  error: string | null,       // message on failure
  controller: AbortController, // NOT serialized to clients
}
```

Registry API:

- `create(type, { label, total }) -> Job` (status `running`, fresh `AbortController`).
- `update(id, patch)` — merges `{done, total, phase}`, emits change.
- `finish(id, result)` / `fail(id, error)` — terminal, emits change.
- `cancel(id)` — `job.controller.abort()`; the running op observes the signal and calls
  `fail(id, "canceled")` → normalize `status` to `"canceled"`.
- `dismiss(id)` — remove a terminal job from the list (running jobs cannot be dismissed).
- `list()` — serializable snapshot (everything except `controller`).
- `on("change", cb)` — for the SSE endpoint.

> **Id generation note.** Workflow/`Date.now()`/`Math.random()` constraints don't apply
> here (this is app runtime, not a workflow script), but keep ids deterministic-friendly:
> a module-level incrementing counter is simplest and avoids collisions.

### Endpoints (`server/api.js`)

Each of the three handlers changes from *do-work-then-respond* to *spawn-job-then-respond*:

1. Validate inputs exactly as today (same 400s).
2. `const job = registry.create(type, { label, total })`.
3. Kick off the work in a fire-and-forget async function that:
   - passes `job.controller.signal` and an `onProgress(done, total, phase)` closure into
     the worker,
   - calls `registry.finish(job.id, result)` on success,
   - calls `registry.fail(job.id, msg)` on throw (including `AbortError`).
4. Respond **202** `{ jobId: job.id }` immediately.

New endpoints:

- `GET /api/jobs` → `{ jobs: registry.list() }` (snapshot; used on client connect).
- `GET /api/jobs/events` → **SSE** stream; on every registry `"change"`, write
  `data: {json list}\n\n`. Send the current snapshot once on connect. Clean up the
  listener on request close.
- `POST /api/jobs/:id/cancel` → `registry.cancel(id)`; 404 if unknown, 409 if already
  terminal.
- `POST /api/jobs/:id/dismiss` → `registry.dismiss(id)`; 404 if unknown, 409 if running.

### Cancelable, progress-reporting workers

**`copyIdsIntoFolder(db, targetDir, ids, opts)`** (`server/api.js`, currently line ~106) —
the shared copy loop behind export and materialize. New signature:

```
copyIdsIntoFolder(db, targetDir, ids, { signal, onProgress, move = false }) ->
  { copied, moved, skipped, manifest }
```

- Check `signal?.aborted` at the top of each iteration; throw a sentinel `AbortError`
  (`const e = new Error("canceled"); e.name = "AbortError"; throw e;`) to unwind. Files
  already copied/moved stay — a canceled job leaves a partial, consistent result (its
  manifest lists exactly what moved, so it's still undoable).
- `onProgress(done, total, phase)` every ~50 files (and once at the end).
- **Move path** (`move === true`), per file:
  1. Resolve collision-safe destination via the existing `nextAvailablePath` (never
     overwrite).
  2. Try `renameSync(src, dst)`. On `EXDEV` (cross-volume — SD card → internal disk),
     fall back to **copy → `fsyncSync` → verify size → `unlinkSync(src)`**. The source is
     removed **only after** the destination is confirmed written. A crash between copy and
     unlink leaves a harmless duplicate, never a lost file.
  3. **Update the index**: repoint the photo's DB row to the new location so it doesn't
     show as missing/offline. (See "Index update" below.)
  4. Record `{ id, from: src, to: dst }` in `manifest`.
- **Copy path** (`move === false`) is today's behavior plus manifest + progress.

**Index update after move.** A moved photo's `photos` row currently points at
`folder_abs_path + filename` under the source folder. After moving into the album folder
(a new location, possibly not yet a scanned `folders` row), the cleanest correct behavior:

- Ensure a `folders` row exists for `targetDir` (reuse `upsertFolder`/scan's folder
  upsert; the album folder becomes a browsable section — desirable).
- Update the photo row's `folder_id` and `filename` to the moved location.
- Do this inside the same transaction batch as the file move loop's DB writes.

This is the one genuinely fiddly part; the plan gives it its own task with tests against a
temp `AUTOGALLERY_HOME` and a temp source/dest on disk.

**Recursive scan worker** (`server/api.js` scan handler, recursive branch) — check
`signal?.aborted` between subfolders (each `processing.scan(subdir)` is atomic; aborting at
folder boundaries is sufficient granularity) and `onProgress(foldersDone, totalDirs,
"scanning " + basename)`.

### Undo (materialize move)

The job's `result` for a move includes the `manifest` (`{id, from, to}[]`). A new
`POST /api/albums/undo-move` `{ manifest }` moves each `to` back to `from`
(copy→verify→unlink, same guardrails) and restores the index rows. The panel surfaces an
**Undo** button on a completed move job while its manifest is still in memory. (Undo is
itself a small job so it shows progress; it does not need its own undo.)

### Frontend

**`ui/src/lib/jobs.js` (new)** — a Svelte store:

- Opens one `EventSource("/api/jobs/events")`; the store value is the jobs array.
- `startScan(dir, {recursive})`, `startExport(...)`, `startMaterialize({destParent, albums, move})`
  — POST the respective endpoint, return the `jobId`.
- `cancelJob(id)`, `dismissJob(id)`, `undoMove(job)`.
- `waitForJob(id) -> Promise` — resolves with the terminal job when it leaves `running`,
  so existing callers keep their "then reload the feed" logic without polling.

**`ui/src/lib/JobsPanel.svelte` (new)** — pinned to the bottom status bar. One row per
non-dismissed job:

- running: `label` · progress bar (`done/total`, indeterminate while `total===0`) · `phase`
  · **Cancel**.
- done: ✓ · result summary (e.g. `moved 812 · skipped 3`, or per-album counts) · dismiss ×
  · **Undo** (move jobs only).
- canceled / failed: ✗ · reason · dismiss ×.

No auto-dismiss timers. A terminal job clears on dismiss or when a new job of the same type
starts (keeps the panel from accreting old rows without a timer).

**Caller rewiring.** `App.svelte` (export, scan) and `AlbumsView.svelte` (materialize)
switch from `await fetchX()` to `startX()` + `waitForJob(id)` for their post-op step. The
materialize dialog gains a **Move / Copy** toggle, **defaulting to Move**, with a one-line
caution ("moves originals out of the source folders — undoable from the jobs panel").

## Testing

- **Registry unit tests** (`server/jobs/registry.test.js`): create/update/finish/fail/
  cancel/dismiss transitions; `list()` omits `controller`; `"change"` fires on each.
- **Copy/move worker tests** (`server/api.test.js` or a new `server/copy.test.js`), all
  against temp dirs in the scratchpad, never real/test photo folders:
  - move relocates + removes source; copy leaves source.
  - collision → ` (2)` suffix, never overwrite (both modes).
  - simulated cross-volume (force the `EXDEV` fallback path) → copy-verify-unlink; source
    removed only after dest exists.
  - `signal.aborted` mid-loop → throws `AbortError`, already-processed files persist,
    manifest reflects exactly what moved.
  - move updates the index (`folder_id`/`filename` repointed; photo no longer "missing").
  - undo move restores files + index.
- **Endpoint tests**: each op returns 202 `{jobId}`; `/api/jobs` lists it; cancel/dismiss
  status codes (404/409) correct.
- **Live verify** (per project convention — a green suite isn't "done" for anything
  touching the feed/materialize): via claude-in-chrome, run a materialize (move) on a
  small **copy of a test folder placed in the scratchpad** (never the real read-only test
  folders), watch the panel progress, cancel mid-run once, and Undo once; confirm the
  scratchpad source/dest and the feed reflect each outcome.

## Out of scope (this spec)

- Persisting jobs across server restart.
- Concurrency limits between jobs (they already serialize naturally; revisit only if
  parallel materialize+scan proves a problem).
- The fisheye snapshot view and the 20k auto-albums default — separate spec
  (`2026-07-09-fisheye-snapshot-view-design.md`); they share only the AlbumsView file.
